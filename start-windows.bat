@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Need Node.js 20 or newer. Download it from https://nodejs.org/
  pause
  exit /b 1
)
echo Installing dependencies...
call npm install
if errorlevel 1 (
  echo Failed to install dependencies. Check your internet connection.
  pause
  exit /b 1
)
start "" "http://localhost:3000"
echo Running the site at http://localhost:3000
call npm start
pause
