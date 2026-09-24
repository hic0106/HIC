// Regression tests: StrategyScheduler (candle-close evaluation), RiskMonitor (real-time stops), Portfolio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-sched-'));
process.env.HIC_LOG_STDOUT = '0';

const { Store } = await import('../server/store.js');
const { Logger } = await import('../server/logger.js');
const { Engine } = await import('../server/engine.js');
const { StrategyScheduler } = await import('../server/scheduler/strategyScheduler.js');
const { SignalLog } = await import('../server/scheduler/signalLog.js');
const { RiskMonitor } = await import('../server/risk/riskMonitor.js');
const { PortfolioService } = await import('../server/portfolio/portfolioService.js');
const { EquityHistory } = await import('../server/portfolio/equityHistory.js');
const { UserDataStream } = await import('../server/portfolio/userDataStream.js');
const { reconcilePositions } = await import('../server/portfolio/reconcile.js');
const { nextSessionClose, usSession } = await import('../server/session.js');
const { BinanceError } = await import('../server/binance.js');

const H4 = 4 * 3600_000, DAY = 86_400_000;
const SYMS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'QQQUSDT'];

// closed candles ending at lastClose (T = close time - 1 ms, Binance style)
function series(closes, len, lastClose, spread = 0.01) {
  const n = closes.length;
  return closes.map((c, i) => { const t = lastClose - (n - i) * len; return { t, o: c, h: c * (1 + spread), l: c * (1 - spread), c, v: 1, T: t + len - 1 }; });
}
const flat = (n, v = 100) => Array.from({ length: n }, () => v);

function fakeMarket(now = Date.now()) {
  const md = new EventEmitter();
  md.status = 'CONNECTED';
  md.s = {}; md.filters = {};
  const lastClose4h = Math.floor(now / H4) * H4; // just closed
  const lastClose1d = Math.floor(now / DAY) * DAY;
  for (const sym of SYMS) {
    md.s[sym] = {
      daily: series(flat(300), DAY, lastClose1d), bars: { '4h': series(flat(300), H4, lastClose4h) },
      last: 100, lastTs: now, mark: { price: 100 }, unavailable: null,
    };
    md.filters[sym] = { symbol: sym, status: 'TRADING', stepSize: 0.001, minQty: 0.001, maxQty: 1e6, minNotional: 5, tickSize: 0.01 };
  }
  md.s.QQQUSDT.daily = series(flat(200, 600), DAY, lastClose1d); // US session candles
  md.price = (s) => md.s[s].last;
  md.isStale = () => false;
  md.underlyingStatus = () => null;
  md.lastClose4h = lastClose4h; md.lastClose1d = lastClose1d;
  return md;
}

// append a closed 4h candle and emit its close event like marketData does
function close4h(md, sym, c) {
  const arr = md.s[sym].bars['4h'];
  const t = arr.at(-1).T + 1;
  arr.push({ t, o: c, h: c * 1.01, l: c * 0.99, c, v: 1, T: t + H4 - 1 });
  md.emit('candleClose', { symbol: sym, interval: '4h' });
}

function setup({ mode = 'PAPER', md = fakeMarket(), store = null } = {}) {
  store ||= new Store();
  store.state.modes.PAPER = { ...store.state.modes.PAPER, slots: {}, orders: [], trades: [], wallet: 10000, realizedTotal: 0, baseCapital: 10000, scheduler: {} };
  store.state.modes.LIVE = { ...store.state.modes.LIVE, slots: {}, orders: [], trades: [], realizedTotal: 0, scheduler: {} };
  store.config.general.mode = mode;
  store.state.runState = 'RUNNING';
  const log = new Logger(store);
  const logs = [];
  log.on('log', (e) => logs.push(e));
  const engine = new Engine(store, md, log);
  const calls = [];
  const orig = engine.evaluateSlot.bind(engine);
  engine.evaluateSlot = (st, sym, trig, opts) => { calls.push(`${st}:${sym}`); return orig(st, sym, trig, opts); };
  const signalLog = new SignalLog({ persist: false });
  const sch = new StrategyScheduler({ store, md, engine, log, signalLog, symbols: SYMS });
  md.on('candleClose', ({ symbol, interval }) => sch.onCandleClose(symbol, interval));
  return { store, md, engine, sch, calls, logs, signalLog, log };
}
const count = (calls, k) => calls.filter((x) => x === k).length;
const orders = (engine, st, sym) => engine.ms().orders.filter((o) => o.strategy === st && o.symbol === sym && o.action === 'OPEN');

test('scheduler: Turtle evaluated exactly once per 4h candle, not on 1d closes; entry on 4h breakout', async () => {
  const { md, engine, sch, calls } = setup();
  await sch.catchUp('bot start'); // evaluates the latest closed 4h candle once
  assert.equal(count(calls, 'TURTLE:BTCUSDT'), 1);
  await sch.catchUp('again'); await sch.tick();
  assert.equal(count(calls, 'TURTLE:BTCUSDT'), 1, 'same candle never re-evaluated');
  md.emit('candleClose', { symbol: 'BTCUSDT', interval: '1d' });
  await new Promise((r) => setImmediate(r));
  assert.equal(count(calls, 'TURTLE:BTCUSDT'), 1, 'daily close does not evaluate a 4h strategy');
  close4h(md, 'BTCUSDT', 110); // breakout above prior 20 x 4h high
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(count(calls, 'TURTLE:BTCUSDT'), 2);
  assert.equal(orders(engine, 'TURTLE', 'BTCUSDT').length, 1);
  assert.equal(engine.slot('TURTLE', 'BTCUSDT').position.side, 'LONG');
  // duplicate close event of the same candle -> no second evaluation / order
  md.emit('candleClose', { symbol: 'BTCUSDT', interval: '4h' });
  await sch.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(count(calls, 'TURTLE:BTCUSDT'), 2);
  assert.equal(orders(engine, 'TURTLE', 'BTCUSDT').length, 1, 'no duplicate order per candle');
});

test('scheduler: ADX evaluated on 4h closes only', async () => {
  const { md, sch, calls } = setup();
  await sch.catchUp('start');
  assert.equal(count(calls, 'ADX:ETHUSDT'), 1);
  md.emit('candleClose', { symbol: 'ETHUSDT', interval: '1d' });
  close4h(md, 'ETHUSDT', 100);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(count(calls, 'ADX:ETHUSDT'), 2);
  // close event lost (ws gap): the fallback tick evaluates the new closed candle once
  const arr = md.s.ETHUSDT.bars['4h']; const t = arr.at(-1).T + 1;
  arr.push({ t, o: 100.5, h: 101, l: 100, c: 100.5, v: 1, T: t + H4 - 1 });
  await sch.tick(); await sch.tick();
  assert.equal(count(calls, 'ADX:ETHUSDT'), 3);
  const row = sch.snapshot().find((r) => r.key === 'ADX:ETHUSDT:4h');
  assert.equal(row.timeframe, '4h');
  assert.ok(row.nextExpectedCandle > Date.now());
  assert.equal((row.nextExpectedCandle - row.lastClosedCandle) % H4, 0, 'next candle on the 4h grid');
  assert.equal(row.lastEvaluatedCandle, row.lastClosedCandle);
});

test('scheduler: TSMOM stays daily (once per 1d close, 4h closes ignored)', async () => {
  const { md, sch, calls } = setup();
  await sch.catchUp('start');
  assert.equal(count(calls, 'TSMOM:XRPUSDT'), 1);
  close4h(md, 'XRPUSDT', 100);
  close4h(md, 'XRPUSDT', 100);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(count(calls, 'TSMOM:XRPUSDT'), 1);
  const d = md.s.XRPUSDT.daily;
  const t = d.at(-1).T + 1;
  d.push({ t, o: 101, h: 102, l: 100, c: 101, v: 1, T: t + DAY - 1 });
  md.emit('candleClose', { symbol: 'XRPUSDT', interval: '1d' });
  md.emit('candleClose', { symbol: 'XRPUSDT', interval: '1d' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(count(calls, 'TSMOM:XRPUSDT'), 2);
});

test('scheduler: QQQ strategies only on US session close; off-hours price / 24h candles never recompute', async () => {
  const { md, sch, calls } = setup();
  await sch.catchUp('start');
  const n0 = count(calls, 'QQQ_EMA_TREND:QQQUSDT');
  assert.equal(n0, 1);
  for (let i = 0; i < 50; i++) md.emit('price', { symbol: 'QQQUSDT', price: 600 + i });
  md.emit('candleClose', { symbol: 'QQQUSDT', interval: '4h' });
  md.emit('candleClose', { symbol: 'QQQUSDT', interval: '1d' });
  await sch.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(count(calls, 'QQQ_EMA_TREND:QQQUSDT'), n0);
  const d = md.s.QQQUSDT.daily;
  const t = d.at(-1).T + DAY;
  d.push({ t: t - 6.5 * 3600_000, o: 600, h: 601, l: 599, c: 600, v: 1, T: t });
  md.emit('candleClose', { symbol: 'QQQUSDT', interval: 'US_SESSION' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(count(calls, 'QQQ_EMA_TREND:QQQUSDT'), n0 + 1);
  const row = sch.snapshot().find((r) => r.strategy === 'QQQ_EMA_TREND');
  assert.equal(row.scheduleType, 'US_MARKET_CLOSE');
  assert.ok(['OPEN', 'CLOSED'].includes(row.market));
});

test('session: next US close follows America/New_York DST and holidays', () => {
  const cal = new Store().config.general.usCalendar;
  // winter (EST, UTC-5): 16:00 ET = 21:00 UTC; summer (EDT, UTC-4): 20:00 UTC
  assert.equal(new Date(nextSessionClose(Date.UTC(2026, 0, 6, 12), cal).close).toISOString(), '2026-01-06T21:00:00.000Z');
  assert.equal(new Date(nextSessionClose(Date.UTC(2026, 6, 7, 12), cal).close).toISOString(), '2026-07-07T20:00:00.000Z');
  // Thanksgiving 2026-11-26 closed -> next is the 13:00 ET early close on 11-27 (18:00 UTC)
  assert.equal(usSession('2026-11-26', cal), null);
  assert.equal(new Date(nextSessionClose(Date.UTC(2026, 10, 26, 12), cal).close).toISOString(), '2026-11-27T18:00:00.000Z');
});

test('risk monitor: ATR stop fires on a price tick without any candle close', async () => {
  const { md, engine } = setup();
  const risk = new RiskMonitor({ engine, md, log: engine.log });
  risk.start();
  await engine.openPosition('TURTLE', 'ETHUSDT', 'LONG', { atr: 1 });
  const pos = engine.slot('TURTLE', 'ETHUSDT').position;
  let closes = 0;
  md.on('candleClose', () => closes++);
  md.s.ETHUSDT.last = pos.stopPrice * 0.99;
  md.emit('price', { symbol: 'ETHUSDT', price: pos.stopPrice * 0.99 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closes, 0);
  assert.equal(engine.slot('TURTLE', 'ETHUSDT').position, null);
  assert.equal(engine.ms().trades[0].exitReason, 'ATR_STOP');
  risk.stop();
});

test('scheduler: last evaluated candle persists across restart; no re-evaluation / re-order', async () => {
  const md = fakeMarket();
  const a = setup({ md });
  close4h(md, 'BTCUSDT', 110);
  await new Promise((r) => setTimeout(r, 10));
  await a.sch.catchUp('start');
  assert.equal(orders(a.engine, 'TURTLE', 'BTCUSDT').length, 1);
  const key = 'TURTLE:BTCUSDT:4h';
  const saved = a.store.state.modes.PAPER.scheduler[key].lastEvaluatedCandle;
  assert.equal(saved, md.s.BTCUSDT.bars['4h'].at(-1).T);
  // "restart": a new Store reads state.json from disk
  const store2 = new Store();
  assert.equal(store2.state.runState, 'STOPPED', 'always STOPPED after restart');
  assert.equal(store2.state.modes.PAPER.scheduler[key].lastEvaluatedCandle, saved);
  store2.state.runState = 'RUNNING';
  const log2 = new Logger(store2);
  const e2 = new Engine(store2, md, log2);
  const calls = [];
  const orig = e2.evaluateSlot.bind(e2);
  e2.evaluateSlot = (st, sym, t, o) => { calls.push(`${st}:${sym}`); return orig(st, sym, t, o); };
  const s2 = new StrategyScheduler({ store: store2, md, engine: e2, log: log2, signalLog: new SignalLog({ persist: false }), symbols: SYMS });
  const r = await s2.run(s2.instances().find((i) => i.key === key), 'bot start');
  assert.equal(r.result, 'DUPLICATE');
  assert.equal(count(calls, 'TURTLE:BTCUSDT'), 0);
  assert.equal(e2.ms().orders.filter((o) => o.strategy === 'TURTLE' && o.symbol === 'BTCUSDT' && o.action === 'OPEN').length, 1);
});

test('scheduler: restart catch-up skips stale entries but still executes exits', async () => {
  const now = Date.now();
  const md = fakeMarket(now);
  // latest 4h candle closed 3h ago (grace 30m) with a breakout
  const lastClose = now - 3 * 3600_000;
  md.s.BTCUSDT.bars['4h'] = series([...flat(299), 110], H4, lastClose);
  md.s.ETHUSDT.bars['4h'] = series([...flat(299), 80], H4, lastClose); // breakdown -> long exit
  const { engine, sch, logs, signalLog } = setup({ md });
  await engine.openPosition('TURTLE', 'ETHUSDT', 'LONG', { atr: 1 });
  md.s.ETHUSDT.last = 99; // keep emergency stop out of the way
  await sch.catchUp('bot start');
  assert.equal(orders(engine, 'TURTLE', 'BTCUSDT').length, 0, 'stale breakout not chased');
  assert.ok(logs.some((l) => l.code === 'STALE_SIGNAL_SKIPPED'));
  assert.equal(engine.slot('TURTLE', 'ETHUSDT').position, null, 'exit still executed');
  const rec = signalLog.recent().find((x) => x.strategy === 'TURTLE' && x.symbol === 'BTCUSDT');
  assert.match(rec.result, /STALE_ENTRY_SKIPPED LONG/);
  assert.equal(rec.stale, true);
});

test('signal log: every evaluation recorded, also HOLD', async () => {
  const { sch, signalLog } = setup();
  await sch.catchUp('start');
  const r = signalLog.recent().find((x) => x.strategy === 'TURTLE' && x.symbol === 'XRPUSDT');
  assert.equal(r.result, 'HOLD');
  assert.match(r.msg, /^TURTLE XRPUSDT 4H Candle Closed .*20H Breakout=False .*10L Exit=False .*Result=HOLD$/);
});

// ---------- portfolio
function liveSetup({ exQty = 0.008 } = {}) {
  const ctx = setup({ mode: 'LIVE' });
  const { engine } = ctx;
  engine.live = { ...engine.live, status: 'CONNECTED', hedgeMode: true, leverage: { BTCUSDT: 1, ETHUSDT: 1, XRPUSDT: 1, QQQUSDT: 1 } };
  const ex = { qty: exQty };
  engine.liveClient = {
    hasKeys: () => true,
    account: async () => ({ totalWalletBalance: '1000', totalMarginBalance: '1003.5', availableBalance: '995.2', totalUnrealizedProfit: '3.5', positions: [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: String(ex.qty) }] }),
    positionRisk: async () => [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: String(ex.qty), entryPrice: '100', markPrice: '100.5', unRealizedProfit: '3.5', liquidationPrice: '0', notional: String(ex.qty * 100.5), initialMargin: String(ex.qty * 100.5) }],
    income: async () => [{ symbol: 'BTCUSDT', incomeType: 'COMMISSION', income: '-0.4', asset: 'USDT', time: Date.now() - 1000, tranId: 1 }],
  };
  // internal ledger: one Turtle BTC long 0.008
  engine.slot('TURTLE', 'BTCUSDT').position = { strategy: 'TURTLE', symbol: 'BTCUSDT', side: 'LONG', entryPrice: 100, qty: 0.008, orderAmount: 0.8, entryNotional: 0.8, entryFee: 0.0004, funding: 0, entryTime: Date.now() - 60_000, stopPrice: 90, leverage: 1, ctrlMultiplier: 1 };
  engine.slot('TURTLE', 'BTCUSDT').status = 'LONG';
  let t = Date.now();
  const pf = new PortfolioService({ store: ctx.store, engine, md: ctx.md, log: engine.log, history: new EquityHistory({ persist: false }), userStream: new EventEmitter(), now: () => t });
  return { ...ctx, pf, ex, advance: (ms) => { t += ms; } };
}

test('portfolio: summary equals Binance account (exchange = truth source)', async () => {
  const { pf } = liveSetup();
  await pf.refreshExchange('test');
  await pf.refreshIncome();
  const p = pf.build();
  assert.equal(p.summary.equity, 1003.5);
  assert.equal(p.summary.available, 995.2);
  assert.equal(p.summary.wallet, 1000);
  assert.equal(p.summary.unrealized, 3.5);
  assert.equal(p.exchange.positions[0].qty, 0.008);
  assert.equal(p.reconciliation.ok, true);
  assert.equal(p.summary.realizedTodaySource, 'BINANCE_INCOME');
  assert.equal(p.summary.realizedToday, -0.4);
  assert.equal(p.strategyView.find((s) => s.strategy === 'TURTLE').positions, 1);
  assert.ok(p.allocation.bySymbol.find((a) => a.symbol === 'BTCUSDT').margin > 0);
});

test('portfolio: position mismatch is reported (never hidden) and shown as UNATTRIBUTED', async () => {
  const { pf, advance } = liveSetup({ exQty: 0.010 });
  await pf.refreshExchange('t');
  assert.equal(pf.recon.ok, true, 'first sighting only SYNCING');
  advance(6000);
  pf.reconcile();
  const p = pf.build();
  assert.equal(p.reconciliation.ok, false);
  assert.deepEqual(p.reconciliation.warnings, ['BTC LONG Exchange Qty 0.01 Internal 0.008 Diff +0.002']);
  const un = p.positions.find((r) => r.strategy === 'UNATTRIBUTED');
  assert.equal(un.qty, 0.002);
  assert.equal(p.positions.find((r) => r.strategy === 'TURTLE').qty, 0.008, 'ledger not modified');
});

test('portfolio: user data stream ACCOUNT_UPDATE updates balance / positions between snapshots', async () => {
  const { pf, engine } = liveSetup();
  await pf.refreshExchange('t');
  pf.applyAccountUpdate({ m: 'ORDER', B: [{ a: 'USDT', wb: '990', cw: '990' }], P: [{ s: 'BTCUSDT', pa: '0', ep: '0', up: '0', ps: 'LONG' }] });
  assert.equal(pf.exchange.wallet, 990);
  assert.equal(pf.exchange.positions.length, 0);
  assert.equal(pf.exchange.source, 'WS');
  assert.equal(engine.live.exchangePositions.find((x) => x.symbol === 'BTCUSDT').positionAmt, '0');
  // stream message wrapper {stream, data}
  const uds = new UserDataStream({ getClient: () => ({}), wsBase: 'ws://x', log: engine.log });
  const got = [];
  uds.on('account', (a) => got.push(a));
  uds.onMessage({ stream: 'key', data: { e: 'ACCOUNT_UPDATE', E: 1, T: 1, a: { m: 'FUNDING_FEE', B: [], P: [] } } });
  assert.equal(got[0].m, 'FUNDING_FEE');
});

test('portfolio: PAPER mode uses the simulated account; LIVE uses the exchange', async () => {
  const { engine, store, md } = setup({ mode: 'PAPER' });
  await engine.openPosition('ADX', 'BTCUSDT', 'LONG', { atr: 1 });
  const pf = new PortfolioService({ store, engine, md, log: engine.log, history: new EquityHistory({ persist: false }), userStream: new EventEmitter() });
  const p = pf.build();
  const pa = engine.paperAccount();
  assert.equal(p.mode, 'PAPER');
  assert.equal(p.summary.equity, pa.equity);
  assert.equal(p.exchange.live, false);
  assert.equal(p.reconciliation.na, 'PAPER');
  assert.equal(p.positions.length, 1);
  pf.recordEquity(true);
  assert.equal(pf.equitySeries('1D').points.length, 1);
  const l = liveSetup();
  await l.pf.refreshExchange('t');
  assert.equal(l.pf.build().exchange.live, true);
});

test('reconcile: pending order marks SYNCING instead of MISMATCH', () => {
  const r = reconcilePositions({ slots: { a: { symbol: 'BTCUSDT', pending: { action: 'OPEN' }, position: null } }, exchange: [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0.01' }], filters: { BTCUSDT: { stepSize: 0.001 } }, symbols: ['BTCUSDT'] });
  assert.equal(r.rows[0].status, 'SYNCING');
  assert.equal(r.ok, true);
});

test('live: scheduler entry with unknown order result is never resent on retry', async () => {
  const { md, engine, sch } = liveSetup();
  let sent = 0;
  engine.slot('TURTLE', 'BTCUSDT').position = null; engine.slot('TURTLE', 'BTCUSDT').status = 'FLAT';
  engine.liveClient.newOrder = async () => { sent++; throw new BinanceError('network error: timeout', { definitive: false }); };
  engine.liveClient.queryOrder = async () => { throw new BinanceError('HTTP 400 -2013', { code: -2013, status: 400, definitive: true }); };
  close4h(md, 'BTCUSDT', 110);
  await new Promise((r) => setTimeout(r, 10));
  await sch.tick(); await sch.tick();
  assert.equal(sent, 1);
});

test('scheduler: evaluations are serialized — two strategies never run their entry checks at the same time', async () => {
  const { md, engine, sch } = setup();
  let active = 0, maxActive = 0;
  const orig = engine.evaluateSlot;
  engine.evaluateSlot = async (...a) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 5)); try { return await orig(...a); } finally { active--; } };
  close4h(md, 'BTCUSDT', 110); // TURTLE + ADX on BTC 4h close together
  await sch.catchUp('bot start');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(maxActive, 1);
});

test('market data: resync after a long outage fills every missed 4h candle (no holes)', async () => {
  const { MarketData } = await import('../server/marketData.js');
  const log = new Logger(new Store());
  const md = new MarketData(['BTCUSDT'], log);
  const now = Date.now();
  const last = Math.floor(now / H4) * H4 - 7 * H4; // 6 closed candles missed + 1 forming
  md.s.BTCUSDT.bars['4h'] = series(flat(10), H4, last + H4);
  const stored = md.s.BTCUSDT.bars['4h'];
  md.rest = { publicGet: async (p, q) => { const out = []; for (let t = Math.ceil(q.startTime / H4) * H4; t < now; t += H4) out.push([t, 100, 101, 99, 100, 1, t + H4 - 1]); return out; } };
  const closes = [];
  md.on('candleClose', (e) => closes.push(e));
  await md.resyncBars('BTCUSDT', '4h', 'test');
  const arr = md.s.BTCUSDT.bars['4h'];
  for (let i = 1; i < arr.length; i++) assert.equal(arr[i].t, arr[i - 1].T + 1, 'contiguous');
  assert.equal(arr.at(-1).T + 1, Math.floor(now / H4) * H4, 'up to the last closed candle');
  assert.ok(closes.length >= 6);
  assert.equal(stored, arr);
});

test('user data stream: stop() during the listenKey request opens no socket', async () => {
  let resolveKey;
  const opened = [];
  class FakeWS { constructor(u) { opened.push(u); this.h = {}; } on(e, f) { this.h[e] = f; } close() {} }
  const uds = new UserDataStream({ getClient: () => ({ startUserStream: () => new Promise((r) => { resolveKey = r; }), closeUserStream: async () => {} }), wsBase: 'ws://x', log: new Logger(new Store()), WebSocketImpl: FakeWS });
  uds.start();
  await new Promise((r) => setImmediate(r));
  await uds.stop();
  resolveKey({ listenKey: 'k1' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(opened.length, 0);
  assert.equal(uds.ws, null);
});

test('portfolio: income rows sharing the last timestamp are not skipped', async () => {
  const { pf, engine } = liveSetup();
  const T = Date.now() - 60_000;
  const all = [{ symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income: '2', asset: 'USDT', time: T, tranId: 1 }];
  engine.liveClient.income = async ({ startTime }) => all.filter((r) => r.time >= startTime);
  await pf.refreshIncome();
  all.push({ symbol: 'BTCUSDT', incomeType: 'COMMISSION', income: '-0.1', asset: 'USDT', time: T, tranId: 2 }); // same ms, arrives later
  await pf.refreshIncome();
  const inc = pf.history.m('LIVE').income;
  assert.equal(inc.length, 2);
  assert.equal(inc.filter((r) => r.tranId === '1').length, 1, 'no duplicates');
});
