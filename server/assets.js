// Symbol metadata: asset class, market type, underlying, signal session and data providers.
export const SYMBOL_META = {
  BTCUSDT: { asset_class: 'CRYPTO', market_type: 'USDM_PERPETUAL', underlying: 'Bitcoin', session: 'CRYPTO_24_7', signalProvider: 'BINANCE_UTC_DAILY', executionProvider: 'BINANCE_FUTURES' },
  ETHUSDT: { asset_class: 'CRYPTO', market_type: 'USDM_PERPETUAL', underlying: 'Ethereum', session: 'CRYPTO_24_7', signalProvider: 'BINANCE_UTC_DAILY', executionProvider: 'BINANCE_FUTURES' },
  XRPUSDT: { asset_class: 'CRYPTO', market_type: 'USDM_PERPETUAL', underlying: 'XRP', session: 'CRYPTO_24_7', signalProvider: 'BINANCE_UTC_DAILY', executionProvider: 'BINANCE_FUTURES' },
  QQQUSDT: {
    asset_class: 'TRADFI_INDEX', market_type: 'USDM_PERPETUAL', underlying: 'Invesco QQQ Trust (Nasdaq-100 ETF)',
    session: 'US_REGULAR_MARKET', // signals on US regular-session closes (America/New_York)
    signalProvider: 'BINANCE_US_SESSION', // future: QQQ ETF session data
    executionProvider: 'BINANCE_FUTURES',
    // Binance QQQUSDT perpetual launched 2026-04-06: native history is limited.
    nativeHistory: 'LIMITED', listedAt: Date.UTC(2026, 3, 6),
  },
};

export const SYMBOLS = Object.keys(SYMBOL_META);
export const ASSET_CLASSES = ['CRYPTO', 'TRADFI_INDEX'];
export const CLASS_LABEL = { CRYPTO: 'CRYPTO', TRADFI_INDEX: 'TRADFI' };
export const assetClassOf = (sym) => SYMBOL_META[sym]?.asset_class || 'CRYPTO';
export const symbolsOfClass = (cls) => SYMBOLS.filter((s) => assetClassOf(s) === cls);
export const isSessionSymbol = (sym) => SYMBOL_META[sym]?.session === 'US_REGULAR_MARKET';
