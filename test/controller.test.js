import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-ctl-test-'));
process.env.HIC_LOG_STDOUT = '0';

const { Store, DEFAULT_CONFIG } = await import('../server/store.js');
const { Logger } = await import('../server/logger.js');
const { Engine } = await import('../server/engine.js');
const { Controller } = await import('../server/controller/controllerEngine.js');
const { ControllerStore, emptyControllerState } = await import('../server/controller/controllerStore.js');
const { decide, multiplierTable, MAX_MULTIPLIER } = await import('../server/controller/decisionRules.js');
const { computeMetrics, returnCorrelation } = await import('../server/controller/performanceEvaluator.js');
const { detectRegime } = await import('../server/controller/regimeDetector.js');
const { ShadowPortfolio } = await import('../server/controller/shadowPortfolio.js');

const DAY = 86_400_000;
const CFG = () => structuredClone(DEFAULT_CONFIG.controller);
const candles = (closes, spread = 0.01, t0 = Date.now() - closes.length * DAY) =>
  closes.map((c, i) => ({ t: t0 + i * DAY, o: c, h: c * (1 + spread), l: c * (1 - spread), c, v: 1, T: t0 + (i + 1) * DAY - 1 }));
const bullBTC = () => candles(Array.from({ length: 320 }, (_, i) => 100 * 1.003 ** i));

function fakeMarket(btc = bullBTC()) {
  const md = new EventEmitter();
  md.status = 'CONNECTED';
  md.s = {}; md.filters = {};
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'XRPUSDT']) {
    md.s[sym] = { daily: sym === 'BTCUSDT' ? btc : candles(Array.from({ length: 300 }, () => 100)), last: 100, lastTs: Date.now() };
    md.filters[sym] = { symbol: sym, status: 'TRADING', stepSize: 0.001, minQty: 0.001, maxQty: 1e6, minNotional: 5, tickSize: 0.01 };
  }
  md.price = (s) => md.s[s].last;
  md.isStale = () => false;
  return md;
}

// equity index path -> daily MTM series ending today (cum in slot units, 3 slots)
function seriesFromEq(eqs) {
  const today = Math.floor(Date.now() / DAY);
  return eqs.map((eq, i) => ({ day: new Date((today - (eqs.length - 1 - i)) * DAY).toISOString().slice(0, 10), cum: (eq - 1) * 3, open: 1 }));
}
const steady = (days, daily, wobble = 0.002) => Array.from({ length: days }, (_, i) => (1 + daily) ** i * (1 + (i % 2 ? wobble : -wobble)));

function setup({ mode = 'OBSERVE', tradingMode = 'PAPER', btc } = {}) {
  const store = new Store();
  store.config = structuredClone(DEFAULT_CONFIG);
  store.config.general.mode = tradingMode;
  store.config.controller.mode = mode;
  store.state.modes.PAPER = { ...store.state.modes.PAPER, slots: {}, orders: [], trades: [], wallet: 10000, realizedTotal: 0, baseCapital: 10000 };
  store.state.modes.LIVE = { ...store.state.modes.LIVE, slots: {}, orders: [], trades: [], realizedTotal: 0 };
  store.state.runState = 'RUNNING';
  const log = new Logger(store);
  const logs = [];
  log.on('log', (e) => logs.push(e));
  const md = fakeMarket(btc);
  const engine = new Engine(store, md, log);
  const cs = new ControllerStore();
  cs.state = emptyControllerState();
  cs.history = [];
  const controller = new Controller({ store, md, engine, log, cstore: cs });
  engine.controller = controller;
  return { store, engine, controller, logs, md };
}

// strong, consistent TURTLE LONG history: +0.15%/day for 200 days, tiny drawdowns
function giveGoodHistory(controller, key = 'TURTLE:LONG') {
  controller.shadow.state.series[key] = seriesFromEq(steady(200, 0.0015));
}

const M = ({ days = 200, r30 = 0.03, r90 = 0.12, rs = 0.2, dd = -0.02, mdd = -0.05, sharpe = 2, sortino = 3, cons = 0.8, consec = 0 } = {}) => ({
  historyDays: days, ret: { fast: r30, main: r90, stability: rs }, stabilityWindow: 180, currentDD: dd, maxDD: mdd,
  sharpe, sortino, consistency: cons, consecutiveLosses: consec, tradeCount: 5,
});

// ---------------------------------------------------------------- sizing modes
test('controller OFF → multiplier 1.0 and base amount used', async () => {
  const { engine, controller } = setup({ mode: 'OFF' });
  giveGoodHistory(controller);
  controller.evaluate('test');
  assert.deepEqual(controller.getSizing('TURTLE', 'LONG', 'PAPER').multiplier, 1);
  assert.equal((await engine.openPosition('TURTLE', 'BTCUSDT', 'LONG', { atr: 1 })).ok, true);
  assert.equal(engine.slot('TURTLE', 'BTCUSDT').position.orderAmount, 300);
});

test('OBSERVE → recommendation created, order amount NOT changed', async () => {
  const { engine, controller } = setup({ mode: 'OBSERVE' });
  giveGoodHistory(controller);
  assert.equal(controller.evaluate('test').ok, true);
  assert.equal(controller.state.sides['TURTLE:LONG'].status, 'BOOSTED');
  assert.equal(controller.getSizing('TURTLE', 'LONG', 'PAPER').multiplier, 1);
  await engine.openPosition('TURTLE', 'BTCUSDT', 'LONG', { atr: 1 });
  const pos = engine.slot('TURTLE', 'BTCUSDT').position;
  assert.equal(pos.orderAmount, 300);
  assert.equal(pos.ctrlMultiplier, 1);
});

test('PAPER_AUTO → multiplier applied to paper orders, base amount untouched', async () => {
  const { store, engine, controller } = setup({ mode: 'OBSERVE' });
  giveGoodHistory(controller);
  const before = structuredClone(store.config.strategies);
  controller.setMode('PAPER_AUTO');
  controller.evaluate('test');
  assert.equal(controller.getSizing('TURTLE', 'LONG', 'PAPER').multiplier, 1.25);
  assert.equal(controller.getSizing('TURTLE', 'LONG', 'LIVE').multiplier, 1, 'LIVE never auto-applied');
  await engine.openPosition('TURTLE', 'BTCUSDT', 'LONG', { atr: 1 });
  const pos = engine.slot('TURTLE', 'BTCUSDT').position;
  assert.equal(pos.orderAmount, 375);
  assert.equal(pos.baseAmount, 300);
  assert.deepEqual(store.config.strategies, before, 'base order amounts and strategy config unchanged');
});

test('LIVE_APPROVAL → not applied to LIVE before approval; applied after APPROVE; REJECT keeps it', () => {
  const { controller } = setup({ mode: 'OBSERVE', tradingMode: 'LIVE' });
  giveGoodHistory(controller);
  giveGoodHistory(controller, 'ADX:LONG');
  controller.setMode('LIVE_APPROVAL');
  controller.evaluate('test');
  assert.equal(controller.getSizing('TURTLE', 'LONG', 'LIVE').multiplier, 1);
  const p = controller.state.pending.find((x) => x.key === 'TURTLE:LONG');
  assert.ok(p && p.to === 'BOOSTED');
  assert.equal(controller.approve(p.id).ok, true);
  assert.equal(controller.getSizing('TURTLE', 'LONG', 'LIVE').multiplier, 1.25);
  const q = controller.state.pending.find((x) => x.key === 'ADX:LONG');
  controller.reject(q.id);
  assert.equal(controller.getSizing('ADX', 'LONG', 'LIVE').multiplier, 1);
  const hist = controller.cstore.history;
  assert.ok(hist.some((h) => h.strategy === 'TURTLE' && h.approved_by_user === true && h.applied === true && h.applied_to === 'LIVE'));
  assert.ok(hist.some((h) => h.strategy === 'ADX' && h.approved_by_user === false && h.note === 'user rejected LIVE change'));
});

// ---------------------------------------------------------------- bounds / fail-safe
test('multiplier upper bound 1.25: config cannot raise it, invalid state falls back to 1.0', async () => {
  assert.equal(MAX_MULTIPLIER, 1.25);
  assert.equal(multiplierTable({ BOOSTED: 3 }).BOOSTED, 1.25);
  assert.equal(multiplierTable({ BOOSTED: 2, NORMAL: 1 }).BOOSTED, 1.25);
  const { engine, controller } = setup({ mode: 'PAPER_AUTO' });
  controller.state.applied.PAPER['TURTLE:LONG'] = { status: 'SUPER', multiplier: 5 };
  assert.equal(controller.getSizing('TURTLE', 'LONG', 'PAPER').multiplier, 1);
  assert.ok(controller.state.failSafe);
  engine.controller = { getSizing: () => ({ multiplier: 5, status: 'X' }) };
  assert.equal(engine.controllerSizing('TURTLE', 'LONG', 300).amount, 300);
  engine.controller = { getSizing: () => ({ multiplier: 1.25, status: 'BOOSTED', capUsdt: 320 }) };
  assert.equal(engine.controllerSizing('TURTLE', 'LONG', 300).amount, 320, 'user max order cap respected');
});

test('multiplier lower bound 0: PAUSED skips entry; negative falls back to 1.0', async () => {
  const { engine, controller, logs } = setup({ mode: 'PAPER_AUTO' });
  controller.state.applied.PAPER['ADX:LONG'] = { status: 'PAUSED', multiplier: 0 };
  const r = await engine.openPosition('ADX', 'ETHUSDT', 'LONG', { atr: 1 });
  assert.equal(r.code, 'CONTROLLER_PAUSED');
  assert.equal(engine.slot('ADX', 'ETHUSDT').position, null);
  assert.ok(logs.some((l) => l.code === 'CONTROLLER_PAUSED'));
  engine.controller = { getSizing: () => ({ multiplier: -1, status: 'X' }) };
  assert.equal(engine.controllerSizing('ADX', 'LONG', 250).multiplier, 1);
});

test('controller error → fail safe 1.0, trading continues', async () => {
  const { engine, controller } = setup({ mode: 'PAPER_AUTO' });
  engine.controller = { getSizing: () => { throw new Error('boom'); } };
  assert.equal(engine.controllerSizing('TSMOM', 'LONG', 250).multiplier, 1);
  assert.equal((await engine.openPosition('TSMOM', 'XRPUSDT', 'LONG', { atr: 1 })).ok, true);
  engine.controller = controller;
  controller.md.s.BTCUSDT = undefined; // missing BTC data is handled (regime NORMAL), not an error
  assert.equal(controller.evaluate('test').ok, true);
  controller.shadow.state.series = null; // corrupt performance data -> evaluation throws
  const r = controller.evaluate('test');
  assert.equal(r.ok, false);
  assert.ok(controller.state.failSafe);
  assert.equal(controller.getSizing('TURTLE', 'LONG', 'PAPER').multiplier, 1);
});

test('DISABLE CONTROLLER → all multipliers 1.0, mode OFF', () => {
  const { controller } = setup({ mode: 'PAPER_AUTO' });
  giveGoodHistory(controller);
  controller.evaluate('test');
  assert.equal(controller.getSizing('TURTLE', 'LONG', 'PAPER').multiplier, 1.25);
  controller.disable();
  assert.equal(controller.cfg.mode, 'OFF');
  for (const { strategy, side } of controller.keys()) {
    assert.equal(controller.getSizing(strategy, side, 'PAPER').multiplier, 1);
    assert.equal(controller.getSizing(strategy, side, 'LIVE').multiplier, 1);
  }
});

test('strategy disabled → controller never re-enables it', async () => {
  const { store, engine, controller } = setup({ mode: 'PAPER_AUTO' });
  store.config.strategies.ADX.enabled = false;
  giveGoodHistory(controller, 'ADX:LONG');
  controller.evaluate('test');
  controller.setMode('LIVE_APPROVAL');
  controller.evaluate('test');
  for (const p of [...controller.state.pending]) controller.approve(p.id);
  assert.equal(store.config.strategies.ADX.enabled, false);
  const r = await engine.openPosition('ADX', 'BTCUSDT', 'LONG', { atr: 1 });
  assert.equal(r.code, 'STRATEGY_DISABLED');
});

// ---------------------------------------------------------------- decision rules
test('insufficient history → NORMAL', () => {
  const d = decide({ metrics: M({ days: 40 }), side: 'LONG', regime: 'BULL_TREND', cfg: CFG() });
  assert.equal(d.status, 'NORMAL');
  assert.match(d.reasons[0], /insufficient history/);
  const { controller } = setup({ mode: 'OBSERVE' });
  controller.shadow.state.series['TURTLE:LONG'] = seriesFromEq(steady(30, 0.01));
  controller.evaluate('test');
  assert.equal(controller.state.sides['TURTLE:LONG'].status, 'NORMAL');
});

test('drawdown guard: no boost > 10%, REDUCED > 15%, PAUSED > 25%', () => {
  const cfg = CFG();
  assert.equal(decide({ metrics: M(), side: 'LONG', regime: 'BULL_TREND', cfg }).status, 'BOOSTED');
  assert.equal(decide({ metrics: M({ dd: -0.12 }), prevStatus: 'BOOSTED', side: 'LONG', regime: 'BULL_TREND', cfg }).status, 'NORMAL');
  assert.equal(decide({ metrics: M({ dd: -0.16 }), prevStatus: 'BOOSTED', side: 'LONG', regime: 'BULL_TREND', cfg }).status, 'REDUCED');
  assert.equal(decide({ metrics: M({ dd: -0.30 }), prevStatus: 'BOOSTED', side: 'LONG', regime: 'BULL_TREND', cfg }).status, 'PAUSED');
});

test('no martingale: no increase after recent losses, one step up at a time', () => {
  const cfg = CFG();
  const up = decide({ metrics: M({ r30: -0.01 }), prevStatus: 'CAUTIOUS', side: 'LONG', regime: 'BULL_TREND', cfg });
  assert.equal(up.status, 'CAUTIOUS', 'negative 30D return blocks any increase');
  const step = decide({ metrics: M(), prevStatus: 'REDUCED', side: 'LONG', regime: 'BULL_TREND', cfg });
  assert.equal(step.status, 'CAUTIOUS', 'REDUCED → CAUTIOUS only');
  const bad = decide({ metrics: M({ r90: -0.08, rs: -0.1, r30: -0.04, sharpe: -1.5, sortino: -2, cons: 0.2, dd: -0.08 }), prevStatus: 'NORMAL', side: 'LONG', regime: 'BULL_TREND', cfg });
  assert.ok(['CAUTIOUS', 'REDUCED'].includes(bad.status));
});

test('return alone does not boost: drawdown/risk/consistency matter', () => {
  const cfg = CFG();
  const d = decide({ metrics: M({ r90: 0.3, sharpe: 0.1, sortino: 0.1, cons: 0.3, dd: -0.09 }), side: 'LONG', regime: 'BULL_TREND', cfg });
  assert.notEqual(d.status, 'BOOSTED');
});

test('consecutive losses: 3 blocks boost, but alone never pauses', () => {
  const cfg = CFG();
  assert.equal(decide({ metrics: M({ consec: 3 }), side: 'LONG', regime: 'BULL_TREND', cfg }).status, 'NORMAL');
  assert.notEqual(decide({ metrics: M({ consec: 8 }), side: 'LONG', regime: 'BULL_TREND', cfg }).status, 'PAUSED');
});

test('regime caps: HIGH_VOLATILITY ≤ 0.75, SIDEWAYS no boost, BULL blocks short boost', () => {
  const cfg = CFG();
  assert.equal(decide({ metrics: M(), prevStatus: 'BOOSTED', side: 'LONG', regime: 'HIGH_VOLATILITY', cfg }).status, 'CAUTIOUS');
  assert.equal(decide({ metrics: M(), side: 'LONG', regime: 'SIDEWAYS', cfg }).status, 'NORMAL');
  assert.equal(decide({ metrics: M(), side: 'SHORT', regime: 'BULL_TREND', cfg }).status, 'NORMAL');
  assert.equal(decide({ metrics: M(), side: 'SHORT', regime: 'BEAR_TREND', cfg }).status, 'BOOSTED');
});

// ---------------------------------------------------------------- metrics / regime / shadow
test('performance metrics from daily equity', () => {
  const series = seriesFromEq([1, 1.1, 1.2, 1.08, 1.14]);
  const m = computeMetrics({ series, trades: [], nSlots: 3, windows: { fast: 30, main: 90, stability: 180, extended: 365 } });
  assert.ok(Math.abs(m.maxDD - (1.08 / 1.2 - 1)) < 1e-9);
  assert.ok(Math.abs(m.currentDD - (1.14 / 1.2 - 1)) < 1e-9);
  assert.ok(Math.abs(m.ret.main - 0.14) < 1e-9);
  const a = seriesFromEq(steady(120, 0.001, 0.01)), b = seriesFromEq(steady(120, 0.001, 0.01));
  assert.ok(returnCorrelation(a, b, 3) > 0.99);
});

test('regime detector: bull / bear / high volatility / sideways', () => {
  const cfg = CFG().regime;
  assert.equal(detectRegime(bullBTC(), cfg).regime, 'BULL_TREND');
  assert.equal(detectRegime(candles(Array.from({ length: 320 }, (_, i) => 100 * 0.997 ** i)), cfg).regime, 'BEAR_TREND');
  assert.equal(detectRegime(candles(Array.from({ length: 320 }, (_, i) => 100 * (i % 2 ? 1.08 : 0.93))), cfg).regime, 'HIGH_VOLATILITY');
  const flat = Array.from({ length: 320 }, (_, i) => 100 + Math.sin(i / 2) * 0.5);
  assert.equal(detectRegime(candles(flat, 0.004), cfg).regime, 'SIDEWAYS');
});

test('shadow portfolio: controller book = baseline × multiplier; PAUSED still records baseline', () => {
  const md = fakeMarket();
  const cfg = structuredClone(DEFAULT_CONFIG);
  let mult = 1.25;
  const sp = new ShadowPortfolio({ md, symbols: ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'], getConfig: () => cfg, proposedMultiplier: () => mult });
  sp.open('TURTLE', 'ETHUSDT', 'LONG', 100, 2, Date.now());
  const t1 = sp.close('TURTLE', 'ETHUSDT', 110, 'STRATEGY_EXIT', Date.now());
  assert.ok(t1.pnlBaseline > 0);
  assert.ok(Math.abs(t1.pnlController - t1.pnlBaseline * 1.25) < 1e-9);
  mult = 0;
  sp.open('ADX', 'ETHUSDT', 'LONG', 100, 2, Date.now());
  const t2 = sp.close('ADX', 'ETHUSDT', 90, 'STRATEGY_EXIT', Date.now());
  assert.ok(t2.pnlBaseline < 0);
  assert.ok(t2.pnlController === 0);
  sp.snapshot('2026-01-01', () => 100);
  const p = sp.state.portfolio.at(-1);
  assert.ok(Math.abs(p.baseline - (t1.pnlBaseline + t2.pnlBaseline)) < 1e-9);
  assert.ok(Math.abs(p.controller - t1.pnlController) < 1e-9);
});

test('shadow stop: ATR stop closes virtual position and never touches real orders', () => {
  const { controller, engine } = setup({ mode: 'OBSERVE' });
  controller.shadow.open('TSMOM', 'BTCUSDT', 'LONG', 100, 1, Date.now());
  const stop = controller.shadow.slot('TSMOM', 'BTCUSDT').pos.stopPrice;
  controller.shadow.onPrice('BTCUSDT', stop * 0.99, Date.now() + 5000);
  assert.equal(controller.shadow.slot('TSMOM', 'BTCUSDT').pos, null);
  assert.equal(controller.shadow.state.trades.at(-1).reason, 'ATR_STOP');
  assert.equal(engine.ms().orders.length, 0);
});

test('every decision stored in history with reason and required fields', () => {
  const { controller } = setup({ mode: 'OBSERVE' });
  giveGoodHistory(controller);
  controller.evaluate('test');
  const h = controller.cstore.history;
  assert.equal(h.length, 6); // 3 strategies × LONG/SHORT
  for (const f of ['timestamp', 'controller_mode', 'strategy', 'side', 'previous_status', 'new_status', 'previous_multiplier', 'new_multiplier',
    '30d_return', '90d_return', '180d_return', 'current_drawdown', 'max_drawdown', 'sharpe', 'sortino', 'profit_factor', 'trade_count',
    'market_regime', 'reason', 'approved_by_user', 'applied']) {
    assert.ok(f in h[0], `missing ${f}`);
  }
  const t = h.find((x) => x.strategy === 'TURTLE' && x.side === 'LONG');
  assert.equal(t.new_status, 'BOOSTED');
  assert.equal(t.applied, false, 'OBSERVE never applies');
  assert.ok(t.reason.length > 10);
});

test('re-evaluation only when due (default 7 days)', () => {
  const { controller } = setup({ mode: 'OBSERVE' });
  const now = Date.now();
  assert.equal(controller.isDue(now), true);
  controller.evaluate('test', now);
  assert.equal(controller.isDue(now + 6 * DAY), false);
  assert.equal(controller.isDue(now + 7 * DAY), true);
});
