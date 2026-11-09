param(
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"
$hostName = "com.jobsearch.emailcollector"
$hostManifestPath = Join-Path $PSScriptRoot "$hostName.json"
$publishPath = Join-Path $PSScriptRoot "publish"
$hostExecutable = Join-Path $publishPath "JobSearch.NativeHost.exe"

if (-not $ExtensionId) {
    $ExtensionId = Read-Host "Enter the extension ID shown on chrome://extensions"
}
if ($ExtensionId -notmatch "^[a-p]{32}$") {
    throw "The extension ID must be the 32-character ID shown on chrome://extensions."
}

dotnet publish (Join-Path $PSScriptRoot "NativeHost.csproj") `
    --configuration Release `
    --runtime win-x64 `
    --self-contained true `
    --output $publishPath
if ($LASTEXITCODE -ne 0) {
    throw "Native host build failed with exit code $LASTEXITCODE."
}

$hostManifest = @{
    name = $hostName
    description = "Writes the LinkedIn email workbook into the JobSearch project folder."
    path = $hostExecutable
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4

[System.IO.File]::WriteAllText(
    $hostManifestPath,
    $hostManifest,
    [System.Text.UTF8Encoding]::new($false)
)
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $hostManifestPath

Write-Host "Native host installed for extension $ExtensionId."
Write-Host "Reload the extension in chrome://extensions before using it."
