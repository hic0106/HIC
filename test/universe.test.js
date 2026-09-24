import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-universe-'));
process.env.HIC_LOG_STDOUT = '0';

const { filterCandidates, rankUniverse, protectedSymbols, UniverseManager, DEFAULT_UNIVERSE } = await import('../server/universe.js');
const { SYMBOLS, SYMBOL_META, assetClassOf, registerCryptoSymbols } = await import('../server/assets.js');
const { historicalTradeSets, tradeFilterFrom, UNIVERSE_METHOD } = await import('../server/backtest/historicalUniverse.js');
const { backtestStrategy } = await import('../server/backtest/backtester.js');
const { Store, DEFAULT_CONFIG } = await import('../server/store.js');
const { Logger } = await import('../server/logger.js');
const { Engine } = await import('../server/engine.js');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 24);
const cfg = { ...DEFAULT_UNIVERSE };
const sym = (symbol, over = {}) => ({ symbol, baseAsset: symbol.replace(/USDT$/, ''), quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN', onboardDate: NOW - 1000 * DAY, ...over });
const tick = (symbol, quoteVolume, volume = 1) => ({ symbol, quoteVolume: String(quoteVolume), volume: String(volume) });

test('universe ranking: sorted by 24h quoteVolume (not base volume)', () => {
  const { eligible } = filterCandidates({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].map((s) => sym(s)) }, cfg, NOW);
  // base volume deliberately in the opposite order: XRP has the largest base volume
  const tickers = [tick('BTCUSDT', 1000, 1), tick('ETHUSDT', 900, 10), tick('SOLUSDT', 800, 100), tick('XRPUSDT', 100, 100000)];
  const r = rankUniverse(eligible, tickers, { ...cfg, watchTopN: 3, tradeTopN: 2, alwaysInclude: [] });
  assert.deepEqual(r.ranked.map((x) => [x.symbol, x.rank]), [['BTCUSDT', 1], ['ETHUSDT', 2], ['SOLUSDT', 3], ['XRPUSDT', 4]]);
  assert.deepEqual(r.watch, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.deepEqual(r.trade, ['BTCUSDT', 'ETHUSDT']);
});

test('universe filter: new listings, stablecoin bases, TradFi (QQQ), non-TRADING, non-perpetual, non-USDT excluded', () => {
  const info = { symbols: [
    sym('BTCUSDT'),
    sym('NEWUSDT', { onboardDate: NOW - 30 * DAY }),
    sym('USDCUSDT'), sym('FDUSDUSDT'), sym('USDEUSDT'),
    sym('QQQUSDT', { contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY' }),
    sym('TSLAUSDT', { contractType: 'TRADIFI_PERPETUAL' }),
    sym('HALTUSDT', { status: 'SETTLING' }),
    sym('BTCUSDT_261225', { contractType: 'CURRENT_QUARTER' }),
    sym('BTCDOMUSDT', { underlyingType: 'INDEX' }),
    { ...sym('ETHBTC'), quoteAsset: 'BTC' },
  ] };
  const { eligible, excluded } = filterCandidates(info, cfg, NOW);
  assert.deepEqual(eligible.map((e) => e.symbol), ['BTCUSDT']);
  assert.equal(excluded.NEWUSDT, 'NEW_LISTING');
  assert.equal(excluded.USDCUSDT, 'STABLECOIN');
  assert.equal(excluded.FDUSDUSDT, 'STABLECOIN');
  assert.equal(excluded.USDEUSDT, 'STABLECOIN');
  assert.equal(excluded.QQQUSDT, 'TRADFI');
  assert.equal(excluded.TSLAUSDT, 'TRADFI');
  assert.equal(excluded.HALTUSDT, 'NOT_TRADING');
  assert.equal(excluded.BTCUSDT_261225, 'NOT_PERPETUAL');
  assert.equal(excluded.BTCDOMUSDT, 'NOT_CRYPTO');
  assert.equal(excluded.ETHBTC, undefined, 'non-USDT quote ignored');
});

test('protected positions stay in the watch universe although out of rank', () => {
  const store = { state: { modes: {
    PAPER: { slots: { 'TURTLE:SOLUSDT': { symbol: 'SOLUSDT', position: { side: 'LONG' }, pending: null } } },
    LIVE: { slots: {
      'ADX:LINKUSDT': { symbol: 'LINKUSDT', position: null, pending: { clientOrderId: 'x' }, status: 'UNKNOWN' },
      'ADX:QQQUSDT': { symbol: 'QQQUSDT', position: { side: 'LONG' } },
      'TSMOM:ADAUSDT': { symbol: 'ADAUSDT', position: null, pending: null, status: 'FLAT' },
    } },
  } } };
  const prot = protectedSymbols(store.state);
  assert.deepEqual(prot.sort(), ['LINKUSDT', 'SOLUSDT']);
  const { eligible } = filterCandidates({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'LINKUSDT'].map((s) => sym(s)) }, cfg, NOW);
  const r = rankUniverse(eligible, [tick('BTCUSDT', 1000), tick('ETHUSDT', 900), tick('SOLUSDT', 10), tick('XRPUSDT', 800), tick('LINKUSDT', 5)], { ...cfg, watchTopN: 2, tradeTopN: 2, alwaysInclude: [] }, prot);
  assert.ok(r.watch.includes('SOLUSDT') && r.watch.includes('LINKUSDT'), 'protected symbols watched');
  assert.ok(!r.trade.includes('SOLUSDT'), 'but no new entries');
});

test('UniverseManager.init registers the watch set into SYMBOLS (live objects) and keeps protected symbols', async () => {
  const store = { config: { cryptoUniverse: { ...DEFAULT_UNIVERSE, watchTopN: 3, tradeTopN: 2, alwaysInclude: ['BTCUSDT'] } },
    state: { modes: { PAPER: { slots: { 'TURTLE:DOTUSDT': { symbol: 'DOTUSDT', position: { side: 'LONG' } } } }, LIVE: { slots: {} } } } };
  const rest = {
    exchangeInfo: async () => ({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOTUSDT'].map((s) => sym(s, { onboardDate: Date.now() - 400 * DAY })) }),
    publicGet: async () => [tick('ETHUSDT', 900), tick('SOLUSDT', 800), tick('XRPUSDT', 700), tick('BTCUSDT', 100), tick('DOTUSDT', 1)],
  };
  const file = path.join(process.env.HIC_DATA_DIR, 'u1.json');
  const u = new UniverseManager({ store, rest, log: null, file });
  await u.init();
  assert.deepEqual(u.watch, ['ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BTCUSDT', 'DOTUSDT'], 'top 3 + alwaysInclude BTC + protected DOT');
  assert.deepEqual([...u.tradeSet].sort(), ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.deepEqual(SYMBOLS, ['ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BTCUSDT', 'DOTUSDT', 'QQQUSDT'], 'TradFi symbols kept, listed last');
  assert.equal(assetClassOf('DOTUSDT'), 'CRYPTO');
  assert.equal(SYMBOL_META.QQQUSDT.asset_class, 'TRADFI_INDEX');
  assert.equal(u.isTradeAllowed('XRPUSDT'), false);
  assert.equal(u.isTradeAllowed('DOTUSDT'), false);
  assert.equal(u.isTradeAllowed('QQQUSDT'), true, 'TradFi is not ranked');
  const snap = u.snapshot();
  assert.equal(snap.rows.find((r) => r.symbol === 'ETHUSDT').rank, 1);
  assert.equal(snap.rows.find((r) => r.symbol === 'DOTUSDT').protected, true);

  // runtime refresh: ranks change, trade permissions follow but only inside the subscribed watch set
  rest.publicGet = async () => [tick('XRPUSDT', 2000), tick('DOTUSDT', 1500), tick('ADAUSDT', 1400), tick('ETHUSDT', 900), tick('SOLUSDT', 1), tick('BTCUSDT', 100)];
  rest.exchangeInfo = async () => ({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOTUSDT', 'ADAUSDT'].map((s) => sym(s, { onboardDate: Date.now() - 400 * DAY })) });
  await u.refresh();
  assert.deepEqual(u.watch, ['ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BTCUSDT', 'DOTUSDT'], 'watch set unchanged at runtime');
  assert.deepEqual([...u.tradeSet].sort(), ['BTCUSDT', 'DOTUSDT', 'XRPUSDT']);
  assert.ok(u.pending.add.includes('ADAUSDT'), 'new top symbol applied on restart');
  assert.ok(!u.isTradeAllowed('ADAUSDT'));

  // network failure on the next start -> saved universe, protected still added
  const u2 = new UniverseManager({ store, rest: { exchangeInfo: async () => { throw new Error('offline'); }, publicGet: async () => [] }, log: null, file });
  await u2.init();
  assert.equal(u2.source, 'CACHE');
  assert.ok(u2.watch.includes('DOTUSDT'));
});

test('historical liquidity: ranking uses only candles closed before each rebalance (no future quoteVolume)', () => {
  const start = 100 * DAY, end = 130 * DAY;
  const mkDaily = (f) => Array.from({ length: 130 }, (_, i) => ({ t: i * DAY, T: (i + 1) * DAY - 1, qv: f(i) }));
  // A dominant before day 107, B dominant from day 107 on
  const daily = { AUSDT: mkDaily((i) => (i < 107 ? 100 : 1)), BUSDT: mkDaily((i) => (i < 107 ? 1 : 100)) };
  const sets = historicalTradeSets(daily, { symbols: ['AUSDT', 'BUSDT'], start, end, lookbackDays: 3, rebalanceDays: 7, topN: 1 });
  assert.deepEqual(sets.map((s) => [s.from / DAY, [...s.symbols]]), [[100, ['AUSDT']], [107, ['AUSDT']], [114, ['BUSDT']], [121, ['BUSDT']], [128, ['BUSDT']]]);
  // rebalance at day 107: day 107's own candle (closes at 108) must NOT be used although B jumps on that day
  assert.equal(sets[1].ranks[0].symbol, 'AUSDT');
  // mutating future candles never changes an earlier decision
  const daily2 = structuredClone(daily);
  for (const c of daily2.BUSDT) if (c.t >= 107 * DAY) c.qv = 1e12;
  const sets2 = historicalTradeSets(daily2, { symbols: ['AUSDT', 'BUSDT'], start, end, lookbackDays: 3, rebalanceDays: 7, topN: 1 });
  assert.deepEqual([...sets2[0].symbols], [...sets[0].symbols]);
  assert.deepEqual([...sets2[1].symbols], [...sets[1].symbols]);
  const allowed = tradeFilterFrom(sets);
  assert.equal(allowed('AUSDT', 110 * DAY), true);
  assert.equal(allowed('BUSDT', 110 * DAY), false);
  assert.equal(allowed('BUSDT', 115 * DAY), true);
  assert.equal(allowed('AUSDT', 99 * DAY), false, 'before the first rebalance nothing is allowed');
  // listing age at the rebalance time
  const young = { ...daily, CUSDT: mkDaily(() => 1e9).slice(95) }; // listed at day 95
  const s3 = historicalTradeSets(young, { symbols: ['AUSDT', 'BUSDT', 'CUSDT'], start, end, lookbackDays: 3, rebalanceDays: 7, topN: 1, minListingDays: 20 });
  assert.ok(!s3[0].symbols.has('CUSDT') && s3[3].symbols.has('CUSDT'), 'eligible only 20 days after listing');
});

test('backtest: trade filter blocks entries, never exits; sizing = capital / tradeTopN', async () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.general.includeFunding = false;
  const closes = Array.from({ length: 120 }, (_, i) => 100 + i);
  const mk = () => closes.map((x, i) => ({ t: i * DAY, o: x, h: x * 1.005, l: x * 0.995, c: x, v: 1, qv: 1, T: (i + 1) * DAY - 1 }));
  const data = { AUSDT: mk(), BUSDT: mk(), CUSDT: mk() };
  const allow = (s, t) => s !== 'CUSDT' && !(s === 'BUSDT' && t > 80 * DAY);
  const r = await backtestStrategy({ strategy: 'TSMOM', config: c, data, start: 50 * DAY, end: 120 * DAY, capital: 900_000, compound: false, symbols: ['AUSDT', 'BUSDT', 'CUSDT'], tradeFilter: allow, slots: 2, universeNote: UNIVERSE_METHOD });
  const held = r.openPositions.map((p) => p.symbol).sort();
  assert.deepEqual(held, ['AUSDT', 'BUSDT'], 'C never entered; B entered while allowed and is kept after it drops out');
  assert.ok(r.openPositions.every((p) => Math.abs(p.notional - 450_000) < 1e-6), 'capital / slots');
  assert.equal(r.slots, 2);
  assert.ok(r.notes[0] === UNIVERSE_METHOD || r.notes.includes(UNIVERSE_METHOD));
});

// ---------- engine gate
function fakeMarket() {
  const md = new EventEmitter();
  md.status = 'CONNECTED';
  md.s = {}; md.filters = {};
  for (const s of SYMBOLS) {
    md.s[s] = { daily: [], bars: { '4h': [] }, last: 100, lastTs: Date.now() };
    md.filters[s] = { symbol: s, status: 'TRADING', stepSize: 0.001, minQty: 0.001, maxQty: 1e6, minNotional: 5, tickSize: 0.01 };
  }
  md.price = (x) => md.s[x].last;
  md.isStale = () => false;
  return md;
}

test('engine: symbol outside the trade universe -> UNIVERSE_FILTER on entry, exits still allowed', async () => {
  registerCryptoSymbols(['BTCUSDT', 'SOLUSDT']);
  const store = new Store();
  store.state.modes.PAPER = { ...store.state.modes.PAPER, slots: {}, orders: [], trades: [], wallet: 10000, realizedTotal: 0, baseCapital: 10000 };
  store.state.runState = 'RUNNING';
  const engine = new Engine(store, fakeMarket(), new Logger(store));
  let allowed = true;
  engine.universe = { isTradeAllowed: (s) => allowed || s !== 'SOLUSDT', cfg: { tradeTopN: 15 } };
  const first = await engine.openPosition('ADX', 'SOLUSDT', 'LONG', { atr: 1 });
  assert.equal(first.ok, true, first.msg);
  allowed = false; // SOL falls out of the top 15
  const blocked = await engine.openPosition('TURTLE', 'SOLUSDT', 'LONG', { atr: 1 });
  assert.equal(blocked.code, 'UNIVERSE_FILTER');
  assert.equal((await engine.closePosition('ADX', 'SOLUSDT', 'STRATEGY_EXIT')).ok, true, 'exit never blocked');
  assert.equal(engine.ms().trades[0].symbol, 'SOLUSDT');
});

test('klines keep base volume v and add quote volume qv (REST index 7)', async () => {
  const { toCandle } = await import('../server/marketData.js');
  const c = toCandle([1000, '1', '2', '0.5', '1.5', '10', 1999, '15.5', 5]);
  assert.equal(c.v, 10);
  assert.equal(c.qv, 15.5);
});
