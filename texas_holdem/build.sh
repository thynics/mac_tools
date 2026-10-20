#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h}"
APP="$ROOT/build/River Club.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun swiftc -O -framework Cocoa -framework WebKit "$ROOT/native/Main.swift" -o "$APP/Contents/MacOS/RiverClub"
cp -R "$ROOT/web" "$APP/Contents/Resources/"
xcrun swift "$ROOT/native/CreateIcon.swift" "$ROOT/build/RiverClub.iconset"
iconutil -c icns "$ROOT/build/RiverClub.iconset" -o "$APP/Contents/Resources/RiverClub.icns"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>RiverClub</string>
<key>CFBundleIdentifier</key><string>com.thynics.riverclub</string>
<key>CFBundleName</key><string>River Club</string>
<key>CFBundleDisplayName</key><string>River Club</string>
<key>CFBundleIconFile</key><string>RiverClub.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSHumanReadableCopyright</key><string>River Club · 虚拟筹码单机德州扑克</string>
</dict></plist>
PLIST
codesign --force --deep --sign - "$APP"
echo "$APP"
