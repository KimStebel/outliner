#!/usr/bin/env bash
#
# Bring up the whole stack locally, the way production runs it.
#
#   ./deploy/stack-local.sh            build and start
#   ./deploy/stack-local.sh --reset    throw away the databases first
#
# --reset matters for Rauthy in particular: bootstrap data is applied with a
# plain INSERT against an empty database, so edits to its clients or users do
# nothing to a database that already exists.
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE=compose.local.yml
ORIGIN=http://localhost:8080
# Must agree with rauthy/config.toml -> <scheme>://<pub_url>/auth/v1/ and with
# AUTH_ISSUER in the compose file.
ISSUER=$ORIGIN/auth/v1/

# shellcheck source=rauthy/local-user.env
source ./rauthy/local-user.env

if [[ "${1:-}" == "--reset" ]]; then
	echo "==> Removing the local databases"
	docker compose -f "$COMPOSE" down -v
fi

echo "==> Building the site"
(cd .. && npm run build)

echo "==> Generating Rauthy bootstrap data"
./rauthy/make-bootstrap-local.sh

echo "==> Writing auth.caddy"
# The same shape production gets, so the Caddyfile's `import` is exercised
# here too. Hashed with the image that will verify it.
PW=$BASIC_PASSWORD
export PW
BASIC_HASH=$(docker run --rm -e PW caddy:2-alpine \
	sh -c 'caddy hash-password --plaintext "$PW"')
unset PW
printf '%s %s\n' "$BASIC_USER" "$BASIC_HASH" >auth.caddy

echo "==> Starting"
docker compose -f "$COMPOSE" up -d --build

# Not /api/health: that sits behind Caddy's basic auth like the rest of the
# API, so an unauthenticated probe of it would always fail.
ready() {
	curl -fsS -o /dev/null "$ORIGIN/" 2>/dev/null &&
		curl -fsS -o /dev/null "$ORIGIN/auth/v1/health" 2>/dev/null
}

printf '==> Waiting for the app and the provider'
for _ in $(seq 1 90); do
	if ready; then
		echo ' ok'
		break
	fi
	printf '.'
	sleep 1
done

if ! ready; then
	echo ' failed'
	docker compose -f "$COMPOSE" logs --tail 30
	exit 1
fi

# The issuer the provider advertises has to be the one the backend was told to
# expect. A mismatch here rejects every token, and is invisible until a client
# tries to sync.
echo "==> Checking the issuer agrees with the backend's"
advertised=$(curl -fsS "$ORIGIN/auth/v1/.well-known/openid-configuration" |
	grep -o '"issuer":"[^"]*"' | cut -d'"' -f4)
configured=$(grep -o 'AUTH_ISSUER: .*' "$COMPOSE" | head -1 | cut -d' ' -f2-)
if [[ "$advertised" != "$configured" ]]; then
	echo "    provider says '$advertised', backend expects '$configured'" >&2
	exit 1
fi
echo "    $advertised"

cat <<EOF

The stack is up at $ORIGIN

  app           $ORIGIN/
  admin UI      $ORIGIN/auth/v1/admin
                $ADMIN_EMAIL / $ADMIN_PASSWORD
  app user      $USER_EMAIL / $USER_PASSWORD
  basic auth    $BASIC_USER / $BASIC_PASSWORD   (still accepted, for now)

  node scripts/verify-oidc.mjs      the token shape, against this stack
  node scripts/verify-stack.mjs     the auth rules through Caddy
  docker compose -f deploy/$COMPOSE logs -f backend
EOF
