#!/usr/bin/env bash
# The installer without systemd (review 11 Oct 2026: 1.2, 1.3, 1.11a). Four runs of scripts/install.sh,
# each from a copy of the built tree, with a throwaway HOME (so `systemctl --user` is unavailable and
# the nohup fallback starts the server) and its own data directory:
#
#   A  no sign-in mode, no GW_TOKEN   → a shared token is generated; the API refuses requests without it
#   B  re-run                          → the same token is kept
#   C  GW_TOKEN with " \ $ in it      → that token is used
#   D  re-run                          → it is read back from the secrets file byte for byte
#
# Every run: the nohup path is taken and the server it starts has its environment (the settings check
# passes; the token is in the process environment, not on its command line); the secrets file is 0600.
#
#   e2e/installer_nohup.sh [port]      (needs a built tree — server/dist, client/dist — and npm registry access)
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8805}"
W="$(mktemp -d /tmp/gw-inst-XXXXXX)"
APP="$W/app"
DATA="$W/data"
HOMEDIR="$W/home"
SECRETS="$HOMEDIR/.config/gridwright/gridwright.env"
pass=0
fail=0
check() { # $1 = name, $2 = 0 when it holds, $3 = detail
  if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1${3:+ — $3}"; fi
}
stop_server() { pkill -f "$APP/server/dist/index.js" 2>/dev/null; for _ in $(seq 1 40); do pgrep -f "$APP/server/dist/index.js" >/dev/null || return 0; sleep 0.25; done; pkill -9 -f "$APP/server/dist/index.js" 2>/dev/null; }
cleanup() { stop_server; rm -r -f -- "$W"; }
trap cleanup EXIT

[ -f "$SRC/server/dist/index.js" ] && [ -f "$SRC/client/dist/index.html" ] || { echo "build the tree first (server/dist, client/dist)"; exit 2; }
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then echo "port $PORT is in use"; exit 2; fi
mkdir -p "$APP" "$HOMEDIR"
rsync -a --exclude node_modules --exclude /data --exclude /src "$SRC/server/" "$APP/server/"
mkdir -p "$APP/client" && rsync -a "$SRC/client/dist/" "$APP/client/dist/"
rsync -a "$SRC/scripts/" "$APP/scripts/"
# INSTALL_SH: run another installer against the same tree (e.g. an older one, for comparison)
[ -n "${INSTALL_SH:-}" ] && cp "$INSTALL_SH" "$APP/scripts/install.sh"

install_run() { # $1 = label, rest = extra env assignments
  local label="$1"; shift
  stop_server
  # a HOME of its own and no user session bus: systemctl --user cannot work, so the installer falls back to nohup
  (cd "$APP" && env -u XDG_RUNTIME_DIR -u DBUS_SESSION_BUS_ADDRESS -u XDG_CONFIG_HOME -u GW_TOKEN -u AI_API_KEY \
     HOME="$HOMEDIR" GW_PORT="$PORT" GW_DATA="$DATA" npm_config_cache="$W/npm-cache" "$@" \
     bash scripts/install.sh --no-backup) > "$W/install-$label.log" 2>&1
  echo $?
}
server_pid() { pgrep -f "$APP/server/dist/index.js" | head -1; }
env_of() { tr '\0' '\n' < "/proc/$1/environ" | grep -m1 "^$2=" | cut -d= -f2-; }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

run_checks() { # $1 = label, $2 = installer exit, $3 = expected token ('' = whatever was generated)
  local label="$1" rc="$2" want="$3" log="$W/install-$1.log" pid tok
  check "$label: the installer finishes" "$([ "$rc" = 0 ]; echo $?)" "exit $rc: $(tail -3 "$log" | tr '\n' ' ' | cut -c1-300)"
  check "$label: …with the nohup fallback (no systemd user session)" "$(grep -q 'started with nohup' "$log"; echo $?)"
  check "$label: …and the settings check passes: shared-token mode" "$(grep -q 'settings check: sign-in mode none, shared token true' "$log"; echo $?)" "$(grep -i 'settings check\|ERROR' "$log" | head -2 | cut -c1-300)"
  pid="$(server_pid)"
  check "$label: the server is running" "$([ -n "$pid" ]; echo $?)"
  [ -n "$pid" ] || return
  tok="$(env_of "$pid" GRIDWRIGHT_TOKEN)"
  check "$label: the server got its environment (port, data directory, token)" "$([ "$(env_of "$pid" PORT)" = "$PORT" ] && [ "$(env_of "$pid" GRIDWRIGHT_DATA)" = "$DATA" ] && [ -n "$tok" ]; echo $?)" "PORT=$(env_of "$pid" PORT) DATA=$(env_of "$pid" GRIDWRIGHT_DATA) token=${tok:+set}"
  if [ -n "$want" ]; then check "$label: …with the expected token" "$([ "$tok" = "$want" ]; echo $?)" "got ${#tok} chars"; fi
  check "$label: the token is not on the command line (other users can read it)" "$(ps -o args= -p "$pid" | grep -qF -- "$tok" && echo 1 || echo 0)"
  check "$label: the API refuses a request without the token" "$([ "$(status "http://127.0.0.1:$PORT/api/files")" = 401 ]; echo $?)"
  check "$label: …and accepts it with the token" "$([ "$(status -H "Authorization: Bearer $tok" "http://127.0.0.1:$PORT/api/files")" = 200 ]; echo $?)"
  local mode dmode
  mode="$(stat -c %a "$SECRETS" 2>/dev/null)"; dmode="$(stat -c %a "$(dirname "$SECRETS")" 2>/dev/null)"
  check "$label: the secrets file is private (0600, folder 0700)" "$([ "$mode" = 600 ] && [ "$dmode" = 700 ]; echo $?)" "file $mode, folder $dmode"
  check "$label: …and holds the token" "$(grep -q '^GRIDWRIGHT_TOKEN=".\+"$' "$SECRETS"; echo $?)"
  LAST_TOKEN="$tok"
}

LAST_TOKEN=""
rc="$(install_run A)"; run_checks A "$rc" ""
GENERATED="$LAST_TOKEN"
check "A: a token was generated (≥ 32 characters)" "$([ ${#GENERATED} -ge 32 ]; echo $?)" "${#GENERATED} chars"
check "A: the installer says where it is kept" "$(grep -q 'generated a shared access token' "$W/install-A.log"; echo $?)"
rc="$(install_run B)"; run_checks B "$rc" "$GENERATED"
SPECIAL='tok"en\with$pecial-chars-2026'
rc="$(install_run C GW_TOKEN="$SPECIAL")"; run_checks C "$rc" "$SPECIAL"
rc="$(install_run D)"; run_checks D "$rc" "$SPECIAL"

echo
echo "$pass/$((pass + fail)) checks passed"
[ "$fail" = 0 ]
