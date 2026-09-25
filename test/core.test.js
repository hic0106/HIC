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

// ---------- exchange-side stops (Binance Algo STOP_MARKET)
function liveEngineWithExchange() {
  const { engine } = newEngine('LIVE');
  engine.live = { ...engine.live, status: 'CONNECTED', hedgeMode: true, leverage: { BTCUSDT: 1, ETHUSDT: 1, XRPUSDT: 1 } };
  const ex = { calls: [], algos: {}, orders: {}, exQty: {} };
  let oid = 1;
  engine.liveClient = {
    hasKeys: () => true,
    account: async () => ({ totalMarginBalance: '1000', totalWalletBalance: '1000', availableBalance: '1000', totalUnrealizedProfit: '0',
      positions: Object.entries(ex.exQty).map(([k, q]) => ({ symbol: k.split(':')[0], positionSide: k.split(':')[1], positionAmt: String(q) })) }),
    newOrder: async (p) => {
      ex.calls.push(['order', p]);
      const o = { status: 'FILLED', avgPrice: '100', executedQty: p.quantity, orderId: oid++, clientOrderId: p.newClientOrderId };
      ex.orders[p.newClientOrderId] = o;
      const k = `${p.symbol}:${p.positionSide}`;
      const opening = (p.side === 'BUY') === (p.positionSide === 'LONG');
      ex.exQty[k] = (ex.exQty[k] || 0) + (opening ? 1 : -1) * Number(p.quantity);
      return o;
    },
    queryOrder: async (sym, id) => { if (ex.orders[id]) return ex.orders[id]; throw new BinanceError('HTTP 400 -2013', { code: -2013, status: 400, definitive: true }); },
    userTrades: async () => [],
    newAlgoOrder: async (p) => { ex.calls.push(['algo', p]); ex.algos[p.clientAlgoId] = { ...p, algoId: oid++, algoStatus: 'NEW' }; return ex.algos[p.clientAlgoId]; },
    cancelAlgoOrder: async (id) => {
      ex.calls.push(['cancel', id]);
      if (ex.algos[id]?.algoStatus !== 'NEW') throw new BinanceError('HTTP 400 -2011 Unknown order sent.', { code: -2011, status: 400, definitive: true });
      ex.algos[id].algoStatus = 'CANCELED';
      return { code: '200' };
    },
    openAlgoOrders: async (sym) => Object.values(ex.algos).filter((a) => a.symbol === sym && a.algoStatus === 'NEW'),
  };
  // simulate Binance triggering a stop: algo finishes and a regular order with the same client id is filled
  ex.trigger = (id, price = '90') => {
    const a = ex.algos[id];
    a.algoStatus = 'FINISHED';
    ex.orders[id] = { status: 'FILLED', avgPrice: price, executedQty: a.quantity, orderId: oid++, clientOrderId: id };
    ex.exQty[`${a.symbol}:${a.positionSide}`] -= Number(a.quantity);
  };
  return { engine, ex };
}

test('live: entry places Binance STOP_MARKET with hedge positionSide', async () => {
  const { engine, ex } = liveEngineWithExchange();
  assert.equal((await engine.openPosition('TURTLE', 'BTCUSDT', 'LONG', { atr: 1 })).ok, true);
  const pos = engine.slot('TURTLE', 'BTCUSDT').position;
  const algo = ex.calls.find((c) => c[0] === 'algo')[1];
  assert.equal(algo.type, 'STOP_MARKET');
  assert.equal(algo.side, 'SELL');
  assert.equal(algo.positionSide, 'LONG');
  assert.equal(Number(algo.triggerPrice), pos.stopPrice);
  assert.equal(algo.reduceOnly, undefined, 'reduceOnly cannot be sent in hedge mode');
  assert.equal(pos.exStop.status, 'NEW');
});

test('live: bot close cancels Binance stop before market order', async () => {
  const { engine, ex } = liveEngineWithExchange();
  await engine.openPosition('ADX', 'ETHUSDT', 'SHORT', { atr: 1 });
  assert.equal((await engine.closePosition('ADX', 'ETHUSDT', 'STRATEGY_EXIT')).ok, true);
  const kinds = ex.calls.map((c) => c[0]);
  assert.deepEqual(kinds, ['order', 'algo', 'cancel', 'order']);
  assert.equal(engine.ms().trades[0].exitReason, 'STRATEGY_EXIT');
});

test('live: stop filled on Binance while bot was away is recorded, not re-closed', async () => {
  const { engine, ex } = liveEngineWithExchange();
  await engine.openPosition('TSMOM', 'XRPUSDT', 'LONG', { atr: 1 });
  const id = engine.slot('TSMOM', 'XRPUSDT').position.exStop.clientAlgoId;
  ex.trigger(id, '85');
  await engine.refreshLiveAccount();
  await engine.syncExchangeStops();
  const slot = engine.slot('TSMOM', 'XRPUSDT');
  assert.equal(slot.position, null);
  const t = engine.ms().trades[0];
  assert.equal(t.exitReason, 'ATR_STOP');
  assert.equal(t.exitPrice, 85);
  assert.equal(ex.calls.filter((c) => c[0] === 'order').length, 1, 'no extra market close');
  assert.equal(slot.block.LONG, true);
});

test('live: close racing a triggered stop records the stop fill only', async () => {
  const { engine, ex } = liveEngineWithExchange();
  await engine.openPosition('TURTLE', 'ETHUSDT', 'LONG', { atr: 1 });
  ex.trigger(engine.slot('TURTLE', 'ETHUSDT').position.exStop.clientAlgoId, '88');
  const r = await engine.closePosition('TURTLE', 'ETHUSDT', 'MANUAL_EXIT');
  assert.equal(r.ok, true);
  assert.equal(engine.ms().trades[0].exitReason, 'ATR_STOP');
  assert.equal(ex.calls.filter((c) => c[0] === 'order').length, 1);
});

test('live: missing Binance stop is re-placed only if exchange holds the position', async () => {
  const { engine, ex } = liveEngineWithExchange();
  await engine.openPosition('ADX', 'BTCUSDT', 'LONG', { atr: 1 });
  const first = engine.slot('ADX', 'BTCUSDT').position.exStop.clientAlgoId;
  ex.algos[first].algoStatus = 'CANCELED'; // e.g. canceled manually in the Binance app
  await engine.refreshLiveAccount();
  await engine.syncExchangeStops();
  await engine.syncExchangeStops();
  const pos = engine.slot('ADX', 'BTCUSDT').position;
  assert.notEqual(pos.exStop.clientAlgoId, first);
  assert.equal(pos.exStop.status, 'NEW');
  // exchange position gone (closed manually) -> do not place
  ex.algos[pos.exStop.clientAlgoId].algoStatus = 'CANCELED';
  ex.exQty['BTCUSDT:LONG'] = 0;
  await engine.refreshLiveAccount();
  const before = ex.calls.filter((c) => c[0] === 'algo').length;
  await engine.syncExchangeStops();
  await engine.syncExchangeStops();
  assert.equal(ex.calls.filter((c) => c[0] === 'algo').length, before);
});

test('binance client: -1021 timestamp ahead -> time re-sync and one retry; timestamp signed with offset', async () => {
  const { BinanceClient } = await import('../server/binance.js');
  const c = new BinanceClient({ restBase: 'http://x', apiKey: 'k', apiSecret: 's' });
  let serverSkew = -3000; // PC clock 3 s ahead of Binance
  let syncs = 0, calls = 0;
  c.publicGet = async (p) => { if (p === '/fapi/v1/time') { syncs++; return { serverTime: Date.now() + serverSkew }; } return {}; };
  c._fetch = async (method, url) => {
    calls++;
    const ts = Number(new URL(url).searchParams.get('timestamp'));
    const server = Date.now() + serverSkew;
    if (ts > server + 1000) throw new BinanceError('HTTP 400 -1021 Timestamp for this request was 1000ms ahead of the server\'s time.', { code: -1021, status: 400, definitive: true });
    return { ok: true };
  };
  c.timeSyncedAt = Date.now(); c.timeOffset = 0; // stale offset from before the drift
  assert.deepEqual(await c.signed('GET', '/fapi/v3/account'), { ok: true });
  assert.equal(syncs, 1);
  assert.equal(calls, 2);
  // other errors are not retried
  c._fetch = async () => { calls++; throw new BinanceError('HTTP 400 -2019 Margin is insufficient.', { code: -2019, status: 400, definitive: true }); };
  calls = 0;
  await assert.rejects(c.signed('POST', '/fapi/v1/order', {}), /-2019/);
  assert.equal(calls, 1);
});

test('binance client: wallet balance of all wallets is a signed read on the spot API base (USDT quote)', async () => {
  const { BinanceClient } = await import('../server/binance.js');
  const c = new BinanceClient({ restBase: 'http://fapi', spotBase: 'http://spot', apiKey: 'k', apiSecret: 's' });
  c.timeSyncedAt = Date.now();
  let url = null;
  c._fetch = async (m, u) => { url = new URL(u); return [{ walletName: 'Spot', balance: '1' }]; };
  await c.walletBalance();
  assert.equal(url.origin, 'http://spot');
  assert.equal(url.pathname, '/sapi/v1/asset/wallet/balance');
  assert.equal(url.searchParams.get('quoteAsset'), 'USDT');
  assert.ok(url.searchParams.get('signature'));
  await assert.rejects(new BinanceClient({ restBase: 'x', apiKey: 'k', apiSecret: 's' }).walletBalance(), /not available/);
});
