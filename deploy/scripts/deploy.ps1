[CmdletBinding()]
param(
    [string]$ResourceGroup = 'rg-doraemon-be-dev',
    [string]$Location = 'eastasia',
    # Optional custom .bicepparam file.
    [string]$ParametersFile = '',
    # Existing MongoDB / DocumentDB connection string (free-tier cluster created in the portal).
    # Omit to be prompted (input hidden).
    [string]$MongoConnectionString = '',
    # Create a paid DocumentDB cluster with Bicep instead of reusing an existing connection string.
    [switch]$CreateMongoCluster,
    # Build and zip-deploy the current working tree after provisioning.
    [switch]$DeployCode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Tool {
    param([string]$Name, [string]$Hint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name not found. $Hint"
    }
}

function New-RandomSecret {
    param([int]$ByteCount = 48)
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

function Ensure-EnvSecret {
    param([string]$Name, [switch]$Generate)
    $current = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($current)) {
        return
    }
    if (-not $Generate) {
        throw "Environment variable $Name is required. Set it in this shell, then re-run."
    }
    $value = New-RandomSecret
    [Environment]::SetEnvironmentVariable($Name, $value, 'Process')
    Write-Host "Generated $Name for this session. Save it somewhere safe (it will be stored in App Service settings)."
}

function Read-RequiredEnv {
    param([string]$Name, [switch]$Secret)
    $current = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($current)) {
        return
    }
    if ([Console]::IsInputRedirected) {
        throw "Environment variable $Name is required. Set it in this shell, then re-run."
    }

    if ($Secret) {
        $secure = Read-Host "Enter $Name (input hidden)" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
    else {
        $plain = Read-Host "Enter $Name"
    }

    if ([string]::IsNullOrWhiteSpace($plain)) {
        throw "$Name cannot be empty."
    }
    [Environment]::SetEnvironmentVariable($Name, $plain, 'Process')
}

Assert-Tool 'az' 'Install with: winget install --id Microsoft.AzureCLI -e'
Assert-Tool 'npm' 'Install Node.js 24 LTS from https://nodejs.org.'

$accountJson = az account show --query '{name:name,id:id}' --output json 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($accountJson)) {
    throw "Azure CLI is not logged in. Run 'az login' first."
}
$account = $accountJson | ConvertFrom-Json
Write-Host "Subscription: $($account.name) ($($account.id))"

Ensure-EnvSecret -Name 'JWT_SECRET' -Generate

if ($CreateMongoCluster) {
    Ensure-EnvSecret -Name 'MONGO_ADMIN_PASSWORD' -Generate
}
else {
    if (-not [string]::IsNullOrWhiteSpace($MongoConnectionString)) {
        [Environment]::SetEnvironmentVariable('MONGODB_CONNECTION_STRING', $MongoConnectionString, 'Process')
    }
    Read-RequiredEnv -Name 'MONGODB_CONNECTION_STRING' -Secret
    $conn = [Environment]::GetEnvironmentVariable('MONGODB_CONNECTION_STRING', 'Process')
    if ($conn -notmatch '^mongodb(\+srv)?://') {
        throw 'MongoDB connection string must start with mongodb:// or mongodb+srv://'
    }
}

Read-RequiredEnv -Name 'WECHAT_APP_ID'
Read-RequiredEnv -Name 'WECHAT_APP_SECRET' -Secret
[Environment]::SetEnvironmentVariable('AZURE_LOCATION', $Location, 'Process')

if ([string]::IsNullOrWhiteSpace($ParametersFile)) {
    $paramsDir = Join-Path $PSScriptRoot '..\params'
    if ($CreateMongoCluster) {
        $ParametersFile = Join-Path $paramsDir 'dev.bicepparam'
    }
    else {
        $ParametersFile = Join-Path $paramsDir 'dev.existing-mongo.bicepparam'
    }
}

if (-not (Test-Path $ParametersFile)) {
    throw "Parameters file not found: $ParametersFile"
}
$resolvedParams = (Resolve-Path $ParametersFile).Path

$rgExists = az group exists --name $ResourceGroup --output tsv
if ($rgExists -ne 'true') {
    Write-Host "Creating resource group $ResourceGroup in $Location"
    az group create --name $ResourceGroup --location $Location --output none
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create resource group.' }
}

$deploymentName = "doraemon-be-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Write-Host "Deploying infrastructure (deployment: $deploymentName)..."

az deployment group create `
    --resource-group $ResourceGroup `
    --name $deploymentName `
    --parameters $resolvedParams `
    --output none
if ($LASTEXITCODE -ne 0) { throw 'Infrastructure deployment failed.' }

$outputsJson = az deployment group show `
    --resource-group $ResourceGroup `
    --name $deploymentName `
    --query properties.outputs `
    --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read deployment outputs.' }
$outputs = $outputsJson | ConvertFrom-Json

$webAppName = $outputs.webAppName.value
$webAppUrl = $outputs.webAppUrl.value
$healthUrl = $outputs.healthCheckUrl.value

Write-Host ''
Write-Host 'Infrastructure deployed:'
Write-Host "  Web app      : $webAppName"
Write-Host "  URL          : $webAppUrl"
Write-Host "  Health check : $healthUrl"
Write-Host "  Mongo cluster: $($outputs.mongoClusterName.value)"

if ($DeployCode) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    Push-Location $repoRoot
    try {
        Write-Host 'Installing dependencies...'
        npm ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

        Write-Host 'Building...'
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

        $zipPath = Join-Path $env:TEMP "$deploymentName.zip"
        if (Test-Path $zipPath) { Remove-Item -Path $zipPath -Force }
        $items = @(
            'package.json',
            'package-lock.json',
            'tsconfig.json',
            'tsconfig.build.json',
            'nest-cli.json',
            'src',
            'dist'
        )
        Write-Host "Packaging $zipPath"
        Compress-Archive -Path $items -DestinationPath $zipPath -Force

        Write-Host 'Deploying code (App Service will run npm install && npm run build)...'
        az webapp deploy `
            --resource-group $ResourceGroup `
            --name $webAppName `
            --src-path $zipPath `
            --type zip `
            --clean true `
            --output none
        if ($LASTEXITCODE -ne 0) { throw 'Code deployment failed.' }

        Remove-Item -Path $zipPath -Force
        Write-Host "Code deployed. First start can take a minute: $healthUrl"
    }
    finally {
        Pop-Location
    }
}

Write-Host ''
Write-Host 'Next steps:'
Write-Host "  1. Check health: curl $healthUrl"
Write-Host '  2. Configure the mini program request domain / request legal域名 with the App Service hostname.'
Write-Host "  3. Optional CI/CD: .\deploy\scripts\setup-oidc.ps1 -GitHubRepository <owner/repo> -ResourceGroup $ResourceGroup"