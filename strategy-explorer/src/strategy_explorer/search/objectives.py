"""Objectives, constraint violations and the Robustness Score.

All search-time quantities are computed from TRAIN metrics only. Validation
metrics are recorded in the ledger but never fed back into evolutionary
selection, MCTS rewards or LLM prompts.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from ..dsl.complexity import Complexity


def _m(d: dict | None, key: str, default: float = 0.0) -> float:
    if not d:
        return default
    v = d.get(key, default)
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


# name -> (function(ctx) -> value, sense). ctx keys: is, oos, cx (Complexity), sens (dict|None)
OBJECTIVES = {
    "return": (lambda c: _m(c["is"], "total_return"), "max"),
    "cagr": (lambda c: _m(c["is"], "cagr"), "max"),
    "sortino": (lambda c: min(_m(c["is"], "sortino"), 10.0), "max"),
    "sharpe": (lambda c: _m(c["is"], "sharpe"), "max"),
    "profit_factor": (lambda c: math.log(max(1e-3, min(_m(c["is"], "profit_factor"), 10.0))), "max"),
    "max_drawdown": (lambda c: _m(c["is"], "max_drawdown", -1.0), "max"),
    "turnover": (lambda c: _m(c["is"], "turnover"), "min"),
    "complexity": (lambda c: c["cx"].score, "min"),
    "consistency": (lambda c: _m(c["is"], "consistency") + 0.25 * max(-1.0, min(1.0, _m(c["is"], "worst_block"))),
                    "max"),
    "expectancy": (lambda c: _m(c["is"], "expectancy"), "max"),
    # selection-stage objectives (post-search, may use validation and sensitivity)
    "oos_return": (lambda c: _m(c["oos"], "total_return"), "max"),
    "oos_sortino": (lambda c: min(_m(c["oos"], "sortino"), 10.0), "max"),
    "sensitivity": (lambda c: _m(c.get("sens"), "instability", 1.0), "min"),
}


def objective_vector(names: list[str] | tuple[str, ...], ctx: dict) -> np.ndarray:
    """Objective values in minimisation form (maximised objectives are negated)."""
    out = np.empty(len(names))
    for i, n in enumerate(names):
        fn, sense = OBJECTIVES[n]
        v = float(fn(ctx))
        out[i] = -v if sense == "max" else v
    return out


@dataclass
class ConstraintConfig:
    min_trades: int = 20
    require_positive_return: bool = True
    max_exposure: float = 1.01


def violation(is_m: dict | None, cfg: ConstraintConfig) -> float:
    if not is_m or not is_m.get("valid"):
        return 10.0
    v = 0.0
    tr = int(is_m.get("trades", 0))
    if tr < cfg.min_trades:
        v += (cfg.min_trades - tr) / max(1, cfg.min_trades)
    if cfg.require_positive_return and _m(is_m, "total_return") <= 0:
        v += 0.01 + min(1.0, -2.0 * _m(is_m, "total_return"))
    if _m(is_m, "exposure") > cfg.max_exposure:
        v += 0.5
    return float(v)


@dataclass
class RobustnessWeights:
    consistency: float = 0.30
    sortino: float = 0.20
    profit_factor: float = 0.15
    drawdown: float = 0.15
    trades: float = 0.10
    simplicity: float = 0.10
    drawdown_ref: float = 0.40
    extra: dict = field(default_factory=dict)


def robustness_components(m: dict | None, cx: Complexity, min_trades: int, w: RobustnessWeights) -> dict:
    if not m or not m.get("valid") or int(m.get("trades", 0)) == 0:
        return {"consistency": 0.0, "sortino": 0.0, "profit_factor": 0.0, "drawdown": 0.0, "trades": 0.0,
                "simplicity": 0.0}
    s = _m(m, "sortino")
    pf = _m(m, "profit_factor")
    return {
        "consistency": float(np.clip(_m(m, "consistency"), 0, 1)),
        "sortino": float(s / (s + 2.0)) if s > 0 else 0.0,
        "profit_factor": float(np.clip(pf - 1.0, 0.0, 1.0)),
        "drawdown": float(1.0 - np.clip(abs(_m(m, "max_drawdown")) / w.drawdown_ref, 0, 1)),
        "trades": float(np.clip(int(m.get("trades", 0)) / (2.0 * max(1, min_trades)), 0, 1)),
        "simplicity": float(1.0 / (1.0 + max(0.0, cx.score - 8.0) / 15.0)),
    }


def robustness_score(m: dict | None, cx: Complexity, min_trades: int, w: RobustnessWeights | None = None) -> float:
    """Search-phase Robustness Score in [0, 1] (train metrics only). Default leaderboard sort key."""
    w = w or RobustnessWeights()
    comp = robustness_components(m, cx, min_trades, w)
    weights = {"consistency": w.consistency, "sortino": w.sortino, "profit_factor": w.profit_factor,
               "drawdown": w.drawdown, "trades": w.trades, "simplicity": w.simplicity}
    tot = sum(weights.values())
    score = sum(comp[k] * weights[k] for k in weights) / tot if tot > 0 else 0.0
    if not m or _m(m, "total_return") <= 0:
        score *= 0.25
    return float(score)
