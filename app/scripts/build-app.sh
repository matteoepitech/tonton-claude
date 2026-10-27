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
#   APP_GROUP           app group the widget shares with the app; defaults to <TeamID>.tech.d3l.tontonclaude with a
#                       Developer ID. Without one the widget is left out (see below)
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

# The widget (desktop and Notification Center) is sandboxed and reads what the app writes in an app group container.
# From macOS 15, a process gets that container without asking the user only when the group starts with its Team ID. An
# ad-hoc signature has none: the app would ask at every launch and the widget, which can't ask, would read nothing. So
# ad-hoc builds leave the widget out, unless APP_GROUP names a group anyway (fine on macOS 14, or to check the bundle).
TEAM_ID=$(printf %s "$CODESIGN_IDENTITY" | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p')
if [ -z "$TEAM_ID" ] && [ -n "$CODESIGN_IDENTITY" ]; then TEAM_ID=$APPLE_TEAM_ID; fi
APP_GROUP=${APP_GROUP:-${TEAM_ID:+$TEAM_ID.tech.d3l.tontonclaude}}
case $APP_GROUP in
  *[!A-Za-z0-9.-]*) echo "APP_GROUP may only hold letters, digits, dots and dashes" >&2; exit 1 ;;
esac
WIDGET_INFO=
WIDGET_STATE=off
if [ -n "$APP_GROUP" ]; then
  WIDGET_INFO="<key>TontonAppGroup</key><string>$APP_GROUP</string>"
  WIDGET_STATE=on
fi

# One build per architecture, merged with lipo: works with the Command Line Tools alone, unlike a multi-arch swift build.
if [ $UNIVERSAL = 1 ]; then
  for arch in arm64 x86_64; do swift build -c release --arch $arch; done
  BIN=build/TontonClaude-universal
  mkdir -p build
  lipo -create -output "$BIN" \
    "$(swift build -c release --arch arm64 --show-bin-path)/TontonClaude" \
    "$(swift build -c release --arch x86_64 --show-bin-path)/TontonClaude"
  WIDGET_BIN=build/TontonWidget-universal
  lipo -create -output "$WIDGET_BIN" \
    "$(swift build -c release --arch arm64 --show-bin-path)/TontonWidget" \
    "$(swift build -c release --arch x86_64 --show-bin-path)/TontonWidget"
  # The framework comes from Sparkle's release with both architectures, whichever build copied it.
  SPARKLE=$(swift build -c release --arch arm64 --show-bin-path)/Sparkle.framework
else
  swift build -c release
  BIN=$(swift build -c release --show-bin-path)/TontonClaude
  WIDGET_BIN=$(swift build -c release --show-bin-path)/TontonWidget
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
  $WIDGET_INFO
</dict>
</plist>
PLIST
plutil -lint -s "$APP/Contents/Info.plist"

# The group goes into the entitlements of both: macOS gives a container only to the code that claims its group.
ENTITLEMENTS=build/entitlements
rm -rf "$ENTITLEMENTS"
mkdir -p "$ENTITLEMENTS"
cp Resources/TontonClaude.entitlements Resources/TontonWidget.entitlements "$ENTITLEMENTS/"
if [ -n "$APP_GROUP" ]; then
  for file in "$ENTITLEMENTS"/*.entitlements; do
    /usr/libexec/PlistBuddy -c "Add :com.apple.security.application-groups array" \
      -c "Add :com.apple.security.application-groups:0 string $APP_GROUP" "$file"
  done
  WIDGET=$APP/Contents/PlugIns/TontonWidget.appex
  mkdir -p "$WIDGET/Contents/MacOS"
  cp "$WIDGET_BIN" "$WIDGET/Contents/MacOS/TontonWidget"
  cat > "$WIDGET/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>tech.d3l.tontonclaude.widget</string>
  <key>CFBundleName</key><string>Tonton Claude</string>
  <key>CFBundleDisplayName</key><string>Tonton Claude</string>
  <key>CFBundleExecutable</key><string>TontonWidget</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSExtension</key>
  <dict><key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string></dict>
  $WIDGET_INFO
</dict>
</plist>
PLIST
  plutil -lint -s "$WIDGET/Contents/Info.plist"
fi

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
# The widget only links system frameworks, so it keeps the hardened runtime with an ad-hoc signature too.
if [ -n "$APP_GROUP" ]; then sign --options runtime --entitlements "$ENTITLEMENTS/TontonWidget.entitlements" "$WIDGET"; fi
if [ -n "$CODESIGN_IDENTITY" ]; then
  sign --options runtime --entitlements "$ENTITLEMENTS/TontonClaude.entitlements" "$APP"
elif [ -n "$APP_GROUP" ]; then
  sign --entitlements "$ENTITLEMENTS/TontonClaude.entitlements" "$APP"
else
  sign "$APP"
fi
codesign --verify --deep --strict "$APP"
echo "OK: $(pwd)/$APP ($VERSION, build $BUILD_NUMBER, updates $UPDATES_STATE, widget $WIDGET_STATE)"

if [ $INSTALL = 1 ]; then
  pkill -x TontonClaude 2>/dev/null || true
  rm -rf /Applications/TontonClaude.app
  cp -R "$APP" /Applications/
  open /Applications/TontonClaude.app
  echo "Installed in /Applications and launched."
fi
