#!/usr/bin/env bash
# Phone / any device access over Tailscale (private network of your own devices). Run on the server after setup-ubuntu.sh.
#   bash ~/HIC/deploy/setup-tailscale.sh
# Tailscale Serve publishes https://<server>.<tailnet>.ts.net -> 127.0.0.1:8420 to YOUR tailnet only (not the internet).
# The terminal keeps listening on 127.0.0.1; the Lightsail firewall stays SSH-only.
set -euo pipefail

if ! command -v tailscale >/dev/null; then
  echo "== install Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "== log in: open the URL printed below and sign in with the SAME account you will use on the phone"
sudo tailscale up

DNS=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
URL="https://$DNS"

echo "== Tailscale Serve (HTTPS inside your tailnet -> localhost:8420)"
echo "   if it asks to enable HTTPS certificates, open the link, enable, then run this script again"
sudo tailscale serve --bg 8420

echo "== allow the browser origin $URL for the live feed"
sudo mkdir -p /etc/systemd/system/hic.service.d
printf '[Service]\nEnvironment=HIC_ALLOWED_ORIGINS=%s\n' "$URL" | sudo tee /etc/systemd/system/hic.service.d/tailscale.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart hic

echo
echo "Done. On the phone: install Tailscale, sign in with the same account, then open:"
echo "  $URL"
tailscale serve status || true
