#!/bin/sh
# Builds chiefman.app and installs it in ~/Applications, where Spotlight finds it.
set -e
cd "$(dirname "$0")/.."
ARCH=$(uname -m)

# The app carries the skills, so Claude Code is all it needs. They come from
# the repo that holds this app folder, or from CHIEFMAN_PLUGIN_SRC.
SRC=$(cd .. && pwd)
[ -d "$SRC/.claude-plugin" ] || SRC=${CHIEFMAN_PLUGIN_SRC:-}
if [ -z "$SRC" ] || [ ! -d "$SRC/.claude-plugin" ] || [ ! -d "$SRC/skills" ]; then
  echo "No plugin found: run from the repo's app folder or set CHIEFMAN_PLUGIN_SRC" >&2
  exit 1
fi
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/plugin"
cp -R "$SRC/.claude-plugin" "$SRC/skills" "$STAGE/plugin/"
find "$STAGE/plugin" -name .DS_Store -delete

npx vite build
rm -rf out
npx electron-packager . chiefman --platform=darwin --arch="$ARCH" --icon=build/icon.icns --out=out --overwrite \
  --extra-resource="$STAGE/plugin" \
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
