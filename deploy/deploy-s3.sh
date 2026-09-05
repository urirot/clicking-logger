#!/usr/bin/env bash
# Upload the app to S3 with the right content types and cache headers.
#
#   BUCKET=my-bucket ./deploy/deploy-s3.sh
#   BUCKET=my-bucket DISTRIBUTION_ID=E123ABC ./deploy/deploy-s3.sh   # + CloudFront invalidation
#   BUCKET=my-bucket PROFILE=personal ./deploy/deploy-s3.sh          # non-default AWS profile
#
# Cache policy: the icons may be cached for a week; everything else must be
# revalidated on every load, because index.html/app.js/sw.js carry no content hash
# and a stale sw.js pins installed phones to an old build.

set -euo pipefail

: "${BUCKET:?set BUCKET=your-bucket-name}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v aws >/dev/null || { echo "aws CLI not found — brew install awscli" >&2; exit 1; }

# Wrapper, not an array: macOS ships bash 3.2, where expanding an empty array
# under `set -u` is an "unbound variable" error.
awsx() {
  if [[ -n "${PROFILE:-}" ]]; then command aws --profile "$PROFILE" "$@"
  else command aws "$@"; fi
}

NOCACHE='no-cache, must-revalidate'
LONG='public, max-age=604800'

put() {  # put <file> <content-type> <cache-control>
  echo "  → $1"
  awsx s3 cp "$1" "s3://$BUCKET/$1" \
    --content-type "$2" --cache-control "$3" --only-show-errors
}

echo "Uploading to s3://$BUCKET"
put index.html           'text/html; charset=utf-8'       "$NOCACHE"
put app.js               'text/javascript; charset=utf-8' "$NOCACHE"
put styles.css           'text/css; charset=utf-8'        "$NOCACHE"
put sw.js                'text/javascript; charset=utf-8' "$NOCACHE"
put manifest.webmanifest 'application/manifest+json'      "$NOCACHE"
put icon-192.png         'image/png'                      "$LONG"
put icon-512.png         'image/png'                      "$LONG"

if [[ -n "${DISTRIBUTION_ID:-}" ]]; then
  echo "Invalidating CloudFront $DISTRIBUTION_ID"
  awsx cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" \
    --paths '/*' --query 'Invalidation.Id' --output text
fi

# Reminder, because this is the one thing that silently breaks installed phones.
if ! grep -q "const CACHE = 'click-timeline-v" sw.js; then
  echo "note: could not read the CACHE version from sw.js" >&2
else
  echo
  echo "Deployed. sw.js cache version: $(grep -o "click-timeline-v[0-9]*" sw.js | head -1)"
  echo "If you changed any file, bump that version in sw.js and redeploy,"
  echo "or already-installed phones will keep serving the old build."
fi
