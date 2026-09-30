// Strategy registry: maps asset classes to strategy groups.
//   CRYPTO        (dynamic universe, server/universe.js) : TURTLE, ADX, TSMOM, RAYNER — from strategies.js
//   TRADFI_INDEX  (QQQ)         : QQQ_EMA_TREND, QQQ_TSMOM, QQQ_SMA200, QQQ_TURTLE_50_20
import { STRATEGIES as CRYPTO_STRATEGIES, STRATEGY_META as CRYPTO_META, evaluate as evaluateCrypto, stopDistancePct, holdMsOf, exitFor, entryStop, stopReasonOf, trendCounts, recordTrendEntry } from './strategies.js';
import { TRADFI_STRATEGIES, TRADFI_META, evaluateTradfi } from './strategiesTradfi.js';
import { assetClassOf, symbolsOfClass } from './assets.js';

export { stopDistancePct, exitFor, entryStop, stopReasonOf, trendCounts, recordTrendEntry, CRYPTO_STRATEGIES, TRADFI_STRATEGIES };

export const ALL_STRATEGIES = [...CRYPTO_STRATEGIES, ...TRADFI_STRATEGIES];
export const STRATEGY_CLASS = Object.fromEntries([
  ...CRYPTO_STRATEGIES.map((s) => [s, 'CRYPTO']),
  ...TRADFI_STRATEGIES.map((s) => [s, 'TRADFI_INDEX']),
]);
export const META = { ...CRYPTO_META, ...TRADFI_META };

// BTC regime filter (strategies.<name>.regime = { sma, exit }): while BTC's last daily close (closed at or before
// closeT) is below its SMA(sma), no new longs; exit=true also closes open longs. Shorts untouched. No BTC data or
// too few candles -> no filter. 2000-day backtest (2021-04..2026-09): ADX / TURTLE entry-only improved return and MDD.
export function applyRegime(sig, scfg, btcDaily, closeT) {
  const n = scfg?.regime?.sma;
  if (!n || !sig.ready || !btcDaily?.length) return sig;
  let k = btcDaily.length - 1;
  while (k >= 0 && btcDaily[k].T > closeT) k--;
  if (k + 1 < n) return sig;
  let sum = 0;
  for (let i = k - n + 1; i <= k; i++) sum += btcDaily[i].c;
  if (btcDaily[k].c >= sum / n) return sig;
  return { ...sig, longCond: false, longExit: scfg.regime.exit ? true : sig.longExit, regimeBlockLong: true };
}

// Cross-sectional momentum (META.crossRank): long while `symbol` is among the params.topK candidates by
// params.lookback-candle return, all measured on the candle closing at closeT (candidates without that candle are left
// out, so a symbol outside the candidates ranks null -> exit). Apply after applyRegime (a blocked long stays blocked).
// ponytail: live, a candidate whose closing candle has not arrived yet is left out -> others rank higher (at worst an
// extra entry, never a false exit); a wait-for-all-closes gate if that shows up in the Signal Log.
export function momentumAt(bars, closeT, lb) {
  let lo = 0, hi = (bars?.length ?? 0) - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].T < closeT) lo = m + 1;
    else if (bars[m].T > closeT) hi = m - 1;
    else return m >= lb && bars[m - lb].c > 0 ? bars[m].c / bars[m - lb].c - 1 : null;
  }
  return null;
}

export function applyRank(sig, name, scfg, symbol, candidates, barsOf, closeT) {
  if (!META[name]?.crossRank || !sig.ready) return sig;
  const ranked = candidates.map((s) => [s, momentumAt(barsOf(s), closeT, scfg.params.lookback)]).filter(([, m]) => m != null).sort((a, b) => b[1] - a[1]);
  const rank = ranked.findIndex(([s]) => s === symbol) + 1 || null;
  const top = rank != null && rank <= scfg.params.topK;
  return { ...sig, longCond: top && !sig.regimeBlockLong, longExit: sig.longExit || !top, view: { ...sig.view, rank, candidates: ranked.length } };
}

export const strategiesForSymbol =(sym) => (assetClassOf(sym) === 'CRYPTO' ? CRYPTO_STRATEGIES : TRADFI_STRATEGIES);
export const symbolsForStrategy = (st) => symbolsOfClass(STRATEGY_CLASS[st]);

export function evaluateStrategy(name, candles, cfg) {
  return STRATEGY_CLASS[name] === 'CRYPTO' ? evaluateCrypto(name, candles, cfg) : evaluateTradfi(name, candles, cfg);
}

// Side the strategy would hold now had it been running: replays its entry/exit flags over the last `lookback`
// closed candles (emergency stops ignored). null for per-trend entry strategies (Rayner: fixed targets / entry limits).
// ponytail: re-evaluates every prefix (O(lookback × candles)); runs only on bot start.
export function impliedSide(name, candles, cfg, lookback = 250) {
  if (META[name]?.trendEntries) return null;
  const allowShort = !!(cfg.shortEnabled && META[name]?.supportsShort);
  let side = null, since = null;
  for (let i = Math.max(1, candles.length - lookback); i <= candles.length; i++) {
    const s = evaluateStrategy(name, candles.slice(0, i), cfg);
    if (!s.ready) continue;
    if ((side === 'LONG' && s.longExit) || (side === 'SHORT' && s.shortExit)) side = null;
    if (side && holdMsOf(s, side) && s.candleTime - since >= holdMsOf(s, side)) side = null; // held past the max holding time
    if (!side) {
      side = s.longCond ? 'LONG' : s.shortCond && allowShort ? 'SHORT' : null;
      since = side ? s.candleTime : null;
    }
  }
  return side ? { side, since } : null;
}
