# Deploying

## The one thing that decides the route: HTTPS

To install on an Android home screen as a real app (own icon, no browser chrome, works
offline), the page **must be served over HTTPS**. Chrome refuses to register a service
worker or offer "Install app" over plain HTTP.

That rules out one option and makes the rest equivalent in outcome:

| Route | HTTPS | Home-screen install | Setup | Deploy command |
|---|---|---|---|---|
| **AWS Amplify Hosting** | ✅ | ✅ | AWS creds only | `./deploy/deploy-amplify.sh` |
| **S3 + CloudFront** | ✅ | ✅ | ~6 commands, most moving parts | `./deploy/deploy-s3.sh` |
| **S3 website endpoint** | ❌ | ❌ | 5 commands | `./deploy/create-website-bucket.sh` |

**Amplify is the route in use.** It gives managed storage, a CDN and a TLS cert on
`*.amplifyapp.com` with no bucket to configure, and it redeploys from git on push.
The S3 routes below are kept as a record of the alternatives that were weighed, not
because anything runs on them.

> **Amplify does not serve from an S3 bucket you own.** It's a separate service with its
> own managed storage — that's why it gets HTTPS for free. If you specifically want your
> own bucket to be the origin, that's the S3 + CloudFront route instead.

Whatever you pick: **bump `CACHE` in `sw.js` whenever you change a file**, or phones that
already installed the app keep serving the old build from their service-worker cache.

---


## AWS Amplify Hosting

```sh
brew install awscli
aws configure                       # access key, secret, default region
./deploy/deploy-amplify.sh
```

First run creates the Amplify app, creates the `main` branch, applies the cache headers
from `amplify-headers.yml`, zips `dist/` and uploads it. It prints your URL and the
`APP_ID` to reuse:

```sh
APP_ID=d1a2b3c4d5 ./deploy/deploy-amplify.sh
```

Your URL: `https://main.<app-id>.amplifyapp.com`

Options: `APP_NAME`, `BRANCH`, `REGION`, `PROFILE`.

This uses Amplify's manual-deploy (zip upload) flow, so no Git connection is needed. If
you'd rather have Amplify build on every push, connect the repo in the Amplify console
instead — the app is static, so leave the build command empty and set the output
directory to `dist` with `bash tools/build-dist.sh` as the build step.

---

## S3 + CloudFront

Private bucket, CloudFront in front for HTTPS. Replace `BUCKET_NAME`, `REGION`,
`ACCOUNT_ID`, `DISTRIBUTION_ID`, `OAC_ID_HERE` in the JSON files as you go.

```sh
# 1. bucket (stays private — omit --create-bucket-configuration in us-east-1)
aws s3api create-bucket --bucket BUCKET_NAME --region REGION \
  --create-bucket-configuration LocationConstraint=REGION

# 2. upload
BUCKET=BUCKET_NAME ./deploy/deploy-s3.sh

# 3. Origin Access Control — note the id it returns
aws cloudfront create-origin-access-control \
  --origin-access-control-config file://deploy/cloudfront-oac.json \
  --query 'OriginAccessControl.Id' --output text

# 4. distribution (edit cloudfront-distribution.json first)
aws cloudfront create-distribution \
  --distribution-config file://deploy/cloudfront-distribution.json \
  --query '{Id:Distribution.Id,Domain:Distribution.DomainName}'

# 5. let CloudFront read the bucket (edit bucket-policy-cloudfront.json first)
aws s3api put-bucket-policy --bucket BUCKET_NAME \
  --policy file://deploy/bucket-policy-cloudfront.json
```

Redeploys, with cache invalidation:

```sh
BUCKET=BUCKET_NAME DISTRIBUTION_ID=E123ABC ./deploy/deploy-s3.sh
```

---

## S3 website endpoint (HTTP only — no home-screen install)

Fine for opening in a browser tab; not enough for an installed app. One command:

```sh
BUCKET=my-unique-bucket-name REGION=il-central-1 ./deploy/create-website-bucket.sh
```

That creates the bucket, clears the public-access block, applies the public-read policy,
enables website hosting, uploads the app, and prints and health-checks your URL. It is
idempotent — safe to re-run.

Doing it by hand instead:

```sh
aws s3api create-bucket --bucket BUCKET_NAME --region REGION \
  --create-bucket-configuration LocationConstraint=REGION

aws s3api put-public-access-block --bucket BUCKET_NAME \
  --public-access-block-configuration \
  "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"

sed 's/BUCKET_NAME/your-actual-bucket/g' deploy/bucket-policy-public.json > /tmp/policy.json
aws s3api put-bucket-policy --bucket BUCKET_NAME --policy file:///tmp/policy.json

aws s3api put-bucket-website --bucket BUCKET_NAME \
  --website-configuration file://deploy/website-config.json

BUCKET=BUCKET_NAME ./deploy/deploy-s3.sh
```

URL: `http://BUCKET_NAME.s3-website-REGION.amazonaws.com` — note that older regions use a
dash before the region and newer ones a dot (`s3-website.REGION.amazonaws.com`). The
script works this out for you.

You can add CloudFront on top of this bucket later to get HTTPS without redoing any of
the above.

---

## Privacy

All routes publish only the app's HTML/CSS/JS. **Recorded clicks are never uploaded** —
they live in `localStorage` on the phone, so even a world-readable bucket exposes no
personal data.

## Files here

| File | Used by |
|---|---|
| `deploy-amplify.sh` | Amplify |
| `amplify-headers.yml` | Amplify (cache/content-type rules) |
| `deploy-s3.sh` | S3 + CloudFront, S3 website |
| `create-website-bucket.sh` | S3 website (full setup) |
| `website-config.json` | S3 website |
| `bucket-policy-public.json` | S3 website |
| `bucket-policy-cloudfront.json` | S3 + CloudFront |
| `cloudfront-oac.json`, `cloudfront-distribution.json` | S3 + CloudFront |
