"""Numbers -> words for discovered patterns (all statistics from TRAIN data).

The text produced here is what the LLM hypothesis generator sees instead of
raw prices.
"""

from __future__ import annotations

import numpy as np

from .mining import PHRASES
from .normalize import CHANNELS


def feature_profile(values: dict[str, np.ndarray], events: np.ndarray, lag: int = 0, top: int = 5) -> list[dict]:
    rows = []
    idx = events - lag
    idx = idx[idx >= 0]
    if idx.size == 0:
        return rows
    for feat, v in values.items():
        base = v[np.isfinite(v)]
        if base.size < 50:
            continue
        ev = v[idx]
        ev = ev[np.isfinite(ev)]
        if ev.size < 5:
            continue
        sd = float(base.std())
        if sd <= 0:
            continue
        z = (float(ev.mean()) - float(base.mean())) / (sd / np.sqrt(ev.size))
        pct = float((base < float(np.median(ev))).mean())
        rows.append({"feature": feat, "phrase": PHRASES.get(feat, feat), "event_median": float(np.median(ev)),
                     "baseline_median": float(np.median(base)), "median_percentile": pct, "z": float(z),
                     "lag": lag})
    rows.sort(key=lambda r: -abs(r["z"]))
    return rows[:top]


def _level(x: float, lo: float, hi: float, words=("low", "normal", "high")) -> str:
    return words[0] if x < lo else (words[2] if x > hi else words[1])


def shape_description(template: np.ndarray) -> list[str]:
    """Describe a (m, C) template as thirds of each channel."""
    m = template.shape[0]
    cuts = np.array_split(np.arange(m), 3)
    out = []
    names = {"ret": "returns (vol-normalised)", "range": "bar range vs normal", "volume": "volume vs normal",
             "body": "candle body direction"}
    for ci, ch in enumerate(CHANNELS[: template.shape[1]]):
        parts = []
        for seg in cuts:
            v = float(template[seg, ci].mean())
            if ch == "ret":
                parts.append(_level(v, -0.35, 0.35, ("down", "flat", "up")))
            elif ch == "body":
                parts.append(_level(v, -0.25, 0.25, ("bearish", "mixed", "bullish")))
            else:
                parts.append(_level(v, -0.25, 0.25, ("below", "normal", "above")))
        last = float(template[-1, ci])
        tail = f"; last bar {last:+.2f}"
        out.append(f"{names[ch]}: {' -> '.join(parts)}{tail}")
    return out


def pct(x: float | None) -> str:
    if x is None or x != x:
        return "n/a"
    return f"{100 * x:+.2f}%"


def summary_text(p: dict) -> str:
    st = p["stats"]
    lines = [f"Pattern {p['pattern_id']} ({p['kind']}, length {p.get('length', 1)} bars, "
             f"{st['n_events']} occurrences on TRAIN)"]
    if p.get("profile"):
        pre = [f"{r['phrase']} {'high' if r['z'] > 0 else 'low'} (median at {100 * r['median_percentile']:.0f}th "
               f"pct{', ' + str(r['lag']) + ' bars before' if r['lag'] else ''})" for r in p["profile"][:4]]
        lines.append("Conditions at occurrence: " + "; ".join(pre))
    if p.get("shape"):
        lines.append("Shape: " + " | ".join(p["shape"]))
    if p["kind"] == "conditional":
        lines.append(f"Definition: {p['dsl']}")
    outs = []
    for h, hs in sorted(st["horizons"].items(), key=lambda x: int(x[0])):
        if "mean" in hs:
            outs.append(f"+{h} bars mean {pct(hs['mean'])} (hit {100 * hs['hit_rate']:.0f}%, baseline "
                        f"{pct(hs['baseline_mean'])})")
    lines.append("Forward outcome after next-open entry: " + "; ".join(outs))
    prim = st["horizons"].get(str(st["primary_horizon"]), {})
    if "t_stat" in prim:
        lines.append(f"Primary horizon {st['primary_horizon']}: excess {pct(prim['excess_mean'])}, "
                     f"t={prim['t_stat']:.2f}, BH q={p.get('q_value', 1.0):.3f}, 5% tail {pct(prim['q05'])}")
    if p.get("regimes"):
        lines.append("Regimes at occurrence: " + ", ".join(f"R{k} {100 * v:.0f}%" for k, v in p["regimes"].items()))
    return "\n".join(lines)
