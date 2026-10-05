import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-rotation-'));
process.env.HIC_LOG_STDOUT = '0';
const { evaluateStrategy, applyRank, applyRegime, momentumAt, bullAddsFor } = await import('../server/strategyRegistry.js');
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
  assert.deepEqual(next.params, { lookback: 21, topK: 3, addGainPct: 15, bullAdds: 1, bullSma: 100, bullPct: 20, rankMode: 'return' });
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

test('bullAddsFor: extra add-ons only while BTC is bullPct above its SMA', () => {
  const c = { params: { bullAdds: 1, bullSma: 10, bullPct: 20 } };
  const flat = bars(path_(20, () => 100));
  const strong = bars([...path_(19, () => 100), 130]); // last close 130 vs SMA10 103 -> +26%
  const mild = bars([...path_(19, () => 100), 115]); // +13%
  assert.equal(bullAddsFor(c, flat, flat.at(-1).T), 0);
  assert.equal(bullAddsFor(c, strong, strong.at(-1).T), 1);
  assert.equal(bullAddsFor(c, mild, mild.at(-1).T), 0);
  assert.equal(bullAddsFor(c, strong, strong.at(-2).T), 0); // only candles closed by closeT
  assert.equal(bullAddsFor({ params: { bullAdds: 0, bullSma: 10 } }, strong, strong.at(-1).T), 0);
});

test('momentumAt volAdj: lookback return divided by sample standard deviation of daily simple returns', () => {
  const b = bars([100, 120, 108, 129.6, 999]);
  const score = momentumAt(b, b[3].T, 3, 'volAdj');
  assert.ok(Math.abs(score - 0.296 / Math.sqrt(0.03)) < 1e-10);
  assert.equal(score, momentumAt(b.slice(0, 4), b[3].T, 3, 'volAdj'), 'future candle is not read');
  assert.equal(momentumAt(b, b[1].T, 3, 'volAdj'), null);
  assert.equal(momentumAt(b, b[3].T + 1, 3, 'volAdj'), null);
});

test('momentumAt volAdj: zero volatility is unrankable, including a constant growth rate', () => {
  const flat = bars([100, 100, 100, 100]);
  const growth = bars([100, 110, 121, 133.1]);
  assert.equal(momentumAt(flat, flat.at(-1).T, 3, 'volAdj'), null);
  assert.equal(momentumAt(growth, growth.at(-1).T, 3, 'volAdj'), null);
});

test('MOM_ROTATION volAdj: a volatile pump loses entry rank to a steadier leader', () => {
  const data = {
    PUMPUSDT: bars([...path_(39, () => 100), 250]),
    STEADYUSDT: bars(path_(40, (i) => 100 * 1.02 ** i * (i % 2 ? 1.005 : 1))),
  };
  const closeT = data.PUMPUSDT.at(-1).T;
  const rank = (mode, symbol, candidates = Object.keys(data)) => {
    const c = cfg({ params: { lookback: 14, topK: 1, rankMode: mode } });
    return applyRank(evaluateStrategy('MOM_ROTATION', data[symbol], c), 'MOM_ROTATION', c, symbol, candidates, (s) => data[s], closeT);
  };
  assert.equal(rank('return', 'PUMPUSDT').longCond, true);
  assert.equal(rank('volAdj', 'PUMPUSDT').longCond, false);
  assert.equal(rank('volAdj', 'STEADYUSDT').longCond, true);
  // A pump is not an unconditional exit rule: a held coin still in topK remains held.
  const held = rank('volAdj', 'PUMPUSDT', ['PUMPUSDT']);
  assert.equal(held.longExit, false);
  assert.equal(held.view.rank, 1);
});

test('MOM_ROTATION: default return mode reproduces legacy ranks and backtest results', async () => {
  const base = structuredClone(DEFAULT_CONFIG);
  base.strategies.MOM_ROTATION = cfg({ params: { lookback: 5, topK: 1 }, maxAdds: 0 });
  const explicit = structuredClone(base);
  explicit.strategies.MOM_ROTATION.params.rankMode = 'return';
  const data = {
    AUSDT: bars(path_(80, (i) => i < 35 ? 100 + i * 2 : 170 - (i - 35))),
    BUSDT: bars(path_(80, (i) => i < 35 ? 100 : 100 + (i - 35) * 2)),
  };
  const args = { strategy: 'MOM_ROTATION', data, start: 0, end: 80 * DAY, capital: 1000, symbols: Object.keys(data) };
  const legacy = await backtestStrategy({ ...args, config: base });
  const current = await backtestStrategy({ ...args, config: explicit });
  assert.deepEqual(current.equity, legacy.equity);
  assert.deepEqual(current.trades, legacy.trades);
  assert.deepEqual(current.metrics, legacy.metrics);
  assert.equal(DEFAULT_CONFIG.strategies.MOM_ROTATION.params.rankMode, 'return');
});

test('MOM_ROTATION rankMode validation: allow return/volAdj, reject others, preserve omitted setting', () => {
  const cur = structuredClone(DEFAULT_CONFIG.strategies.MOM_ROTATION);
  const submit = (rankMode) => ({ ...structuredClone(cur), params: { ...cur.params, rankMode } });
  assert.equal(validateStrategySettings('MOM_ROTATION', submit('volAdj'), cur).params.rankMode, 'volAdj');
  assert.equal(validateStrategySettings('MOM_ROTATION', submit('return'), cur).params.rankMode, 'return');
  for (const invalid of ['sharpe', '', null, 1, true]) {
    assert.throws(() => validateStrategySettings('MOM_ROTATION', submit(invalid), cur), /rank mode/);
  }
  const omitted = structuredClone(cur);
  delete omitted.params.rankMode;
  const enabled = { ...cur, params: { ...cur.params, rankMode: 'volAdj' } };
  assert.equal(validateStrategySettings('MOM_ROTATION', omitted, enabled).params.rankMode, 'volAdj');
  assert.equal(validateStrategySettings('MOM_ROTATION', omitted, omitted).params.rankMode, 'return');
});
