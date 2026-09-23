"""Strategy Robustness Gate.

A candidate becomes a RESEARCH_WINNER only if every check passes. Thresholds
come from the configuration. Critical failures (look-ahead, no out-of-sample
edge, no cost survival, cost-free assumptions) reject the candidate outright.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .common import safe_metric

RESEARCH_WINNER, PROMISING, REJECTED = "RESEARCH_WINNER", "PROMISING", "REJECTED"
CRITICAL = ("no_lookahead", "positive_oos_expectation", "transaction_cost_survival", "costs_modelled")


@dataclass
class GateConfig:
    min_oos_trades: int = 15
    min_train_trades: int = 20
    max_oos_drawdown: float = 0.35
    dsr_min: float = 0.95
    pbo_max: float = 0.30
    candidate_pbo_max: float | None = None   # neighbourhood PBO is diagnostic unless a threshold is set
    max_trade_share: float = 0.50
    max_month_share: float = 0.50
    concentration_warn_levels: tuple[float, ...] = (0.3, 0.4, 0.5)
    promising_min_pass_fraction: float = 0.7

    def to_dict(self) -> dict:
        return asdict(self)


def _check(name: str, passed: bool, value, threshold, detail: str = "") -> dict:
    return {"name": name, "passed": bool(passed), "value": value, "threshold": threshold, "detail": detail}


def evaluate_gate(v: dict, cfg: GateConfig) -> dict:
    """``v`` is the validation bundle produced by the pipeline for one candidate."""
    oos = v.get("oos", {})
    test = v.get("test", {})
    train = v.get("train", {})
    checks = []
    exp = safe_metric(oos, "expectancy")
    checks.append(_check("positive_oos_expectation", exp > 0 and safe_metric(test, "total_return") > 0,
                         {"oos_expectancy": exp, "test_return": safe_metric(test, "total_return")}, "> 0",
                         "validation+test expectancy and test-segment return must be positive"))
    ntr = int(oos.get("trades", 0) or 0)
    checks.append(_check("minimum_trade_count", ntr >= cfg.min_oos_trades and
                         int(train.get("trades", 0) or 0) >= cfg.min_train_trades,
                         {"oos_trades": ntr, "train_trades": train.get("trades")},
                         {"oos": cfg.min_oos_trades, "train": cfg.min_train_trades}))
    mdd = safe_metric(oos, "max_drawdown", -1.0)
    checks.append(_check("acceptable_drawdown", mdd >= -cfg.max_oos_drawdown, mdd, -cfg.max_oos_drawdown))
    stress = v.get("stress", {})
    checks.append(_check("transaction_cost_survival", bool(stress.get("cost_survival")),
                         {k: stress.get("scenarios", {}).get(k, {}).get("total_return")
                          for k in ("fee_x2", "slippage_x2", "fee_x2_slippage_x2")}, "> 0 under 2x costs"))
    checks.append(_check("stress_survival", bool(stress.get("passed")),
                         {"required": stress.get("required"),
                          "missed_trades_positive": stress.get("missed_trades", {}).get("positive_fraction")},
                         "all required scenarios > 0"))
    sens = v.get("sensitivity", {})
    checks.append(_check("parameter_stability", bool(sens.get("passed")),
                         {"selection": sens.get("train+validation"), "test": sens.get("test")},
                         "neighbourhood keeps the edge"))
    wf = v.get("walk_forward", {})
    checks.append(_check("walk_forward_survival", bool(wf.get("passed")),
                         {"positive_fraction": wf.get("positive_fraction"),
                          "compounded": wf.get("compounded_oos_return")}, "multiple OOS folds positive"))
    dsr = v.get("dsr", {}).get("dsr")
    checks.append(_check("deflated_sharpe", dsr is not None and dsr >= cfg.dsr_min, dsr, cfg.dsr_min,
                         f"segment {v.get('dsr', {}).get('segment')}, N = {v.get('dsr', {}).get('n_trials')} "
                         f"({v.get('dsr', {}).get('n_basis')})"))
    pbo_e = v.get("pbo_experiment", {}).get("pbo")
    pbo_c = v.get("pbo_candidate", {}).get("pbo")
    pbo_ok = (pbo_e is not None and pbo_e <= cfg.pbo_max) and \
        (cfg.candidate_pbo_max is None or pbo_c is None or pbo_c <= cfg.candidate_pbo_max)
    checks.append(_check("pbo", pbo_ok, {"experiment": pbo_e, "candidate": pbo_c},
                         {"experiment": cfg.pbo_max, "candidate": cfg.candidate_pbo_max}))
    la = v.get("lookahead", {})
    checks.append(_check("no_lookahead", bool(la.get("valid")), len(la.get("mismatches", [])), 0))
    conc = v.get("concentration", {})
    ts_ = max(safe_metric(conc, "oos_best_trade_share"), safe_metric(conc, "full_best_trade_share"))
    ms_ = max(safe_metric(conc, "oos_best_month_share"), safe_metric(conc, "full_best_month_share"))
    checks.append(_check("no_single_trade_dominance", ts_ <= cfg.max_trade_share, ts_, cfg.max_trade_share))
    checks.append(_check("no_single_month_dominance", ms_ <= cfg.max_month_share, ms_, cfg.max_month_share))
    checks.append(_check("costs_modelled", not v.get("costless", False), v.get("cost_model"),
                         "fee or slippage > 0"))
    warnings = []
    # report the highest warning level reached
    for lvl in sorted(cfg.concentration_warn_levels, reverse=True):
        if ts_ >= lvl:
            warnings.append(f"CONCENTRATION_WARNING: one trade = {ts_:.0%} of net profit (>= {lvl:.0%})")
            break
    for lvl in sorted(cfg.concentration_warn_levels, reverse=True):
        if ms_ >= lvl:
            warnings.append(f"CONCENTRATION_WARNING: one month = {ms_:.0%} of net profit (>= {lvl:.0%})")
            break
    passed = [c for c in checks if c["passed"]]
    critical_fail = [c["name"] for c in checks if c["name"] in CRITICAL and not c["passed"]]
    frac = len(passed) / len(checks)
    if len(passed) == len(checks):
        status = RESEARCH_WINNER
    elif critical_fail or frac < cfg.promising_min_pass_fraction:
        status = REJECTED
    else:
        status = PROMISING
    return {"checks": checks, "passed_all": len(passed) == len(checks), "pass_fraction": frac,
            "critical_failures": critical_fail, "warnings": warnings, "status": status}


def full_robustness_score(v: dict, gate: dict) -> float:
    """Post-validation Robustness Score in [0, 1] (leaderboard sort key for candidates)."""
    parts = [
        gate.get("pass_fraction", 0.0),
        min(1.0, max(0.0, v.get("walk_forward", {}).get("positive_fraction", 0.0))),
        min(1.0, max(0.0, v.get("dsr", {}).get("dsr") or 0.0)),
        1.0 - min(1.0, max(0.0, v.get("pbo_experiment", {}).get("pbo") if
                           v.get("pbo_experiment", {}).get("pbo") is not None else 1.0)),
        min(1.0, max(0.0, v.get("sensitivity", {}).get("train+validation", {}).get("positive_fraction", 0.0))),
        min(1.0, max(0.0, v.get("stress", {}).get("missed_trades", {}).get("positive_fraction", 0.0))),
    ]
    return float(sum(parts) / len(parts))
