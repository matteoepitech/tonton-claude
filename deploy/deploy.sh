#!/bin/sh
# Deploys the relay to a host: syncs the code, compiles the agent for every OS and restarts the service.
# Usage: deploy/deploy.sh [user@host]
# Defaults come from deploy/deploy.env (git-ignored, see deploy.env.example): TONTON_DEPLOY_HOST and TONTON_SSH.
set -e
cd "$(dirname "$0")/.."
[ -f deploy/deploy.env ] && . deploy/deploy.env
HOST=${1:-$TONTON_DEPLOY_HOST}
SSH=${TONTON_SSH:-ssh}
[ -n "$HOST" ] || { echo "usage: deploy/deploy.sh user@host (or set TONTON_DEPLOY_HOST in deploy/deploy.env)" >&2; exit 1; }

rsync -az --delete -e "$SSH" --exclude node_modules --exclude dist --exclude app --exclude .git --exclude data \
  --exclude deploy/deploy.env ./ "$HOST:/opt/tonton/"
$SSH "$HOST" 'set -e
cd /opt/tonton
/opt/bun/bin/bun install --frozen-lockfile --silent
PATH=/opt/bun/bin:$PATH bun run scripts/build-agent.ts >/dev/null
chmod -R a+rX /opt/tonton
install -m 644 deploy/tonton.service /etc/systemd/system/tonton.service
systemctl daemon-reload
systemctl enable --quiet tonton
systemctl restart tonton
sleep 1
systemctl is-active tonton
curl -fsS http://127.0.0.1/health && echo " <- health"'
