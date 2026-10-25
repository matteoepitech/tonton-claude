#!/bin/sh
# Builds TontonClaude.app into app/build/.
#   --universal  Apple silicon and Intel in one binary (used for releases)
#   --install    copy to /Applications and launch
# Environment:
#   VERSION             marketing version, defaults to the latest git tag without its "v"
#   BUILD_NUMBER        defaults to the number of commits
#   CODESIGN_IDENTITY   e.g. "Developer ID Application: Name (TEAMID)"; ad-hoc signature when unset
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

# One build per architecture, merged with lipo: works with the Command Line Tools alone, unlike a multi-arch swift build.
if [ $UNIVERSAL = 1 ]; then
  for arch in arm64 x86_64; do swift build -c release --arch $arch; done
  BIN=build/TontonClaude-universal
  mkdir -p build
  lipo -create -output "$BIN" \
    "$(swift build -c release --arch arm64 --show-bin-path)/TontonClaude" \
    "$(swift build -c release --arch x86_64 --show-bin-path)/TontonClaude"
else
  swift build -c release
  BIN=$(swift build -c release --show-bin-path)/TontonClaude
fi

APP=build/TontonClaude.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/TontonClaude"
[ -f Resources/AppIcon.icns ] && cp Resources/AppIcon.icns "$APP/Contents/Resources/"
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
</dict>
</plist>
PLIST

if [ -n "$CODESIGN_IDENTITY" ]; then
  codesign --force --options runtime --timestamp --sign "$CODESIGN_IDENTITY" "$APP"
else
  codesign --force --sign - "$APP"
fi
echo "OK: $(pwd)/$APP ($VERSION, build $BUILD_NUMBER)"

if [ $INSTALL = 1 ]; then
  pkill -x TontonClaude 2>/dev/null || true
  rm -rf /Applications/TontonClaude.app
  cp -R "$APP" /Applications/
  open /Applications/TontonClaude.app
  echo "Installed in /Applications and launched."
fi
