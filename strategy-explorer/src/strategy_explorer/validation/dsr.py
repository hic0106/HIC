"""Probabilistic and Deflated Sharpe Ratio (Bailey & Lopez de Prado, 2014).

    SR0 = sqrt(V[SR_n]) * ((1 - g) * Z^-1(1 - 1/N) + g * Z^-1(1 - 1/(N e)))
    PSR(SR*) = Z( (SR - SR*) * sqrt(T - 1) / sqrt(1 - g3 * SR + (g4 - 1) / 4 * SR^2) )
    DSR = PSR(SR0)

SR values are per-bar (not annualised), T is the number of bars, g3 the
skewness and g4 the (raw, non-excess) kurtosis of the per-bar returns, N the
number of trials and g the Euler-Mascheroni constant. V[SR_n] is the variance
of the trials' Sharpe estimates under the null that every trial has zero true
Sharpe. Two estimators are available (``dsr.variance``):

* ``sampling`` (default): the sampling variance of the SR estimator at SR = 0,
  ~1 / (T - 1). SR0 then grows with the number of distinct trials N only.
* ``cross_sectional``: the observed variance of the trials' Sharpe ratios on the
  same segment, as in Bailey & Lopez de Prado (2014). It also contains the *true*
  dispersion between trials (cost-dragged losers, many rediscoveries of one
  edge), so SR0 rises when the search succeeds; stricter, reported as a
  diagnostic. ``max`` takes the larger of the two.
"""

from __future__ import annotations

import math
from statistics import NormalDist

import numpy as np

EULER_GAMMA = 0.5772156649015329
_N = NormalDist()


def expected_max_sharpe(n_trials: int, var_sr: float) -> float:
    if n_trials <= 1 or var_sr <= 0:
        return 0.0
    z1 = _N.inv_cdf(1.0 - 1.0 / n_trials)
    z2 = _N.inv_cdf(1.0 - 1.0 / (n_trials * math.e))
    return math.sqrt(var_sr) * ((1.0 - EULER_GAMMA) * z1 + EULER_GAMMA * z2)


def probabilistic_sharpe(sr: float, sr_benchmark: float, T: int, skew: float, kurt: float) -> float:
    if T < 3:
        return 0.0
    denom = 1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr * sr
    denom = math.sqrt(max(denom, 1e-12))
    return float(_N.cdf((sr - sr_benchmark) * math.sqrt(T - 1.0) / denom))


def deflated_sharpe(sr: float, T: int, skew: float, kurt: float, n_trials: int, var_sr: float) -> dict:
    sr0 = expected_max_sharpe(n_trials, var_sr)
    return {
        "sharpe_per_bar": float(sr),
        "bars": int(T),
        "skew": float(skew),
        "kurtosis": float(kurt),
        "n_trials": int(n_trials),
        "trial_sharpe_variance": float(var_sr),
        "expected_max_sharpe": float(sr0),
        "dsr": probabilistic_sharpe(sr, sr0, T, skew, kurt),
        "psr_vs_zero": probabilistic_sharpe(sr, 0.0, T, skew, kurt),
    }


def trial_sharpe_variance(sharpes: list[float] | np.ndarray) -> float:
    s = np.asarray([x for x in sharpes if x is not None and math.isfinite(x)], dtype=np.float64)
    if s.size < 2:
        return 0.0
    return float(s.var(ddof=1))


def effective_trials(vectors: np.ndarray, threshold: float = 0.7) -> int:
    """Number of behaviourally distinct trials: greedy clustering of unit-normalised
    return vectors, a trial joins the first cluster whose representative has
    correlation > ``threshold``. Used as N in the DSR (raw N is reported too)."""
    V = np.asarray(vectors, dtype=np.float32)
    if V.ndim != 2 or V.shape[0] == 0:
        return 0
    reps: list[np.ndarray] = []
    R = np.zeros((0, V.shape[1]), dtype=np.float32)
    for v in V:
        if R.shape[0] and float(np.max(R @ v)) > threshold:
            continue
        reps.append(v)
        R = np.vstack([R, v[None, :]])
    return len(reps)
