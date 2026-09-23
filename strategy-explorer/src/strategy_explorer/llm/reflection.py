"""AI Reflection Loop: generation summaries built from TRAIN metrics only.

``TrainView`` is the only projection of a trial the reflection may read; it
has no field for validation, test or holdout results, so they cannot leak into
LLM prompts.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..dsl.complexity import max_window
from ..search.trials import EVALUATED, TrialRecord


@dataclass(frozen=True)
class TrainView:
    trial_id: int
    group: str
    family: str
    direction: str
    nodes: int
    lookback: int
    trigger: str
    robustness: float
    net_return: float
    gross_return: float
    turnover: float
    consistency: float
    trades: int


def train_view(r: TrialRecord) -> TrainView:
    m = r.is_metrics or {}
    st = r.strategy
    trig = "onset" if any(n.op == "ONSET" for _, n in st.slot_items()) else "level"
    return TrainView(
        trial_id=r.trial_id, group=r.group or "", family=r.family or "", direction=st.direction,
        nodes=r.complexity.nodes if r.complexity else 0, lookback=max_window(st), trigger=trig,
        robustness=float(r.robustness), net_return=float(m.get("total_return", 0.0) or 0.0),
        gross_return=float(m.get("gross_return", 0.0) or 0.0), turnover=float(m.get("turnover", 0.0) or 0.0),
        consistency=float(m.get("consistency", 0.0) or 0.0), trades=int(m.get("trades", 0) or 0),
    )


def _bucket_lookback(w: int) -> str:
    return "short lookbacks (<=10 bars)" if w <= 10 else ("medium lookbacks (11-50)" if w <= 50 else
                                                         "long lookbacks (>50)")


def _bucket_nodes(n: int) -> str:
    return "compact rules (<=6 nodes)" if n <= 6 else ("mid-size rules (7-12 nodes)" if n <= 12 else
                                                       "large rules (>12 nodes)")


def summarize(records: list[TrialRecord], min_group: int = 5) -> dict:
    views = [train_view(r) for r in records if r.status == EVALUATED and r.is_metrics and r.strategy]
    if not views:
        return {"n": 0, "rows": []}
    rob_all = np.array([v.robustness for v in views])
    turn_med = float(np.median([v.turnover for v in views]))
    q75, q50 = float(np.quantile(rob_all, 0.75)), float(np.median(rob_all))
    dims = {
        "feature group": lambda v: v.group,
        "lookback": lambda v: _bucket_lookback(v.lookback),
        "direction": lambda v: f"{v.direction} rules",
        "complexity": lambda v: _bucket_nodes(v.nodes),
        "trigger": lambda v: f"{v.trigger}-triggered entries",
    }
    rows = []
    for dim, key in dims.items():
        groups: dict[str, list[TrainView]] = {}
        for v in views:
            groups.setdefault(key(v), []).append(v)
        for name, vs in sorted(groups.items()):
            if len(vs) < min_group:
                continue
            rob = float(np.mean([v.robustness for v in vs]))
            net_pos = float(np.mean([v.net_return > 0 for v in vs]))
            gross_pos = float(np.mean([v.gross_return > 0 for v in vs]))
            turn = float(np.median([v.turnover for v in vs]))
            cons = float(np.mean([v.consistency for v in vs]))
            if rob >= q75 and net_pos >= 0.3:
                verdict = "promising"
            elif gross_pos >= 0.4 and net_pos < 0.5 * gross_pos:
                verdict = "fails after costs"
            elif turn > 2.0 * max(turn_med, 1e-9):
                verdict = "high turnover"
            elif cons < 0.4:
                verdict = "unstable across train sub-periods"
            elif rob < q50:
                verdict = "weak"
            else:
                verdict = "neutral"
            rows.append({"dimension": dim, "value": name, "n": len(vs), "mean_robustness": rob,
                         "positive_after_costs": net_pos, "positive_before_costs": gross_pos,
                         "median_turnover": turn, "mean_consistency": cons, "verdict": verdict})
    return {"n": len(views), "rows": rows, "robustness_q75": q75, "robustness_median": q50}


def summary_text(summary: dict, max_lines: int = 24) -> str:
    if not summary.get("rows"):
        return "No evaluated trials yet."
    lines = [f"{summary['n']} evaluated rules (TRAIN metrics, net of costs)."]
    rows = sorted(summary["rows"], key=lambda r: (-r["mean_robustness"], r["dimension"]))
    for r in rows[:max_lines]:
        lines.append(f"- {r['value']} [{r['dimension']}]: {r['verdict']} (n={r['n']}, robustness "
                     f"{r['mean_robustness']:.2f}, {100 * r['positive_after_costs']:.0f}% positive after costs vs "
                     f"{100 * r['positive_before_costs']:.0f}% before, median turnover {r['median_turnover']:.0f}/yr, "
                     f"sub-period consistency {r['mean_consistency']:.2f})")
    return "\n".join(lines)
