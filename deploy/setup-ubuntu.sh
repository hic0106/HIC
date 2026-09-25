#!/usr/bin/env bash
# HIC Terminal: one-time setup on a fresh Ubuntu 22.04 / 24.04 cloud server (e.g. AWS Lightsail Seoul / Tokyo).
#   curl -fsSL https://raw.githubusercontent.com/hic0106/HIC/claude/binance-crypto-trading-terminal-xspxvw/deploy/setup-ubuntu.sh | bash
# The terminal listens on 127.0.0.1 only (no password): open it through an SSH tunnel (deploy/connect.bat). Never open port 8420.
set -euo pipefail
BRANCH=claude/binance-crypto-trading-terminal-xspxvw
DIR="$HOME/HIC"

echo "== system packages, clock sync (Binance rejects requests from a drifting clock: -1021)"
sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates
sudo timedatectl set-ntp true || true

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "== Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# small instances (512 MB - 1 GB RAM): swap keeps backtests from being killed
if [ "$(free -m | awk '/Swap/ {print $2}')" -lt 1000 ] && [ ! -f /swapfile ]; then
  echo "== 2 GB swap"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== code ($BRANCH)"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only origin "$BRANCH"; else git clone -b "$BRANCH" https://github.com/hic0106/HIC.git "$DIR"; fi
cd "$DIR"
npm ci --omit=dev --no-audit --no-fund
mkdir -p data && chmod 700 data

echo "== systemd service (auto start on boot, restart on crash; bots always start STOPPED)"
sed -e "s#__USER__#$USER#g" -e "s#__DIR__#$DIR#g" -e "s#__NODE__#$(command -v node)#g" deploy/hic.service | sudo tee /etc/systemd/system/hic.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now hic
sleep 3
systemctl --no-pager --lines=5 status hic || true

echo
echo "Done. Server public IP (add it to the Binance API key IP whitelist):"
curl -fsS https://checkip.amazonaws.com || true
echo "Logs: journalctl -u hic -f     Update: bash $DIR/deploy/update.sh"
