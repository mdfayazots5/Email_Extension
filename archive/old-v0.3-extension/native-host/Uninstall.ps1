$ErrorActionPreference = "Stop"
$hostName = "com.jobsearch.emailcollector"
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"

if (Test-Path $registryPath) {
    Remove-Item -Path $registryPath -Recurse
}

Write-Host "Native host registration removed. Existing workbook and state files were kept."
