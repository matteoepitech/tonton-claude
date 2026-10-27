#!/bin/sh
# Builds TontonClaude.app into app/build/.
#   --universal  Apple silicon and Intel in one binary (used for releases)
#   --install    copy to /Applications and launch
# Environment:
#   VERSION             marketing version, defaults to the latest git tag without its "v"
#   BUILD_NUMBER        defaults to the number of commits
#   CODESIGN_IDENTITY   e.g. "Developer ID Application: Name (TEAMID)"; ad-hoc signature when unset
#   SPARKLE_PUBLIC_KEY  EdDSA public key of the update feed (Sparkle's generate_keys); without it the app never updates
#                       itself
#   SPARKLE_FEED_URL    defaults to the appcast published with the latest GitHub release
set -e
cd "$(dirname "$0")/.."

UNIVERSAL=0
INSTALL=0
for arg in "$@"; do
  case $arg in
    --universal) UNIVERSAL=1 ;;
    --install) INSTALL=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

VERSION=${VERSION:-$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')}
VERSION=${VERSION:-0.0.0}
BUILD_NUMBER=${BUILD_NUMBER:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}
SPARKLE_FEED_URL=${SPARKLE_FEED_URL:-https://github.com/matteoepitech/tonton-claude/releases/latest/download/appcast.xml}

# Checked before the build: a bad key would ship an app that rejects every update, and only a manual install fixes that.
UPDATES=
UPDATES_STATE=off
if [ -n "$SPARKLE_PUBLIC_KEY" ]; then
  [ "$(printf %s "$SPARKLE_PUBLIC_KEY" | base64 -d 2>/dev/null | wc -c | tr -d ' ')" = 32 ] ||
    { echo "SPARKLE_PUBLIC_KEY is not an EdDSA public key (generate_keys -p prints it)" >&2; exit 1; }
  case $SPARKLE_FEED_URL in
    https://*) ;;
    *) echo "SPARKLE_FEED_URL must be https" >&2; exit 1 ;;
  esac
  # A signed feed, and archives checked before they are opened: Sparkle's strictest settings.
  UPDATES="<key>SUFeedURL</key><string>$SPARKLE_FEED_URL</string>
  <key>SUPublicEDKey</key><string>$SPARKLE_PUBLIC_KEY</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SURequireSignedFeed</key><true/>
  <key>SUVerifyUpdateBeforeExtraction</key><true/>"
  UPDATES_STATE=on
fi

# One build per architecture, merged with lipo: works with the Command Line Tools alone, unlike a multi-arch swift build.
if [ $UNIVERSAL = 1 ]; then
  for arch in arm64 x86_64; do swift build -c release --arch $arch; done
  BIN=build/TontonClaude-universal
  mkdir -p build
  lipo -create -output "$BIN" \
    "$(swift build -c release --arch arm64 --show-bin-path)/TontonClaude" \
    "$(swift build -c release --arch x86_64 --show-bin-path)/TontonClaude"
  # The framework comes from Sparkle's release with both architectures, whichever build copied it.
  SPARKLE=$(swift build -c release --arch arm64 --show-bin-path)/Sparkle.framework
else
  swift build -c release
  BIN=$(swift build -c release --show-bin-path)/TontonClaude
  SPARKLE=$(swift build -c release --show-bin-path)/Sparkle.framework
fi

APP=build/TontonClaude.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp "$BIN" "$APP/Contents/MacOS/TontonClaude"
# ditto keeps the framework's symlinks and signatures.
ditto "$SPARKLE" "$APP/Contents/Frameworks/Sparkle.framework"
[ -f Resources/AppIcon.icns ] && cp Resources/AppIcon.icns "$APP/Contents/Resources/"
cp Resources/TontonClaude.sdef "$APP/Contents/Resources/"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>tech.d3l.tontonclaude</string>
  <key>CFBundleName</key><string>Tonton Claude</string>
  <key>CFBundleDisplayName</key><string>Tonton Claude</string>
  <key>CFBundleExecutable</key><string>TontonClaude</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>tech.d3l.tontonclaude</string>
    <key>CFBundleURLSchemes</key><array><string>tonton</string></array>
  </dict></array>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleScriptEnabled</key><true/>
  <key>OSAScriptingDefinition</key><string>TontonClaude.sdef</string>
  <key>NSMicrophoneUsageDescription</key><string>Dictate messages to your Claude Code sessions from the notch.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Turn what you dictate in the notch into text for Claude.</string>
  $UPDATES
</dict>
</plist>
PLIST
plutil -lint -s "$APP/Contents/Info.plist"

# Inside out, and without --deep, as Sparkle documents: --deep would drop the entitlements of its downloader service.
# Sparkle's helpers keep the hardened runtime they ship with, ad-hoc signed too. The app only gets it with a Developer ID,
# which notarization requires: an ad-hoc app under the hardened runtime can't load an ad-hoc framework.
sign() {
  if [ -n "$CODESIGN_IDENTITY" ]; then
    codesign --force --timestamp --sign "$CODESIGN_IDENTITY" "$@"
  else
    codesign --force --sign - "$@"
  fi
}
SPARKLE_CODE="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
sign --options runtime "$SPARKLE_CODE/XPCServices/Installer.xpc"
sign --options runtime --preserve-metadata=entitlements "$SPARKLE_CODE/XPCServices/Downloader.xpc"
sign --options runtime "$SPARKLE_CODE/Autoupdate"
sign --options runtime "$SPARKLE_CODE/Updater.app"
sign --options runtime "$APP/Contents/Frameworks/Sparkle.framework"
if [ -n "$CODESIGN_IDENTITY" ]; then
  sign --options runtime --entitlements Resources/TontonClaude.entitlements "$APP"
else
  sign "$APP"
fi
codesign --verify --deep --strict "$APP"
echo "OK: $(pwd)/$APP ($VERSION, build $BUILD_NUMBER, updates $UPDATES_STATE)"

if [ $INSTALL = 1 ]; then
  pkill -x TontonClaude 2>/dev/null || true
  rm -rf /Applications/TontonClaude.app
  cp -R "$APP" /Applications/
  open /Applications/TontonClaude.app
  echo "Installed in /Applications and launched."
fi
