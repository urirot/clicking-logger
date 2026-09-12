/* Native adapter — the ONLY file that knows Capacitor exists.
   Bundled by tools/build-native.sh into native.bundle.js and loaded before
   app.js in the native builds. The web build never sees it, which is why
   index.html, styles.css and app.js still run as plain files with no
   dependencies and no build step.

   Everything here is exposed on one global, window.CTD_NATIVE. app.js
   feature-detects that object and falls back to its browser path when it is
   absent, so there is exactly one source tree for web, iOS and Android. */
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Share } from '@capacitor/share';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

if (Capacitor.isNativePlatform()) {
  window.CTD_NATIVE = {
    platform: Capacitor.getPlatform(),

    /* navigator.vibrate is a no-op on iOS, so the pad would feel dead there. */
    haptic() {
      Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    },

    /* A WKWebView ignores <a download> entirely — no file, no error. Write the
       backup into the app's cache directory and hand it to the system share
       sheet instead, which is also the only way to get it off an iPhone. */
    async exportFile(name, text) {
      const { uri } = await Filesystem.writeFile({
        path: name,
        data: text,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      });
      await Share.share({ title: 'Count the Dots backup', url: uri });
    },

    /* Tipping — cordova-plugin-purchase registers itself as a global, so it is
       reached through window.CdvPurchase rather than imported here. Resolved
       lazily because the plugin is not ready until deviceready has fired. */
    tips: null,   // filled in by initTips() below
  };

  initTips();
}

/* ── In-app purchase ───────────────────────────────────────
   Three consumables. Consumable is the right product type for a tip: nothing
   is unlocked, so there is no entitlement to restore and no receipt to
   validate — which is what lets this work with no server and no third-party
   SDK phoning home. "Nothing leaves your device" stays true. */
const TIP_IDS = ['tip_small', 'tip_medium', 'tip_large'];

function initTips() {
  document.addEventListener('deviceready', () => {
    const CdvPurchase = window.CdvPurchase;
    if (!CdvPurchase) return;                 // plugin absent: app.js hides the tip UI

    const { store, ProductType, Platform } = CdvPurchase;
    const platform = window.CTD_NATIVE.platform === 'ios'
      ? Platform.APPLE_APPSTORE
      : Platform.GOOGLE_PLAY;

    store.register(TIP_IDS.map(id => ({ id, type: ProductType.CONSUMABLE, platform })));

    /* A consumable must be finished or the store will refuse to sell it again. */
    store.when()
      .approved(tx => tx.verify())
      .verified(receipt => receipt.finish())
      .finished(() => { window.CTD_NATIVE.onTipPaid?.(); });

    store.initialize([platform]).then(() => {
      const products = TIP_IDS
        .map(id => store.get(id, platform))
        .filter(p => p && p.getOffer());
      if (!products.length) return;           // nothing approved in the console yet

      window.CTD_NATIVE.tips = {
        /* Real localised prices from the store — never hard-code an amount. */
        list: products.map(p => ({ id: p.id, price: p.getOffer().pricingPhases[0].price })),
        buy(id) {
          const offer = store.get(id, platform)?.getOffer();
          return offer ? offer.order() : Promise.reject(new Error('no offer'));
        },
      };
      window.CTD_NATIVE.onTipsReady?.();
    }).catch(() => {});
  }, { once: true });
}
