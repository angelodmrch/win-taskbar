#!/usr/bin/env bash
# Builds dist/win-taskbar@angelo.shell-extension.zip for `gnome-extensions install`.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$(mktemp -d)"
cp -r "$SRC"/metadata.json "$SRC"/*.js "$SRC"/stylesheet.css "$SRC"/schemas "$BUILD"/
rm -f "$BUILD/schemas/gschemas.compiled"
glib-compile-schemas "$BUILD/schemas"
mkdir -p "$SRC/dist"
OUT="$SRC/dist/win-taskbar@angelo.shell-extension.zip"
rm -f "$OUT"
(cd "$BUILD" && zip -qr "$OUT" .)
rm -rf "$BUILD"
echo "$OUT"
