// Pure strategy signal functions. Evaluated on CLOSED daily candles only.
// `candles` = closed candles, last element = the candle that just closed ("현재 봉").
// Returns entry/exit flags + view values for the UI.

import { sma, ema, atr, adx, priorHigh, priorLow, logMomentum, macd, lowestLow, highestHigh } from './indicators.js';

export const STRATEGIES = ['TURTLE', 'ADX', 'TSMOM', 'RAYNER', 'TREND_RIDER', 'VOL_BREAKOUT', 'MA_PULLBACK', 'MOM_ROTATION'];

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
  // Breakout with the big trend, Chandelier trailing exit: losses cut by the initial stop, winners ride until the trail breaks.
  TREND_RIDER: { label: 'Trend Rider', short: 'R', supportsShort: true, resetAfterStop: false,
    exitRule: (p) => `${p.trailPeriod}봉 최고가 − ATR×${p.trailMult} 이탈 (샹들리에)` },
  // Short-term (단타): intraday volatility breakout with the trend. Cross of UTC-day open ± k × ATR(levelAtr) above/below
  // EMA(trendPeriod); exit on a short Chandelier trail or after maxHoldBars (TIME_EXIT).
  VOL_BREAKOUT: { label: 'Vol Breakout', short: 'V', supportsShort: true, resetAfterStop: false,
    exitRule: (p) => `${p.trailPeriod}봉 추적 ATR×${p.trailMult} 이탈 또는 ${p.maxHoldBars}봉 보유` },
  // Moving-average pullback (TradingView "이동평균선 눌림목 매매법 9 EMA & 20/200 SMA"): with the SMA200 trend and a rising
  // SMA20, a candle that dips to the SMA20 and closes back above it as a bullish candle. Fixed stop at the signal
  // candle's low and a fixed target at close + rr x (close - low); no strategy exit, no trailing, no add-ons (Pine:
  // strategy.exit stop/limit, one position). Short mirrored.
  MA_PULLBACK: { label: 'MA Pullback 9/20/200', short: 'P', supportsShort: true, resetAfterStop: false, stopModes: ['STRUCTURE'],
    fixedTarget: true, noTrail: true, noAdds: true,
    exitRule: (p) => `손절 신호봉 저가/고가 · 익절 손절폭×${p.rr}` },
  // Cross-sectional momentum rotation: long the topK entry-universe symbols by lookback-candle return, exit when a
  // symbol drops out of the topK. The rank needs every candidate's candles -> applied by strategyRegistry.applyRank
  // (evaluate alone never enters). Pair with the BTC regime filter (regime.exit) for the cash-in-bear-markets rule.
  MOM_ROTATION: { label: 'Momentum Rotation', short: 'O', supportsShort: false, resetAfterStop: true, crossRank: true, noAdds: true, noTrail: true,
    exitRule: (p) => `${p.lookback}봉 수익률 상위 ${p.topK} 이탈` },
};

// Exit reason for an emergency stop of the given stop mode.
export const stopReasonOf = (mode) => (mode === 'FIXED_PERCENT' ? 'FIXED_STOP' : mode === 'STRUCTURE' ? 'STRUCTURE_STOP' : 'ATR_STOP');

// Strategy exit for an open position. Rayner: histogram beyond the target fixed at entry -> RAYNER_HIST_TP.
// max holding time for a side: a number, or { LONG, SHORT } when the sides differ
export const holdMsOf = (sig, side) => (sig?.maxHoldMs && typeof sig.maxHoldMs === 'object' ? sig.maxHoldMs[side] : sig?.maxHoldMs);

export function exitFor(name, sig, pos) {
  // max holding time: counted from the fill (engine: entryTime, backtester: time) to this candle's close
  const t0 = pos?.entryTime ?? pos?.time;
  const hold = holdMsOf(sig, pos?.side);
  if (hold && t0 != null && sig.candleTime + sig.barMs - t0 >= hold) return { exit: true, reason: 'TIME_EXIT' };
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
  if (name === 'VOL_BREAKOUT') return Math.max(p.levelAtr + 1, p.trailPeriod + 1, p.trendPeriod, atrP) + 2;
  if (name === 'TREND_RIDER') return Math.max(p.entryPeriod, p.trailPeriod + 1, p.smaFilter, atrP) + 2;
  if (name === 'MA_PULLBACK') return Math.max(p.smaTrend, p.smaMid + 1, p.emaFast, atrP) + 2;
  if (name === 'MOM_ROTATION') return Math.max(p.lookback + 1, atrP) + 2;
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
      exitLevel: { LONG: exitLow, SHORT: exitHigh },
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
      exitLevel: { LONG: candles[i + 1 - p.lookback]?.c ?? null, SHORT: null }, // next close <= this -> momentum <= 0
      view: { momentum: mom, momentumPct: (Math.exp(mom) - 1) * 100, atr: atrVal },
    };
  }
  if (name === 'MOM_ROTATION') {
    const mom = k.c / candles[i - p.lookback].c - 1;
    return {
      ready: true, candleTime: k.t, close: k.c, atr: atrVal,
      longCond: false, shortCond: false, longExit: false, shortExit: true, // set by applyRank
      view: { momentumPct: mom * 100, atr: atrVal },
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
      exitLevel: { LONG: e0, SHORT: e0 },
      structStop: { LONG: longStop, SHORT: shortStop },
      histTarget: { LONG: longTarget, SHORT: shortTarget },
      trend: { lastBelow, lastAbove },
      view: { ema: e0, emaRef: eS, hist: h0, longTarget, shortTarget, longStop, shortStop, atr: atrVal },
    };
  }
  if (name === 'VOL_BREAKOUT') {
    const DAY = 86_400_000;
    const barMs = k.T - k.t + 1;
    const lvAtr = atr(candles, p.levelAtr);
    const dayOpen = (j) => { const d0 = Math.floor(candles[j].t / DAY) * DAY; let m = j; while (m > 0 && candles[m - 1].t >= d0) m--; return candles[m].o; };
    const a0 = lvAtr[i], a1 = lvAtr[i - 1];
    const trendArr = p.trendPeriod > 0 ? ema(closes, p.trendPeriod) : null;
    const trend = trendArr ? trendArr[i] : null;
    if (a0 == null || a1 == null || (p.trendPeriod > 0 && trend == null)) return { ready: false, reason: 'Vol Breakout warmup' };
    // short side may be stricter: own k, own holding time, and a falling trend EMA (vs shortSlopeBars ago)
    const kS = p.shortK ?? p.k;
    const slopeRef = p.shortSlopeBars > 0 && trendArr ? trendArr[i - p.shortSlopeBars] : null;
    const falling = !(p.shortSlopeBars > 0) || (slopeRef != null && trend < slopeRef);
    // volume confirmation (0 = off): breakout candle volume > volMult × mean volume of the prior volPeriod candles
    let volOk = true, volRatio = null;
    if (p.volMult > 0) {
      const prior = candles.slice(Math.max(0, i - p.volPeriod), i);
      const avg = prior.reduce((a, c) => a + (c.v || 0), 0) / Math.max(1, prior.length);
      volRatio = avg > 0 ? k.v / avg : null;
      volOk = volRatio != null && volRatio > p.volMult;
    }
    const o0 = dayOpen(i), o1 = dayOpen(i - 1), prev = candles[i - 1];
    const up = o0 + p.k * a0, dn = o0 - kS * a0;
    const trAtr = atr(candles, p.trailPeriod)[i];
    const longTrail = highestHigh(candles, i, p.trailPeriod) - p.trailMult * trAtr;
    const shortTrail = lowestLow(candles, i, p.trailPeriod) + p.trailMult * trAtr;
    return {
      ready: true, candleTime: k.t, close: k.c, atr: atrVal, barMs,
      maxHoldMs: { LONG: p.maxHoldBars * barMs, SHORT: (p.shortHoldBars ?? p.maxHoldBars) * barMs },
      // event: the close crosses the level on this candle; only in the direction of the trend EMA
      longCond: prev.c <= o1 + p.k * a1 && k.c > up && (trend == null || k.c > trend) && volOk,
      shortCond: prev.c >= o1 - kS * a1 && k.c < dn && (trend == null || k.c < trend) && falling && volOk,
      longExit: k.c < longTrail,
      shortExit: k.c > shortTrail,
      exitLevel: { LONG: longTrail, SHORT: shortTrail },
      view: { dayOpen: o0, upper: up, lower: dn, trend, longTrail, shortTrail, volRatio, atr: atrVal },
    };
  }
  if (name === 'TREND_RIDER') {
    const entryHigh = priorHigh(candles, i, p.entryPeriod);
    const entryLow = priorLow(candles, i, p.entryPeriod);
    const smaVal = sma(closes, p.smaFilter)[i];
    const trAtr = atr(candles, p.trailPeriod)[i];
    const hh = highestHigh(candles, i, p.trailPeriod), ll = lowestLow(candles, i, p.trailPeriod);
    if (smaVal == null || trAtr == null) return { ready: false, reason: 'Trend Rider warmup' };
    const longTrail = hh - p.trailMult * trAtr, shortTrail = ll + p.trailMult * trAtr;
    return {
      ready: true, candleTime: k.t, close: k.c, atr: atrVal,
      longCond: k.c > entryHigh && k.c > smaVal,
      shortCond: k.c < entryLow && k.c < smaVal,
      longExit: k.c < longTrail,
      shortExit: k.c > shortTrail,
      exitLevel: { LONG: longTrail, SHORT: shortTrail },
      view: { entryHigh, entryLow, sma: smaVal, longTrail, shortTrail, atr: atrVal },
    };
  }
  if (name === 'MA_PULLBACK') {
    const s20 = sma(closes, p.smaMid), s200 = sma(closes, p.smaTrend)[i], e9 = ema(closes, p.emaFast)[i];
    const m0 = s20[i], m1 = s20[i - 1];
    if (m0 == null || m1 == null || s200 == null) return { ready: false, reason: 'MA Pullback warmup' };
    // Pine: is_bull_trend and ta.change(sma20) > 0 and (low <= sma20 and close > sma20) and close > open
    const longCond = k.c > s200 && m0 - m1 > 0 && k.l <= m0 && k.c > m0 && k.c > k.o;
    const shortCond = k.c < s200 && m0 - m1 < 0 && k.h >= m0 && k.c < m0 && k.c < k.o;
    const longTp = k.c + (k.c - k.l) * p.rr, shortTp = k.c - (k.h - k.c) * p.rr;
    return {
      ready: true, candleTime: k.t, close: k.c, atr: atrVal,
      longCond, shortCond,
      longExit: false, shortExit: false, // exits only by the fixed stop / target
      structStop: { LONG: k.l, SHORT: k.h },
      tpTarget: { LONG: longTp, SHORT: shortTp },
      view: { ema9: e9, sma20: m0, sma200: s200, sma20Up: m0 > m1, longStop: k.l, longTp, shortStop: k.h, shortTp, atr: atrVal },
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
