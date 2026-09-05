#!/usr/bin/env bash
# One-shot setup of an S3 static-website bucket for this app.
#
#   BUCKET=my-unique-bucket-name REGION=il-central-1 ./deploy/create-website-bucket.sh
#
# Idempotent: safe to re-run. Serves over HTTP only (S3 website endpoints have no TLS).

set -euo pipefail

: "${BUCKET:?set BUCKET=your-globally-unique-bucket-name}"
: "${REGION:?set REGION=e.g. il-central-1, eu-central-1, us-east-1}"
# Wrapper, not an array: macOS ships bash 3.2, where expanding an empty array
# under `set -u` is an "unbound variable" error.
awsx() {
  if [[ -n "${PROFILE:-}" ]]; then command aws --profile "$PROFILE" "$@"
  else command aws "$@"; fi
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
command -v aws >/dev/null || { echo "aws CLI not found — run: brew install awscli" >&2; exit 1; }

awsx sts get-caller-identity --query Arn --output text >/dev/null \
  || { echo "not authenticated — run: aws configure" >&2; exit 1; }

echo "▸ 1/5  creating bucket $BUCKET in $REGION"
if awsx s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "       already exists — skipping"
elif [[ "$REGION" == "us-east-1" ]]; then
  awsx s3api create-bucket --bucket "$BUCKET" --region us-east-1
else
  awsx s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION"
fi

echo "▸ 2/5  allowing a public bucket policy"
awsx s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"

echo "▸ 3/5  granting public read on objects"
POLICY="$(mktemp -t clicktl)"; trap 'rm -f "$POLICY"' EXIT
sed "s/BUCKET_NAME/$BUCKET/g" deploy/bucket-policy-public.json > "$POLICY"
awsx s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$POLICY"

echo "▸ 4/5  turning on website hosting"
awsx s3api put-bucket-website --bucket "$BUCKET" \
  --website-configuration file://deploy/website-config.json

echo "▸ 5/5  uploading the app"
BUCKET="$BUCKET" PROFILE="${PROFILE:-}" ./deploy/deploy-s3.sh

# Older regions use a dash before the region in the website endpoint; newer ones a dot.
case "$REGION" in
  us-east-1|us-west-1|us-west-2|ap-southeast-1|ap-southeast-2|ap-northeast-1|eu-west-1|sa-east-1)
    HOST="$BUCKET.s3-website-$REGION.amazonaws.com" ;;
  *)
    HOST="$BUCKET.s3-website.$REGION.amazonaws.com" ;;
esac

echo
echo "───────────────────────────────────────────────"
echo " Your app:  http://$HOST"
echo "───────────────────────────────────────────────"
echo
printf 'checking… '
code="$(curl -s -o /dev/null -w '%{http_code}' "http://$HOST/" || true)"
if [[ "$code" == "200" ]]; then
  echo "HTTP 200 — live."
else
  echo "HTTP $code."
  echo "If this is 307/404, the endpoint may use the other host form; try:"
  echo "  http://$BUCKET.s3-website-$REGION.amazonaws.com"
  echo "  http://$BUCKET.s3-website.$REGION.amazonaws.com"
  echo "DNS for a brand-new bucket can also take a minute to propagate."
fi
