import dataclasses

import numpy as np
import pytest

from strategy_explorer.backtest import CostModel, ExecConfig, compute_metrics, run_backtest
from strategy_explorer.backtest.lookahead import truncation_test
from strategy_explorer.data import MarketData
from strategy_explorer.dsl import EvalContext, Signals, Strategy, compile_strategy
from strategy_explorer.dsl import registry as R

ZERO = CostModel(0.0, 0.0, "none")


def make_md(opens, closes=None):
    opens = np.asarray(opens, dtype=float)
    closes = opens.copy() if closes is None else np.asarray(closes, dtype=float)
    n = len(opens)
    return MarketData("T", "1h", np.arange(n, dtype=np.int64) * 3_600_000, opens, np.maximum(opens, closes) * 1.001,
                      np.minimum(opens, closes) * 0.999, closes, np.ones(n))


def sig(n, le=(), lx=(), se=(), sx=()):
    def m(ix):
        a = np.zeros(n, dtype=bool)
        a[list(ix)] = True
        return a
    return Signals(m(le), m(lx), m(se), m(sx))


LONG = Strategy("long")
LS = Strategy("long_short")


def test_next_bar_open_execution_and_costs():
    md = make_md([100, 100, 100, 110, 120, 130, 140, 150, 150, 150])
    s = sig(10, le=[2], lx=[5])
    res = run_backtest(md, s, LONG, 0, 10, ZERO)
    t = res.trades[0]
    assert (t.signal_idx, t.entry_idx, t.exit_signal_idx, t.exit_idx) == (2, 3, 5, 6)
    assert t.entry_price == 110 and t.exit_price == 140
    assert t.net_pnl == pytest.approx(10_000 * (140 / 110 - 1))
    assert res.equity[-1] == pytest.approx(10_000 * 140 / 110)
    assert list(res.position) == [0, 0, 0, 1, 1, 1, 0, 0, 0, 0]
    costs = CostModel(fee_bps=10, slippage_bps=10, funding_mode="none")
    res2 = run_backtest(md, s, LONG, 0, 10, costs)
    t2 = res2.trades[0]
    assert t2.entry_price == pytest.approx(110 * 1.001) and t2.exit_price == pytest.approx(140 * 0.999)
    qty = 10_000 / t2.entry_price
    expected = qty * (t2.exit_price - t2.entry_price) - 0.001 * qty * (t2.entry_price + t2.exit_price)
    assert t2.net_pnl == pytest.approx(expected)
    assert t2.net_pnl < t.net_pnl and t2.gross_pnl == pytest.approx(qty * 30)


def test_signal_on_last_bar_not_executed_and_end_of_segment_close():
    md = make_md([100, 101, 102, 103, 104])
    res = run_backtest(md, sig(5, le=[4]), LONG, 0, 5, ZERO)
    assert res.trades == []
    res = run_backtest(md, sig(5, le=[1]), LONG, 0, 5, ZERO)
    t = res.trades[0]
    assert t.reason == "END_OF_SEGMENT" and t.exit_at_close and t.exit_idx == 4


def test_max_hold_stop_loss_take_profit():
    md = make_md([100] * 3 + [100, 99, 90, 89, 88, 87, 86, 86])
    st = Strategy("long", max_hold=3)
    t = run_backtest(md, sig(11, le=[2]), st, 0, 11, ZERO).trades[0]
    assert t.reason == "MAX_HOLD" and t.entry_idx == 3 and t.exit_idx == 6 and t.bars_held == 3
    st = Strategy("long", max_hold=50, stop_loss=0.05)
    t = run_backtest(md, sig(11, le=[2]), st, 0, 11, ZERO).trades[0]
    assert t.reason == "STOP_LOSS" and t.exit_signal_idx == 5 and t.exit_idx == 6
    md2 = make_md([100, 100, 100, 104, 108, 112, 113])
    st = Strategy("long", max_hold=50, take_profit=0.07)
    t = run_backtest(md2, sig(7, le=[1]), st, 0, 7, ZERO).trades[0]
    assert t.reason == "TAKE_PROFIT" and t.exit_signal_idx == 4


def test_reversal_conflict_and_ignored_opposite_entries():
    md = make_md(np.linspace(100, 120, 20))
    res = run_backtest(md, sig(20, le=[2], lx=[6], se=[6], sx=[10]), LS, 0, 20, ZERO)
    assert [(t.side, t.entry_idx, t.exit_idx) for t in res.trades] == [(1, 3, 7), (-1, 7, 11)]
    res = run_backtest(md, sig(20, le=[3], se=[3]), LS, 0, 20, ZERO)
    assert res.trades == []
    # short entry while long without long exit is ignored
    res = run_backtest(md, sig(20, le=[2], se=[5], lx=[9]), LS, 0, 20, ZERO)
    assert [(t.side, t.entry_idx) for t in res.trades] == [(1, 3)]
    # re-entry on the same bar as an exit signal is not allowed for the same side
    res = run_backtest(md, sig(20, le=[2, 6, 8], lx=[6]), Strategy("long", max_hold=100), 0, 20, ZERO)
    assert [t.entry_idx for t in res.trades] == [3, 9]


def test_short_pnl_and_funding():
    md = make_md([100, 100, 100, 90, 80, 80])
    res = run_backtest(md, sig(6, se=[1], sx=[3]), Strategy("short"), 0, 6, ZERO)
    t = res.trades[0]
    assert t.entry_price == 100 and t.exit_price == 80 and t.net_pnl == pytest.approx(10_000 * 0.2)
    fund = CostModel(0, 0, "constant", funding_bps_per_8h=10.0, funding_side="both_pay")
    t2 = run_backtest(md, sig(6, se=[1], sx=[3]), Strategy("short"), 0, 6, fund).trades[0]
    per_bar = 0.001 / 8  # 10 bps per 8h on 1h bars
    assert t2.funding == pytest.approx(sum(100 * per_bar * c for c in [100, 90]), rel=1e-9)


def test_signal_delay_and_missed_trades_and_adverse_entry():
    md = make_md(np.linspace(100, 130, 30))
    s = sig(30, le=[2, 12, 22], lx=[5, 15, 25])
    base = run_backtest(md, s, LONG, 0, 30, ZERO)
    late = run_backtest(md, s, LONG, 0, 30, ZERO, ExecConfig(signal_delay=1))
    assert [t.entry_idx for t in late.trades] == [t.entry_idx + 1 for t in base.trades]
    adv = run_backtest(md, s, LONG, 0, 30, ZERO, ExecConfig(adverse_entry_bps=50))
    assert all(a.entry_price > b.entry_price for a, b in zip(adv.trades, base.trades))
    miss = run_backtest(md, s, LONG, 0, 30, ZERO, ExecConfig(missed_trade_prob=0.99, missed_trade_seed=1))
    assert len(miss.trades) < len(base.trades)


def test_segment_starts_flat_and_metrics(md_1h, reg_full):
    st = compile_strategy("LONG_ENTRY: GT(return(3), 0.004)\nLONG_EXIT: LT(return(3), 0)\nMAX_HOLD: 12", reg_full)
    ctx = EvalContext(md_1h, ("4h",))
    s = ctx.signals(st)
    res = run_backtest(md_1h, s, st, 1000, 2000, CostModel())
    assert all(1000 < t.entry_idx < 2000 for t in res.trades)
    m = compute_metrics(res, md_1h.ts[1000:2000], md_1h.periods_per_year())
    assert m["trades"] == len(res.trades) and m["valid"]
    assert m["max_drawdown"] <= 0 and 0 <= m["exposure"] <= 1
    assert m["gross_return"] > m["total_return"]  # costs always reduce the result
    assert len(m["block_returns"]) == 6


def test_truncation_test_detects_lookahead(md_1h, reg_full, monkeypatch):
    st = compile_strategy("LONG_ENTRY: GT(return(3), 0.002)\nMAX_HOLD: 5", reg_full)
    assert truncation_test(st, md_1h, ("4h",), n_cuts=4).valid
    leaky = dataclasses.replace(R.SIG_BY_KEY["return"],
                                impl=lambda ctx, n: np.r_[ctx.c[n:] / ctx.c[:-n] - 1.0, np.full(n, np.nan)])
    monkeypatch.setitem(R.SIG_BY_KEY, "return", leaky)
    rep = truncation_test(st, md_1h, ("4h",), n_cuts=4)
    assert not rep.valid and rep.mismatches


def test_htf_rule_is_causal(md_1h, reg_full):
    st = compile_strategy('LONG_ENTRY: AND(GT(tf("4h", range_position(10)), 0.7), GT(tf("1d", return(2)), 0))\n'
                          "MAX_HOLD: 6", reg_full)
    assert truncation_test(st, md_1h, ("4h", "1d"), n_cuts=5).valid
