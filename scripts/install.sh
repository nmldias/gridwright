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
#   --python           create a Python virtual environment in the data directory (pandas, numpy,
#                      matplotlib, openpyxl) for server-side Python cells. Without it the host's
#                      python3 is used as it is. For GPU cells install RAPIDS into that venv:
#                      ~/gridwright-data/pyenv/bin/pip install --extra-index-url=https://pypi.nvidia.com "cudf-cu13"
#                      (pick the cuXX that matches `nvidia-smi`; see rapids.ai/start).
#   --companion        install the companion's investigation stack (LangChain, DeepAgents, LangGraph,
#                      SQLite checkpoints) into the --python venv (created if missing), so *Investigate*
#                      in Ask works; the stack runs as a separate process and calls the server back over
#                      the loopback interface with a short-lived token for the requesting person.
#   --sandbox          strongest isolation for server-side Python cells: installs bubblewrap and, on
#                      Ubuntu ≥ 23.10 (DGX OS included), an AppArmor profile that lets it create user
#                      namespaces — without it those kernels confine the namespace and cells run as a
#                      plain process. Uses sudo once; re-run the installer afterwards is not needed.
#   --no-backup        do not install the nightly backup timer.
#
# Environment:
#   GW_PORT      listen port (default 8787)
#   GW_DATA      data directory (default ~/gridwright-data)
#   GW_TOKEN     optional shared access token (empty = open to anyone who can reach the port)
#   GW_ADMINS    comma-separated Tailscale logins allowed to manage connections/AI/backups (with --tailscale)
#   GW_READONLY  comma-separated Tailscale logins that may only view (with --tailscale)
#   GW_DEFAULT_SHARING  sharing level of new documents: none (private, default with --tailscale), view or edit
#   GW_PYTHON           interpreter for server-side Python cells (default: the --python venv, else python3); "off" disables
#   GW_PYTHON_SANDBOX   auto (default: bubblewrap → user namespace → none), bwrap, unshare, none, or require
#                       (refuse to run cells without a namespace sandbox)
#   GW_PYTHON_TIMEOUT_MS, GW_PYTHON_MEMORY_MB, GW_PYTHON_CONCURRENCY, GW_PYTHON_THREADS
#                       per-run limits: wall clock (60000 ms), memory (default a quarter of RAM, at most half of
#                       what is free at start), parallel runs (2), BLAS threads per run (4)
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
PYVENV=0
SANDBOX=0
COMPANION=0
BACKUP=1
for a in "$@"; do
  case "$a" in
    --tailscale) TAILSCALE=1 ;;
    --pyodide) PYODIDE=1 ;;
    --python) PYVENV=1 ;;
    --companion) PYVENV=1; COMPANION=1 ;;
    --sandbox) SANDBOX=1 ;;
    --no-backup) BACKUP=0 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\033[32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

[ -f server/dist/index.js ] && [ -f client/dist/index.html ] || die "this is not the prebuilt release (server/dist or client/dist missing) — run scripts/build.sh first"
[ -f server/engine/gridwright_core.js ] || echo "note: server/engine is missing, so the MCP server and proposals will be off (rebuild with scripts/build.sh or fetch a newer release)" >&2
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

# --- Python for server-side cells -----------------------------------------------------------
if [ "$PYVENV" = 1 ]; then
  command -v python3 >/dev/null 2>&1 || die "--python needs python3 on this host (sudo apt install python3 python3-venv)"
  if [ -x "$DATA/pyenv/bin/python" ]; then
    say "Python venv already present in $DATA/pyenv (adding missing packages only — versions you installed, e.g. RAPIDS and the numpy it pins, are left alone)"
  else
    say "creating a Python venv in $DATA/pyenv"
    python3 -m venv "$DATA/pyenv" || die "python3 -m venv failed (sudo apt install python3-venv)"
  fi
  "$DATA/pyenv/bin/pip" install -q --upgrade pip >/dev/null 2>&1 || true
  # no --upgrade: an existing numpy/pandas stays as it is, because cuDF's numba pins numpy and a blind upgrade breaks the GPU path
  "$DATA/pyenv/bin/pip" install -q pandas numpy matplotlib openpyxl || die "pip install failed (is the internet reachable?)"
  say "venv ready: $("$DATA/pyenv/bin/python" --version) with pandas $("$DATA/pyenv/bin/python" -c 'import pandas; print(pandas.__version__)')"
  if [ "${COMPANION:-0}" = 1 ]; then
    say "installing the companion's investigation stack into the venv (LangChain, DeepAgents, LangGraph)"
    "$DATA/pyenv/bin/pip" install -q -r "$ROOT/integrations/companion/requirements.txt" || die "pip install of the investigation stack failed (is the internet reachable?)"
    say "investigation stack: $("$DATA/pyenv/bin/python" "$ROOT/integrations/companion/investigate.py" --probe)"
  fi
fi
if [ "$SANDBOX" = 1 ]; then
  command -v sudo >/dev/null 2>&1 || die "--sandbox needs sudo"
  if ! command -v bwrap >/dev/null 2>&1; then
    say "installing bubblewrap (sudo)"
    sudo apt-get install -y -qq bubblewrap >/dev/null || die "apt-get install bubblewrap failed"
  fi
  bwrap_ok() { bwrap --ro-bind / / --tmpfs /tmp --proc /proc --dev /dev --unshare-all --die-with-parent true 2>"$DATA/.bwrap-test.err"; }
  bwrap_err() { tail -n 1 "$DATA/.bwrap-test.err" 2>/dev/null; }
  profile_text() {
    printf 'abi <abi/4.0>,\ninclude <tunables/global>\n\n# Lets bubblewrap create user namespaces on kernels with apparmor_restrict_unprivileged_userns=1\n# (installed by gridwright/scripts/install.sh --sandbox). The sandbox itself is set up by bwrap.\nprofile bwrap %s flags=(unconfined) {\n  userns,\n\n  include if exists <local/bwrap>\n}\n' "$(command -v bwrap)"
  }
  mkdir -p "$DATA"
  if bwrap_ok; then
    say "bubblewrap sandbox works"
  elif [ ! -d /etc/apparmor.d ]; then
    echo "warning: bubblewrap cannot set up its sandbox ($(bwrap_err)) and this host has no AppArmor; cells will fall back" >&2
  elif [ -f /etc/apparmor.d/bwrap ] && ! grep -q gridwright /etc/apparmor.d/bwrap; then
    echo "warning: bubblewrap cannot set up its sandbox ($(bwrap_err)) and /etc/apparmor.d/bwrap already exists (not Gridwright's):" >&2
    sed 's/^/    /' /etc/apparmor.d/bwrap >&2
    echo "  If that profile confines bwrap's children, move it aside and re-run:" >&2
    echo "    sudo apparmor_parser -R /etc/apparmor.d/bwrap && sudo mv /etc/apparmor.d/bwrap /etc/apparmor.d/disable/ && scripts/install.sh --sandbox" >&2
  else
    say "bubblewrap cannot set up its sandbox ($(bwrap_err)); adding an AppArmor profile that lets it create user namespaces (sudo)"
    profile_text | sudo tee /etc/apparmor.d/bwrap >/dev/null
    sudo apparmor_parser -r -T -W /etc/apparmor.d/bwrap || die "apparmor_parser failed (is apparmor installed?)"
    if bwrap_ok; then
      say "bubblewrap sandbox works"
    else
      echo "warning: bubblewrap still cannot set up its sandbox: $(bwrap_err)" >&2
      echo "  $(sysctl kernel.apparmor_restrict_unprivileged_userns kernel.apparmor_restrict_unprivileged_unconfined 2>&1 | tr '\n' ' ')" >&2
      echo "  loaded profile: $(sudo aa-status 2>/dev/null | grep -c -i bwrap) match(es); kernel $(uname -r). Please report this output." >&2
    fi
  fi
elif ! command -v bwrap >/dev/null 2>&1 || [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] && [ ! -f /etc/apparmor.d/bwrap ]; then
  echo "note: for the strongest isolation of server-side Python cells run the installer with --sandbox (bubblewrap + an AppArmor profile; needs sudo once)" >&2
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
Environment=GRIDWRIGHT_DEFAULT_SHARING=${GW_DEFAULT_SHARING:-}
Environment=GRIDWRIGHT_PYTHON=${GW_PYTHON:-}
Environment=GRIDWRIGHT_PYTHON_SANDBOX=${GW_PYTHON_SANDBOX:-}
Environment=GRIDWRIGHT_PYTHON_TIMEOUT_MS=${GW_PYTHON_TIMEOUT_MS:-}
Environment=GRIDWRIGHT_PYTHON_MEMORY_MB=${GW_PYTHON_MEMORY_MB:-}
Environment=GRIDWRIGHT_PYTHON_CONCURRENCY=${GW_PYTHON_CONCURRENCY:-}
Environment=GRIDWRIGHT_PYTHON_THREADS=${GW_PYTHON_THREADS:-}
Environment=AI_BASE_URL=${AI_BASE_URL:-}
Environment=AI_MODEL=${AI_MODEL:-}
Environment=AI_API_KEY=${AI_API_KEY:-}
EOF
}

start_nohup() {
  pkill -f "$ROOT/server/dist/index.js" 2>/dev/null || true
  (cd server && PORT="$PORT" HOST="$HOST_BIND" GRIDWRIGHT_DATA="$DATA" CLIENT_DIR="$ROOT/client/dist" \
    GRIDWRIGHT_TOKEN="${GW_TOKEN:-}" GRIDWRIGHT_TRUST_TAILSCALE="$TRUST" GRIDWRIGHT_ADMINS="${GW_ADMINS:-}" GRIDWRIGHT_READONLY="${GW_READONLY:-}" GRIDWRIGHT_DEFAULT_SHARING="${GW_DEFAULT_SHARING:-}" \
    GRIDWRIGHT_PYTHON="${GW_PYTHON:-}" GRIDWRIGHT_PYTHON_SANDBOX="${GW_PYTHON_SANDBOX:-}" GRIDWRIGHT_PYTHON_TIMEOUT_MS="${GW_PYTHON_TIMEOUT_MS:-}" GRIDWRIGHT_PYTHON_MEMORY_MB="${GW_PYTHON_MEMORY_MB:-}" GRIDWRIGHT_PYTHON_CONCURRENCY="${GW_PYTHON_CONCURRENCY:-}" GRIDWRIGHT_PYTHON_THREADS="${GW_PYTHON_THREADS:-}" \
    AI_BASE_URL="${AI_BASE_URL:-}" AI_MODEL="${AI_MODEL:-}" AI_API_KEY="${AI_API_KEY:-}" \
    setsid -f nohup "$NODE_BIN" "$ROOT/server/dist/index.js" > "$DATA/server.log" 2>&1 < /dev/null)
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
tar -czf "$BACKUP_DIR/gridwright-\$stamp.tar.gz" -C "$DATA" --exclude=./pyodide --exclude=./pyenv --exclude=./pycache --exclude=./server.log --exclude=./backup.sh .
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

# the runtime is probed in the background right after start (a second or two), then the GPU probe
# imports cuDF when it is installed (can take a while on first use) — wait for both, within reason
for i in $(seq 1 40); do
  curl -fsS -H "Authorization: Bearer ${GW_TOKEN:-}" "http://127.0.0.1:$PORT/api/python" 2>/dev/null | grep -q '"not probed yet"' || break
  sleep 0.5
done
if "$DATA/pyenv/bin/python" -c 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("cudf") else 1)' 2>/dev/null; then
  say "cuDF is installed in the venv — waiting for the GPU probe"
  for i in $(seq 1 90); do
    curl -fsS -H "Authorization: Bearer ${GW_TOKEN:-}" "http://127.0.0.1:$PORT/api/python" 2>/dev/null | grep -q '"gpu":null' || break
    sleep 1
  done
fi
py_line="$(curl -fsS -H "Authorization: Bearer ${GW_TOKEN:-}" "http://127.0.0.1:$PORT/api/python" 2>/dev/null | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s);process.stdout.write(p.available?`CPython ${p.version}, sandbox: ${p.sandbox}${p.sandbox!=="bwrap"&&p.fallbacks?" ("+p.fallbacks+" — run the installer with --sandbox)":""}${p.gpu===null?", GPU: still probing (see Settings → Re-check server Python)":p.gpu.startsWith("cudf")?", GPU: "+p.gpu:", GPU: "+p.gpu}`:"off — "+(p.reason||"no python3 found (run with --python or set GW_PYTHON)"))}catch{process.stdout.write("unknown")}})')"
say "server-side Python cells: $py_line"

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
