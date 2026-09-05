# Click Timeline

A one-page app: tap **blue**, **yellow** or **red** to stamp the current time, then read the whole
log off one picture — three rate curves showing how fast each colour is being tapped at
each moment, over a rail that keeps every individual tap visible as its own tick.

Built as an offline-capable PWA so it installs to an Android/iOS home screen and works
with no signal.

## How clicks are stored

Every tap appends `{ id, t, b }` (timestamp in epoch ms, button 1–3) to one array kept
in the browser's `localStorage` under the key `click-timeline/v1`, written synchronously
on every tap. That's the whole storage layer — no database, no API, no account, no sync.
The code makes zero network requests; the only `fetch` in the project is inside `sw.js`,
serving the app's own files for offline use.

What that means in practice:

* **Data is tied to one origin on one device.** Clicks recorded on
  `https://main.abc123.amplifyapp.com` are not visible from a different URL or a
  different phone. Moving hosts or adding a custom domain starts a fresh log — use
  **Export JSON** on the old URL and **Import JSON** on the new one.
* **The installed home-screen app and the same site in a Chrome tab share the log** —
  same origin, same profile, same storage.
* **It survives app restarts, reboots and going offline.** On first run the app calls
  `navigator.storage.persist()`, which asks Android not to evict the data when the
  device is low on space (granted silently for installed PWAs).
* **It does not survive "clear site data", uninstalling with storage cleared, or a
  factory reset.** Export a JSON backup if the history matters.

### Import merges by day

**Import is not a dedupe-and-append.** Every local calendar day the file mentions
*replaces* whatever is recorded here for that day; every day the file says nothing about
is left exactly as it is. So re-importing a corrected Tuesday fixes Tuesday rather than
doubling it, and importing one device's Tuesday never touches the Wednesday you only
have here.

The consequence: importing a day you already have **discards** the local version of that
day, and undo only pops the newest click, so there is no way back. Import therefore
prompts before it destroys anything — naming how many days and how many clicks are at
stake — and only when the file actually overlaps days that already have clicks.

Malformed entries are skipped; a click needs a finite `t` and a `b` of 1, 2 or 3.
Imported clicks are given fresh ids, so a file exported from another device can never
collide with what is already here.

## Privacy

**Your click data never leaves your device.** It lives in the browser's `localStorage`
on the phone you tap on — there is no server, no database, no account, no analytics.
The published page is just static HTML/CSS/JS.

Note that GitHub Pages sites are *publicly reachable* even when the repo is private
(truly private Pages is a GitHub Enterprise Cloud feature). That's fine here: the URL
serves the empty app to anyone who finds it, and your recorded times aren't in it.

Use **Export JSON** for a backup before clearing browser data — clearing site data for
the domain deletes the log.

## Deploying

Any static host works — the app is 7 files and makes no network calls. Configs and a
runbook for each route are in **[`deploy/README.md`](deploy/README.md)**.

**The page must be served over HTTPS** to install on a home screen: Chrome won't
register a service worker or offer "Install app" over plain HTTP.

| Route | HTTPS | Deploy |
|---|---|---|
| Firebase Hosting | ✅ | `firebase deploy --only hosting` |
| AWS Amplify Hosting | ✅ | `./deploy/deploy-amplify.sh` |
| S3 + CloudFront | ✅ | `BUCKET=… DISTRIBUTION_ID=… ./deploy/deploy-s3.sh` |
| GitHub Pages | ✅ | push, then enable Pages (`.nojekyll` is in place) |
| S3 website endpoint | ❌ | `BUCKET=… REGION=… ./deploy/create-website-bucket.sh` |

Whatever the host, **bump `CACHE` in `sw.js` when you change a file** — installed
phones keep serving the old build otherwise.

## Install on Android

1. Open the Pages URL in Chrome.
2. ⋮ menu → **Add to Home screen** (Chrome may offer **Install app** instead).
3. Launch from the icon — it opens standalone, no browser chrome.

On iOS: Safari → Share → **Add to Home Screen**.

## Using it

| | |
|---|---|
| Tap a colour | records a click at the current time |
| Keys `1` `2` `3` | same, on a desktop keyboard — `1` blue, `2` yellow, `3` red |
| Today / 7 / 30 / All | scopes the chart — opens on **7 days** |
| Hover or tap the chart | nearest tap: its exact timestamp, and all three colours' rates at that moment |
| ↶ | undo the last click — in the top bar, so it is reachable from the pad |
| ◐ | cycles theme: auto → light → dark |
| Export JSON | back the log up, or move it to another device |
| Import JSON | merge a file back in — see **Import merges by day** below |

The buttons carry no numerals — the colour *is* the identity, and the badge on each one
counts **today**. The range chips scope the chart. The Timeline screen is the chart and
an export/import pair, nothing else: no log table, no clear. Undo lives in the
top bar instead, next to the theme toggle, so a mistaken tap can be dropped without
leaving the pad; it greys out when the log is empty.

## Files

```
index.html            markup
styles.css            tokens + layout (light/dark, both OS setting and manual toggle)
app.js                storage, SVG chart, export
manifest.webmanifest  PWA metadata
sw.js                 service worker — network-first, cache fallback
icon-192/512.png      three palette dots, generated by tools/make_icons.py (no image deps)
tools/smoke-test.mjs  jsdom smoke test (npm test)
firebase.json         Firebase Hosting config (builds dist/, sets cache headers)
deploy/               Amplify + S3/CloudFront configs and deploy scripts
tools/build-dist.sh   copies just the 7 shipping files into dist/
```

## Develop

```sh
npm run serve      # http://localhost:8731
```

Run the smoke test (~70 assertions over recording, curve geometry and the shared count
scale, the event rail, filters, hover, persistence, export, theme):

```sh
npm install && npm test
```

Regenerate icons after changing the palette:

```sh
npm run icons
```

**When deploying a change, bump `CACHE` in `sw.js`** so installed clients pick it up.

## Chart notes

**The curve is a rate, not a total.** Each line is how many taps per hour / day / week /
month that colour is getting *at that moment*, so it rises and falls and the three cross
one another. This is deliberate: a cumulative running total can only ever climb, which
shows accumulation and hides change — exactly the wrong read for "am I doing this more
or less than I was?". The unit follows the visible span — per hour out to 2 days, per
day to 120, then per week and per month — and is carried by the subtitle
(`peak 27/day`) and the tooltip rather than by a caption on the axis, which is left as
bare numbers.

**How the rate is computed.** A sliding triangular window, half-width `max(span/12,
unit)/2`, sampled every 2px across the plot. The weights are normalised by the
half-width, so a steady stream of *r* taps per unit reads as exactly *r* — the number on
the axis is a real rate, not an arbitrary activity score. The window is fed from the
**whole log**, not just the visible slice, so it is properly full at both edges instead
of dipping to zero wherever the range happens to be cut.

**Nothing is filled or stacked.** No wash under the curves: with three lines that cross,
a fill reads as stacked area and invites adding the values together, which would be
meaningless here. Each curve is one line plus a wide, faint copy behind it for bloom.

Under the curves, the **event rail** keeps the raw data visible: one row per colour
(blue at the bottom, so 1 → 3 reads upward), one tick per tap at its exact time. The
curve answers "how much, and is it changing"; the rail answers "when, exactly".

Hovering or tapping picks the nearest tap by time — aim is x-dominant, with the rail row
only breaking ties, so a finger on the red row picks a red tap. It drops a node on **all
three** curves at that instant, so the tooltip's three numbers are visibly the three
lines, and the subtitle carries the peak rate for the range.

On the 7- and 30-day ranges the subtitle also carries the change against the preceding
window. That delta is **only** shown when the log actually covers the preceding
window — otherwise "up 300%" would just be the history starting.

**Palette: blue, yellow, red**, in that order — button 1 is blue and sits at the bottom
of the rail. Storage is unchanged: clicks are still saved as `b: 1 | 2 | 3`, and the
colour is only how that number is presented.

Two honest caveats about this palette. A true lemon yellow is invisible as a 2px line on
a near-white surface, so the light theme uses a deep gold (`#d4a000`, ~3:1 against the
chart surface) and only the dark theme uses the brighter tone; and white-on-yellow fails
contrast, so the yellow button flips to dark ink on a light badge. Red and yellow also
sit closer together for red-blind viewers than the old blue/orange/aqua set did.

Identity is therefore never carried by colour alone: each rail row is labelled **Red** /
**Yellow** / **Blue** in text, the legend names them beside its per-range counts, the
tooltip names the tapped colour in words, and each pad button exposes its colour in its
accessible name.
