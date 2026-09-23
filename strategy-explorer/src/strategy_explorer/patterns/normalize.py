"""Scale-invariant channel representation for motif / shapelet discovery.

Absolute prices never enter a pattern. Each bar is described by

* ret    - log return divided by rolling volatility (z-like)
* range  - log of the bar range relative to its prior average
* volume - log of volume relative to its prior average
* body   - signed body position (close - open) / (high - low) in [-1, 1]

All statistics use past data only, so the representation is causal and the
same 10-bar shape is recognised at BTC 10,000 or 100,000.
"""

from __future__ import annotations

import numpy as np

from ..data.market import MarketData
from ..dsl import primitives as P

CHANNELS = ("ret", "range", "volume", "body")


def channel_matrix(md: MarketData, window: int = 50) -> np.ndarray:
    c, o, h, l, v = md.close, md.open, md.high, md.low, md.volume
    r = P.log_returns(c)
    sig = P.lag(P.rolling_std(r, window), 1)
    ret = np.clip(P.safe_div(r, sig), -5, 5)
    rng = P.safe_div(h - l, P.lag(c, 1))
    rng_rel = np.clip(P.log_(P.safe_div(rng, P.lag(P.rolling_mean(rng, window), 1))), -3, 3)
    if md.has_volume:
        vol_rel = np.clip(P.log_(P.safe_div(v + 1e-12, P.lag(P.rolling_mean(v, window), 1))), -4, 4)
    else:
        vol_rel = np.zeros(len(md))
    body = np.clip(P.safe_div(c - o, h - l), -1, 1)
    return np.column_stack([ret, rng_rel, vol_rel, body])


def windows(X: np.ndarray, m: int) -> np.ndarray:
    """(T-m+1, m, C) view of all length-m subsequences (row t ends at bar t+m-1)."""
    from numpy.lib.stride_tricks import sliding_window_view

    if X.shape[0] < m:
        return np.zeros((0, m, X.shape[1]))
    return sliding_window_view(X, (m, X.shape[1]))[:, 0]


def rms_distance_profile(X: np.ndarray, template: np.ndarray) -> np.ndarray:
    """Distance at every end bar t between X[t-m+1..t] and ``template`` (NaN during warm-up)."""
    m = template.shape[0]
    out = np.full(X.shape[0], np.nan)
    W = windows(X, m)
    if W.shape[0]:
        d = np.sqrt(np.mean((W - template[None]) ** 2, axis=(1, 2)))
        out[m - 1:] = d
    return out
