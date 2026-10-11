#!/usr/bin/env bash
#
# Build and push the app to the production server.
#
# Credentials come from ./prod-env (gitignored), which holds:
#   ip: <address>
#   user: <user>
#   password: <password>
#
# Usage: ./scripts/deploy.sh

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=prod-env
if [[ ! -f $ENV_FILE ]]; then
  echo "Missing $ENV_FILE — it holds the server address and credentials." >&2
  exit 1
fi

field() { sed -n "s/^$1:[[:space:]]*//p" "$ENV_FILE" | head -1; }

HOST=$(field ip)
USER=$(field user)
# Exported, not passed on a command line, so it never shows up in `ps`.
SSHPASS=$(field password)
export SSHPASS

# Under /home deliberately. Docker on this server is the Canonical snap, and
# snap confinement grants it the `home` interface only — from /opt it cannot
# read the compose file, and the daemon cannot bind-mount the site directory.
REMOTE_DIR=/home/outliner
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

echo "==> Building"
npm run build

echo "==> Preparing $REMOTE_DIR on $HOST"
sshpass -e ssh "${SSH_OPTS[@]}" "$USER@$HOST" "mkdir -p $REMOTE_DIR/site"

echo "==> Uploading site"
# --delete so files removed from a build do not linger and get served.
sshpass -e rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  dist/ "$USER@$HOST:$REMOTE_DIR/site/"

echo "==> Uploading Caddy config"
sshpass -e rsync -az \
  -e "ssh ${SSH_OPTS[*]}" \
  deploy/Caddyfile deploy/docker-compose.yml "$USER@$HOST:$REMOTE_DIR/"

echo "==> Starting Caddy"
sshpass -e ssh "${SSH_OPTS[@]}" "$USER@$HOST" \
  "cd $REMOTE_DIR && docker compose up -d && docker compose ps"

echo "==> Done. https://outliner.stebel.kim"
