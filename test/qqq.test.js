import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-qqq-test-'));
process.env.HIC_LOG_STDOUT = '0';

const { Store, DEFAULT_CONFIG, SYMBOLS } = await import('../server/store.js');
const { Logger } = await import('../server/logger.js');
const { Engine } = await import('../server/engine.js');
const { SYMBOL_META, assetClassOf } = await import('../server/assets.js');
const { usSession, marketStatus, sessionsBetween, buildSessionCandle, nyToUtc } = await import('../server/session.js');
const { BinanceUsSessionProvider } = await import('../server/dataProviders.js');
const { evaluateTradfi } = await import('../server/strategiesTradfi.js');
const { evaluateStrategy, strategiesForSymbol, META } = await import('../server/strategyRegistry.js');
const { evaluate: evaluateCrypto } = await import('../server/strategies.js');
const { parseSymbolFilters, floorToStep } = await import('../server/binance.js');
const { Controller } = await import('../server/controller/controllerEngine.js');
const { ControllerStore, emptyControllerState } = await import('../server/controller/controllerStore.js');

const DAY = 86_400_000;
const candles = (closes, spread = 0.005) => closes.map((c, i) => ({ t: i * DAY, o: c, h: c * (1 + spread), l: c * (1 - spread), c, v: 1, T: (i + 1) * DAY - 1 }));

function fakeMarket(qqqCloses = Array.from({ length: 220 }, (_, i) => 500 * 1.002 ** i)) {
  const md = new EventEmitter();
  md.status = 'CONNECTED';
  md.s = {}; md.filters = {};
  for (const sym of SYMBOLS) {
    const qqq = sym === 'QQQUSDT';
    md.s[sym] = { daily: qqq ? candles(qqqCloses) : candles(Array.from({ length: 300 }, () => 100)), last: qqq ? qqqCloses.at(-1) : 100, lastTs: Date.now() };
    md.filters[sym] = qqq
      ? { symbol: sym, status: 'TRADING', stepSize: 0.01, minQty: 0.01, maxQty: 1e6, minNotional: 5, tickSize: 0.01 }
      : { symbol: sym, status: 'TRADING', stepSize: 0.001, minQty: 0.001, maxQty: 1e6, minNotional: 5, tickSize: 0.01 };
  }
  md.price = (s) => md.s[s].last;
  md.isStale = () => false;
  return md;
}

function setup(md = fakeMarket()) {
  const store = new Store();
  store.config = structuredClone(DEFAULT_CONFIG);
  store.state.modes.PAPER = { ...store.state.modes.PAPER, slots: {}, orders: [], trades: [], wallet: 10000, realizedTotal: 0, baseCapital: 10000 };
  store.state.runState = 'RUNNING';
  const log = new Logger(store);
  const logs = [];
  log.on('log', (e) => logs.push(e));
  const engine = new Engine(store, md, log);
  return { store, engine, md, logs, log };
}

// ---------------------------------------------------------------- metadata / availability
test('QQQ symbol metadata: TRADFI_INDEX, US session, limited native history', () => {
  assert.ok(SYMBOLS.includes('QQQUSDT'));
  assert.equal(assetClassOf('QQQUSDT'), 'TRADFI_INDEX');
  assert.equal(assetClassOf('BTCUSDT'), 'CRYPTO');
  const m = SYMBOL_META.QQQUSDT;
  assert.equal(m.market_type, 'USDM_PERPETUAL');
  assert.match(m.underlying, /QQQ/);
  assert.equal(m.session, 'US_REGULAR_MARKET');
  assert.equal(m.nativeHistory, 'LIMITED');
  assert.deepEqual(strategiesForSymbol('QQQUSDT'), ['QQQ_EMA_TREND', 'QQQ_TSMOM', 'QQQ_SMA200', 'QQQ_TURTLE_50_20']);
  assert.deepEqual(strategiesForSymbol('BTCUSDT'), ['TURTLE', 'ADX', 'TSMOM']);
});

test('QQQ futures availability: filters parsed, missing symbol blocks only QQQ', async () => {
  const f = parseSymbolFilters({ symbol: 'QQQUSDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', filters: [
    { filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.01', minQty: '0.01', maxQty: '10000' },
    { filterType: 'MARKET_LOT_SIZE', stepSize: '0.01', minQty: '0.01', maxQty: '1000' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] });
  assert.equal(f.stepSize, 0.01);
  assert.equal(f.minNotional, 5);
  const md = fakeMarket();
  delete md.filters.QQQUSDT;
  md.s.QQQUSDT.unavailable = 'symbol not found';
  const { engine } = setup(md);
  assert.equal((await engine.openPosition('QQQ_EMA_TREND', 'QQQUSDT', 'LONG', { atr: 5 })).code, 'SYMBOL_NOT_TRADABLE');
  assert.equal((await engine.openPosition('TURTLE', 'BTCUSDT', 'LONG', { atr: 1 })).ok, true, 'crypto unaffected');
});

test('QQQ order quantity / min notional', async () => {
  assert.equal(floorToStep(300 / 609.37, 0.01), 0.49);
  const { engine, store } = setup(fakeMarket(Array.from({ length: 220 }, () => 600)));
  assert.equal((await engine.openPosition('QQQ_EMA_TREND', 'QQQUSDT', 'LONG', { atr: 5 })).ok, true);
  const pos = engine.slot('QQQ_EMA_TREND', 'QQQUSDT').position;
  assert.equal(pos.qty, 0.5);
  store.config.strategies.QQQ_TSMOM.amounts.PAPER.long = 3;
  assert.equal((await engine.openPosition('QQQ_TSMOM', 'QQQUSDT', 'LONG', { atr: 5 })).code, 'BELOW_MIN_QTY');
  store.config.strategies.QQQ_TSMOM.amounts.PAPER.long = 4;
  const md2 = fakeMarket(Array.from({ length: 220 }, () => 100));
  const e2 = setup(md2);
  e2.store.config.strategies.QQQ_TSMOM.amounts.PAPER.long = 4;
  assert.equal((await e2.engine.openPosition('QQQ_TSMOM', 'QQQUSDT', 'LONG', { atr: 1 })).code, 'BELOW_MIN_NOTIONAL');
});

test('QQQ funding accounting: trading PnL, fee, funding, net stored separately', async () => {
  const { engine, md } = setup(fakeMarket(Array.from({ length: 220 }, () => 600)));
  await engine.openPosition('QQQ_EMA_TREND', 'QQQUSDT', 'LONG', { atr: 5 });
  const pos = engine.slot('QQQ_EMA_TREND', 'QQQUSDT').position;
  engine.onFunding({ symbol: 'QQQUSDT', time: Date.now() + 1, rate: 0.0001, markPrice: 600 });
  assert.ok(Math.abs(pos.funding - pos.qty * 600 * 0.0001) < 1e-9);
  md.s.QQQUSDT.last = 612;
  await engine.closePosition('QQQ_EMA_TREND', 'QQQUSDT', 'MANUAL_EXIT');
  const t = engine.ms().trades[0];
  assert.ok(t.grossPnl > 0 && t.fee > 0);
  assert.ok(t.funding < 0, 'funding paid is recorded as a cost');
  assert.ok(Math.abs(t.netPnl - (t.grossPnl - t.fee + t.funding)) < 1e-9);
});

// ---------------------------------------------------------------- US session
test('US market session detection (America/New_York, DST, holidays, early close)', () => {
  const s = usSession('2026-09-23');
  assert.equal(new Date(s.open).toISOString(), '2026-09-23T13:30:00.000Z'); // EDT
  assert.equal(new Date(s.close).toISOString(), '2026-09-23T20:00:00.000Z');
  assert.equal(new Date(usSession('2026-12-01').open).toISOString(), '2026-12-01T14:30:00.000Z'); // EST
  assert.equal(usSession('2026-09-26'), null, 'Saturday');
  assert.equal(usSession('2026-11-26'), null, 'Thanksgiving');
  assert.equal(usSession('2026-07-03'), null, 'Independence Day observed');
  const early = usSession('2026-11-27');
  assert.ok(early.early);
  assert.equal(new Date(early.close).toISOString(), '2026-11-27T18:00:00.000Z');
  assert.equal(marketStatus(Date.parse('2026-09-23T15:00:00Z')).underlying, 'OPEN');
  assert.equal(marketStatus(Date.parse('2026-09-23T21:00:00Z')).underlying, 'CLOSED');
  assert.equal(marketStatus(Date.parse('2026-09-26T15:00:00Z')).underlying, 'CLOSED');
  assert.equal(nyToUtc('2026-03-09', '09:30'), Date.parse('2026-03-09T13:30:00Z'));
});

test('session candles use regular-hours bars only; off-hours prices do not change signals', async () => {
  const start = Date.parse('2026-09-21T00:00:00Z');
  const bars = [];
  for (let t = start; t < start + 3 * DAY; t += 30 * 60_000) {
    const s = usSession(new Date(t - 4 * 3600_000).toISOString().slice(0, 10));
    const inSession = s && t >= s.open && t < s.close;
    const px = inSession ? 600 : 900; // off-hours spike must be ignored
    bars.push([t, px, px + 1, px - 1, px, 10, t + 30 * 60_000 - 1]);
  }
  const rest = { publicGet: async () => bars };
  const p = new BinanceUsSessionProvider({ rest, symbol: 'QQQUSDT', listedAt: start, getCalendar: () => DEFAULT_CONFIG.general.usCalendar });
  await p.fetchRange(start, start + 3 * DAY);
  const sess = p.sessions(start, start + 3 * DAY);
  assert.deepEqual(sess.map((c) => c.day), ['2026-09-21', '2026-09-22', '2026-09-23']);
  for (const c of sess) {
    assert.equal(c.c, 600);
    assert.ok(c.h <= 601, 'off-hours high excluded');
    assert.equal(c.bars, 13);
  }
  assert.equal(sessionsBetween(start, start + 3 * DAY).length, 3);
  assert.equal(buildSessionCandle(usSession('2026-09-24'), []), null);
});

// ---------------------------------------------------------------- strategies
test('QQQ EMA 50/150 signal and exit', () => {
  const cfg = DEFAULT_CONFIG.strategies.QQQ_EMA_TREND;
  const up = candles(Array.from({ length: 200 }, (_, i) => 400 + i));
  let r = evaluateTradfi('QQQ_EMA_TREND', up, cfg);
  assert.equal(r.longCond, true);
  assert.equal(r.shortCond, false);
  const down = candles(Array.from({ length: 200 }, (_, i) => 600 - i));
  r = evaluateTradfi('QQQ_EMA_TREND', down, cfg);
  assert.equal(r.longCond, false);
  assert.equal(r.longExit, true);
  const short = evaluateTradfi('QQQ_EMA_TREND', candles(Array.from({ length: 120 }, () => 500)), cfg);
  assert.equal(short.ready, false, 'EMA150 needs 152 US sessions');
  assert.match(short.reason, /insufficient session history/);
});

test('QQQ TSMOM 126 signal (separate instance from crypto TSMOM 30)', () => {
  const cfg = DEFAULT_CONFIG.strategies.QQQ_TSMOM;
  assert.equal(cfg.params.lookback, 126);
  assert.equal(DEFAULT_CONFIG.strategies.TSMOM.params.lookback, 30);
  const c = candles(Array.from({ length: 140 }, (_, i) => 500 * 1.001 ** i));
  const r = evaluateTradfi('QQQ_TSMOM', c, cfg);
  assert.equal(r.longCond, true);
  assert.ok(Math.abs(r.view.momentum - Math.log(c[139].c / c[13].c)) < 1e-12);
  const d = evaluateTradfi('QQQ_TSMOM', candles(Array.from({ length: 140 }, (_, i) => 500 * 0.999 ** i)), cfg);
  assert.equal(d.longExit, true);
});

test('QQQ SMA200 and Slow Turtle 50/20 exist, default disabled', () => {
  assert.equal(DEFAULT_CONFIG.strategies.QQQ_SMA200.enabled, false);
  assert.equal(DEFAULT_CONFIG.strategies.QQQ_TURTLE_50_20.enabled, false);
  assert.equal(DEFAULT_CONFIG.strategies.QQQ_EMA_TREND.enabled, true);
  assert.equal(DEFAULT_CONFIG.strategies.QQQ_TSMOM.enabled, true);
  const up = candles([...Array.from({ length: 210 }, () => 500), 520]);
  assert.equal(evaluateTradfi('QQQ_SMA200', up, DEFAULT_CONFIG.strategies.QQQ_SMA200).longCond, true);
  assert.equal(evaluateTradfi('QQQ_TURTLE_50_20', up, DEFAULT_CONFIG.strategies.QQQ_TURTLE_50_20).longCond, true);
  const dn = candles([...Array.from({ length: 210 }, () => 500), 480]);
  assert.equal(evaluateTradfi('QQQ_TURTLE_50_20', dn, DEFAULT_CONFIG.strategies.QQQ_TURTLE_50_20).longExit, true);
});

test('Long → Cash transition through the engine; no QQQ short order ever', async () => {
  const rising = Array.from({ length: 220 }, (_, i) => 500 * 1.002 ** i);
  const md = fakeMarket(rising);
  const { engine, store } = setup(md);
  store.config.strategies.QQQ_TSMOM.enabled = false;
  await engine.evaluateSymbol('QQQUSDT', 'test');
  assert.equal(engine.slot('QQQ_EMA_TREND', 'QQQUSDT').status, 'LONG');
  // trend reverses: EMA50 < EMA150 on a new session close
  const falling = [...rising, ...Array.from({ length: 120 }, (_, i) => rising.at(-1) * 0.99 ** (i + 1))];
  md.s.QQQUSDT.daily = candles(falling);
  md.s.QQQUSDT.last = falling.at(-1);
  await engine.evaluateSymbol('QQQUSDT', 'test');
  assert.equal(engine.slot('QQQ_EMA_TREND', 'QQQUSDT').status, 'FLAT');
  assert.equal(engine.ms().trades[0].exitReason, 'STRATEGY_EXIT');
  assert.ok(engine.ms().orders.every((o) => o.positionSide === 'LONG'), 'no SHORT orders for QQQ');
  assert.equal((await engine.openPosition('QQQ_EMA_TREND', 'QQQUSDT', 'SHORT', { atr: 5 })).code, 'SHORT_DISABLED');
  for (const st of strategiesForSymbol('QQQUSDT')) assert.equal(META[st].supportsShort, false);
  // crypto strategies never touched QQQ, QQQ strategies never touched BTC
  assert.ok(!engine.ms().slots['TURTLE:QQQUSDT']);
  await engine.evaluateSymbol('BTCUSDT', 'test');
  assert.ok(!engine.ms().slots['QQQ_EMA_TREND:BTCUSDT']);
});

test('QQQ ATR emergency stop range 5–12%', async () => {
  const { engine } = setup(fakeMarket(Array.from({ length: 220 }, () => 600)));
  await engine.openPosition('QQQ_EMA_TREND', 'QQQUSDT', 'LONG', { atr: 1 }); // raw 0.4% → clamped to 5%
  let pos = engine.slot('QQQ_EMA_TREND', 'QQQUSDT').position;
  assert.ok(Math.abs(pos.stopPct - 5) < 1e-9);
  await engine.openPosition('QQQ_TSMOM', 'QQQUSDT', 'LONG', { atr: 60 }); // raw 25% → clamped to 12%
  pos = engine.slot('QQQ_TSMOM', 'QQQUSDT').position;
  assert.ok(Math.abs(pos.stopPct - 12) < 1e-9);
});

test('QQQ leverage is separate and defaults to 1x', () => {
  const { engine } = setup();
  assert.equal(engine.leverageFor('QQQUSDT'), 1);
  engine.store.config.general.leverage = 3;
  assert.equal(engine.leverageFor('BTCUSDT'), 3);
  assert.equal(engine.leverageFor('QQQUSDT'), 1);
});

test('controller multiplier applies to QQQ strategies (order multiplier only)', async () => {
  const { store, engine, md, log } = setup(fakeMarket(Array.from({ length: 220 }, () => 600)));
  store.config.controller.mode = 'PAPER_AUTO';
  const cs = new ControllerStore(); cs.state = emptyControllerState(); cs.history = [];
  const c = new Controller({ store, md, engine, log, cstore: cs });
  engine.controller = c;
  assert.ok(c.keys().some((k) => k.key === 'QQQ_EMA_TREND:LONG' && k.assetClass === 'TRADFI_INDEX'));
  assert.ok(!c.keys().some((k) => k.key === 'QQQ_EMA_TREND:SHORT'));
  cs.state.applied.PAPER['QQQ_EMA_TREND:LONG'] = { status: 'BOOSTED', multiplier: 1.25 };
  await engine.openPosition('QQQ_EMA_TREND', 'QQQUSDT', 'LONG', { atr: 5 });
  const pos = engine.slot('QQQ_EMA_TREND', 'QQQUSDT').position;
  assert.equal(pos.orderAmount, 375);
  assert.equal(store.config.strategies.QQQ_EMA_TREND.params.fastEma, 50);
  assert.equal(store.config.strategies.QQQ_EMA_TREND.params.slowEma, 150);
  assert.equal(engine.leverageFor('QQQUSDT'), 1);
  c.evaluate('test');
  const perf = c.classPerformance();
  assert.ok(perf.CRYPTO && perf.TRADFI_INDEX, 'crypto / tradfi evaluated separately');
  assert.ok(c.state.regimes.TRADFI_INDEX, 'tradfi regime from QQQ sessions');
});

test('strategy settings persistence (QQQ)', () => {
  const s1 = new Store();
  s1.config.strategies.QQQ_EMA_TREND.amounts.PAPER.long = 420;
  s1.config.strategies.QQQ_TSMOM.params.lookback = 189;
  s1.saveConfig();
  const s2 = new Store();
  assert.equal(s2.config.strategies.QQQ_EMA_TREND.amounts.PAPER.long, 420);
  assert.equal(s2.config.strategies.QQQ_TSMOM.params.lookback, 189);
  assert.equal(s2.config.strategies.TURTLE.params.entryPeriod, 20, 'crypto config intact');
});

test('QQQ PnL and exposure separated from crypto', async () => {
  const md = fakeMarket(Array.from({ length: 220 }, () => 600));
  const { engine } = setup(md);
  await engine.openPosition('TURTLE', 'BTCUSDT', 'LONG', { atr: 1 });
  await engine.openPosition('QQQ_EMA_TREND', 'QQQUSDT', 'LONG', { atr: 5 });
  md.s.QQQUSDT.last = 630;
  const a = engine.accountSummary();
  assert.ok(a.byClass.CRYPTO.long > 0 && a.byClass.TRADFI_INDEX.long > 0);
  assert.ok(Math.abs(a.byClass.CRYPTO.gross + a.byClass.TRADFI_INDEX.gross - a.grossExp) < 1e-9);
  assert.ok(a.byClass.TRADFI_INDEX.pnl > 0);
  assert.ok(Math.abs(a.byClass.CRYPTO.pnl + a.byClass.TRADFI_INDEX.pnl - a.totalPnl) < 1e-6);
  await engine.closePosition('QQQ_EMA_TREND', 'QQQUSDT', 'MANUAL_EXIT');
  const b = engine.accountSummary();
  assert.ok(b.byClass.TRADFI_INDEX.realized > 0);
  assert.equal(b.byClass.TRADFI_INDEX.gross, 0);
});

// ---------------------------------------------------------------- regression / config-change markers
test('regression: crypto strategies evaluate identically through the registry', () => {
  const c = candles(Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 7) * 10 + i * 0.1));
  for (const st of ['TURTLE', 'ADX', 'TSMOM']) {
    assert.deepEqual(evaluateStrategy(st, c, DEFAULT_CONFIG.strategies[st]), evaluateCrypto(st, c, DEFAULT_CONFIG.strategies[st]));
  }
});

test('config change marker: recorded in history; parameter change separates evaluation data', () => {
  const { store, engine, md, log } = setup();
  const cs = new ControllerStore(); cs.state = emptyControllerState(); cs.history = [];
  const c = new Controller({ store, md, engine, log, cstore: cs });
  const today = Math.floor(Date.now() / DAY);
  cs.state.shadow.series['TURTLE:LONG'] = Array.from({ length: 200 }, (_, i) => ({ day: new Date((today - 199 + i) * DAY).toISOString().slice(0, 10), cum: i * 0.003, open: 1 }));
  const prev = structuredClone(store.config.strategies.TURTLE);
  store.config.strategies.TURTLE.amounts.PAPER.long = 350;
  c.onStrategyConfigChanged('TURTLE', prev, store.config.strategies.TURTLE);
  assert.equal(cs.history.at(-1).type, 'CONFIG_CHANGE');
  assert.equal(cs.history.at(-1).significant, false, 'amount change is not a parameter change');
  assert.equal(c.metricsFor('TURTLE', 'LONG').historyDays, 200);
  const prev2 = structuredClone(store.config.strategies.TURTLE);
  store.config.strategies.TURTLE.params.entryPeriod = 25;
  c.onStrategyConfigChanged('TURTLE', prev2, store.config.strategies.TURTLE);
  const h = cs.history.at(-1);
  assert.equal(h.significant, true);
  assert.match(h.reason, /params\.entryPeriod 20→25/);
  const m = c.metricsFor('TURTLE', 'LONG');
  assert.equal(m.historyReset, true);
  assert.ok(m.historyDays <= 1, 'old-parameter data excluded');
  assert.ok(m.change && m.change.retBefore > 0);
  store.config.controller.resetHistoryOnParamChange = false;
  assert.equal(c.metricsFor('TURTLE', 'LONG').historyDays, 200);
});

test('market data: QQQ session close emits one dailyClose per US session (not per UTC day)', async () => {
  const { MarketData } = await import('../server/marketData.js');
  const log = new Logger(new Store());
  const md = new MarketData(['QQQUSDT'], log, { getCalendar: () => DEFAULT_CONFIG.general.usCalendar });
  const now = Date.now();
  const start = now - 10 * DAY;
  const bars = [];
  for (let t = Math.floor(start / 1800000) * 1800000; t + 1800000 <= now; t += 1800000) bars.push([t, 600, 601, 599, 600, 1, t + 1800000 - 1]);
  const st = md.s.QQQUSDT;
  st.session.rest = { publicGet: async () => bars };
  st.session.listedAt = start;
  md.filters.QQQUSDT = { status: 'TRADING' };
  await md.loadSession('QQQUSDT');
  const n = st.daily.length;
  assert.ok(n >= 5 && n <= 8, `~7 US sessions in 10 days (got ${n})`);
  const closes = [];
  md.on('dailyClose', (e) => closes.push(e));
  // pretend the last session had not been processed yet
  const last = st.daily.pop();
  st.lastSessionT = st.daily.at(-1).t;
  await md.checkSessionClose('QQQUSDT');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].candle.day, last.day);
  await md.checkSessionClose('QQQUSDT');
  assert.equal(closes.length, 1, 'no duplicate / no off-hours recalculation');
});
