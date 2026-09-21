#!/usr/bin/env python3
"""Generate every icon and splash the three targets need (no third-party deps —
raw PNG via zlib).

Three dots, one per button, in the app's palette: blue, yellow, red. Laid out
left to right and sized to stay legible when the launcher shrinks them to a
16px favicon, so no lane rules or other detail that would turn to mush.

The splash is drawn at a reduced scale rather than cropped: the 2732² square is
centre-cropped to fill whatever aspect the device has, and the narrowest common
crop keeps about 46% of the width, so the mark has to sit well inside that.

The Android adaptive foreground is *not* scaled down, even though the dots span
78% of the canvas and the mask only guarantees the centre 66%. @capacitor/assets
already wraps the foreground in `<inset android:inset="16.7%">`, which maps the
art onto the inner 72dp of the 108dp canvas — exactly the safe zone. Scaling here
as well would shrink it twice and leave the Android icon noticeably smaller than
the iOS one. At full bleed the outermost dot edge lands 28.1dp from centre,
inside the 33dp guaranteed circle.
"""
import struct, zlib

BG = (0x1a, 0x1a, 0x19)         # --surface, the icon's own ground
PLANE = (0x0d, 0x0d, 0x0d)      # --plane, the app's page background
SERIES = [(0x39, 0x87, 0xe5),   # blue   — button 1
          (0xf0, 0xbc, 0x2e),   # yellow — button 2
          (0xef, 0x5a, 0x4d)]   # red    — button 3
CENTRES = (0.235, 0.5, 0.765)   # dot centres, in 0..1 of the icon width
RADIUS = 0.125                  # dot radius, same units
SS = 4                          # supersampling factor per axis, for clean edges


def render(size, path, *, scale=1.0, bg=BG, alpha=False):
    """Draw the three dots at `scale` about the centre.

    `alpha=True` emits colour type 6 (RGBA) on a transparent ground, which is
    what an Android adaptive foreground has to be. Everything else stays colour
    type 2 (no alpha) — Apple rejects a store icon that carries an alpha channel.
    """
    stride = 4 if alpha else 3
    px = bytearray()
    for _ in range(size * size):
        px += bytes((0, 0, 0, 0)) if alpha else bytes(bg)

    r = RADIUS * scale * size
    cy = 0.5 * size
    for (xf, rgb) in zip(CENTRES, SERIES):
        cx = (0.5 + (xf - 0.5) * scale) * size
        lo_y, hi_y = int(cy - r - 2), int(cy + r + 2) + 1
        lo_x, hi_x = int(cx - r - 2), int(cx + r + 2) + 1
        for y in range(max(0, lo_y), min(size, hi_y)):
            for x in range(max(0, lo_x), min(size, hi_x)):
                # coverage by supersampling — exact enough, and dependency-free
                hit = 0
                for sy in range(SS):
                    py = y + (sy + 0.5) / SS
                    for sx in range(SS):
                        pxx = x + (sx + 0.5) / SS
                        if (pxx - cx) ** 2 + (py - cy) ** 2 <= r * r:
                            hit += 1
                if not hit:
                    continue
                a = hit / (SS * SS)
                i = (y * size + x) * stride
                if alpha:
                    # Non-premultiplied: the dot's own colour, coverage as alpha.
                    px[i:i + 3] = bytes(rgb)
                    px[i + 3] = round(a * 255)
                else:
                    for k in range(3):
                        px[i + k] = round(px[i + k] * (1 - a) + rgb[k] * a)

    row = size * stride
    raw = b''.join(b'\x00' + bytes(px[y * row:(y + 1) * row]) for y in range(size))

    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6 if alpha else 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path}  {size}x{size}  {len(png)} bytes')


def flat(size, path, rgb):
    """A solid field — the Android adaptive background layer."""
    render(size, path, scale=0.0, bg=rgb)


# 192/512 ship in the web app; 1024 is the App Store / Play listing icon.
for s in (192, 512, 1024):
    render(s, f'icon-{s}.png')

# assets/ is the source tree @capacitor/assets expands into every platform size.
# It is generated, not authored — regenerate rather than edit by hand.
import os
os.makedirs('assets', exist_ok=True)

render(1024, 'assets/icon.png')                            # iOS app icon, no alpha
render(1024, 'assets/icon-foreground.png', alpha=True)     # see the note on inset above
flat(1024, 'assets/icon-background.png', BG)

# Splash sits on --plane so the launch image blends into the app's own page
# background rather than flashing a different shade at startup. Light and dark
# are the same file: the app is dark in both, and its light theme still opens
# on a dark launch screen for the same reason.
render(2732, 'assets/splash.png', scale=0.33, bg=PLANE)
render(2732, 'assets/splash-dark.png', scale=0.33, bg=PLANE)
