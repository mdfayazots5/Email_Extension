# One-time setup for the Email Extension (per Windows user).
#
# Normally started by double-clicking install.bat (or update.bat) in the project folder.
# It installs packages, builds the extension, and registers the native host so Chrome
# starts the tracker service by itself: no terminal, no token to paste.
#
# Run it again after updating the project or moving the project folder.

param(
  # Extra extension IDs to allow (normally not needed: the extension ID is fixed by
  # the "key" in extension\tracker.manifest.json).
  [Parameter()]
  [ValidatePattern("^[a-p]{32}$")]
  [string[]] $ExtensionId = @(),

  [Parameter()]
  [ValidateSet("Chrome", "Brave", "Edge")]
  [string[]] $Browser = @("Chrome", "Brave", "Edge")
)

$ErrorActionPreference = "Stop"
$fixedExtensionId = "dellkemhijjjiopbmnbcokdnklmcmona"
$minimumNode = [version]"22.13.0"
$hostName = "com.jobposttracker.service"
$nativeHostDirectory = $PSScriptRoot
$projectRoot = Split-Path -Parent $nativeHostDirectory
$hostScript = Join-Path $nativeHostDirectory "host.mjs"
$hostBat = Join-Path $nativeHostDirectory "host.bat"
$manifestPath = Join-Path $nativeHostDirectory "$hostName.json"
$registryRoots = @{
  Chrome = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
  Brave  = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts"
  Edge   = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
}

function Step([string] $text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }

Push-Location $projectRoot
try {
  # Files from a downloaded ZIP are marked as coming from the internet; clear that mark.
  Step "Preparing files"
  Get-ChildItem -LiteralPath $projectRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "\\node_modules\\" } |
    Unblock-File -ErrorAction SilentlyContinue

  Step "Checking Node.js"
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    throw "Node.js was not found. Install the LTS version from https://nodejs.org (keep the default options), then run install.bat again."
  }
  $nodePath = $nodeCommand.Source
  $nodeVersionText = (& $nodePath --version).Trim()
  $nodeVersion = [version]($nodeVersionText.TrimStart("v") -replace "-.*$", "")
  if ($nodeVersion -lt $minimumNode) {
    throw "Node.js $nodeVersionText is too old (need $minimumNode or newer). Install the LTS version from https://nodejs.org, then run install.bat again."
  }
  Write-Host "  Node $nodeVersionText at $nodePath"

  # A running service keeps files in node_modules open, which makes npm ci fail on Windows.
  # The extension starts the service again by itself the next time it is opened.
  $listener = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $running = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($running -and $running.ProcessName -eq "node") {
      Step "Stopping the running tracker service"
      & taskkill.exe /PID $running.Id /T /F | Out-Null
      Start-Sleep -Seconds 1
    }
  }

  Step "Installing packages (first time takes a minute)"
  if (Test-Path -LiteralPath (Join-Path $projectRoot "package-lock.json")) { & npm.cmd ci --no-audit --no-fund } else { & npm.cmd install --no-audit --no-fund }
  if ($LASTEXITCODE -ne 0) { throw "Installing packages failed. Check your internet connection and run install.bat again." }

  Step "Building the extension"
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "Building the extension failed. See the messages above." }
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "manifest.json"))) { throw "The build did not produce manifest.json." }

  Step "Registering the native host"
  # Chrome launches this .bat; an absolute node.exe path avoids PATH and nvm surprises.
  $batText = "@echo off`r`n`"$nodePath`" `"%~dp0host.mjs`" %*`r`n"
  [System.IO.File]::WriteAllText($hostBat, $batText, [System.Text.Encoding]::ASCII)

  $ids = @($fixedExtensionId) + $ExtensionId | Select-Object -Unique
  $hostManifest = [ordered]@{
    name = $hostName
    description = "Starts the Email Extension service for the extension"
    path = $hostBat
    type = "stdio"
    allowed_origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
  } | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($manifestPath, $hostManifest, [System.Text.UTF8Encoding]::new($false))

  foreach ($name in ($Browser | Select-Object -Unique)) {
    $registryPath = Join-Path $registryRoots[$name] $hostName
    New-Item -Path $registryPath -Force | Out-Null
    Set-Item -Path $registryPath -Value $manifestPath
    Write-Host "  Registered for $name."
  }

  Write-Host ""
  Write-Host "Done." -ForegroundColor Green
  Write-Host ""
  Write-Host "Next steps (first install only):"
  Write-Host "  1. In Chrome open chrome://extensions and switch on 'Developer mode' (top right)."
  Write-Host "  2. Click 'Load unpacked' and select this folder:"
  Write-Host "       $projectRoot"
  Write-Host "  3. Close every Chrome window and open Chrome again."
  Write-Host ""
  Write-Host "After an update: click the reload icon on the Email Extension card in chrome://extensions."
  Write-Host "Your extension ID is $fixedExtensionId"
}
finally {
  Pop-Location
}
