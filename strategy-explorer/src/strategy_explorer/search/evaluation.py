"""Deterministic candidate evaluation (optionally in a CPU process pool).

Each candidate is evaluated on the TRAIN segment (search fitness) and on the
VALIDATION segment (recorded in the ledger; used only after the search for
selection statistics). TEST and FINAL HOLDOUT are never touched here.
"""

from __future__ import annotations

import multiprocessing as mp
import os
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field

import numpy as np

from ..backtest.costs import CostModel
from ..backtest.engine import BacktestResult, ExecConfig, run_backtest
from ..backtest.metrics import compute_metrics
from ..data.market import MarketData
from ..data.splits import SplitPlan
from ..dsl.evaluator import EvalContext, Signals
from ..dsl.nodes import Strategy
from ..dsl.registry import Registry
from ..dsl.typecheck import TypeChecker
from ..util import sha256_text
from .novelty import behavior_vectors


@dataclass
class SearchSpec:
    """Everything a worker needs; picklable."""

    md: MarketData
    split: SplitPlan
    costs: CostModel
    exec_cfg: ExecConfig
    htf: tuple[str, ...] = ()
    registry_kwargs: dict = field(default_factory=dict)
    regime_model: object | None = None
    pattern_library: object | None = None
    n_blocks: int = 6
    behavior_dim: int = 256
    max_nodes: int = 60
    max_depth: int = 10
    cache_mb: int = 384

    def registry(self) -> Registry:
        return Registry(**self.registry_kwargs)


@dataclass
class EvalResult:
    ok: bool
    error: str | None = None
    is_metrics: dict | None = None
    oos_metrics: dict | None = None
    behavior_pos: np.ndarray | None = None
    behavior_ret: np.ndarray | None = None
    behavior_hash: str | None = None
    entry_rate: float = 0.0
    elapsed: float = 0.0


class StrategyEvaluator:
    def __init__(self, spec: SearchSpec):
        self.spec = spec
        self.ctx = EvalContext(spec.md, spec.htf, spec.regime_model, spec.pattern_library,
                               cache_bytes=spec.cache_mb * 2 ** 20)
        self.registry = spec.registry()
        self.checker = TypeChecker(self.registry, spec.max_nodes, spec.max_depth)
        self.ppy = spec.md.periods_per_year()
        # Hard guarantee: the evaluation context never contains FINAL HOLDOUT bars.
        if len(spec.md) > spec.split.holdout_start:
            raise RuntimeError("search data must not include the final holdout segment")
        self.max_ts_seen = int(spec.md.ts[-1]) if len(spec.md) else None

    def signals(self, st: Strategy) -> Signals:
        return self.ctx.signals(st)

    def segment_bounds(self, segment: str | tuple[int, int]) -> tuple[int, int]:
        if isinstance(segment, tuple):
            return segment
        if segment == "holdout":
            raise PermissionError("the search evaluator has no access to the final holdout")
        return self.spec.split.segment(segment)

    def backtest(self, st: Strategy, segment: str | tuple[int, int], sig: Signals | None = None,
                 costs: CostModel | None = None, ex: ExecConfig | None = None,
                 md: MarketData | None = None) -> tuple[BacktestResult, dict]:
        md = md or self.spec.md
        sig = sig if sig is not None else self.signals(st)
        s, e = self.segment_bounds(segment)
        ex = ex or self.spec.exec_cfg
        res = run_backtest(md, sig, st, s, e, costs or self.spec.costs, ex)
        m = compute_metrics(res, md.ts[s:e], self.ppy, self.spec.n_blocks, ex.leverage)
        return res, m

    def evaluate(self, st: Strategy) -> EvalResult:
        t0 = time.perf_counter()
        try:
            sig = self.signals(st)
            tr_res, is_m = self.backtest(st, "train", sig)
            _, oos_m = self.backtest(st, "validation", sig)
            pv, rv = behavior_vectors(tr_res.position, tr_res.returns, self.spec.behavior_dim)
            bh = sha256_text(tr_res.position.tobytes().hex())[:20] if tr_res.trades else None
            s, e = self.spec.split.train
            entry = sig.long_entry[s:e] | sig.short_entry[s:e]
            return EvalResult(ok=True, is_metrics=is_m, oos_metrics=oos_m, behavior_pos=pv, behavior_ret=rv,
                              behavior_hash=bh, entry_rate=float(entry.mean()) if e > s else 0.0,
                              elapsed=time.perf_counter() - t0)
        except Exception as exc:  # recorded as an ERROR trial, never silently dropped
            return EvalResult(ok=False, error=f"{type(exc).__name__}: {exc}", elapsed=time.perf_counter() - t0)

    def evaluate_text(self, text: str) -> EvalResult:
        from ..dsl.parser import parse_strategy

        st = self.checker.check_strategy(parse_strategy(text))
        return self.evaluate(st)


# ----------------------------------------------------------------- process pool
_WORKER: StrategyEvaluator | None = None


def _init_worker(spec: SearchSpec) -> None:
    global _WORKER
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    _WORKER = StrategyEvaluator(spec)


def _eval_in_worker(text: str) -> EvalResult:
    assert _WORKER is not None
    try:
        return _WORKER.evaluate_text(text)
    except Exception as exc:
        return EvalResult(ok=False, error=f"{type(exc).__name__}: {exc}")


class EvaluatorPool:
    """Evaluates batches of strategies; results are order-preserving and independent of worker count."""

    def __init__(self, spec: SearchSpec, workers: int = 1):
        self.local = StrategyEvaluator(spec)
        self.workers = max(1, int(workers))
        self._pool: ProcessPoolExecutor | None = None
        self.spec = spec

    def _ensure_pool(self) -> ProcessPoolExecutor:
        if self._pool is None:
            method = "fork" if "fork" in mp.get_all_start_methods() else "spawn"
            self._pool = ProcessPoolExecutor(max_workers=self.workers, mp_context=mp.get_context(method),
                                             initializer=_init_worker, initargs=(self.spec,))
        return self._pool

    def evaluate(self, strategies: list[Strategy]) -> list[EvalResult]:
        if not strategies:
            return []
        if self.workers <= 1 or len(strategies) < 4:
            return [self.local.evaluate(s) for s in strategies]
        pool = self._ensure_pool()
        texts = [s.text for s in strategies]
        chunk = max(1, len(texts) // (self.workers * 4))
        return list(pool.map(_eval_in_worker, texts, chunksize=chunk))

    def close(self) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=True, cancel_futures=True)
            self._pool = None


def default_workers(requested: int | None) -> int:
    if requested and requested > 0:
        return int(requested)
    return max(1, (os.cpu_count() or 2) - 1)
