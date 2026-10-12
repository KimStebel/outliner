#!/usr/bin/env bash
#
# Exercise the deployed sync API end to end.
#
# Reads credentials from ./prod-basic-auth. Leaves the stored document as it
# found it, so it is safe to run against production.
#
# Usage: ./scripts/smoke-api.sh [base-url]

set -uo pipefail
cd "$(dirname "$0")/.."

BASE=${1:-https://outliner.stebel.kim}
API="$BASE/api/doc"
AUTH=$(cat prod-basic-auth)

checks=0
failures=0
check() {
  checks=$((checks + 1))
  if [[ $2 == "$3" ]]; then
    echo "  ok   $1"
  else
    failures=$((failures + 1))
    echo "  FAIL $1 — got '$2', want '$3'"
  fi
}

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
header_of() { grep -i "^$1:" <<<"$2" | tr -d '\r' | cut -d' ' -f2-; }

echo
echo "auth"
check "unauthenticated GET is refused" "$(status "$API")" "401"
check "unauthenticated PUT is refused" "$(status -X PUT -d '{}' "$API")" "401"
check "a wrong password is refused" "$(status -u "nope:wrong" "$API")" "401"
challenge=$(curl -s -o /dev/null -D- "$API" | grep -ic 'www-authenticate: *basic')
check "a browser is challenged, so the native dialog appears" "$challenge" "1"
check "the static site needs no auth" "$(status "$BASE/")" "200"

echo
echo "round trip"
# Preserve whatever is live so this can run against production.
original=$(mktemp)
trap 'rm -f "$original"' EXIT
existing=$(status -u "$AUTH" -o "$original" "$API")

# An array, so the header survives as one argument — and keyed off the status
# code being 200, not merely non-empty: "404" is a non-empty string too.
if [[ $existing == "200" ]]; then
  precondition=(-H 'If-Match: *')
else
  precondition=()
fi

payload='{"version":1,"doc":{"rootId":"root","items":{"root":{"id":"root","text":"","parent":null,"children":[],"collapsed":false}}},"smoke":true}'
headers=$(curl -s -D- -o /dev/null -u "$AUTH" -X PUT \
  -H 'Content-Type: application/json' \
  "${precondition[@]}" \
  --data "$payload" "$API")
code=$(head -1 <<<"$headers" | awk '{print $2}')
check "PUT stores the document" "$code" "204"
etag=$(header_of etag "$headers")
check "and returns an ETag" "$([[ -n $etag ]] && echo yes)" "yes"

body=$(curl -s -u "$AUTH" "$API")
check "GET returns exactly what was stored" "$body" "$payload"

echo
echo "conditional requests"
code=$(status -u "$AUTH" -H "If-None-Match: $etag" "$API")
check "a current ETag gets 304" "$code" "304"
code=$(status -u "$AUTH" -H 'If-None-Match: "stale"' "$API")
check "a stale ETag gets the document" "$code" "200"
code=$(status -u "$AUTH" -I -H "If-None-Match: $etag" "$API")
check "HEAD honours If-None-Match too" "$code" "304"
head_headers=$(curl -s -D- -o /dev/null -u "$AUTH" -I "$API")
check "HEAD reports Last-Modified" \
  "$([[ -n $(header_of last-modified "$head_headers") ]] && echo yes)" "yes"

echo
echo "the stale-overwrite guard"
code=$(status -u "$AUTH" -X PUT -H 'Content-Type: application/json' \
  --data '{"clobber":true}' "$API")
check "an overwrite with no If-Match is refused" "$code" "428"
code=$(status -u "$AUTH" -X PUT -H 'If-Match: "outdated"' \
  -H 'Content-Type: application/json' --data '{"clobber":true}' "$API")
check "an overwrite from a stale version is refused" "$code" "412"
check "and the document is untouched" "$(curl -s -u "$AUTH" "$API")" "$payload"

echo
echo "input validation"
code=$(status -u "$AUTH" -X PUT -H "If-Match: $etag" --data 'not json' "$API")
check "junk is rejected" "$code" "400"
code=$(status -u "$AUTH" -X PUT -H "If-Match: $etag" --data '' "$API")
check "an empty body is rejected" "$code" "400"
check "and still nothing was overwritten" "$(curl -s -u "$AUTH" "$API")" "$payload"

echo
echo "restoring the previous document"
if [[ $existing == "200" ]]; then
  current=$(curl -s -D- -o /dev/null -u "$AUTH" -I "$API")
  code=$(status -u "$AUTH" -X PUT -H "If-Match: $(header_of etag "$current")" \
    -H 'Content-Type: application/json' --data-binary "@$original" "$API")
  check "the document that was there before is back" "$code" "204"
else
  echo "  --   nothing was stored before this run; leaving the smoke document"
fi

echo
echo "$((checks - failures))/$checks checks passed"
[[ $failures -eq 0 ]]
