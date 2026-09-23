"""Gaussian HMM (diagonal covariance) with Baum-Welch fitting.

The forward and backward recursions are computed with a parallel prefix scan
over normalised 2x2..KxK transition-emission matrices (Hillis-Steele), so the
whole E-step is a handful of batched numpy matrix products instead of a Python
loop over time. The prefix product for bar t depends only on bars <= t, so
filtered probabilities are exactly causal: truncating the data does not change
any earlier value.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

_TINY = 1e-300


def _scan(M: np.ndarray, logs: np.ndarray, left: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Inclusive scan of matrix products. right-multiplying (P_t = P_{t-1} M_t) unless ``left``."""
    P = M.copy()
    S = logs.copy()
    T = P.shape[0]
    d = 1
    while d < T:
        A, B = P[:-d], P[d:]
        C = (B @ A) if left else (A @ B)
        mx = np.maximum(C.max(axis=(1, 2)), _TINY)
        C = C / mx[:, None, None]
        s_new = S[:-d] + S[d:] + np.log(mx)
        P[d:] = C
        S[d:] = s_new
        d *= 2
    return P, S


@dataclass
class HMMParams:
    pi: np.ndarray
    A: np.ndarray
    mu: np.ndarray
    var: np.ndarray

    def to_dict(self) -> dict:
        return {"pi": self.pi.tolist(), "A": self.A.tolist(), "mu": self.mu.tolist(), "var": self.var.tolist()}

    @classmethod
    def from_dict(cls, d: dict) -> "HMMParams":
        return cls(np.asarray(d["pi"], float), np.asarray(d["A"], float), np.asarray(d["mu"], float),
                   np.asarray(d["var"], float))


def log_emission(X: np.ndarray, p: HMMParams) -> np.ndarray:
    """(T, K) log densities; rows with missing features get 0 (uninformative)."""
    T = X.shape[0]
    K = p.mu.shape[0]
    out = np.zeros((T, K))
    ok = np.all(np.isfinite(X), axis=1)
    Xo = X[ok]
    for k in range(K):
        v = p.var[k]
        out[ok, k] = -0.5 * np.sum(np.log(2 * np.pi * v) + (Xo - p.mu[k]) ** 2 / v, axis=1)
    return out


def _transition_mats(logB: np.ndarray, A: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    m = logB.max(axis=1)
    Bs = np.exp(logB - m[:, None])
    M = A[None, :, :] * Bs[1:, None, :]
    mx = np.maximum(M.max(axis=(1, 2)), _TINY)
    M = M / mx[:, None, None]
    return M, np.log(mx) + m[1:], Bs


def forward_filter(logB: np.ndarray, p: HMMParams) -> tuple[np.ndarray, float]:
    T, K = logB.shape
    if T == 0:
        return np.zeros((0, K)), 0.0
    M, logs, Bs = _transition_mats(logB, p.A)
    a0 = p.pi * Bs[0]
    s0 = a0.sum()
    a0 = a0 / max(s0, _TINY)
    probs = np.empty((T, K))
    probs[0] = a0
    loglik = math.log(max(s0, _TINY)) + logB[0].max()
    if T > 1:
        P, S = _scan(M, logs)
        alpha = np.einsum("k,tkj->tj", a0, P)
        tot = np.maximum(alpha.sum(axis=1), _TINY)
        probs[1:] = alpha / tot[:, None]
        loglik += math.log(tot[-1]) + S[-1]
    return probs, float(loglik)


def forward_backward(logB: np.ndarray, p: HMMParams) -> tuple[float, np.ndarray, np.ndarray]:
    T, K = logB.shape
    M, logs, Bs = _transition_mats(logB, p.A)
    probs, loglik = forward_filter(logB, p)
    beta = np.ones((T, K))
    if T > 1:
        R = M[::-1].copy()
        Q, _ = _scan(R, logs[::-1].copy(), left=True)
        # Q[j] = M_{T-1-j} @ ... @ M_{T-1}  -> beta_{T-2-j} = Q[j] @ 1
        b = Q.sum(axis=2)
        b = b / np.maximum(b.max(axis=1, keepdims=True), _TINY)
        beta[:-1] = b[::-1]
    gamma = probs * beta
    gamma /= np.maximum(gamma.sum(axis=1, keepdims=True), _TINY)
    xi_sum = np.zeros((K, K))
    if T > 1:
        right = Bs[1:] * beta[1:]
        X = probs[:-1, :, None] * p.A[None, :, :] * right[:, None, :]
        X /= np.maximum(X.sum(axis=(1, 2), keepdims=True), _TINY)
        xi_sum = X.sum(axis=0)
    return loglik, gamma, xi_sum


class GaussianHMM:
    def __init__(self, n_states: int = 4, n_iter: int = 60, tol: float = 1e-4, seed: int = 0, restarts: int = 3,
                 min_var: float = 1e-3):
        self.K = n_states
        self.n_iter = n_iter
        self.tol = tol
        self.seed = seed
        self.restarts = restarts
        self.min_var = min_var
        self.params: HMMParams | None = None
        self.loglik = -np.inf

    def _init(self, X: np.ndarray, rng: np.random.Generator) -> HMMParams:
        K, D = self.K, X.shape[1]
        # k-means++ style seeding of the means
        idx = [int(rng.integers(0, X.shape[0]))]
        for _ in range(1, K):
            d2 = np.min(((X[:, None, :] - X[idx][None, :, :]) ** 2).sum(axis=2), axis=1)
            pr = d2 / d2.sum() if d2.sum() > 0 else None
            idx.append(int(rng.choice(X.shape[0], p=pr)))
        mu = X[idx].copy()
        var = np.tile(np.maximum(X.var(axis=0), self.min_var), (K, 1))
        A = np.full((K, K), 0.05 / max(1, K - 1))
        np.fill_diagonal(A, 0.95)
        return HMMParams(np.full(K, 1.0 / K), A, mu, var)

    def fit(self, X: np.ndarray) -> "GaussianHMM":
        Xf = X[np.all(np.isfinite(X), axis=1)]
        if Xf.shape[0] < 10 * self.K:
            raise ValueError("not enough observations to fit the HMM")
        rng = np.random.default_rng(self.seed)
        best, best_ll = None, -np.inf
        for _ in range(self.restarts):
            p = self._init(Xf, rng)
            prev = -np.inf
            for _ in range(self.n_iter):
                logB = log_emission(Xf, p)
                ll, gamma, xi = forward_backward(logB, p)
                w = gamma.sum(axis=0) + 1e-12
                pi = gamma[0] / gamma[0].sum()
                A = xi + 1e-6
                A = A / A.sum(axis=1, keepdims=True)
                mu = (gamma.T @ Xf) / w[:, None]
                var = np.empty_like(mu)
                for k in range(self.K):
                    var[k] = (gamma[:, k][:, None] * (Xf - mu[k]) ** 2).sum(axis=0) / w[k]
                var = np.maximum(var, self.min_var)
                p = HMMParams(pi, A, mu, var)
                if abs(ll - prev) < self.tol * max(1.0, abs(prev)):
                    break
                prev = ll
            ll = forward_filter(log_emission(Xf, p), p)[1]
            if ll > best_ll:
                best, best_ll = p, ll
        self.params, self.loglik = best, float(best_ll)
        return self

    def n_parameters(self, D: int) -> int:
        K = self.K
        return K * (K - 1) + (K - 1) + 2 * K * D

    def bic(self, X: np.ndarray) -> float:
        n = int(np.all(np.isfinite(X), axis=1).sum())
        return -2.0 * self.loglik + self.n_parameters(X.shape[1]) * math.log(max(n, 2))

    def filter(self, X: np.ndarray) -> np.ndarray:
        assert self.params is not None
        probs, _ = forward_filter(log_emission(X, self.params), self.params)
        return probs
