"""Stress tests on the out-of-sample region: higher fees and slippage, one bar
of extra signal delay, adverse entry prices and randomly missed trades."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..dsl.nodes import Strategy
from ..search.evaluation import StrategyEvaluator
from .common import safe_metric


@dataclass
class StressConfig:
    region: str = "validation+test"
    fee_multipliers: tuple[float, ...] = (1.0, 1.5, 2.0)
    slippage_multipliers: tuple[float, ...] = (1.0, 2.0)
    delay_bars: tuple[int, ...] = (1,)
    adverse_entry_bps: tuple[float, ...] = (5.0, 10.0)
    missed_trade_prob: float = 0.1
    mc_runs: int = 40
    required: tuple[str, ...] = ("fee_x2", "slippage_x2", "fee_x2_slippage_x2", "delay_1", "adverse_5bps")
    mc_min_positive: float = 0.8


def stress_test(st: Strategy, ev: StrategyEvaluator, cfg: StressConfig | None = None, seed: int = 0) -> dict:
    cfg = cfg or StressConfig()
    sig = ev.signals(st)
    costs, ex = ev.spec.costs, ev.spec.exec_cfg
    scenarios = {}

    def run(name, c=None, e=None):
        _, m = ev.backtest(st, cfg.region, sig, costs=c or costs, ex=e or ex)
        scenarios[name] = {"total_return": m.get("total_return"), "sharpe": m.get("sharpe"),
                           "trades": m.get("trades"), "expectancy": m.get("expectancy"),
                           "max_drawdown": m.get("max_drawdown"), "profit_factor": m.get("profit_factor")}

    run("base")
    for f in cfg.fee_multipliers:
        if f != 1.0:
            run(f"fee_x{f:g}", costs.scaled(fee=f))
    for s in cfg.slippage_multipliers:
        if s != 1.0:
            run(f"slippage_x{s:g}", costs.scaled(slippage=s))
    run("fee_x2_slippage_x2", costs.scaled(fee=2.0, slippage=2.0))
    for d in cfg.delay_bars:
        run(f"delay_{d}", e=ex.replace(signal_delay=ex.signal_delay + d))
    for a in cfg.adverse_entry_bps:
        run(f"adverse_{a:g}bps", e=ex.replace(adverse_entry_bps=a))
    mc = []
    for i in range(cfg.mc_runs):
        _, m = ev.backtest(st, cfg.region, sig,
                           ex=ex.replace(missed_trade_prob=cfg.missed_trade_prob, missed_trade_seed=seed * 1000 + i))
        mc.append(safe_metric(m, "total_return"))
    mc_arr = np.array(mc)
    missed = {"prob": cfg.missed_trade_prob, "runs": cfg.mc_runs,
              "positive_fraction": float(np.mean(mc_arr > 0)) if mc_arr.size else 0.0,
              "median_return": float(np.median(mc_arr)) if mc_arr.size else 0.0,
              "p05_return": float(np.quantile(mc_arr, 0.05)) if mc_arr.size else 0.0}
    checks = {name: safe_metric(scenarios.get(name), "total_return", -1.0) > 0 for name in cfg.required
              if name in scenarios}
    passed = all(checks.values()) and missed["positive_fraction"] >= cfg.mc_min_positive
    return {"region": cfg.region, "scenarios": scenarios, "missed_trades": missed, "required": checks,
            "cost_survival": bool(checks.get("fee_x2", True) and checks.get("slippage_x2", True)
                                  and checks.get("fee_x2_slippage_x2", True)),
            "passed": bool(passed)}
