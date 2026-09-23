import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-test-'));
process.env.HIC_LOG_STDOUT = '0';

const { sma, atr, adx, priorHigh, priorLow, logMomentum } = await import('../server/indicators.js');
const { evaluate, stopDistancePct } = await import('../server/strategies.js');
const { floorToStep, BinanceError } = await import('../server/binance.js');
const { Store, DEFAULT_CONFIG } = await import('../server/store.js');
const { Logger } = await import('../server/logger.js');
const { Engine } = await import('../server/engine.js');

const DAY = 86_400_000;
const mk = (closes, spread = 0.01) => closes.map((c, i) => ({ t: i * DAY, o: c, h: c * (1 + spread), l: c * (1 - spread), c, v: 1 }));

test('sma / prior channel excludes current candle', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const c = mk([10, 11, 12, 20]);
  assert.equal(priorHigh(c, 3, 3), 12 * 1.01); // current candle (20) not included
  assert.equal(priorLow(c, 3, 3), 10 * 0.99);
  assert.equal(priorHigh(c, 2, 3), null);
});

test('log momentum = ln(c_t / c_{t-n})', () => {
  const c = mk([100, 105, 110, 121]);
  assert.ok(Math.abs(logMomentum(c, 3, 3) - Math.log(1.21)) < 1e-12);
});

test('ATR / ADX in trending market', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 2);
  const c = mk(closes);
  const a = atr(c, 14);
  assert.equal(a[13], null);
  assert.ok(a[79] > 0);
  const r = adx(c, 14);
  assert.ok(r.plusDI[79] > r.minusDI[79]);
  assert.ok(r.adx[79] > 25);
  assert.equal(r.adx[26], null);
  assert.ok(r.adx[27] != null);
});

test('Turtle long breakout / short needs SMA200 filter', () => {
  const cfg = structuredClone(DEFAULT_CONFIG.strategies.TURTLE);
  const base = Array.from({ length: 260 }, () => 100);
  let r = evaluate('TURTLE', mk([...base, 110]), cfg);
  assert.equal(r.longCond, true);
  assert.equal(r.shortCond, false);
  // breakdown while price above SMA200 -> no short
  const up = Array.from({ length: 260 }, (_, i) => 50 + i * 0.5);
  const upLast = up[up.length - 1];
  r = evaluate('TURTLE', mk([...up, ...Array(25).fill(upLast), upLast * 0.9]), cfg);
  assert.equal(r.shortCond, false, 'price above SMA200 must block short');
  // breakdown below SMA200 -> short
  const down = Array.from({ length: 260 }, (_, i) => 300 - i * 0.5);
  r = evaluate('TURTLE', mk([...down, down[259] * 0.9]), cfg);
  assert.equal(r.shortCond, true);
  assert.equal(r.longExit, true);
});

test('TSMOM long / cash', () => {
  const cfg = structuredClone(DEFAULT_CONFIG.strategies.TSMOM);
  let r = evaluate('TSMOM', mk(Array.from({ length: 40 }, (_, i) => 100 + i)), cfg);
  assert.equal(r.longCond, true);
  r = evaluate('TSMOM', mk(Array.from({ length: 40 }, (_, i) => 200 - i)), cfg);
  assert.equal(r.longCond, false);
  assert.equal(r.longExit, true);
  assert.equal(r.shortCond, false);
});

test('stop distance clamps to min/max', () => {
  const s = { mode: 'ATR_DYNAMIC', atrMult: 2, minPct: 8, maxPct: 18 };
  assert.equal(stopDistancePct(s, 1, 100), 8); // raw 2% -> 8
  assert.equal(stopDistancePct(s, 20, 100), 18); // raw 40% -> 18
  assert.equal(stopDistancePct(s, 5, 100), 10);
  assert.equal(stopDistancePct({ mode: 'OFF' }, 5, 100), null);
});

test('floorToStep never rounds up', () => {
  assert.equal(floorToStep(0.0049999, 0.001), 0.004);
  assert.equal(floorToStep(178.19, 0.1), 178.1);
  assert.equal(floorToStep(0.003, 0.001), 0.003);
});

// ---------- engine with fake market / exchange
function fakeMarket(price = 100) {
  const md = new EventEmitter();
  md.status = 'CONNECTED';
  md.s = {};
  md.filters = {};
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'XRPUSDT']) {
    md.s[sym] = { daily: mk(Array.from({ length: 300 }, (_, i) => 100 + i * 0.1)), last: price, lastTs: Date.now() };
    md.filters[sym] = { symbol: sym, status: 'TRADING', stepSize: 0.001, minQty: 0.001, maxQty: 1e6, minNotional: 5, tickSize: 0.01 };
  }
  md.price = (s) => md.s[s].last;
  md.isStale = () => false;
  return md;
}

function newEngine(mode = 'PAPER') {
  const store = new Store();
  store.state.modes.PAPER = { ...store.state.modes.PAPER, slots: {}, orders: [], trades: [], wallet: 10000, realizedTotal: 0, baseCapital: 10000 };
  store.state.modes.LIVE = { ...store.state.modes.LIVE, slots: {}, orders: [], trades: [], realizedTotal: 0 };
  store.config.general.mode = mode;
  store.state.runState = 'RUNNING';
  const log = new Logger(store);
  const logs = [];
  log.on('log', (e) => logs.push(e));
  const engine = new Engine(store, fakeMarket(), log);
  return { engine, store, logs };
}

test('paper: insufficient balance skips order (no size reduction)', async () => {
  const { engine, store, logs } = newEngine('PAPER');
  store.config.strategies.TURTLE.amounts.PAPER.long = 50000;
  const r = await engine.openPosition('TURTLE', 'BTCUSDT', 'LONG', { atr: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INSUFFICIENT_BALANCE');
  assert.equal(engine.slot('TURTLE', 'BTCUSDT').position, null);
  assert.ok(logs.some((l) => l.code === 'INSUFFICIENT_BALANCE'));
});

test('paper: open with stop, duplicate entry blocked, close records trade', async () => {
  const { engine } = newEngine('PAPER');
  assert.equal((await engine.openPosition('ADX', 'ETHUSDT', 'LONG', { atr: 2 })).ok, true);
  const pos = engine.slot('ADX', 'ETHUSDT').position;
  assert.ok(pos.stopPrice < pos.entryPrice);
  const dup = await engine.openPosition('ADX', 'ETHUSDT', 'LONG', { atr: 2 });
  assert.equal(dup.code, 'POSITION_EXISTS');
  // other strategy on same coin is allowed
  assert.equal((await engine.openPosition('TSMOM', 'ETHUSDT', 'LONG', { atr: 2 })).ok, true);
  assert.equal((await engine.closePosition('ADX', 'ETHUSDT', 'MANUAL_EXIT')).ok, true);
  const ms = engine.ms();
  assert.equal(ms.trades[0].exitReason, 'MANUAL_EXIT');
  assert.ok(ms.trades[0].fee > 0);
  assert.equal(engine.slot('ADX', 'ETHUSDT').block.LONG, true, 'ADX must re-arm after non-strategy exit');
});

test('live: unknown order result is never resent and is reconciled by clientOrderId', async () => {
  const { engine } = newEngine('LIVE');
  let sent = 0;
  let placed = null;
  engine.live = { ...engine.live, status: 'CONNECTED', hedgeMode: true, leverage: { BTCUSDT: 1, ETHUSDT: 1, XRPUSDT: 1 }, account: { equity: 1000, available: 1000 } };
  engine.liveClient = {
    hasKeys: () => true,
    account: async () => ({ totalMarginBalance: '1000', totalWalletBalance: '1000', availableBalance: '1000', totalUnrealizedProfit: '0', positions: [] }),
    newOrder: async (p) => { sent++; placed = p; throw new BinanceError('network error: timeout', { definitive: false }); },
    queryOrder: async (sym, id) => ({ status: 'FILLED', avgPrice: '100.5', executedQty: placed.quantity, orderId: 7, clientOrderId: id }),
    userTrades: async () => [{ commission: '0.05', commissionAsset: 'USDT' }],
  };
  const r = await engine.openPosition('TURTLE', 'BTCUSDT', 'LONG', { atr: 1 });
  assert.equal(r.code, 'ORDER_UNKNOWN');
  const slot = engine.slot('TURTLE', 'BTCUSDT');
  assert.equal(slot.status, 'UNKNOWN');
  const again = await engine.openPosition('TURTLE', 'BTCUSDT', 'LONG', { atr: 1 });
  assert.equal(again.ok, false);
  assert.equal(sent, 1, 'must not resend while result unknown');
  await engine.resolveUnknownOrders();
  assert.equal(slot.status, 'LONG');
  assert.equal(slot.position.entryPrice, 100.5);
  assert.equal(slot.position.entryFee, 0.05);
  assert.equal(placed.positionSide, 'LONG');
  assert.equal(placed.newClientOrderId, slot.position.clientOrderId);
});

test('live: definitive rejection frees the slot', async () => {
  const { engine } = newEngine('LIVE');
  engine.live = { ...engine.live, status: 'CONNECTED', hedgeMode: true, leverage: { BTCUSDT: 1, ETHUSDT: 1, XRPUSDT: 1 } };
  engine.liveClient = {
    hasKeys: () => true,
    account: async () => ({ totalMarginBalance: '1000', totalWalletBalance: '1000', availableBalance: '1000', totalUnrealizedProfit: '0', positions: [] }),
    newOrder: async () => { throw new BinanceError('HTTP 400 -2019 Margin is insufficient.', { code: -2019, status: 400, definitive: true }); },
  };
  const r = await engine.openPosition('ADX', 'XRPUSDT', 'LONG', { atr: 1 });
  assert.equal(r.code, 'ORDER_REJECTED');
  const slot = engine.slot('ADX', 'XRPUSDT');
  assert.equal(slot.status, 'FLAT');
  assert.equal(slot.pending, null);
});

test('emergency stop triggers ATR_STOP exit', async () => {
  const { engine } = newEngine('PAPER');
  await engine.openPosition('TURTLE', 'XRPUSDT', 'SHORT', { atr: 1 });
  const pos = engine.slot('TURTLE', 'XRPUSDT').position;
  engine.md.s.XRPUSDT.last = pos.stopPrice * 1.01;
  engine.lastTickCheck = {};
  engine.onPrice('XRPUSDT', pos.stopPrice * 1.01);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(engine.slot('TURTLE', 'XRPUSDT').position, null);
  assert.equal(engine.ms().trades[0].exitReason, 'ATR_STOP');
  assert.ok(engine.ms().trades[0].netPnl < 0);
});
