[CmdletBinding()]
param(
    # GitHub repository in owner/name form, e.g. someone/doraemon-be
    [Parameter(Mandatory = $true)]
    [string]$GitHubRepository,
    [string]$ResourceGroup = 'rg-doraemon-be-dev',
    [string]$Branch = 'main',
    [string]$EnvironmentName = 'production',
    [string]$DisplayName = 'doraemon-be-github-actions'
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

$credentials = az ad app federated-credential list --id $appId --query "[].name" --output json | ConvertFrom-Json
$credentialSpecs = @(
    @{
        Name    = "github-branch-$Branch"
        Subject = "repo:$GitHubRepository:ref:refs/heads/$Branch"
    },
    @{
        Name    = "github-environment-$EnvironmentName"
        Subject = "repo:$GitHubRepository:environment:$EnvironmentName"
    }
)

foreach ($spec in $credentialSpecs) {
    if ($credentials -contains $spec.Name) {
        Write-Host "Federated credential '$($spec.Name)' already exists"
        continue
    }

    $body = @{
        name      = $spec.Name
        issuer    = 'https://token.actions.githubusercontent.com'
        subject   = $spec.Subject
        audiences = @('api://AzureADTokenExchange')
    } | ConvertTo-Json -Depth 5

    $tempFile = Join-Path $env:TEMP "$($spec.Name).json"
    Set-Content -Path $tempFile -Value $body -Encoding utf8
    try {
        Write-Host "Creating federated credential '$($spec.Name)' ($($spec.Subject))"
        az ad app federated-credential create --id $appId --parameters $tempFile --output none
        if ($LASTEXITCODE -ne 0) { throw "Failed to create federated credential $($spec.Name)." }
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