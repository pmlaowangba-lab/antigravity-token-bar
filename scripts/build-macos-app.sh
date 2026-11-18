#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$REPO_ROOT/build/AntigravityTokenBar.app"

mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$REPO_ROOT/macos/Info.plist" "$APP_DIR/Contents/Info.plist"
printf '%s\n' "$REPO_ROOT/src/server.js" > "$APP_DIR/Contents/Resources/server-path.txt"

swiftc -O -parse-as-library \
  "$REPO_ROOT/macos/TokenBarApp.swift" \
  -o "$APP_DIR/Contents/MacOS/TokenBarApp" \
  -framework AppKit -framework WebKit -framework CoreGraphics -framework Foundation

codesign --force --deep --sign - "$APP_DIR"
echo "[antigravity-token-bar] Built $APP_DIR"
