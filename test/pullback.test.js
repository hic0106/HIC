import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-pullback-'));
process.env.HIC_LOG_STDOUT = '0';
const { evaluate, exitFor } = await import('../server/strategies.js');
const { sma } = await import('../server/indicators.js');
const { DEFAULT_CONFIG } = await import('../server/store.js');
const { backtestStrategy } = await import('../server/backtest/backtester.js');
const { validateStrategySettings } = await import('../server/strategyConfig.js');

const H1 = 3_600_000;
const cfg = () => structuredClone(DEFAULT_CONFIG.strategies.MA_PULLBACK);
// uptrend with small wiggles, then a candle that dips to the SMA20 and closes back above it (bullish)
const trend = (n, start, step) => Array.from({ length: n }, (_, i) => start + i * step);
const barsFrom = (closes, last = null) => {
  const b = closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { t: i * H1, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1, T: (i + 1) * H1 - 1 }; });
  if (last) b.push({ t: b.length * H1, T: (b.length + 1) * H1 - 1, v: 1, ...last });
  return b;
};

test('MA pullback long: SMA200 trend, rising SMA20, low touches SMA20, bullish close above it', () => {
  const closes = trend(260, 100, 0.2);
  const b0 = barsFrom(closes);
  const m20 = sma(b0.map((x) => x.c), 20).at(-1);
  const last = closes.at(-1);
  // next candle opens a bit lower, dips below the SMA20 and closes above it (bullish)
  const bars = barsFrom(closes, { o: m20 + 0.3, h: last + 0.5, l: m20 - 0.2, c: m20 + 1.2 });
  const r = evaluate('MA_PULLBACK', bars, cfg());
  assert.equal(r.ready, true);
  assert.equal(r.longCond, true);
  assert.equal(r.shortCond, false);
  const k = bars.at(-1);
  assert.equal(r.structStop.LONG, k.l, 'stop = signal candle low');
  assert.ok(Math.abs(r.tpTarget.LONG - (k.c + 2 * (k.c - k.l))) < 1e-9, 'target = close + 2 x (close - low)');
  assert.equal(r.longExit, false, 'no strategy exit');
  // bearish candle at the same place -> no long (bull_candle required)
  assert.equal(evaluate('MA_PULLBACK', barsFrom(closes, { o: m20 + 1.5, h: m20 + 1.6, l: m20 - 0.2, c: m20 + 1.2 }), cfg()).longCond, false);
  // low stays above the SMA20 -> no pullback
  assert.equal(evaluate('MA_PULLBACK', barsFrom(closes, { o: m20 + 0.5, h: m20 + 2, l: m20 + 0.4, c: m20 + 1.5 }), cfg()).longCond, false);
});

test('MA pullback short mirrored; long blocked below SMA200', () => {
  const closes = trend(260, 200, -0.2);
  const b0 = barsFrom(closes);
  const m20 = sma(b0.map((x) => x.c), 20).at(-1);
  const r = evaluate('MA_PULLBACK', barsFrom(closes, { o: m20 - 0.3, h: m20 + 0.2, l: m20 - 1.5, c: m20 - 1.2 }), cfg());
  assert.equal(r.shortCond, true);
  assert.equal(r.longCond, false);
  const k = { h: m20 + 0.2, c: m20 - 1.2 };
  assert.ok(Math.abs(r.structStop.SHORT - k.h) < 1e-9);
  assert.ok(Math.abs(r.tpTarget.SHORT - (k.c - 2 * (k.h - k.c))) < 1e-9);
  // bullish touch in a downtrend: no long
  assert.equal(evaluate('MA_PULLBACK', barsFrom(closes, { o: m20 - 0.5, h: m20 + 0.2, l: m20 - 0.8, c: m20 + 0.1 }), cfg()).longCond, false);
});

test('backtest: fixed stop at the signal low, fixed 2R target, no trailing or add-ons even when enabled globally', async () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.general.includeFunding = false;
  c.general.trailing = { enabled: true, activateAtr: 0.1, trailAtr: 0.1 };
  c.general.maxAdds = 3;
  c.strategies.MA_PULLBACK.enabled = true;
  const closes = trend(260, 100, 0.2);
  const b0 = barsFrom(closes);
  const m20 = sma(b0.map((x) => x.c), 20).at(-1);
  const sig = { o: m20 + 0.3, h: closes.at(-1) + 0.5, l: m20 - 0.2, c: m20 + 1.2 };
  const bars = barsFrom(closes, sig);
  const tp = sig.c + 2 * (sig.c - sig.l);
  const n = bars.length;
  // next candle opens at the close, then a candle runs through the target
  bars.push({ t: n * H1, T: (n + 1) * H1 - 1, o: sig.c, h: sig.c + 0.5, l: sig.c - 0.1, c: sig.c + 0.4, v: 1 });
  bars.push({ t: (n + 1) * H1, T: (n + 2) * H1 - 1, o: sig.c + 0.4, h: tp + 1, l: sig.c + 0.3, c: tp + 0.5, v: 1 });
  const r = await backtestStrategy({ strategy: 'MA_PULLBACK', config: c, data: { BTCUSDT: bars }, start: bars[240].t, end: bars.at(-1).T + 1, capital: 1_000_000, symbols: ['BTCUSDT'] });
  const t = r.trades.find((x) => x.reason === 'TAKE_PROFIT');
  assert.ok(t, `take profit hit (${JSON.stringify(r.trades.map((x) => x.reason))})`);
  assert.ok(Math.abs(t.exitPrice - tp * (1 - 0.0005)) < 1e-6, 'filled at the fixed target');
  assert.ok(Math.abs(t.stopPrice - sig.l) < 1e-9, 'stop stayed at the signal low (no trailing)');
  assert.ok(!r.trades.some((x) => x.reason === 'TRAIL_STOP'));
  assert.ok(!r.notes.some((x) => /add-on/.test(x)), 'no add-ons');
});

test('config: MA pullback defaults + validation', () => {
  const d = DEFAULT_CONFIG.strategies.MA_PULLBACK;
  assert.equal(d.enabled, false);
  assert.equal(d.stop.mode, 'STRUCTURE');
  assert.deepEqual(d.params, { emaFast: 9, smaMid: 20, smaTrend: 200, rr: 2 });
  const v = validateStrategySettings('MA_PULLBACK', structuredClone(d), d);
  assert.deepEqual(v.params, d.params);
  assert.throws(() => validateStrategySettings('MA_PULLBACK', { ...structuredClone(d), params: { ...d.params, rr: 0 } }, d));
  assert.equal(exitFor('MA_PULLBACK', { longExit: false, candleTime: 0 }, { side: 'LONG', entryTime: 0 }).exit, false);
});

test('engine: fixed target stored on the position, trailing never moves the stop', async () => {
  const { EventEmitter } = await import('node:events');
  const { Store } = await import('../server/store.js');
  const { Logger } = await import('../server/logger.js');
  const { Engine } = await import('../server/engine.js');
  const md = new EventEmitter();
  md.status = 'CONNECTED'; md.s = {}; md.filters = {};
  for (const s of ['BTCUSDT', 'ETHUSDT', 'XRPUSDT']) { md.s[s] = { daily: [], bars: {}, last: 100, lastTs: Date.now() }; md.filters[s] = { symbol: s, status: 'TRADING', stepSize: 0.001, minQty: 0.001, maxQty: 1e6, minNotional: 5, tickSize: 0.01 }; }
  md.price = (s) => md.s[s].last; md.isStale = () => false;
  const store = new Store();
  store.state.modes.PAPER = { ...store.state.modes.PAPER, slots: {}, orders: [], trades: [], wallet: 10000, realizedTotal: 0, baseCapital: 10000 };
  store.state.runState = 'RUNNING';
  store.config.strategies.MA_PULLBACK.enabled = true;
  store.config.general.trailing = { enabled: true, activateAtr: 0.1, trailAtr: 0.1 };
  const engine = new Engine(store, md, new Logger(store));
  const r = await engine.openPosition('MA_PULLBACK', 'BTCUSDT', 'LONG', { atr: 1, candleTime: 1, structStop: { LONG: 98 }, tpTarget: { LONG: 104 } });
  assert.equal(r.ok, true, r.msg);
  const pos = engine.slot('MA_PULLBACK', 'BTCUSDT').position;
  assert.equal(pos.stopPrice, 98);
  assert.equal(pos.tpPrice, 104);
  engine.trailStop(engine.slot('MA_PULLBACK', 'BTCUSDT'), 103.9);
  assert.equal(pos.stopPrice, 98, 'no trailing for MA_PULLBACK');
  engine.lastTickCheck = {};
  md.s.BTCUSDT.last = 104.2;
  engine.onPrice('BTCUSDT', 104.2);
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(engine.ms().trades[0].exitReason, 'TAKE_PROFIT');
});
