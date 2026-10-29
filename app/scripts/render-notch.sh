#!/bin/sh
# Draws the open notch with sample sessions to an image, for the README: ./scripts/render-notch.sh [out.png]
# The app's views are built with render-notch.swift as their entry point, against TontonCore and TontonMac as
# `swift build` left them, and run with an empty home, so no session or account of this Mac shows.
set -e
cd "$(dirname "$0")/.."
out=$(cd "$(dirname "${1:-notch.png}")" && pwd)/$(basename "${1:-notch.png}")
swift build >/dev/null
build=.build/debug
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
find Sources/TontonClaude -name '*.swift' ! -path '*/App/Main.swift' -exec cp {} "$work/" \;
cp scripts/render-notch.swift "$work/main.swift"
objects=""
for module in TontonCore TontonMac; do
  for file in Sources/$module/*.swift; do
    object="$build/$module.build/$(basename "$file").o"
    [ -f "$object" ] && objects="$objects $object"
  done
done
# shellcheck disable=SC2086
swiftc -Onone -D DEBUG -module-name TontonClaude -I "$build/Modules" -F "$build" -framework Sparkle \
  -Xlinker -rpath -Xlinker "$PWD/$build" -o "$work/render" "$work"/*.swift $objects
mkdir -p "$work/home"
CFFIXED_USER_HOME="$work/home" HOME="$work/home" "$work/render" "$out"
echo "Wrote $out"
