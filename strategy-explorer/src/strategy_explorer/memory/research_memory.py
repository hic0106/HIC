"""AI Research Memory.

Aggregates tested hypothesis families and records conclusions so later
searches do not regenerate the same failed idea under a new name.

scope = "llm_visible"     conclusions derived from TRAIN metrics only; shown to the LLM
                          and used as a selection penalty for exhausted families
scope = "researcher_only" notes derived from validation / gate results; shown in the UI
                          only, never to the LLM (they would leak out-of-sample information)
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..ledger.db import LedgerDB
from ..search.trials import EVALUATED, TrialRecord

LLM_VISIBLE, RESEARCHER_ONLY = "llm_visible", "researcher_only"
EXHAUSTED = ("fails_after_cost", "no_edge")


@dataclass
class MemoryConfig:
    min_trials: int = 25
    penalty: float = 0.5
    same_asset_only: bool = True


class ResearchMemory:
    def __init__(self, db: LedgerDB, asset: str, timeframe: str, cfg: MemoryConfig | None = None):
        self.db = db
        self.asset = asset
        self.timeframe = timeframe
        self.cfg = cfg or MemoryConfig()
        self._exhausted: set[str] = set()
        self.reload()

    def _rows(self, scope: str) -> list[dict]:
        if self.cfg.same_asset_only:
            return self.db.memory(scope=scope, asset=self.asset, timeframe=self.timeframe)
        return self.db.memory(scope=scope)

    def reload(self) -> None:
        self._exhausted = {r["family"] for r in self._rows(LLM_VISIBLE)
                           if r["conclusion"] in EXHAUSTED and int(r["n_trials"]) >= self.cfg.min_trials}

    def family_factor(self, family: str) -> float:
        """Robustness multiplier applied to candidates of an exhausted family (identical structure)."""
        return self.cfg.penalty if family in self._exhausted else 1.0

    def llm_notes(self, limit: int = 15) -> list[str]:
        notes, seen = [], set()
        for r in self._rows(LLM_VISIBLE):
            if r["family"] in seen:
                continue
            seen.add(r["family"])
            st = r.get("stats") or {}
            advice = ("do not regenerate without a material structural change" if r["conclusion"] in EXHAUSTED
                      else "may be refined")
            notes.append(f"- family [{r['family']}]: {r['n_trials']} trials, {r['conclusion'].replace('_', ' ')} "
                         f"({100 * st.get('positive_after_costs', 0):.0f}% positive after costs, "
                         f"{100 * st.get('positive_before_costs', 0):.0f}% before) -> {advice}")
            if len(notes) >= limit:
                break
        return notes

    @staticmethod
    def conclude(net_pos: float, gross_pos: float, consistency: float, rob: float, rob_q75: float) -> str:
        if gross_pos >= 0.5 and net_pos < 0.2:
            return "fails_after_cost"
        if net_pos < 0.1:
            return "no_edge"
        if consistency < 0.4:
            return "unstable"
        if rob >= rob_q75 and net_pos >= 0.3:
            return "promising"
        return "inconclusive"

    def update_from_trials(self, experiment_id: str, records: list[TrialRecord]) -> list[dict]:
        ev = [r for r in records if r.status == EVALUATED and r.is_metrics]
        if not ev:
            return []
        rob_q75 = float(np.quantile([r.robustness for r in ev], 0.75))
        fams: dict[str, list[TrialRecord]] = {}
        for r in ev:
            fams.setdefault(r.family or "?", []).append(r)
        out = []
        for fam, rs in sorted(fams.items()):
            if len(rs) < self.cfg.min_trials:
                continue
            net_pos = float(np.mean([(r.is_metrics.get("total_return") or 0) > 0 for r in rs]))
            gross_pos = float(np.mean([(r.is_metrics.get("gross_return") or 0) > 0 for r in rs]))
            cons = float(np.mean([r.is_metrics.get("consistency") or 0 for r in rs]))
            rob = float(np.mean([r.robustness for r in rs]))
            conclusion = self.conclude(net_pos, gross_pos, cons, rob, rob_q75)
            rec = {"experiment_id": experiment_id, "asset": self.asset, "timeframe": self.timeframe, "family": fam,
                   "scope": LLM_VISIBLE, "n_trials": len(rs), "conclusion": conclusion,
                   "stats": {"positive_after_costs": net_pos, "positive_before_costs": gross_pos,
                             "mean_consistency": cons, "mean_robustness": rob, "segment": "train"}}
            self.db.add_memory(rec)
            out.append(rec)
        self.reload()
        return out

    def add_validation_notes(self, experiment_id: str, candidates: list[dict]) -> None:
        for c in candidates:
            self.db.add_memory({
                "experiment_id": experiment_id, "asset": self.asset, "timeframe": self.timeframe,
                "family": c.get("family") or "?", "scope": RESEARCHER_ONLY, "n_trials": 1,
                "conclusion": c.get("status", "?"),
                "stats": {"failed_checks": c.get("failed_checks", []), "novelty": c.get("novelty_class")},
                "note": f"candidate {c.get('candidate_id')} (trial {c.get('trial_id')}): {c.get('status')}",
            })
