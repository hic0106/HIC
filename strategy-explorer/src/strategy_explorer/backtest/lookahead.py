"""Look-ahead detection by truncation.

A causal rule must produce, at bar t, the same value whether or not bars
after t exist. The test re-evaluates every rule slot on data truncated at
random cut points and compares the trailing values with the full-data values.
Any difference (including known/unknown status) marks the strategy INVALID.
This is implementation-agnostic: it catches look-ahead in primitives,
multi-timeframe joins, regime filtering and pattern features alike.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np

from ..data.market import MarketData
from ..dsl.evaluator import EvalContext
from ..dsl.nodes import Strategy
from ..util import derive_rng


@dataclass
class LookaheadReport:
    valid: bool
    cuts: list[int] = field(default_factory=list)
    mismatches: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _same(a: np.ndarray, b: np.ndarray) -> bool:
    both_nan = np.isnan(a) & np.isnan(b)
    return bool(np.all(both_nan | (a == b)))


def truncation_test(st: Strategy, md: MarketData, htf_timeframes: tuple[str, ...] = (), regime_model=None,
                    pattern_library=None, n_cuts: int = 6, tail: int = 8, seed: int = 0,
                    min_index: int = 50) -> LookaheadReport:
    n = len(md)
    lo, hi = max(min_index, tail + 1), n - 2
    if hi <= lo:
        return LookaheadReport(valid=True)
    rng = derive_rng(seed, "lookahead", st.hash)
    k = min(n_cuts, hi - lo)
    cuts = sorted(int(x) for x in rng.choice(np.arange(lo, hi), size=k, replace=False))
    # always include the last-but-one bar and an early cut
    cuts = sorted(set(cuts) | {hi - 1, lo})
    full_ctx = EvalContext(md, htf_timeframes, regime_model, pattern_library)
    full = {slot: np.asarray(full_ctx.eval(node), dtype=np.float64) for slot, node in st.slot_items()}
    mismatches = []
    for cut in cuts:
        sub = EvalContext(md.slice(0, cut + 1), htf_timeframes, regime_model, pattern_library)
        for slot, node in st.slot_items():
            part = np.asarray(sub.eval(node), dtype=np.float64)
            a = full[slot][cut - tail + 1:cut + 1]
            b = part[cut - tail + 1:cut + 1]
            if not _same(a, b):
                diff = np.flatnonzero(~((np.isnan(a) & np.isnan(b)) | (a == b)))
                mismatches.append({"cut": cut, "slot": slot, "first_bad_index": int(cut - tail + 1 + diff[0]),
                                   "full": float(a[diff[0]]) if np.isfinite(a[diff[0]]) else None,
                                   "truncated": float(b[diff[0]]) if np.isfinite(b[diff[0]]) else None})
    return LookaheadReport(valid=not mismatches, cuts=cuts, mismatches=mismatches[:20])
