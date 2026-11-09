# One-time setup for the Email Extension (per Windows user).
#
# After this runs, Chrome starts the tracker service by itself whenever any Chrome
# profile opens the extension: no start-service.bat, no token to paste.
#
# Run it again only after changing native-host\Program.cs or moving the project folder.

param(
  # Extra extension IDs to allow (normally not needed: the ID of the unpacked
  # extension loaded from the project folder is calculated automatically).
  [Parameter()]
  [ValidatePattern("^[a-p]{32}$")]
  [string[]] $ExtensionId = @(),

  [Parameter()]
  [ValidateSet("Chrome", "Brave", "Edge")]
  [string[]] $Browser = @("Chrome", "Brave", "Edge")
)

$ErrorActionPreference = "Stop"
$hostName = "com.jobposttracker.service"
$nativeHostDirectory = $PSScriptRoot
$projectRoot = Split-Path -Parent $nativeHostDirectory
$publishDirectory = Join-Path $nativeHostDirectory "publish"
$hostPath = Join-Path $publishDirectory "JobPostTrackerHost.exe"
$manifestPath = Join-Path $nativeHostDirectory "$hostName.json"
$envPath = Join-Path $projectRoot "service\.env"
$registryRoots = @{
  Chrome = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
  Brave  = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts"
  Edge   = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "manifest.json"))) {
  throw "manifest.json was not found in $projectRoot. Run 'npm run build' first."
}

# Chrome derives an unpacked extension's ID from its folder path, so every profile
# that loads this folder gets the same ID. Allow both drive-letter spellings.
function Get-UnpackedExtensionId([string] $path) {
  $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::Unicode.GetBytes($path))
  -join ($hash[0..15] | ForEach-Object { $_.ToString("x2").ToCharArray() } | ForEach-Object { [char]([int][char]"a" + [Convert]::ToInt32([string]$_, 16)) })
}
$rootPath = (Resolve-Path -LiteralPath $projectRoot).Path.TrimEnd("\")
$ids = @(
  Get-UnpackedExtensionId ($rootPath.Substring(0, 1).ToUpper() + $rootPath.Substring(1))
  Get-UnpackedExtensionId ($rootPath.Substring(0, 1).ToLower() + $rootPath.Substring(1))
) + $ExtensionId | Select-Object -Unique

Write-Output "Checking Node.js..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js was not found. Install Node.js 22.5 or newer from https://nodejs.org, then run this again." }
Write-Output "  Node $(& node --version)"

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules"))) {
  Write-Output "Installing service packages (npm install)..."
  Push-Location $projectRoot
  try { & npm install; if ($LASTEXITCODE -ne 0) { throw "npm install failed." } } finally { Pop-Location }
}

Write-Output "Building the native host..."
& dotnet publish (Join-Path $nativeHostDirectory "TrackerHost.csproj") --configuration Release --runtime win-x64 --self-contained true --output $publishDirectory --nologo -v quiet
if ($LASTEXITCODE -ne 0) {
  throw "Could not build the native host. Close every browser using the extension and try again."
}

$hostManifest = [ordered]@{
  name = $hostName
  description = "Starts the Email Extension service for the extension"
  path = $hostPath
  type = "stdio"
  allowed_origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $hostManifest, [System.Text.UTF8Encoding]::new($false))

foreach ($name in ($Browser | Select-Object -Unique)) {
  $registryPath = Join-Path $registryRoots[$name] $hostName
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -Path $registryPath -Value $manifestPath
  Write-Output "Registered for $name."
}

# Also allow the IDs in service\.env, so a service started by hand accepts the extension.
$lines = @()
if (Test-Path -LiteralPath $envPath) { $lines = @(Get-Content -LiteralPath $envPath) }
$existing = @()
$other = @()
foreach ($line in $lines) {
  if ($line -match "^\s*CORS_EXTENSION_IDS=(.*)$") { $existing += ($Matches[1].Trim('"', "'") -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
  else { $other += $line }
}
$allIds = @($existing + $ids | Select-Object -Unique)
[System.IO.File]::WriteAllLines($envPath, [string[]](@("CORS_EXTENSION_IDS=$($allIds -join ',')") + $other), [System.Text.UTF8Encoding]::new($false))

Write-Output ""
Write-Output "Done. Allowed extension IDs: $($ids -join ', ')"
Write-Output "Close all Chrome windows, reopen Chrome, and open the extension. It connects by itself."
