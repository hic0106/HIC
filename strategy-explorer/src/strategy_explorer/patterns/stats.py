"""Forward-outcome statistics for discovered patterns (TRAIN data only)."""

from __future__ import annotations

import math

import numpy as np


def forward_returns(open_: np.ndarray, horizons: tuple[int, ...]) -> dict[int, np.ndarray]:
    """fwd[h][t] = open[t+1+h] / open[t+1] - 1: enter at the next open after bar t closes, hold h bars."""
    n = open_.shape[0]
    out = {}
    for h in horizons:
        f = np.full(n, np.nan)
        if n > h + 1:
            f[: n - 1 - h] = open_[1 + h:] / open_[1: n - h] - 1.0
        out[h] = f
    return out


def thin_events(idx: np.ndarray, spacing: int) -> np.ndarray:
    """Keep events at least ``spacing`` bars apart (greedy in time order)."""
    if idx.size == 0:
        return idx
    keep = [int(idx[0])]
    for i in idx[1:]:
        if i - keep[-1] >= spacing:
            keep.append(int(i))
    return np.asarray(keep, dtype=np.int64)


def onset_events(mask: np.ndarray) -> np.ndarray:
    m = np.asarray(mask, dtype=bool)
    prev = np.r_[False, m[:-1]]
    return np.flatnonzero(m & ~prev)


def _betacf(a: float, b: float, x: float) -> float:
    """Continued fraction of the regularised incomplete beta function (modified Lentz)."""
    tiny, qab, qap, qam = 1e-300, a + b, a + 1.0, a - 1.0
    c, d = 1.0, 1.0 - qab * x / qap
    d = 1.0 / (d if abs(d) > tiny else tiny)
    h = d
    for m in range(1, 300):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        d = 1.0 / (d if abs(d) > tiny else tiny)
        c = 1.0 + aa / c
        c = c if abs(c) > tiny else tiny
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        d = 1.0 / (d if abs(d) > tiny else tiny)
        c = 1.0 + aa / c
        c = c if abs(c) > tiny else tiny
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-12:
            break
    return h


def betainc(a: float, b: float, x: float) -> float:
    """Regularised incomplete beta I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    ln = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log1p(-x)
    if x < (a + 1.0) / (a + b + 2.0):
        return math.exp(ln) * _betacf(a, b, x) / a
    return 1.0 - math.exp(ln) * _betacf(b, a, 1.0 - x) / b


def p_value(t: float, df: float = math.inf) -> float:
    """Two-sided p-value of a t statistic with ``df`` degrees of freedom (Student t; normal when df is inf)."""
    if not math.isfinite(t):
        return 1.0
    if not math.isfinite(df) or df > 1e7:
        return float(math.erfc(abs(t) / math.sqrt(2.0)))
    df = max(df, 1.0)
    return float(betainc(0.5 * df, 0.5, df / (df + t * t)))


def event_stats(events: np.ndarray, fwd: dict[int, np.ndarray], primary: int) -> dict:
    """Outcome statistics of events versus the unconditional baseline."""
    res: dict = {"n_events": int(events.size), "horizons": {}}
    for h, f in fwd.items():
        base = f[np.isfinite(f)]
        ev = events[(events < f.shape[0])]
        # thin so that forward windows of the same horizon do not overlap (independent observations)
        ev_h = thin_events(ev, max(1, h))
        vals = f[ev_h]
        vals = vals[np.isfinite(vals)]
        n = vals.size
        if n < 3 or base.size < 10:
            res["horizons"][str(h)] = {"n": int(n)}
            continue
        mean, sd = float(vals.mean()), float(vals.std(ddof=1))
        bmean, bsd = float(base.mean()), float(base.std(ddof=1))
        # the baseline averages overlapping h-bar windows: only ~N/h of them are independent
        n_base = max(2.0, base.size / max(1, h))
        v_ev, v_base = sd * sd / n, bsd * bsd / n_base
        se = math.sqrt(v_ev + v_base) if sd > 0 else float("inf")
        t = (mean - bmean) / se if se > 0 and math.isfinite(se) else 0.0
        # Welch-Satterthwaite degrees of freedom
        den = v_ev * v_ev / max(1, n - 1) + v_base * v_base / max(1.0, n_base - 1.0)
        df = (v_ev + v_base) ** 2 / den if den > 0 else float(n - 1)
        res["horizons"][str(h)] = {
            "n": int(n),
            "mean": mean,
            "median": float(np.median(vals)),
            "hit_rate": float((vals > 0).mean()),
            "q05": float(np.quantile(vals, 0.05)),
            "q95": float(np.quantile(vals, 0.95)),
            "baseline_mean": bmean,
            "baseline_hit_rate": float((base > 0).mean()),
            "excess_mean": mean - bmean,
            "t_stat": float(t),
            "df": float(df),
            "p_value": p_value(t, df),
        }
    prim = res["horizons"].get(str(primary), {})
    res["primary_horizon"] = primary
    res["t_stat"] = float(prim.get("t_stat", 0.0))
    res["p_value"] = float(prim.get("p_value", 1.0))
    res["excess_mean"] = float(prim.get("excess_mean", 0.0))
    mean = float(prim.get("mean", 0.0))
    # a tradable direction needs the absolute mean and the excess over the baseline to agree
    if mean > 0 and res["excess_mean"] > 0:
        res["direction"] = "long"
    elif mean < 0 and res["excess_mean"] < 0:
        res["direction"] = "short"
    else:
        res["direction"] = "neutral"
    return res


def benjamini_hochberg(pvals: list[float]) -> list[float]:
    """BH-adjusted q-values."""
    m = len(pvals)
    if m == 0:
        return []
    order = np.argsort(pvals)
    q = np.empty(m)
    prev = 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        prev = min(prev, pvals[i] * m / rank)
        q[i] = prev
    return [float(min(1.0, x)) for x in q]
