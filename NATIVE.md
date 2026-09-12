# Shipping to the App Store and Google Play

The web app is unchanged by any of this. `tools/build-dist.sh` still emits the same
seven files with no build step, and `index.html`, `styles.css` and `app.js` still run
as plain files opened from disk. Everything native is additive.

## How the one source tree serves three targets

```
native.js            the ONLY file that imports Capacitor. Bundled to an IIFE and
                     loaded before app.js in the native builds; sets window.CTD_NATIVE
app.js               unchanged for web. Four native branches, all behind `NATIVE`
tools/build-native.sh  builds dist-native/ — web files + adapter, minus sw.js
capacitor.config.json  appId click.countthedots.app, webDir dist-native
ios/ android/        generated projects, with hand-edited config (see below)
```

`app.js` reads `window.CTD_NATIVE` once into `NATIVE`. On the web it is `null` and every
branch falls through to the code that was already there.

## Prerequisites (not installed on this machine)

```sh
xcode-select --install                    # you have CLT only; the full Xcode is needed
# Install Xcode from the App Store, then:
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

**CocoaPods is not required** — Capacitor 8 uses Swift Package Manager.

For Android, install Android Studio; it brings its own SDK and JDK.

## Build and run

```sh
npm install
npm run ios        # builds, syncs, opens Xcode
npm run android    # builds, syncs, opens Android Studio
```

`npm run sync` after any change to `app.js`, `styles.css`, `index.html` or `native.js` —
the native projects hold *copies*, so an edit is invisible until you sync.

## What was changed, and why

| Change | Reason |
|---|---|
| Export goes through the share sheet | `a.download` is a **silent no-op in a WKWebView** — no file, no error. Export is the app's entire backup story. |
| Haptics on tap | `navigator.vibrate` does nothing on iOS; the pad would feel dead. |
| Service worker skipped on native | Capacitor already serves the files locally. A network-first worker over `capacitor://localhost` can pin a stale shell after an app update, with no deploy to bump `CACHE` against. |
| Tip jar → in-app purchase | The Ko-fi link is permitted on the US storefront only; everywhere else it violates guideline 3.1.1. IAP tipping is explicitly allowed. |
| Portrait lock | Matches `manifest.webmanifest` and the fixed-height layout. |
| `CFBundleDisplayName` = `Dots` | Short name under the icon; the keyword-bearing name is the *store listing*, a separate field. |
| `ITSAppUsesNonExemptEncryption = false` | Skips the export-compliance questionnaire on every upload. |
| `icon-1024.png` | Store listing icon. Colour type 2, no alpha, as Apple requires. |

## In-app purchase — remaining setup

The code is done. The consoles are not.

**1. Create three consumable products** in App Store Connect and Play Console with
exactly these IDs:

```
tip_small    tip_medium    tip_large
```

Only `tip_medium` is wired to the button today (`TIP_DEFAULT` in `app.js`). The other
two are registered so that offering a choice later needs no console work. Note the
README's argument against three amounts was specific to Ko-fi, which picks the amount on
its own page — with IAP the app knows the real localised prices, so that reasoning no
longer applies and a three-amount dialog would now be honest.

**2. Sign Apple's Paid Applications Agreement** and complete banking + W-8BEN.
**Nothing can sell until this is active, and it can take days.** Do it first.

**3. Apply to Apple's Small Business Program** — 15% commission instead of 30% under
$1M/yr. Google applies the reduced rate automatically on the first $1M.

Until a real purchasable product comes back from the store, `nudgeArmed` stays `false`
and **the dialog never appears** — the same guard the Ko-fi build used, so a
half-configured build cannot show anyone a dead button.

Consumables need no receipt validation and no entitlement restore, which is why there is
no backend and no third-party SDK. RevenueCat was deliberately rejected here: it would
make the app phone home, contradicting *"nothing leaves your device"*.

One thing IAP buys that Ko-fi could not: the app now **knows** when a tip completed, so
someone who has paid is never asked again. Backing out of the purchase sheet counts only
as "later".

## Still to do before submission

- [ ] Generate platform icon sets: `npx @capacitor/assets generate --iconBackgroundColor '#1a1a19'` from `icon-1024.png`
- [ ] Splash screens (same tool)
- [ ] Screenshots — 6.7" iPhone, plus Android phone
- [ ] Privacy policy URL — add `/privacy` to the countthedots.click repo; both stores require one
- [ ] Privacy labels: **Data Not Collected** on both. Still true — IAP is processed by the store, not the app.
- [ ] Verify Capacitor ships `PrivacyInfo.xcprivacy` (required since 2024; UserDefaults is a "required reason" API)
- [ ] Set the store listing name to `Count the Dots: Tally Counter` — not the bundle display name

## Known issue, pre-existing

`npm test` fails 14 assertions on `main` and on this branch **identically** — this work
introduced none of them. They are all in the chart hover/pin area ("lights exactly that
period's taps", "a quiet period still answers"). Worth fixing before shipping, since the
chart interaction is a core feature, but it is a separate change.
