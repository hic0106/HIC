"""Conditional price/volume pattern mining (statistical feature discovery).

Every base feature is discretised at TRAIN quantiles, single conditions and
beam-searched conjunctions (pairs, triples) are tested for a difference in
next-open forward returns versus the unconditional baseline, and the
Benjamini-Hochberg procedure controls the false discovery rate over *all*
conditions tested. Surviving patterns are expressed as DSL boolean
expressions that reproduce their occurrences exactly.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations

import numpy as np

from ..dsl.evaluator import EvalContext
from ..dsl.nodes import fmt_number
from ..dsl.parser import parse_expr
from ..dsl.registry import Registry
from ..dsl.typecheck import TypeChecker
from ..dsl.types import DSLTypeError
from .stats import benjamini_hochberg, event_stats, onset_events

# (expression, human phrase) - generic, scale-invariant features; no named indicator strategies
BASE_FEATURES: tuple[tuple[str, str], ...] = (
    ("volume_zscore(20)", "volume vs prior 20-bar average (z)"),
    ("volume_ratio(10)", "volume / prior 10-bar mean"),
    ("relative_volume(10)", "volume vs same time-of-day average"),
    ("volume_return(1)", "log volume change vs previous bar"),
    ("count_true(GT(volume_return(1), 0), 8)", "bars with rising volume in last 8"),
    ("range_position(20)", "close position in 20-bar range"),
    ("range_position(50)", "close position in 50-bar range"),
    ("close_location_in_range()", "close position in bar range"),
    ("body_ratio()", "body / range"),
    ("upper_wick()", "upper wick / range"),
    ("lower_wick()", "lower wick / range"),
    ("gap()", "open vs previous close"),
    ("return(1)", "1-bar return"),
    ("return(3)", "3-bar return"),
    ("return(10)", "10-bar return"),
    ("range_contraction(8)", "8-bar range vs 32-bar range"),
    ("range_expansion(20)", "bar range vs prior 20-bar average"),
    ("volatility_ratio(5, 50)", "5-bar vs 50-bar realised volatility"),
    ("volatility_change(10)", "change of 10-bar realised volatility"),
    ("trend_slope(20)", "20-bar trend-to-noise"),
    ("trend_slope(50)", "50-bar trend-to-noise"),
    ("breakout_distance(20)", "close above prior 20-bar high (ATR units)"),
    ("distance_from_recent_high(50)", "distance from 50-bar high"),
    ("distance_from_recent_low(50)", "distance from 50-bar low"),
    ("higher_high_count(10)", "higher highs in last 10 bars"),
    ("lower_low_count(10)", "lower lows in last 10 bars"),
    ("compression_score(20)", "20-bar range compression"),
    ("price_volume_correlation(20)", "return/volume-change correlation"),
    ("volume_acceleration(10)", "volume trend acceleration"),
    ("taker_buy_ratio(5)", "taker-buy share of volume"),
    ("funding_sum(3)", "recent funding rate"),
    ("oi_change(6)", "open-interest change"),
)
PHRASES = dict(BASE_FEATURES)


@dataclass
class MiningConfig:
    horizons: tuple[int, ...] = (1, 3, 5, 10)
    primary: int = 5
    quantiles: tuple[float, ...] = (0.02, 0.05, 0.1, 0.25, 0.75, 0.9, 0.95, 0.98)
    min_events: int = 20
    top_singles: int = 24
    beam: int = 16
    max_patterns: int = 10
    fdr: float = 0.10
    max_overlap: float = 0.6


def compile_features(registry: Registry, extra: tuple[str, ...] = ()) -> list[tuple[str, object]]:
    tc = TypeChecker(registry)
    out = []
    for text, _ in BASE_FEATURES + tuple((e, e) for e in extra):
        try:
            node, _t = tc.check_expr(parse_expr(text))
        except DSLTypeError:
            continue
        out.append((node.text, node))
    return out


def _rounded(x: float) -> float:
    return float(f"{x:.4g}")


def mine_conditional(ctx: EvalContext, registry: Registry, fwd: dict, cfg: MiningConfig) -> list[dict]:
    feats = compile_features(registry)
    values = {}
    for text, node in feats:
        v = np.asarray(ctx.eval(node), dtype=np.float64)
        if np.isfinite(v).sum() > 100:
            values[text] = v
    tests: list[dict] = []

    def run(conds: list[tuple[str, str, float]]):
        mask = np.ones(ctx.n, dtype=bool)
        for feat, op, thr in conds:
            v = values[feat]
            with np.errstate(invalid="ignore"):
                mask &= (v < thr) if op == "LT" else (v > thr)
        ev = onset_events(mask)
        if ev.size < cfg.min_events:
            return None
        st = event_stats(ev, fwd, cfg.primary)
        if st["horizons"].get(str(cfg.primary), {}).get("n", 0) < cfg.min_events:
            return None
        rec = {"conds": conds, "events": ev, "stats": st, "p": st["p_value"], "t": st["t_stat"]}
        tests.append(rec)
        return rec

    singles = []
    for feat, v in values.items():
        fv = v[np.isfinite(v)]
        for q in cfg.quantiles:
            thr = _rounded(float(np.quantile(fv, q)))
            op = "LT" if q < 0.5 else "GT"
            r = run([(feat, op, thr)])
            if r is not None:
                singles.append(r)
    singles.sort(key=lambda r: -abs(r["t"]))
    top = singles[: cfg.top_singles]
    pairs = []
    for a, b in combinations(top, 2):
        if a["conds"][0][0] == b["conds"][0][0]:
            continue
        r = run(a["conds"] + b["conds"])
        if r is not None:
            pairs.append(r)
    pairs.sort(key=lambda r: -abs(r["t"]))
    for pr in pairs[: cfg.beam]:
        used = {c[0] for c in pr["conds"]}
        for s in top[: cfg.beam]:
            if s["conds"][0][0] in used:
                continue
            run(pr["conds"] + s["conds"])
    if not tests:
        return []
    qs = benjamini_hochberg([t["p"] for t in tests])
    for t, q in zip(tests, qs):
        t["q"] = q
    tests.sort(key=lambda r: (r["q"], -abs(r["t"])))
    chosen: list[dict] = []
    for t in tests:
        if t["q"] > cfg.fdr:
            break
        ev = set(t["events"].tolist())
        if any(len(ev & set(c["events"].tolist())) / max(1, len(ev | set(c["events"].tolist()))) > cfg.max_overlap
               for c in chosen):
            continue
        chosen.append(t)
        if len(chosen) >= cfg.max_patterns:
            break
    out = []
    for t in chosen:
        parts = [f"{op}({feat}, {fmt_number(thr)})" for feat, op, thr in t["conds"]]
        dsl = parts[0] if len(parts) == 1 else f"AND({', '.join(parts)})"
        out.append({"kind": "conditional", "dsl": dsl, "events": t["events"], "stats": t["stats"], "q": t["q"],
                    "length": 1, "conds": t["conds"], "n_tests": len(tests)})
    return out
