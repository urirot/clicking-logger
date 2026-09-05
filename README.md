# Click Timeline

A one-page app: tap **blue**, **yellow** or **red** to stamp the current time, then read the whole
log off one picture — one line per colour through its click count per hour or day, over a
rail that keeps every individual tap visible as its own tick.

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
| Hover or tap the chart | bands the period around the nearest tap and gives all three colours' counts for it |
| | a **tap pins** that reading — dismiss it by tapping outside the chart, or `Esc` |
| ↶ | undo the last click — in the top bar, so it is reachable from the pad |
| ◐ | cycles theme: auto → light → dark |
| Export JSON | back the log up, or move it to another device |
| Import JSON | merge a file back in — see **Import merges by day** below |
| Data & backup | the export/import row collapses; the state is remembered |

The buttons carry no numerals — the colour *is* the identity, and the badge on each one
counts **today**. The range chips scope the chart. The Timeline screen is the chart and
an export/import pair, nothing else: no log table, no clear. Undo lives in the
top bar instead, next to the theme toggle, so a mistaken tap can be dropped without
leaving the pad; it greys out when the log is empty.

## Layout

The app is one fixed-height flex column — top bar, a single scroll region (`<main>`),
tab bar — rather than a long page with a floating tab bar over it. The tap screen sizes
itself to that region and so **never scrolls at any viewport height**; the buttons shrink
instead. Only the timeline scrolls, and only inside `<main>`.

One trap that follows: `#panel-tap` sets `display: flex`, and an id selector outranks the
UA's `[hidden] { display: none }`, so a hidden panel stays painted. `styles.css` carries
an explicit `[hidden] { display: none !important }` reset for that, and the smoke test
asserts it is still there — jsdom has no layout, so nothing else would catch it.

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

**The lines are plain counts.** Each one is how many clicks that colour got in each
period — an integer you could arrive at by hand from the log. Nothing is smoothed,
weighted, accumulated or stacked, so the axis only ever shows whole numbers and the
lines rise and fall independently. The period follows the visible span: per hour out to
2 days, per day to 120, then per week and per month. Periods are stepped with `Date`
methods rather than fixed millisecond offsets, so a DST change doesn't drift the
boundaries.

Each period's point sits at its midpoint, clamped so a part-covered first or last period
stays inside the axes. Per-period dots are drawn up to 60 periods, past which they'd be
noise.

**Nothing is filled.** With lines that cross, a wash under them reads as stacked area
and invites adding the values together, which would be meaningless here.

Under the lines, the **event rail** keeps the raw data visible: one row per colour (blue
at the bottom, so 1 → 3 reads upward), one tick per tap at its exact time. The lines
answer "how many, and is it changing"; the rail answers "when, exactly".

Hovering or tapping picks the nearest tap — aim is x-dominant, with the rail row only
breaking ties, so a finger on the red row picks a red tap — then **bands that tap's whole
period** across the plot and drops a node on all three lines, so the tooltip's three
counts are visibly the three lines. The subtitle carries the peak for the range.

**Hover previews, a tap pins.** A pinned reading survives `pointerleave` and is not
dragged around by subsequent hovering; tapping elsewhere on the chart re-pins, and
tapping outside it — or pressing `Esc` — dismisses it. Pinning is what makes the chart
usable on a phone at all: the browser fires `pointerleave` the instant the finger lifts,
so an un-pinned reading vanishes before it can be read.

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
