#!/usr/bin/env bash
# opencode-free-bridge installer.
#
#   curl -fsSL https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/install.sh | bash
#
# What it does:
#   1. requires Bun. The CLI ships as a Bun binary and the free-tier gate checks
#      the transport fingerprint: measured 200 on Bun, 403 on Node and curl.
#   2. copies server.js, token-budget.js and verify.js into an install dir
#   3. registers a service so the bridge starts on boot and restarts on crash
#      (systemd on Linux, launchd on macOS, a logon task on Windows Git Bash)
#   4. starts it and runs the self-check
#
# Env overrides:
#   PORT       listen port            (default 20129)
#   HOST       bind address           (default 127.0.0.1)
#   BINDIR     where the files go     (default ~/.opencode-free-bridge)
#   NO_SERVICE skip service install   (default: install the service)
#   REPO       source repo            (default azrinaldi/opencode-free-bridge)
set -euo pipefail

PORT="${PORT:-20129}"
HOST="${HOST:-127.0.0.1}"
BINDIR="${BINDIR:-$HOME/.opencode-free-bridge}"
REPO="${REPO:-azrinaldi/opencode-free-bridge}"
BRANCH="${BRANCH:-main}"

say()  { printf '\033[1;32m[opencode-free-bridge]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[opencode-free-bridge]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[opencode-free-bridge]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- Node.js ---
# Bun is required, not preferred. Measured from one IP in one minute with
# identical headers and body: the real CLI and the bridge on Bun both get 200,
# while Node and curl get 403. The CLI ships as a Bun binary, and the free-tier
# gate inspects the transport fingerprint, so only Bun reproduces it.
if command -v bun >/dev/null 2>&1; then
  RUNTIME="$(command -v bun)"
  say "runtime: bun ($("$RUNTIME" --version)) — matches the CLI's transport"
elif [ -n "${ALLOW_NODE:-}" ] && command -v node >/dev/null 2>&1; then
  RUNTIME="$(command -v node)"
  warn "runtime: node — NOT supported for live use. The free-tier gate refuses Node's"
  warn "transport fingerprint with 403. Proceeding because ALLOW_NODE is set."
else
  die "Bun is required but not found. Install it: https://bun.sh
     (Node does not work: the free-tier gate returns 403 for its TLS fingerprint.
      Set ALLOW_NODE=1 to install anyway for offline work.)"
fi
# Bun has no version gate here: the bridge uses only long-stable APIs, and Bun
# 1.4.2 (the CLI's own bundled version) and 1.4.3 were both verified. Node does.
if [ "$(basename "$RUNTIME")" = "node" ]; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 18 ] || die "Node.js >= 18 required (found $(node -v))"
fi

# -------------------------------------------------------------- migration ---
# Upgrading from 1.x or early 2.x means three things change underneath:
#
#   * the runtime (node -> bun), so any service unit still says `node`
#   * the file set (identity.js and the transport tools are new), so a partial
#     copy from an older installer leaves a bridge that cannot start
#   * the transport itself, so an old install that "worked" now needs Bun to
#     get anything but 403
#
# The old files are moved aside rather than deleted, so a failed upgrade can be
# undone by hand.
PREV_VERSION=""
if [ -f "$BINDIR/package.json" ]; then
  PREV_VERSION="$("$RUNTIME" -e 'try{process.stdout.write(require(process.argv[1]).version||"")}catch{}' "$BINDIR/package.json" 2>/dev/null || true)"
fi
if [ -n "$PREV_VERSION" ]; then
  say "Found existing install: v$PREV_VERSION in $BINDIR"
  BACKUP="$BINDIR/.backup-v$PREV_VERSION-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$BACKUP"
  for f in server.js identity.js token-budget.js verify.js gate-drill.js package.json; do
    [ -f "$BINDIR/$f" ] && cp -p "$BINDIR/$f" "$BACKUP/$f" 2>/dev/null || true
  done
  say "Backed up to $BACKUP"
  if [ -f "$BINDIR/server.js" ] && ! grep -q '#!/usr/bin/env bun' "$BINDIR/server.js" 2>/dev/null; then
    say "Old install ran on Node; this version requires Bun for the live gate"
  fi
fi

# A service unit written by an older installer still points at `node`, which
# would silently keep failing after the upgrade. Rewrite it if we can.
migrate_service_runtime() {
  local unit
  for unit in "/etc/systemd/system/opencode-free-bridge.service" \
              "$HOME/.config/systemd/user/opencode-free-bridge.service"; do
    [ -f "$unit" ] || continue
    if grep -q 'ExecStart=.*node' "$unit" 2>/dev/null; then
      sed -i.bak -E "s|^ExecStart=.*|ExecStart=\"$RUNTIME\" \"$BINDIR/server.js\"|" "$unit" 2>/dev/null || {
        warn "could not rewrite $unit — update ExecStart to: \"$RUNTIME\" \"$BINDIR/server.js\""
        continue
      }
      say "Service unit updated to run under $(basename "$RUNTIME"): $unit"
      if [ "${unit#/etc}" != "$unit" ]; then
        systemctl daemon-reload 2>/dev/null || true
      else
        systemctl --user daemon-reload 2>/dev/null || true
      fi
    fi
  done
  local plist="$HOME/Library/LaunchAgents/com.opencode-free-bridge.plist"
  if [ -f "$plist" ] && grep -q '<string>.*node</string>' "$plist" 2>/dev/null; then
    sed -i.bak -E "s|<string>[^<]*node</string>|<string>$RUNTIME</string>|" "$plist" 2>/dev/null || true
    say "launchd agent updated to run under $(basename "$RUNTIME")"
  fi
}
migrate_service_runtime

# ------------------------------------------------------------------ fetch ---
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
mkdir -p "$BINDIR"
say "Installing into $BINDIR"

fetch() {
  local file="$1"
  local tmp="$BINDIR/.$file.tmp.$$"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$tmp" "$RAW/$file"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp" "$RAW/$file"
  else
    die "neither curl nor wget is available"
  fi
  mv -f "$tmp" "$BINDIR/$file"
}

fetch package.json
fetch server.js
fetch identity.js
fetch token-budget.js
fetch verify.js
fetch gate-drill.js
fetch transport-fingerprint.js
fetch transport-baseline.json
chmod +x "$BINDIR/server.js" "$BINDIR/verify.js" "$BINDIR/gate-drill.js" 2>/dev/null || true
say "Files installed (v$(node -p 'require(process.argv[1]).version' "$BINDIR/package.json" 2>/dev/null || echo 'latest'))"

# ---------------------------------------------------------------- service ---
install_service() {
  local os
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"

  if [ "$os" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
    local unit_dir="/etc/systemd/system"
    local unit="$unit_dir/opencode-free-bridge.service"
    if [ -w "$unit_dir" ]; then
      cat > "$unit" <<UNIT
[Unit]
Description=OpenCode Free Bridge (OpenAI-compatible, free-tier models)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory="$BINDIR"
Environment=PORT=$PORT
Environment=HOST=$HOST
ExecStart="$RUNTIME" "$BINDIR/server.js"
Restart=always
RestartSec=3
MemoryMax=512M

[Install]
WantedBy=multi-user.target
UNIT
      systemctl daemon-reload
      systemctl enable opencode-free-bridge >/dev/null 2>&1 || true
      systemctl restart opencode-free-bridge
      say "systemd service installed and restarted"
      return 0
    elif systemctl --user status >/dev/null 2>&1; then
      local user_unit_dir="$HOME/.config/systemd/user"
      local user_unit="$user_unit_dir/opencode-free-bridge.service"
      mkdir -p "$user_unit_dir"
      cat > "$user_unit" <<UNIT
[Unit]
Description=OpenCode Free Bridge (OpenAI-compatible, free-tier models)
After=network-online.target

[Service]
Type=simple
WorkingDirectory="$BINDIR"
Environment=PORT=$PORT
Environment=HOST=$HOST
ExecStart="$RUNTIME" "$BINDIR/server.js"
Restart=always
RestartSec=3
MemoryMax=512M
[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload
      systemctl --user enable opencode-free-bridge >/dev/null 2>&1 || true
      systemctl --user restart opencode-free-bridge
      say "systemd --user service installed and restarted"
      return 0
    else
      warn "no write access to $unit_dir — skipping service install (run with sudo to enable it)"
      return 1
    fi
  fi

  if [ "$os" = "darwin" ]; then
    local plist="$HOME/Library/LaunchAgents/com.opencode-free-bridge.plist"
    mkdir -p "$(dirname "$plist")"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.opencode-free-bridge</string>
  <key>ProgramArguments</key>
  <array><string>$RUNTIME</string><string>$BINDIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$BINDIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PORT</key><string>$PORT</string><key>HOST</key><string>$HOST</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
    launchctl unload "$plist" >/dev/null 2>&1 || true
    launchctl load "$plist"
    say "launchd agent installed and restarted"
    return 0
  fi

  warn "no supported service manager found — start it manually: PORT=$PORT $RUNTIME $BINDIR/server.js"
  return 1
}

SERVICE_OK=1
if [ "${NO_SERVICE:-0}" != "1" ]; then
  install_service || SERVICE_OK=0
else
  SERVICE_OK=0
fi

# ------------------------------------------------------------ start check ---
if [ "$SERVICE_OK" != "1" ]; then
  say "Starting in the background (no service manager)"
  pkill -f -- "$BINDIR/server.js" 2>/dev/null || true
  sleep 0.5
  (cd "$BINDIR" && PORT="$PORT" HOST="$HOST" nohup "$RUNTIME" server.js >"$BINDIR/bridge.log" 2>&1 &)
fi

say "Waiting for the bridge to come up..."
for _ in $(seq 1 20); do
  if curl -fsS "http://$HOST:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo
say "Running self-check (quick — full check: $RUNTIME $BINDIR/verify.js)"
echo
PORT="$PORT" HOST="$HOST" "$RUNTIME" "$BINDIR/verify.js" --quick || true

echo
say "Done."
cat <<NEXT

  Endpoint : http://$HOST:$PORT/v1
  API key  : public  (any value is accepted)
  Models   : curl http://$HOST:$PORT/v1/models

  Add it to 9Router, Cursor, Continue, or any OpenAI-compatible client as a
  custom provider. Re-run the self-check any time with:

      "$RUNTIME" $BINDIR/verify.js

NEXT

if [ "$SERVICE_OK" = "1" ]; then
  if command -v systemctl >/dev/null 2>&1 && [ "$(uname -s)" = "Linux" ]; then
    echo "  Logs     : journalctl -u opencode-free-bridge -f"
  else
    echo "  Logs     : tail -f ~/Library/Logs/opencode-free-bridge.log"
  fi
fi
echo
