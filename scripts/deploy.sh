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
AUTH_FILE=prod-basic-auth
for required in "$ENV_FILE" "$AUTH_FILE"; do
  if [[ ! -f $required ]]; then
    echo "Missing $required." >&2
    exit 1
  fi
done

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

echo "==> Uploading Caddy config and backend source"
sshpass -e rsync -az \
  -e "ssh ${SSH_OPTS[*]}" \
  deploy/Caddyfile deploy/docker-compose.yml "$USER@$HOST:$REMOTE_DIR/"
sshpass -e rsync -az --delete \
  --exclude target \
  -e "ssh ${SSH_OPTS[*]}" \
  backend/ "$USER@$HOST:$REMOTE_DIR/backend/"

echo "==> Writing Caddy credentials"
# Hashed locally with the same Caddy image that will verify it, so the
# plaintext password never reaches the server at all — only the bcrypt hash.
# `-e PW` takes the value from this process's environment rather than argv, so
# it does not appear in `ps`.
BASIC_USER=$(cut -d: -f1 "$AUTH_FILE")
PW=$(cut -d: -f2- "$AUTH_FILE")
export PW
BASIC_HASH=$(docker run --rm -e PW caddy:2-alpine \
  sh -c 'caddy hash-password --plaintext "$PW"')
unset PW

# Written as a Caddyfile snippet rather than environment variables: compose
# interpolates env_file values and would eat the `$` sequences in the hash.
#
# Just the credentials, not the whole `basic_auth` block: the Caddyfile wraps
# this in one with a matcher, so that a request carrying a bearer token is not
# also asked for a password — Caddy would refuse it before the backend could
# check the token.
AUTH_SNIPPET=$(mktemp)
trap 'rm -f "$AUTH_SNIPPET"' EXIT
chmod 600 "$AUTH_SNIPPET"
printf '%s %s\n' "$BASIC_USER" "$BASIC_HASH" >"$AUTH_SNIPPET"
sshpass -e rsync -az --chmod=F600 \
  -e "ssh ${SSH_OPTS[*]}" \
  "$AUTH_SNIPPET" "$USER@$HOST:$REMOTE_DIR/auth.caddy"

# The backend runs unprivileged, so its data directory must be writable by it.
sshpass -e ssh "${SSH_OPTS[@]}" "$USER@$HOST" \
  "mkdir -p $REMOTE_DIR/data && chown -R 10001:10001 $REMOTE_DIR/data"

echo "==> Building and starting"
sshpass -e ssh "${SSH_OPTS[@]}" "$USER@$HOST" \
  "cd $REMOTE_DIR && docker compose up -d --build"

# The Caddyfile is a bind mount, so changing it does not change the container
# and `up -d` leaves it running with the old config. Without this, a config
# change silently does not take effect.
echo "==> Reloading Caddy config"
sshpass -e ssh "${SSH_OPTS[@]}" "$USER@$HOST" \
  "cd $REMOTE_DIR && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>&1 | tail -1 && docker compose ps"

echo "==> Done. https://outliner.stebel.kim"
