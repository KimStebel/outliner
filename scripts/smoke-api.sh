#!/usr/bin/env bash
#
# Exercise the deployed sync API end to end.
#
# Reads credentials from ./prod-basic-auth.
#
# This test WRITES to the document store. It refuses to run when the store
# already holds something, because a restore that silently fails leaves the
# real document replaced by a test fixture — which is exactly what happened
# once. Pass --allow-overwrite only against a store you do not care about.
#
# Usage: ./scripts/smoke-api.sh [base-url] [--allow-overwrite]

set -uo pipefail
cd "$(dirname "$0")/.."

BASE=https://outliner.stebel.kim
ALLOW_OVERWRITE=0
for arg in "$@"; do
  case $arg in
    --allow-overwrite) ALLOW_OVERWRITE=1 ;;
    http*) BASE=$arg ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
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
# Preserve whatever is live. `--compressed` matters: without it curl writes
# the gzip bytes, and restoring those later is not valid JSON, so the restore
# fails and the real document stays replaced.
original=$(mktemp)
trap 'rm -f "$original"' EXIT
existing=$(curl -s -o "$original" -w '%{http_code}' --compressed -u "$AUTH" "$API")

if [[ $existing == "200" && $ALLOW_OVERWRITE != "1" ]]; then
  echo "  --   the store holds a document ($(wc -c <"$original") bytes)."
  echo "       This test overwrites it. Re-run with --allow-overwrite if that"
  echo "       document is expendable."
  exit 2
fi

# An array, so the header survives as one argument — and keyed off the status
# code being 200, not merely non-empty: "404" is a non-empty string too.
if [[ $existing == "200" ]]; then
  precondition=(-H 'If-Match: *')
else
  precondition=()
fi

# Padded past Caddy's minimum compression length. The ETag bug this guards
# against only appears on responses the proxy actually compresses, so a
# fixture small enough to be sent verbatim would never catch it.
filler=$(printf 'x%.0s' $(seq 1 1200))
payload="{\"version\":1,\"doc\":{\"rootId\":\"root\",\"items\":{\"root\":{\"id\":\"root\",\"text\":\"\",\"parent\":null,\"children\":[],\"collapsed\":false}}},\"smoke\":\"$filler\"}"
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
echo "the ETag a browser is given is one the server will accept"
# The proxy compresses, which rewrites the ETag. Both conditional paths must
# still work with the rewritten tag, or writes are refused as stale and polls
# re-download the whole document instead of getting a 304.
zipped=$(curl -s -D- -o /dev/null -u "$AUTH" -H 'Accept-Encoding: gzip' "$API")
check "responses are compressed" "$(header_of content-encoding "$zipped")" "gzip"
browser_tag=$(header_of etag "$zipped")
check "and the tag is the rewritten one" \
  "$([[ $browser_tag == *-gzip* ]] && echo yes)" "yes"
code=$(status -u "$AUTH" --compressed -H "If-None-Match: $browser_tag" "$API")
check "a conditional read with it gets 304" "$code" "304"
roundtrip=$(mktemp)
browser_etag=$(curl -s -D- -o "$roundtrip" -u "$AUTH" --compressed "$API" |
  grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2-)
code=$(status -u "$AUTH" -X PUT -H "If-Match: $browser_etag" \
  -H 'Content-Type: application/json' --data-binary "@$roundtrip" "$API")
rm -f "$roundtrip"
check "a write using it is accepted" "$code" "204"
etag=$(header_of etag "$(curl -s -D- -o /dev/null -u "$AUTH" -I "$API")")

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
  check "the restore was accepted" "$code" "204"
  # Verify rather than assume: a restore that fails silently is how a real
  # document gets left replaced by a test fixture.
  check "and the document really is byte-for-byte what it was" \
    "$(curl -s --compressed -u "$AUTH" "$API" | cksum)" "$(cksum <"$original")"
else
  echo "  --   nothing was stored before this run; clearing the smoke document"
  current=$(curl -s -D- -o /dev/null -u "$AUTH" -I "$API")
  status -u "$AUTH" -X PUT -H "If-Match: $(header_of etag "$current")" \
    -H 'Content-Type: application/json' \
    --data '{"version":1,"doc":{"rootId":"root","items":{"root":{"id":"root","text":"","parent":null,"children":[],"collapsed":false}}}}' \
    "$API" >/dev/null
fi

echo
echo "$((checks - failures))/$checks checks passed"
[[ $failures -eq 0 ]]
