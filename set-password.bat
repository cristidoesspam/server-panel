@echo off
set "PANEL_DATA=%LOCALAPPDATA%\ServerPanel\data"
set "KIND=owner"
if /i "%~1"=="friends" set "KIND=guest"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Run install.bat first.
  pause
  exit /b 1
)
node "%LOCALAPPDATA%\ServerPanel\app\set-password.js" %KIND%
pause
