[CmdletBinding()]
param(
    [string]$ResourceGroup = 'rg-doraemon-be-dev',
    # Free tier is only available in a subset of regions; East Asia / Japan East are closest to mainland China.
    [string]$Location = 'eastasia',
    [string]$ClusterName = '',
    [string]$AdministratorLogin = 'doraemonadmin',
    [int]$StorageSizeGb = 32,
    [string]$BicepPath = ''
)

$ErrorActionPreference = 'Stop'

function Assert-Tool {
    param([string]$Name, [string]$Hint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name not found. $Hint"
    }
}

function Resolve-Bicep {
    param([string]$Override)
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($Override)) { $candidates += $Override }
    if (-not [string]::IsNullOrWhiteSpace($env:BICEP_PATH)) { $candidates += $env:BICEP_PATH }
    $cmd = Get-Command bicep -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    $candidates += (Join-Path $env:LOCALAPPDATA 'doraemon-be\bicep.exe')

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }
    throw 'Bicep CLI not found. Run .\deploy\scripts\install-bicep.ps1 or pass -BicepPath.'
}

function New-RandomSecret {
    param([int]$ByteCount = 40)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] $ByteCount
        $rng.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes)
    }
    finally {
        $rng.Dispose()
    }
}

Assert-Tool 'az' 'Install with: winget install --id Microsoft.AzureCLI -e'

$accountJson = az account show --query '{name:name,id:id}' --output json 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($accountJson)) {
    throw "Azure CLI is not logged in. Run 'az login' first."
}
$account = $accountJson | ConvertFrom-Json
Write-Host "Subscription: $($account.name) ($($account.id))"

$existingJson = az resource list `
    --namespace Microsoft.DocumentDB `
    --resource-type mongoClusters `
    --query "[].{name:name,resourceGroup:resourceGroup}" `
    --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not list existing DocumentDB clusters.' }
$existing = @($existingJson | ConvertFrom-Json)
if ($existing.Count -gt 0) {
    $names = ($existing | ForEach-Object { "$($_.resourceGroup)/$($_.name)" }) -join ', '
    throw "Subscription already has DocumentDB cluster(s): $names. Free tier allows one per subscription; reuse the existing cluster instead."
}

if ([string]::IsNullOrWhiteSpace($ClusterName)) {
    $suffix = -join (1..6 | ForEach-Object { 'abcdefghijklmnopqrstuvwxyz0123456789'[(Get-Random -Maximum 36)] })
    $ClusterName = "doraemon-be-dev-$suffix"
}

$bicep = Resolve-Bicep -Override $BicepPath
$password = 'Aa1!' + (New-RandomSecret -ByteCount 40)

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$templatePath = Join-Path $env:TEMP "mongoCluster-$stamp.json"
$paramsPath = Join-Path $env:TEMP "mongoCluster-$stamp.parameters.json"

try {
    & $bicep build (Join-Path $PSScriptRoot '..\modules\mongoCluster.bicep') --outfile $templatePath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Bicep build failed.' }

    $params = @{
        '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters     = @{
            name                  = @{ value = $ClusterName }
            location              = @{ value = $Location }
            administratorLogin    = @{ value = $AdministratorLogin }
            administratorPassword = @{ value = $password }
            serverVersion         = @{ value = '8.0' }
            computeTier           = @{ value = 'Free' }
            storageSizeGb         = @{ value = $StorageSizeGb }
            highAvailability      = @{ value = $false }
            allowAzureServices    = @{ value = $true }
        }
    }
    [IO.File]::WriteAllText(
        $paramsPath,
        ($params | ConvertTo-Json -Depth 6),
        (New-Object System.Text.UTF8Encoding($false))
    )

    $rgExists = az group exists --name $ResourceGroup --output tsv
    if ($rgExists -ne 'true') {
        Write-Host "Creating resource group $ResourceGroup in $Location"
        az group create --name $ResourceGroup --location $Location --output none
        if ($LASTEXITCODE -ne 0) { throw 'Resource group creation failed.' }
    }

    Write-Host "Creating free-tier DocumentDB cluster $ClusterName (this can take ~10 minutes)..."
    az deployment group create `
        --resource-group $ResourceGroup `
        --name "mongo-free-$stamp" `
        --template-file $templatePath `
        --parameters "@$paramsPath" `
        --output none
    if ($LASTEXITCODE -ne 0) { throw 'DocumentDB cluster deployment failed.' }
}
finally {
    Remove-Item -Path $paramsPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $templatePath -Force -ErrorAction SilentlyContinue
}

$subscriptionId = az account show --query id --output tsv
$clusterId = "/subscriptions/$subscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.DocumentDB/mongoClusters/$ClusterName"
$state = az resource show --ids $clusterId --api-version '2026-06-01' --query 'properties.provisioningState' --output tsv
$firewall = az resource show --ids "$clusterId/firewallRules/AllowAllAzureServices" --api-version '2026-06-01' --query 'properties' --output json

$encodedPassword = [uri]::EscapeDataString($password)
$connectionString = "mongodb+srv://${AdministratorLogin}:${encodedPassword}@${ClusterName}.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false&maxIdleTimeMS=120000"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$secretsDir = Join-Path $repoRoot '.secrets'
New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null
$connectionFile = Join-Path $secretsDir 'mongo-connection-string.txt'
[IO.File]::WriteAllText($connectionFile, $connectionString, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host "Mongo cluster    : $ClusterName"
Write-Host "Resource group   : $ResourceGroup"
Write-Host "Location         : $Location"
Write-Host "ProvisioningState: $state"
Write-Host "Firewall rule    : $firewall"
Write-Host "Host             : $ClusterName.mongocluster.cosmos.azure.com"
Write-Host "Connection string saved to: $connectionFile (gitignored; password not printed)"
Write-Host ''
Write-Host 'Next: .\deploy\scripts\deploy.ps1 -DeployCode -Location eastasia -UseFreeAppServicePlan'