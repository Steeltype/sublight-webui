#!/usr/bin/env bash
# Sublight WebUI launcher (Linux / macOS).
# Opens the server in the foreground so the startup banner, token status,
# and URL are visible. Spawns a browser to the configured port after a
# short delay so we don't race the server listening.
set -e

cd "$(dirname "$0")"

PORT=$(node -e "try{const s=JSON.parse(require('fs').readFileSync('settings.json','utf8'));console.log(s.port||3700)}catch(e){console.log(3700)}")

# Pick a browser opener — macOS has `open`, most Linux desktops have `xdg-open`.
if command -v xdg-open >/dev/null 2>&1; then
  OPENER=xdg-open
elif command -v open >/dev/null 2>&1; then
  OPENER=open
else
  OPENER=
fi

if [ -n "$OPENER" ]; then
  ( sleep 2 && "$OPENER" "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 ) &
fi

exec npm start
