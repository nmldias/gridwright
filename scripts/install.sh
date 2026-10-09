#!/usr/bin/env bash
# One-shot install of the prebuilt Gridwright release on a Linux host (arm64 or x86_64),
# without root: installs Node 22 into ~/.local if the host has no Node ≥ 20, installs the
# server dependencies, and registers a systemd *user* service so it survives reboots.
#
#   tar -xzf gridwright.tar.gz && cd gridwright && scripts/install.sh
#
# Options (environment):
#   GW_PORT      listen port (default 8787)
#   GW_DATA      data directory (default ~/gridwright-data)
#   GW_TOKEN     optional shared access token (empty = open to anyone who can reach the port)
#   AI_BASE_URL, AI_MODEL, AI_API_KEY   defaults for the assistant (also editable in the UI)
#
# Re-running the script is safe: it updates the service and restarts it.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PORT="${GW_PORT:-8787}"
DATA="${GW_DATA:-$HOME/gridwright-data}"
NODE_FALLBACK="v22.23.3"

say() { printf '\033[32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

[ -f server/dist/index.js ] && [ -f client/dist/index.html ] || die "this is not the prebuilt release (server/dist or client/dist missing) — run scripts/build.sh first"
command -v curl >/dev/null 2>&1 || die "curl is required"

# --- Node ≥ 20 ---------------------------------------------------------------------
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ] || [ "$(node_major "$NODE_BIN")" -lt 20 ]; then
  arch="$(uname -m)"
  case "$arch" in aarch64|arm64) na=arm64 ;; x86_64|amd64) na=x64 ;; *) die "unsupported CPU: $arch" ;; esac
  ver="$(curl -fsSL --max-time 30 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt 2>/dev/null | grep -o "node-v22[0-9.]*-linux-$na.tar.xz" | head -1 | sed -E 's/node-(v[0-9.]+)-.*/\1/')"
  ver="${ver:-$NODE_FALLBACK}"
  dest="$HOME/.local/node-$ver"
  if [ ! -x "$dest/bin/node" ]; then
    say "no Node ≥ 20 on this host; installing Node $ver ($na) into $dest"
    mkdir -p "$HOME/.local"
    tmp="$(mktemp -d)"
    curl -fsSL --max-time 600 "https://nodejs.org/dist/$ver/node-$ver-linux-$na.tar.xz" -o "$tmp/node.tar.xz"
    tar -xJf "$tmp/node.tar.xz" -C "$tmp"
    mv "$tmp/node-$ver-linux-$na" "$dest"
    rm -rf "$tmp"
  fi
  NODE_BIN="$dest/bin/node"
  export PATH="$dest/bin:$PATH"
fi
say "node $("$NODE_BIN" -v) at $NODE_BIN"

# --- server dependencies (pure JavaScript: express, ws, pg, mysql2) --------------------
say "installing server dependencies"
(cd server && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
mkdir -p "$DATA"

# --- run it: systemd user service when available, nohup otherwise --------------------
start_nohup() {
  pkill -f "$ROOT/server/dist/index.js" 2>/dev/null || true
  (cd server && PORT="$PORT" HOST=0.0.0.0 GRIDWRIGHT_DATA="$DATA" CLIENT_DIR="$ROOT/client/dist" \
    GRIDWRIGHT_TOKEN="${GW_TOKEN:-}" AI_BASE_URL="${AI_BASE_URL:-}" AI_MODEL="${AI_MODEL:-}" AI_API_KEY="${AI_API_KEY:-}" \
    nohup "$NODE_BIN" "$ROOT/server/dist/index.js" > "$DATA/server.log" 2>&1 &)
  say "started with nohup (no systemd user session); log: $DATA/server.log"
}

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  unit="$HOME/.config/systemd/user/gridwright.service"
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<EOF
[Unit]
Description=Gridwright spreadsheet server
After=network-online.target

[Service]
WorkingDirectory=$ROOT/server
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=0.0.0.0
Environment=GRIDWRIGHT_DATA=$DATA
Environment=CLIENT_DIR=$ROOT/client/dist
Environment=GRIDWRIGHT_TOKEN=${GW_TOKEN:-}
Environment=AI_BASE_URL=${AI_BASE_URL:-}
Environment=AI_MODEL=${AI_MODEL:-}
Environment=AI_API_KEY=${AI_API_KEY:-}
ExecStart=$NODE_BIN $ROOT/server/dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable gridwright.service >/dev/null 2>&1
  systemctl --user restart gridwright.service
  say "systemd user service installed: systemctl --user status gridwright · journalctl --user -u gridwright -f"
  if loginctl enable-linger "$USER" >/dev/null 2>&1; then
    say "linger enabled: the service keeps running after logout and starts at boot"
  else
    say "to keep it running after logout / start at boot: sudo loginctl enable-linger $USER"
  fi
else
  start_nohup
fi

# --- health ------------------------------------------------------------------------
for i in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
  [ "$i" -eq 20 ] && { [ -f "$DATA/server.log" ] && tail -n 30 "$DATA/server.log"; journalctl --user -u gridwright --no-pager -n 30 2>/dev/null || true; die "server did not answer on port $PORT"; }
done
ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
ts="$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -1 || true)"
say "Gridwright is up: http://${ts:-${ip:-localhost}}:$PORT${GW_TOKEN:+/?token=$GW_TOKEN}"
[ -n "$ts" ] && [ -n "$ip" ] && [ "$ts" != "$ip" ] && say "also on the LAN: http://$ip:$PORT"
say "data: $DATA   (documents, connections, AI settings, secret.key — back this up)"
