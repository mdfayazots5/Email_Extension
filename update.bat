@echo off
setlocal
cd /d "%~dp0"
if exist ".git" (
  where git >nul 2>nul
  if errorlevel 1 (
    echo Git is not installed, so the latest version cannot be downloaded automatically.
    echo Download the new ZIP from GitHub and extract it over this folder, or install Git from https://git-scm.com
    pause
    exit /b 1
  )
  echo ==^> Downloading the latest version
  git pull --ff-only
  if errorlevel 1 (
    echo.
    echo Could not update. If you changed project files yourself, undo those changes and try again.
    pause
    exit /b 1
  )
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0native-host\install.ps1" %*
if errorlevel 1 (
  echo.
  echo Update did not finish. Read the message above, fix it, and run update.bat again.
  pause
  exit /b 1
)
echo.
echo Now open chrome://extensions and click the reload icon on the Email Extension card.
pause
