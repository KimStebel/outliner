#!/usr/bin/env bash
#
# Daily backup of every user's document to Cloudflare R2. Runs on the server,
# driven by outliner-backup.timer.
#
# Each user's document is in a directory named after their subject, and is
# kept under doc/<subject>/ with retention counted per user, so one busy
# account cannot push another's history out. One user's bad document fails
# the run but does not stop everyone else's being backed up.
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
DATA=${DATA:-/home/outliner/data}
# Overridable so this can be exercised against a throwaway prefix without
# touching the real backups.
PREFIX=${PREFIX:-doc}
DATE=${DATE:-$(date -u +%F)}
# Kept by count rather than by age, per user. With a daily run the two are the same, but
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

# Upload one document and prune that user's older backups. Returns non-zero
# rather than exiting, so the other users still get their turn.
backup_one() {
	local user=$1 doc=$2

	[[ -s $doc ]] || { log "FAILED: $doc is empty"; return 1; }

	# A corrupt document must not become the backup. Failing here leaves the
	# last ten good ones in place, which is the right outcome; quietly
	# uploading wreckage would overwrite all of them inside ten days.
	python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$doc" 2>/dev/null ||
		{ log "FAILED: $doc is not valid JSON"; return 1; }

	local bytes sha key tmp gz_bytes status stored listing expired old
	bytes=$(stat -c %s "$doc")
	# The same value the API serves as its ETag, which is what makes the
	# backup checkable later without having to restore it.
	sha=$(sha256sum "$doc" | cut -d' ' -f1)
	key="${PREFIX}/${user}/${DATE}.json.gz"

	tmp=$(mktemp /tmp/outliner-backup.XXXXXX.gz)
	gzip -9 -c "$doc" >"$tmp"
	gz_bytes=$(stat -c %s "$tmp")

	log "uploading $key ($bytes bytes, $gz_bytes gzipped, sha256 ${sha:0:12})"
	status=$(r2 PUT "${HQL_S3_BUCKET}/${key}" \
		--data-binary "@$tmp" \
		-H 'Content-Type: application/gzip' \
		-H "x-amz-meta-sha256: $sha" \
		-H "x-amz-meta-bytes: $bytes" \
		-o /dev/null -w '%{http_code}')
	rm -f "$tmp"
	[[ $status == 200 ]] || { log "FAILED: upload of $key answered $status"; return 1; }

	# Read it back rather than trusting the 200. Cheap, and it is the
	# difference between "the request succeeded" and "the object is there".
	stored=$(r2 HEAD "${HQL_S3_BUCKET}/${key}" -I | tr -d '\r' |
		sed -n 's/^[Cc]ontent-[Ll]ength: //p')
	[[ $stored == "$gz_bytes" ]] ||
		{ log "FAILED: stored $key is $stored bytes, expected $gz_bytes"; return 1; }
	log "verified $key"

	# -- retention, within this user's prefix only ---------------------------

	# Keys are dated, so sorting them lexicographically sorts them by time.
	listing=$(r2 GET "${HQL_S3_BUCKET}?list-type=2&prefix=${PREFIX}/${user}/&max-keys=1000")
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
				log "FAILED: could not remove $old: answered $status"
				return 1
			fi
		done <<<"$expired"
	fi

	local kept
	kept=$(printf '%s' "$listing" | grep -c '<Key>' || true)
	log "$user: $((kept > KEEP ? KEEP : kept)) backup(s) retained"
}

docs=0
failed=0
for doc in "$DATA"/*/doc.json; do
	[[ -e $doc ]] || continue
	docs=$((docs + 1))
	backup_one "$(basename "$(dirname "$doc")")" "$doc" || failed=$((failed + 1))
done

# Finding nothing at all is a failure, not a quiet success: it is what a
# wrong DATA path, or a document left behind at the top level, looks like.
((docs > 0)) || die "no documents under $DATA/*/doc.json"
if [[ -e $DATA/doc.json ]]; then
	log "WARNING: $DATA/doc.json predates per-user storage and is not backed up"
fi
((failed == 0)) || die "$failed of $docs document(s) not backed up"
log "done; $docs document(s) backed up"
