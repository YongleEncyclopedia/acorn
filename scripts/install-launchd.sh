#!/bin/sh
# Keep Acorn running on macOS (starts at login, restarts if it crashes).
# Usage: scripts/install-launchd.sh   — uninstall with scripts/uninstall-launchd.sh
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LABEL="app.acorn.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$DIR/data/logs" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>--env-file-if-exists=$DIR/.env</string>
    <string>$DIR/src/server/main.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/logs/acorn.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/logs/acorn.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "松果已设为开机自启：$PLIST"
echo "日志：$DIR/data/logs/acorn.log"
