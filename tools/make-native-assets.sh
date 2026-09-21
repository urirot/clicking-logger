#!/usr/bin/env bash
# Regenerate every launcher icon and splash screen in ios/ and android/ from the
# three dots, then fix up the one thing @capacitor/assets gets wrong.
#
# Run this after changing the palette or the mark. It is not part of the normal
# build — the generated PNGs are committed, so a clean checkout (or a cloud CI
# runner with no Xcode) builds the right icons without running this at all.
#
# The fix-up: @capacitor/assets writes the adaptive icon's BACKGROUND layer as an
# inset bitmap —
#
#   <background><inset android:drawable="@mipmap/ic_launcher_background"
#                      android:inset="16.7%" /></background>
#
# 16.7% a side maps the art onto the inner 72dp of the 108dp canvas. That is
# right for the foreground, and wrong for the background: the outer 18dp ring
# exists so launchers can pan and scale the layers for parallax and press
# effects, and a background that stops at 72dp shows transparent corners the
# moment one does. A background must be full bleed.
#
# Since ours is a flat colour, @color/ic_launcher_background is both correct and
# six PNGs smaller than the bitmap it replaces.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SURFACE='#1a1a19'   # --surface, the icon's ground
PLANE='#0d0d0d'     # --plane, the app's page background, so launch blends in

python3 tools/make_icons.py

npx --yes @capacitor/assets@3 generate --ios --android \
  --iconBackgroundColor "$SURFACE"   --iconBackgroundColorDark "$SURFACE" \
  --splashBackgroundColor "$PLANE"   --splashBackgroundColorDark "$PLANE" \
  | tail -3

RES=android/app/src/main/res

python3 - "$RES" "$SURFACE" <<'PY'
import glob, os, re, sys
res, surface = sys.argv[1], sys.argv[2]

# The colour the adaptive background resolves to. @capacitor/assets leaves this
# file at its generated #FFFFFF and points the XML at the bitmap instead.
path = f'{res}/values/ic_launcher_background.xml'
with open(path) as f:
    xml = f.read()
xml, n = re.subn(r'(<color name="ic_launcher_background">)[^<]*(</color>)',
                 rf'\g<1>{surface}\g<2>', xml)
assert n == 1, f'ic_launcher_background colour not found in {path}'
open(path, 'w').write(xml)
print(f'{path}  background colour -> {surface}')

# Full-bleed background, inset foreground.
inset = re.compile(
    r'<background>\s*<inset\s+android:drawable="@mipmap/ic_launcher_background"'
    r'\s+android:inset="[\d.]+%"\s*/>\s*</background>', re.S)
for path in sorted(glob.glob(f'{res}/mipmap-anydpi-v26/ic_launcher*.xml')):
    with open(path) as f:
        xml = f.read()
    xml, n = inset.subn(
        '<background android:drawable="@color/ic_launcher_background" />', xml)
    assert n == 1, f'background inset not found in {path}'
    open(path, 'w').write(xml)
    print(f'{path}  background -> full-bleed @color')

# Nothing references the bitmap any more.
for png in sorted(glob.glob(f'{res}/mipmap-*/ic_launcher_background.png')):
    os.remove(png)
    print(f'{png}  removed (superseded by @color)')
PY

echo
echo "Icons and splashes regenerated. Commit ios/ and android/ — a CI build"
echo "without Xcode or the Android SDK still needs them in the tree."
