# Removes the Email Extension native host registration (current Windows user) and
# stops the background service. Your data in the data folder is kept.
$hostName = "com.jobposttracker.service"
foreach ($root in @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
)) {
  $path = Join-Path $root $hostName
  if (Test-Path $path) { Remove-Item -Path $path -Force; Write-Output "Removed $path" }
}

$listener = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq "node") {
    Stop-Process -Id $process.Id -Force
    Write-Output "Stopped the tracker service (process $($process.Id))."
  }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
Write-Output ""
Write-Output "Uninstalled. Your data is kept in $(Join-Path $projectRoot 'data')."
Write-Output "Remove the extension from chrome://extensions, then delete the project folder if you no longer need the data."
