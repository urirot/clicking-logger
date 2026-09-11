#!/usr/bin/env bash
# Build dist-native/ — the web app plus the Capacitor adapter, minus the two
# things that must not ship inside a native binary:
#
#   sw.js                 Capacitor already serves these files locally. A
#                         network-first worker over capacitor://localhost can
#                         pin a stale shell after an app update, and there is
#                         no deploy to bump CACHE against.
#   manifest.webmanifest  PWA install metadata; the store listing replaces it.
#
# The web build (tools/build-dist.sh) is untouched by any of this and still
# ships as plain files with no build step.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT=dist-native
FILES=(index.html styles.css app.js icon-192.png icon-512.png)

rm -rf "$OUT"
mkdir -p "$OUT"
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "missing: $f" >&2; exit 1; }
  cp "$f" "$OUT/"
done

# native.js is the only file that imports anything. Bundle it to an IIFE so the
# page still loads it with a plain <script>, no module graph in the browser.
npx esbuild native.js \
  --bundle --format=iife --target=es2020 --minify \
  --outfile="$OUT/native.bundle.js" \
  --log-level=warning

# Load the adapter before app.js so window.CTD_NATIVE exists by the time app.js
# reads it. Nothing else in index.html differs between web and native.
python3 - "$OUT/index.html" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
tag = '<script src="native.bundle.js"></script>\n<script src="app.js"></script>'
assert s.count('<script src="app.js"></script>') == 1, 'app.js script tag not found'
open(p, 'w').write(s.replace('<script src="app.js"></script>', tag))
PY

echo "$OUT/ built — $(ls "$OUT" | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1) total"
echo "adapter: $(wc -c < "$OUT/native.bundle.js" | tr -d ' ') bytes"
