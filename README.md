# HXG Connect mobile (field teams)

Expo SDK 57 (React Native 0.86). Android and iOS from one codebase.

**Screens:** sign in (server address + workspace, so it works before you own a domain), My Day (call through the CRM's click-to-call, WhatsApp, done with a required next step), lead search and lead page (history, notes, call), and selfie check-in.

**Check-in rules:** front camera only and no gallery picker, so old photos can't be used. Location is read only at the moment of check-in (background location, microphone and photo-library permissions are blocked in `app.json`). Android's mock-location flag is sent to the server, which flags the check-in. Without signal, the photo is copied out of the cache into app storage with its original capture time and sent automatically later; the server marks it "sent late" for the manager.

## Run it
```bash
npm install
npx expo start          # scan the QR code with Expo Go on a phone on the same network
npx tsc --noEmit        # type-check
npx expo export --platform android   # production JS bundle (also what CI runs)
```
For store builds use EAS (`npx eas build`), which needs an Expo account. Release builds block plain `http://` by default on Android: point the app at an `https://` server, or add `expo-build-properties` with `usesCleartextTraffic` for internal testing only.

## Not verified yet
Type-checked and bundled for Android, but **not yet run on a real phone or emulator**. Test camera, GPS, offline queue (airplane mode → check in → reconnect) and click-to-call on at least one Android and one iPhone before rollout. Navigation is a simple in-app stack; move to expo-router when the app grows beyond these screens.
