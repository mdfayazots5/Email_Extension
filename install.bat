@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0native-host\install.ps1" %*
if errorlevel 1 (
  echo.
  echo Setup did not finish. Read the message above, fix it, and run install.bat again.
)
echo.
pause
