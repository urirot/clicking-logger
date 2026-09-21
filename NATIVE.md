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

## Prerequisites

Neither IDE is installed on this machine. They are not equally necessary.

**Android needs no IDE.** Android Studio is ~1.5 GB of editor around a toolchain
Gradle can drive on its own. The command-line SDK is enough:

```sh
brew install --cask android-commandlinetools
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
echo "sdk.dir=$(brew --prefix)/share/android-commandlinetools" > android/local.properties
cd android && ./gradlew bundleRelease        # -> app/build/outputs/bundle/release/*.aab
```

A JDK is already present (Homebrew OpenJDK 26).

**iOS needs Xcode, or a Mac that has it.** Apple permits no other way to compile
and sign an iOS binary. Either install the full Xcode (free, ~20 GB, App Store),
or build on a hosted macOS runner — this repo is public, so GitHub Actions'
macOS runners are free for it; Codemagic gives 500 free macOS minutes a month.

Install Xcode anyway if you can spare the download. The simulator is how you take
the required screenshots, and a StoreKit configuration file (below) lets you test
the entire tip flow locally before either console has a product in it — neither of
which a cloud runner gives you.

**CocoaPods is not required** — Capacitor 8 uses Swift Package Manager.

**Expo is not an option here.** EAS Build targets React Native; Count the Dots is
plain HTML/CSS/JS in a WKWebView. Adopting it would mean rewriting the app, which
is the thing Capacitor was chosen to avoid.

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

## In-app purchase — the tip jar

The code is done and tested. What is left is console work and one Xcode step.

### Testing it before either console has a product

`nudgeArmed` stays `false` until a real, purchasable product comes back from the
store, so **the 50-click dialog never appears in a fresh build**. That guard is
deliberate — it is what stops a half-configured build showing anyone a dead donate
button — but it also means you cannot see the feature at all until a store answers.

`ios/App/App/Products.storekit` removes that wait. It declares the three
consumables locally, so StoreKit answers `store.initialize()` from the file instead
of the network and the whole flow works with nothing created in App Store Connect:

Both steps are already wired, so there is nothing to click: the file is in the
project (in no target — it must never reach the binary), and the **shared scheme**
at `App.xcodeproj/xcshareddata/xcschemes/App.xcscheme` sets
`StoreKitConfigurationFileReference` on its Launch action. Open the project and press
Run.

It has to be a *debugger* launch. `xcrun simctl launch` cannot apply a StoreKit
configuration — there is no simctl flag for it — so an app installed that way asks
the real store, gets `0 product(s) and 3 invalid identifier(s)` back, and correctly
leaves the nudge disarmed.

Prices there are `0.99` / `2.99` / `5.99`, default `tip_medium`. Those are a
placeholder for the local test — the real prices are whatever you set in the
consoles — but they are also a reasonable answer to a dialog whose copy says
"throw a coin in", so they are worth keeping unless you decide otherwise.

To watch the failure paths, Xcode's **Debug → StoreKit** menu forces errors, and
`_failTransactionsEnabled` in the file makes every purchase fail. The app should
toast "Could not reach the store" and leave the nudge armed for next time.

Android has no local equivalent. Testing a real purchase there needs a signed
build already uploaded to a track plus a licence tester account, which is one more
reason the closed test wants starting early.

### Console setup

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

Play has historically refused to create in-app products before a build containing the
Billing library exists on some track, so upload the closed-test AAB first.

**2. Sign Apple's Paid Applications Agreement** and complete banking + W-8BEN.
**Nothing can sell until this is active, and it can take days.** Do it first.

**3. Apply to Apple's Small Business Program** — 15% commission instead of 30% under
$1M/yr. Google applies the reduced rate automatically on the first $1M.

Consumables need no receipt validation and no entitlement restore, which is why there is
no backend and no third-party SDK. RevenueCat was deliberately rejected here: it would
make the app phone home, contradicting *"nothing leaves your device"*.

One thing IAP buys that Ko-fi could not: the app now **knows** when a tip completed, so
someone who has paid is never asked again. Backing out of the purchase sheet counts only
as "later".

## Icons and splash screens

`tools/make-native-assets.sh` regenerates every size in `ios/` and `android/` from
the three dots. Run it after a palette or mark change; the output is committed, so a
clean checkout — or a CI runner with no Xcode and no Android SDK — builds the right
icons without running it.

It patches one thing `@capacitor/assets` gets wrong. That tool writes the adaptive
icon's *background* layer as `<inset android:inset="16.7%">`, which stops the
background at the inner 72dp of the 108dp canvas. The outer 18dp ring exists so
launchers can pan and scale the layers, and a background that stops short shows
transparent corners the moment one does. The script swaps it for a full-bleed
`@color`, which is also six PNGs smaller.

The *foreground* keeps that inset, and `make_icons.py` therefore does **not** scale
the art down as well — 16.7% a side already is the safe zone, and scaling twice left
the Android icon visibly smaller than the iOS one. At full bleed the outermost dot
edge lands 28.1dp from centre, inside the 33dp guaranteed circle.

## Still to do before submission

- [x] Platform icon sets and splash screens — `tools/make-native-assets.sh`
- [x] Privacy policy — `privacy.html`, shipped by `tools/build-dist.sh`, served at
      `https://app.countthedots.click/privacy.html`. **Replace the contact email
      placeholder in it before submitting.**
- [x] `PrivacyInfo.xcprivacy` for the App target — Capacitor ships one for the
      framework only, and no plugin ships one at all
- [x] Android release signing config — `tools/make-upload-keystore.sh`, then
      `./gradlew bundleRelease`
- [ ] **Run `tools/make-upload-keystore.sh`** and save the password. Not yet done.
- [x] `Products.storekit` and `PrivacyInfo.xcprivacy` added to the Xcode project —
      the manifest is in the target and ships in the bundle, the StoreKit file is in
      no target and does not. Verified against a built `App.app`.
- [x] Shared scheme with the StoreKit configuration wired to its Launch action
- [ ] Screenshots — 6.7" iPhone, plus an Android phone
- [ ] Privacy labels: **Data Not Collected** on both. Still true — IAP is processed
      by the store, not the app.
- [ ] Set the store listing name to `Count the Dots: Tally Counter` — not the bundle
      display name
- [ ] Create the three IAP products in both consoles

## Tests

`npm test` is green, including the native branches: the smoke test can install a
stub `window.CTD_NATIVE` before `app.js` runs, and asserts that export goes through
the share sheet rather than an `<a download>`, that a tap fires one haptic, that the
tip control is a button showing the store's own price on native and still a link on
the web, and that a completed purchase stops the asking while backing out of the
sheet does not.

(The 14 failures this branch used to document were a stale test, not a broken app,
and were fixed in `eea88b5`.)
