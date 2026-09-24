// Point-in-time trade universe for backtests (no look-ahead).
// At every rebalance time R (start, start + rebalanceDays, ...), the candidates are ranked by the SUM of the
// quoteVolume (USDT turnover) of daily candles that CLOSED before R within [R - lookbackDays, R). The top N may
// open new positions until the next rebalance. Nothing at or after R is read.
// Limitation: candidates = the CURRENT watch set (today's top list), ranked historically inside that set
// -> survivorship bias is reduced, not removed (coins that were big in the past but fell out are missing).
export const UNIVERSE_METHOD = 'HISTORICAL_QUOTE_VOLUME_WITHIN_WATCH_SET';
const DAY = 86_400_000;

// daily: { symbol: [{ t, T, qv }] } sorted by t. Returns [{ from, to, symbols: Set, ranks: [{symbol, score, rank}] }]
export function historicalTradeSets(daily, { symbols, start, end, lookbackDays = 30, rebalanceDays = 7, topN = 15, minListingDays = 0, alwaysInclude = [] }) {
  const sets = [];
  for (let R = start; R < end; R += rebalanceDays * DAY) {
    const from = R - lookbackDays * DAY;
    const scores = [];
    for (const s of symbols) {
      const rows = daily[s] || [];
      if (!rows.length) continue;
      // listed long enough at R (first available bar; data is loaded well before the test start)
      if (minListingDays > 0 && rows[0].t > R - minListingDays * DAY) continue;
      let sum = 0, n = 0;
      for (const c of rows) {
        if (c.T >= R) break; // candle not closed before R -> future information
        if (c.t >= from && Number.isFinite(c.qv)) { sum += c.qv; n++; }
      }
      if (n > 0 && sum > 0) scores.push({ symbol: s, score: sum });
    }
    scores.sort((a, b) => b.score - a.score);
    const ranks = scores.map((x, i) => ({ ...x, rank: i + 1 }));
    const pick = new Set(ranks.slice(0, topN).map((x) => x.symbol));
    for (const s of alwaysInclude) if (ranks.some((x) => x.symbol === s)) pick.add(s);
    sets.push({ from: R, to: Math.min(R + rebalanceDays * DAY, end), symbols: pick, ranks });
  }
  return sets;
}

// Trade permission at time t (signal time): the set whose period contains t. Before the first set: not allowed.
export function tradeFilterFrom(sets) {
  return (symbol, t) => {
    let lo = 0, hi = sets.length - 1, hit = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sets[mid].from <= t) { hit = sets[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return !!hit && hit.symbols.has(symbol); // sets are contiguous; the last one runs to the end of the test
  };
}
