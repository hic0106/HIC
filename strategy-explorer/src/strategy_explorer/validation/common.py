"""Helpers shared by the validators: parameter neighbourhoods and segment backtests."""

from __future__ import annotations

import numpy as np

from ..dsl.complexity import Param, parameters, set_param
from ..dsl.nodes import Strategy, get_at
from ..search.evaluation import StrategyEvaluator

MULTS = (0.8, 0.9, 1.1, 1.2)
QSHIFTS = (-0.1, -0.05, 0.05, 0.1)


def _lhs_for(st: Strategy, p: Param):
    slot, _, rest = p.path.partition("/")
    idx = tuple(int(x) for x in rest.split("/")) if rest else ()
    parent = get_at(st.slot(slot), idx[:-1])
    if parent.args and not parent.args[0].is_literal:
        return parent.args[0]
    return None


def neighbor_values(st: Strategy, p: Param, ev: StrategyEvaluator, window: tuple[int, int],
                    mults: tuple[float, ...] = MULTS, qshifts: tuple[float, ...] = QSHIFTS) -> list[float]:
    v = float(p.value)
    if p.kind == "window":
        lo = int(p.min_value or 1)
        vals = sorted({max(lo, int(round(v * m))) for m in mults} - {int(v)})
        return [float(x) for x in vals]
    if p.kind in ("max_hold",):
        return [float(x) for x in sorted({max(1, int(round(v * m))) for m in mults} - {int(v)})]
    if p.kind in ("stop_loss", "take_profit"):
        return [float(f"{v * m:.4g}") for m in mults]
    if p.kind == "quantile":
        return [float(np.clip(v + dq, 0.02, 0.98)) for dq in qshifts]
    lhs = _lhs_for(st, p)
    if lhs is not None:
        s, e = window
        vals = np.asarray(ev.ctx.eval(lhs), dtype=np.float64)[s:e]
        vals = np.sort(vals[np.isfinite(vals)])
        if vals.size >= 20 and vals[0] != vals[-1]:
            q0 = float(np.searchsorted(vals, v) / vals.size)
            out = []
            for dq in qshifts:
                x = float(np.quantile(vals, float(np.clip(q0 + dq, 0.001, 0.999))))
                x = float(f"{x:.4g}")
                if x != v:
                    out.append(x)
            if out:
                return sorted(set(out))
    if abs(v) > 1e-9:
        return [float(f"{v * m:.4g}") for m in mults]
    return [-0.001, 0.001]


def neighborhood(st: Strategy, ev: StrategyEvaluator, window: tuple[int, int],
                 max_variants: int = 40) -> list[tuple[Param, float, Strategy]]:
    out = []
    for p in parameters(st):
        for val in neighbor_values(st, p, ev, window):
            try:
                st2 = set_param(st, p.path, val, ev.registry.max_window)
            except (ValueError, KeyError):
                continue
            if st2.text != st.text:
                out.append((p, val, st2))
    return out[:max_variants]


def safe_metric(m: dict | None, key: str, default: float = 0.0) -> float:
    if not m:
        return default
    v = m.get(key, default)
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if np.isfinite(f) else default
