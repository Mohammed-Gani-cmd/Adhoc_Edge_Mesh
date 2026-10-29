@echo off
setlocal
cd /d "%~dp0mobile" || exit /b 1

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required.
  exit /b 1
)
if not exist "node_modules\expo\bin\cli" (
  echo Expo dependencies are missing. Run "npm ci" in mobile\ first.
  exit /b 1
)

node node_modules\expo\bin\cli start --go --lan --port 8082 %*
exit /b %errorlevel%
