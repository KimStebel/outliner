#!/usr/bin/env bash
#
# Start Rauthy for local development.
#
#   ./deploy/rauthy/rauthy-local.sh            start (or leave running)
#   ./deploy/rauthy/rauthy-local.sh --reset    throw the database away first
#
# --reset is needed more often than it sounds: bootstrap data is applied with a
# plain INSERT against an empty database, so edits to bootstrap/*.json have no
# effect on a database that already exists.
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE=compose.local.yml
HEALTH=http://127.0.0.1:8081/auth/v1/health
# Must agree with config.toml -> issuer = <scheme>://<pub_url>/auth/v1/
ISSUER=http://localhost:8080/auth/v1/

# shellcheck source=local-user.env
source ./local-user.env

if [[ "${1:-}" == "--reset" ]]; then
	echo "==> Removing the local Rauthy database"
	docker compose -f "$COMPOSE" down -v
fi

echo "==> Generating bootstrap-local"
./make-bootstrap-local.sh

echo "==> Validating config.toml"
# Catches a bad key or a malformed encryption key before the container starts,
# where the failure would be a panic in a log nobody is watching.
#
# Run through compose rather than `docker run` so it inherits the same
# environment: config.toml on its own is deliberately incomplete — every secret
# arrives as an env override — and validating it alone just fails on the
# missing encryption keys.
docker compose -f "$COMPOSE" run --rm --no-deps \
	--entrypoint /app/rauthy \
	rauthy validate-config --path /app/config.toml

echo "==> Starting Rauthy"
docker compose -f "$COMPOSE" up -d

printf '==> Waiting for %s' "$HEALTH"
for _ in $(seq 1 60); do
	if curl -fsS -o /dev/null "$HEALTH" 2>/dev/null; then
		echo ' ok'
		break
	fi
	printf '.'
	sleep 1
done

if ! curl -fsS -o /dev/null "$HEALTH" 2>/dev/null; then
	echo ' failed'
	docker compose -f "$COMPOSE" logs --tail 40 rauthy
	exit 1
fi

# Prove the issuer is what the backend will be told to expect, rather than
# assuming it. A mismatch here is the single most likely cause of every token
# being rejected later.
echo "==> Checking the issuer"
actual=$(curl -fsS http://127.0.0.1:8081/auth/v1/.well-known/openid-configuration |
	grep -o '"issuer":"[^"]*"' | cut -d'"' -f4)
if [[ "$actual" != "$ISSUER" ]]; then
	echo "    issuer is '$actual', expected '$ISSUER'" >&2
	exit 1
fi
echo "    $actual"

cat <<EOF

Rauthy is up.

  app + auth    http://localhost:8080/auth/v1/   (through the Vite dev server)
  direct        http://127.0.0.1:8081/auth/v1/
  admin UI      http://localhost:8080/auth/v1/admin
                $ADMIN_EMAIL / $ADMIN_PASSWORD
  app user      $USER_EMAIL / $USER_PASSWORD

Start the dev server with 'npm run dev' for the /auth proxy to work,
then check the token shape with 'node scripts/verify-oidc.mjs'.
EOF
