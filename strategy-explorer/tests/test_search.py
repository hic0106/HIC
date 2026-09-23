"""Typed GP generation/variation, NSGA-II, budget, novelty and known-strategy fingerprints."""

import numpy as np
import pytest

from strategy_explorer.backtest import CostModel, ExecConfig
from strategy_explorer.data import make_split
from strategy_explorer.data.synthetic import generate_synthetic
from strategy_explorer.dsl import EvalContext, compile_strategy
from strategy_explorer.dsl.registry import Registry
from strategy_explorer.search import nsga2
from strategy_explorer.search.budget import EXPLOIT, EXPLORE, SearchBudget
from strategy_explorer.search.fingerprints import KNOWN_LIKE, classify, positions_for, reference_strategies
from strategy_explorer.search.generator import (PARAMETRIC_OPS, STRUCTURAL_OPS, GenConfig, ThresholdSampler,
                                                TypedGenerator, Variation)
from strategy_explorer.search.novelty import NoveltyArchive, ast_similarity, trade_overlap
from strategy_explorer.backtest.engine import run_backtest


@pytest.fixture(scope="module")
def env():
    md = generate_synthetic(3000, "4h", seed=4)
    reg = Registry(columns=frozenset(md.available_columns()), htf=("1d",), n_regimes=0, base_timeframe="4h")
    ctx = EvalContext(md, ("1d",))
    sampler = ThresholdSampler(ctx, (0, 1500), np.random.default_rng(1))
    gen = TypedGenerator(reg, sampler, np.random.default_rng(2), GenConfig())
    return md, reg, ctx, gen, Variation(gen, np.random.default_rng(3))


def test_generated_strategies_are_well_typed_and_causal(env):
    md, reg, ctx, gen, var = env
    ok = 0
    for _ in range(80):
        st = gen.finalize(gen.strategy())
        if st is None:
            continue
        ok += 1
        # round-trip through text: parse -> type check -> identical canonical hash
        assert compile_strategy(st.text, reg, 200, 30).hash == st.hash
        ctx.signals(st)
    assert ok >= 60


def test_variation_operators_preserve_types(env):
    md, reg, ctx, gen, var = env
    base = [gen.finalize(gen.strategy()) for _ in range(20)]
    base = [b for b in base if b is not None]
    produced = 0
    for op in STRUCTURAL_OPS + PARAMETRIC_OPS:
        for st in base[:8]:
            child = var.apply(op, st)
            if child is None:
                continue
            child = gen.finalize(child)
            if child is None:
                continue
            produced += 1
            assert compile_strategy(child.text, reg, 200, 30).hash == child.hash
    for a, b in zip(base[:8], base[1:9]):
        child = var.crossover(a, b)
        if child is not None and gen.finalize(child) is not None:
            produced += 1
    assert produced > 40


def test_thresholds_are_train_quantiles(env):
    md, reg, ctx, gen, var = env
    node = compile_strategy("LONG_ENTRY: GT(volume_zscore(20), 0)\nMAX_HOLD: 3", reg).long_entry.args[0].args[0]
    thr = gen.sampler.at_quantile(node, 0.9)
    vals = np.asarray(ctx.eval(node))[:1500]
    assert thr == pytest.approx(float(np.nanquantile(vals, 0.9)), rel=1e-3)


def test_nsga2_fronts_and_crowding():
    F = np.array([[1, 5], [2, 3], [3, 1], [2, 4], [4, 4], [3, 3]], dtype=float)
    fronts = nsga2.fast_non_dominated_sort(F)
    assert sorted(fronts[0]) == [0, 1, 2]
    assert sorted(fronts[1]) == [3, 5]
    cd = nsga2.crowding_distance(F[fronts[0]])
    assert np.isinf(cd).sum() == 2
    viol = np.array([0, 0, 0, 0, 0, 1.0])
    fr = nsga2.fast_non_dominated_sort(F, viol)
    assert 5 in fr[-1]  # infeasible solutions are dominated by every feasible one
    sel = nsga2.select(F, None, 3)
    assert sorted(sel) == [0, 1, 2]


def test_budget_split_is_strict():
    b = SearchBudget(10, 0.6)
    assert b.caps == {EXPLORE: 6, EXPLOIT: 4}
    for _ in range(6):
        b.spend(EXPLORE)
    assert not b.can_spend(EXPLORE) and b.can_spend(EXPLOIT)
    with pytest.raises(RuntimeError):
        b.spend(EXPLORE)
    for _ in range(4):
        b.spend(EXPLOIT)
    assert b.exhausted


def test_novelty_archive_detects_near_duplicates():
    arch = NoveltyArchive(dim=64)
    rng = np.random.default_rng(0)
    a = rng.normal(size=64).astype(np.float32)
    arch.add(1, a, a, "h1")
    info = arch.query(a + 0.01 * rng.normal(size=64).astype(np.float32), a)
    assert info.max_similarity > 0.99 and info.closest_trial == 1
    far = arch.query(rng.normal(size=64).astype(np.float32), rng.normal(size=64).astype(np.float32))
    assert far.max_similarity < 0.6
    pa = np.array([0, 1, 1, 1, 0, -1, -1, 0], dtype=np.int8)
    assert trade_overlap(pa, pa) == 1.0
    assert trade_overlap(pa, -pa) == 0.0


def test_known_strategy_fingerprints(env):
    md, reg, ctx, gen, var = env
    known = reference_strategies(md)
    names = {k.name for k in known}
    assert {"RSI14<30", "SMA50/200_cross", "MACD12/26/9", "Donchian20/10", "BuyAndHold"} <= names
    kp = {k.name: (k.family, positions_for(md, k, 0, len(md))) for k in known}
    # a channel breakout written in the DSL is recognised structurally
    donchian = compile_strategy("LONG_ENTRY: GT(close, lag(rolling_max(high, 20), 1))\n"
                                "LONG_EXIT: GT(lag(rolling_min(low, 10), 1), close)", reg)
    pos = run_backtest(md, ctx.signals(donchian), donchian, 0, len(md), CostModel(0, 0, "none"), ExecConfig()).position
    rep = classify(donchian, pos, kp)
    assert rep.novelty_class == KNOWN_LIKE and "channel_breakout" in rep.structural
    # an almost-always-long rule is buy-and-hold in disguise
    always = compile_strategy("LONG_ENTRY: GT(realized_volatility(20), 0)\nLONG_EXIT: LT(realized_volatility(20), 0)",
                              reg)
    pos2 = run_backtest(md, ctx.signals(always), always, 0, len(md), CostModel(0, 0, "none"), ExecConfig()).position
    rep2 = classify(always, pos2, kp)
    assert rep2.novelty_class == KNOWN_LIKE and rep2.closest in ("BuyAndHold",) or rep2.max_similarity > 0.9
    assert ast_similarity(donchian, donchian) == 1.0
