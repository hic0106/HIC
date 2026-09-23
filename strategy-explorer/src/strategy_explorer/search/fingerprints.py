"""Known Strategy Fingerprint Library.

Reference implementations of well-known public strategies. They are NOT search
primitives and are never used as seeds; they exist only so that discovered
rules which re-invent a famous strategy can be tagged:

* KNOWN_LIKE - behaves like (or is structurally identical to) a known strategy
* HYBRID     - contains a known component combined with other conditions, or
               partially overlaps a known strategy's behaviour
* NOVEL      - neither
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from ..backtest.costs import CostModel
from ..backtest.engine import ExecConfig, run_backtest
from ..data.market import MarketData
from ..dsl.evaluator import Signals
from ..dsl.nodes import Node, Strategy, iter_nodes
from ..util import DAY_MS
from .families import clauses
from .novelty import trade_overlap

KNOWN_LIKE, HYBRID, NOVEL = "KNOWN_LIKE", "HYBRID", "NOVEL"


# -------------------------------------------------------- reference indicators
def _s(x):
    return pd.Series(np.asarray(x, dtype=np.float64))


def sma(x, n):
    return np.array(_s(x).rolling(n, min_periods=n).mean().to_numpy(), dtype=np.float64)


def ema(x, n):
    return np.array(_s(x).ewm(span=n, adjust=False, min_periods=n).mean().to_numpy(), dtype=np.float64)


def rsi(c, n=14):
    d = np.diff(c, prepend=np.nan)
    up = _s(np.where(d > 0, d, 0.0)).ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean().to_numpy()
    dn = _s(np.where(d < 0, -d, 0.0)).ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean().to_numpy()
    with np.errstate(all="ignore"):
        rs = up / dn
        out = np.array(100.0 - 100.0 / (1.0 + rs), dtype=np.float64)
    out[dn == 0] = 100.0
    return out


def _prior_max(x, n):
    return _s(x).rolling(n, min_periods=n).max().shift(1).to_numpy()


def _prior_min(x, n):
    return _s(x).rolling(n, min_periods=n).min().shift(1).to_numpy()


def _cross_up(a, b):
    a, b = np.asarray(a), np.asarray(b)
    prev_a, prev_b = np.r_[np.nan, a[:-1]], np.r_[np.nan, b[:-1]]
    return (a > b) & (prev_a <= prev_b)


def _adx(h, l, c, n=14):
    up = np.diff(h, prepend=np.nan)
    dn = -np.diff(l, prepend=np.nan)
    pdm = np.where((up > dn) & (up > 0), up, 0.0)
    mdm = np.where((dn > up) & (dn > 0), dn, 0.0)
    pc = np.r_[np.nan, c[:-1]]
    tr = np.nanmax(np.vstack([h - l, np.abs(h - pc), np.abs(l - pc)]), axis=0)
    a = 1.0 / n
    atr = _s(tr).ewm(alpha=a, adjust=False, min_periods=n).mean().to_numpy()
    with np.errstate(all="ignore"):
        pdi = 100 * _s(pdm).ewm(alpha=a, adjust=False, min_periods=n).mean().to_numpy() / atr
        mdi = 100 * _s(mdm).ewm(alpha=a, adjust=False, min_periods=n).mean().to_numpy() / atr
        dx = 100 * np.abs(pdi - mdi) / (pdi + mdi)
    adx = _s(dx).ewm(alpha=a, adjust=False, min_periods=n).mean().to_numpy()
    return adx, pdi, mdi


def _nz(x):
    return np.where(np.isfinite(x), x, np.nan)


def _b(x):
    return np.asarray(np.nan_to_num(x, nan=0.0), dtype=bool)


@dataclass
class KnownStrategy:
    name: str
    family: str
    direction: str
    signals: Signals


def reference_strategies(md: MarketData) -> list[KnownStrategy]:
    o, h, l, c = md.open, md.high, md.low, md.close
    n = len(md)
    F = np.zeros(n, dtype=bool)
    out: list[KnownStrategy] = []
    bars_per_day = max(1, DAY_MS // md.bar_ms)
    scales = [1] if bars_per_day == 1 else [1, bars_per_day]

    def add(name, family, direction, le=F, lx=F, se=F, sx=F):
        out.append(KnownStrategy(name, family, direction, Signals(_b(le), _b(lx), _b(se), _b(sx))))

    for k in scales:
        tag = "" if k == 1 else "_days"
        r14 = rsi(c, 14 * k)
        add(f"RSI14<30{tag}", "rsi_mean_reversion", "long", r14 < 30, r14 > 50)
        add(f"RSI14>70_short{tag}", "rsi_mean_reversion", "short", se=r14 > 70, sx=r14 < 50)
        for a, b in ((50, 200), (20, 50), (10, 30)):
            if b * k < n // 2:
                fa, fb = sma(c, a * k), sma(c, b * k)
                add(f"SMA{a}/{b}_cross{tag}", "ma_crossover", "long", _cross_up(fa, fb), _cross_up(fb, fa))
        e12, e26 = ema(c, 12 * k), ema(c, 26 * k)
        add(f"EMA12/26_cross{tag}", "ma_crossover", "long", _cross_up(e12, e26), _cross_up(e26, e12))
        macd = e12 - e26
        sig = ema(np.nan_to_num(macd, nan=0.0), 9 * k)
        sig[np.isnan(macd)] = np.nan
        add(f"MACD12/26/9{tag}", "macd", "long", _cross_up(macd, sig), _cross_up(sig, macd))
        for ent, ex in ((20, 10), (55, 20)):
            if ent * k < n // 2:
                ph, pl = _prior_max(h, ent * k), _prior_min(l, ent * k)
                xh, xl = _prior_max(h, ex * k), _prior_min(l, ex * k)
                add(f"Donchian{ent}/{ex}{tag}", "channel_breakout", "long_short", c > ph, c < xl, c < pl, c > xh)
        m20 = sma(c, 20 * k)
        sd20 = _s(c).rolling(20 * k, min_periods=20 * k).std().to_numpy()
        add(f"Bollinger20_reversion{tag}", "bollinger", "long", c < m20 - 2 * sd20, c > m20)
        add(f"Bollinger20_breakout{tag}", "bollinger", "long", c > m20 + 2 * sd20, c < m20)
        for m in (30, 90, 126, 252):
            if m * k < n // 2:
                ret = c / np.r_[np.full(m * k, np.nan), c[:-m * k]] - 1.0
                add(f"TSMOM{m}{tag}", "time_series_momentum", "long", ret > 0, ret <= 0)
                add(f"TSMOM{m}_LS{tag}", "time_series_momentum", "long_short", ret > 0, ret <= 0, ret < 0, ret >= 0)
        if 200 * k < n // 2:
            s200 = sma(c, 200 * k)
            add(f"Close>SMA200{tag}", "trend_filter", "long", c > s200, c < s200)
        adx, pdi, mdi = _adx(h, l, c, 14 * k)
        add(f"ADX14>25{tag}", "adx_trend", "long", (adx > 25) & (pdi > mdi), (adx <= 25) | (mdi >= pdi))
        ll = _s(l).rolling(14 * k, min_periods=14 * k).min().to_numpy()
        hh = _s(h).rolling(14 * k, min_periods=14 * k).max().to_numpy()
        with np.errstate(all="ignore"):
            kk = 100 * (c - ll) / (hh - ll)
        dd = sma(np.nan_to_num(kk, nan=50.0), 3)
        add(f"Stochastic14/3{tag}", "stochastic", "long", _cross_up(kk, dd) & (kk < 20), kk > 80)
        cr = rsi(c, 2 * k)
        s200b = sma(c, 200 * k) if 200 * k < n // 2 else np.full(n, -np.inf)
        add(f"RSI2_Connors{tag}", "rsi_mean_reversion", "long", (cr < 10) & (c > s200b), c > sma(c, 5 * k))
    add("BuyAndHold", "buy_and_hold", "long", np.ones(n, dtype=bool), F)
    return out


def positions_for(md: MarketData, ks: KnownStrategy, start: int, stop: int) -> np.ndarray:
    st = Strategy(ks.direction, long_entry=None, max_hold=None)
    res = run_backtest(md, ks.signals, st, start, stop, CostModel(0.0, 0.0, "none"), ExecConfig())
    return res.position


# ------------------------------------------------------------ structure check
def _is_prior_channel(n: Node, kind: str) -> bool:
    if n.op == "lag" and n.args and n.args[0].op == kind:
        return True
    return False


def structural_matches(st: Strategy) -> list[str]:
    """Known constructions recognised in the entry rules."""
    found = []
    for slot in ("long_entry", "short_entry"):
        root = st.slot(slot)
        if root is None:
            continue
        for cl in clauses(root):
            for _, n in iter_nodes(cl):
                if n.op in ("GT", "CROSS_ABOVE") and len(n.args) == 2:
                    a, b = n.args
                    if a.op in ("close", "high") and (_is_prior_channel(b, "rolling_max") or
                                                      (b.op == "rolling_max" and b.args and b.args[0].op == "high")):
                        found.append("channel_breakout")
                    if b.op in ("close", "low") and (_is_prior_channel(a, "rolling_min") or
                                                     (a.op == "rolling_min" and a.args and a.args[0].op == "low")):
                        found.append("channel_breakout")
                    if a.op == "rolling_mean" and b.op == "rolling_mean":
                        found.append("ma_crossover")
                    if (a.op == "close" and b.op == "rolling_mean") or (b.op == "close" and a.op == "rolling_mean"):
                        found.append("price_vs_moving_average")
                    if a.op == "breakout_distance" and not b.is_literal:
                        found.append("channel_breakout")
                if n.op in ("GT", "LT", "CROSS_ABOVE", "CROSS_BELOW") and len(n.args) == 2 and n.args[1].op == "#float":
                    a = n.args[0]
                    thr = float(n.args[1].value)
                    if a.op in ("return", "log_return") and abs(thr) < 1e-3 and int(a.args[0].value) >= 20:
                        found.append("time_series_momentum")
                    if a.op == "breakout_distance" and abs(thr) < 0.25:
                        found.append("channel_breakout")
                    if a.op == "zscore" and a.args and a.args[0].op == "close" and abs(abs(thr) - 2.0) < 0.35:
                        found.append("bollinger")
    return sorted(set(found))


@dataclass
class KnownLikeReport:
    novelty_class: str
    max_similarity: float
    closest: str | None
    closest_family: str | None
    structural: list[str]
    top: list[dict]

    def to_dict(self) -> dict:
        return dict(self.__dict__)


def classify(st: Strategy, cand_position: np.ndarray, known_positions: dict[str, tuple[str, np.ndarray]],
             known_threshold: float = 0.7, hybrid_threshold: float = 0.4) -> KnownLikeReport:
    sims = []
    for name, (fam, pos) in known_positions.items():
        ov = trade_overlap(cand_position, pos)
        a = cand_position.astype(np.float64)
        b = pos.astype(np.float64)
        if a.std() > 0 and b.std() > 0:
            corr = float(np.corrcoef(a, b)[0, 1])
        else:
            corr = 0.0
        sims.append((max(ov, corr), name, fam, ov, corr))
    sims.sort(key=lambda x: -x[0])
    best = sims[0] if sims else (0.0, None, None, 0.0, 0.0)
    structural = structural_matches(st)
    n_clauses = sum(len(clauses(st.slot(s))) for s in ("long_entry", "short_entry") if st.slot(s) is not None)
    if best[0] >= known_threshold or (structural and n_clauses <= len(structural)):
        cls = KNOWN_LIKE
    elif best[0] >= hybrid_threshold or structural:
        cls = HYBRID
    else:
        cls = NOVEL
    top = [{"name": s[1], "family": s[2], "similarity": round(s[0], 4), "trade_overlap": round(s[3], 4),
            "position_correlation": round(s[4], 4)} for s in sims[:5]]
    return KnownLikeReport(cls, float(best[0]), best[1], best[2], structural, top)
