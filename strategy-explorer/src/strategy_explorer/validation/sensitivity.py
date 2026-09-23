"""Parameter-sensitivity analysis.

Every numeric parameter is moved to neighbouring values (windows x0.8/0.9/1.1/1.2,
thresholds by +-5/10 quantile points of their input series on TRAIN, ...).
An edge that exists only at the exact discovered values is a sign of
overfitting. The variant return series are also reused for a candidate-level
PBO (CSCV over the neighbourhood).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..dsl.nodes import Strategy
from ..search.evaluation import StrategyEvaluator
from .common import neighborhood, safe_metric


@dataclass
class SensitivityConfig:
    selection_region: str = "train+validation"
    check_region: str = "test"
    min_positive_fraction: float = 0.6
    min_ratio: float = 0.5
    min_test_positive_fraction: float = 0.5
    max_variants: int = 40


def parameter_sensitivity(st: Strategy, ev: StrategyEvaluator, cfg: SensitivityConfig | None = None,
                          regions: tuple[str, ...] | None = None, keep_returns: bool = False) -> dict:
    cfg = cfg or SensitivityConfig()
    regions = regions or (cfg.selection_region, cfg.check_region)
    train_window = ev.spec.split.train
    variants = neighborhood(st, ev, train_window, cfg.max_variants)
    base_sig = ev.signals(st)
    base = {r: ev.backtest(st, r, base_sig)[1] for r in regions}
    rows = []
    series = {}
    search_region = ev.spec.split.segment("search")
    if keep_returns:
        res, _ = ev.backtest(st, search_region, base_sig)
        series["base"] = res.returns
    for p, val, st2 in variants:
        sig = ev.signals(st2)
        row = {"parameter": p.name, "path": p.path, "base_value": p.value, "value": val}
        for r in regions:
            _, m = ev.backtest(st2, r, sig)
            row[r] = {"total_return": m.get("total_return"), "sortino": m.get("sortino"), "trades": m.get("trades")}
        if keep_returns:
            res, _ = ev.backtest(st2, search_region, sig)
            series[f"{p.name}={val}"] = res.returns
        rows.append(row)
    out = {"variants": rows, "n_variants": len(rows), "base": {r: {k: base[r].get(k) for k in
                                                                   ("total_return", "sortino", "trades")}
                                                               for r in regions}}
    for r in regions:
        vals = np.array([safe_metric(x[r], "total_return") for x in rows]) if rows else np.zeros(0)
        sorts = np.array([safe_metric(x[r], "sortino") for x in rows]) if rows else np.zeros(0)
        b = safe_metric(base[r], "sortino")
        out[r] = {
            "positive_fraction": float(np.mean(vals > 0)) if vals.size else 0.0,
            "median_return": float(np.median(vals)) if vals.size else 0.0,
            "median_sortino_ratio": float(np.median(sorts) / b) if (vals.size and b > 0) else 0.0,
            "worst_return": float(vals.min()) if vals.size else 0.0,
        }
    sel, chk = out[cfg.selection_region], out.get(cfg.check_region, {})
    out["instability"] = float(1.0 - 0.5 * sel["positive_fraction"] - 0.5 * min(1.0, max(0.0,
                                                                                       sel["median_sortino_ratio"])))
    out["passed"] = bool(rows) and sel["positive_fraction"] >= cfg.min_positive_fraction \
        and sel["median_sortino_ratio"] >= cfg.min_ratio \
        and chk.get("positive_fraction", 0.0) >= cfg.min_test_positive_fraction
    if keep_returns:
        out["_series"] = series
    return out


def selection_instability(st: Strategy, ev: StrategyEvaluator, max_variants: int = 24) -> dict:
    """Cheap sensitivity on the selection data only (used as a post-search NSGA-II objective)."""
    cfg = SensitivityConfig(max_variants=max_variants)
    res = parameter_sensitivity(st, ev, cfg, regions=(cfg.selection_region,))
    return {"instability": res["instability"], "positive_fraction": res[cfg.selection_region]["positive_fraction"],
            "median_sortino_ratio": res[cfg.selection_region]["median_sortino_ratio"], "n_variants": res["n_variants"]}
