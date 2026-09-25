@echo off
REM Opens the cloud HIC terminal in the browser through an SSH tunnel (nothing is exposed to the internet).
REM Edit the two lines below once: server IP and the path of the key file downloaded from Lightsail.
set SERVER=ubuntu@0.0.0.0
set KEY=%USERPROFILE%\.ssh\hic-lightsail.pem
title HIC cloud tunnel (close this window to disconnect)
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process http://127.0.0.1:8421"
ssh -i "%KEY%" -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -L 8421:127.0.0.1:8420 %SERVER%
echo.
echo Tunnel closed. Press any key.
pause >nul
