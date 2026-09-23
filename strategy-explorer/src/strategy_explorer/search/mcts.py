"""Monte Carlo Tree Search over strategy edits.

Node   = one concrete strategy expression (an evaluated trial)
Action = a typed edit: add/remove condition, operator change, window change,
         threshold change, exit-rule change, direction change, trigger change,
         subtree replacement
Reward = train-only Robustness Score from the deterministic backtest

Selection uses UCT with progressive widening; the value of a node is the best
reward found in its subtree ("max" backup, suited to optimisation) or the
mean. An optional expander (e.g. an LLM) proposes edits as DSL text; those go
through the same compiler, budget and ledger as every other candidate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from .budget import EXPLOIT
from .generator import TypedGenerator, Variation
from .trials import EVALUATED, Proposal, TrialManager, TrialRecord

MCTS_ACTIONS = ("add_condition", "remove_condition", "point", "window", "threshold", "exit_change", "direction",
                "signal_type", "subtree")


@dataclass
class MCTSConfig:
    iterations: int = 30
    c_uct: float = 1.0
    widen_c: float = 2.0
    widen_alpha: float = 0.5
    max_edit_depth: int = 6
    backup: str = "max"
    actions: tuple[str, ...] = MCTS_ACTIONS
    expansion_tries: int = 8
    expander_share: float = 0.5


@dataclass
class MCTSNode:
    record: TrialRecord
    parent: "MCTSNode | None" = None
    depth: int = 0
    children: list["MCTSNode"] = field(default_factory=list)
    visits: int = 0
    value_sum: float = 0.0
    best: float = 0.0

    def value(self, backup: str) -> float:
        if self.visits == 0:
            return 0.0
        return self.best if backup == "max" else self.value_sum / self.visits


class MCTS:
    def __init__(self, cfg: MCTSConfig, manager: TrialManager, var: Variation, gen: TypedGenerator,
                 rng: np.random.Generator, expander: Callable[[TrialRecord], list[str]] | None = None,
                 phase: str = EXPLOIT):
        self.cfg = cfg
        self.m = manager
        self.var = var
        self.gen = gen
        self.rng = rng
        self.expander = expander
        self.phase = phase
        self.nodes_created = 0
        self.llm_expansions = 0

    @staticmethod
    def reward(rec: TrialRecord) -> float:
        if rec is None or rec.status != EVALUATED:
            return 0.0
        return float(rec.robustness if rec.feasible else 0.5 * rec.robustness)

    def _max_children(self, node: MCTSNode) -> int:
        return max(1, int(math.ceil(self.cfg.widen_c * (node.visits + 1) ** self.cfg.widen_alpha)))

    def _uct(self, parent: MCTSNode, child: MCTSNode) -> float:
        if child.visits == 0:
            return float("inf")
        explore = self.cfg.c_uct * math.sqrt(math.log(parent.visits + 1) / child.visits)
        return child.value(self.cfg.backup) + explore

    def _select(self, root: MCTSNode) -> MCTSNode:
        node = root
        while node.children and len(node.children) >= self._max_children(node) \
                and node.depth < self.cfg.max_edit_depth:
            node = max(node.children, key=lambda ch: (self._uct(node, ch), -ch.record.seq))
        return node

    def _expand(self, node: MCTSNode, root_id: int) -> TrialRecord | None:
        st = node.record.strategy
        use_llm = self.expander is not None and self.rng.random() < self.cfg.expander_share
        if use_llm:
            try:
                texts = self.expander(node.record) or []
            except Exception:  # an unavailable LLM must not stop the search
                texts = []
            for text in texts[: self.cfg.expansion_tries]:
                recs = self.m.submit([Proposal(text=text, creation_method="MCTS", operator="llm_edit",
                                               phase=self.phase, parents=(node.record.trial_id,),
                                               meta={"mcts_root": root_id, "mcts_depth": node.depth + 1,
                                                     "expansion": "llm"})])
                rec = recs[0]
                if rec is not None and rec.trial_id != node.record.trial_id:
                    self.llm_expansions += 1
                    return rec
        seen_children = {c.record.hash for c in node.children}
        for _ in range(self.cfg.expansion_tries):
            action = str(self.rng.choice(self.cfg.actions))
            child = self.var.apply(action, st)
            if child is None:
                continue
            child = self.gen.finalize(child)
            if child is None or child.hash == st.hash or child.hash in seen_children:
                continue
            recs = self.m.submit([Proposal(strategy=child, creation_method="MCTS", operator=action,
                                           phase=self.phase, parents=(node.record.trial_id,),
                                           meta={"mcts_root": root_id, "mcts_depth": node.depth + 1})])
            return recs[0]
        return None

    def search(self, root_rec: TrialRecord, iterations: int | None = None) -> list[TrialRecord]:
        root = MCTSNode(root_rec, visits=1, value_sum=self.reward(root_rec), best=self.reward(root_rec))
        found: list[TrialRecord] = []
        for _ in range(iterations or self.cfg.iterations):
            if not self.m.budget.can_spend(self.phase):
                break
            leaf = self._select(root)
            rec = self._expand(leaf, root_rec.trial_id)
            if rec is None:
                leaf.visits += 1  # dead end: discourage revisiting
                continue
            child = MCTSNode(rec, parent=leaf, depth=leaf.depth + 1)
            leaf.children.append(child)
            self.nodes_created += 1
            r = self.reward(rec)
            n: MCTSNode | None = child
            while n is not None:
                n.visits += 1
                n.value_sum += r
                n.best = max(n.best, r)
                n = n.parent
            found.append(rec)
        return found
