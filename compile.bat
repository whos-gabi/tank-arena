@echo off
setlocal

cd /d "%~dp0"

set "APP_URL=http://localhost:5173"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found in PATH.
  echo Install Node.js first: https://nodejs.org/
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

echo Starting Tank Arena dev server...
start "Tank Arena Dev Server" cmd /k "cd /d "%~dp0" && npm run dev"

echo Waiting for the server to start...
timeout /t 4 /nobreak >nul

echo Opening %APP_URL%
start "" "%APP_URL%"

echo.
echo Tank Arena should now be running in your browser.
echo If the page is blank, wait a few seconds and refresh.

endlocal
