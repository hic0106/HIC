// Validation of strategy settings (used by the settings API and by AI suggestions before they are applied).
import { META as STRATEGY_META, STRATEGY_CLASS } from './strategyRegistry.js';
import { CRYPTO_TIMEFRAME_CHOICES } from './scheduler/timeframes.js';

export const num = (v, { min = -Infinity, max = Infinity, int = false } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new Error(`invalid number: ${v}`);
  return n;
};

// b = submitted settings, cur = current stored settings. Returns the validated next settings (throws on error).
export function validateStrategySettings(name, b, cur) {
  const amt = (x) => num(x, { min: 0, max: 1e7 });
  const next = {
    enabled: !!b.enabled,
    ...(STRATEGY_CLASS[name] === 'CRYPTO' ? { timeframe: CRYPTO_TIMEFRAME_CHOICES.includes(b.timeframe) ? b.timeframe : (cur.timeframe || '1d') } : {}),
    shortEnabled: STRATEGY_META[name].supportsShort ? !!b.shortEnabled : false,
    leverage: num(b.leverage ?? cur.leverage ?? 1, { min: 1, max: STRATEGY_CLASS[name] === 'CRYPTO' ? 20 : 10, int: true }),
    amounts: {
      PAPER: { long: amt(b.amounts.PAPER.long), short: amt(b.amounts.PAPER.short ?? 0) },
      LIVE: { long: amt(b.amounts.LIVE.long), short: amt(b.amounts.LIVE.short ?? 0) },
    },
    params: {},
    stop: {
      mode: ['ATR_DYNAMIC', 'FIXED_PERCENT', 'OFF'].includes(b.stop.mode) ? b.stop.mode : (() => { throw new Error('bad stop mode'); })(),
      atrPeriod: num(b.stop.atrPeriod, { min: 2, max: 200, int: true }),
      atrMult: num(b.stop.atrMult, { min: 0.1, max: 20 }),
      minPct: num(b.stop.minPct, { min: 0.1, max: 90 }),
      maxPct: num(b.stop.maxPct, { min: 0.1, max: 90 }),
      fixedPct: num(b.stop.fixedPct, { min: 0.1, max: 90 }),
    },
    takeProfit: { enabled: !!b.takeProfit.enabled, pct: num(b.takeProfit.pct, { min: 0.1, max: 1000 }) },
  };
  if (next.stop.minPct > next.stop.maxPct) throw new Error('Min Stop % must be <= Max Stop %');
  const P = { min: 2, max: 400, int: true };
  if (name === 'TURTLE') next.params = { entryPeriod: num(b.params.entryPeriod, P), exitPeriod: num(b.params.exitPeriod, P), smaFilter: num(b.params.smaFilter, P) };
  if (name === 'ADX') next.params = { adxPeriod: num(b.params.adxPeriod, P), threshold: num(b.params.threshold, { min: 1, max: 100 }), smaFilter: num(b.params.smaFilter, P) };
  if (name === 'TSMOM') next.params = { lookback: num(b.params.lookback, P) };
  if (name === 'QQQ_EMA_TREND') {
    next.params = { fastEma: num(b.params.fastEma, P), slowEma: num(b.params.slowEma, P), sma200Filter: !!b.params.sma200Filter };
    if (next.params.fastEma >= next.params.slowEma) throw new Error('Fast EMA must be < Slow EMA');
  }
  if (name === 'QQQ_TSMOM') next.params = { lookback: num(b.params.lookback, { min: 20, max: 400, int: true }), sma200Filter: !!b.params.sma200Filter };
  if (name === 'QQQ_SMA200') next.params = { smaPeriod: num(b.params.smaPeriod, P) };
  if (name === 'QQQ_TURTLE_50_20') next.params = { entryPeriod: num(b.params.entryPeriod, P), exitPeriod: num(b.params.exitPeriod, P) };
  if (!STRATEGY_META[name].supportsShort) { next.amounts.PAPER.short = 0; next.amounts.LIVE.short = 0; }
  return next;
}
