"""Overfitting firewall statistics, gate logic, walk-forward folds and pattern discovery sanity."""

import math

import numpy as np
import pytest

from strategy_explorer.data.synthetic import generate_synthetic
from strategy_explorer.dsl.registry import Registry
from strategy_explorer.patterns import PatternConfig, discover_patterns
from strategy_explorer.patterns.stats import benjamini_hochberg
from strategy_explorer.regimes.hmm import GaussianHMM, forward_backward, forward_filter, log_emission
from strategy_explorer.validation.dsr import deflated_sharpe, effective_trials, expected_max_sharpe, probabilistic_sharpe
from strategy_explorer.validation.gate import PROMISING, REJECTED, RESEARCH_WINNER, GateConfig, evaluate_gate
from strategy_explorer.validation.pbo import cscv_pbo


def test_expected_max_sharpe_matches_paper():
    # Bailey & Lopez de Prado: ~3.26 after 1,000 independent trials with unit variance
    assert expected_max_sharpe(1000, 1.0) == pytest.approx(3.26, abs=0.01)
    assert expected_max_sharpe(1, 1.0) == 0.0


def test_psr_and_dsr_monotonic():
    base = probabilistic_sharpe(0.05, 0.0, 1000, 0.0, 3.0)
    assert 0.5 < base < 1.0
    assert probabilistic_sharpe(0.05, 0.0, 4000, 0.0, 3.0) > base   # more data -> more confidence
    assert probabilistic_sharpe(0.05, 0.0, 1000, -1.0, 10.0) < base  # negative skew / fat tails -> less
    d_few = deflated_sharpe(0.05, 1000, 0.0, 3.0, 10, 0.0004)["dsr"]
    d_many = deflated_sharpe(0.05, 1000, 0.0, 3.0, 5000, 0.0004)["dsr"]
    assert d_many < d_few  # more trials -> larger deflation


def test_effective_trials_clusters_duplicates():
    rng = np.random.default_rng(0)
    base = rng.normal(size=(5, 64))
    V = np.vstack([b + 0.01 * rng.normal(size=(20, 64)) for b in base])
    V = V - V.mean(axis=1, keepdims=True)
    V /= np.linalg.norm(V, axis=1, keepdims=True)
    assert effective_trials(V, 0.7) == 5


def test_pbo_noise_vs_edge():
    vals = []
    for s in range(12):
        M = np.random.default_rng(s).normal(0, 0.01, (800, 30))
        vals.append(cscv_pbo(M, 12, max_combinations=2000)["pbo"])
    assert 0.3 < np.mean(vals) < 0.7
    M = np.random.default_rng(1).normal(0, 0.01, (800, 30))
    M[:, 3] += 0.004
    assert cscv_pbo(M, 12)["pbo"] < 0.05


def test_benjamini_hochberg():
    q = benjamini_hochberg([0.01, 0.04, 0.03, 0.2])
    assert q[0] == pytest.approx(0.04) and q[3] == pytest.approx(0.2)
    assert all(a <= 1 for a in q)


def _bundle(**over):
    v = {
        "oos": {"expectancy": 0.01, "trades": 40, "max_drawdown": -0.1, "best_trade_share": 0.1,
                "best_month_share": 0.2},
        "test": {"total_return": 0.2}, "train": {"trades": 60},
        "full": {"best_trade_share": 0.1, "best_month_share": 0.2},
        "stress": {"cost_survival": True, "passed": True, "scenarios": {}, "missed_trades": {"positive_fraction": 1}},
        "sensitivity": {"passed": True}, "walk_forward": {"passed": True, "positive_fraction": 1.0},
        "dsr": {"dsr": 0.99}, "pbo_experiment": {"pbo": 0.1}, "pbo_candidate": {"pbo": 0.6},
        "lookahead": {"valid": True, "mismatches": []},
        "concentration": {"oos_best_trade_share": 0.1, "full_best_trade_share": 0.1, "oos_best_month_share": 0.2,
                          "full_best_month_share": 0.2},
        "costless": False,
    }
    for k, val in over.items():
        v[k] = val
    return v


def test_gate_statuses():
    cfg = GateConfig()
    assert evaluate_gate(_bundle(), cfg)["status"] == RESEARCH_WINNER
    g = evaluate_gate(_bundle(dsr={"dsr": 0.5}), cfg)
    assert g["status"] == PROMISING and [c["name"] for c in g["checks"] if not c["passed"]] == ["deflated_sharpe"]
    assert evaluate_gate(_bundle(lookahead={"valid": False, "mismatches": [1]}), cfg)["status"] == REJECTED
    assert evaluate_gate(_bundle(costless=True), cfg)["status"] == REJECTED  # cost-free results never win
    conc = {"oos_best_trade_share": 0.45, "full_best_trade_share": 0.1, "oos_best_month_share": 0.2,
            "full_best_month_share": 0.2}
    g2 = evaluate_gate(_bundle(concentration=conc), cfg)
    assert g2["warnings"] == ["CONCENTRATION_WARNING: one trade = 45% of net profit (>= 40%)"]
    assert g2["status"] == RESEARCH_WINNER
    g3 = evaluate_gate(_bundle(concentration={**conc, "oos_best_trade_share": 0.6}), cfg)
    assert "no_single_trade_dominance" in [c["name"] for c in g3["checks"] if not c["passed"]]


def test_hmm_forward_backward_matches_bruteforce():
    rng = np.random.default_rng(0)
    T = 400
    s = np.zeros(T, int)
    for t in range(1, T):
        s[t] = s[t - 1] if rng.random() < 0.97 else 1 - s[t - 1]
    X = np.where(s[:, None] == 0, rng.normal(0, 1, (T, 2)), rng.normal(2.5, 0.6, (T, 2)))
    h = GaussianHMM(2, seed=1, n_iter=30).fit(X)
    logB = log_emission(X[:60], h.params)
    B = np.exp(logB)
    a = h.params.pi * B[0]
    ll = math.log(a.sum())
    a /= a.sum()
    rows = [a]
    for t in range(1, 60):
        a = (a @ h.params.A) * B[t]
        ll += math.log(a.sum())
        a /= a.sum()
        rows.append(a)
    probs, ll2 = forward_filter(logB, h.params)
    assert np.allclose(probs, np.array(rows)) and ll2 == pytest.approx(ll)
    p_short, _ = forward_filter(logB[:25], h.params)
    assert np.array_equal(p_short, probs[:25])  # exactly causal
    _, gamma, _ = forward_backward(logB, h.params)
    assert np.allclose(gamma.sum(axis=1), 1.0)


def test_pattern_discovery_null_vs_planted():
    # BH at q=0.10 bounds the chance of *any* discovery on a null series by ~10%: count null series with one
    hits = 0
    for seed in range(1, 9):
        null = generate_synthetic(5000, "4h", seed=seed).slice(0, 2600)
        reg = Registry(columns=frozenset(null.available_columns()), base_timeframe="4h")
        pats, _ = discover_patterns(null, reg, PatternConfig(use_shapelets=False, use_motifs=False), seed=1)
        hits += any(p.kind == "conditional" for p in pats)
    assert hits <= 2, hits
    md = generate_synthetic(5000, "4h", seed=5, plant="squeeze_breakout", plant_strength=2.0)
    train = md.slice(0, 2600)
    pats, lib = discover_patterns(train, reg, PatternConfig(use_shapelets=False), seed=1)
    ev = np.array([e for e in md.synthetic_events if e < 2600])
    longs = [p for p in pats if p.direction == "long" and p.kind == "conditional"]
    assert longs, [p.dsl for p in pats]
    best = longs[0]
    near = np.mean([np.any(np.abs(o - ev) <= 8) for o in best.occurrences])
    assert near > 0.5, best.dsl
