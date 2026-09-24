// Symbol metadata: asset class, market type, underlying, signal session and data providers.
// Crypto symbols are not fixed here: the UniverseManager (server/universe.js) selects them at startup from
// Binance USDⓈ-M quote volume and registers them with registerCryptoSymbols(). SYMBOLS / SYMBOL_META are
// live objects mutated IN PLACE, so every module that imported them sees the same set.
// FALLBACK_CRYPTO is used only when no universe is available (tests, first start without network and no cache).
export const FALLBACK_CRYPTO = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'];

const cryptoMeta = (sym, underlying = sym.replace(/USDT$/, '')) => ({
  asset_class: 'CRYPTO', market_type: 'USDM_PERPETUAL', underlying, session: 'CRYPTO_24_7', signalProvider: 'BINANCE_UTC_DAILY', executionProvider: 'BINANCE_FUTURES',
});

// Non-crypto instruments (fixed, explicitly supported)
export const TRADFI_META = {
  QQQUSDT: {
    asset_class: 'TRADFI_INDEX', market_type: 'USDM_PERPETUAL', underlying: 'Invesco QQQ Trust (Nasdaq-100 ETF)',
    session: 'US_REGULAR_MARKET', // signals on US regular-session closes (America/New_York)
    signalProvider: 'BINANCE_US_SESSION', // future: QQQ ETF session data
    executionProvider: 'BINANCE_FUTURES',
    // Binance QQQUSDT perpetual launched 2026-04-06: native history is limited.
    nativeHistory: 'LIMITED', listedAt: Date.UTC(2026, 3, 6),
  },
};

export const SYMBOL_META = {};
export const SYMBOLS = [];

// Replaces the crypto part of SYMBOLS / SYMBOL_META (TradFi symbols stay, listed last). Call before MarketData,
// Engine, Scheduler etc. are constructed: the watch set is fixed for the lifetime of the process.
export function registerCryptoSymbols(list, underlyings = {}) {
  const crypto = [...new Set(list)].filter((s) => !TRADFI_META[s]);
  for (const k of Object.keys(SYMBOL_META)) delete SYMBOL_META[k];
  for (const s of crypto) SYMBOL_META[s] = cryptoMeta(s, underlyings[s]);
  Object.assign(SYMBOL_META, TRADFI_META);
  SYMBOLS.length = 0;
  SYMBOLS.push(...crypto, ...Object.keys(TRADFI_META));
  return SYMBOLS;
}
registerCryptoSymbols(FALLBACK_CRYPTO, { BTCUSDT: 'Bitcoin', ETHUSDT: 'Ethereum', XRPUSDT: 'XRP' });

export const ASSET_CLASSES = ['CRYPTO', 'TRADFI_INDEX'];
export const CLASS_LABEL = { CRYPTO: '코인', TRADFI_INDEX: '미국지수 (QQQ)' }; // display labels
export const assetClassOf = (sym) => SYMBOL_META[sym]?.asset_class || TRADFI_META[sym]?.asset_class || 'CRYPTO';
export const symbolsOfClass = (cls) => SYMBOLS.filter((s) => assetClassOf(s) === cls);
export const isSessionSymbol = (sym) => (SYMBOL_META[sym] || TRADFI_META[sym])?.session === 'US_REGULAR_MARKET';
