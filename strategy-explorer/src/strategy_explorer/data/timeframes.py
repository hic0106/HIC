"""Multi-timeframe support without look-ahead.

Higher-timeframe (HTF) candles are built by resampling the base data into UTC
anchored buckets. A bucket ``[t0, t0 + H)`` is only emitted when it is complete,
and it becomes visible to a base bar only when that base bar closes at or after
``t0 + H``. Using the HTF close time (not the open time) as the join key is what
prevents the classic resampling look-ahead bug.
"""

from __future__ import annotations

import numpy as np

from .market import EXTRA_COLUMNS, MarketData, tf_ms

_SUM_COLUMNS = {"quote_volume", "number_of_trades", "taker_buy_volume", "funding_rate"}
_LAST_COLUMNS = {"open_interest", "long_short_ratio"}


def resample(md: MarketData, target_tf: str, require_complete: bool = True) -> MarketData:
    base_ms = md.bar_ms
    tgt_ms = tf_ms(target_tf)
    if tgt_ms < base_ms or tgt_ms % base_ms:
        raise ValueError(f"cannot resample {md.timeframe} into {target_tf}")
    if tgt_ms == base_ms:
        return md.slice(0, len(md))
    if len(md) == 0:
        return md.slice(0, 0)
    ratio = tgt_ms // base_ms
    bucket = (md.ts // tgt_ms) * tgt_ms
    starts = np.flatnonzero(np.r_[True, bucket[1:] != bucket[:-1]])
    ends = np.r_[starts[1:], len(md)] - 1
    counts = ends - starts + 1
    if require_complete and md.asset_class == "crypto":
        complete = counts == ratio
    else:
        # Exchange calendars have legitimately short buckets; only the trailing
        # bucket may still be forming, so drop it unless its last bar closes the bucket.
        complete = np.ones(len(starts), dtype=bool)
        last_close = md.ts[ends[-1]] + base_ms
        complete[-1] = last_close >= bucket[starts[-1]] + tgt_ms
    o = md.open[starts]
    c = md.close[ends]
    h = np.maximum.reduceat(md.high, starts)
    l = np.minimum.reduceat(md.low, starts)
    v = np.add.reduceat(md.volume, starts)
    extra = {}
    for k, arr in md.extra.items():
        if k in _SUM_COLUMNS:
            filled = np.where(np.isfinite(arr), arr, 0.0)
            s = np.add.reduceat(filled, starts)
            anyv = np.add.reduceat(np.isfinite(arr).astype(np.int64), starts) > 0
            extra[k] = np.where(anyv, s, np.nan)
        elif k in _LAST_COLUMNS or k in EXTRA_COLUMNS:
            extra[k] = arr[ends]
    keep = np.flatnonzero(complete)
    return MarketData(
        asset=md.asset,
        timeframe=target_tf,
        ts=bucket[starts][keep].astype(np.int64),
        open=o[keep],
        high=h[keep],
        low=l[keep],
        close=c[keep],
        volume=v[keep],
        extra={k: a[keep] for k, a in extra.items()},
        asset_class=md.asset_class,
        source=md.source + f"|resampled:{target_tf}",
        has_volume=md.has_volume,
    )


def align_to_base(base_close_ts: np.ndarray, htf_close_ts: np.ndarray, values: np.ndarray) -> np.ndarray:
    """For every base bar return the value of the latest HTF bar whose close <= base bar close."""
    idx = np.searchsorted(htf_close_ts, base_close_ts, side="right") - 1
    out = np.full(base_close_ts.shape[0], np.nan, dtype=np.float64)
    ok = idx >= 0
    if values.shape[0]:
        out[ok] = values[idx[ok]]
    return out


def build_htf(md: MarketData, timeframes: list[str] | tuple[str, ...]) -> dict[str, MarketData]:
    out: dict[str, MarketData] = {}
    for tf in timeframes:
        if tf == md.timeframe:
            continue
        out[tf] = resample(md, tf)
    return out
