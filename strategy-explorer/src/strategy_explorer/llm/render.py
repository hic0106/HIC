"""Dependency-free candlestick + volume chart rasteriser (PNG) for the visual path."""

from __future__ import annotations

import struct
import zlib

import numpy as np

from ..data.market import MarketData

BG = (13, 17, 23)
GRID = (33, 38, 45)
UP = (38, 166, 154)
DOWN = (239, 83, 80)
VOL_UP = (38, 110, 104)
VOL_DOWN = (150, 60, 58)
SHADE = (40, 44, 52)
MARK = (240, 185, 11)


def encode_png(px: np.ndarray) -> bytes:
    h, w, _ = px.shape
    raw = b"".join(b"\x00" + px[y].astype(np.uint8).tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


class Canvas:
    def __init__(self, w: int, h: int, bg=BG):
        self.w, self.h = w, h
        self.px = np.empty((h, w, 3), dtype=np.uint8)
        self.px[:] = bg

    def rect(self, x0: float, y0: float, x1: float, y1: float, color) -> None:
        xa, xb = sorted((int(round(x0)), int(round(x1))))
        ya, yb = sorted((int(round(y0)), int(round(y1))))
        xa, xb = max(0, xa), min(self.w - 1, xb)
        ya, yb = max(0, ya), min(self.h - 1, yb)
        if xa <= xb and ya <= yb:
            self.px[ya:yb + 1, xa:xb + 1] = color


def render_candles(md: MarketData, start: int, stop: int, width: int = 640, height: int = 400,
                   marker: int | None = None, shade_from: int | None = None) -> bytes:
    """Bars [start, stop). ``marker`` draws a vertical line at a bar; bars >= ``shade_from`` get a grey background."""
    start, stop = max(0, start), min(len(md), stop)
    n = max(1, stop - start)
    cv = Canvas(width, height)
    pad = 6
    price_h = int(height * 0.72)
    vol_top = price_h + 8
    o, h, l, c, v = (a[start:stop] for a in (md.open, md.high, md.low, md.close, md.volume))
    lo, hi = float(np.min(l)), float(np.max(h))
    span = max(hi - lo, hi * 1e-6)
    vmax = float(np.max(v)) if md.has_volume and np.max(v) > 0 else 1.0
    cw = (width - 2 * pad) / n
    for gy in range(1, 4):
        y = pad + (price_h - 2 * pad) * gy / 4
        cv.rect(pad, y, width - pad, y, GRID)
    if shade_from is not None and shade_from < stop:
        xs = pad + (max(shade_from, start) - start) * cw
        cv.rect(xs, 0, width - 1, height - 1, SHADE)

    def py(p: float) -> float:
        return pad + (hi - p) / span * (price_h - 2 * pad)

    body_w = max(1.0, cw * 0.7)
    for i in range(n):
        x = pad + i * cw + cw / 2
        up = c[i] >= o[i]
        col = UP if up else DOWN
        cv.rect(x, py(h[i]), x, py(l[i]), col)
        y0, y1 = py(max(o[i], c[i])), py(min(o[i], c[i]))
        cv.rect(x - body_w / 2, y0, x + body_w / 2, max(y1, y0 + 1), col)
        if md.has_volume:
            vh = (height - vol_top - pad) * float(v[i]) / vmax
            cv.rect(x - body_w / 2, height - pad - vh, x + body_w / 2, height - pad, VOL_UP if up else VOL_DOWN)
    if marker is not None and start <= marker < stop:
        x = pad + (marker - start) * cw + cw / 2
        cv.rect(x, 0, x, height - 1, MARK)
    return encode_png(cv.px)
