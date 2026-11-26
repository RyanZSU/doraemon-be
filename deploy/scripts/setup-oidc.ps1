[CmdletBinding()]
param(
    # GitHub repository in owner/name form, e.g. someone/doraemon-be
    [Parameter(Mandatory = $true)]
    [string]$GitHubRepository,
    [string]$ResourceGroup = 'rg-doraemon-be-dev',
    [string]$Branch = 'main',
    [string]$EnvironmentName = 'production',
    [string]$DisplayName = 'doraemon-be-github-actions',
    # Immutable OIDC subject IDs. Repositories created after 2026-07-15 include
    # owner/repo IDs in the subject. Auto-detected through the GitHub API when
    # omitted; for private repositories set GITHUB_TOKEN or pass both IDs.
    [string]$GitHubOwnerId = '',
    [string]$GitHubRepositoryId = '',
    # Repositories created before 2026-07-15 keep the legacy subject format
    # unless immutable subject claims were explicitly enabled.
    [switch]$LegacySubject
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI not found. Install with: winget install --id Microsoft.AzureCLI -e'
}

$subscriptionId = az account show --query id --output tsv 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($subscriptionId)) {
    throw "Azure CLI is not logged in. Run 'az login' first."
}
$tenantId = az account show --query tenantId --output tsv

$resourceGroupId = az group show --name $ResourceGroup --query id --output tsv
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resourceGroupId)) {
    throw "Resource group '$ResourceGroup' not found. Deploy the infrastructure first (deploy\scripts\deploy.ps1)."
}

$appId = az ad app list --display-name $DisplayName --query "[0].appId" --output tsv
if ([string]::IsNullOrWhiteSpace($appId)) {
    Write-Host "Creating Entra application '$DisplayName'"
    $appId = az ad app create --display-name $DisplayName --query appId --output tsv
}
else {
    Write-Host "Reusing Entra application '$DisplayName' ($appId)"
}

$servicePrincipalId = az ad sp list --filter "appId eq '$appId'" --query "[0].id" --output tsv
if ([string]::IsNullOrWhiteSpace($servicePrincipalId)) {
    Write-Host 'Creating service principal'
    $servicePrincipalId = az ad sp create --id $appId --query id --output tsv
}

$existingRole = az role assignment list `
    --assignee $servicePrincipalId `
    --scope $resourceGroupId `
    --query "[?roleDefinitionName=='Website Contributor'].id" `
    --output tsv
if ([string]::IsNullOrWhiteSpace($existingRole)) {
    Write-Host 'Granting Website Contributor on the resource group'
    az role assignment create `
        --assignee-object-id $servicePrincipalId `
        --assignee-principal-type ServicePrincipal `
        --role 'Website Contributor' `
        --scope $resourceGroupId `
        --output none
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create role assignment. You need Owner or User Access Administrator on the resource group.' }
}
else {
    Write-Host 'Website Contributor role assignment already exists'
}

$repoParts = $GitHubRepository.Split('/')
if ($repoParts.Count -ne 2 -or
    [string]::IsNullOrWhiteSpace($repoParts[0]) -or
    [string]::IsNullOrWhiteSpace($repoParts[1])) {
    throw 'GitHubRepository must be in owner/name form, e.g. someone/doraemon-be.'
}

if (-not $LegacySubject) {
    if ([string]::IsNullOrWhiteSpace($GitHubOwnerId) -or [string]::IsNullOrWhiteSpace($GitHubRepositoryId)) {
        try {
            $apiHeaders = @{
                'User-Agent' = 'doraemon-be-setup'
                Accept       = 'application/vnd.github+json'
            }
            if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) {
                $apiHeaders.Authorization = "Bearer $($env:GITHUB_TOKEN)"
            }
            $repoInfo = Invoke-RestMethod `
                -Uri "https://api.github.com/repos/$GitHubRepository" `
                -Headers $apiHeaders `
                -TimeoutSec 30
            $GitHubOwnerId = "$($repoInfo.owner.id)"
            $GitHubRepositoryId = "$($repoInfo.id)"
            Write-Host "Detected immutable OIDC IDs: owner=$GitHubOwnerId repo=$GitHubRepositoryId"
        }
        catch {
            throw "Could not read $GitHubRepository from the GitHub API. " +
                'For private repositories set GITHUB_TOKEN, or pass -GitHubOwnerId and -GitHubRepositoryId. ' +
                "Repositories created before 2026-07-15 can use -LegacySubject. Error: $($_.Exception.Message)"
        }
    }
    $subjectPrefix = 'repo:{0}@{1}/{2}@{3}' -f $repoParts[0], $GitHubOwnerId, $repoParts[1], $GitHubRepositoryId
}
else {
    $subjectPrefix = 'repo:{0}/{1}' -f $repoParts[0], $repoParts[1]
    Write-Warning 'Using legacy OIDC subject format. This only works for repositories that do not use immutable subject claims.'
}

$credentialsJson = az ad app federated-credential list `
    --id $appId `
    --query "[].{name:name,issuer:issuer,subject:subject,audiences:audiences}" `
    --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not list federated credentials.' }
# Windows PowerShell 5.1 returns a JSON array as a single pipeline object;
# assign first, then wrap, so Where-Object sees each credential individually.
$credentialsParsed = $credentialsJson | ConvertFrom-Json
$credentials = @($credentialsParsed)

# Format strings avoid the PowerShell pitfall where "$var:suffix" is parsed as
# a scope-qualified variable name.
$credentialSpecs = @(
    @{
        Name    = "github-branch-$Branch"
        Subject = ('{0}:ref:refs/heads/{1}' -f $subjectPrefix, $Branch)
    },
    @{
        Name    = "github-environment-$EnvironmentName"
        Subject = ('{0}:environment:{1}' -f $subjectPrefix, $EnvironmentName)
    }
)

foreach ($spec in $credentialSpecs) {
    $audience = 'api://AzureADTokenExchange'
    $body = @{
        name      = $spec.Name
        issuer    = 'https://token.actions.githubusercontent.com'
        subject   = $spec.Subject
        audiences = @($audience)
    } | ConvertTo-Json -Depth 5

    $existing = $credentials | Where-Object { $_.name -eq $spec.Name } | Select-Object -First 1
    if ($existing) {
        $audienceMatches = (($existing.audiences | Sort-Object) -join ',') -eq $audience
        if ($existing.subject -eq $spec.Subject -and
            $existing.issuer -eq 'https://token.actions.githubusercontent.com' -and
            $audienceMatches) {
            Write-Host "Federated credential '$($spec.Name)' already exists and matches"
            continue
        }
        Write-Host "Updating federated credential '$($spec.Name)' (subject was '$($existing.subject)')"
        $verb = 'update'
        $verbArgs = @('--federated-credential-id', $spec.Name)
    }
    else {
        Write-Host "Creating federated credential '$($spec.Name)' ($($spec.Subject))"
        $verb = 'create'
        $verbArgs = @()
    }

    $tempFile = Join-Path $env:TEMP "$($spec.Name).json"
    [IO.File]::WriteAllText($tempFile, $body, (New-Object System.Text.UTF8Encoding($false)))
    try {
        az ad app federated-credential $verb --id $appId @verbArgs --parameters $tempFile --output none
        if ($LASTEXITCODE -ne 0) { throw "Failed to $verb federated credential $($spec.Name)." }
    }
    finally {
        Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host 'Configure these GitHub Actions secrets (Settings > Secrets and variables > Actions):'
Write-Host "  AZURE_CLIENT_ID       = $appId"
Write-Host "  AZURE_TENANT_ID       = $tenantId"
Write-Host "  AZURE_SUBSCRIPTION_ID = $subscriptionId"
Write-Host ''
Write-Host 'Configure this GitHub Actions repository variable:'
Write-Host '  AZURE_WEBAPP_NAME     = <web app name from deploy.ps1 output>'
Write-Host ''
Write-Host 'Or with GitHub CLI:'
Write-Host "  gh secret set AZURE_CLIENT_ID       --repo $GitHubRepository --body `"$appId`""
Write-Host "  gh secret set AZURE_TENANT_ID       --repo $GitHubRepository --body `"$tenantId`""
Write-Host "  gh secret set AZURE_SUBSCRIPTION_ID --repo $GitHubRepository --body `"$subscriptionId`""
Write-Host "  gh variable set AZURE_WEBAPP_NAME   --repo $GitHubRepository --body <web-app-name>"
Write-Host ''
Write-Host 'Role assignments can take a few minutes to propagate before the first workflow run succeeds.'