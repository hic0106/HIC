// Signal timeframe per strategy. Strategy rules are unchanged; only the candle series they read differs.
//   '4h' / '1d'   : Binance UTC-aligned kline closes (crypto)
//   'US_SESSION'  : NYSE regular-session candles (QQQ), closes follow America/New_York incl. DST / holidays
import { STRATEGY_CLASS } from '../strategyRegistry.js';
import { isSessionSymbol } from '../assets.js';

export const US_SESSION = 'US_SESSION';
export const KLINE_TIMEFRAMES = ['4h', '1d']; // closed-candle series kept for strategies
export const CRYPTO_TIMEFRAME_CHOICES = ['4h', '1d'];
export const TF_MS = { '4h': 4 * 3600_000, '1d': 86_400_000 };
export const TF_LABEL = { '4h': '4H', '1d': '1D', [US_SESSION]: 'US SESSION' };

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
  if (tf === US_SESSION || tf === '1d' || isSessionSymbol(symbol)) return st.daily || [];
  return st.bars?.[tf] || [];
}
