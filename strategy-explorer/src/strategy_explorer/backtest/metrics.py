"""Performance metrics computed from a BacktestResult (always net of costs unless named gross_*)."""

from __future__ import annotations

import math

import numpy as np

from .engine import BacktestResult

PF_CAP = 99.0


def _bucket_sum(keys: np.ndarray, values: np.ndarray) -> np.ndarray:
    if keys.size == 0:
        return np.zeros(0)
    uniq, inv = np.unique(keys, return_inverse=True)
    out = np.zeros(uniq.shape[0])
    np.add.at(out, inv, values)
    return out


def moments(r: np.ndarray) -> tuple[float, float]:
    """Skewness and raw (non-excess) kurtosis; normal = (0, 3)."""
    if r.size < 3:
        return 0.0, 3.0
    mu = r.mean()
    d = r - mu
    m2 = float(np.mean(d * d))
    if m2 <= 0:
        return 0.0, 3.0
    return float(np.mean(d ** 3) / m2 ** 1.5), float(np.mean(d ** 4) / m2 ** 2)


def compute_metrics(res: BacktestResult, ts: np.ndarray, periods_per_year: float, n_blocks: int = 6,
                    leverage: float = 1.0) -> dict:
    """``ts`` must be the bar open times of the evaluated segment [res.start, res.stop)."""
    n = res.n
    e0 = res.initial_equity
    out: dict = {"bars": int(n), "trades": len(res.trades)}
    if n == 0:
        out.update(total_return=0.0, valid=False)
        return out
    rets = res.returns
    eq = res.equity
    years = n / periods_per_year if periods_per_year > 0 else 0.0
    total = float(eq[-1] / e0 - 1.0)
    cagr = (1.0 + total) ** (1.0 / years) - 1.0 if years > 0 and total > -1.0 else -1.0
    mu = float(rets.mean())
    sd = float(rets.std(ddof=1)) if n > 1 else 0.0
    sharpe_bar = mu / sd if sd > 0 else 0.0
    downside = float(np.sqrt(np.mean(np.minimum(rets, 0.0) ** 2)))
    if downside > 0:
        sortino = mu / downside * math.sqrt(periods_per_year)
    else:
        sortino = 10.0 if mu > 0 else 0.0
    curve = np.r_[e0, eq]
    peak = np.maximum.accumulate(curve)
    dd = curve / peak - 1.0
    mdd = float(dd.min())
    trades = res.trades
    net = np.array([t.net_pnl for t in trades], dtype=np.float64)
    tr_ret = np.array([t.ret for t in trades], dtype=np.float64)
    gross_ret = np.array([t.gross_ret for t in trades], dtype=np.float64)
    gp = float(net[net > 0].sum()) if net.size else 0.0
    gl = float(-net[net < 0].sum()) if net.size else 0.0
    pf = gp / gl if gl > 0 else (PF_CAP if gp > 0 else 0.0)
    total_net = float(net.sum()) if net.size else 0.0
    skew, kurt = moments(rets)
    # concentration (only meaningful for profitable results)
    bar_pnl = np.diff(curve)
    t64 = ts.astype("datetime64[ms]")
    months = t64.astype("datetime64[M]").astype(np.int64)
    weeks = t64.astype("datetime64[W]").astype(np.int64)
    month_pnl = _bucket_sum(months, bar_pnl)
    week_pnl = _bucket_sum(weeks, bar_pnl)
    pnl_total = float(bar_pnl.sum())
    if pnl_total > 0:
        best_trade_share = float(net.max() / pnl_total) if net.size else 0.0
        best_month_share = float(month_pnl.max() / pnl_total) if month_pnl.size else 0.0
        best_week_share = float(week_pnl.max() / pnl_total) if week_pnl.size else 0.0
    else:
        best_trade_share = best_month_share = best_week_share = float("nan")
    # consistency across equal sub-periods
    blocks = []
    edges = np.linspace(0, n, n_blocks + 1).astype(int)
    for a, b in zip(edges[:-1], edges[1:]):
        if b <= a:
            continue
        start_eq = curve[a]
        blocks.append(float(curve[b] / start_eq - 1.0) if start_eq > 0 else -1.0)
    blocks_arr = np.array(blocks) if blocks else np.zeros(0)
    exposure = float(np.mean(res.position != 0))
    out.update(
        valid=True,
        total_return=total,
        cagr=float(cagr),
        years=float(years),
        mean_bar_return=mu,
        vol_bar=sd,
        ann_vol=sd * math.sqrt(periods_per_year),
        sharpe_bar=float(sharpe_bar),
        sharpe=float(sharpe_bar * math.sqrt(periods_per_year)),
        sortino=float(sortino),
        max_drawdown=mdd,
        calmar=float(cagr / abs(mdd)) if mdd < 0 else 0.0,
        profit_factor=float(min(pf, PF_CAP)),
        win_rate=float((net > 0).mean()) if net.size else 0.0,
        expectancy=float(tr_ret.mean()) if tr_ret.size else 0.0,
        median_trade=float(np.median(tr_ret)) if tr_ret.size else 0.0,
        avg_bars_held=float(np.mean([t.bars_held for t in trades])) if trades else 0.0,
        exposure=exposure,
        turnover=float(2.0 * len(trades) * leverage / years) if years > 0 else 0.0,
        trades_per_year=float(len(trades) / years) if years > 0 else 0.0,
        gross_return=float(np.prod(1.0 + gross_ret) - 1.0) if gross_ret.size else 0.0,
        cost_fees=float(sum(t.fees for t in trades) / e0),
        cost_slippage=float(sum(t.slippage_cost for t in trades) / e0),
        cost_funding=float(sum(t.funding for t in trades) / e0),
        skew=skew,
        kurtosis=kurt,
        best_trade_share=best_trade_share,
        best_month_share=best_month_share,
        best_week_share=best_week_share,
        block_returns=[float(b) for b in blocks_arr],
        consistency=float((blocks_arr > 0).mean()) if blocks_arr.size else 0.0,
        worst_block=float(blocks_arr.min()) if blocks_arr.size else 0.0,
        long_trades=int(sum(1 for t in trades if t.side == 1)),
        short_trades=int(sum(1 for t in trades if t.side == -1)),
        ruined=bool(res.ruined),
        total_net_pnl=total_net,
    )
    return out


SUMMARY_KEYS = ("total_return", "cagr", "sharpe", "sortino", "max_drawdown", "profit_factor", "win_rate",
                "expectancy", "trades", "exposure", "turnover", "consistency", "gross_return")


def summary(m: dict) -> dict:
    return {k: m.get(k) for k in SUMMARY_KEYS}
