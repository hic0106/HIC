"""NSGA-II (Deb et al. 2002): fast non-dominated sorting, crowding distance and
constraint-domination. Objectives are in minimisation form."""

from __future__ import annotations

import numpy as np


def dominance_matrix(F: np.ndarray, viol: np.ndarray | None = None) -> np.ndarray:
    """D[i, j] = True if i constraint-dominates j."""
    n = F.shape[0]
    if viol is None:
        viol = np.zeros(n)
    le = np.all(F[:, None, :] <= F[None, :, :], axis=2)
    lt = np.any(F[:, None, :] < F[None, :, :], axis=2)
    pareto = le & lt
    feas = viol <= 0
    fi, fj = feas[:, None], feas[None, :]
    both_feas = fi & fj
    D = np.where(both_feas, pareto, False)
    D |= fi & ~fj
    both_inf = ~fi & ~fj
    D |= both_inf & (viol[:, None] < viol[None, :])
    np.fill_diagonal(D, False)
    return D


def fast_non_dominated_sort(F: np.ndarray, viol: np.ndarray | None = None) -> list[list[int]]:
    n = F.shape[0]
    if n == 0:
        return []
    D = dominance_matrix(F, viol)
    dominated_count = D.sum(axis=0)
    fronts: list[list[int]] = []
    current = [int(i) for i in np.flatnonzero(dominated_count == 0)]
    assigned = np.zeros(n, dtype=bool)
    while current:
        fronts.append(current)
        assigned[current] = True
        dominated_count = dominated_count - D[current].sum(axis=0)
        nxt = [int(i) for i in np.flatnonzero((dominated_count == 0) & ~assigned)]
        current = nxt
    return fronts


def crowding_distance(F: np.ndarray) -> np.ndarray:
    n, m = F.shape
    if n <= 2:
        return np.full(n, np.inf)
    dist = np.zeros(n)
    for k in range(m):
        order = np.argsort(F[:, k], kind="mergesort")
        fk = F[order, k]
        span = fk[-1] - fk[0]
        dist[order[0]] = dist[order[-1]] = np.inf
        if span <= 0:
            continue
        dist[order[1:-1]] += (fk[2:] - fk[:-2]) / span
    return dist


def rank_and_crowding(F: np.ndarray, viol: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    n = F.shape[0]
    rank = np.zeros(n, dtype=np.int64)
    crowd = np.zeros(n)
    for r, front in enumerate(fast_non_dominated_sort(F, viol)):
        rank[front] = r
        crowd[front] = crowding_distance(F[front])
    return rank, crowd


def select(F: np.ndarray, viol: np.ndarray | None, k: int) -> list[int]:
    """Environmental selection of k survivors (elitist, diversity preserving)."""
    chosen: list[int] = []
    for front in fast_non_dominated_sort(F, viol):
        if len(chosen) + len(front) <= k:
            chosen.extend(front)
            continue
        cd = crowding_distance(F[front])
        order = np.argsort(-cd, kind="mergesort")
        chosen.extend(front[i] for i in order[: k - len(chosen)])
        break
    return chosen


def tournament(rank: np.ndarray, crowd: np.ndarray, rng: np.random.Generator, n: int) -> list[int]:
    """Binary tournament on (rank asc, crowding desc)."""
    size = rank.shape[0]
    a = rng.integers(0, size, n)
    b = rng.integers(0, size, n)
    better_a = (rank[a] < rank[b]) | ((rank[a] == rank[b]) & (crowd[a] >= crowd[b]))
    return [int(x) for x in np.where(better_a, a, b)]
