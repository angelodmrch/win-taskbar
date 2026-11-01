#!/usr/bin/env bash
# Builds gnome-shell-extension-win-taskbar_<version>_all.deb in dist/.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
UUID="win-taskbar@angelo"
PKG="gnome-shell-extension-win-taskbar"
VERSION="$(grep -o '"version": *[0-9]*' "$SRC/metadata.json" | grep -o '[0-9]*$')"
BUILD="$(mktemp -d)"
ROOT="$BUILD/$PKG"
EXT="$ROOT/usr/share/gnome-shell/extensions/$UUID"

mkdir -p "$EXT" "$ROOT/DEBIAN" "$ROOT/usr/share/doc/$PKG"
cp -r "$SRC"/metadata.json "$SRC"/*.js "$SRC"/stylesheet.css "$SRC"/schemas "$EXT"/
rm -f "$EXT/schemas/gschemas.compiled"
glib-compile-schemas "$EXT/schemas"
find "$ROOT" -type d -exec chmod 755 {} +
find "$ROOT" -type f -exec chmod 644 {} +
cp "$SRC/README.md" "$ROOT/usr/share/doc/$PKG/"

cat > "$ROOT/DEBIAN/control" <<CONTROL
Package: $PKG
Version: $VERSION
Architecture: all
Maintainer: Angelo <angelodmrch@gmail.com>
Depends: gnome-shell (>= 45)
Recommends: libnotify-bin
Section: gnome
Priority: optional
Description: Windows-style taskbar for GNOME
 A bottom taskbar with an Ubuntu button that opens the app grid, pinned
 and running apps with window previews, the system tray, and a clock that
 opens the calendar and notifications. Works on Wayland and X11.
CONTROL

cp "$SRC/packaging/postinst" "$ROOT/DEBIAN/postinst"
chmod 755 "$ROOT/DEBIAN/postinst"

mkdir -p "$SRC/dist"
OUT="$SRC/dist/${PKG}_${VERSION}_all.deb"
dpkg-deb --root-owner-group --build "$ROOT" "$OUT"
rm -rf "$BUILD"
echo "$OUT"
