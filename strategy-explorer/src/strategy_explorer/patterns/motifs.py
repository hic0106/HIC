"""Motif discovery (repeated price-volume subsequences) and shapelet discovery
(subsequences whose proximity separates future outcomes), both on the
scale-invariant channel matrix of TRAIN data.

Motifs: exact nearest-neighbour matrix profile via blocked matrix products,
seeds taken in order of lowest profile value, occurrences = subsequences
within a radius of the seed; the template is the occurrence centroid.

Shapelets: candidate subsequences are sampled; for each candidate and each
distance quantile the events "distance <= threshold" are scored by their
excess forward return. The best (candidate, threshold) pairs are refined to a
centroid template.

For both, the reported statistics are recomputed on the exact DSL rule
``LT(pattern_distance(id), threshold)`` so that what is shown is what a
strategy using the pattern would trade.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .normalize import rms_distance_profile, windows
from .stats import benjamini_hochberg, event_stats, onset_events, thin_events


@dataclass
class MotifConfig:
    lengths: tuple[int, ...] = (8, 12)
    top_k: int = 4
    occ_quantile: float = 0.02
    radius_factor: float = 2.0
    min_occ: int = 20
    max_positions: int = 12000
    max_seeds: int = 400


@dataclass
class ShapeletConfig:
    lengths: tuple[int, ...] = (6, 10, 16)
    candidates_per_length: int = 60
    quantiles: tuple[float, ...] = (0.01, 0.02, 0.05, 0.1)
    min_occ: int = 20
    top_k: int = 4
    max_positions: int = 15000


def _subseq(X: np.ndarray, m: int, max_positions: int) -> tuple[np.ndarray, np.ndarray]:
    W = windows(X, m)
    ends = np.arange(m - 1, X.shape[0])
    ok = np.all(np.isfinite(W), axis=(1, 2))
    S = W[ok].reshape(int(ok.sum()), -1).astype(np.float32)
    ends = ends[ok]
    if S.shape[0] > max_positions:
        idx = np.linspace(0, S.shape[0] - 1, max_positions).astype(np.int64)
        S, ends = S[idx], ends[idx]
    return S, ends


def matrix_profile(S: np.ndarray, ends: np.ndarray, excl: int, block: int = 1024) -> tuple[np.ndarray, np.ndarray]:
    n, dim = S.shape
    norms = (S.astype(np.float64) ** 2).sum(axis=1)
    mp = np.full(n, np.inf)
    mpi = np.full(n, -1, dtype=np.int64)
    for a in range(0, n, block):
        b = min(n, a + block)
        G = (S[a:b] @ S.T).astype(np.float64)
        D2 = norms[a:b, None] + norms[None, :] - 2.0 * G
        np.maximum(D2, 0.0, out=D2)
        D2[np.abs(ends[a:b, None] - ends[None, :]) < excl] = np.inf
        j = np.argmin(D2, axis=1)
        mp[a:b] = np.sqrt(D2[np.arange(b - a), j] / dim)
        mpi[a:b] = j
    return mp, mpi


def _dist_to(S: np.ndarray, norms: np.ndarray, i: int) -> np.ndarray:
    d2 = norms + norms[i] - 2.0 * (S @ S[i]).astype(np.float64)
    return np.sqrt(np.maximum(d2, 0.0) / S.shape[1])


def _greedy_nonoverlap(order: np.ndarray, ends: np.ndarray, m: int) -> np.ndarray:
    taken: list[int] = []
    used_ends: list[int] = []
    for k in order:
        e = int(ends[k])
        if all(abs(e - u) >= m for u in used_ends):
            taken.append(int(k))
            used_ends.append(e)
    return np.asarray(taken, dtype=np.int64)


def _rule_events(X: np.ndarray, template: np.ndarray, thr: float, m: int) -> tuple[np.ndarray, np.ndarray]:
    dist = rms_distance_profile(X, template)
    with np.errstate(invalid="ignore"):
        mask = dist < thr
    return thin_events(onset_events(mask), m), dist


def discover_motifs(X: np.ndarray, fwd: dict, primary: int, cfg: MotifConfig) -> list[dict]:
    found = []
    for m in cfg.lengths:
        S, ends = _subseq(X, m, cfg.max_positions)
        n = S.shape[0]
        if n < 5 * cfg.min_occ:
            continue
        mp, _ = matrix_profile(S, ends, excl=m)
        norms = (S.astype(np.float64) ** 2).sum(axis=1)
        covered = np.zeros(n, dtype=bool)
        k_found = 0
        for seeds, i in enumerate(np.argsort(mp, kind="mergesort")):
            if k_found >= cfg.top_k or seeds >= cfg.max_seeds:
                break
            if covered[i] or not np.isfinite(mp[i]):
                continue
            d = _dist_to(S, norms, int(i))
            radius = min(cfg.radius_factor * float(mp[i]), float(np.quantile(d, cfg.occ_quantile)))
            cand = np.flatnonzero(d <= radius)
            cand = cand[np.argsort(d[cand], kind="mergesort")]
            occ = _greedy_nonoverlap(cand, ends, m)
            if occ.size < cfg.min_occ:
                covered[i] = True
                continue
            template = S[occ].astype(np.float64).mean(axis=0).reshape(m, -1)
            thr = float(f"{float(np.quantile(np.sqrt(((S[occ] - template.reshape(-1)) ** 2).mean(axis=1)), 0.9)):.4g}")
            events, _ = _rule_events(X, template, thr, m)
            # mark neighbourhood of all occurrences as covered so the next motif is different
            for e in ends[occ]:
                covered |= np.abs(ends - e) < m
            if events.size < cfg.min_occ:
                continue
            st = event_stats(events, fwd, primary)
            found.append({"kind": "motif", "length": m, "template": template, "threshold": thr, "events": events,
                          "stats": st, "p": st["p_value"], "seed_end": int(ends[i]), "nn_distance": float(mp[i])})
            k_found += 1
    if found:
        for f, q in zip(found, benjamini_hochberg([f["p"] for f in found])):
            f["q"] = q
    return found


def discover_shapelets(X: np.ndarray, fwd: dict, primary: int, cfg: ShapeletConfig,
                       rng: np.random.Generator) -> list[dict]:
    tests = []
    f_primary = fwd[primary]
    for m in cfg.lengths:
        S, ends = _subseq(X, m, cfg.max_positions)
        n = S.shape[0]
        if n < 5 * cfg.min_occ:
            continue
        norms = (S.astype(np.float64) ** 2).sum(axis=1)
        cands = rng.choice(n, size=min(cfg.candidates_per_length, n), replace=False)
        for ci in sorted(int(c) for c in cands):
            d = _dist_to(S, norms, ci)
            for q in cfg.quantiles:
                thr = float(np.quantile(d, q))
                near = np.flatnonzero(d <= thr)
                ev = thin_events(np.sort(ends[near]), m)
                ev = ev[np.isfinite(f_primary[ev])] if ev.size else ev
                if ev.size < cfg.min_occ:
                    continue
                st = event_stats(ev, fwd, primary)
                tests.append({"m": m, "ci": ci, "q": q, "near": near, "S": S, "ends": ends, "p": st["p_value"],
                              "t": st["t_stat"]})
    if not tests:
        return []
    qvals = benjamini_hochberg([t["p"] for t in tests])
    for t, qv in zip(tests, qvals):
        t["q_bh"] = qv
    tests.sort(key=lambda t: (-abs(t["t"]), t["q_bh"]))
    out, used_templates = [], []
    for t in tests:
        if len(out) >= cfg.top_k:
            break
        m, S, near = t["m"], t["S"], t["near"]
        template = S[near].astype(np.float64).mean(axis=0).reshape(m, -1)
        if any(tm.shape == template.shape and np.sqrt(np.mean((tm - template) ** 2)) < 0.35 for tm in used_templates):
            continue
        dn = np.sqrt(((S[near] - template.reshape(-1)) ** 2).mean(axis=1))
        thr = float(f"{float(np.quantile(dn, 0.9)):.4g}")
        events, _ = _rule_events(X, template, thr, m)
        if events.size < cfg.min_occ:
            continue
        st = event_stats(events, fwd, primary)
        used_templates.append(template)
        # the refined rule is what gets traded: its own p-value, Bonferroni-adjusted for the whole search
        q_final = float(min(1.0, st["p_value"] * len(tests)))
        out.append({"kind": "shapelet", "length": m, "template": template, "threshold": thr, "events": events,
                    "stats": st, "p": st["p_value"], "q": q_final, "n_tests": len(tests),
                    "search_t": t["t"], "search_q": t["q_bh"], "search_quantile": t["q"]})
    return out
