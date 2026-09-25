// Backtester: replays the EXISTING strategy functions (strategyRegistry.evaluateStrategy) bar by bar with the
// user's current settings (params, timeframe, stop, take profit, short on/off, fees, slippage, funding).
// Rules mirror the live engine:
//   - signal on a CLOSED candle; the order fills at the next candle's open (± slippage)
//   - indicator window = same length the live engine keeps (4h: 1000 bars, 1d: 500 bars, US session: all)
//   - emergency stop fixed at entry from the ATR of the signal candle (min/max clamp); checked intrabar
//     (gap through the stop -> filled at the open); take profit likewise; stop assumed first if both hit
//   - exit first, then entry on the same candle (flip); one position per strategy × symbol
//   - re-arm after stop exits for ADX / TSMOM / QQQ (resetAfterStop), Turtle re-enters on a new breakout
//   - funding: position value × historical funding rate at each funding time held (paid when > 0 for longs)
//   - Rayner: structure stop from the signal candle (entry skipped if it is not beyond the fill), histogram target
//     fixed at entry (RAYNER_HIST_TP), at most maxEntriesPerTrend entries per side until a close across the EMA
//   - dynamic crypto universe (optional tradeFilter(symbol, signalTime)): new entries only when the symbol was in the
//     historical trade set at the signal time; exits / stops are never filtered
// Sizing: each strategy has its own account (capital). Each slot gets equity / nSlots at entry (compound) or
// capital / nSlots (fixed); nSlots = number of symbols, or `slots` (e.g. tradeTopN) when given - then at most
// `slots` positions are open at once. 1x notional, no leverage.
import { META, evaluateStrategy, symbolsForStrategy, exitFor, entryStop, stopReasonOf, trendCounts, recordTrendEntry } from '../strategyRegistry.js';
import { timeframeOf, US_SESSION } from '../scheduler/timeframes.js';

// indicator window = what the live market data keeps: 1000 bars per interval, 500 daily
export const LIVE_WINDOW = new Proxy({ '1d': 500, [US_SESSION]: Infinity }, { get: (o, k) => (k in o ? o[k] : 1000) });
const dirOf = (side) => (side === 'LONG' ? 1 : -1);

// custom (optional): { cfg, meta, timeframe, prepare(bars) -> (i) => signal } for AI rule strategies (server/ai/dsl.js)
export async function backtestStrategy({ strategy, config, data, funding = {}, start, end, capital, compound = true, symbols, custom = null, tradeFilter = null, slots = null, universeNote = null }) {
  symbols ||= custom?.symbols || symbolsForStrategy(strategy);
  const scfg = custom ? custom.cfg : config.strategies[strategy];
  const g = config.general;
  const tf = custom ? custom.timeframe : timeframeOf(strategy, config);
  const W = LIVE_WINDOW[tf] ?? 1000;
  const fee = g.takerFeePct / 100, slip = g.slippagePct / 100;
  const useFunding = !!g.includeFunding;
  const meta = custom ? custom.meta : META[strategy];
  const n = Math.max(1, Math.min(symbols.length, slots > 0 ? slots : symbols.length));
  const capSlots = n < symbols.length; // more watched symbols than slots: limit concurrent positions

  let cash = capital; // realized equity
  const trades = [], equity = [], notes = [];
  const pos = {}, pending = {}, block = {}, lastPx = {}, fIdx = {}, trendEntries = {};
  const stats = { fees: 0, funding: 0, signalsSkipped: 0, notReady: {}, universeSkipped: 0, slotsFull: 0, stopInvalid: 0, trendMax: 0 };
  for (const s of symbols) { block[s] = { LONG: false, SHORT: false }; pending[s] = []; fIdx[s] = 0; trendEntries[s] = { LONG: [], SHORT: [] }; }

  // timeline: open times of bars inside [start, end] across this strategy's symbols
  const bars = {};
  const times = new Set();
  for (const s of symbols) {
    bars[s] = data[s] || [];
    for (const b of bars[s]) if (b.t >= start && b.T < end) times.add(b.t);
  }
  const timeline = [...times].sort((a, b) => a - b);
  const idx = {};
  for (const s of symbols) { idx[s] = new Map(); bars[s].forEach((b, i) => idx[s].set(b.t, i)); }
  const evalAt = {};
  if (custom) for (const s of symbols) evalAt[s] = custom.prepare(bars[s]);

  const unrealized = (s, px) => { const p = pos[s]; return p ? (px - p.entry) * p.qty * dirOf(p.side) : 0; };
  const equityNow = () => cash + symbols.reduce((a, s) => a + (pos[s] ? unrealized(s, lastPx[s]) - pos[s].fundingAcc : 0), 0);

  const close = (s, rawPx, time, reason) => {
    const p = pos[s];
    const px = rawPx * (1 - dirOf(p.side) * slip);
    const gross = (px - p.entry) * p.qty * dirOf(p.side);
    const exitFee = px * p.qty * fee;
    stats.fees += exitFee;
    const net = gross - p.entryFee - exitFee - p.fundingAcc;
    cash += gross - exitFee - p.fundingAcc; // entry fee was already taken from cash
    trades.push({ strategy, symbol: s, side: p.side, entryTime: p.time, entryPrice: p.entry, exitTime: time, exitPrice: px, qty: p.qty, notional: p.notional,
      stopPrice: p.stop, gross, fees: p.entryFee + exitFee, funding: -p.fundingAcc, net, returnPct: (net / p.notional) * 100, reason });
    delete pos[s];
    if (reason !== 'STRATEGY_EXIT' && meta.resetAfterStop) block[s][p.side] = true;
    return trades[trades.length - 1];
  };

  const open = (s, o, rawPx, time) => {
    const { side } = o;
    const px = rawPx * (1 + dirOf(side) * slip);
    if (capSlots && Object.keys(pos).length >= n) { stats.slotsFull++; return; }
    const es = entryStop(scfg.stop, { atr: o.atr, structStop: { [side]: o.structStop } }, side, px);
    if (es.invalid) { stats.stopInvalid++; return; } // structure stop not beyond the fill -> entry cancelled
    const eq = equityNow();
    const alloc = (compound ? Math.max(0, eq) : capital) / n;
    if (!(alloc > 0)) return;
    const qty = alloc / px;
    const entryFee = alloc * fee;
    stats.fees += entryFee;
    cash -= entryFee;
    pos[s] = { side, entry: px, qty, notional: alloc, time, entryFee, fundingAcc: 0,
      stop: es.stopPrice, stopPct: es.distPct, stopMode: scfg.stop.mode, histTarget: o.histTarget ?? null,
      tp: scfg.takeProfit?.enabled ? px * (1 + dirOf(side) * scfg.takeProfit.pct / 100) : null };
    if (meta.trendEntries) recordTrendEntry(trendEntries[s], side, o.signalCandle);
  };

  let step = 0;
  for (const t of timeline) {
    // yield to the event loop regularly: live price ticks / emergency stops must never wait for a backtest
    if (++step % 100 === 0) await new Promise((r) => setImmediate(r));
    for (const s of symbols) {
      const i = idx[s].get(t);
      if (i == null) continue;
      const b = bars[s][i];
      // 1) orders decided at the previous close fill at this open
      for (const o of pending[s]) {
        if (o.type === 'EXIT' && pos[s]) { const tr = close(s, b.o, b.t, o.reason || 'STRATEGY_EXIT'); tr.signalTime = o.signalTime; }
        if (o.type === 'ENTRY' && !pos[s]) { open(s, o, b.o, b.t); if (pos[s]) pos[s].signalTime = o.signalTime; }
      }
      pending[s] = [];
      // 2) intrabar emergency stop / take profit
      const p = pos[s];
      if (p) {
        const d = dirOf(p.side);
        const lo = p.side === 'LONG' ? b.l : b.h; // adverse extreme
        const hi = p.side === 'LONG' ? b.h : b.l; // favorable extreme
        if (p.stop != null && (lo - p.stop) * d <= 0) {
          const fill = (b.o - p.stop) * d <= 0 ? b.o : p.stop; // gap through stop -> open
          close(s, fill, b.t, stopReasonOf(p.stopMode));
        } else if (p.tp != null && (hi - p.tp) * d >= 0) {
          close(s, (b.o - p.tp) * d >= 0 ? b.o : p.tp, b.t, 'TAKE_PROFIT');
        }
      }
      // 3) funding settlements inside this bar
      const fr = funding[s] || [];
      while (fIdx[s] < fr.length && fr[fIdx[s]].time < b.t) fIdx[s]++;
      while (fIdx[s] < fr.length && fr[fIdx[s]].time <= b.T) {
        const f = fr[fIdx[s]++];
        if (useFunding && pos[s] && pos[s].time < f.time) {
          const px = b.c; // approximation of the mark price at settlement
          const amt = pos[s].qty * px * f.rate * dirOf(pos[s].side);
          pos[s].fundingAcc += amt;
          stats.funding += amt;
        }
      }
      lastPx[s] = b.c;
      // 4) strategy evaluation on this closed candle (same window length as live)
      const sig = custom ? evalAt[s](i) : evaluateStrategy(strategy, bars[s].slice(Math.max(0, i + 1 - (Number.isFinite(W) ? W : i + 1)), i + 1), scfg);
      if (!sig.ready) { stats.notReady[s] = (stats.notReady[s] || 0) + 1; continue; }
      if (pos[s]) {
        const ex = exitFor(strategy, sig, pos[s]);
        if (!ex.exit) continue;
        pending[s].push({ type: 'EXIT', reason: ex.reason, signalTime: b.T + 1 });
      }
      if (!sig.longCond) block[s].LONG = false;
      if (!sig.shortCond) block[s].SHORT = false;
      let side = null;
      if (sig.longCond) side = 'LONG';
      else if (sig.shortCond && scfg.shortEnabled && meta.supportsShort) side = 'SHORT';
      if (!side) continue;
      if (block[s][side]) { stats.signalsSkipped++; continue; }
      if (meta.trendEntries && trendCounts(sig, trendEntries[s])[side] >= scfg.params.maxEntriesPerTrend) { stats.trendMax++; continue; }
      if (tradeFilter && !tradeFilter(s, b.T + 1)) { stats.universeSkipped++; continue; }
      pending[s].push({ type: 'ENTRY', side, atr: sig.atr, structStop: sig.structStop?.[side] ?? null, histTarget: sig.histTarget?.[side] ?? null, signalCandle: sig.candleTime, signalTime: b.T + 1 });
    }
    // mark to market once per time step
    const eq = equityNow();
    equity.push({ t: t, equity: eq });
  }

  // open positions at the end (not closed; marked to market)
  const openPositions = symbols.filter((s) => pos[s]).map((s) => ({ symbol: s, side: pos[s].side, entryTime: pos[s].time, entryPrice: pos[s].entry, mark: lastPx[s], stopPrice: pos[s].stop, unrealized: unrealized(s, lastPx[s]) - pos[s].fundingAcc - pos[s].entryFee, notional: pos[s].notional }));

  // buy & hold benchmark: capital split equally at the first open, held to the end
  const bh = benchmark(symbols, bars, idx, timeline, capital);
  const metrics = computeMetrics({ equity, trades, capital, timeline, bars, symbols, start, end });
  if (!timeline.length) notes.push('no candles in the test period');
  if (universeNote) notes.push(universeNote);
  if (stats.universeSkipped) notes.push(`${stats.universeSkipped} entry signal(s) skipped: symbol outside the historical trade universe at signal time`);
  if (stats.slotsFull) notes.push(`${stats.slotsFull} entry signal(s) skipped: all ${n} slots in use`);
  if (stats.stopInvalid) notes.push(`${stats.stopInvalid} entry signal(s) cancelled: structure stop not beyond the fill price`);
  if (stats.trendMax) notes.push(`${stats.trendMax} entry signal(s) skipped: max entries per trend reached`);
  for (const [s, c] of Object.entries(stats.notReady)) {
    const total = timeline.filter((t) => idx[s].has(t)).length;
    if (c >= total && total > 0) notes.push(`${s}: indicators never ready in the period (insufficient history for current parameters)`);
    else if (c > 0) notes.push(`${s}: first ${c} candle(s) of the period without a signal (indicator warm-up / limited history)`);
  }
  return {
    strategy, timeframe: tf, symbols, capital, compound, enabled: !!scfg.enabled, params: scfg.params, stop: scfg.stop, takeProfit: scfg.takeProfit, shortEnabled: !!(scfg.shortEnabled && meta.supportsShort),
    metrics, equity, benchmark: bh, trades, openPositions, fees: stats.fees, funding: -stats.funding, notes, slots: n,
    skipped: { universe: stats.universeSkipped, slotsFull: stats.slotsFull, stopInvalid: stats.stopInvalid, trendMax: stats.trendMax, rearm: stats.signalsSkipped },
  };
}

function benchmark(symbols, bars, idx, timeline, capital) {
  if (!timeline.length) return [];
  const each = capital / symbols.length;
  const first = {};
  const last = {};
  const out = [];
  for (const t of timeline) {
    for (const s of symbols) {
      const b = bars[s][idx[s].get(t)];
      if (!b) continue;
      if (first[s] == null) first[s] = b.o;
      last[s] = b.c;
    }
    const v = symbols.reduce((a, s) => a + (first[s] ? each * last[s] / first[s] : each), 0);
    out.push({ t, equity: v });
  }
  return out;
}

export function computeMetrics({ equity, trades, capital, timeline }) {
  const final = equity.length ? equity[equity.length - 1].equity : capital;
  // drawdown duration: from the time of the peak until equity is back at the peak (or the end of the test)
  let peak = capital, peakT = equity.length ? equity[0].t : 0, maxDd = 0, inDd = false, longestDd = 0, cur = 0;
  for (const p of equity) {
    if (p.equity >= peak) { if (inDd) longestDd = Math.max(longestDd, p.t - peakT); peak = p.equity; peakT = p.t; inDd = false; } else inDd = true;
    const dd = (peak - p.equity) / peak * 100;
    if (dd > maxDd) maxDd = dd;
    cur = dd;
  }
  if (inDd && equity.length) longestDd = Math.max(longestDd, equity[equity.length - 1].t - peakT); // drawdown still open at the end
  const wins = trades.filter((t) => t.net > 0), losses = trades.filter((t) => t.net <= 0);
  const gw = wins.reduce((a, t) => a + t.net, 0), gl = -losses.reduce((a, t) => a + t.net, 0);
  const years = timeline.length > 1 ? (timeline[timeline.length - 1] - timeline[0]) / (365 * 86_400_000) : 0;
  const ret = final / capital - 1;
  // daily returns from the equity curve (last point per UTC day) for Sharpe
  const byDay = new Map();
  for (const p of equity) byDay.set(Math.floor(p.t / 86_400_000), p.equity);
  const dv = [capital, ...byDay.values()];
  const dr = [];
  for (let i = 1; i < dv.length; i++) dr.push(dv[i] / dv[i - 1] - 1);
  const m = dr.reduce((a, x) => a + x, 0) / (dr.length || 1);
  const sd = Math.sqrt(dr.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, dr.length - 1));
  const holdMs = trades.reduce((a, t) => a + (t.exitTime - t.entryTime), 0);
  return {
    finalEquity: final, profit: final - capital, returnPct: ret * 100,
    cagrPct: years > 0.05 ? (Math.pow(Math.max(final, 0) / capital, 1 / years) - 1) * 100 : null,
    maxDrawdownPct: maxDd, currentDrawdownPct: cur, longestDrawdownDays: longestDd / 86_400_000,
    trades: trades.length, wins: wins.length, losses: losses.length, winRatePct: trades.length ? wins.length / trades.length * 100 : null,
    profitFactor: gl > 0 ? gw / gl : wins.length ? Infinity : null, avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
    bestTrade: trades.length ? Math.max(...trades.map((t) => t.returnPct)) : null, worstTrade: trades.length ? Math.min(...trades.map((t) => t.returnPct)) : null,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(365) : null, avgHoldDays: trades.length ? holdMs / trades.length / 86_400_000 : null,
    byReason: trades.reduce((a, t) => { a[t.reason] = (a[t.reason] || 0) + 1; return a; }, {}),
  };
}
