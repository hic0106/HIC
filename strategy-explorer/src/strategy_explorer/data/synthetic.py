"""Deterministic synthetic OHLCV generator.

Used for demos and for validating the research pipeline itself:

* ``plant=None, drift_scale=0`` -> a martingale with volatility regimes and
  realistic volume. No rule can have positive expected return after costs, so
  the overfitting firewall should reject everything (null test).
* ``plant="squeeze_breakout"`` -> the same process with a hidden, repeatable
  price/volume behaviour: range and volume contract for several bars, then a
  volume expansion bar closes near its high, and the following bars carry a
  positive drift. The pipeline should be able to rediscover it.
"""

from __future__ import annotations

import numpy as np

from ..util import DAY_MS, parse_date_ms
from .market import MarketData, tf_ms

PLANTS = ("squeeze_breakout",)


def _student_t(rng: np.random.Generator, df: float, size: int) -> np.ndarray:
    x = rng.standard_t(df, size=size)
    return x / np.sqrt(df / (df - 2.0))


def generate_synthetic(
    n_bars: int = 6000,
    timeframe: str = "4h",
    asset: str = "SYNTH",
    seed: int = 7,
    start: str = "2018-01-01",
    plant: str | None = None,
    plant_strength: float = 1.0,
    drift_scale: float | None = None,
    daily_vol: float = 0.035,
) -> MarketData:
    if plant is not None and plant not in PLANTS:
        raise ValueError(f"unknown plant {plant!r}; available: {PLANTS}")
    if drift_scale is None:
        drift_scale = 0.0
    rng = np.random.default_rng(seed)
    bar_ms = tf_ms(timeframe)
    t0 = parse_date_ms(start)
    ts = t0 + np.arange(n_bars, dtype=np.int64) * bar_ms
    sigma = daily_vol * np.sqrt(bar_ms / DAY_MS)

    # --- latent volatility regimes (Markov chain)
    vol_mult = np.array([0.6, 1.0, 1.5, 0.8])
    drift = np.array([0.02, -0.02, 0.0, 0.01]) * drift_scale
    stay = 1.0 - 1.0 / 250.0
    trans = np.full((4, 4), (1.0 - stay) / 3.0)
    np.fill_diagonal(trans, stay)
    states = np.empty(n_bars, dtype=np.int64)
    s = 0
    u = rng.random(n_bars)
    cum = np.cumsum(trans, axis=1)
    for i in range(n_bars):
        states[i] = s
        s = int(np.searchsorted(cum[s], u[i], side="right"))
        s = min(s, 3)

    # --- volatility clustering
    eta = rng.normal(0.0, 1.0, n_bars)
    logh = np.empty(n_bars)
    acc = 0.0
    for i in range(n_bars):
        acc = 0.97 * acc + 0.18 * eta[i]
        logh[i] = acc
    h = np.exp(logh - logh.mean())
    sig_t = sigma * vol_mult[states] * h
    eps = _student_t(rng, 5.0, n_bars)
    ret = drift[states] * sigma + sig_t * eps

    # --- volume: related to volatility and |shock|, with intraday seasonality
    vnoise = np.empty(n_bars)
    acc = 0.0
    vn = rng.normal(0.0, 1.0, n_bars)
    for i in range(n_bars):
        acc = 0.8 * acc + 0.35 * vn[i]
        vnoise[i] = acc
    hour = ((ts % DAY_MS) / 3_600_000.0) if bar_ms < DAY_MS else np.zeros(n_bars)
    season = 0.25 * np.sin(2 * np.pi * (hour - 8.0) / 24.0)
    log_vol = np.log(1000.0) + 0.9 * np.log(vol_mult[states] * h) + 0.25 * np.abs(eps) + vnoise + season
    vol_factor = np.ones(n_bars)
    close_high = np.zeros(n_bars, dtype=bool)

    events: list[int] = []
    if plant == "squeeze_breakout":
        pos = 60
        while pos < n_bars - 20:
            pos += int(rng.integers(45, 110))
            if pos >= n_bars - 20:
                break
            events.append(pos)
        for e in events:
            # 8 bars of contraction: small ranges, declining volume
            for k in range(8):
                j = e - 8 + k
                ret[j] = ret[j] * 0.35
                sig_t[j] = sig_t[j] * 0.35
                vol_factor[j] = 0.85 - 0.05 * k
            # expansion bar: volume spike, strong close near the high
            ret[e] = abs(ret[e]) * 0.3 + 1.2 * sigma
            vol_factor[e] = 3.2
            close_high[e] = True
            # follow-through drift for 6 bars
            for k in range(1, 7):
                ret[e + k] = ret[e + k] + 0.35 * sigma * plant_strength
        # remove the planted drift from the unconditional mean: only the conditional behaviour carries an edge
        touched = np.zeros(n_bars, dtype=bool)
        for e in events:
            touched[e - 8:e + 7] = True
        added = sum(0.35 * sigma * plant_strength * 6 + 1.2 * sigma for _ in events)
        if (~touched).any():
            ret[~touched] -= added / float((~touched).sum())

    volume = np.exp(log_vol) * vol_factor
    gap = rng.normal(0.0, 0.05, n_bars) * sig_t
    close = np.empty(n_bars)
    open_ = np.empty(n_bars)
    price = 10_000.0
    for i in range(n_bars):
        o = price * np.exp(gap[i])
        c = o * np.exp(ret[i])
        open_[i] = o
        close[i] = c
        price = c
    wick_hi = np.abs(rng.normal(0.0, 0.45, n_bars)) * sig_t
    wick_lo = np.abs(rng.normal(0.0, 0.45, n_bars)) * sig_t
    wick_hi[close_high] = 0.02 * sig_t[close_high]
    high = np.maximum(open_, close) * np.exp(wick_hi)
    low = np.minimum(open_, close) * np.exp(-wick_lo)
    taker = volume * np.clip(0.5 + 0.08 * np.sign(ret) + rng.normal(0, 0.03, n_bars), 0.05, 0.95)
    md = MarketData(
        asset=asset,
        timeframe=timeframe,
        ts=ts,
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=volume,
        extra={"taker_buy_volume": taker},
        asset_class="crypto",
        source=f"synthetic(seed={seed},plant={plant},strength={plant_strength})",
    )
    md.synthetic_events = events  # type: ignore[attr-defined]  (ground truth for tests only)
    return md
