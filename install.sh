#!/usr/bin/env bash
# opencode-free-bridge installer.
#
#   curl -fsSL https://raw.githubusercontent.com/azrinaldi/opencode-free-bridge/main/install.sh | bash
#
# What it does:
#   1. picks a runtime: Bun if present, otherwise Node >= 18. The CLI ships as a
#      Bun binary, so Bun reproduces its TLS ClientHello exactly; Node differs in
#      cipher count and extension order (see README). Both pass every gate.
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
# Prefer Bun: it reproduces the CLI's transport fingerprint byte for byte.
if command -v bun >/dev/null 2>&1; then
  RUNTIME="$(command -v bun)"
  say "runtime: bun ($("$RUNTIME" --version)) — matches the CLI's TLS fingerprint"
elif command -v node >/dev/null 2>&1; then
  RUNTIME="$(command -v node)"
  warn "runtime: node ($("$RUNTIME" --version)) — works, but the TLS ClientHello differs from the CLI's; install Bun to match it: https://bun.sh"
else
  die "No runtime found. Install Bun (https://bun.sh) or Node.js >= 18 (https://nodejs.org)"
fi
# Bun needs no version gate here (the bridge uses only long-stable APIs); Node does.
if [ "$(basename "$RUNTIME")" = "node" ]; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 18 ] || die "Node.js >= 18 required (found $(node -v))"
fi

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
chmod +x "$BINDIR/server.js" "$BINDIR/verify.js" 2>/dev/null || true
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
  (cd "$BINDIR" && PORT="$PORT" HOST="$HOST" nohup node server.js >"$BINDIR/bridge.log" 2>&1 &)
fi

say "Waiting for the bridge to come up..."
for _ in $(seq 1 20); do
  if curl -fsS "http://$HOST:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo
say "Running self-check (quick — full check: $RUNTIME $BINDIR/verify.js)"
echo
PORT="$PORT" HOST="$HOST" node "$BINDIR/verify.js" --quick || true

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
