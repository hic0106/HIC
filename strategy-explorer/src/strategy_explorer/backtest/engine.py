"""Deterministic event backtester (LONG / SHORT / CASH).

Execution semantics (identical for every candidate)
---------------------------------------------------
* Signals are computed at the CLOSE of bar t and filled at the OPEN of bar t+1
  (+ ``signal_delay`` extra bars in stress tests).
* When flat: a long entry signal opens a long, a short entry signal a short;
  both on the same bar -> conflict, no trade.
* When in a position only the exit conditions of that side are evaluated,
  starting at the close of the fill bar. Opposite entry signals are ignored,
  except that an exit bar which also carries an opposite entry (and no same
  side entry) reverses the position at the same open.
* MAX_HOLD n exits at the open after n bars in the trade; STOP_LOSS /
  TAKE_PROFIT are checked on bar closes and exit at the next open.
* A position still open at the end of the evaluated segment is closed at the
  last close (reason END_OF_SEGMENT), costs included. Each segment starts flat.
* Costs: fee per side on notional, slippage per side on the fill price,
  funding per bar held. Sizing is fixed-fraction (compounding) or fixed
  notional and is never optimised by the search.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np

from ..data.market import MarketData
from ..dsl.evaluator import Signals
from ..dsl.nodes import Strategy
from .costs import CostModel

_BIG = 1 << 62


@dataclass(frozen=True)
class ExecConfig:
    sizing: str = "fixed_fraction"
    leverage: float = 1.0
    initial_equity: float = 10_000.0
    notional: float = 10_000.0
    signal_delay: int = 0
    adverse_entry_bps: float = 0.0
    missed_trade_prob: float = 0.0
    missed_trade_seed: int = 0

    def __post_init__(self):
        if self.sizing not in ("fixed_fraction", "fixed_notional"):
            raise ValueError("sizing must be fixed_fraction or fixed_notional")
        if self.leverage <= 0:
            raise ValueError("leverage must be > 0")

    def to_dict(self) -> dict:
        return asdict(self)

    def replace(self, **kw) -> "ExecConfig":
        d = asdict(self)
        d.update(kw)
        return ExecConfig(**d)


@dataclass
class Trade:
    side: int
    signal_idx: int
    entry_idx: int
    entry_mid: float
    entry_price: float
    exit_signal_idx: int
    exit_idx: int
    exit_mid: float
    exit_price: float
    exit_at_close: bool
    reason: str
    qty: float = 0.0
    notional: float = 0.0
    equity_at_entry: float = 0.0
    gross_pnl: float = 0.0
    fees: float = 0.0
    slippage_cost: float = 0.0
    funding: float = 0.0
    net_pnl: float = 0.0
    ret: float = 0.0
    gross_ret: float = 0.0
    bars_held: int = 0
    mfe: float = 0.0
    mae: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class BacktestResult:
    start: int
    stop: int
    equity: np.ndarray
    returns: np.ndarray
    position: np.ndarray
    trades: list[Trade] = field(default_factory=list)
    initial_equity: float = 10_000.0
    ruined: bool = False

    @property
    def n(self) -> int:
        return self.stop - self.start


def _nxt(arr: np.ndarray, pos: int) -> int:
    k = int(np.searchsorted(arr, pos, side="left"))
    return int(arr[k]) if k < arr.shape[0] else _BIG


def _has(arr: np.ndarray, v: int) -> bool:
    k = int(np.searchsorted(arr, v, side="left"))
    return k < arr.shape[0] and int(arr[k]) == v


def simulate_trades(md: MarketData, sig: Signals, st: Strategy, start: int, stop: int, costs: CostModel,
                    ex: ExecConfig) -> list[Trade]:
    o, c = md.open, md.close
    last = stop - 1
    if stop - start < 2:
        return []
    allow_long = st.direction in ("long", "long_short")
    allow_short = st.direction in ("short", "long_short")
    empty = np.zeros(0, dtype=np.int64)

    def idx(mask: np.ndarray, allowed: bool) -> np.ndarray:
        if not allowed:
            return empty
        return np.flatnonzero(mask[start:stop]) + start

    le, lx = idx(sig.long_entry, allow_long), idx(sig.long_exit, allow_long)
    se, sx = idx(sig.short_entry, allow_short), idx(sig.short_exit, allow_short)
    delay = int(ex.signal_delay)
    slip = costs.slippage
    adverse = ex.adverse_entry_bps / 1e4
    rng = np.random.default_rng(ex.missed_trade_seed) if ex.missed_trade_prob > 0 else None
    trades: list[Trade] = []
    cursor = start
    forced: tuple[int, int] | None = None
    while True:
        if forced is not None:
            side, s_idx = forced
            forced = None
        else:
            nl, ns = _nxt(le, cursor), _nxt(se, cursor)
            if nl >= _BIG and ns >= _BIG:
                break
            if nl == ns:
                cursor = nl + 1
                continue
            side, s_idx = (1, nl) if nl < ns else (-1, ns)
        fill = s_idx + 1 + delay
        if fill > last:
            break
        if rng is not None and rng.random() < ex.missed_trade_prob:
            cursor = s_idx + 1
            continue
        entry_mid = float(o[fill])
        entry_px = entry_mid * (1.0 + side * (slip + adverse))
        exits = lx if side == 1 else sx
        j_rule = _nxt(exits, fill)
        j_time = fill + int(st.max_hold) - 1 if st.max_hold else _BIG
        j_cap = min(j_rule, j_time, last)
        j_risk, risk_reason = _BIG, ""
        if (st.stop_loss or st.take_profit) and j_cap >= fill:
            seg = c[fill:j_cap + 1]
            r = side * (seg / entry_px - 1.0)
            if st.stop_loss:
                hit = np.flatnonzero(r <= -st.stop_loss)
                if hit.size:
                    j_risk, risk_reason = fill + int(hit[0]), "STOP_LOSS"
            if st.take_profit:
                hit = np.flatnonzero(r >= st.take_profit)
                if hit.size and fill + int(hit[0]) < j_risk:
                    j_risk, risk_reason = fill + int(hit[0]), "TAKE_PROFIT"
        j = min(j_rule, j_time, j_risk)
        if j >= _BIG:
            reason = "END_OF_SEGMENT"
        elif j == j_risk:
            reason = risk_reason
        elif j == j_rule:
            reason = "EXIT_RULE"
        else:
            reason = "MAX_HOLD"
        exit_fill = j + 1 + delay if j < _BIG else _BIG
        if exit_fill > last:
            exit_idx, exit_mid, at_close = last, float(c[last]), True
            reason = "END_OF_SEGMENT"
        else:
            exit_idx, exit_mid, at_close = exit_fill, float(o[exit_fill]), False
        exit_px = exit_mid * (1.0 - side * slip)
        trades.append(Trade(side=side, signal_idx=s_idx, entry_idx=fill, entry_mid=entry_mid, entry_price=entry_px,
                            exit_signal_idx=j if j < _BIG else last, exit_idx=exit_idx, exit_mid=exit_mid,
                            exit_price=exit_px, exit_at_close=at_close, reason=reason))
        if at_close:
            break
        if st.direction == "long_short":
            opp, same = (se, le) if side == 1 else (le, se)
            if _has(opp, j) and not _has(same, j):
                forced = (-side, j)
        cursor = j + 1
    return trades


def run_backtest(md: MarketData, sig: Signals, st: Strategy, start: int, stop: int, costs: CostModel,
                 ex: ExecConfig | None = None) -> BacktestResult:
    ex = ex or ExecConfig()
    start, stop = int(start), int(min(stop, len(md)))
    n = max(0, stop - start)
    trades = simulate_trades(md, sig, st, start, stop, costs, ex)
    e0 = float(ex.initial_equity)
    equity = np.empty(n, dtype=np.float64)
    pos = np.zeros(n, dtype=np.int8)
    c, h, l = md.close, md.high, md.low
    fund, signed = costs.funding_rate_per_bar(len(md), md.bar_ms, md.extra.get("funding_rate"))
    fee = costs.fee
    cash = e0
    cur = start
    ruined = False
    kept: list[Trade] = []
    for tr in trades:
        e_i = tr.entry_idx
        equity[cur - start:e_i - start] = cash
        if cash <= 0:
            ruined = True
            break
        base = cash if ex.sizing == "fixed_fraction" else ex.notional / ex.leverage
        notional = base * ex.leverage
        qty = notional / tr.entry_price
        fee_in = fee * qty * tr.entry_price
        cash_after = cash - fee_in
        last_held = tr.exit_idx if tr.exit_at_close else tr.exit_idx - 1
        hs, he = e_i - start, last_held + 1 - start
        closes = c[e_i:last_held + 1]
        fr = fund[e_i:last_held + 1]
        fcost = (tr.side * qty * closes * fr) if signed else (qty * closes * fr)
        fcum = np.cumsum(fcost)
        equity[hs:he] = cash_after + tr.side * qty * (closes - tr.entry_price) - fcum
        pos[hs:he] = tr.side
        funding_total = float(fcum[-1]) if fcum.size else 0.0
        fee_out = fee * qty * tr.exit_price
        pnl_px = tr.side * qty * (tr.exit_price - tr.entry_price)
        tr.qty, tr.notional, tr.equity_at_entry = qty, notional, cash
        tr.gross_pnl = tr.side * qty * (tr.exit_mid - tr.entry_mid)
        tr.fees = fee_in + fee_out
        tr.slippage_cost = tr.gross_pnl - pnl_px
        tr.funding = funding_total
        tr.net_pnl = pnl_px - tr.fees - funding_total
        tr.ret = tr.net_pnl / cash
        tr.gross_ret = tr.gross_pnl / cash
        tr.bars_held = last_held - e_i + 1
        hi = float(np.max(h[e_i:last_held + 1]))
        lo = float(np.min(l[e_i:last_held + 1]))
        if tr.side == 1:
            tr.mfe, tr.mae = hi / tr.entry_price - 1.0, lo / tr.entry_price - 1.0
        else:
            tr.mfe, tr.mae = 1.0 - lo / tr.entry_price, 1.0 - hi / tr.entry_price
        cash = cash_after + pnl_px - funding_total - fee_out
        kept.append(tr)
        if tr.exit_at_close:
            equity[he - 1] = cash
            cur = last_held + 1
        else:
            cur = tr.exit_idx
    if ruined:
        equity[cur - start:] = max(cash, 0.0)
    else:
        equity[cur - start:] = cash
    prev = np.empty(n, dtype=np.float64)
    if n:
        prev[0] = e0
        prev[1:] = equity[:-1]
    with np.errstate(all="ignore"):
        rets = np.where(prev > 0, equity / prev - 1.0, 0.0)
    rets = np.maximum(rets, -1.0)
    return BacktestResult(start=start, stop=stop, equity=equity, returns=rets, position=pos, trades=kept,
                          initial_equity=e0, ruined=ruined)
