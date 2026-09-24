// Strategy registry: maps asset classes to strategy groups.
//   CRYPTO        (dynamic universe, server/universe.js) : TURTLE, ADX, TSMOM, RAYNER — from strategies.js
//   TRADFI_INDEX  (QQQ)         : QQQ_EMA_TREND, QQQ_TSMOM, QQQ_SMA200, QQQ_TURTLE_50_20
import { STRATEGIES as CRYPTO_STRATEGIES, STRATEGY_META as CRYPTO_META, evaluate as evaluateCrypto, stopDistancePct, exitFor, entryStop, stopReasonOf, trendCounts, recordTrendEntry } from './strategies.js';
import { TRADFI_STRATEGIES, TRADFI_META, evaluateTradfi } from './strategiesTradfi.js';
import { assetClassOf, symbolsOfClass } from './assets.js';

export { stopDistancePct, exitFor, entryStop, stopReasonOf, trendCounts, recordTrendEntry, CRYPTO_STRATEGIES, TRADFI_STRATEGIES };

export const ALL_STRATEGIES = [...CRYPTO_STRATEGIES, ...TRADFI_STRATEGIES];
export const STRATEGY_CLASS = Object.fromEntries([
  ...CRYPTO_STRATEGIES.map((s) => [s, 'CRYPTO']),
  ...TRADFI_STRATEGIES.map((s) => [s, 'TRADFI_INDEX']),
]);
export const META = { ...CRYPTO_META, ...TRADFI_META };

export const strategiesForSymbol = (sym) => (assetClassOf(sym) === 'CRYPTO' ? CRYPTO_STRATEGIES : TRADFI_STRATEGIES);
export const symbolsForStrategy = (st) => symbolsOfClass(STRATEGY_CLASS[st]);

export function evaluateStrategy(name, candles, cfg) {
  return STRATEGY_CLASS[name] === 'CRYPTO' ? evaluateCrypto(name, candles, cfg) : evaluateTradfi(name, candles, cfg);
}
