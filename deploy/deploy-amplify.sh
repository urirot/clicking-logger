#!/usr/bin/env bash
# Deploy to AWS Amplify Hosting — HTTPS on *.amplifyapp.com, no bucket to manage.
#
#   ./deploy/deploy-amplify.sh                    # first run: creates the app
#   APP_ID=d1a2b3c4d5 ./deploy/deploy-amplify.sh   # subsequent deploys
#   PROFILE=personal REGION=eu-central-1 ./deploy/deploy-amplify.sh
#
# Uses Amplify's manual-deploy flow (zip upload) — no Git connection needed.
set -euo pipefail

APP_NAME="${APP_NAME:-click-timeline}"
BRANCH="${BRANCH:-main}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Wrapper, not an array: macOS bash 3.2 errors on empty-array expansion under `set -u`.
awsx() {
  set -- "$@"
  if [[ -n "${PROFILE:-}" && -n "${REGION:-}" ]]; then command aws --profile "$PROFILE" --region "$REGION" "$@"
  elif [[ -n "${PROFILE:-}" ]]; then command aws --profile "$PROFILE" "$@"
  elif [[ -n "${REGION:-}" ]]; then command aws --region "$REGION" "$@"
  else command aws "$@"; fi
}

command -v aws >/dev/null || { echo "aws CLI not found — run: brew install awscli" >&2; exit 1; }
command -v zip >/dev/null || { echo "zip not found" >&2; exit 1; }
awsx sts get-caller-identity --query Arn --output text >/dev/null \
  || { echo "not authenticated — run: aws configure" >&2; exit 1; }

echo "▸ building dist/"
bash tools/build-dist.sh

# 1. app
if [[ -z "${APP_ID:-}" ]]; then
  APP_ID="$(awsx amplify list-apps --query "apps[?name=='$APP_NAME'].appId | [0]" --output text)"
  if [[ -z "$APP_ID" || "$APP_ID" == "None" ]]; then
    echo "▸ creating Amplify app '$APP_NAME'"
    APP_ID="$(awsx amplify create-app --name "$APP_NAME" --platform WEB \
      --custom-headers "$(cat customHttp.yml)" \
      --query 'app.appId' --output text)"
  else
    echo "▸ reusing existing app '$APP_NAME'"
  fi
fi
echo "  app id: $APP_ID"

# 2. headers (idempotent — safe to reapply)
awsx amplify update-app --app-id "$APP_ID" \
  --custom-headers "$(cat customHttp.yml)" >/dev/null

# 3. branch
if ! awsx amplify get-branch --app-id "$APP_ID" --branch-name "$BRANCH" >/dev/null 2>&1; then
  echo "▸ creating branch '$BRANCH'"
  awsx amplify create-branch --app-id "$APP_ID" --branch-name "$BRANCH" \
    --stage PRODUCTION >/dev/null
fi

# 4. zip and upload
ZIP="$(mktemp -t clicktl).zip"
trap 'rm -f "$ZIP"' EXIT
( cd dist && zip -qr "$ZIP" . )
echo "▸ uploading $(du -h "$ZIP" | cut -f1)"

read -r JOB_ID UPLOAD_URL <<EOF
$(awsx amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH" \
    --query '[jobId,zipUploadUrl]' --output text)
EOF

curl -sS -H 'Content-Type: application/zip' --upload-file "$ZIP" "$UPLOAD_URL"

echo "▸ starting deployment (job $JOB_ID)"
awsx amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" \
  --job-id "$JOB_ID" --query 'jobSummary.status' --output text

URL="https://$BRANCH.$APP_ID.amplifyapp.com"
echo
echo "───────────────────────────────────────────────"
echo " Your app:  $URL"
echo "───────────────────────────────────────────────"
echo
echo "Deployment runs for a few seconds. Watch it with:"
echo "  aws amplify get-job --app-id $APP_ID --branch-name $BRANCH --job-id $JOB_ID \\"
echo "    --query 'job.summary.status' --output text"
echo
echo "Redeploy later with:  APP_ID=$APP_ID ./deploy/deploy-amplify.sh"
echo "Remember to bump CACHE in sw.js when you change a file."
