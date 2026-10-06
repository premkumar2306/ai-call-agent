# EchoStrip — mobile app

Expo / React Native client for the EchoStrip de-reverberation backend.
One codebase targets iOS, Android, and web.

```
src/
├── app/                       expo-router routes
│   ├── _layout.tsx            theme provider + stack, audio session setup
│   ├── (tabs)/
│   │   ├── _layout.tsx        Create · History · Settings tab bar
│   │   ├── index.tsx          Create — pick a file, upload, watch it clean
│   │   ├── history.tsx        History — every recording this device has run
│   │   └── settings.tsx       Settings — appearance, server, privacy, clear
│   └── job/[id].tsx           Result — A/B players, benchmarks, matrix, export
├── components/ui.tsx          themed primitives (Card, Pill, Button, …)
└── lib/
    ├── api.ts                 typed backend client + upload with progress
    ├── device.ts              anonymous device id (no accounts)
    ├── theme.tsx              light / dark / system, persisted
    ├── confirm.ts             cross-platform destructive confirmation
    └── format.ts              byte / duration / relative-time formatters
```

## Running it

The backend must be running first (see the repository root README).

```bash
npm install

# A simulator can use localhost; a physical device must reach your machine
# over the LAN, because `localhost` on a phone is the phone itself.
export EXPO_PUBLIC_API_URL=http://192.168.1.20:8000

npx expo start            # then press i / a, or scan the QR code
npx expo start --web      # browser target
```

`EXPO_PUBLIC_API_URL` is inlined at build time, so change it and restart
rather than expecting a running bundler to pick it up.

## Notes

* **No accounts.** `lib/device.ts` generates a UUID on first launch, stores it
  locally, and sends it as `X-Device-Id`. It is not derived from any hardware
  identifier. Clearing app storage orphans the server-side history.
* **Upload progress** uses `XMLHttpRequest`, because `fetch` cannot report it.
  The transfer leg is real progress; the processing leg is server-side with no
  progress channel, so the UI narrates the pipeline's actual stages.
* **Audio** uses `expo-audio`. The root layout sets `playsInSilentMode` so
  playback is audible with an iPhone's ringer switch off.
* **Web caveat:** `Alert.alert` is a no-op under react-native-web, so
  `lib/confirm.ts` routes destructive confirmations to `window.confirm` there.

## Building for the stores

Native binaries need EAS (or a local Xcode/Android Studio build):

```bash
npx eas build --platform ios
npx eas build --platform android
```

No native build has been produced or run in this repository yet — only the
TypeScript and the web target have been exercised.
