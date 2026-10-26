#!/bin/sh
# Tonton Claude relay on a Linux server with systemd. Published with each release; run it again to update:
#   curl -fsSL https://github.com/matteoepitech/tonton-claude/releases/latest/download/install-relay.sh | sudo sh
# The relay listens on PORT (default 7777) behind your HTTPS reverse proxy. Settings: /etc/tonton/tonton.env.
set -e
REPO=matteoepitech/tonton-claude
VERSION=__VERSION__

[ "$(id -u)" = 0 ] || { echo "Run it as root (sudo sh)." >&2; exit 1; }
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

release="https://github.com/$REPO/releases/download/v$VERSION"
name="tonton-relay-linux-$arch"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading the Tonton Claude relay $VERSION ($arch)..."
curl -fsSL "$release/SHA256SUMS" -o "$tmp/SHA256SUMS"
curl -fsSL "$release/$name" -o "$tmp/$name"
expected=$(grep "  $name\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
actual=$(sha256sum "$tmp/$name" | cut -d' ' -f1)
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "$name does not match its checksum, aborting." >&2; exit 1; }
install -m 755 "$tmp/$name" /usr/local/bin/tonton-relay

# Relays set up by the old deploy script kept their port in the unit: carry it over to the settings.
old_port=$(sed -n 's/.*Environment=PORT=\([0-9]*\).*/\1/p' /etc/systemd/system/tonton.service 2>/dev/null | head -1)
if [ -f /etc/tonton/tonton.env ] && ! grep -q '^PORT=' /etc/tonton/tonton.env; then echo "PORT=${old_port:-7777}" >> /etc/tonton/tonton.env; fi

id tontond >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin tontond
mkdir -p /etc/tonton
if [ ! -f /etc/tonton/tonton.env ]; then
  cat > /etc/tonton/tonton.env <<'EOF'
# Tonton Claude relay settings. Restart after a change: systemctl restart tonton
PORT=7777
# open: anyone can create an account. closed: only with TONTON_ADMIN_TOKEN (24+ characters).
TONTON_REGISTRATION=open
#TONTON_ADMIN_TOKEN=
# 1 to read client IPs from X-Forwarded-For, only behind a reverse proxy that sets it.
TONTON_TRUST_PROXY=0
# Set to turn on /metrics (Prometheus) for this bearer token (24+ characters).
#TONTON_METRICS_TOKEN=
EOF
  chmod 600 /etc/tonton/tonton.env
fi

cat > /etc/systemd/system/tonton.service <<'EOF'
[Unit]
Description=Tonton Claude relay
After=network-online.target
Wants=network-online.target

[Service]
User=tontond
Group=tontond
EnvironmentFile=/etc/tonton/tonton.env
Environment=TONTON_DATA_DIR=/var/lib/tonton
# Accounts and machines (SQLite) live here; the rest of the filesystem stays read-only for the service.
StateDirectory=tonton
StateDirectoryMode=0700
WorkingDirectory=/var/lib/tonton
ExecStart=/usr/local/bin/tonton-relay
Restart=always
RestartSec=2

# Sandboxing: the relay only needs its data directory and sockets.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
# Only granted to bind a port below 1024, if PORT is one.
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --quiet tonton
systemctl restart tonton
sleep 1
port=$(sed -n 's/^PORT=//p' /etc/tonton/tonton.env | tail -1)
if curl -fsS "http://127.0.0.1:${port:-7777}/health" >/dev/null; then
  echo "Tonton Claude relay $VERSION is running on port ${port:-7777}."
else
  echo "The relay did not answer: journalctl -u tonton" >&2
  exit 1
fi
