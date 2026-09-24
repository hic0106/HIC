// TradFi (QQQ) strategy group. LONG / CASH only — these strategies never produce short signals.
// Evaluated on US regular-session daily candles (see session.js), not on UTC daily candles.
// Separate instances from the crypto strategies: no shared config or code paths.
import { sma, atr, ema, priorHigh, priorLow, logMomentum } from './indicators.js';

export const TRADFI_STRATEGIES = ['QQQ_EMA_TREND', 'QQQ_TSMOM', 'QQQ_SMA200', 'QQQ_TURTLE_50_20'];

const longOnly = { supportsShort: false, resetAfterStop: true };
export const TRADFI_META = {
  QQQ_EMA_TREND: { label: 'QQQ EMA Trend', short: 'E', ...longOnly, exitRule: (p) => `EMA${p.fastEma}가 EMA${p.slowEma} 아래로` },
  QQQ_TSMOM: { label: 'QQQ TSMOM', short: 'R', ...longOnly, exitRule: (p) => `${p.lookback}세션 모멘텀 0 이하` },
  QQQ_SMA200: { label: 'QQQ SMA200 Regime', short: 'S', ...longOnly, exitRule: (p) => `종가가 SMA${p.smaPeriod} 이하` },
  // breakout event (like crypto Turtle): no re-arm needed after a stop
  QQQ_TURTLE_50_20: { label: 'QQQ Slow Turtle 50/20', short: 'W', supportsShort: false, resetAfterStop: false, exitRule: (p) => `${p.exitPeriod}세션 최저가 이탈` },
};

export function tradfiMinCandles(name, cfg) {
  const p = cfg.params;
  const f = p.sma200Filter ? 200 : 0;
  const a = cfg.stop.atrPeriod;
  if (name === 'QQQ_EMA_TREND') return Math.max(p.slowEma, f, a) + 2;
  if (name === 'QQQ_TSMOM') return Math.max(p.lookback, f, a) + 2;
  if (name === 'QQQ_SMA200') return Math.max(p.smaPeriod, a) + 2;
  if (name === 'QQQ_TURTLE_50_20') return Math.max(p.entryPeriod, p.exitPeriod, a) + 2;
  return 0;
}

export function evaluateTradfi(name, candles, cfg) {
  const need = tradfiMinCandles(name, cfg);
  const i = candles.length - 1;
  if (i < 0 || candles.length < need) return { ready: false, reason: `insufficient session history (${candles.length}/${need} US sessions)` };
  const k = candles[i];
  const closes = candles.map((x) => x.c);
  const atrVal = atr(candles, cfg.stop.atrPeriod)[i];
  const p = cfg.params;
  const sma200 = candles.length >= 200 ? sma(closes, 200)[i] : null;
  // optional SMA200 regime filter on entries (exits unchanged)
  const filterOk = !p.sma200Filter || (sma200 != null && k.c > sma200);
  const base = { ready: true, candleTime: k.t, close: k.c, atr: atrVal, shortCond: false, shortExit: true };

  if (name === 'QQQ_EMA_TREND') {
    const f = ema(closes, p.fastEma)[i], s = ema(closes, p.slowEma)[i];
    return { ...base, longCond: f > s && filterOk, longExit: f <= s, view: { fastEma: f, slowEma: s, sma200, atr: atrVal, filter: p.sma200Filter } };
  }
  if (name === 'QQQ_TSMOM') {
    const mom = logMomentum(candles, i, p.lookback);
    return { ...base, longCond: mom > 0 && filterOk, longExit: mom <= 0, view: { momentum: mom, momentumPct: (Math.exp(mom) - 1) * 100, sma200, atr: atrVal, filter: p.sma200Filter } };
  }
  if (name === 'QQQ_SMA200') {
    const s = sma(closes, p.smaPeriod)[i];
    return { ...base, longCond: k.c > s, longExit: k.c <= s, view: { sma: s, above: k.c > s, atr: atrVal } };
  }
  if (name === 'QQQ_TURTLE_50_20') {
    const hi = priorHigh(candles, i, p.entryPeriod), lo = priorLow(candles, i, p.exitPeriod);
    return { ...base, longCond: k.c > hi, longExit: k.c < lo, view: { entryHigh: hi, exitLow: lo, sma200, atr: atrVal } };
  }
  throw new Error(`unknown tradfi strategy ${name}`);
}
