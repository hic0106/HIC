"""Novelty / duplicate detection.

Similarity is measured four ways:

* AST similarity      - Jaccard overlap of sub-expression sets
* signal similarity   - correlation of block-averaged position series (train)
* return correlation  - correlation of block-summed strategy returns (train)
* trade overlap       - Jaccard overlap of same-side in-position bars (exact, for the closest match)

A candidate whose behaviour hash equals an earlier trial is a DUPLICATE; one
whose behavioural similarity exceeds ``near_threshold`` receives a novelty
penalty and a NEAR_DUPLICATE tag.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..dsl.nodes import Strategy, iter_nodes


def behavior_vectors(position: np.ndarray, returns: np.ndarray, dim: int) -> tuple[np.ndarray, np.ndarray]:
    n = position.shape[0]
    if n == 0:
        return np.zeros(dim, np.float32), np.zeros(dim, np.float32)
    edges = np.linspace(0, n, min(dim, n) + 1).astype(np.int64)
    counts = np.diff(edges)
    pos_sum = np.add.reduceat(position.astype(np.float64), edges[:-1])
    ret_sum = np.add.reduceat(returns.astype(np.float64), edges[:-1])
    pv = (pos_sum / np.maximum(counts, 1)).astype(np.float32)
    rv = ret_sum.astype(np.float32)
    if pv.shape[0] < dim:
        pv = np.pad(pv, (0, dim - pv.shape[0]))
        rv = np.pad(rv, (0, dim - rv.shape[0]))
    return pv, rv


def _unit(v: np.ndarray) -> np.ndarray | None:
    v = v.astype(np.float32) - np.float32(v.mean())
    n = float(np.linalg.norm(v))
    if n < 1e-9:
        return None
    return v / n


def ast_subtrees(st: Strategy) -> set[str]:
    out = set()
    for slot, root in st.slot_items():
        for _, n in iter_nodes(root):
            if n.is_literal or n.op == "WHEN":
                continue
            out.add(f"{slot.split('_')[0]}:{n.text}")
    return out


def ast_similarity(a: Strategy, b: Strategy) -> float:
    sa, sb = ast_subtrees(a), ast_subtrees(b)
    if not sa and not sb:
        return 1.0
    return len(sa & sb) / len(sa | sb)


def trade_overlap(pos_a: np.ndarray, pos_b: np.ndarray) -> float:
    ina, inb = pos_a != 0, pos_b != 0
    union = int(np.count_nonzero(ina | inb))
    if union == 0:
        return 0.0
    same = int(np.count_nonzero(ina & inb & (pos_a == pos_b)))
    return same / union


@dataclass
class NoveltyInfo:
    max_similarity: float
    closest_trial: int | None
    knn_similarity: float
    novelty: float
    signal_similarity: float
    return_similarity: float

    def to_dict(self) -> dict:
        return dict(self.__dict__)


class NoveltyArchive:
    def __init__(self, dim: int = 256, k: int = 5, capacity: int = 1024):
        self.dim = dim
        self.k = k
        self._P = np.zeros((capacity, dim), np.float32)
        self._R = np.zeros((capacity, dim), np.float32)
        self._ids: list[int] = []
        self.by_hash: dict[str, int] = {}

    def __len__(self) -> int:
        return len(self._ids)

    def _grow(self) -> None:
        cap = self._P.shape[0] * 2
        self._P = np.resize(self._P, (cap, self.dim))
        self._R = np.resize(self._R, (cap, self.dim))

    def query(self, pos_vec: np.ndarray, ret_vec: np.ndarray) -> NoveltyInfo:
        n = len(self._ids)
        pu, ru = _unit(pos_vec), _unit(ret_vec)
        if n == 0 or pu is None:
            return NoveltyInfo(0.0, None, 0.0, 1.0, 0.0, 0.0)
        sp = self._P[:n] @ pu
        sr = self._R[:n] @ ru if ru is not None else np.zeros(n, np.float32)
        sim = np.maximum(sp, sr)
        j = int(np.argmax(sim))
        kk = min(self.k, n)
        knn = float(np.mean(np.partition(sim, n - kk)[n - kk:]))
        return NoveltyInfo(max_similarity=float(sim[j]), closest_trial=self._ids[j], knn_similarity=knn,
                           novelty=float(1.0 - max(0.0, knn)), signal_similarity=float(sp[j]),
                           return_similarity=float(sr[j]))

    def return_matrix(self) -> np.ndarray:
        """Unit-normalised train return vectors of all archived (non-duplicate) trials."""
        return self._R[: len(self._ids)].copy()

    def add(self, trial_id: int, pos_vec: np.ndarray, ret_vec: np.ndarray, behavior_hash: str | None) -> None:
        if behavior_hash and behavior_hash not in self.by_hash:
            self.by_hash[behavior_hash] = trial_id
        pu, ru = _unit(pos_vec), _unit(ret_vec)
        if pu is None:
            return
        if len(self._ids) >= self._P.shape[0]:
            self._grow()
        i = len(self._ids)
        self._P[i] = pu
        self._R[i] = ru if ru is not None else 0.0
        self._ids.append(trial_id)


def novelty_penalty(info: NoveltyInfo, near_threshold: float = 0.9, max_penalty: float = 0.5) -> float:
    if info.max_similarity <= near_threshold:
        return 0.0
    return float(max_penalty * min(1.0, (info.max_similarity - near_threshold) / max(1e-9, 1.0 - near_threshold)))
