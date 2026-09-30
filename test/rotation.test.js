import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-rotation-'));
process.env.HIC_LOG_STDOUT = '0';
const { evaluateStrategy, applyRank, applyRegime, momentumAt } = await import('../server/strategyRegistry.js');
const { DEFAULT_CONFIG } = await import('../server/store.js');
const { backtestStrategy } = await import('../server/backtest/backtester.js');
const { validateStrategySettings, addGainOk } = await import('../server/strategyConfig.js');

const DAY = 86_400_000;
const bars = (closes) => closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { t: i * DAY, T: (i + 1) * DAY - 1, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1, qv: 1 }; });
const path_ = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const cfg = (over = {}) => ({ ...structuredClone(DEFAULT_CONFIG.strategies.MOM_ROTATION), regime: null, ...over });

test('momentumAt: return over lookback on the candle closing at closeT, null when that candle is missing', () => {
  const b = bars([100, 110, 121, 133.1]);
  assert.ok(Math.abs(momentumAt(b, b[3].T, 2) - 0.21) < 1e-9);
  assert.equal(momentumAt(b, b[3].T + DAY, 2), null);
  assert.equal(momentumAt(b, b[1].T, 2), null); // not enough history
});

test('MOM_ROTATION: evaluate alone never enters; applyRank longs the topK and exits the rest', () => {
  const c = cfg({ params: { lookback: 14, topK: 1 } });
  const data = { AUSDT: bars(path_(40, (i) => 100 + i * 2)), BUSDT: bars(path_(40, (i) => 100 + i)), CUSDT: bars(path_(40, (i) => 100 - i)) };
  const closeT = data.AUSDT.at(-1).T;
  const raw = evaluateStrategy('MOM_ROTATION', data.BUSDT, c);
  assert.equal(raw.ready, true);
  assert.equal(raw.longCond, false);
  const rank = (s) => applyRank(evaluateStrategy('MOM_ROTATION', data[s], c), 'MOM_ROTATION', c, s, Object.keys(data), (x) => data[x], closeT);
  assert.equal(rank('AUSDT').longCond, true);
  assert.equal(rank('AUSDT').view.rank, 1);
  assert.equal(rank('BUSDT').longCond, false);
  assert.equal(rank('BUSDT').longExit, true);
  // not among the candidates (outside the entry universe) -> exit
  const out = applyRank(evaluateStrategy('MOM_ROTATION', data.AUSDT, c), 'MOM_ROTATION', c, 'AUSDT', ['BUSDT'], (x) => data[x], closeT);
  assert.equal(out.longExit, true);
});

test('MOM_ROTATION: BTC below its SMA blocks the long even at rank 1 (regime exit closes it)', () => {
  const c = cfg({ params: { lookback: 14, topK: 1 }, regime: { sma: 20, exit: true } });
  const a = bars(path_(40, (i) => 100 + i * 2));
  const btc = bars(path_(40, (i) => 200 - i)); // falling: close < SMA20
  const sig = applyRank(applyRegime(evaluateStrategy('MOM_ROTATION', a, c), c, btc, a.at(-1).T), 'MOM_ROTATION', c, 'AUSDT', ['AUSDT'], () => a, a.at(-1).T);
  assert.equal(sig.longCond, false);
  assert.equal(sig.longExit, true);
});

test('MOM_ROTATION backtest: leadership switch rotates the position, never more than topK open', async () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.strategies.MOM_ROTATION = cfg({ params: { lookback: 5, topK: 1 } });
  // A leads for 30 days then falls; B flat then rallies
  const data = {
    AUSDT: bars(path_(80, (i) => (i < 30 ? 100 + i * 3 : 190 - (i - 30) * 2))),
    BUSDT: bars(path_(80, (i) => (i < 30 ? 100 : 100 + (i - 30) * 3))),
  };
  const r = await backtestStrategy({ strategy: 'MOM_ROTATION', config: c, data, start: 0, end: 80 * DAY, capital: 1000, symbols: ['AUSDT', 'BUSDT'] });
  assert.deepEqual(r.trades.map((t) => t.symbol), ['AUSDT']);
  assert.deepEqual(r.openPositions.map((p) => p.symbol), ['BUSDT']); // B still held at the end
  const a = r.trades[0], b = r.openPositions[0];
  assert.equal(a.reason, 'STRATEGY_EXIT');
  assert.equal(a.exitTime, b.entryTime, 'old leader exits at the same open the new one enters (slots never full)');
  assert.equal(r.skipped.slotsFull, 0);
});

test('MOM_ROTATION settings are validated', () => {
  const cur = DEFAULT_CONFIG.strategies.MOM_ROTATION;
  const next = validateStrategySettings('MOM_ROTATION', { ...structuredClone(cur), params: { lookback: '21', topK: '3', addGainPct: '15' } }, cur);
  assert.deepEqual(next.params, { lookback: 21, topK: 3, addGainPct: 15 });
  assert.deepEqual(next.regime, { sma: 100, exit: true });
  assert.throws(() => validateStrategySettings('MOM_ROTATION', { ...structuredClone(cur), params: { lookback: 14, topK: 50 } }, cur));
});

test('addGainOk: add-on only while the position is up >= params.addGainPct from the average entry', () => {
  const c = { params: { addGainPct: 10 } };
  assert.equal(addGainOk(c, 'LONG', 100, 109), false);
  assert.equal(addGainOk(c, 'LONG', 100, 110), true);
  assert.equal(addGainOk(c, 'SHORT', 100, 90), true);
  assert.equal(addGainOk({ params: {} }, 'LONG', 100, 50), true); // no gate
});

test('MOM_ROTATION backtest: add-ons go to the winner only, at most maxAdds', async () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.strategies.MOM_ROTATION = cfg({ params: { lookback: 5, topK: 2, addGainPct: 10 }, maxAdds: 3 });
  // A climbs steadily (adds), B sits at the top-2 border without gaining (no adds), C falls (never held)
  const data = {
    AUSDT: bars(path_(60, (i) => 100 * 1.03 ** i)),
    BUSDT: bars(path_(60, (i) => 100 + (i % 2))),
    CUSDT: bars(path_(60, (i) => 100 - i)),
  };
  const r = await backtestStrategy({ strategy: 'MOM_ROTATION', config: c, data, start: 0, end: 60 * DAY, capital: 1000, symbols: ['AUSDT', 'BUSDT', 'CUSDT'] });
  const a = r.openPositions.find((p) => p.symbol === 'AUSDT'), b = r.openPositions.find((p) => p.symbol === 'BUSDT');
  assert.equal(r.adds, 3);
  assert.ok(a.notional > 3.9 * b.notional, `winner holds 4 units: A ${a.notional} vs B ${b.notional}`);
});
