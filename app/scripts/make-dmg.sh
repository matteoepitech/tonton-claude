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

DMGBUILD_VERSION=1.6.7
VENV=build/dmgbuild-$DMGBUILD_VERSION
if [ ! -x "$VENV/bin/dmgbuild" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check "dmgbuild==$DMGBUILD_VERSION"
fi

rm -f "$DMG"
"$VENV/bin/dmgbuild" -s scripts/dmg-settings.py -D app="$APP" -D resources=Resources "Tonton Claude" "$DMG"

if [ -n "$CODESIGN_IDENTITY" ]; then
  codesign --force --timestamp --sign "$CODESIGN_IDENTITY" "$DMG"
fi
if [ -n "$APPLE_ID" ] && [ -n "$APPLE_TEAM_ID" ] && [ -n "$APPLE_APP_PASSWORD" ]; then
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
  xcrun stapler staple "$DMG"
fi
echo "OK: $(pwd)/$DMG"
