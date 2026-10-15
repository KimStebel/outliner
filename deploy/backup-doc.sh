#!/usr/bin/env bash
#
# Daily backup of the document to Cloudflare R2. Runs on the server, driven by
# outliner-backup.timer.
#
# Rauthy backs up its own database — consistently, encrypted, and with its own
# retention — so this only has to deal with the document, which is the part
# nothing else covers.
#
# No snapshotting or locking is needed: the backend writes the document
# atomically (temp file, fsync, rename), so this file is always a complete
# version and never a half-written one.
#
# Nothing is installed for this. curl on this box signs its own S3 requests
# with --aws-sigv4, and python3 is only used to pick keys out of a listing.
set -euo pipefail

CONF=${CONF:-/home/outliner/r2.env}
DOC=${DOC:-/home/outliner/data/doc.json}
# Overridable so this can be exercised against a throwaway prefix without
# touching the real backups.
PREFIX=${PREFIX:-doc}
DATE=${DATE:-$(date -u +%F)}
# Kept by count rather than by age. With a daily run the two are the same, but
# they fail differently: if this stops running, "delete anything older than ten
# days" eventually leaves nothing, while keeping the newest ten leaves those
# ten in place for as long as it takes someone to notice.
KEEP=${KEEP:-10}

# HQL_S3_URL, HQL_S3_BUCKET, HQL_S3_REGION, HQL_S3_KEY, HQL_S3_SECRET. Shared
# with Rauthy, which reads the same file as its env_file, so there is one place
# the credentials live.
# shellcheck source=/dev/null
source "$CONF"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() {
	log "FAILED: $*"
	exit 1
}

# The credentials go in on stdin rather than the command line, so they do not
# show up in `ps` for the lifetime of the request.
r2() {
	local method=$1 path=$2
	shift 2
	curl -sS --aws-sigv4 "aws:amz:${HQL_S3_REGION}:s3" -X "$method" \
		"${HQL_S3_URL}/${path}" "$@" -K - <<-EOF
			user = "${HQL_S3_KEY}:${HQL_S3_SECRET}"
		EOF
}

[[ -s $DOC ]] || die "$DOC is missing or empty"

# A corrupt document must not become the backup. Failing here leaves the last
# ten good ones in place, which is the right outcome; quietly uploading
# wreckage would overwrite all of them inside ten days.
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$DOC" 2>/dev/null ||
	die "$DOC is not valid JSON"

BYTES=$(stat -c %s "$DOC")
# The same value the API serves as its ETag, which is what makes the backup
# checkable later without having to restore it.
SHA=$(sha256sum "$DOC" | cut -d' ' -f1)
KEY="${PREFIX}/${DATE}.json.gz"

TMP=$(mktemp /tmp/outliner-backup.XXXXXX.gz)
trap 'rm -f "$TMP"' EXIT
gzip -9 -c "$DOC" >"$TMP"
GZ_BYTES=$(stat -c %s "$TMP")

log "uploading $KEY ($BYTES bytes, $GZ_BYTES gzipped, sha256 ${SHA:0:12})"
status=$(r2 PUT "${HQL_S3_BUCKET}/${KEY}" \
	--data-binary "@$TMP" \
	-H 'Content-Type: application/gzip' \
	-H "x-amz-meta-sha256: $SHA" \
	-H "x-amz-meta-bytes: $BYTES" \
	-o /dev/null -w '%{http_code}')
[[ $status == 200 ]] || die "upload answered $status"

# Read it back rather than trusting the 200. Cheap, and it is the difference
# between "the request succeeded" and "the object is there".
stored=$(r2 HEAD "${HQL_S3_BUCKET}/${KEY}" -I | tr -d '\r' |
	sed -n 's/^[Cc]ontent-[Ll]ength: //p')
[[ $stored == "$GZ_BYTES" ]] ||
	die "stored object is $stored bytes, expected $GZ_BYTES"
log "verified $KEY"

# -- retention ---------------------------------------------------------------

# Keys are dated, so sorting them lexicographically sorts them by time.
listing=$(r2 GET "${HQL_S3_BUCKET}?list-type=2&prefix=${PREFIX}/&max-keys=1000")
expired=$(printf '%s' "$listing" | python3 -c '
import sys, xml.etree.ElementTree as ET

NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
root = ET.fromstring(sys.stdin.read())
keys = sorted(e.text for e in root.iter(NS + "Key"))
keep = int(sys.argv[1])
for key in keys[:-keep] if keep else keys:
    print(key)
' "$KEEP")

if [[ -n $expired ]]; then
	while read -r old; do
		[[ -n $old ]] || continue
		status=$(r2 DELETE "${HQL_S3_BUCKET}/${old}" -o /dev/null -w '%{http_code}')
		# 204 on delete, 404 if something else got there first.
		if [[ $status == 204 || $status == 404 ]]; then
			log "removed $old"
		else
			die "could not remove $old: answered $status"
		fi
	done <<<"$expired"
fi

kept=$(printf '%s' "$listing" | grep -c '<Key>' || true)
log "done; $((kept > KEEP ? KEEP : kept)) backup(s) retained"
