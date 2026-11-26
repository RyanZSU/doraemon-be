[CmdletBinding()]
param(
    [string]$ResourceGroup = 'rg-doraemon-be-dev',
    [string]$Location = 'eastasia',
    # Optional custom .bicepparam file.
    [string]$ParametersFile = '',
    # Existing MongoDB / DocumentDB connection string (free-tier cluster).
    # If omitted, .secrets\mongo-connection-string.txt is used when present, else prompted (input hidden).
    [string]$MongoConnectionString = '',
    # Optional path to bicep.exe (otherwise discovered from PATH / %LOCALAPPDATA%\doraemon-be).
    [string]$BicepPath = '',
    # Optional WeChat credentials file; defaults to .secrets\weixin.txt.
    # Lines can be "KEY: VALUE", "KEY=VALUE" or a JSON object.
    [string]$WeixinSecretsFile = '',
    # Create a paid DocumentDB cluster with Bicep instead of reusing an existing connection string.
    [switch]$CreateMongoCluster,
    # Use the App Service Free plan (F1, 60 CPU min/day, no Always On, no custom domain).
    [switch]$UseFreeAppServicePlan,
    # Validate the deployment with Azure without creating resources.
    [switch]$ValidateOnly,
    # Build and zip-deploy the current working tree after provisioning.
    [switch]$DeployCode
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
    # az bicep needs GitHub Releases; compile locally instead.
    throw 'Bicep CLI not found. Run .\deploy\scripts\install-bicep.ps1 or pass -BicepPath.'
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

function Import-EnvFileKeys {
    param(
        [string]$Path,
        [string[]]$Keys
    )
    $values = @{}
    if (-not (Test-Path $Path)) {
        return $values
    }

    $raw = Get-Content -Path $Path -Raw
    if ($raw.TrimStart().StartsWith('{')) {
        try {
            $json = $raw | ConvertFrom-Json
            foreach ($key in $Keys) {
                $property = $json.PSObject.Properties[$key]
                if ($property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
                    $values[$key] = ([string]$property.Value).Trim()
                }
            }
            return $values
        }
        catch {
            # Not valid JSON; fall back to key/value parsing below.
        }
    }

    foreach ($line in ($raw -split "\r?\n")) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) {
            continue
        }
        if ($trimmed -match '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*)$') {
            $name = $Matches[1]
            $value = $Matches[2].Trim()
            if ($value.Length -ge 2 -and
                (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                 ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            if (($Keys -contains $name) -and -not [string]::IsNullOrWhiteSpace($value)) {
                $values[$name] = $value
            }
        }
    }
    return $values
}

function New-ZipPackage {
    param(
        [string]$SourceRoot,
        [string[]]$Items,
        [string]$Destination
    )
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path $Destination) {
        Remove-Item -Path $Destination -Force
    }

    $root = $SourceRoot.TrimEnd('\', '/')
    $archive = [IO.Compression.ZipFile]::Open($Destination, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($item in $Items) {
            $path = Join-Path $root $item
            if (Test-Path $path -PathType Container) {
                Get-ChildItem -Path $path -Recurse -File | ForEach-Object {
                    $relative = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
                    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $relative) | Out-Null
                }
            }
            else {
                $relative = $item.Replace('\', '/')
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $path, $relative) | Out-Null
            }
        }
    }
    finally {
        $archive.Dispose()
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
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

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
    $secretFile = Join-Path $repoRoot '.secrets\mongo-connection-string.txt'
    if (-not [string]::IsNullOrWhiteSpace($MongoConnectionString)) {
        [Environment]::SetEnvironmentVariable('MONGODB_CONNECTION_STRING', $MongoConnectionString, 'Process')
    }
    elseif ((Test-Path $secretFile) -and
        -not [string]::IsNullOrWhiteSpace((Get-Content -Path $secretFile -Raw))) {
        $saved = (Get-Content -Path $secretFile -Raw).Trim()
        [Environment]::SetEnvironmentVariable('MONGODB_CONNECTION_STRING', $saved, 'Process')
        Write-Host 'Using MongoDB connection string from .secrets\mongo-connection-string.txt'
    }

    Read-RequiredEnv -Name 'MONGODB_CONNECTION_STRING' -Secret
    $conn = [Environment]::GetEnvironmentVariable('MONGODB_CONNECTION_STRING', 'Process')
    if ($conn -notmatch '^mongodb(\+srv)?://') {
        throw 'MongoDB connection string must start with mongodb:// or mongodb+srv://'
    }
}

if ([string]::IsNullOrWhiteSpace($WeixinSecretsFile)) {
    $WeixinSecretsFile = Join-Path $repoRoot '.secrets\weixin.txt'
}
if (Test-Path $WeixinSecretsFile) {
    $weixinValues = Import-EnvFileKeys -Path $WeixinSecretsFile -Keys @('WECHAT_APP_ID', 'WECHAT_APP_SECRET')
    foreach ($key in @('WECHAT_APP_ID', 'WECHAT_APP_SECRET')) {
        $current = [Environment]::GetEnvironmentVariable($key, 'Process')
        if ([string]::IsNullOrWhiteSpace($current) -and $weixinValues.ContainsKey($key)) {
            [Environment]::SetEnvironmentVariable($key, $weixinValues[$key], 'Process')
            Write-Host "Using $key from $WeixinSecretsFile"
        }
    }
}

Read-RequiredEnv -Name 'WECHAT_APP_ID'
Read-RequiredEnv -Name 'WECHAT_APP_SECRET' -Secret
[Environment]::SetEnvironmentVariable('AZURE_LOCATION', $Location, 'Process')

if ($UseFreeAppServicePlan) {
    [Environment]::SetEnvironmentVariable('APP_SERVICE_SKU', 'F1', 'Process')
    [Environment]::SetEnvironmentVariable('APP_SERVICE_TIER', 'Free', 'Process')
    Write-Host ''
    Write-Host 'Using the App Service Free plan (F1):'
    Write-Host '  - 60 CPU minutes per day; the site stops serving when the quota is used up.'
    Write-Host '  - No Always On: the app unloads after idle and cold-starts on the next request.'
    Write-Host '  - No custom domains: only *.azurewebsites.net, which cannot be ICP-filed for a released mini program.'
    Write-Host '  - Health check is disabled automatically to avoid waking the app every minute.'
    Write-Host '  Upgrade to B1 before submitting the mini program for release.'
    Write-Host ''
}

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

$bicepCli = Resolve-Bicep -Override $BicepPath
$templatePath = Join-Path $env:TEMP "$deploymentName.main.json"
$compiledParamsPath = Join-Path $env:TEMP "$deploymentName.params.json"

try {
    # Compile locally so az does not need its own Bicep CLI (which downloads from GitHub Releases).
    & $bicepCli build (Join-Path $PSScriptRoot '..\main.bicep') --outfile $templatePath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Bicep template compilation failed.' }

    & $bicepCli build-params $resolvedParams --outfile $compiledParamsPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Bicep parameter compilation failed.' }

    if ($ValidateOnly) {
        az deployment group validate `
            --resource-group $ResourceGroup `
            --name $deploymentName `
            --template-file $templatePath `
            --parameters "@$compiledParamsPath" `
            --output none
        if ($LASTEXITCODE -ne 0) { throw 'Validation failed.' }
    }
    else {
        az deployment group create `
            --resource-group $ResourceGroup `
            --name $deploymentName `
            --template-file $templatePath `
            --parameters "@$compiledParamsPath" `
            --output none
        if ($LASTEXITCODE -ne 0) { throw 'Infrastructure deployment failed.' }
    }
}
finally {
    Remove-Item -Path $templatePath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $compiledParamsPath -Force -ErrorAction SilentlyContinue
}

if ($ValidateOnly) {
    Write-Host ''
    Write-Host 'Validation succeeded. No resources were created.'
    return
}

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
        # Compress-Archive in Windows PowerShell 5.1 writes backslash-separated
        # entry names, which Linux unzip turns into single filenames. Use .NET so
        # the archive uses standard forward slashes.
        New-ZipPackage -SourceRoot $repoRoot -Items $items -Destination $zipPath

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
Write-Host '  2. Configure the mini program request legal domain with the App Service hostname.'
Write-Host "  3. Optional CI/CD: .\deploy\scripts\setup-oidc.ps1 -GitHubRepository <owner/repo> -ResourceGroup $ResourceGroup"