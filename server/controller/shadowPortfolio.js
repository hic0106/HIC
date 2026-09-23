// Shadow (virtual) portfolio. Never sends orders.
// Replays the EXISTING strategy signals (strategies.evaluate) on closed daily candles and the same
// ATR emergency-stop rule, with 1.00x baseline sizing. Each virtual trade also records the controller
// multiplier proposed at entry, so two books come out of one ledger:
//   Baseline   = base order × 1.00 (always)
//   Controller = base order × controller multiplier (0 … 1.25)
// The baseline book is also the controller's performance data source: it is not distorted by
// controller sizing and keeps accumulating while a strategy is PAUSED.
import { STRATEGIES, STRATEGY_META, evaluate, stopDistancePct } from '../strategies.js';

const dirOf = (side) => (side === 'LONG' ? 1 : -1);
export const sideKey = (strategy, side) => `${strategy}:${side}`;

export function emptyShadowState() {
  return { slots: {}, trades: [], series: {}, realized: {}, realizedUsdt: { baseline: 0, controller: 0 }, portfolio: [], lastSnapDay: null, startedAt: Date.now() };
}

export class ShadowPortfolio {
  constructor({ md, getConfig, symbols, proposedMultiplier, state }) {
    this.md = md;
    this.getConfig = getConfig;
    this.symbols = symbols;
    this.proposedMultiplier = proposedMultiplier;
    this.state = state || emptyShadowState();
    this.lastTick = {};
  }

  slot(strategy, symbol) {
    const k = `${strategy}:${symbol}`;
    return (this.state.slots[k] ||= { lastCandle: null, block: { LONG: false, SHORT: false }, pos: null });
  }

  costs() {
    const g = this.getConfig().general;
    return { fee: g.takerFeePct / 100, slip: g.slippagePct / 100 };
  }

  processAll(now = Date.now()) {
    for (const sym of this.symbols) this.onDailyClose(sym, now);
  }

  onDailyClose(symbol, now = Date.now()) {
    for (const st of STRATEGIES) this.processCandle(st, symbol, now);
  }

  processCandle(strategy, symbol, now = Date.now()) {
    const cfg = this.getConfig();
    const scfg = cfg.strategies[strategy];
    if (!scfg.enabled) return; // mirrors the engine: disabled strategies do not act
    const sig = evaluate(strategy, this.md.s[symbol].daily, scfg);
    if (!sig.ready) return;
    const slot = this.slot(strategy, symbol);
    if (slot.lastCandle === sig.candleTime) return;
    slot.lastCandle = sig.candleTime;

    if (slot.pos) {
      const exit = slot.pos.side === 'LONG' ? sig.longExit : sig.shortExit;
      if (!exit) return;
      this.close(strategy, symbol, sig.close, 'STRATEGY_EXIT', now);
    }
    if (!sig.longCond) slot.block.LONG = false;
    if (!sig.shortCond) slot.block.SHORT = false;
    let side = null;
    if (sig.longCond) side = 'LONG';
    else if (sig.shortCond && scfg.shortEnabled && STRATEGY_META[strategy].supportsShort) side = 'SHORT';
    if (side && !slot.block[side]) this.open(strategy, symbol, side, sig.close, sig.atr, now);
  }

  open(strategy, symbol, side, price, atrValue, now) {
    const cfg = this.getConfig();
    const scfg = cfg.strategies[strategy];
    const { fee, slip } = this.costs();
    const entry = price * (1 + dirOf(side) * slip);
    const distPct = stopDistancePct(scfg.stop, atrValue, entry);
    const amounts = scfg.amounts[cfg.general.mode] || scfg.amounts.PAPER;
    const baseAmount = Number(side === 'LONG' ? amounts.long : amounts.short) || 0;
    let mult = 1;
    try { mult = this.proposedMultiplier(strategy, side); } catch { mult = 1; }
    this.slot(strategy, symbol).pos = {
      side, entryPrice: entry, entryTime: now,
      stopPrice: distPct == null ? null : entry * (1 - dirOf(side) * distPct / 100),
      stopMode: scfg.stop.mode,
      tpPrice: scfg.takeProfit.enabled ? entry * (1 + dirOf(side) * scfg.takeProfit.pct / 100) : null,
      baseAmount, mult, fee, funding: 0,
    };
  }

  unrealized(pos, price) {
    return (price / pos.entryPrice - 1) * dirOf(pos.side) - pos.fee - pos.funding;
  }

  close(strategy, symbol, price, reason, now) {
    const slot = this.slot(strategy, symbol);
    const pos = slot.pos;
    if (!pos) return null;
    const { fee, slip } = this.costs();
    const exit = price * (1 - dirOf(pos.side) * slip);
    const ret = (exit / pos.entryPrice - 1) * dirOf(pos.side) - pos.fee - fee * (exit / pos.entryPrice) - pos.funding;
    const t = {
      strategy, symbol, side: pos.side, entryTime: pos.entryTime, exitTime: now, entryPrice: pos.entryPrice, exitPrice: exit,
      ret, baseAmount: pos.baseAmount, mult: pos.mult, pnlBaseline: pos.baseAmount * ret, pnlController: pos.baseAmount * pos.mult * ret, reason,
    };
    const k = sideKey(strategy, pos.side);
    this.state.realized[k] = (this.state.realized[k] || 0) + ret;
    this.state.realizedUsdt.baseline += t.pnlBaseline;
    this.state.realizedUsdt.controller += t.pnlController;
    this.state.trades.push(t);
    if (this.state.trades.length > 3000) this.state.trades.splice(0, this.state.trades.length - 3000);
    slot.pos = null;
    if (reason !== 'STRATEGY_EXIT' && STRATEGY_META[strategy].resetAfterStop) slot.block[pos.side] = true;
    return t;
  }

  onPrice(symbol, price, now = Date.now()) {
    if (now - (this.lastTick[symbol] || 0) < 1000) return;
    this.lastTick[symbol] = now;
    for (const st of STRATEGIES) {
      const pos = this.state.slots[`${st}:${symbol}`]?.pos;
      if (!pos) continue;
      const d = dirOf(pos.side);
      if (pos.stopPrice != null && (price - pos.stopPrice) * d <= 0) this.close(st, symbol, price, pos.stopMode === 'FIXED_PERCENT' ? 'FIXED_STOP' : 'ATR_STOP', now);
      else if (pos.tpPrice != null && (price - pos.tpPrice) * d >= 0) this.close(st, symbol, price, 'TAKE_PROFIT', now);
    }
  }

  onFunding({ symbol, time, rate }) {
    if (!this.getConfig().general.includeFunding) return;
    for (const st of STRATEGIES) {
      const pos = this.state.slots[`${st}:${symbol}`]?.pos;
      if (pos && pos.entryTime < time) pos.funding += rate * dirOf(pos.side);
    }
  }

  // Daily mark-to-market record (one point per UTC day).
  snapshot(day, priceOf) {
    const cum = {}, open = {};
    for (const st of STRATEGIES) for (const side of ['LONG', 'SHORT']) { const k = sideKey(st, side); cum[k] = this.state.realized[k] || 0; open[k] = 0; }
    let ub = 0, uc = 0;
    for (const [k, s] of Object.entries(this.state.slots)) {
      if (!s.pos) continue;
      const [st, sym] = k.split(':');
      const px = priceOf(sym);
      if (!(px > 0)) continue;
      const u = this.unrealized(s.pos, px);
      const sk = sideKey(st, s.pos.side);
      cum[sk] += u; open[sk]++;
      ub += u * s.pos.baseAmount;
      uc += u * s.pos.baseAmount * s.pos.mult;
    }
    for (const k of Object.keys(cum)) {
      const arr = (this.state.series[k] ||= []);
      const pt = { day, cum: cum[k], open: open[k] };
      if (arr.length && arr[arr.length - 1].day === day) arr[arr.length - 1] = pt; else arr.push(pt);
      if (arr.length > 800) arr.shift();
    }
    const pf = { day, baseline: this.state.realizedUsdt.baseline + ub, controller: this.state.realizedUsdt.controller + uc };
    const p = this.state.portfolio;
    if (p.length && p[p.length - 1].day === day) p[p.length - 1] = pf; else p.push(pf);
    if (p.length > 800) p.shift();
    this.state.lastSnapDay = day;
  }

  summary(priceOf) {
    let ub = 0, uc = 0, openCount = 0;
    for (const [k, s] of Object.entries(this.state.slots)) {
      if (!s.pos) continue;
      const px = priceOf(k.split(':')[1]);
      if (!(px > 0)) continue;
      const u = this.unrealized(s.pos, px);
      ub += u * s.pos.baseAmount; uc += u * s.pos.baseAmount * s.pos.mult; openCount++;
    }
    return {
      baselinePnl: this.state.realizedUsdt.baseline + ub,
      controllerPnl: this.state.realizedUsdt.controller + uc,
      openPositions: openCount, trades: this.state.trades.length, startedAt: this.state.startedAt,
      days: this.state.portfolio.length,
    };
  }
}
