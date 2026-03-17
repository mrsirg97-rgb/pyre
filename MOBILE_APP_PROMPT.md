# Pyre World — Solana Seeker Mobile App

## Goal

Build a mobile-first Pyre World app as a Trusted Web Activity (TWA) targeting Solana Seeker devices. The app wraps the existing Next.js frontend (`packages/app`) with Solana Mobile Wallet Adapter (MWA) support for native wallet signing on Android.

## Reference Implementation

`~/Projects/burnfun` has a working TWA setup for Torch Market:

### Key files to reference:
- `burnfun/twa/twa-manifest.json` — TWA configuration (package ID, host, theme, signing key)
- `burnfun/twa/` — Full Android TWA project (gradle, keystore, build scripts)
- `burnfun/packages/app/src/app/providers.tsx` — Solana Mobile Wallet Adapter integration

### MWA Integration Pattern (from burnfun):
```typescript
import {
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
  registerMwa,
} from '@solana-mobile/wallet-standard-mobile'

// Only register on Android mobile (not desktop — would shadow Phantom etc.)
if (isAndroidMobile()) {
  registerMwa({
    appIdentity: {
      name: 'Pyre World',
      uri: getUriForAppIdentity(),
      icon: '/apple-touch-icon.png',
    },
    authorizationCache: createDefaultAuthorizationCache(),
    chains: ['solana:mainnet', 'solana:devnet'],
    chainSelector: createDefaultChainSelector(),
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  })
}
```

### Dependencies needed:
```json
"@solana-mobile/wallet-standard-mobile": "^0.4.4"
```

## Architecture

The Pyre mobile app is NOT a separate React Native app. It's a TWA (Trusted Web Activity) — an Android wrapper around the existing Next.js web app at `pyre.world`. This means:

1. **No code duplication** — the TWA just loads the web app in a Chrome Custom Tab with full-screen display
2. **Same codebase** — all features from `packages/app` work on mobile automatically
3. **Native wallet support** — MWA enables signing with Solana Seeker's native wallet (no browser extension needed)
4. **Ephemeral controller** — the browser agent's controller keypair (IndexedDB) works in the TWA context, so after initial wallet setup, no more wallet popups per action

## What needs to happen

### 1. Add MWA to the Pyre frontend (`packages/app`)

Update `packages/app/src/app/providers.tsx` to register MWA on Android, following the burnfun pattern. The wallet adapter already works — just need to add the mobile registration so Seeker's native wallet appears as an option.

### 2. Create the TWA project

Create `packages/app/twa/` with:
- `twa-manifest.json` — pointing to `pyre.world`, package ID `world.pyre.twa`
- Android project (gradle, keystore) — use `bubblewrap-cli` to generate
- Build scripts for APK/AAB generation

### 3. PWA manifest

Ensure `packages/app/public/manifest.json` has proper PWA metadata:
- `name: "Pyre World"`
- `short_name: "Pyre"`
- `display: "standalone"`
- `theme_color` / `background_color` matching the dark theme
- App icons (192x192, 512x512)

### 4. Mobile UX considerations

The existing frontend already works on Phantom mobile browser. Key things to verify in the TWA:
- **Controller setup flow** — generate keypair, display pubkey for funding, link to stronghold. This should work as-is since it uses IndexedDB.
- **Tick button** — the game controller UX (tick, auto-play intervals) should work well on mobile with touch targets
- **Model loading** — WebGPU/WebLLM may not be available on all Seeker devices. RNG fallback is fine.
- **Stage feed** — the live activity feed should scroll smoothly on mobile
- **Agent panel** — the log console should be scrollable and not interfere with the rest of the UI

### 5. App signing

Generate a signing keystore for the Pyre TWA:
```bash
keytool -genkey -v -keystore pyre.keystore -alias android -keyalg RSA -keysize 2048 -validity 10000
```

## TWA vs React Native

We chose TWA because:
- **Zero code duplication** — same Next.js app, same components, same hooks
- **Instant updates** — deploy to Vercel, TWA picks up changes immediately
- **Full web API access** — WebGPU, IndexedDB, WebSocket all work
- **Solana wallet standard** — MWA integrates through the same wallet adapter the desktop app uses
- **Simpler maintenance** — one codebase, not two

The only downside: no access to native APIs (push notifications require service worker, no camera/sensors). For a faction warfare game, this doesn't matter.

## Build & Deploy

```bash
# Generate TWA project (one-time)
npx @nicolo-ribaudo/bubblewrap init --manifest https://pyre.world/manifest.json

# Build APK
cd twa && ./gradlew assembleRelease

# Sign
jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 -keystore pyre.keystore app-release-unsigned.apk android
zipalign -v 4 app-release-unsigned.apk pyre-release.apk

# Install on Seeker
adb install pyre-release.apk
```

## Digital Asset Links

For the TWA to display without the URL bar, `pyre.world` needs a `/.well-known/assetlinks.json`:
```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "world.pyre.twa",
    "sha256_cert_fingerprints": ["<SHA256 from keystore>"]
  }
}]
```

Add this to `packages/app/public/.well-known/assetlinks.json`.
