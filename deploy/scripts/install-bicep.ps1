[CmdletBinding()]
param(
    # Bicep CLI version published as Azure.Bicep.CommandLine.win-x64 on NuGet.
    [string]$Version = '0.49.2',
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'doraemon-be')
)

$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$zipPath = Join-Path $env:TEMP "bicep-$Version.zip"
$extractDir = Join-Path $env:TEMP "bicep-$Version"
Remove-Item -Path $extractDir -Recurse -Force -ErrorAction SilentlyContinue

$url = "https://api.nuget.org/v3-flatcontainer/azure.bicep.commandline.win-x64/$Version/azure.bicep.commandline.win-x64.$Version.nupkg"
Write-Host "Downloading $url"

try {
    # NuGet is used because GitHub Releases (the usual Bicep distribution) may be blocked
    # in some networks while NuGet is reachable.
    Invoke-WebRequest -Uri $url -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    $exe = Get-ChildItem -Path $extractDir -Recurse -Filter 'bicep.exe' |
        Select-Object -First 1
    if (-not $exe) {
        throw 'bicep.exe not found in the NuGet package.'
    }

    $target = Join-Path $InstallDir 'bicep.exe'
    Copy-Item -Path $exe.FullName -Destination $target -Force
    Write-Host "Bicep CLI installed: $target"
    Write-Host 'The deploy scripts discover it automatically; no PATH change needed.'
}
finally {
    Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $extractDir -Recurse -Force -ErrorAction SilentlyContinue
}