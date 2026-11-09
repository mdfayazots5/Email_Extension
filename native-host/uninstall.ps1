# Removes the Email Extension native host registration (current Windows user).
$hostName = "com.jobposttracker.service"
foreach ($root in @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
)) {
  $path = Join-Path $root $hostName
  if (Test-Path $path) { Remove-Item -Path $path -Force; Write-Output "Removed $path" }
}
