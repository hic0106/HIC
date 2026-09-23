import numpy as np
import pytest

from strategy_explorer.dsl import (DSLSyntaxError, DSLTypeError, EvalContext, TypeChecker, compile_strategy,
                                   complexity, parameters, parse_expr, set_param)
from strategy_explorer.dsl import primitives as P
from strategy_explorer.dsl.registry import Registry

EXAMPLE = """
LONG_ENTRY:
    AND(
        GT(volume_zscore(20), 1.2),
        GT(slope(log(close), 12), 0),
        GT(close_location_in_range(), 0.75)
    )
LONG_EXIT:
    OR(
        LT(slope(log(close), 8), 0),
        LT(volume_zscore(10), -0.5)
    )
"""


def test_example_from_spec_compiles(reg_full):
    st = compile_strategy(EXAMPLE, reg_full)
    assert st.direction == "long"
    assert "volume_zscore(20)" in st.text
    c = complexity(st)
    assert c.nodes > 10 and c.parameters == 9


def test_canonical_hash_is_order_invariant(reg_full):
    a = compile_strategy("LONG_ENTRY: AND(GT(return(3), 0), GT(volume_ratio(20), 1.5))\nMAX_HOLD: 5", reg_full)
    b = compile_strategy("LONG_ENTRY: AND(GT(volume_ratio(20), 1.5), AND(GT(return(3), 0), GT(return(3), 0)))\n"
                         "MAX_HOLD: 5", reg_full)
    assert a.hash == b.hash
    c = compile_strategy("LONG_ENTRY: LT(rolling_max(high, 20), close)\nMAX_HOLD: 5", reg_full)
    d = compile_strategy("LONG_ENTRY: GT(close, rolling_max(high, 20))\nMAX_HOLD: 5", reg_full)
    assert c.hash == d.hash


@pytest.mark.parametrize("bad", [
    "LONG_ENTRY: GT(close, 50000)\nMAX_HOLD: 3",           # absolute price vs constant
    "LONG_ENTRY: GT(volume, close)\nMAX_HOLD: 3",          # unit mismatch
    "LONG_ENTRY: GT(rsi(14), 30)\nMAX_HOLD: 3",            # famous indicators are not primitives
    "LONG_ENTRY: GT(return(3), 0)",                        # no exit and no max hold
    "LONG_ENTRY: GT(zscore(close, 1), 0)\nMAX_HOLD: 3",    # window below minimum
    "LONG_ENTRY: AND(GT(return(3), 0), 1.5)\nMAX_HOLD: 3",  # literal where BOOLEAN needed
    "LONG_ENTRY: return(3)\nMAX_HOLD: 3",                  # SERIES is not a signal
    "LONG_ENTRY: GT(tf(\"3h\", return(2)), 0)\nMAX_HOLD: 3",  # timeframe not configured
])
def test_type_errors(reg_full, bad):
    with pytest.raises((DSLTypeError, DSLSyntaxError)):
        compile_strategy(bad, reg_full)


def test_syntax_errors():
    with pytest.raises(DSLSyntaxError):
        parse_expr("GT(return(3), 0")
    with pytest.raises(DSLSyntaxError):
        parse_expr("GT(return(3) 0)")


def test_three_valued_logic_blocks_warmup_signals():
    x = np.array([np.nan, 1.0, 0.0, 1.0])
    y = np.array([0.0, np.nan, np.nan, 1.0])
    assert np.array_equal(P.and_(x, y), np.array([0.0, np.nan, 0.0, 1.0]), equal_nan=True)
    assert np.array_equal(P.or_(x, y), np.array([np.nan, 1.0, np.nan, 1.0]), equal_nan=True)
    assert np.isnan(P.not_(np.array([np.nan]))[0])


def test_slope_matches_polyfit():
    rng = np.random.default_rng(0)
    x = np.cumsum(rng.normal(size=50))
    s = P.slope(x, 10)
    assert np.isnan(s[:9]).all()
    assert s[30] == pytest.approx(np.polyfit(np.arange(10), x[21:31], 1)[0])


def test_primitives_are_causal(md_1h, reg_full):
    """Changing future bars never changes past feature values."""
    names = ["return(5)", "zscore(close, 20)", "rank(volume, 30)", "slope(log(close), 12)",
             "volume_zscore(20)", "relative_volume(5)", "compression_score(10)", "breakout_distance(20)",
             "range_position(20)", "trend_slope(20)", "volatility_ratio(5, 20)", "price_volume_correlation(20)",
             "count_true(GT(return(1), 0), 10)", "bars_since(GT(volume_ratio(20), 2))",
             "tf(\"4h\", range_position(10))", "tf(\"1d\", realized_volatility(5))", "range_contraction(5)",
             "rolling_quantile(close, 20, 0.8)", "taker_buy_ratio(10)", "volume_acceleration(6)"]
    cut = 2000
    md2 = md_1h.slice(0, len(md_1h))
    rng = np.random.default_rng(1)
    noise = np.exp(rng.normal(0, 0.05, len(md2) - cut))
    for arr in (md2.open, md2.high, md2.low, md2.close):
        arr[cut:] = arr[cut:] * noise
    md2.volume[cut:] = md2.volume[cut:] * 3.0
    a, b = EvalContext(md_1h, ("4h", "1d")), EvalContext(md2, ("4h", "1d"))
    tc = TypeChecker(reg_full)
    for text in names:
        node, _ = tc.check_expr(parse_expr(text))
        va, vb = a.eval(node)[:cut], b.eval(node)[:cut]
        assert np.array_equal(va, vb, equal_nan=True), text
        assert np.isfinite(va[-500:]).any(), text


def test_set_param_and_parameters(reg_full):
    st = compile_strategy(EXAMPLE, reg_full)
    ps = {p.name: p for p in parameters(st)}
    p = ps["long_entry.volume_zscore.window"]
    st2 = set_param(st, p.path, 24)
    assert "volume_zscore(24)" in st2.text
    st3 = set_param(st, ps["long_entry.slope.window"].path, 1)  # clamped to the minimum window of slope
    assert "slope(log(close), 3)" in st3.text
    ctx = EvalContext(__import__("strategy_explorer.data.synthetic", fromlist=["x"]).generate_synthetic(800, "1h"),
                      ("4h",))
    ctx.signals(st2)


def test_regime_and_pattern_ops_need_context():
    reg = Registry()
    with pytest.raises(DSLTypeError):
        compile_strategy("LONG_ENTRY: regime_is(1)\nMAX_HOLD: 3", reg)
    reg2 = Registry(n_regimes=3, pattern_ids=("M1",))
    st = compile_strategy('LONG_ENTRY: AND(regime_is(2), LT(pattern_distance("M1"), 1.0))\nMAX_HOLD: 3', reg2)
    assert "regime_is(2)" in st.text
    with pytest.raises(DSLTypeError):
        compile_strategy("LONG_ENTRY: regime_is(3)\nMAX_HOLD: 3", reg2)
