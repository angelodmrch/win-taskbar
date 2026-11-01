#!/usr/bin/env bash
# Installs the Win Taskbar GNOME Shell extension for the current user.
set -euo pipefail

UUID="win-taskbar@angelo"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
cp -r "$SRC"/metadata.json "$SRC"/*.js "$SRC"/stylesheet.css "$SRC"/schemas "$DEST"/
rm -f "$DEST/schemas/gschemas.compiled"
glib-compile-schemas "$DEST/schemas"

echo "Installed to $DEST"
if gnome-extensions enable "$UUID" 2>/dev/null; then
  echo "Enabled. Log out and back in if the taskbar does not appear."
else
  echo "GNOME Shell has not seen the new extension yet."
  if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
    echo "Log out and back in, then run:  gnome-extensions enable $UUID"
  else
    echo "Press Alt+F2, type r, press Enter, then run:  gnome-extensions enable $UUID"
  fi
fi
