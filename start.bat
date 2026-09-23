@echo off
REM HIC Terminal launcher: starts the server and opens the browser.
cd /d "%~dp0"
title HIC Terminal (close this window to stop)
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process http://127.0.0.1:8420"
call npm start
echo.
echo Server stopped. Press any key to close.
pause >nul
