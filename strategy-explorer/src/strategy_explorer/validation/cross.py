"""Cross-asset and regime robustness."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..backtest.costs import CostModel
from ..backtest.engine import ExecConfig, run_backtest
from ..backtest.metrics import compute_metrics
from ..data.market import MarketData
from ..dsl.evaluator import EvalContext
from ..dsl.nodes import Strategy
from ..dsl.registry import Registry
from ..dsl.typecheck import TypeChecker
from ..dsl.types import DSLTypeError
from ..search.evaluation import StrategyEvaluator


@dataclass
class CrossAssetConfig:
    min_positive_crypto: float = 0.6
    min_positive_other: float = 0.5
    warmup_bars: int = 300


def cross_asset_test(st: Strategy, others: list[MarketData], cutoff_ms: int, costs_for: dict[str, CostModel],
                     ex: ExecConfig, htf: tuple[str, ...], regime_model=None, pattern_library=None,
                     cfg: CrossAssetConfig | None = None) -> dict:
    """Apply the recipe unchanged to other assets, using only bars before the primary holdout start."""
    cfg = cfg or CrossAssetConfig()
    rows = []
    for md in others:
        cut = md.slice(0, md.index_of_ts(cutoff_ms, "left"))
        row = {"asset": md.asset, "asset_class": md.asset_class, "bars": len(cut)}
        if len(cut) < cfg.warmup_bars + 100:
            row["status"] = "INSUFFICIENT_DATA"
            rows.append(row)
            continue
        reg = Registry(columns=frozenset(cut.available_columns()), htf=htf, base_timeframe=cut.timeframe,
                       n_regimes=regime_model.n_states if regime_model is not None else 0,
                       pattern_ids=pattern_library.ids() if pattern_library is not None else ())
        try:
            st2 = TypeChecker(reg, 200, 30).check_strategy(st)
        except DSLTypeError as exc:
            row["status"] = "NOT_APPLICABLE"
            row["reason"] = str(exc)
            rows.append(row)
            continue
        ctx = EvalContext(cut, htf, regime_model, pattern_library)
        sig = ctx.signals(st2)
        costs = costs_for.get(cut.asset_class) or costs_for.get("default")
        res = run_backtest(cut, sig, st2, cfg.warmup_bars, len(cut), costs, ex)
        m = compute_metrics(res, cut.ts[cfg.warmup_bars:], cut.periods_per_year(), 6, ex.leverage)
        row.update(status="TESTED", total_return=m.get("total_return"), sharpe=m.get("sharpe"),
                   max_drawdown=m.get("max_drawdown"), trades=m.get("trades"),
                   profit_factor=m.get("profit_factor"),
                   positive=bool(m.get("total_return", 0) > 0 and m.get("profit_factor", 0) > 1.0))
        rows.append(row)
    tested = [r for r in rows if r.get("status") == "TESTED"]
    crypto = [r for r in tested if r["asset_class"] == "crypto"]
    other = [r for r in tested if r["asset_class"] != "crypto"]
    fc = float(np.mean([r["positive"] for r in crypto])) if crypto else None
    fo = float(np.mean([r["positive"] for r in other])) if other else None
    if not tested:
        cls = "NOT_TESTED"
    elif fc is not None and fc >= cfg.min_positive_crypto and fo is not None and fo >= cfg.min_positive_other:
        cls = "Cross-asset"
    elif fc is not None and fc >= cfg.min_positive_crypto:
        cls = "Crypto-general"
    else:
        cls = "Asset-specific"
    return {"assets": rows, "crypto_positive_fraction": fc, "other_positive_fraction": fo, "classification": cls}


def regime_breakdown(st: Strategy, ev: StrategyEvaluator, labels: np.ndarray | None,
                     descriptions: list[dict] | None, region: str = "search") -> dict:
    if labels is None:
        return {"available": False}
    s, e = ev.spec.split.segment(region)
    res, _ = ev.backtest(st, (s, e))
    lab = labels[s:e]
    g = np.log1p(np.maximum(res.returns, -0.999999))
    names = {d["regime"]: d.get("label", f"Regime {d['regime']}") for d in (descriptions or [])}
    total = float(g.sum())
    rows = []
    ks = sorted({int(x) for x in lab[np.isfinite(lab)]})
    for k in ks:
        m = lab == k
        inpos = m & (res.position != 0)
        entries = [t for t in res.trades if np.isfinite(labels[t.signal_idx]) and int(labels[t.signal_idx]) == k]
        rows.append({
            "regime": k,
            "label": names.get(k, f"Regime {k}"),
            "bars": int(m.sum()),
            "bars_in_position": int(inpos.sum()),
            "return": float(np.expm1(g[m].sum())),
            "share_of_log_growth": float(g[m].sum() / total) if total != 0 else None,
            "trades_entered": len(entries),
            "win_rate": float(np.mean([t.net_pnl > 0 for t in entries])) if entries else None,
        })
    works = [r["regime"] for r in rows if r["return"] > 0 and r["trades_entered"] >= 3]
    return {"available": True, "region": region, "regimes": rows, "works_in": works}
