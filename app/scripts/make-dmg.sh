#!/bin/sh
# Packs app/build/TontonClaude.app into app/build/TontonClaude-<version>.dmg, with a link to /Applications to drag it onto.
# With CODESIGN_IDENTITY the image is signed; with APPLE_ID, APPLE_TEAM_ID and APPLE_APP_PASSWORD it is also notarized
# and stapled, so Gatekeeper opens it without warnings.
set -e
cd "$(dirname "$0")/.."

APP=build/TontonClaude.app
[ -d "$APP" ] || { echo "build the app first: scripts/build-app.sh" >&2; exit 1; }
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")
DMG=build/TontonClaude-$VERSION.dmg

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
cp -R "$APP" "$STAGING/Tonton Claude.app"
ln -s /Applications "$STAGING/Applications"
rm -f "$DMG"
hdiutil create -quiet -volname "Tonton Claude" -srcfolder "$STAGING" -fs HFS+ -format UDZO "$DMG"

if [ -n "$CODESIGN_IDENTITY" ]; then
  codesign --force --timestamp --sign "$CODESIGN_IDENTITY" "$DMG"
fi
if [ -n "$APPLE_ID" ] && [ -n "$APPLE_TEAM_ID" ] && [ -n "$APPLE_APP_PASSWORD" ]; then
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
  xcrun stapler staple "$DMG"
fi
echo "OK: $(pwd)/$DMG"
