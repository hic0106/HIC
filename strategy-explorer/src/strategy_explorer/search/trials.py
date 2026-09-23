"""TrialManager - the single gateway through which every candidate (GP, MCTS,
LLM, pattern templates) is compiled, de-duplicated, budget-checked,
evaluated and written to the append-only Trial Ledger.

Search algorithms receive :class:`TrialRecord` objects that contain TRAIN
metrics only. Validation metrics stay inside the manager until the search is
closed (``close_search``); asking for them earlier raises.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from ..backtest.costs import CostModel
from ..dsl.complexity import Complexity, complexity, parameters
from ..dsl.nodes import Strategy
from ..dsl.parser import parse_strategy
from ..dsl.typecheck import TypeChecker
from ..dsl.types import DSLSyntaxError, DSLTypeError
from ..ledger.db import LedgerDB
from ..util import utc_now_iso
from .budget import EXPLORE, SearchBudget
from .evaluation import EvalResult, EvaluatorPool
from .families import family, group
from .novelty import NoveltyArchive, NoveltyInfo, novelty_penalty
from .objectives import ConstraintConfig, RobustnessWeights, robustness_score, violation

EVALUATED, NO_TRADES, ERROR = "EVALUATED", "NO_TRADES", "ERROR"
DUPLICATE, DUPLICATE_BEHAVIOR, INVALID_DSL = "DUPLICATE", "DUPLICATE_BEHAVIOR", "INVALID_DSL"
NEAR_DUPLICATE_TAG = "NEAR_DUPLICATE"
EVALUATED_STATUSES = (EVALUATED, NO_TRADES, DUPLICATE_BEHAVIOR, ERROR)


@dataclass
class Proposal:
    strategy: Strategy | None = None
    text: str | None = None
    creation_method: str = "GP"
    operator: str | None = None
    phase: str = EXPLORE
    parents: tuple[int, ...] = ()
    generation: int = 0
    meta: dict = field(default_factory=dict)


@dataclass
class TrialRecord:
    trial_id: int
    seq: int
    strategy: Strategy | None
    hash: str | None
    status: str
    creation_method: str
    operator: str | None
    phase: str
    generation: int
    parents: tuple[int, ...]
    family: str | None
    group: str | None
    is_metrics: dict | None
    complexity: Complexity | None
    robustness: float
    violation: float
    novelty: NoveltyInfo | None = None
    duplicate_of: int | None = None
    error: str | None = None
    tags: tuple[str, ...] = ()
    meta: dict = field(default_factory=dict)

    @property
    def feasible(self) -> bool:
        return self.violation <= 0


@dataclass
class ManagerConfig:
    max_nodes: int = 60
    max_depth: int = 10
    near_duplicate: float = 0.95
    novelty_max_penalty: float = 0.5
    max_proposals_factor: int = 20


class TrialManager:
    def __init__(self, db: LedgerDB, experiment_id: str, budget: SearchBudget, pool: EvaluatorPool,
                 checker: TypeChecker, costs: CostModel, constraints: ConstraintConfig,
                 cfg: ManagerConfig | None = None, weights: RobustnessWeights | None = None,
                 memory_factor: Callable[[str], float] | None = None, behavior_dim: int = 256,
                 on_progress: Callable[[], None] | None = None):
        self.db = db
        self.experiment_id = experiment_id
        self.budget = budget
        self.pool = pool
        self.checker = checker
        self.costs = costs
        self.constraints = constraints
        self.cfg = cfg or ManagerConfig()
        self.weights = weights or RobustnessWeights()
        self.memory_factor = memory_factor or (lambda fam: 1.0)
        self.archive = NoveltyArchive(dim=behavior_dim)
        self.by_hash: dict[str, TrialRecord] = {}
        self.records: list[TrialRecord] = []
        self._oos: dict[int, dict] = {}
        self._seq = 0
        self.proposals_seen = 0
        self.rejected_budget = 0
        self.search_closed = False
        self.on_progress = on_progress
        self.method_counts: dict[str, int] = {}

    # ------------------------------------------------------------ helpers
    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def _base_row(self, p: Proposal, seq: int) -> dict:
        return {
            "experiment_id": self.experiment_id,
            "seq": seq,
            "parent_trial": p.parents[0] if p.parents else None,
            "parents_json": list(p.parents),
            "generation": p.generation,
            "creation_method": p.creation_method,
            "operator": p.operator,
            "phase": p.phase,
            "cost_json": self.costs.to_dict(),
            "meta_json": p.meta,
            "created_at": utc_now_iso(),
        }

    def oos_metrics(self, trial_id: int) -> dict | None:
        if not self.search_closed:
            raise PermissionError("validation metrics are sealed until the search budget is closed")
        return self._oos.get(trial_id)

    def close_search(self) -> None:
        self.search_closed = True
        self.pool.close()

    # ------------------------------------------------------------- submit
    def compile(self, text: str) -> Strategy:
        return self.checker.check_strategy(parse_strategy(text))

    def submit(self, proposals: list[Proposal]) -> list[TrialRecord | None]:
        if self.search_closed:
            raise RuntimeError("search is closed; no further trials may be evaluated")
        out: list[TrialRecord | None] = [None] * len(proposals)
        pending_rows: list[tuple[int, dict]] = []
        to_eval: list[tuple[int, Strategy, Proposal, int]] = []
        batch_first: dict[str, int] = {}
        in_batch_dups: list[tuple[int, Proposal, str, int]] = []
        for i, p in enumerate(proposals):
            self.proposals_seen += 1
            st = p.strategy
            if st is None:
                text = p.text or ""
                try:
                    st = self.compile(text)
                except (DSLSyntaxError, DSLTypeError, ValueError) as exc:
                    seq = self._next_seq()
                    row = self._base_row(p, seq)
                    row.update(dsl=text[:8000], status=INVALID_DSL, counts_toward_budget=0, error=str(exc)[:1000])
                    pending_rows.append((i, row))
                    continue
            else:
                try:
                    st = self.checker.check_strategy(st)
                except (DSLTypeError, ValueError):
                    continue
            h = st.hash
            if h in self.by_hash:
                seq = self._next_seq()
                prev = self.by_hash[h]
                row = self._base_row(p, seq)
                row.update(dsl=st.text, strategy_hash=h, status=DUPLICATE, counts_toward_budget=0,
                           duplicate_of=prev.trial_id)
                pending_rows.append((i, row))
                out[i] = prev
                continue
            if h in batch_first:
                in_batch_dups.append((i, p, h, self._next_seq()))
                continue
            if not self.budget.can_spend(p.phase):
                self.rejected_budget += 1
                continue
            self.budget.spend(p.phase)
            batch_first[h] = i
            to_eval.append((i, st, p, self._next_seq()))

        results = self.pool.evaluate([st for _, st, _, _ in to_eval])
        eval_rows: list[tuple[int, dict, Strategy, Proposal, EvalResult, dict]] = []
        batch_behavior: dict[str, int] = {}
        for (i, st, p, seq), res in zip(to_eval, results):
            cx = complexity(st)
            row = self._base_row(p, seq)
            fam, grp = family(st), group(st)
            info: NoveltyInfo | None = None
            dup_of = None
            tags: list[str] = []
            if not res.ok:
                status = ERROR
                is_m = oos_m = None
            else:
                is_m, oos_m = res.is_metrics, res.oos_metrics
                status = EVALUATED if is_m.get("trades", 0) > 0 else NO_TRADES
                if res.behavior_hash and res.behavior_hash in self.archive.by_hash:
                    status = DUPLICATE_BEHAVIOR
                    dup_of = self.archive.by_hash[res.behavior_hash]
                elif res.behavior_hash and res.behavior_hash in batch_behavior:
                    status = DUPLICATE_BEHAVIOR
                    dup_of = -batch_behavior[res.behavior_hash]  # resolved after insert
                elif status == EVALUATED:
                    info = self.archive.query(res.behavior_pos, res.behavior_ret)
                    if info.max_similarity >= self.cfg.near_duplicate:
                        tags.append(NEAR_DUPLICATE_TAG)
                    if res.behavior_hash:
                        batch_behavior[res.behavior_hash] = seq
            rob = robustness_score(is_m, cx, self.constraints.min_trades, self.weights) if is_m else 0.0
            if info is not None:
                rob *= 1.0 - novelty_penalty(info, self.cfg.near_duplicate - 0.1, self.cfg.novelty_max_penalty)
            mf = self.memory_factor(fam)
            if mf < 1.0:
                tags.append("MEMORY_PENALTY")
                rob *= mf
            viol = violation(is_m, self.constraints) if is_m else 10.0
            if status == DUPLICATE_BEHAVIOR:
                viol += 5.0
                rob = 0.0
            row.update(
                strategy_hash=st.hash, dsl=st.text, parameters_json=[x.to_dict() for x in parameters(st)],
                family=fam, complexity_score=cx.score, complexity_json=cx.to_dict(), is_result_json=is_m,
                oos_result_json=oos_m, status=status, counts_toward_budget=1, duplicate_of=dup_of,
                robustness=rob, is_return=(is_m or {}).get("total_return"), oos_return=(oos_m or {}).get("total_return"),
                is_sharpe_bar=(is_m or {}).get("sharpe_bar"), oos_sharpe_bar=(oos_m or {}).get("sharpe_bar"),
                is_trades=(is_m or {}).get("trades"), oos_trades=(oos_m or {}).get("trades"),
                novelty_json=info.to_dict() if info else None, error=res.error,
                meta_json={**p.meta, "tags": tags, "entry_rate": res.entry_rate, "group": grp,
                           "eval_seconds": round(res.elapsed, 4)},
            )
            eval_rows.append((i, row, st, p, res, {"cx": cx, "fam": fam, "grp": grp, "info": info, "tags": tags,
                                                   "rob": rob, "viol": viol, "is": is_m, "oos": oos_m,
                                                   "status": status}))

        # insert evaluated rows first (resolve in-batch behaviour duplicates), then bookkeeping rows
        seq_to_id: dict[int, int] = {}
        ordered = sorted(eval_rows, key=lambda x: x[1]["seq"])
        first_rows = [r for _, r, *_ in ordered if not (r.get("duplicate_of") or 0) < 0]
        ids = self.db.insert_trials(first_rows)
        for r, tid in zip(first_rows, ids):
            seq_to_id[r["seq"]] = tid
        late = [r for _, r, *_ in ordered if (r.get("duplicate_of") or 0) < 0]
        for r in late:
            r["duplicate_of"] = seq_to_id.get(-r["duplicate_of"])
        late_ids = self.db.insert_trials(late)
        for r, tid in zip(late, late_ids):
            seq_to_id[r["seq"]] = tid

        for i, row, st, p, res, x in ordered:
            tid = seq_to_id[row["seq"]]
            rec = TrialRecord(trial_id=tid, seq=row["seq"], strategy=st, hash=st.hash, status=x["status"],
                              creation_method=p.creation_method, operator=p.operator, phase=p.phase,
                              generation=p.generation, parents=tuple(p.parents), family=x["fam"], group=x["grp"],
                              is_metrics=x["is"], complexity=x["cx"], robustness=x["rob"], violation=x["viol"],
                              novelty=x["info"], duplicate_of=row.get("duplicate_of"), error=res.error,
                              tags=tuple(x["tags"]), meta=p.meta)
            self._oos[tid] = x["oos"] or {}
            self.by_hash[st.hash] = rec
            self.records.append(rec)
            self.method_counts[p.creation_method] = self.method_counts.get(p.creation_method, 0) + 1
            if res.ok and x["status"] == EVALUATED:
                self.archive.add(tid, res.behavior_pos, res.behavior_ret, res.behavior_hash)
            out[i] = rec

        for i, p, h, seq in in_batch_dups:
            prev = self.by_hash.get(h)
            row = self._base_row(p, seq)
            row.update(dsl=prev.strategy.text if prev and prev.strategy else (p.text or ""), strategy_hash=h,
                       status=DUPLICATE, counts_toward_budget=0, duplicate_of=prev.trial_id if prev else None)
            pending_rows.append((i, row))
            out[i] = prev
        if pending_rows:
            pending_rows.sort(key=lambda x: x[1]["seq"])
            self.db.insert_trials([r for _, r in pending_rows])
        if self.on_progress:
            self.on_progress()
        return out

    # ------------------------------------------------------------ queries
    def evaluated(self) -> list[TrialRecord]:
        return [r for r in self.records if r.status == EVALUATED]
