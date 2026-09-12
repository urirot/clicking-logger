# Deploying

The app is hosted on **AWS Amplify**. Everything else that was once here — Firebase,
S3 + CloudFront, a raw S3 website bucket — was an alternative that lost, and has been
removed rather than left to rot.

## Why hosting matters at all: HTTPS

To install on an Android home screen as a real app (own icon, no browser chrome, works
offline), the page **must be served over HTTPS**. Chrome refuses to register a service
worker or offer "Install app" over plain HTTP. Amplify gives managed storage, a CDN and
a TLS cert on `*.amplifyapp.com` with no bucket to configure.

> **Bump `CACHE` in `sw.js` whenever you change a shipping file**, or phones that already
> installed the app keep serving the old build from their service-worker cache.

## Two ways to deploy, both Amplify

### 1. Git-connected (what runs today)

Amplify watches the repo and rebuilds on push. The build spec is `amplify.yml` at the
repo root; the cache and content-type rules are `customHttp.yml` beside it.

`amplify.yml` declares its phases explicitly so Amplify does **not** auto-detect Node and
run `npm ci` — `package-lock.json` is gitignored and the npm dependencies are for the
test suite and the native builds, none of which the web deploy needs.

### 2. Manual zip upload (fallback)

```sh
brew install awscli
aws configure                       # access key, secret, default region
./deploy/deploy-amplify.sh
```

First run creates the Amplify app and the `main` branch, applies the headers from
`customHttp.yml`, then zips `dist/` and uploads it. It prints your URL and the `APP_ID`
to reuse:

```sh
APP_ID=d1a2b3c4d5 ./deploy/deploy-amplify.sh
```

Your URL: `https://main.<app-id>.amplifyapp.com`

Options: `APP_NAME`, `BRANCH`, `REGION`, `PROFILE`.

No Git connection is needed for this route, which is what makes it a usable fallback if
the connected build is ever wedged.

## Privacy

The deploy publishes only the app's HTML/CSS/JS. **Recorded clicks are never uploaded** —
they live in `localStorage` on the phone, so the hosting layer holds no personal data.

## Files here

| File | Used by |
|---|---|
| `deploy-amplify.sh` | the manual zip-upload route |

The Git-connected route's config lives at the repo root: `amplify.yml` (build spec) and
`customHttp.yml` (cache and content-type headers).

## The native apps

iOS and Android are not deployed from here — they are built from the same source and
submitted to the stores. See [`../NATIVE.md`](../NATIVE.md).
