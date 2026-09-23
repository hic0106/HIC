"""Probability of Backtest Overfitting via Combinatorially Symmetric
Cross-Validation (Bailey, Borwein, Lopez de Prado & Zhu, 2015).

M is a (T x N) matrix of per-period returns of N configurations. Rows are cut
into S blocks; for every way of choosing S/2 blocks as in-sample (IS) the
remaining blocks are out-of-sample (OOS). For each split the configuration
with the best IS Sharpe (n*) is located in the OOS ranking:
    omega = rank_OOS(n*) / (N + 1),    lambda = ln(omega / (1 - omega))
PBO = share of splits with lambda <= 0 (the IS winner is at or below the OOS median).
All combinations are evaluated at once with matrix products over per-block
sufficient statistics.
"""

from __future__ import annotations

from itertools import combinations

import numpy as np


def cscv_pbo(M: np.ndarray, n_blocks: int = 16, max_combinations: int = 20000,
             rng: np.random.Generator | None = None) -> dict:
    M = np.asarray(M, dtype=np.float64)
    T, N = M.shape
    if N < 2 or T < 2 * n_blocks:
        return {"pbo": None, "reason": "not enough configurations or observations", "n_configs": int(N),
                "n_periods": int(T)}
    if n_blocks % 2:
        n_blocks -= 1
    edges = np.linspace(0, T, n_blocks + 1).astype(np.int64)
    sums = np.vstack([M[a:b].sum(axis=0) for a, b in zip(edges[:-1], edges[1:])])
    sq = np.vstack([(M[a:b] ** 2).sum(axis=0) for a, b in zip(edges[:-1], edges[1:])])
    cnt = np.diff(edges).astype(np.float64)
    combos = list(combinations(range(n_blocks), n_blocks // 2))
    if len(combos) > max_combinations:
        rng = rng or np.random.default_rng(0)
        pick = rng.choice(len(combos), size=max_combinations, replace=False)
        combos = [combos[i] for i in sorted(pick)]
    C = np.zeros((len(combos), n_blocks))
    for i, c in enumerate(combos):
        C[i, list(c)] = 1.0

    def sharpe(mask: np.ndarray) -> np.ndarray:
        s = mask @ sums
        q = mask @ sq
        n = (mask @ cnt)[:, None]
        mu = s / n
        var = np.maximum(q / n - mu * mu, 1e-18)
        return mu / np.sqrt(var)

    is_sr = sharpe(C)
    oos_sr = sharpe(1.0 - C)
    n_star = np.argmax(is_sr, axis=1)
    rows = np.arange(len(combos))
    best_oos = oos_sr[rows, n_star]
    # rank 1 = worst ... N = best; ties counted at their average position
    below = (oos_sr < best_oos[:, None]).sum(axis=1)
    equal = (oos_sr == best_oos[:, None]).sum(axis=1)
    rank = below + (equal + 1) / 2.0
    omega = rank / (N + 1.0)
    lam = np.log(omega / (1.0 - omega))
    is_best = is_sr[rows, n_star]
    slope = float(np.polyfit(is_best, best_oos, 1)[0]) if np.std(is_best) > 0 else 0.0
    return {
        "pbo": float(np.mean(lam <= 0)),
        "n_configs": int(N),
        "n_periods": int(T),
        "n_blocks": int(n_blocks),
        "n_combinations": int(len(combos)),
        "logit_mean": float(np.mean(lam)),
        "prob_oos_loss": float(np.mean(best_oos < 0)),
        "degradation_slope": slope,
        "is_sharpe_mean": float(np.mean(is_best)),
        "oos_sharpe_mean": float(np.mean(best_oos)),
        "logit_histogram": np.histogram(lam, bins=12)[0].tolist(),
    }


def aggregate_returns(returns: np.ndarray, ts: np.ndarray, period_ms: int) -> np.ndarray:
    """Sum log growth per calendar period (e.g. daily) to reduce T for CSCV."""
    key = (ts // period_ms).astype(np.int64)
    g = np.log1p(np.maximum(returns, -0.999999))
    uniq, inv = np.unique(key, return_inverse=True)
    out = np.zeros(uniq.shape[0])
    np.add.at(out, inv, g)
    return out
