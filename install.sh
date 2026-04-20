#!/usr/bin/env bash
# install.sh — Linux / macOS installer for Sublight.
#   Linux : writes a freedesktop .desktop entry + installs icon into
#           the hicolor theme so the app menu picks it up.
#   macOS : builds a Sublight.app bundle on the Desktop, with an .icns
#           icon produced from the committed PNG set via iconutil.
# Idempotent — rerun to refresh.

set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
PNG_DIR="$REPO_ROOT/assets/icon"
LAUNCHER="$REPO_ROOT/start-sublight.sh"

if [ ! -f "$LAUNCHER" ]; then
  echo "error: launcher missing at $LAUNCHER" >&2
  exit 1
fi
chmod +x "$LAUNCHER"

for sz in 16 32 48 64 128 256 512 1024; do
  if [ ! -f "$PNG_DIR/$sz.png" ]; then
    echo "error: missing icon asset $PNG_DIR/$sz.png (regenerate via scripts/render-pngs.ps1)" >&2
    exit 1
  fi
done

OS="$(uname -s)"

case "$OS" in
  Linux)
    ICON_DIR="$HOME/.local/share/icons/hicolor"
    APP_DIR="$HOME/.local/share/applications"
    DESKTOP_DIR="$HOME/Desktop"

    mkdir -p "$APP_DIR"
    for sz in 16 32 48 64 128 256 512; do
      mkdir -p "$ICON_DIR/${sz}x${sz}/apps"
      cp -f "$PNG_DIR/$sz.png" "$ICON_DIR/${sz}x${sz}/apps/sublight.png"
    done

    # Refresh the icon cache if gtk-update-icon-cache is available. Failure
    # here is non-fatal — the .desktop file still works, it just may need a
    # logout/login to pick up the icon.
    if command -v gtk-update-icon-cache >/dev/null 2>&1; then
      gtk-update-icon-cache -q -t "$ICON_DIR" 2>/dev/null || true
    fi

    DESKTOP_FILE="$APP_DIR/sublight.desktop"
    cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Sublight
Comment=Sublight WebUI
Exec="$LAUNCHER"
Icon=sublight
Terminal=true
Categories=Development;Utility;
StartupNotify=false
EOF
    chmod +x "$DESKTOP_FILE"

    # Also drop a copy on the Desktop if it exists. Requires the user to
    # "Allow Launching" via their file manager on first use (Nautilus/Nemo
    # security prompt).
    if [ -d "$DESKTOP_DIR" ]; then
      cp -f "$DESKTOP_FILE" "$DESKTOP_DIR/sublight.desktop"
      chmod +x "$DESKTOP_DIR/sublight.desktop"
      echo "desktop  : $DESKTOP_DIR/sublight.desktop"
    fi

    echo "launcher : $LAUNCHER"
    echo "icons    : $ICON_DIR/*/apps/sublight.png"
    echo "menu     : $DESKTOP_FILE"
    echo ''
    echo 'Installed. Sublight should appear in your application menu.'
    ;;

  Darwin)
    if ! command -v iconutil >/dev/null 2>&1; then
      echo "error: iconutil not found (macOS system tool — is this really macOS?)" >&2
      exit 1
    fi

    APP_PATH="$HOME/Desktop/Sublight.app"
    TMP_ICONSET="$(mktemp -d)/Sublight.iconset"
    mkdir -p "$TMP_ICONSET"

    # iconutil naming: icon_<size>x<size>[@2x].png for the @1x / @2x pair
    # at each logical size. Apple's reference sizes are 16/32/128/256/512.
    cp "$PNG_DIR/16.png"   "$TMP_ICONSET/icon_16x16.png"
    cp "$PNG_DIR/32.png"   "$TMP_ICONSET/icon_16x16@2x.png"
    cp "$PNG_DIR/32.png"   "$TMP_ICONSET/icon_32x32.png"
    cp "$PNG_DIR/64.png"   "$TMP_ICONSET/icon_32x32@2x.png"
    cp "$PNG_DIR/128.png"  "$TMP_ICONSET/icon_128x128.png"
    cp "$PNG_DIR/256.png"  "$TMP_ICONSET/icon_128x128@2x.png"
    cp "$PNG_DIR/256.png"  "$TMP_ICONSET/icon_256x256.png"
    cp "$PNG_DIR/512.png"  "$TMP_ICONSET/icon_256x256@2x.png"
    cp "$PNG_DIR/512.png"  "$TMP_ICONSET/icon_512x512.png"
    cp "$PNG_DIR/1024.png" "$TMP_ICONSET/icon_512x512@2x.png"

    rm -rf "$APP_PATH"
    mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"
    iconutil -c icns "$TMP_ICONSET" -o "$APP_PATH/Contents/Resources/sublight.icns"

    # The bundle's executable opens start-sublight.sh in Terminal so the
    # user sees the banner + token URL, matching the Windows experience.
    EXE="$APP_PATH/Contents/MacOS/Sublight"
    cat > "$EXE" <<EOF
#!/usr/bin/env bash
open -a Terminal "$LAUNCHER"
EOF
    chmod +x "$EXE"

    cat > "$APP_PATH/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Sublight</string>
  <key>CFBundleIconFile</key><string>sublight.icns</string>
  <key>CFBundleIdentifier</key><string>io.steeltype.sublight</string>
  <key>CFBundleName</key><string>Sublight</string>
  <key>CFBundleDisplayName</key><string>Sublight</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><false/>
</dict>
</plist>
EOF

    # Nudge the Finder to re-read the icon (otherwise it sometimes caches
    # a generic app icon until the next login).
    touch "$APP_PATH"

    echo "launcher : $LAUNCHER"
    echo "bundle   : $APP_PATH"
    echo ''
    echo 'Installed. Double-click Sublight.app on your Desktop to launch.'
    echo 'First launch may trigger a Gatekeeper warning — right-click > Open to allow.'
    ;;

  *)
    echo "error: unsupported OS '$OS'. Sublight installer supports Linux, macOS, and Windows only." >&2
    exit 1
    ;;
esac
