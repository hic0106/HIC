@echo off
REM HIC Terminal launcher: starts the server and opens the browser.
cd /d "%~dp0"
title HIC Terminal (close this window to stop)
REM install / update dependencies (fast when nothing changed; needed after git pull adds a package)
call npm install --no-audit --no-fund --loglevel=error
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process http://127.0.0.1:8420"
call npm start
echo.
echo Server stopped. Press any key to close.
pause >nul
