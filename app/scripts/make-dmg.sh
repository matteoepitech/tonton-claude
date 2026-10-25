#!/bin/sh
# Packs app/build/TontonClaude.app into app/build/TontonClaude-<version>.dmg: an installer window with the app, an arrow
# and a link to Applications, laid out by dmgbuild (scripts/dmg-settings.py).
# With CODESIGN_IDENTITY the image is signed; with APPLE_ID, APPLE_TEAM_ID and APPLE_APP_PASSWORD it is also notarized
# and stapled, so Gatekeeper opens it without warnings.
set -e
cd "$(dirname "$0")/.."

APP=build/TontonClaude.app
[ -d "$APP" ] || { echo "build the app first: scripts/build-app.sh" >&2; exit 1; }
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")
DMG=build/TontonClaude-$VERSION.dmg

# One venv per set of requirements, rebuilt when it no longer runs (e.g. its Python went away with a Homebrew upgrade).
REQUIREMENTS=scripts/dmgbuild-requirements.txt
VENV=build/dmgbuild-$(shasum -a 256 "$REQUIREMENTS" | cut -c1-12)
if ! "$VENV/bin/python" -c 'import dmgbuild' 2>/dev/null; then
  rm -rf "$VENV"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check --require-hashes --only-binary :all: -r "$REQUIREMENTS"
fi

swift scripts/make-dmg-background.swift build/dmg
rm -f "$DMG"
"$VENV/bin/dmgbuild" -s scripts/dmg-settings.py -D app="$APP" -D layout=scripts/dmg-layout.json \
  -D background=build/dmg/dmg-background.png -D icon=Resources/AppIcon.icns "Tonton Claude" "$DMG"

# dmgbuild ignores a failed copy of the app, so check the copy before signing and publishing the image. No --strict:
# hide_extensions puts Finder info on the bundle, which it reports as detritus.
MOUNT=$(mktemp -d)
hdiutil attach -quiet -nobrowse -noautoopen -readonly -mountpoint "$MOUNT" "$DMG"
INTACT=1
diff -rq "$APP" "$MOUNT/Tonton Claude.app" && codesign --verify --deep "$MOUNT/Tonton Claude.app" || INTACT=0
hdiutil detach -quiet "$MOUNT"
rmdir "$MOUNT" 2>/dev/null || true
[ $INTACT = 1 ] || { echo "the app in $DMG differs from $APP" >&2; exit 1; }

if [ -n "$CODESIGN_IDENTITY" ]; then
  codesign --force --timestamp --sign "$CODESIGN_IDENTITY" "$DMG"
fi
if [ -n "$APPLE_ID" ] && [ -n "$APPLE_TEAM_ID" ] && [ -n "$APPLE_APP_PASSWORD" ]; then
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
  xcrun stapler staple "$DMG"
fi
echo "OK: $(pwd)/$DMG"
