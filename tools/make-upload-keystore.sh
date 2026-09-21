#!/usr/bin/env bash
# Create the Play upload key, once, and wire Gradle to it.
#
# Read this before running it. Under Play App Signing, Google generates and holds
# the key that actually signs what users install; this script makes the *upload*
# key, which only proves to Google that an upload came from you. That distinction
# is the good news — an upload key can be reset by Google support if it is ever
# lost, whereas the app signing key cannot. But the reset takes days and blocks
# every release until it clears, so treat this file as irreplaceable anyway.
#
# It is written outside the repo on purpose. A keystore committed to a public
# GitHub repo is a keystore you have to ask Google to revoke.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STORE_DIR="${CTD_KEYSTORE_DIR:-$HOME/.countthedots}"
STORE="$STORE_DIR/upload-keystore.jks"
ALIAS=upload
PROPS=android/keystore.properties

if [[ -e "$STORE" ]]; then
  echo "A keystore already exists at:"
  echo "  $STORE"
  echo
  echo "Refusing to overwrite it. If you have already uploaded a build signed"
  echo "with this key, replacing it means a Google support ticket to reset the"
  echo "upload key before you can release again. Move it aside by hand if you"
  echo "are certain it was never used." >&2
  exit 1
fi

command -v keytool >/dev/null || { echo "keytool not found — install a JDK" >&2; exit 1; }

echo "Creating the Play upload key for click.countthedots.app"
echo
echo "Choose a password you can retrieve in twenty years. Put it in your password"
echo "manager NOW, before you type it — there is no recovery from a lost password,"
echo "only a support ticket."
echo
read -rsp "Keystore password: " PW; echo
read -rsp "Again: " PW2; echo
[[ "$PW" == "$PW2" ]] || { echo "Passwords differ." >&2; exit 1; }
[[ ${#PW} -ge 12 ]] || { echo "Use at least 12 characters." >&2; exit 1; }

mkdir -p "$STORE_DIR"
chmod 700 "$STORE_DIR"

# RSA 2048 is Play's minimum. 10000 days clears Google's requirement that an
# upload key stay valid well past 2033; a key that expires mid-life is a release
# outage with no quick fix.
keytool -genkeypair \
  -keystore "$STORE" -storetype PKCS12 \
  -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PW" -keypass "$PW" \
  -dname "CN=Count the Dots, OU=Count the Dots, O=Count the Dots, C=IL"

chmod 600 "$STORE"

# Gradle reads this; .gitignore keeps it out of the repo. Same four values are
# what CI wants in its environment, as CTD_KEYSTORE_* / CTD_KEY_*.
umask 077
cat > "$PROPS" <<EOF
storeFile=$STORE
storePassword=$PW
keyAlias=$ALIAS
keyPassword=$PW
EOF

echo
echo "Keystore   $STORE"
echo "Gradle     $PROPS  (gitignored)"
echo
keytool -list -v -keystore "$STORE" -storepass "$PW" -alias "$ALIAS" \
  | sed -n '/Certificate fingerprints/,/SHA256/p'
echo
echo "To build on CI instead, add these repository secrets:"
echo "  CTD_KEYSTORE_BASE64    $(base64 < "$STORE" | tr -d '\n' | cut -c1-24)…  (full value below)"
echo "  CTD_KEYSTORE_PASSWORD  the password you just chose"
echo "  CTD_KEY_ALIAS          $ALIAS"
echo "  CTD_KEY_PASSWORD       the same password"
echo
echo "Full base64 of the keystore, for CTD_KEYSTORE_BASE64:"
echo
base64 < "$STORE" | tr -d '\n'
echo
