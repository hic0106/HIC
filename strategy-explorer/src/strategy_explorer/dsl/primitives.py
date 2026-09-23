"""Raw, causal array primitives.

Every function returns an array aligned with its inputs where element ``t`` uses
only information available at the close of bar ``t``. Rolling windows include
the current bar unless stated otherwise ("prior n bars" = bars t-n .. t-1).
Warm-up values are NaN. Booleans are float arrays holding 1.0 / 0.0 / NaN
(three-valued logic: NaN = unknown, which never produces a trading signal).

All price-derived outputs are scale invariant (returns, ratios, ranks,
ATR-normalised distances) unless they carry an absolute unit such as ``price``.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..util import DAY_MS

NAN = np.nan
EPS = 1e-12
VOL_EPS = 1e-12


def _roll(x: np.ndarray, n: int):
    n = int(n)
    return pd.Series(np.asarray(x, dtype=np.float64), copy=False).rolling(n, min_periods=n)


def safe_div(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    out = np.full(np.broadcast(a, b).shape, NAN)
    ok = np.isfinite(a) & np.isfinite(b) & (np.abs(b) > EPS)
    np.divide(a, b, out=out, where=ok)
    return out


def finite(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    return np.where(np.isfinite(x), x, NAN)


# ------------------------------------------------------------ generic transforms


def lag(x: np.ndarray, n: int) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    n = int(n)
    out = np.full(x.shape[0], NAN)
    if n <= 0:
        return x.copy()
    if n < x.shape[0]:
        out[n:] = x[:-n]
    return out


def rolling_mean(x, n):
    return _roll(x, n).mean().to_numpy()


def rolling_std(x, n):
    return _roll(x, max(2, int(n))).std(ddof=1).to_numpy()


def rolling_max(x, n):
    return _roll(x, n).max().to_numpy()


def rolling_min(x, n):
    return _roll(x, n).min().to_numpy()


def rolling_sum(x, n):
    return _roll(x, n).sum().to_numpy()


def rolling_quantile(x, n, q):
    return _roll(x, n).quantile(float(q)).to_numpy()


def rank(x, n):
    """Percentile rank (0, 1] of the current value within the last n values."""
    return _roll(x, n).rank(pct=True).to_numpy()


def zscore(x, n):
    m = rolling_mean(x, n)
    s = rolling_std(x, n)
    tol = 1e-12 * np.maximum(np.abs(m), 1e-12)
    out = np.full(len(m), NAN)
    ok = np.isfinite(s) & (s > tol)
    np.divide(np.asarray(x, dtype=np.float64) - m, s, out=out, where=ok)
    return out


def slope(x, n):
    """OLS slope per bar over the last n values (linear FIR filter, NaN if any value missing)."""
    n = max(2, int(n))
    x = np.asarray(x, dtype=np.float64)
    out = np.full(x.shape[0], NAN)
    if x.shape[0] >= n:
        k = np.arange(n, dtype=np.float64) - (n - 1) / 2.0
        w = k / np.sum(k * k)
        out[n - 1:] = np.convolve(x, w[::-1], mode="valid")
    return out


def correlation(x, y, n):
    a = pd.Series(np.asarray(x, dtype=np.float64), copy=False)
    b = pd.Series(np.asarray(y, dtype=np.float64), copy=False)
    r = a.rolling(int(n), min_periods=int(n)).corr(b).to_numpy()
    r = finite(r)
    return np.clip(r, -1.0, 1.0)


def ratio(x, y):
    return safe_div(x, y)


def difference(x, y):
    return np.asarray(x, dtype=np.float64) - np.asarray(y, dtype=np.float64)


def log_(x):
    x = np.asarray(x, dtype=np.float64)
    out = np.full(x.shape[0], NAN)
    np.log(x, out=out, where=x > 0)
    return out


def abs_(x):
    return np.abs(np.asarray(x, dtype=np.float64))


# ------------------------------------------------------------------- logic


def _cmp(a, b, fn) -> np.ndarray:
    a = np.asarray(a, dtype=np.float64)
    b = np.broadcast_to(np.asarray(b, dtype=np.float64), a.shape)
    res = fn(a, b).astype(np.float64)
    res[np.isnan(a) | np.isnan(b)] = NAN
    return res


def gt(a, b):
    return _cmp(a, b, np.greater)


def lt(a, b):
    return _cmp(a, b, np.less)


def and_(*xs):
    X = np.vstack([np.asarray(x, dtype=np.float64) for x in xs])
    zero = (X == 0.0).any(axis=0)
    unknown = np.isnan(X).any(axis=0)
    return np.where(zero, 0.0, np.where(unknown, NAN, 1.0))


def or_(*xs):
    X = np.vstack([np.asarray(x, dtype=np.float64) for x in xs])
    one = (X == 1.0).any(axis=0)
    unknown = np.isnan(X).any(axis=0)
    return np.where(one, 1.0, np.where(unknown, NAN, 0.0))


def not_(x):
    return 1.0 - np.asarray(x, dtype=np.float64)


def cross_above(a, b):
    a = np.asarray(a, dtype=np.float64)
    b_arr = np.broadcast_to(np.asarray(b, dtype=np.float64), a.shape)
    now = gt(a, b_arr)
    prev = _cmp(lag(a, 1), lag(np.array(b_arr), 1), np.less_equal)
    return and_(now, prev)


def cross_below(a, b):
    a = np.asarray(a, dtype=np.float64)
    b_arr = np.broadcast_to(np.asarray(b, dtype=np.float64), a.shape)
    now = lt(a, b_arr)
    prev = _cmp(lag(a, 1), lag(np.array(b_arr), 1), np.greater_equal)
    return and_(now, prev)


def was(b, n):
    """1 if the condition was true on any of the last n bars (incl. current)."""
    return _roll(b, n).max().to_numpy()


def held(b, n):
    """1 if the condition was true on all of the last n bars (incl. current)."""
    return _roll(b, n).min().to_numpy()


def count_true(b, n):
    return _roll(b, n).sum().to_numpy()


def bars_since(b):
    b = np.asarray(b, dtype=np.float64)
    idx = np.arange(b.shape[0])
    last = np.where(b == 1.0, idx, -1)
    last = np.maximum.accumulate(last) if b.shape[0] else last
    out = (idx - last).astype(np.float64)
    out[last < 0] = NAN
    out[np.isnan(b)] = NAN
    return out


def onset(b):
    """Edge trigger: 1 only on the bar where the condition turns from false to true."""
    return and_(b, not_(lag(b, 1)))


# -------------------------------------------------------------------- price


def ret_n(c, n):
    return safe_div(c, lag(c, n)) - 1.0


def log_ret_n(c, n):
    return log_(safe_div(c, lag(c, n)))


def log_returns(c):
    return log_(safe_div(c, lag(c, 1)))


# ---------------------------------------------------------- candle geometry


def body_size(o, c):
    return safe_div(np.abs(c - o), o)


def body_ratio(o, h, l, c):
    return safe_div(np.abs(c - o), h - l)


def upper_wick(o, h, l, c):
    return safe_div(h - np.maximum(o, c), h - l)


def lower_wick(o, h, l, c):
    return safe_div(np.minimum(o, c) - l, h - l)


def wick_to_body(o, h, l, c):
    rng = h - l
    body = np.abs(c - o)
    out = safe_div(rng - body, body + 0.01 * rng)
    out[~(rng > 0)] = NAN
    return out


def close_location_in_range(h, l, c):
    return safe_div(c - l, h - l)


def high_low_range(h, l, c):
    return safe_div(h - l, c)


def gap(o, c):
    return safe_div(o, lag(c, 1)) - 1.0


def true_range_abs(h, l, c):
    pc = lag(c, 1)
    hi = np.where(np.isfinite(pc), np.maximum(h, pc), h)
    lo = np.where(np.isfinite(pc), np.minimum(l, pc), l)
    return hi - lo


def true_range(h, l, c):
    return safe_div(true_range_abs(h, l, c), lag(c, 1))


def range_expansion(h, l, n):
    hl = h - l
    return safe_div(hl, lag(rolling_mean(hl, n), 1))


def range_contraction(h, l, n):
    """Average range of the last n bars relative to the last 4n bars (<1 = contracting)."""
    hl = h - l
    return safe_div(rolling_mean(hl, n), rolling_mean(hl, 4 * int(n)))


# -------------------------------------------------------------------- volume


def volume_return(v, n):
    lv = np.log(np.asarray(v, dtype=np.float64) + VOL_EPS)
    return np.clip(lv - lag(lv, n), -10.0, 10.0)


def volume_ratio(v, n):
    """Current volume relative to the mean of the prior n bars."""
    return safe_div(v, lag(rolling_mean(v, n), 1))


def volume_zscore(v, n):
    """(volume - mean) / std, both over the prior n bars."""
    m = lag(rolling_mean(v, n), 1)
    s = lag(rolling_std(v, n), 1)
    return safe_div(np.asarray(v, dtype=np.float64) - m, s)


def price_volume_correlation(c, v, n):
    r = log_returns(c)
    lv = np.log(np.asarray(v, dtype=np.float64) + VOL_EPS)
    dv = lv - lag(lv, 1)
    return correlation(r, dv, n)


def volume_acceleration(v, n):
    lv = np.log(np.asarray(v, dtype=np.float64) + VOL_EPS)
    s = slope(lv, n)
    return s - lag(s, n)


def relative_volume(v, ts, bar_ms, n):
    """Volume relative to the mean volume at the same time of day over the prior n days.

    For daily or slower bars this equals ``volume_ratio``.
    """
    if bar_ms >= DAY_MS:
        return volume_ratio(v, n)
    slot = ((np.asarray(ts) % DAY_MS) // bar_ms).astype(np.int64)
    s = pd.Series(np.asarray(v, dtype=np.float64))
    n = int(n)
    prior = s.groupby(slot).transform(lambda g: g.shift(1).rolling(n, min_periods=n).mean()).to_numpy()
    return safe_div(v, prior)


# ---------------------------------------------------------------- volatility


def realized_volatility(c, n):
    return rolling_std(log_returns(c), n)


def range_volatility(h, l, n):
    x = log_(safe_div(h, l)) ** 2
    return np.sqrt(rolling_mean(x, n) / (4.0 * np.log(2.0)))


def volatility_ratio(c, n1, n2):
    return safe_div(realized_volatility(c, n1), realized_volatility(c, n2))


def volatility_change(c, n):
    rv = realized_volatility(c, n)
    return safe_div(rv, lag(rv, n)) - 1.0


# ---------------------------------------------------------- market structure


def distance_from_recent_high(h, c, n):
    return safe_div(c, rolling_max(h, n)) - 1.0


def distance_from_recent_low(l, c, n):
    return safe_div(c, rolling_min(l, n)) - 1.0


def higher_high_count(h, n):
    x = (h > lag(h, 1)).astype(np.float64)
    x[0] = NAN
    return rolling_sum(x, n)


def lower_low_count(l, n):
    x = (l < lag(l, 1)).astype(np.float64)
    x[0] = NAN
    return rolling_sum(x, n)


def trend_slope(c, n):
    """Slope of log price divided by the volatility of log returns (trend-to-noise)."""
    lc = log_(c)
    return safe_div(slope(lc, n), rolling_std(log_returns(c), n))


def compression_score(h, l, c, n):
    """1 - percentile rank of the n-bar normalised range within the last 5n bars (1 = most compressed)."""
    nr = safe_div(rolling_max(h, n) - rolling_min(l, n), c)
    return 1.0 - rank(nr, 5 * int(n))


def breakout_distance(h, l, c, n):
    """Close minus the prior n-bar high, in units of the prior n-bar ATR."""
    prior_high = lag(rolling_max(h, n), 1)
    atr = lag(rolling_mean(true_range_abs(h, l, c), n), 1)
    return safe_div(c - prior_high, atr)


def range_position(h, l, c, n):
    """Position of the close within the n-bar high-low range (0 = at low, 1 = at high)."""
    hi = rolling_max(h, n)
    lo = rolling_min(l, n)
    return safe_div(c - lo, hi - lo)


# ------------------------------------------------------ optional data columns


def taker_buy_ratio(tb, v, n):
    return rolling_mean(safe_div(tb, v), n)


def funding_sum(fr, n):
    return rolling_sum(fr, n)


def oi_change(oi, n):
    return safe_div(oi, lag(oi, n)) - 1.0
