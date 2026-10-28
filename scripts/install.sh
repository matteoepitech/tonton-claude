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

# Sessions started from the notch and a pool's sessions run in tmux. Installed with Homebrew or the system's package
# manager when it is missing; a failure only warns, the agent works without it for the rest. With sudo only from a
# terminal: Update agent runs this without one, and must never wait for a password.
install_tmux() {
  for found in tmux /opt/homebrew/bin/tmux /usr/local/bin/tmux; do command -v "$found" >/dev/null 2>&1 && return 0; done
  missing="tmux is missing: sessions from the notch and pool machines need it."
  if [ "$os" = darwin ]; then
    brew=$(command -v brew || { [ -x /opt/homebrew/bin/brew ] && echo /opt/homebrew/bin/brew; } || { [ -x /usr/local/bin/brew ] && echo /usr/local/bin/brew; } || true)
    if [ -z "$brew" ]; then echo "$missing Install Homebrew (https://brew.sh), then: brew install tmux" >&2; return 0; fi
    echo "Installing tmux with Homebrew..."
    "$brew" install tmux >/dev/null 2>&1 || echo "$missing Homebrew could not install it: brew install tmux" >&2
    return 0
  fi
  if [ "$(id -u)" = 0 ]; then sudo=""; elif command -v sudo >/dev/null 2>&1 && { sudo -n true 2>/dev/null || [ -t 2 ]; }; then sudo=sudo; else
    echo "$missing Install it with your package manager." >&2
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then set -- apt-get install -y tmux
  elif command -v dnf >/dev/null 2>&1; then set -- dnf install -y tmux
  elif command -v yum >/dev/null 2>&1; then set -- yum install -y tmux
  elif command -v pacman >/dev/null 2>&1; then set -- pacman -S --noconfirm tmux
  elif command -v zypper >/dev/null 2>&1; then set -- zypper --non-interactive install tmux
  elif command -v apk >/dev/null 2>&1; then set -- apk add tmux
  else echo "$missing Install it with your package manager." >&2; return 0
  fi
  echo "Installing tmux ($1)..."
  $sudo "$@" >/dev/null 2>&1 </dev/null || echo "$missing It could not be installed: $* (as root)" >&2
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
install_tmux
"$dir/tonton" install "$@"
