"""Unsupervised market-regime detection.

A Gaussian HMM is fitted on TRAIN data only, using causal features:
log return, realised volatility, log relative volume and trend-to-noise slope.
States are first identified only by number (ordered by volatility so ids are
stable); human-readable descriptions such as "High Vol Trend Up" are attached
afterwards from TRAIN statistics. Applying the model uses forward filtering
only (P(regime_t | data up to t)), never smoothing.
"""

from __future__ import annotations

import math

import numpy as np

from ..data.market import MarketData
from ..dsl import primitives as P
from .hmm import GaussianHMM, HMMParams

FEATURE_NAMES = ("log_return", "realized_volatility", "log_relative_volume", "trend_slope")


class RegimeModel:
    def __init__(self, n_states: int = 4, window: int = 20, seed: int = 0, n_iter: int = 60, restarts: int = 3):
        self.n_states = n_states
        self.window = window
        self.seed = seed
        self.n_iter = n_iter
        self.restarts = restarts
        self.mean: np.ndarray | None = None
        self.std: np.ndarray | None = None
        self.params: HMMParams | None = None
        self.use_volume = True
        self.descriptions: list[dict] = []
        self.loglik = float("nan")
        self.bic = float("nan")

    # ------------------------------------------------------------ features
    def raw_features(self, md: MarketData) -> np.ndarray:
        c = md.close
        n = self.window
        r = P.log_returns(c)
        rv = P.realized_volatility(c, n)
        cols = [r, np.log(np.maximum(rv, 1e-12))]
        if self.use_volume and md.has_volume:
            cols.append(P.log_(P.safe_div(md.volume + 1e-12, P.lag(P.rolling_mean(md.volume, n), 1))))
        cols.append(P.trend_slope(c, n))
        return np.column_stack(cols)

    def _z(self, X: np.ndarray) -> np.ndarray:
        Z = (X - self.mean) / self.std
        return np.clip(Z, -6.0, 6.0)

    # ----------------------------------------------------------------- fit
    def fit(self, md_train: MarketData) -> "RegimeModel":
        self.use_volume = md_train.has_volume
        X = self.raw_features(md_train)
        ok = np.all(np.isfinite(X), axis=1)
        self.mean = X[ok].mean(axis=0)
        self.std = np.maximum(X[ok].std(axis=0), 1e-9)
        hmm = GaussianHMM(self.n_states, self.n_iter, seed=self.seed, restarts=self.restarts).fit(self._z(X))
        p = hmm.params
        order = np.argsort(p.mu[:, 1])  # by volatility feature
        self.params = HMMParams(p.pi[order], p.A[np.ix_(order, order)], p.mu[order], p.var[order])
        self.loglik = hmm.loglik
        self.bic = hmm.bic(self._z(X))
        self.descriptions = self.describe(md_train)
        return self

    # --------------------------------------------------------------- apply
    def filter(self, md: MarketData) -> tuple[np.ndarray, np.ndarray]:
        from .hmm import forward_filter, log_emission

        assert self.params is not None, "fit the regime model first"
        X = self.raw_features(md)
        Z = self._z(X)
        probs, _ = forward_filter(log_emission(Z, self.params), self.params)
        labels = np.argmax(probs, axis=1).astype(np.float64)
        labels[~np.all(np.isfinite(X), axis=1)] = np.nan
        probs = probs.copy()
        probs[~np.all(np.isfinite(X), axis=1)] = np.nan
        return probs, labels

    def describe(self, md_train: MarketData) -> list[dict]:
        probs, labels = self.filter(md_train)
        X = self.raw_features(md_train)
        r = X[:, 0]
        trend = X[:, -1]
        ppy = md_train.periods_per_year()
        vols = []
        out = []
        for k in range(self.n_states):
            m = labels == k
            rk = r[m & np.isfinite(r)]
            vol = float(np.std(rk)) * math.sqrt(ppy) if rk.size > 2 else float("nan")
            vols.append(vol)
            both = m[1:] & m[:-1] & np.isfinite(r[1:]) & np.isfinite(r[:-1])
            if both.sum() > 10:
                a, b = r[1:][both], r[:-1][both]
                ac = float(np.corrcoef(a, b)[0, 1]) if a.std() > 0 and b.std() > 0 else 0.0
            else:
                ac = 0.0
            akk = float(self.params.A[k, k])
            out.append({
                "regime": k,
                "share": float(np.nanmean(m)) if m.size else 0.0,
                "bars": int(m.sum()),
                "ann_return": float(np.mean(rk) * ppy) if rk.size else float("nan"),
                "ann_volatility": vol,
                "mean_trend_slope": float(np.nanmean(trend[m])) if m.any() else float("nan"),
                "return_autocorr": ac,
                "expected_duration_bars": float(1.0 / max(1e-9, 1.0 - akk)),
            })
        finite_vols = [v for v in vols if v == v]
        med = float(np.median(finite_vols)) if finite_vols else 0.0
        for d in out:
            level = "High Vol" if d["ann_volatility"] == d["ann_volatility"] and d["ann_volatility"] > med else "Low Vol"
            t = d["mean_trend_slope"]
            if t == t and t > 0.12:
                char = "Trend Up"
            elif t == t and t < -0.12:
                char = "Trend Down"
            elif d["return_autocorr"] < -0.05:
                char = "Mean-Revert"
            else:
                char = "Sideways"
            d["label"] = f"{level} {char}"
        return out

    # ----------------------------------------------------------- persist
    def to_dict(self) -> dict:
        return {
            "type": "gaussian_hmm_diag",
            "n_states": self.n_states,
            "window": self.window,
            "features": list(FEATURE_NAMES if self.use_volume else
                             ("log_return", "realized_volatility", "trend_slope")),
            "use_volume": self.use_volume,
            "standardize_mean": self.mean.tolist() if self.mean is not None else None,
            "standardize_std": self.std.tolist() if self.std is not None else None,
            "clip": 6.0,
            "params": self.params.to_dict() if self.params else None,
            "inference": "forward filtering only (causal); label = argmax filtered probability",
            "descriptions": self.descriptions,
            "loglik": self.loglik,
            "bic": self.bic,
            "seed": self.seed,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "RegimeModel":
        m = cls(n_states=int(d["n_states"]), window=int(d["window"]), seed=int(d.get("seed", 0)))
        m.use_volume = bool(d.get("use_volume", True))
        m.mean = np.asarray(d["standardize_mean"], float)
        m.std = np.asarray(d["standardize_std"], float)
        m.params = HMMParams.from_dict(d["params"])
        m.descriptions = d.get("descriptions", [])
        m.loglik = d.get("loglik", float("nan"))
        m.bic = d.get("bic", float("nan"))
        return m


def fit_regimes(md_train: MarketData, n_states: int | str = 4, window: int = 20, seed: int = 0,
                candidates: tuple[int, ...] = (2, 3, 4, 5)) -> RegimeModel:
    if n_states == "auto":
        best = None
        for k in candidates:
            try:
                m = RegimeModel(k, window, seed).fit(md_train)
            except ValueError:
                continue
            if best is None or m.bic < best.bic:
                best = m
        if best is None:
            raise ValueError("could not fit any regime model")
        return best
    return RegimeModel(int(n_states), window, seed).fit(md_train)
