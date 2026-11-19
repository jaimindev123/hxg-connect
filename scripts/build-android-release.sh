#!/usr/bin/env bash
# Build a signed Android release locally.
#   ./scripts/build-android-release.sh          -> .aab (Play Store / internal testing)
#   ./scripts/build-android-release.sh apk      -> .apk (install directly on a device)
#   ./scripts/build-android-release.sh both
#   ./scripts/build-android-release.sh apk --install   -> also `adb install` the apk
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-aab}"
INSTALL="${2:-}"
PROPS="$ROOT/credentials/android/keystore.properties"

if [[ ! -f "$PROPS" ]]; then
  echo "Missing $PROPS - run ./scripts/create-android-keystore.sh first (or restore your backup)." >&2
  exit 1
fi

echo "==> Regenerating android/ (expo prebuild --clean)"
bunx expo prebuild --platform android --clean --no-install

case "$TARGET" in
  aab)  TASKS=(bundleRelease) ;;
  apk)  TASKS=(assembleRelease) ;;
  both) TASKS=(bundleRelease assembleRelease) ;;
  *) echo "Unknown target '$TARGET' (use aab | apk | both)" >&2; exit 1 ;;
esac

echo "==> ./gradlew ${TASKS[*]}"
(cd android && ./gradlew "${TASKS[@]}")

VERSION="$(node -p "require('./app.json').expo.version")"
STAMP="$(date +%Y%m%d-%H%M)"
OUT="$ROOT/build/android"
mkdir -p "$OUT"

AAB="android/app/build/outputs/bundle/release/app-release.aab"
APK="android/app/build/outputs/apk/release/app-release.apk"
[[ -f "$AAB" && "$TARGET" != apk ]] && cp "$AAB" "$OUT/hxg-connect-$VERSION-$STAMP.aab" && echo "AAB: $OUT/hxg-connect-$VERSION-$STAMP.aab"
if [[ -f "$APK" && "$TARGET" != aab ]]; then
  cp "$APK" "$OUT/hxg-connect-$VERSION-$STAMP.apk"
  echo "APK: $OUT/hxg-connect-$VERSION-$STAMP.apk"
  if [[ "$INSTALL" == "--install" ]]; then
    adb install -r "$APK"
  fi
fi

echo "==> Signature check"
if [[ -f "$AAB" && "$TARGET" != apk ]]; then
  jarsigner -verify -verbose:summary -certs "$AAB" 2>/dev/null | grep -m1 -E 'CN=' || true
fi
