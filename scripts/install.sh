#!/usr/bin/env bash
# One-shot install of the prebuilt Gridwright release on a Linux host (arm64 or x86_64),
# without root: installs Node 22 into ~/.local if the host has no Node ≥ 20, installs the
# server dependencies, registers a systemd *user* service (survives reboots), a nightly
# backup timer, and optionally fronts the server with `tailscale serve` (HTTPS + identity).
#
#   tar -xzf gridwright.tar.gz && cd gridwright && scripts/install.sh [options]
#
# Options:
#   --tailscale        serve over HTTPS on the tailnet via `tailscale serve`; the server then
#                      binds to 127.0.0.1 and trusts Tailscale's identity headers (names, roles,
#                      audit log). Needs `sudo tailscale set --operator=$USER` once, and HTTPS
#                      certificates enabled in the Tailscale admin console (DNS → HTTPS Certificates).
#   --pyodide          download the Pyodide 0.27.5 distribution (~300 MB) into the data directory
#                      so Python cells work without internet access.
#   --no-backup        do not install the nightly backup timer.
#
# Environment:
#   GW_PORT      listen port (default 8787)
#   GW_DATA      data directory (default ~/gridwright-data)
#   GW_TOKEN     optional shared access token (empty = open to anyone who can reach the port)
#   GW_ADMINS    comma-separated Tailscale logins allowed to manage connections/AI/backups (with --tailscale)
#   GW_READONLY  comma-separated Tailscale logins that may only view (with --tailscale)
#   GW_BACKUP_DIR    where nightly backups go (default ~/gridwright-backups, 14 kept)
#   GW_BACKUP_TARGET optional rsync destination for the backups, e.g. nmldias@100.78.161.2:gridwright-backups/
#   AI_BASE_URL, AI_MODEL, AI_API_KEY   defaults for the assistant (also editable in the UI)
#
# Re-running the script is safe: it updates the service and restarts it.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PORT="${GW_PORT:-8787}"
DATA="${GW_DATA:-$HOME/gridwright-data}"
NODE_FALLBACK="v22.23.3"
PYODIDE_VERSION="0.27.5"
TAILSCALE=0
PYODIDE=0
BACKUP=1
for a in "$@"; do
  case "$a" in
    --tailscale) TAILSCALE=1 ;;
    --pyodide) PYODIDE=1 ;;
    --no-backup) BACKUP=0 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

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

# --- server dependencies (pure JavaScript: express, ws, pg, mysql2, mssql) --------------
say "installing server dependencies"
(cd server && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
mkdir -p "$DATA"

# --- optional: self-hosted Pyodide ----------------------------------------------------
if [ "$PYODIDE" = 1 ]; then
  if [ -f "$DATA/pyodide/pyodide.mjs" ]; then
    say "Pyodide already present in $DATA/pyodide"
  else
    say "downloading Pyodide $PYODIDE_VERSION (full distribution, this takes a while)"
    tmp="$(mktemp -d)"
    curl -fL --max-time 3600 --progress-bar "https://github.com/pyodide/pyodide/releases/download/$PYODIDE_VERSION/pyodide-$PYODIDE_VERSION.tar.bz2" -o "$tmp/pyodide.tar.bz2"
    tar -xjf "$tmp/pyodide.tar.bz2" -C "$tmp"
    rm -rf "$DATA/pyodide"
    mv "$tmp/pyodide" "$DATA/pyodide"
    rm -rf "$tmp"
    say "Pyodide installed: $(du -sh "$DATA/pyodide" | cut -f1) in $DATA/pyodide (served at /pyodide/)"
  fi
fi

# --- optional: tailscale serve ------------------------------------------------------------
HOST_BIND=0.0.0.0
TRUST=0
if [ "$TAILSCALE" = 1 ]; then
  command -v tailscale >/dev/null 2>&1 || die "tailscale is not installed on this host"
  HOST_BIND=127.0.0.1
  TRUST=1
fi

# --- run it: systemd user service when available, nohup otherwise --------------------------
unit_env() {
  cat <<EOF
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=$HOST_BIND
Environment=GRIDWRIGHT_DATA=$DATA
Environment=CLIENT_DIR=$ROOT/client/dist
Environment=GRIDWRIGHT_TOKEN=${GW_TOKEN:-}
Environment=GRIDWRIGHT_TRUST_TAILSCALE=$TRUST
Environment=GRIDWRIGHT_ADMINS=${GW_ADMINS:-}
Environment=GRIDWRIGHT_READONLY=${GW_READONLY:-}
Environment=AI_BASE_URL=${AI_BASE_URL:-}
Environment=AI_MODEL=${AI_MODEL:-}
Environment=AI_API_KEY=${AI_API_KEY:-}
EOF
}

start_nohup() {
  pkill -f "$ROOT/server/dist/index.js" 2>/dev/null || true
  (cd server && PORT="$PORT" HOST="$HOST_BIND" GRIDWRIGHT_DATA="$DATA" CLIENT_DIR="$ROOT/client/dist" \
    GRIDWRIGHT_TOKEN="${GW_TOKEN:-}" GRIDWRIGHT_TRUST_TAILSCALE="$TRUST" GRIDWRIGHT_ADMINS="${GW_ADMINS:-}" GRIDWRIGHT_READONLY="${GW_READONLY:-}" \
    AI_BASE_URL="${AI_BASE_URL:-}" AI_MODEL="${AI_MODEL:-}" AI_API_KEY="${AI_API_KEY:-}" \
    setsid nohup "$NODE_BIN" "$ROOT/server/dist/index.js" > "$DATA/server.log" 2>&1 < /dev/null &)
  say "started with nohup (no systemd user session); log: $DATA/server.log"
}

HAVE_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  HAVE_SYSTEMD=1
  unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"
  {
    printf '[Unit]\nDescription=Gridwright spreadsheet server\nAfter=network-online.target\n\n[Service]\nWorkingDirectory=%s/server\n' "$ROOT"
    unit_env
    printf 'ExecStart=%s %s/server/dist/index.js\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n' "$NODE_BIN" "$ROOT"
  } > "$unit_dir/gridwright.service"
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

# --- nightly backups ----------------------------------------------------------------------
if [ "$BACKUP" = 1 ]; then
  BACKUP_DIR="${GW_BACKUP_DIR:-$HOME/gridwright-backups}"
  mkdir -p "$BACKUP_DIR"
  cat > "$DATA/backup.sh" <<EOF
#!/usr/bin/env bash
# Nightly backup of the Gridwright data directory (documents, history, connections, settings).
set -euo pipefail
stamp="\$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/gridwright-\$stamp.tar.gz" -C "$DATA" --exclude=./pyodide --exclude=./server.log --exclude=./backup.sh .
ls -1t "$BACKUP_DIR"/gridwright-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
${GW_BACKUP_TARGET:+rsync -a --delete "$BACKUP_DIR/" "$GW_BACKUP_TARGET" || echo "rsync to $GW_BACKUP_TARGET failed" >&2}
echo "backup written: $BACKUP_DIR/gridwright-\$stamp.tar.gz"
EOF
  chmod +x "$DATA/backup.sh"
  if [ "$HAVE_SYSTEMD" = 1 ]; then
    cat > "$HOME/.config/systemd/user/gridwright-backup.service" <<EOF
[Unit]
Description=Gridwright nightly backup

[Service]
Type=oneshot
ExecStart=$DATA/backup.sh
EOF
    cat > "$HOME/.config/systemd/user/gridwright-backup.timer" <<EOF
[Unit]
Description=Gridwright nightly backup at 02:30

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now gridwright-backup.timer >/dev/null 2>&1
    say "nightly backup timer installed → $BACKUP_DIR (14 kept${GW_BACKUP_TARGET:+, mirrored to $GW_BACKUP_TARGET}); run now: $DATA/backup.sh"
  else
    say "backup script: $DATA/backup.sh (add it to cron: 30 2 * * * $DATA/backup.sh)"
  fi
fi

# --- health ------------------------------------------------------------------------------
for i in $(seq 1 30); do
  curl -fsS -H "Authorization: Bearer ${GW_TOKEN:-}" "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
  [ "$i" -eq 30 ] && { [ -f "$DATA/server.log" ] && tail -n 30 "$DATA/server.log"; journalctl --user -u gridwright --no-pager -n 30 2>/dev/null || true; die "server did not answer on port $PORT"; }
done

if [ "$TAILSCALE" = 1 ]; then
  if tailscale serve --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    fqdn="$(tailscale status --json 2>/dev/null | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.Self.DNSName||"").replace(/\.$/,""))}catch{}})')"
    say "Gridwright is up on the tailnet: https://${fqdn:-<this-machine>.<tailnet>.ts.net}/  (identity from Tailscale; admins: ${GW_ADMINS:-everyone})"
  else
    say "tailscale serve failed — run once: sudo tailscale set --operator=$USER   and enable HTTPS certificates in the admin console, then re-run with --tailscale"
    say "meanwhile the server listens on 127.0.0.1:$PORT only"
  fi
else
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  ts="$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -1 || true)"
  say "Gridwright is up: http://${ts:-${ip:-localhost}}:$PORT${GW_TOKEN:+/?token=$GW_TOKEN}"
  [ -n "$ts" ] && [ -n "$ip" ] && [ "$ts" != "$ip" ] && say "also on the LAN: http://$ip:$PORT"
fi
say "data: $DATA   (documents, history, connections, AI settings, secret.key — back this up)"
