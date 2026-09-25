@echo off
REM Copies this PC's settings / positions / API keys to the cloud server (run ONCE, with the PC terminal closed).
REM After this, run LIVE only on the server (never on both).
set SERVER=ubuntu@0.0.0.0
set KEY=%USERPROFILE%\.ssh\hic-lightsail.pem
cd /d "%~dp0\.."
ssh -i "%KEY%" %SERVER% "sudo systemctl stop hic && mkdir -p ~/HIC/data && chmod 700 ~/HIC/data"
for %%F in (config.json state.json secrets.json portfolio-history.json backtest-last.json ai-state.json ai-strategies.json universe.json) do (
  if exist "data\%%F" scp -i "%KEY%" "data\%%F" %SERVER%:HIC/data/
)
ssh -i "%KEY%" %SERVER% "chmod 600 ~/HIC/data/secrets.json 2>/dev/null; sudo systemctl start hic"
echo Done. Press any key.
pause >nul
