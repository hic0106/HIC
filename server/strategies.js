// Pure strategy signal functions. Evaluated on CLOSED daily candles only.
// `candles` = closed candles, last element = the candle that just closed ("현재 봉").
// Returns entry/exit flags + view values for the UI.

import { sma, atr, adx, priorHigh, priorLow, logMomentum } from './indicators.js';

export const STRATEGIES = ['TURTLE', 'ADX', 'TSMOM'];

export const STRATEGY_META = {
  TURTLE: { label: 'Turtle 20/10', short: 'T', supportsShort: true, exitRule: (p) => `${p.exitPeriod}D Channel`,
    // Breakout is an event: re-entry after a stop only needs a new breakout close.
    resetAfterStop: false },
  ADX: { label: 'ADX Trend', short: 'A', supportsShort: true, exitRule: (p) => `ADX<=${p.threshold} / DI Cross`,
    // State condition: after a stop, condition must turn false once before re-entering.
    resetAfterStop: true },
  TSMOM: { label: 'TSMOM 30D', short: 'M', supportsShort: false, exitRule: (p) => `${p.lookback}D Mom <= 0`,
    resetAfterStop: true },
};

export function minCandles(name, cfg) {
  const p = cfg.params;
  const atrP = cfg.stop.atrPeriod;
  if (name === 'TURTLE') return Math.max(p.entryPeriod, p.exitPeriod, p.smaFilter, atrP) + 2;
  if (name === 'ADX') return Math.max(p.adxPeriod * 2 + 2, p.smaFilter, atrP) + 2;
  if (name === 'TSMOM') return Math.max(p.lookback, atrP) + 2;
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
  throw new Error(`unknown strategy ${name}`);
}

// Emergency stop distance as a fraction of entry price.
export function stopDistancePct(stopCfg, atrValue, price) {
  if (!stopCfg || stopCfg.mode === 'OFF') return null;
  if (stopCfg.mode === 'FIXED_PERCENT') return stopCfg.fixedPct;
  if (atrValue == null || !(price > 0)) return stopCfg.maxPct; // fallback: widest allowed
  const raw = ((atrValue * stopCfg.atrMult) / price) * 100;
  return Math.min(stopCfg.maxPct, Math.max(stopCfg.minPct, raw));
}
