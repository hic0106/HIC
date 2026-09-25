#!/usr/bin/env bash
# Update the server to the latest code. Stop LIVE bots in the UI first (open positions keep their Binance stops).
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only origin claude/binance-crypto-trading-terminal-xspxvw
npm ci --omit=dev --no-audit --no-fund
sudo systemctl restart hic
sleep 3
systemctl --no-pager --lines=5 status hic || true
