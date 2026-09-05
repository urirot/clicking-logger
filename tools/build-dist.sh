#!/usr/bin/env bash
# Copy just the shipping files into dist/ — keeps deploy tooling, tests and
# node_modules out of whatever gets uploaded.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FILES=(index.html styles.css app.js sw.js manifest.webmanifest icon-192.png icon-512.png)

rm -rf dist
mkdir -p dist
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "missing: $f" >&2; exit 1; }
  cp "$f" dist/
done

echo "dist/ built — $(ls dist | wc -l | tr -d ' ') files, $(du -sh dist | cut -f1) total"
echo "sw.js cache version: $(grep -o 'click-timeline-v[0-9]*' dist/sw.js | head -1)"
