"""Final Holdout vault.

* The holdout window of a dataset is registered LOCKED when an experiment is
  created, together with a hash of its bars. The search process never
  receives those bars.
* It can be unsealed exactly once, only for candidates that passed every
  gate, and all such candidates are evaluated in that single unsealing.
* After unsealing the window is CONSUMED for that market (asset + timeframe,
  whatever the file or provider) forever - by database trigger. A modified strategy, or any later
  experiment, must use a new *prospective* window that starts after the last
  consumed window and waits until enough new bars exist.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..backtest.costs import CostModel
from ..backtest.engine import ExecConfig, run_backtest
from ..backtest.metrics import compute_metrics
from ..data.market import MarketData
from ..dsl.evaluator import EvalContext
from ..dsl.nodes import Strategy
from ..ledger.db import LedgerDB
from ..util import dumps, ms_to_iso, utc_now_iso
from .gate import RESEARCH_WINNER

LOCKED, CONSUMED = "LOCKED", "CONSUMED"
PROSPECTIVE_HASH = "PROSPECTIVE"


class HoldoutError(RuntimeError):
    pass


class HoldoutConsumedError(HoldoutError):
    pass


@dataclass
class HoldoutConfig:
    mode: str = "fixed"          # fixed | prospective
    auto_evaluate: bool = True
    min_bars: int = 100
    min_trades: int = 5


def dataset_key(source: str, asset: str, timeframe: str) -> str:
    """Holdout identity of a market. Real data is keyed by asset + timeframe only, so switching the file
    format or provider cannot be used to look at the same future period again. Synthetic data keeps its
    generator parameters (different synthetic worlds are different markets)."""
    src = (source or "").split("|")[0]
    if src.startswith("synthetic"):
        return f"{src}:{asset}:{timeframe}"
    return f"{asset}:{timeframe}"


def holdout_hash(md: MarketData, start: int, stop: int) -> str:
    return md.slice(start, stop).version()


class HoldoutVault:
    def __init__(self, db: LedgerDB, key: str):
        self.db = db
        self.key = key

    def windows(self) -> list[dict]:
        return self.db.query("SELECT * FROM holdout_registry WHERE dataset_key = ? ORDER BY window_start", [self.key])

    def consumed_until(self) -> int | None:
        rows = [w for w in self.windows() if w["status"] == CONSUMED]
        return max((int(w["window_end"]) for w in rows), default=None)

    def register(self, experiment_id: str, start_ms: int, end_ms: int, data_hash: str) -> dict:
        for w in self.windows():
            overlaps = not (end_ms < int(w["window_start"]) or start_ms > int(w["window_end"]))
            if w["status"] == CONSUMED and overlaps:
                raise HoldoutConsumedError(
                    f"holdout window {ms_to_iso(start_ms)}..{ms_to_iso(end_ms)} overlaps a window consumed by "
                    f"experiment {w['consumed_by']} on {w['consumed_at']}. Use holdout.mode = 'prospective' "
                    f"(new data after {ms_to_iso(int(w['window_end']))}).")
        row = self.db.query_one("SELECT * FROM holdout_registry WHERE dataset_key = ? AND window_start = ?",
                                [self.key, int(start_ms)])
        if row is None:
            self.db.execute("INSERT INTO holdout_registry (dataset_key, window_start, window_end, data_hash, status, "
                            "registered_by) VALUES (?, ?, ?, ?, ?, ?)",
                            [self.key, int(start_ms), int(end_ms), data_hash, LOCKED, experiment_id])
            row = self.db.query_one("SELECT * FROM holdout_registry WHERE dataset_key = ? AND window_start = ?",
                                    [self.key, int(start_ms)])
        return row

    def status(self, start_ms: int) -> dict | None:
        return self.db.query_one("SELECT * FROM holdout_registry WHERE dataset_key = ? AND window_start = ?",
                                 [self.key, int(start_ms)])

    def unseal(self, experiment_id: str, start_ms: int, candidates: list[dict], load_full: callable,
               htf: tuple[str, ...], costs: CostModel, ex: ExecConfig, regime_model=None, pattern_library=None,
               cfg: HoldoutConfig | None = None) -> list[dict]:
        """Evaluate every RESEARCH_WINNER once. ``candidates``: dicts with candidate_id, strategy, status."""
        cfg = cfg or HoldoutConfig()
        row = self.status(start_ms)
        if row is None:
            raise HoldoutError("holdout window is not registered")
        if row["status"] != LOCKED:
            raise HoldoutConsumedError(f"holdout already consumed by {row['consumed_by']} at {row['consumed_at']}")
        bad = [c["candidate_id"] for c in candidates if c.get("status") != RESEARCH_WINNER]
        if bad:
            raise HoldoutError(f"only candidates that passed every gate may see the holdout (rejected: {bad})")
        if not candidates:
            raise HoldoutError("no eligible candidates; the holdout stays locked")
        md: MarketData = load_full()
        start = md.index_of_ts(int(start_ms), "left")
        stop = len(md)
        if row["data_hash"] != PROSPECTIVE_HASH:
            stop = md.index_of_ts(int(row["window_end"]), "right")
            if holdout_hash(md, start, stop) != row["data_hash"]:
                raise HoldoutError("holdout data changed since registration; refusing to evaluate")
        if stop - start < cfg.min_bars:
            raise HoldoutError(f"only {stop - start} holdout bars available; need {cfg.min_bars} (awaiting data)")
        md = md.slice(0, stop)
        ctx = EvalContext(md, htf, regime_model, pattern_library)
        results = []
        for c in candidates:
            st: Strategy = c["strategy"]
            sig = ctx.signals(st)
            res = run_backtest(md, sig, st, start, stop, costs, ex)
            m = compute_metrics(res, md.ts[start:stop], md.periods_per_year(), 6, ex.leverage)
            n_tr = int(m.get("trades", 0))
            if n_tr < cfg.min_trades:
                verdict = "HOLDOUT_INCONCLUSIVE"
            elif m.get("total_return", 0) > 0 and m.get("expectancy", 0) > 0:
                verdict = "HOLDOUT_PASSED"
            else:
                verdict = "HOLDOUT_FAILED"
            out = {"candidate_id": c["candidate_id"], "strategy_hash": st.hash, "verdict": verdict, "metrics": m,
                   "window": {"start": ms_to_iso(int(md.ts[start])), "end": ms_to_iso(int(md.ts[stop - 1])),
                              "bars": stop - start}}
            results.append(out)
        # all-or-nothing: re-check the lock inside one write transaction, record every result, consume the window
        con = self.db._conn()
        con.execute("BEGIN IMMEDIATE")
        try:
            cur = con.execute("SELECT status FROM holdout_registry WHERE dataset_key = ? AND window_start = ?",
                              [self.key, int(start_ms)]).fetchone()
            if cur is None or cur[0] != LOCKED:
                raise HoldoutConsumedError("holdout was consumed concurrently")
            now = utc_now_iso()
            for out in results:
                con.execute("INSERT INTO holdout_evaluations (dataset_key, window_start, window_end, experiment_id, "
                            "candidate_id, strategy_hash, result_json, passed, evaluated_at) "
                            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            [self.key, int(start_ms), int(md.ts[stop - 1]), experiment_id, out["candidate_id"],
                             out["strategy_hash"], dumps(out), int(out["verdict"] == "HOLDOUT_PASSED"), now])
            con.execute("UPDATE holdout_registry SET status = ?, consumed_by = ?, consumed_at = ?, window_end = ? "
                        "WHERE dataset_key = ? AND window_start = ?",
                        [CONSUMED, experiment_id, now, int(md.ts[stop - 1]), self.key, int(start_ms)])
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise
        return results
