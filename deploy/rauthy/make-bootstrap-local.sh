#!/usr/bin/env bash
#
# Generate the local Rauthy bootstrap directory.
#
# Shared by the Rauthy-only setup (rauthy-local.sh, for use with the Vite dev
# server) and the full local stack (../stack-local.sh), so the two cannot end
# up with different users or clients.
#
# Rauthy reads bootstrap data from one fixed directory, so the local extras go
# into a generated copy of the committed one. bootstrap/clients.json stays the
# single definition of the real client: local cannot drift from production by
# someone editing a second copy of it.
set -euo pipefail

cd "$(dirname "$0")"

# shellcheck source=local-user.env
source ./local-user.env

LOCAL_DIR=bootstrap-local

rm -rf "$LOCAL_DIR"
mkdir -p "$LOCAL_DIR"

# Generated rather than committed because production needs this same file with
# a real password, and that must never be in the repo.
cat >"$LOCAL_DIR/users.json" <<EOF
[
  {
    "id": "$USER_ID",
    "email": "$USER_EMAIL",
    "given_name": "Kim",
    "password": { "Plain": "$USER_PASSWORD" },
    "roles": ["user"],
    "enabled": true,
    "email_verified": true
  }
]
EOF

# The real client, plus one that exists only to make the refresh flow testable.
#
# A refresh token's `nbf` is `now + access_token_lifetime - 60s`, so with the
# real client's 24h tokens it cannot be redeemed for nearly a day. Giving the
# probe a 70 second access token puts its `nbf` 10 seconds out, which a test
# can wait for — and it exercises the real nbf rule rather than switching it
# off, which is what `disable_refresh_token_nbf` would do.
python3 - "$LOCAL_DIR" <<'PY'
import json, sys
clients = json.load(open('bootstrap/clients.json'))
probe = dict(next(c for c in clients if c['id'] == 'outliner'))
probe.update(
    id='outliner-refresh-probe',
    name='Outliner refresh probe',
    access_token_lifetime=70,
)
json.dump(clients + [probe], open(f'{sys.argv[1]}/clients.json', 'w'), indent=2)
PY
