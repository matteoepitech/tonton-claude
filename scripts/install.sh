#!/bin/sh
# Tonton Claude agent, macOS and Linux. Published with each release:
#   curl -fsSL https://github.com/matteoepitech/tonton-claude/releases/latest/download/install.sh | TONTON_TOKEN='<token>' sh
# TONTON_TOKEN is the token from the app (Machines). Without it, a connected machine updates.
set -e
REPO=matteoepitech/tonton-claude
VERSION=__VERSION__

if [ -z "$TONTON_TOKEN" ] && [ ! -f "$HOME/.tonton/config.json" ]; then
  echo "Missing TONTON_TOKEN. Copy the install command from Tonton Claude > Machines." >&2
  exit 1
fi

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac
case "$os" in
  darwin|linux) ;;
  *) echo "Unsupported OS: $os (on Windows, use install.ps1)" >&2; exit 1 ;;
esac

release="https://github.com/$REPO/releases/download/v$VERSION"
dir="$HOME/.tonton/bin"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Downloads a file of the release and checks it against SHA256SUMS.
fetch() {
  curl -fsSL "$release/$1" -o "$tmp/$1"
  expected=$(grep "  $1\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
  if command -v sha256sum >/dev/null; then actual=$(sha256sum "$tmp/$1" | cut -d' ' -f1); else actual=$(shasum -a 256 "$tmp/$1" | cut -d' ' -f1); fi
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then echo "$1 does not match its checksum, aborting." >&2; exit 1; fi
  chmod +x "$tmp/$1"
}

echo "Downloading Tonton Claude $VERSION ($os-$arch)..."
curl -fsSL "$release/SHA256SUMS" -o "$tmp/SHA256SUMS"
fetch "tonton-$os-$arch"
mkdir -p "$dir"
if [ "$os" = darwin ]; then
  fetch tonton-tray-darwin
  mv -f "$tmp/tonton-tray-darwin" "$dir/tonton-tray"
fi
# A rename keeps running sessions on the old binary instead of corrupting it.
mv -f "$tmp/tonton-$os-$arch" "$dir/tonton"
"$dir/tonton" install "$@"
