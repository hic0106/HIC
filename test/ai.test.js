// AI features with a stubbed Claude client (no network): rule DSL, improvement loop, generation, apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-ai-'));
process.env.HIC_LOG_STDOUT = '0';

const { Store } = await import('../server/store.js');
const { Logger } = await import('../server/logger.js');
const { BacktestRunner } = await import('../server/backtest/backtestRunner.js');
const { AiService, diagnose } = await import('../server/ai/aiService.js');
const { validateDsl, compileDsl, STRATEGY_SCHEMA } = await import('../server/ai/dsl.js');
const { backtestStrategy } = await import('../server/backtest/backtester.js');

const H = 3600_000, DAY = 24 * H;
const TF = { '4h': 4 * H, '1d': DAY, '30m': 30 * 60_000 };
// deterministic trending / ranging price path
const px = (t) => 100 * Math.exp(0.35 * Math.sin(t / (40 * DAY)) + 0.05 * Math.sin(t / (3 * DAY)));
const fakeRest = {
  publicGet: async (p, q) => {
    if (p === '/fapi/v1/fundingRate') return [];
    const ms = TF[q.interval];
    const now = Date.now();
    const out = [];
    for (let t = Math.ceil(q.startTime / ms) * ms; t + ms <= now && out.length < q.limit; t += ms) {
      const o = px(t), c = px(t + ms);
      out.push([t, o, Math.max(o, c) * 1.003, Math.min(o, c) * 0.997, c, 1, t + ms - 1]);
    }
    return out;
  },
};

function setup() {
  const store = new Store();
  store.config.general.includeFunding = false;
  const log = new Logger(store);
  const backtest = new BacktestRunner({ store, md: { s: {} }, log, rest: fakeRest });
  const controller = { changes: [], onStrategyConfigChanged(st, a, b) { this.changes.push([st, a, b]); } };
  const ai = new AiService({ store, backtest, controller, engine: null, log });
  store.secrets.anthropicApiKey = 'sk-ant-test';
  const calls = [];
  ai.claude.json = async (req) => { calls.push(req); const data = ai._reply(req, calls.length); return { data, content: [{ type: 'text', text: JSON.stringify(data) }], usage: { input_tokens: 1, output_tokens: 1 } }; };
  return { store, ai, backtest, controller, calls };
}
const waitJob = async (ai) => { for (let i = 0; i < 400 && ai.job.state === 'RUNNING'; i++) await new Promise((r) => setTimeout(r, 25)); return ai.job; };

const EMA_CROSS = {
  name: 'EMA_CROSS', description: 'EMA 교차', rationale: '추세 추종', timeframe: '1d', symbols: ['BTCUSDT'],
  indicators: [{ id: 'fast', type: 'EMA', period: 10, source: 'close' }, { id: 'slow', type: 'EMA', period: 40, source: 'close' }],
  long: { enabled: true, entry: { mode: 'all', rules: [{ left: { kind: 'indicator', ref: 'fast', value: 0, offset: 0, mult: 1 }, op: 'crossAbove', right: { kind: 'indicator', ref: 'slow', value: 0, offset: 0, mult: 1 } }] },
    exit: { mode: 'any', rules: [{ left: { kind: 'indicator', ref: 'fast', value: 0, offset: 0, mult: 1 }, op: '<', right: { kind: 'indicator', ref: 'slow', value: 0, offset: 0, mult: 1 } }] } },
  short: { enabled: false, entry: { mode: 'all', rules: [] }, exit: { mode: 'all', rules: [] } },
  stop: { mode: 'ATR_DYNAMIC', atrPeriod: 14, atrMult: 3, minPct: 5, maxPct: 20, fixedPct: 8 }, takeProfit: { enabled: false, pct: 20 }, resetAfterStop: true,
};

test('dsl: schema is closed (structured outputs requirement) and has no recursion', () => {
  const walk = (o, depth = 0) => {
    assert.ok(depth < 12, 'no recursion');
    if (o.type === 'object') { assert.equal(o.additionalProperties, false); assert.deepEqual([...o.required].sort(), Object.keys(o.properties).sort()); Object.values(o.properties).forEach((p) => walk(p, depth + 1)); }
    if (o.type === 'array') walk(o.items, depth + 1);
  };
  walk(STRATEGY_SCHEMA);
});

test('dsl: validation rejects unknown references and bad values; interpreter trades on crossovers', () => {
  assert.throws(() => validateDsl({ ...EMA_CROSS, long: { ...EMA_CROSS.long, entry: { mode: 'all', rules: [{ ...EMA_CROSS.long.entry.rules[0], left: { kind: 'indicator', ref: 'nope', value: 0, offset: 0, mult: 1 } }] } } }), /unknown indicator/);
  assert.throws(() => validateDsl({ ...EMA_CROSS, symbols: ['DOGEUSDT'] }), /symbol/);
  const d = validateDsl(EMA_CROSS);
  const custom = compileDsl(d);
  const bars = []; for (let i = 0; i < 400; i++) { const t = i * DAY, o = px(t), c = px(t + DAY); bars.push({ t, o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, c, v: 1, T: t + DAY - 1 }); }
  const store = new Store(); store.config.general.includeFunding = false;
  const r = backtestStrategy({ strategy: 'EMA_CROSS', config: store.config, data: { BTCUSDT: bars }, start: 50 * DAY, end: 400 * DAY, capital: 1_000_000, custom });
  assert.ok(r.trades.length >= 1, `trades ${r.trades.length}`);
  assert.ok(r.trades.every((t) => t.side === 'LONG'));
  // exits only when fast < slow or stop
  assert.ok(r.trades.every((t) => ['STRATEGY_EXIT', 'ATR_STOP'].includes(t.reason)));
});

test('ai improve: candidates are backtested in/out of sample, verdicts set, nothing applied automatically', async () => {
  const { ai, store } = setup();
  const before = structuredClone(store.config.strategies.TSMOM);
  ai._reply = (req, n) => ({ analysis: '모멘텀 기간이 짧아 잦은 손절', candidates: [
    { label: '기간 늘리기', hypothesis: '잡음 감소', changes: [{ path: 'params.lookback', value: '60' }] },
    { label: '금지 항목', hypothesis: 'x', changes: [{ path: 'amounts.LIVE.long', value: '999999' }] },
  ] });
  assert.equal(ai.improve({ strategy: 'TSMOM', rounds: 2, days: 200 }).ok, true);
  const job = await waitJob(ai);
  assert.equal(job.state, 'DONE', job.msg);
  const imp = ai.state.improvements.TSMOM;
  assert.equal(imp.candidates.length, 4);
  const good = imp.candidates.filter((c) => !c.error);
  const bad = imp.candidates.filter((c) => c.error);
  assert.equal(bad.length, 2, 'order amounts can never be changed by AI');
  assert.ok(good.every((c) => ['PASSED', 'OVERFIT', 'WORSE'].includes(c.verdict) && c.inSample && c.outSample));
  assert.deepEqual(store.config.strategies.TSMOM, before, 'not applied without the user');
  assert.ok(imp.split.cut > imp.split.start && imp.split.cut < imp.split.end);
});

test('ai improve: Claude never receives out-of-sample data', async () => {
  const { ai, calls } = setup();
  ai._reply = () => ({ analysis: 'x', candidates: [{ label: 'a', hypothesis: 'b', changes: [{ path: 'stop.atrMult', value: '3.5' }] }] });
  ai.improve({ strategy: 'ADX', rounds: 2, days: 200 });
  await waitJob(ai);
  const imp = ai.state.improvements.ADX;
  const sent = JSON.stringify(calls.map((c) => c.messages.filter((m) => m.role === 'user')));
  const oos = imp.candidates[0].outSample;
  assert.ok(!sent.includes('outSample'), 'no out-of-sample block in prompts');
  assert.ok(calls.every((c) => c.schema && c.system), 'structured output + cached system prompt');
  assert.ok(oos);
});

test('ai apply: validated like a manual save, amounts kept, controller notified', async () => {
  const { ai, store, controller } = setup();
  store.config.strategies.TURTLE.amounts.LIVE.long = 77;
  ai._reply = () => ({ analysis: 'x', candidates: [{ label: '채널 넓히기', hypothesis: 'y', changes: [{ path: 'params.entryPeriod', value: '30' }, { path: 'timeframe', value: '1d' }] }] });
  ai.improve({ strategy: 'TURTLE', rounds: 1, days: 200 });
  await waitJob(ai);
  const c = ai.state.improvements.TURTLE.candidates[0];
  assert.ok(!c.error, c.error);
  assert.equal(ai.applyCandidate({ strategy: 'TURTLE', id: c.id }).ok, true);
  assert.equal(store.config.strategies.TURTLE.params.entryPeriod, 30);
  assert.equal(store.config.strategies.TURTLE.timeframe, '1d');
  assert.equal(store.config.strategies.TURTLE.amounts.LIVE.long, 77);
  assert.equal(controller.changes.length, 1);
});

test('ai generate: invalid rules are sent back for correction, valid ones backtested and saved', async () => {
  const { ai } = setup();
  ai._reply = (req, n) => (n === 1
    ? { notes: '첫 버전', strategy: { ...EMA_CROSS, indicators: [] } } // references undefined indicators
    : { notes: '수정본', strategy: EMA_CROSS });
  ai.generate({ idea: 'EMA 교차 추세추종', rounds: 2, days: 200 });
  const job = await waitJob(ai);
  assert.equal(job.state, 'DONE', job.msg);
  const [v1, v2] = ai.state.generated[0].versions;
  assert.ok(v1.error);
  assert.ok(!v2.error, v2.error);
  assert.ok(v2.inSample && v2.outSample && v2.rules.longEntry);
  assert.equal(ai.saveGenerated({ id: v2.id }).ok, true);
  assert.equal(ai.saved.length, 1);
  assert.equal(ai.saveGenerated({ id: v1.id }).ok, false);
});

test('ai analyze: requires a backtest, stores the structured analysis', async () => {
  const { ai, backtest } = setup();
  assert.equal(ai.analyze().ok, false);
  await backtest.run({ days: 120, capital: 1_000_000, strategies: ['TSMOM'] });
  ai._reply = () => ({ overall: '요약', strategies: [{ strategy: 'TSMOM', verdict: 'MIXED', summary: 's', lossCauses: [{ cause: '횡보장 손절', evidence: 'ATR_STOP 5회', severity: 'HIGH' }], suggestions: ['기간 늘리기'] }], portfolioRisks: [], nextSteps: [] });
  assert.equal(ai.analyze().ok, true);
  await waitJob(ai);
  assert.equal(ai.state.analysis.strategies[0].lossCauses[0].severity, 'HIGH');
  const d = diagnose(backtest.last.results[0]);
  assert.ok(d.metrics && d.byExitReason && d.monthlyReturnPct);
});

test('dsl: price operands and HIGHEST/LOWEST read candle fields (prior bars only)', () => {
  const d = validateDsl({ ...EMA_CROSS, indicators: [{ id: 'hh', type: 'HIGHEST', period: 3, source: 'close' }],
    long: { enabled: true, entry: { mode: 'all', rules: [{ left: { kind: 'price', ref: 'close', value: 0, offset: 0, mult: 1 }, op: '>', right: { kind: 'indicator', ref: 'hh', value: 0, offset: 0, mult: 1 } }] }, exit: { mode: 'all', rules: [] } } });
  const flat = Array.from({ length: 80 }, (_, i) => ({ t: i, o: 10, h: 10.5, l: 9.5, c: 10, v: 1, T: i + 1 }));
  const ev = compileDsl(d).prepare([...flat, { t: 80, o: 12, h: 12.5, l: 11.5, c: 12, v: 1, T: 81 }]);
  assert.equal(ev(5).ready, false, 'warm-up respected');
  assert.equal(ev(79).longCond, false, 'close 10 is not above prior high 10.5');
  assert.equal(ev(80).longCond, true, 'close 12 > prior 3-bar high 10.5 (current bar excluded)');
});
