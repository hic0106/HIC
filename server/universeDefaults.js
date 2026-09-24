// Default crypto universe settings (separate file: imported by store.js and universe.js without a cycle).
export const DEFAULT_UNIVERSE = {
  mode: 'TOP_QUOTE_VOLUME', // TOP_QUOTE_VOLUME | STATIC (fallback BTC/ETH/XRP + alwaysInclude)
  watchTopN: 20, // watched: market data, signals, position management
  tradeTopN: 15, // new entries allowed
  minListingDays: 90,
  alwaysInclude: ['BTCUSDT', 'ETHUSDT'],
  excludeStablecoinBases: true,
  backtestDynamic: true, // backtest: historical quoteVolume ranking inside the watch set (no look-ahead)
  backtestRankLookbackDays: 30,
  backtestRebalanceDays: 7,
};
