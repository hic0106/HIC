@echo off
REM Shared by connect.bat / upload-data.bat: server IP + key file, asked once and saved to %USERPROFILE%\.hic-cloud.cmd
set "HIC_CFG=%USERPROFILE%\.hic-cloud.cmd"
if exist "%HIC_CFG%" call "%HIC_CFG%"

if defined HIC_IP goto :have_ip
set /p "HIC_IP=Lightsail static IP (e.g. 3.35.10.20): "
if not defined HIC_IP (echo No IP entered.& exit /b 1)
:have_ip

if defined HIC_KEY if exist "%HIC_KEY%" goto :have_key
set "HIC_KEY="
REM look for the Lightsail key (.pem) in .ssh, the user folder, Downloads, Desktop
for %%D in ("%USERPROFILE%\.ssh" "%USERPROFILE%" "%USERPROFILE%\Downloads" "%USERPROFILE%\Desktop") do (
  if not defined HIC_KEY for %%F in ("%%~D\*.pem") do if not defined HIC_KEY set "HIC_KEY=%%~fF"
)
if not defined HIC_KEY set /p "HIC_KEY=Full path of the Lightsail key file (.pem): "
if not exist "%HIC_KEY%" (echo Key file not found: %HIC_KEY%& set "HIC_KEY="& exit /b 1)
:have_key
echo Server %HIC_IP%   Key %HIC_KEY%

REM OpenSSH refuses keys readable by other users ("UNPROTECTED PRIVATE KEY FILE"): owner read-only
icacls "%HIC_KEY%" /inheritance:r /grant:r "%USERNAME%:R" >nul 2>&1

(echo set "HIC_IP=%HIC_IP%"& echo set "HIC_KEY=%HIC_KEY%") > "%HIC_CFG%"
set "HIC_SERVER=ubuntu@%HIC_IP%"
exit /b 0
