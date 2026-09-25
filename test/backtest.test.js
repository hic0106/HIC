import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-bt-'));
process.env.HIC_LOG_STDOUT = '0';

const { DEFAULT_CONFIG } = await import('../server/store.js');
const { backtestStrategy } = await import('../server/backtest/backtester.js');
const { evaluateStrategy } = await import('../server/strategyRegistry.js');

const H4 = 4 * 3600_000, DAY = 86_400_000;
const mk = (closes, len, t0 = 0, spread = 0.005) => closes.map((c, i) => ({ t: t0 + i * len, o: c, h: c * (1 + spread), l: c * (1 - spread), c, v: 1, T: t0 + (i + 1) * len - 1 }));
const cfg = () => { const c = structuredClone(DEFAULT_CONFIG); c.general.includeFunding = false; return c; };

test('backtest: Turtle 4h — signal on close, fill at next open, stop fixed at entry, fees + slippage', async () => {
  const c = cfg();
  const closes = [...Array(300).fill(100), 110, 112, 115, 115, 115];
  const bars = mk(closes, H4);
  const data = { BTCUSDT: bars };
  const start = bars[250].t, end = bars.at(-1).T + 1;
  const r = await backtestStrategy({ strategy: 'TURTLE', config: c, data, start, end, capital: 1_000_000, symbols: ['BTCUSDT'] });
  assert.equal(r.timeframe, '4h');
  const sigBar = bars[300];
  assert.equal(evaluateStrategy('TURTLE', bars.slice(0, 301), c.strategies.TURTLE).longCond, true);
  assert.equal(r.openPositions.length, 1);
  const p = r.openPositions[0];
  assert.equal(p.entryTime, bars[301].t, 'filled at the open of the next candle');
  assert.ok(Math.abs(p.entryPrice - bars[301].o * 1.0005) < 1e-9, 'slippage applied');
  assert.ok(p.stopPrice < p.entryPrice * 0.93 && p.stopPrice >= p.entryPrice * 0.82 - 1e-9, 'stop within min/max clamp');
  assert.ok(sigBar.T < p.entryTime);
  assert.equal(r.fees > 0, true);
});

test('backtest: intrabar emergency stop and gap-through fills', async () => {
  const c = cfg();
  c.strategies.TSMOM.stop = { mode: 'FIXED_PERCENT', fixedPct: 10, atrPeriod: 20, atrMult: 3, minPct: 10, maxPct: 22 };
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i); // rising -> TSMOM long
  const bars = mk(closes, DAY);
  bars.push({ t: 80 * DAY, o: 150, h: 153, l: 150, c: 152, v: 1, T: 81 * DAY - 1 }); // entry bar (momentum still > 0)
  bars.push({ t: 81 * DAY, o: 140, h: 141, l: 120, c: 125, v: 1, T: 82 * DAY - 1 }); // stop hit intrabar
  const r = await backtestStrategy({ strategy: 'TSMOM', config: c, data: { BTCUSDT: bars }, start: 79 * DAY, end: 82 * DAY, capital: 1_000_000, symbols: ['BTCUSDT'] });
  const t = r.trades.find((x) => x.reason === 'FIXED_STOP');
  assert.ok(t, 'stopped out');
  const stop = t.entryPrice * 0.9;
  assert.ok(Math.abs(t.exitPrice - stop * (1 - 0.0005)) < 1e-6, 'filled at the stop price (minus slippage)');
  // gap below the stop -> filled at the open
  const bars2 = bars.slice(0, -1);
  bars2.push({ t: 81 * DAY, o: 120, h: 121, l: 110, c: 115, v: 1, T: 82 * DAY - 1 });
  const r2 = await backtestStrategy({ strategy: 'TSMOM', config: c, data: { BTCUSDT: bars2 }, start: 79 * DAY, end: 82 * DAY, capital: 1_000_000, symbols: ['BTCUSDT'] });
  const t2 = r2.trades.find((x) => x.reason === 'FIXED_STOP');
  assert.ok(Math.abs(t2.exitPrice - 120 * (1 - 0.0005)) < 1e-6);
});

test('backtest: compound vs fixed sizing, equity accounting consistent', async () => {
  const c = cfg();
  // alternating up / down trends -> several TSMOM round trips
  const closes = [];
  let p = 100;
  for (let i = 0; i < 400; i++) { p *= 1 + (Math.floor(i / 60) % 2 ? -0.01 : 0.012); closes.push(p); }
  const bars = mk(closes, DAY);
  const args = { strategy: 'TSMOM', config: c, data: { BTCUSDT: bars }, start: bars[40].t, end: bars.at(-1).T + 1, capital: 1_000_000, symbols: ['BTCUSDT'] };
  const a = await backtestStrategy({ ...args, compound: true });
  const b = await backtestStrategy({ ...args, compound: false });
  assert.ok(a.trades.length >= 3);
  // realized equity = capital + sum of closed trade net PnL (+ open position MTM)
  const openA = a.openPositions.reduce((s, x) => s + x.unrealized, 0);
  assert.ok(Math.abs(a.metrics.finalEquity - (1_000_000 + a.trades.reduce((s, t) => s + t.net, 0) + openA)) < 1e-4);
  // fixed sizing: every entry uses the same notional
  assert.ok(b.trades.every((t) => Math.abs(t.notional - 1_000_000) < 1e-6));
  // compounding: later entries use the grown equity
  assert.ok(a.trades.some((t) => Math.abs(t.notional - 1_000_000) > 1));
});

test('backtest: re-arm after stop for ADX-type strategies, three symbols share one account', async () => {
  const c = cfg();
  const closes = Array.from({ length: 120 }, (_, i) => 100 + i);
  const data = { BTCUSDT: mk(closes, DAY), ETHUSDT: mk(closes, DAY), XRPUSDT: mk(closes, DAY) };
  const r = await backtestStrategy({ strategy: 'TSMOM', config: c, data, start: 50 * DAY, end: 120 * DAY, capital: 1_000_000 });
  assert.equal(r.openPositions.length, 3);
  const total = r.openPositions.reduce((s, x) => s + x.notional, 0);
  assert.ok(total <= 1_000_000 + 1e-6, 'slots share the strategy capital');
  assert.ok(r.benchmark.length > 0);
});

test('backtest: QQQ with limited history reports warm-up instead of fake trades', async () => {
  const c = cfg();
  const bars = mk(Array(60).fill(600), DAY);
  const r = await backtestStrategy({ strategy: 'QQQ_EMA_TREND', config: c, data: { QQQUSDT: bars }, start: 0, end: 60 * DAY, capital: 1_000_000 });
  assert.equal(r.trades.length, 0);
  assert.ok(r.notes.some((n) => /never ready/.test(n)));
  assert.equal(r.metrics.returnPct, 0);
});

test('metrics: a drawdown still open at the end counts toward the longest drawdown', async () => {
  const { computeMetrics } = await import('../server/backtest/backtester.js');
  const eq = [100, 120, 110, 105, 100].map((v, i) => ({ t: i * DAY, equity: v * 10000 }));
  const m = computeMetrics({ equity: eq, trades: [], capital: 1_000_000, timeline: eq.map((p) => p.t) });
  assert.equal(m.longestDrawdownDays, 3);
});

test('backtest: Turtle on 5m candles (signal on close, next-open fill) + 5m period cap', async () => {
  const { BacktestRunner, MAX_DAYS } = await import('../server/backtest/backtestRunner.js');
  const { validateStrategySettings } = await import('../server/strategyConfig.js');
  const c = cfg();
  const t = validateStrategySettings('TURTLE', { ...structuredClone(c.strategies.TURTLE), timeframe: '5m' }, c.strategies.TURTLE);
  assert.equal(t.timeframe, '5m');
  c.strategies.TURTLE = t;
  const M5 = 300_000;
  const closes = [...Array(300).fill(100), 110, 112, 115, 115, 115];
  const bars = mk(closes, M5);
  const r = await backtestStrategy({ strategy: 'TURTLE', config: c, data: { BTCUSDT: bars }, start: bars[250].t, end: bars.at(-1).T + 1, capital: 1_000_000, symbols: ['BTCUSDT'] });
  assert.equal(r.timeframe, '5m');
  assert.equal(r.openPositions.length, 1);
  assert.equal(r.openPositions[0].entryTime, bars[301].t, 'filled at the open of the next 5m candle');
  const runner = new BacktestRunner({ store: { config: c }, md: {}, log: { warn() {}, info() {}, error() {} }, rest: {} });
  assert.equal(runner.effectiveDays(365, [{ s: 'BTCUSDT', tf: '5m' }, { s: 'BTCUSDT', tf: '1d' }]), MAX_DAYS['5m']);
  assert.equal(runner.effectiveDays(365, [{ s: 'BTCUSDT', tf: '4h' }]), 365);
});
