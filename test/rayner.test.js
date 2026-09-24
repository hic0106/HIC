import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-rayner-'));
process.env.HIC_LOG_STDOUT = '0';

const { macd, ema } = await import('../server/indicators.js');
const { evaluate, exitFor, entryStop, trendCounts, recordTrendEntry } = await import('../server/strategies.js');
const { Store, DEFAULT_CONFIG } = await import('../server/store.js');
const { Logger } = await import('../server/logger.js');
const { Engine } = await import('../server/engine.js');
const { backtestStrategy } = await import('../server/backtest/backtester.js');
const { validateStrategySettings } = await import('../server/strategyConfig.js');

const H4 = 4 * 3600_000;
const bars = (closes) => closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { t: i * H4, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1, T: (i + 1) * H4 - 1 }; });
const cfg = () => structuredClone(DEFAULT_CONFIG.strategies.RAYNER);
const up = Array.from({ length: 200 }, (_, i) => 100 * 1.002 ** i);
const dn = Array.from({ length: 200 }, (_, i) => 100 * 0.998 ** i);
const extend = (arr, n, f) => { const a = [...arr]; for (let k = 0; k < n; k++) a.push(a.at(-1) * f); return a; };
const A = [...up, up.at(-1) * 1.03]; // uptrend + momentum burst on the last candle
const B = [...extend(A, 40, 1.002)]; B.push(B.at(-1) * 1.03);
const C = [...extend(B, 40, 1.002)]; C.push(C.at(-1) * 1.03);

test('MACD(1,50,9) histogram = (close - EMA50) - EMA9(close - EMA50)', () => {
  const closes = Array.from({ length: 150 }, (_, i) => 100 + 10 * Math.sin(i / 7) + i * 0.3);
  const r = macd(closes, 1, 50, 9);
  // independent reference
  const e50 = ema(closes, 50);
  const line = closes.map((c, i) => (e50[i] == null ? null : c - e50[i]));
  const k = 2 / 10;
  let sig = null;
  const first = 49;
  for (let i = first; i < closes.length; i++) {
    if (i < first + 8) continue;
    if (i === first + 8) sig = line.slice(first, first + 9).reduce((a, x) => a + x, 0) / 9;
    else sig = line[i] * k + sig * (1 - k);
    assert.ok(Math.abs(r.hist[i] - (line[i] - sig)) < 1e-9, `hist mismatch at ${i}`);
  }
  assert.equal(r.hist[first + 7], null, 'no histogram before the signal EMA is seeded');
  assert.deepEqual(ema([1, 2, 3], 1), [1, 2, 3], 'EMA(1) = the value itself');
});

test('Rayner long: rising EMA50 + positive histogram acceleration', () => {
  const r = evaluate('RAYNER', bars(A), cfg());
  assert.equal(r.ready, true);
  assert.equal(r.longCond, true);
  assert.equal(r.shortCond, false);
  assert.ok(r.close > r.view.ema && r.view.ema > r.view.emaRef);
  assert.ok(r.hist > 0);
  // no burst -> no signal (histogram does not exceed 1.5 × prior max)
  assert.equal(evaluate('RAYNER', bars(extend(up, 1, 1.002)), cfg()).longCond, false);
});

test('Rayner short: falling EMA50 + negative histogram acceleration (mirror, negative comparison direction)', () => {
  const r = evaluate('RAYNER', bars([...dn, dn.at(-1) * 0.97]), cfg());
  assert.equal(r.shortCond, true);
  assert.equal(r.longCond, false);
  assert.ok(r.hist < 0);
  // histogram negative, trend down, but not below min(prior 3) × 1.5 (prior bars were MORE negative) -> no short
  const W = [...dn, dn.at(-1) * 0.94]; W.push(W.at(-1) * 0.999); W.push(W.at(-1) * 0.985);
  const w = evaluate('RAYNER', bars(W), cfg());
  assert.ok(w.hist < 0 && w.close < w.view.ema && w.view.ema < w.view.emaRef, 'fixture: bearish context');
  const prevMin = w.view.shortTarget; // most negative recent histogram (<= prior 3)
  assert.ok(w.hist > prevMin * 1.5);
  assert.equal(w.shortCond, false);
  // burst up inside a downtrend never gives a short (or a long: EMA falling)
  const u = evaluate('RAYNER', bars([...dn, dn.at(-1) * 1.03]), cfg());
  assert.equal(u.shortCond, false);
  assert.equal(u.longCond, false);
});

test('Rayner structure stop: lowest low / highest high of the last 10 closed candles (signal candle included)', () => {
  const b = bars(A);
  const r = evaluate('RAYNER', b, cfg());
  const last10 = b.slice(-10);
  assert.equal(r.structStop.LONG, Math.min(...last10.map((x) => x.l)));
  assert.equal(r.structStop.SHORT, Math.max(...last10.map((x) => x.h)));
  const s = entryStop(cfg().stop, r, 'LONG', r.close);
  assert.equal(s.invalid, false);
  assert.equal(s.stopPrice, r.structStop.LONG);
  // stop at / above the fill -> entry cancelled
  assert.equal(entryStop(cfg().stop, r, 'LONG', r.structStop.LONG).invalid, true);
  assert.equal(entryStop(cfg().stop, r, 'SHORT', r.structStop.SHORT * 1.01).invalid, true);
});

test('Rayner histogram target is the 25-bar extreme at entry and exits as RAYNER_HIST_TP', () => {
  const r = evaluate('RAYNER', bars(A), cfg());
  const b = bars(A).map((x) => x.c);
  const H = macd(b, 1, 50, 9).hist.slice(-25);
  assert.equal(r.histTarget.LONG, Math.max(...H));
  assert.equal(r.histTarget.SHORT, Math.min(...H));
  const pos = { side: 'LONG', histTarget: r.histTarget.LONG };
  assert.deepEqual(exitFor('RAYNER', { hist: pos.histTarget * 1.01, longExit: false }, pos), { exit: true, reason: 'RAYNER_HIST_TP' });
  assert.deepEqual(exitFor('RAYNER', { hist: pos.histTarget * 0.5, longExit: false }, pos), { exit: false, reason: 'STRATEGY_EXIT' });
  assert.deepEqual(exitFor('RAYNER', { hist: -1, longExit: true }, pos), { exit: true, reason: 'STRATEGY_EXIT' });
  const sp = { side: 'SHORT', histTarget: -2 };
  assert.equal(exitFor('RAYNER', { hist: -2.5, shortExit: false }, sp).reason, 'RAYNER_HIST_TP');
  assert.equal(exitFor('RAYNER', { hist: -1.5, shortExit: false }, sp).exit, false);
});

test('Rayner exits: close below EMA or histogram < 0 (long), mirrored for short', () => {
  const r = evaluate('RAYNER', bars([...up, up.at(-1) * 0.95]), cfg());
  assert.equal(r.longExit, true);
  const s = evaluate('RAYNER', bars([...dn, dn.at(-1) * 1.05]), cfg());
  assert.equal(s.shortExit, true);
});

test('trend entry count: resets after a close on the other side of the EMA', () => {
  const e = recordTrendEntry(recordTrendEntry(null, 'LONG', 10), 'LONG', 20);
  assert.equal(trendCounts({ trend: { lastBelow: null, lastAbove: null } }, e).LONG, 2);
  assert.equal(trendCounts({ trend: { lastBelow: 15, lastAbove: null } }, e).LONG, 1);
  assert.equal(trendCounts({ trend: { lastBelow: 25, lastAbove: null } }, e).LONG, 0);
  // evaluate reports the last close below the EMA
  const D = [...C, C.at(-1) * 0.9];
  const r = evaluate('RAYNER', bars(D), cfg());
  assert.equal(r.trend.lastBelow, (D.length - 1) * H4);
  assert.equal(trendCounts(r, { LONG: [0, (A.length - 1) * H4, (C.length - 1) * H4] }).LONG, 0);
});

// ---------- engine (paper)
function fakeMarket() {
  const md = new EventEmitter();
  md.status = 'CONNECTED';
  md.s = {}; md.filters = {};
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'XRPUSDT']) {
    md.s[sym] = { daily: [], bars: { '4h': [] }, last: 100, lastTs: Date.now() };
    md.filters[sym] = { symbol: sym, status: 'TRADING', stepSize: 0.001, minQty: 0.001, maxQty: 1e6, minNotional: 5, tickSize: 0.0001 };
  }
  md.price = (s) => md.s[s].last;
  md.isStale = () => false;
  return md;
}
function newEngine() {
  const store = new Store();
  store.state.modes.PAPER = { ...store.state.modes.PAPER, slots: {}, orders: [], trades: [], wallet: 10000, realizedTotal: 0, baseCapital: 10000 };
  store.config.general.mode = 'PAPER';
  store.config.strategies.RAYNER.enabled = true;
  store.state.runState = 'RUNNING';
  const log = new Logger(store);
  const engine = new Engine(store, fakeMarket(), log);
  return { engine, store };
}
const evalOn = async (engine, closes) => {
  const b = bars(closes);
  engine.md.s.BTCUSDT.last = b.at(-1).c;
  return engine.evaluateSlot('RAYNER', 'BTCUSDT', 'test', { bars: b });
};

test('engine: Rayner entry stores structure stop + fixed histogram target; target not updated later', async () => {
  const { engine } = newEngine();
  const res = await evalOn(engine, A);
  assert.equal(res.result, 'ENTRY LONG');
  const pos = engine.slot('RAYNER', 'BTCUSDT').position;
  const sig = evaluate('RAYNER', bars(A), cfg());
  assert.equal(pos.stopMode, 'STRUCTURE');
  assert.ok(Math.abs(pos.stopPrice - sig.structStop.LONG) < 1e-3);
  assert.equal(pos.histTarget, sig.histTarget.LONG);
  // next candle: new 25-bar extreme is different, the position keeps the entry value
  const next = [...A, A.at(-1) * 1.001];
  await evalOn(engine, next);
  const p2 = engine.slot('RAYNER', 'BTCUSDT').position;
  if (p2) assert.equal(p2.histTarget, sig.histTarget.LONG);
});

test('engine: max 2 entries per trend — 3rd signal blocked, count reset after a close below EMA', async () => {
  const { engine } = newEngine();
  assert.equal((await evalOn(engine, A)).result, 'ENTRY LONG');
  await engine.closePosition('RAYNER', 'BTCUSDT', 'MANUAL_EXIT');
  assert.equal((await evalOn(engine, B)).result, 'ENTRY LONG');
  await engine.closePosition('RAYNER', 'BTCUSDT', 'MANUAL_EXIT');
  const third = await evalOn(engine, C);
  assert.equal(third.result, 'MAX_TREND_ENTRIES LONG');
  assert.equal(engine.slot('RAYNER', 'BTCUSDT').position, null);
  assert.deepEqual(engine.slot('RAYNER', 'BTCUSDT').trendCount, { LONG: 2, SHORT: 0 });
  // a candle closes below the EMA -> LONG count back to 0
  await evalOn(engine, [...C, C.at(-1) * 0.9]);
  assert.equal(engine.slot('RAYNER', 'BTCUSDT').trendCount.LONG, 0);
});

test('engine: structure stop hit closes with STRUCTURE_STOP', async () => {
  const { engine } = newEngine();
  await evalOn(engine, A);
  const pos = engine.slot('RAYNER', 'BTCUSDT').position;
  engine.lastTickCheck = {};
  engine.md.s.BTCUSDT.last = pos.stopPrice * 0.99;
  engine.onPrice('BTCUSDT', pos.stopPrice * 0.99);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(engine.ms().trades[0].exitReason, 'STRUCTURE_STOP');
});

test('engine: structure stop at/above the entry price cancels the entry', async () => {
  const { engine } = newEngine();
  const sig = { atr: 1, candleTime: 1, structStop: { LONG: 101 }, histTarget: { LONG: 1 } };
  const r = await engine.openPosition('RAYNER', 'BTCUSDT', 'LONG', sig);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'STOP_INVALID');
  assert.equal(engine.slot('RAYNER', 'BTCUSDT').position, null);
});

test('config: Rayner defaults + validation', () => {
  const c = DEFAULT_CONFIG.strategies.RAYNER;
  assert.equal(c.enabled, false);
  assert.equal(c.timeframe, '4h');
  assert.equal(c.stop.mode, 'STRUCTURE');
  assert.deepEqual(c.params, { emaPeriod: 50, fastPeriod: 1, slowPeriod: 50, signalPeriod: 9, slopeLookback: 3, momentumLookback: 3, momentumMultiplier: 1.5, stopLookback: 10, targetLookback: 25, maxEntriesPerTrend: 2 });
  const next = validateStrategySettings('RAYNER', structuredClone(c), c);
  assert.deepEqual(next.params, c.params);
  assert.equal(next.stop.mode, 'STRUCTURE');
  assert.throws(() => validateStrategySettings('RAYNER', { ...structuredClone(c), params: { ...c.params, fastPeriod: 60 } }, c), /Fast/);
  // STRUCTURE is not available for strategies without structure levels
  const t = structuredClone(DEFAULT_CONFIG.strategies.TURTLE);
  assert.throws(() => validateStrategySettings('TURTLE', { ...t, stop: { ...t.stop, mode: 'STRUCTURE' } }, t), /stop mode/);
});

test('backtest: Rayner uses structure stops, histogram target exits and the per-trend limit', async () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.general.includeFunding = false;
  c.strategies.RAYNER.enabled = true;
  // repeated bursts in one uptrend: 3rd+ entries must be skipped
  let closes = [...up];
  for (let k = 0; k < 5; k++) { closes = extend(closes, 30, 1.002); closes.push(closes.at(-1) * 1.03); }
  closes = extend(closes, 10, 1.002);
  const b = bars(closes);
  const r = await backtestStrategy({ strategy: 'RAYNER', config: c, data: { BTCUSDT: b }, start: b[150].t, end: b.at(-1).T + 1, capital: 1_000_000, symbols: ['BTCUSDT'] });
  const entries = r.trades.length + r.openPositions.length;
  assert.ok(entries <= 2, `at most 2 entries in one trend (got ${entries})`);
  assert.ok(r.skipped.trendMax >= 1);
  for (const t of r.trades) assert.ok(['RAYNER_HIST_TP', 'STRATEGY_EXIT', 'STRUCTURE_STOP'].includes(t.reason), t.reason);
  for (const t of r.trades) assert.ok(t.stopPrice < t.entryPrice, 'long structure stop below entry');
});
