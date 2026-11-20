#!/bin/sh
# Builds chiefman.app and installs it in ~/Applications, where Spotlight finds it.
set -e
cd "$(dirname "$0")/.."
ARCH=$(uname -m)
npx vite build
rm -rf out
npx electron-packager . chiefman --platform=darwin --arch="$ARCH" --icon=build/icon.icns --out=out --overwrite \
  --app-bundle-id=local.chiefman.app --app-category-type=public.app-category.developer-tools \
  --ignore='^/(src|scripts|build|out|\.git|index\.html|vite\.config\.mjs|tsconfig\.json)($|/)'
APP="out/chiefman-darwin-$ARCH/chiefman.app"
codesign --force --deep --sign - "$APP"
DEST="$HOME/Applications/chiefman.app"
mkdir -p "$HOME/Applications"
if [ -d "$DEST" ]; then
  osascript -e 'quit app "chiefman"' >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$DEST"
fi
ditto "$APP" "$DEST"
mdimport "$DEST"

rm -rf out
echo "Installed $DEST"
