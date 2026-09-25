// Signal timeframe per strategy. Strategy rules are unchanged; only the candle series they read differs.
//   '5m' / '4h' / '1d' : Binance UTC-aligned kline closes (crypto)
//   'US_SESSION'  : NYSE regular-session candles (QQQ), closes follow America/New_York incl. DST / holidays
import { STRATEGY_CLASS } from '../strategyRegistry.js';
import { isSessionSymbol } from '../assets.js';

export const US_SESSION = 'US_SESSION';
// Every Binance USDⓈ-M kline interval. '1M' length varies (28-31 days): TF_MS is nominal (30 d), never used for paging.
export const KLINE_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
export const CRYPTO_TIMEFRAME_CHOICES = KLINE_TIMEFRAMES;
const M = 60_000, H = 3_600_000, D = 86_400_000;
export const TF_MS = { '1m': M, '3m': 3 * M, '5m': 5 * M, '15m': 15 * M, '30m': 30 * M, '1h': H, '2h': 2 * H, '4h': 4 * H, '6h': 6 * H, '8h': 8 * H, '12h': 12 * H, '1d': D, '3d': 3 * D, '1w': 7 * D, '1M': 30 * D };
export const TF_LABEL = { '1m': '1M', '3m': '3M', '5m': '5M', '15m': '15M', '30m': '30M', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '8h': '8H', '12h': '12H', '1d': '1D', '3d': '3D', '1w': '1W', '1M': '1MO', [US_SESSION]: 'US SESSION' };
// Default grace for NEW entries after a candle close (minutes): half the candle, 1 … 120 (config entryGraceMin overrides)
export const defaultGraceMin = (tf) => Math.max(1, Math.min(120, Math.round((TF_MS[tf] || H) / M / 2)));

export const DEFAULT_TIMEFRAME = {
  TURTLE: '4h', ADX: '4h', TSMOM: '1d', RAYNER: '4h',
  QQQ_EMA_TREND: US_SESSION, QQQ_TSMOM: US_SESSION, QQQ_SMA200: US_SESSION, QQQ_TURTLE_50_20: US_SESSION,
};

export function timeframeOf(strategy, config) {
  if (STRATEGY_CLASS[strategy] === 'TRADFI_INDEX') return US_SESSION; // fixed: US regular market close
  const tf = config?.strategies?.[strategy]?.timeframe || DEFAULT_TIMEFRAME[strategy] || '1d';
  return CRYPTO_TIMEFRAME_CHOICES.includes(tf) ? tf : '1d';
}

export const scheduleTypeOf = (tf) => (tf === US_SESSION ? 'US_MARKET_CLOSE' : 'CANDLE_CLOSE');

// Closed candles a strategy instance evaluates on.
export function barsFor(md, strategy, symbol, config) {
  const st = md.s[symbol];
  if (!st) return [];
  const tf = timeframeOf(strategy, config);
  if (tf === US_SESSION || tf === '1d' || isSessionSymbol(symbol)) return st.daily || []; // 1d = the daily series
  return st.bars?.[tf] || [];
}

// Intraday / multi-day closed-candle series the live market data must keep (crypto strategies; '1d' uses st.daily).
export function barIntervalsFor(config) {
  const out = new Set(['4h']);
  for (const [name, cls] of Object.entries(STRATEGY_CLASS)) {
    if (cls !== 'CRYPTO') continue;
    const tf = timeframeOf(name, config);
    if (tf !== '1d') out.add(tf);
  }
  return [...out];
}
