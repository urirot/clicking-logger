#!/usr/bin/env python3
"""Generate the PWA icons (no third-party deps — raw PNG via zlib).

Three dots, one per button, in the app's palette: blue, yellow, red. Laid out
left to right and sized to stay legible when the launcher shrinks them to a
16px favicon, so no lane rules or other detail that would turn to mush.
"""
import struct, zlib

BG = (0x1a, 0x1a, 0x19)
SERIES = [(0x39, 0x87, 0xe5),   # blue   — button 1
          (0xf0, 0xbc, 0x2e),   # yellow — button 2
          (0xef, 0x5a, 0x4d)]   # red    — button 3
CENTRES = (0.235, 0.5, 0.765)   # dot centres, in 0..1 of the icon width
RADIUS = 0.125                  # dot radius, same units
SS = 4                          # supersampling factor per axis, for clean edges


def render(size, path):
    px = bytearray()
    for _ in range(size * size):
        px += bytes(BG)

    r = RADIUS * size
    cy = 0.5 * size
    for (xf, rgb) in zip(CENTRES, SERIES):
        cx = xf * size
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
                i = (y * size + x) * 3
                for k in range(3):
                    px[i + k] = round(px[i + k] * (1 - a) + rgb[k] * a)

    raw = b''.join(b'\x00' + bytes(px[y * size * 3:(y + 1) * size * 3]) for y in range(size))

    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path}  {size}x{size}  {len(png)} bytes')


for s in (192, 512):
    render(s, f'icon-{s}.png')
