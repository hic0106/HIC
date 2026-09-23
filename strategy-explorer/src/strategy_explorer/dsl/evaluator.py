"""Vectorised evaluation of typed expression trees over one MarketData context.

Sub-expressions are cached by canonical text, so thousands of candidate rules
that share building blocks (e.g. ``volume_zscore(20)``) compute them once.
Higher-timeframe sub-expressions are evaluated on resampled candles and joined
back on candle *close* time (see :mod:`..data.timeframes`).
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

import numpy as np

from ..data.market import MarketData
from ..data.timeframes import align_to_base, resample
from .nodes import Node, Strategy
from .registry import SIG_BY_KEY


class ArrayCache:
    def __init__(self, max_bytes: int = 256 * 2 ** 20):
        self.max_bytes = max_bytes
        self._d: OrderedDict[str, np.ndarray] = OrderedDict()
        self._bytes = 0

    def get(self, key: str):
        v = self._d.get(key)
        if v is not None:
            self._d.move_to_end(key)
        return v

    def put(self, key: str, value: np.ndarray) -> None:
        if key in self._d:
            return
        nb = int(getattr(value, "nbytes", 0))
        self._d[key] = value
        self._bytes += nb
        while self._bytes > self.max_bytes and len(self._d) > 1:
            _, old = self._d.popitem(last=False)
            self._bytes -= int(getattr(old, "nbytes", 0))

    def clear(self) -> None:
        self._d.clear()
        self._bytes = 0


@dataclass
class Signals:
    long_entry: np.ndarray
    long_exit: np.ndarray
    short_entry: np.ndarray
    short_exit: np.ndarray

    def as_dict(self) -> dict[str, np.ndarray]:
        return {"long_entry": self.long_entry, "long_exit": self.long_exit, "short_entry": self.short_entry,
                "short_exit": self.short_exit}


class EvalContext:
    """Evaluation context over one dataset (base timeframe or one higher timeframe)."""

    def __init__(self, md: MarketData, htf_timeframes: tuple[str, ...] = (), regime_model: Any = None,
                 pattern_library: Any = None, cache_bytes: int = 256 * 2 ** 20, _is_htf: bool = False):
        self.md = md
        self.o, self.h, self.l, self.c, self.v = md.open, md.high, md.low, md.close, md.volume
        self.ts = md.ts
        self.bar_ms = md.bar_ms
        self.n = len(md)
        self.htf_timeframes = tuple(htf_timeframes)
        self.regime_model = regime_model
        self.pattern_library = pattern_library
        self.cache = ArrayCache(cache_bytes)
        self._htf: dict[str, EvalContext] = {}
        self._is_htf = _is_htf
        self._regime: tuple[np.ndarray, np.ndarray] | None = None
        self._pattern_features: np.ndarray | None = None

    # ------------------------------------------------------------ data access
    def col(self, name: str) -> np.ndarray:
        return self.md.column(name)

    def htf(self, tf: str) -> "EvalContext":
        ctx = self._htf.get(tf)
        if ctx is None:
            if tf not in self.htf_timeframes:
                raise KeyError(f"timeframe {tf} not configured")
            ctx = EvalContext(resample(self.md, tf), (), None, None, self.cache.max_bytes // 4, _is_htf=True)
            self._htf[tf] = ctx
        return ctx

    def eval_htf(self, tf: str, node: Node) -> np.ndarray:
        sub = self.htf(tf)
        vals = np.asarray(sub.eval(node), dtype=np.float64)
        return align_to_base(self.md.close_ts, sub.md.close_ts, vals)

    def _regimes(self) -> tuple[np.ndarray, np.ndarray]:
        if self._regime is None:
            if self.regime_model is None:
                raise RuntimeError("no regime model in this context")
            probs, labels = self.regime_model.filter(self.md)
            self._regime = (probs, labels)
        return self._regime

    def regime_is(self, k: int) -> np.ndarray:
        _, labels = self._regimes()
        out = (labels == k).astype(np.float64)
        out[np.isnan(labels)] = np.nan
        return out

    def regime_prob(self, k: int) -> np.ndarray:
        probs, _ = self._regimes()
        return probs[:, int(k)].copy()

    def pattern_distance(self, pid: str) -> np.ndarray:
        if self.pattern_library is None:
            raise RuntimeError("no pattern library in this context")
        return self.pattern_library.distance(pid, self)

    # ------------------------------------------------------------- evaluation
    def eval(self, node: Node):
        if node.is_literal:
            return node.value
        key = node.text
        hit = self.cache.get(key)
        if hit is not None:
            return hit
        sig = SIG_BY_KEY.get(node.sig) if node.sig else None
        if sig is None:
            raise ValueError(f"node {key} is not type-checked (no signature)")
        if sig.lazy:
            args = [a.value if a.is_literal else a for a in node.args]
        else:
            args = [self.eval(a) for a in node.args]
        with np.errstate(all="ignore"):
            out = sig.impl(self, *args)
        out = np.array(out, dtype=np.float64, copy=True) if sig.category == "terminal" else \
            np.asarray(out, dtype=np.float64)
        if out.shape != (self.n,):
            out = np.broadcast_to(out, (self.n,)).astype(np.float64)
        out.setflags(write=False)
        self.cache.put(key, out)
        return out

    def eval_bool(self, node: Node | None) -> np.ndarray:
        if node is None:
            return np.zeros(self.n, dtype=bool)
        return np.asarray(self.eval(node)) == 1.0

    def signals(self, st: Strategy) -> Signals:
        return Signals(
            long_entry=self.eval_bool(st.long_entry),
            long_exit=self.eval_bool(st.long_exit),
            short_entry=self.eval_bool(st.short_entry),
            short_exit=self.eval_bool(st.short_exit),
        )


def warmup_bars(st: Strategy) -> int:
    """Upper bound on the look-back needed before a rule can fire (for reporting)."""
    from .nodes import iter_nodes

    mx = 1
    for _, root in st.slot_items():
        for _, n in iter_nodes(root):
            if n.op == "#window":
                mx = max(mx, int(n.value))
    return 5 * mx + 2
