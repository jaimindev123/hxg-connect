#!/usr/bin/env bash
# One-time: generate the Android upload/release keystore + credentials/android/keystore.properties.
# Override defaults with env vars: KEY_ALIAS, KEYSTORE_PASSWORD, KEY_DNAME.
# BACK UP the generated folder somewhere safe (password manager). Losing it = you can't update the app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/credentials/android"
KEYSTORE="$DIR/release.keystore"
PROPS="$DIR/keystore.properties"

KEY_ALIAS="${KEY_ALIAS:-hxg-connect-upload}"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)}"
KEY_DNAME="${KEY_DNAME:-CN=HXG Connect, OU=Mobile, O=HXG Global, C=IN}"

if [[ -f "$KEYSTORE" || -f "$PROPS" ]]; then
  echo "Refusing to overwrite existing $DIR contents. Delete them manually if you really want a new key." >&2
  exit 1
fi

mkdir -p "$DIR"
chmod 700 "$DIR"

# PKCS12 keystores use one password for store and key.
keytool -genkeypair -v \
  -storetype PKCS12 \
  -keystore "$KEYSTORE" \
  -alias "$KEY_ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$KEYSTORE_PASSWORD" -keypass "$KEYSTORE_PASSWORD" \
  -dname "$KEY_DNAME"

cat > "$PROPS" <<EOF
# Gitignored. Read by android/app/build.gradle (via plugins/withAndroidReleaseSigning.js).
storeFile=release.keystore
storePassword=$KEYSTORE_PASSWORD
keyAlias=$KEY_ALIAS
keyPassword=$KEYSTORE_PASSWORD
EOF
chmod 600 "$KEYSTORE" "$PROPS"

echo
echo "Created $KEYSTORE"
echo "Created $PROPS"
echo "SHA-1 / SHA-256 fingerprints:"
keytool -list -v -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASSWORD" -alias "$KEY_ALIAS" | grep -E 'SHA1|SHA256'
