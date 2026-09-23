"""Strongly-Typed Genetic Programming with NSGA-II survival.

The rule *structure* evolves (not only parameters): subtree mutation, clause
insertion/removal, hoisting, exit-logic changes and direction changes alter
the expression tree; window/threshold/operator mutations refine it. Survival is
elitist (mu + lambda) NSGA-II on train-only objectives with constraint
domination (minimum trades, positive net return). Near-duplicates are
penalised through the Robustness Score and exact behaviour duplicates are
infeasible.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import nsga2
from .budget import EXPLOIT, EXPLORE
from .generator import PARAMETRIC_OPS, STRUCTURAL_OPS, TypedGenerator, Variation
from .objectives import objective_vector
from .trials import EVALUATED, Proposal, TrialManager, TrialRecord


@dataclass
class GPConfig:
    population: int = 60
    offspring: int | None = None
    p_crossover: float = 0.3
    p_immigrant: float = 0.1
    objectives: tuple[str, ...] = ("sortino", "consistency", "max_drawdown", "complexity")
    attempts_factor: int = 25


class GPEngine:
    def __init__(self, cfg: GPConfig, manager: TrialManager, gen: TypedGenerator, var: Variation,
                 rng: np.random.Generator):
        self.cfg = cfg
        self.m = manager
        self.gen = gen
        self.var = var
        self.rng = rng
        self.population: list[TrialRecord] = []
        self.generation = 0
        self.history: list[dict] = []

    # --------------------------------------------------------- objectives
    def objectives(self, recs: list[TrialRecord]) -> tuple[np.ndarray, np.ndarray]:
        names = self.cfg.objectives
        F = np.zeros((len(recs), len(names)))
        V = np.zeros(len(recs))
        for i, r in enumerate(recs):
            if r.is_metrics and r.complexity is not None:
                F[i] = objective_vector(names, {"is": r.is_metrics, "oos": None, "cx": r.complexity})
                # the novelty/memory adjusted robustness enters as a tie-breaking pressure on the first objective
                F[i, 0] -= 0.25 * r.robustness
            else:
                F[i] = 1e6
            V[i] = r.violation
        return F, V

    def _pick(self, rank: np.ndarray, crowd: np.ndarray, k: int = 1) -> list[TrialRecord]:
        idx = nsga2.tournament(rank, crowd, self.rng, k)
        return [self.population[i] for i in idx]

    # ----------------------------------------------------------- lifecycle
    def initialize(self, seeds: list[TrialRecord] | None = None) -> None:
        pop = [r for r in (seeds or []) if r is not None and r.strategy is not None and r.status == EVALUATED]
        need = max(0, self.cfg.population - len(pop))
        props, seen = [], {r.hash for r in pop}
        attempts = 0
        while len(props) < need and attempts < need * self.cfg.attempts_factor:
            attempts += 1
            st = self.gen.finalize(self.gen.strategy())
            if st is None or st.hash in seen:
                continue
            seen.add(st.hash)
            props.append(Proposal(strategy=st, creation_method="GP", operator="random", phase=EXPLORE,
                                  generation=0))
        recs = self.m.submit(props)
        pop.extend(r for r in recs if r is not None and r.strategy is not None)
        self.population = self._unique(pop)[: max(self.cfg.population, len(pop))]

    @staticmethod
    def _unique(recs: list[TrialRecord]) -> list[TrialRecord]:
        seen, out = set(), []
        for r in recs:
            if r is None or r.hash is None or r.hash in seen:
                continue
            seen.add(r.hash)
            out.append(r)
        return out

    def breed(self, n: int) -> list[Proposal]:
        if not self.population:
            return []
        F, V = self.objectives(self.population)
        rank, crowd = nsga2.rank_and_crowding(F, V)
        props: list[Proposal] = []
        seen = {r.hash for r in self.population}
        attempts = 0
        while len(props) < n and attempts < n * self.cfg.attempts_factor:
            attempts += 1
            if self.m.budget.exhausted:
                break
            p_explore = self.m.budget.explore_share_needed()
            phase = EXPLORE if self.rng.random() < p_explore else EXPLOIT
            if not self.m.budget.can_spend(phase):
                phase = EXPLOIT if phase == EXPLORE else EXPLORE
                if not self.m.budget.can_spend(phase):
                    break
            parents: tuple[int, ...] = ()
            if phase == EXPLORE:
                r = self.rng.random()
                if r < self.cfg.p_immigrant:
                    child, op, method = self.gen.strategy(), "random", "GP"
                elif r < self.cfg.p_immigrant + self.cfg.p_crossover:
                    a, b = self._pick(rank, crowd, 2)
                    child, op, method = self.var.crossover(a.strategy, b.strategy), "crossover", "CROSSOVER"
                    parents = (a.trial_id, b.trial_id)
                else:
                    (a,) = self._pick(rank, crowd, 1)
                    op = str(self.rng.choice(STRUCTURAL_OPS))
                    child, method = self.var.apply(op, a.strategy), "MUTATION"
                    parents = (a.trial_id,)
            else:
                (a,) = self._pick(rank, crowd, 1)
                op = str(self.rng.choice(PARAMETRIC_OPS))
                child, method = self.var.apply(op, a.strategy), "MUTATION"
                parents = (a.trial_id,)
            if child is None:
                continue
            child = self.gen.finalize(child)
            if child is None or child.hash in seen:
                continue
            seen.add(child.hash)
            props.append(Proposal(strategy=child, creation_method=method, operator=op, phase=phase, parents=parents,
                                  generation=self.generation))
        return props

    def step(self, injected: list[Proposal] | None = None) -> dict:
        self.generation += 1
        n_off = self.cfg.offspring or self.cfg.population
        injected = list(injected or [])
        for p in injected:
            p.generation = self.generation
        props = injected + self.breed(max(0, n_off - len(injected)))
        recs = self.m.submit(props)
        new = [r for r in recs if r is not None and r.strategy is not None]
        combined = self._unique(self.population + new)
        F, V = self.objectives(combined)
        keep = nsga2.select(F, V, self.cfg.population)
        self.population = [combined[i] for i in keep]
        fresh = [r for r in new if r.generation == self.generation and r.status == EVALUATED]
        stats = {
            "generation": self.generation,
            "offspring_evaluated": len(fresh),
            "population": len(self.population),
            "feasible": int(sum(1 for r in self.population if r.feasible)),
            "best_robustness": float(max((r.robustness for r in self.population), default=0.0)),
            "median_robustness": float(np.median([r.robustness for r in self.population])) if self.population
            else 0.0,
            "budget": self.m.budget.to_dict(),
        }
        self.history.append(stats)
        return stats

    def absorb(self, recs: list[TrialRecord]) -> None:
        """Merge externally produced, already evaluated trials (MCTS, LLM) into the population."""
        new = [r for r in recs if r is not None and r.strategy is not None]
        if not new:
            return
        combined = self._unique(self.population + new)
        F, V = self.objectives(combined)
        keep = nsga2.select(F, V, self.cfg.population)
        self.population = [combined[i] for i in keep]

    def elites(self, k: int = 10) -> list[TrialRecord]:
        feas = [r for r in self.population if r.status == EVALUATED]
        return sorted(feas, key=lambda r: (-r.robustness, r.seq))[:k]
