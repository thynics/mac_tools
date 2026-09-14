#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/build"
APP="$BUILD_DIR/Biweekly.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun swiftc -O -target "$(uname -m)-apple-macosx13.0" -framework Cocoa -framework WebKit -framework UniformTypeIdentifiers "$ROOT/Sources/main.swift" -o "$APP/Contents/MacOS/Biweekly"
rsync -a --delete "$ROOT/web/" "$APP/Contents/Resources/web/"
cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
if [ -f "$ROOT/AppIcon.icns" ]; then cp "$ROOT/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"; fi
codesign --force --deep --sign - "$APP"
printf 'Built %s\n' "$APP"
if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  ditto "$APP" "$HOME/Applications/Biweekly.app"
  printf 'Installed %s\n' "$HOME/Applications/Biweekly.app"
fi
