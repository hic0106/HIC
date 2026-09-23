"""Rolling / anchored walk-forward validation.

For every fold, the candidate's numeric parameters are re-fitted on the fold's
TRAIN window only (coordinate search over each parameter's neighbourhood,
objective = Sortino with a minimum trade count) and then evaluated on the
following TEST window. The fixed (as-discovered) parameters are evaluated on
the same windows. Folds whose test window lies in the TEST segment are marked
``clean``: the rule structure was never selected on them.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..dsl.complexity import parameters, set_param
from ..dsl.nodes import Strategy
from ..search.evaluation import StrategyEvaluator
from .common import neighbor_values, safe_metric


@dataclass
class WFConfig:
    mode: str = "anchored"
    n_folds: int = 5
    test_region: str = "validation+test"
    rolling_train_bars: int | None = None
    refit: bool = True
    refit_passes: int = 1
    refit_min_trades: int = 8
    min_positive_fraction: float = 0.6


def make_folds(ev: StrategyEvaluator, cfg: WFConfig) -> list[dict]:
    sp = ev.spec.split
    if cfg.test_region == "test":
        a, b = sp.test
    elif cfg.test_region == "all":
        a, b = sp.train[0] + (sp.train[1] - sp.train[0]) // 2, sp.test[1]
    else:
        a, b = sp.validation[0], sp.test[1]
    edges = np.linspace(a, b, cfg.n_folds + 1).astype(np.int64)
    folds = []
    for k in range(cfg.n_folds):
        ts, te = int(edges[k]), int(edges[k + 1])
        if cfg.mode == "rolling":
            length = cfg.rolling_train_bars or (sp.train[1] - sp.train[0])
            tr_s = max(0, ts - length)
        else:
            tr_s = 0
        folds.append({"fold": k, "train": (tr_s, ts), "test": (ts, te), "clean": ts >= sp.test[0]})
    return folds


def _objective(m: dict, min_trades: int) -> float:
    if not m or not m.get("valid") or m.get("trades", 0) < min_trades:
        return -1e9
    return safe_metric(m, "sortino")


def refit_parameters(st: Strategy, ev: StrategyEvaluator, window: tuple[int, int], passes: int = 1,
                     min_trades: int = 8) -> tuple[Strategy, dict]:
    best = st
    _, m = ev.backtest(st, window)
    best_score = _objective(m, min_trades)
    evaluated = 1
    for _ in range(passes):
        improved = False
        for p in parameters(best):
            for val in neighbor_values(best, p, ev, window):
                try:
                    cand = set_param(best, p.path, val, ev.registry.max_window)
                except (ValueError, KeyError):
                    continue
                _, mc = ev.backtest(cand, window)
                evaluated += 1
                sc = _objective(mc, min_trades)
                if sc > best_score + 1e-12:
                    best, best_score, improved = cand, sc, True
        if not improved:
            break
    return best, {"train_objective": best_score, "variants_evaluated": evaluated}


def walk_forward(st: Strategy, ev: StrategyEvaluator, cfg: WFConfig | None = None) -> dict:
    cfg = cfg or WFConfig()
    sig = ev.signals(st)
    folds_out = []
    for f in make_folds(ev, cfg):
        _, fixed = ev.backtest(st, f["test"], sig)
        row = {"fold": f["fold"], "train": list(f["train"]), "test": list(f["test"]), "clean": f["clean"],
               "test_start_ts": int(ev.spec.md.ts[f["test"][0]]), "test_end_ts": int(ev.spec.md.ts[f["test"][1] - 1]),
               "fixed": _brief(fixed)}
        if cfg.refit:
            refit_st, info = refit_parameters(st, ev, f["train"], cfg.refit_passes, cfg.refit_min_trades)
            _, rm = ev.backtest(refit_st, f["test"])
            row["refit"] = _brief(rm)
            row["refit_dsl"] = refit_st.text if refit_st.text != st.text else None
            row["refit_info"] = info
        folds_out.append(row)
    key = "refit" if cfg.refit else "fixed"
    rets = np.array([r[key]["total_return"] for r in folds_out])
    fixed_rets = np.array([r["fixed"]["total_return"] for r in folds_out])
    clean = np.array([r[key]["total_return"] for r in folds_out if r["clean"]])
    growth = float(np.prod(1.0 + rets) - 1.0) if rets.size else 0.0
    pos = float(np.mean(rets > 0)) if rets.size else 0.0
    passed = pos >= cfg.min_positive_fraction and growth > 0 and (clean.size == 0 or float(np.prod(1 + clean)) > 1.0)
    return {
        "mode": cfg.mode,
        "refit": cfg.refit,
        "folds": folds_out,
        "positive_fraction": pos,
        "positive_fraction_fixed": float(np.mean(fixed_rets > 0)) if fixed_rets.size else 0.0,
        "compounded_oos_return": growth,
        "compounded_oos_return_fixed": float(np.prod(1.0 + fixed_rets) - 1.0) if fixed_rets.size else 0.0,
        "clean_folds": int(clean.size),
        "clean_compounded_return": float(np.prod(1.0 + clean) - 1.0) if clean.size else None,
        "passed": bool(passed),
    }


def _brief(m: dict) -> dict:
    return {k: m.get(k) for k in ("total_return", "sharpe", "sortino", "max_drawdown", "trades", "profit_factor",
                                  "expectancy", "exposure")}
