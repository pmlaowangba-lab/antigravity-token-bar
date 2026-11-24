#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$REPO_ROOT/build/AntigravityTokenBar.app"

if [ ! -x "$APP_DIR/Contents/MacOS/TokenBarApp" ]; then
  bash "$REPO_ROOT/scripts/build-macos-app.sh"
fi

pkill -f "AntigravityTokenBar.app/Contents/MacOS/TokenBarApp" 2>/dev/null || true
pkill -f "antigravity-token-bar/src/server.js" 2>/dev/null || true
OLD_PID="$(lsof -t -iTCP:19825 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$OLD_PID" ]; then
  kill "$OLD_PID" 2>/dev/null || true
fi
sleep 0.5

/usr/bin/open "$APP_DIR"
echo "[antigravity-token-bar] Started $APP_DIR (http://127.0.0.1:19825/)"
