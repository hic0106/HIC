// Pure strategy signal functions. Evaluated on CLOSED daily candles only.
// `candles` = closed candles, last element = the candle that just closed ("현재 봉").
// Returns entry/exit flags + view values for the UI.

import { sma, ema, atr, adx, priorHigh, priorLow, logMomentum, macd, lowestLow, highestHigh } from './indicators.js';

export const STRATEGIES = ['TURTLE', 'ADX', 'TSMOM', 'RAYNER'];

export const STRATEGY_META = {
  TURTLE: { label: 'Turtle 20/10', short: 'T', supportsShort: true, exitRule: (p) => `${p.exitPeriod}봉 채널 이탈`,
    // Breakout is an event: re-entry after a stop only needs a new breakout close.
    resetAfterStop: false },
  ADX: { label: 'ADX Trend', short: 'A', supportsShort: true, exitRule: (p) => `ADX ${p.threshold} 이하 또는 DI 교차`,
    // State condition: after a stop, condition must turn false once before re-entering.
    resetAfterStop: true },
  TSMOM: { label: 'TSMOM 30D', short: 'M', supportsShort: false, exitRule: (p) => `${p.lookback}일 모멘텀 0 이하`,
    resetAfterStop: true },
  // Momentum burst is an event (histogram acceleration); re-entries are limited per trend instead (maxEntriesPerTrend).
  RAYNER: { label: 'Rayner EMA50 + MACD', short: 'N', supportsShort: true, resetAfterStop: false, trendEntries: true, stopModes: ['STRUCTURE'],
    exitRule: (p) => `종가 EMA${p.emaPeriod} 반대편 · 히스토그램 0 반대 · 히스토그램 목표 도달` },
};

// Exit reason for an emergency stop of the given stop mode.
export const stopReasonOf = (mode) => (mode === 'FIXED_PERCENT' ? 'FIXED_STOP' : mode === 'STRUCTURE' ? 'STRUCTURE_STOP' : 'ATR_STOP');

// Strategy exit for an open position. Rayner: histogram beyond the target fixed at entry -> RAYNER_HIST_TP.
export function exitFor(name, sig, pos) {
  if (name === 'RAYNER' && pos?.histTarget != null && sig.hist != null) {
    if (pos.side === 'LONG' && sig.hist > pos.histTarget) return { exit: true, reason: 'RAYNER_HIST_TP' };
    if (pos.side === 'SHORT' && sig.hist < pos.histTarget) return { exit: true, reason: 'RAYNER_HIST_TP' };
  }
  return { exit: !!(pos?.side === 'LONG' ? sig.longExit : sig.shortExit), reason: 'STRATEGY_EXIT' };
}

// Emergency stop at entry. STRUCTURE: stop from the signal candle (sig.structStop), invalid if on the wrong side of
// the actual entry price (-> entry cancelled). Other modes: ATR / fixed % distance (stopDistancePct).
export function entryStop(stopCfg, sig, side, entryPrice) {
  if (stopCfg?.mode === 'STRUCTURE') {
    const sp = sig?.structStop?.[side];
    if (!(sp > 0) || !(entryPrice > 0)) return { stopPrice: null, distPct: null, invalid: true };
    const d = side === 'LONG' ? entryPrice - sp : sp - entryPrice;
    if (!(d > 0)) return { stopPrice: sp, distPct: null, invalid: true };
    return { stopPrice: sp, distPct: (d / entryPrice) * 100, invalid: false };
  }
  const distPct = stopDistancePct(stopCfg, sig?.atr, entryPrice);
  return { stopPrice: distPct == null ? null : entryPrice * (1 - (side === 'LONG' ? 1 : -1) * distPct / 100), distPct, invalid: false };
}

// Entries in the current trend: entries (signal candle open times) after the last close on the other side of the EMA.
// LONG count resets when a candle closes below the EMA, SHORT count when a candle closes above it.
export function trendCounts(sig, entries = {}) {
  const cnt = (list, lastOpp) => (list || []).filter((t) => lastOpp == null || t > lastOpp).length;
  return { LONG: cnt(entries.LONG, sig?.trend?.lastBelow), SHORT: cnt(entries.SHORT, sig?.trend?.lastAbove) };
}

// Records an entry (signal candle time) in a per-slot { LONG: [], SHORT: [] } list (bounded).
export function recordTrendEntry(entries, side, candleTime) {
  const e = entries || { LONG: [], SHORT: [] };
  const list = (e[side] ||= []);
  if (candleTime != null && !list.includes(candleTime)) list.push(candleTime);
  if (list.length > 20) list.splice(0, list.length - 20);
  return e;
}

export function minCandles(name, cfg) {
  const p = cfg.params;
  const atrP = cfg.stop.atrPeriod;
  if (name === 'TURTLE') return Math.max(p.entryPeriod, p.exitPeriod, p.smaFilter, atrP) + 2;
  if (name === 'ADX') return Math.max(p.adxPeriod * 2 + 2, p.smaFilter, atrP) + 2;
  if (name === 'TSMOM') return Math.max(p.lookback, atrP) + 2;
  if (name === 'RAYNER') return Math.max(p.emaPeriod + p.slopeLookback, p.slowPeriod + p.signalPeriod + Math.max(p.momentumLookback, p.targetLookback), p.stopLookback, atrP) + 2;
  return 0;
}

export function evaluate(name, candles, cfg) {
  const i = candles.length - 1;
  if (i < 0 || candles.length < minCandles(name, cfg)) {
    return { ready: false, reason: `insufficient data (${candles.length}/${minCandles(name, cfg)})` };
  }
  const k = candles[i];
  const closes = candles.map((x) => x.c);
  const atrArr = atr(candles, cfg.stop.atrPeriod);
  const atrVal = atrArr[i];
  const p = cfg.params;

  if (name === 'TURTLE') {
    const entryHigh = priorHigh(candles, i, p.entryPeriod);
    const entryLow = priorLow(candles, i, p.entryPeriod);
    const exitLow = priorLow(candles, i, p.exitPeriod);
    const exitHigh = priorHigh(candles, i, p.exitPeriod);
    const smaVal = sma(closes, p.smaFilter)[i];
    const longCond = k.c > entryHigh;
    const shortCond = k.c < entryLow && smaVal != null && k.c < smaVal;
    return {
      ready: true, candleTime: k.t, close: k.c, atr: atrVal,
      longCond, shortCond,
      longExit: k.c < exitLow,
      shortExit: k.c > exitHigh,
      view: { entryHigh, entryLow, exitLow, exitHigh, sma: smaVal, atr: atrVal },
    };
  }

  if (name === 'ADX') {
    const r = adx(candles, p.adxPeriod);
    const a = r.adx[i], pdi = r.plusDI[i], mdi = r.minusDI[i];
    const smaVal = sma(closes, p.smaFilter)[i];
    if (a == null || pdi == null || mdi == null) return { ready: false, reason: 'ADX warmup' };
    return {
      ready: true, candleTime: k.t, close: k.c, atr: atrVal,
      longCond: a > p.threshold && pdi > mdi,
      shortCond: a > p.threshold && mdi > pdi && smaVal != null && k.c < smaVal,
      longExit: a <= p.threshold || mdi >= pdi,
      shortExit: a <= p.threshold || pdi >= mdi,
      view: { adx: a, plusDI: pdi, minusDI: mdi, sma: smaVal, atr: atrVal },
    };
  }

  if (name === 'TSMOM') {
    const mom = logMomentum(candles, i, p.lookback);
    return {
      ready: true, candleTime: k.t, close: k.c, atr: atrVal,
      longCond: mom > 0,
      shortCond: false,
      longExit: mom <= 0,
      shortExit: true,
      view: { momentum: mom, momentumPct: (Math.exp(mom) - 1) * 100, atr: atrVal },
    };
  }
  if (name === 'RAYNER') {
    const e = ema(closes, p.emaPeriod);
    const H = macd(closes, p.fastPeriod, p.slowPeriod, p.signalPeriod).hist;
    const e0 = e[i], eS = e[i - p.slopeLookback], h0 = H[i];
    const prev = H.slice(i - p.momentumLookback, i);
    const tw = H.slice(i - p.targetLookback + 1, i + 1);
    if (e0 == null || eS == null || h0 == null || prev.length < p.momentumLookback || prev.some((x) => x == null) || tw.length < p.targetLookback || tw.some((x) => x == null)) {
      return { ready: false, reason: 'Rayner warmup' };
    }
    const maxPrev = Math.max(...prev), minPrev = Math.min(...prev);
    const mult = p.momentumMultiplier;
    const longStop = lowestLow(candles, i, p.stopLookback), shortStop = highestHigh(candles, i, p.stopLookback);
    const longTarget = Math.max(...tw), shortTarget = Math.min(...tw);
    // last candle (open time) that closed on the other side of the EMA -> resets the per-trend entry count
    let lastBelow = null, lastAbove = null;
    for (let j = i; j >= 0 && (lastBelow == null || lastAbove == null); j--) {
      if (e[j] == null) break;
      if (lastBelow == null && candles[j].c < e[j]) lastBelow = candles[j].t;
      if (lastAbove == null && candles[j].c > e[j]) lastAbove = candles[j].t;
    }
    return {
      ready: true, candleTime: k.t, close: k.c, atr: atrVal, hist: h0,
      // Long: close above a rising EMA, positive histogram accelerating past max(prior N) × mult. Short mirrored.
      longCond: k.c > e0 && e0 > eS && h0 > 0 && h0 > maxPrev * mult,
      shortCond: k.c < e0 && e0 < eS && h0 < 0 && h0 < minPrev * mult,
      longExit: k.c < e0 || h0 < 0,
      shortExit: k.c > e0 || h0 > 0,
      structStop: { LONG: longStop, SHORT: shortStop },
      histTarget: { LONG: longTarget, SHORT: shortTarget },
      trend: { lastBelow, lastAbove },
      view: { ema: e0, emaRef: eS, hist: h0, longTarget, shortTarget, longStop, shortStop, atr: atrVal },
    };
  }
  throw new Error(`unknown strategy ${name}`);
}

// Emergency stop distance as a fraction of entry price.
export function stopDistancePct(stopCfg, atrValue, price) {
  if (!stopCfg || stopCfg.mode === 'OFF' || stopCfg.mode === 'STRUCTURE') return null; // STRUCTURE: see entryStop()
  if (stopCfg.mode === 'FIXED_PERCENT') return stopCfg.fixedPct;
  if (atrValue == null || !(price > 0)) return stopCfg.maxPct; // fallback: widest allowed
  const raw = ((atrValue * stopCfg.atrMult) / price) * 100;
  return Math.min(stopCfg.maxPct, Math.max(stopCfg.minPct, raw));
}
