@echo off
REM Opens the cloud HIC terminal in the browser through an SSH tunnel (nothing is exposed to the internet).
REM First run asks for the server IP and finds the .pem key; to change them delete %USERPROFILE%\.hic-cloud.cmd
cd /d "%~dp0"
call "%~dp0cloud-config.cmd" || (pause & exit /b 1)
title HIC cloud tunnel (close this window to disconnect)
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process http://127.0.0.1:8421"
ssh -i "%HIC_KEY%" -N -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -L 8421:127.0.0.1:8420 %HIC_SERVER%
echo.
echo Tunnel closed. Press any key.
pause >nul
