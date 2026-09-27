import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-vbo-'));
process.env.HIC_LOG_STDOUT = '0';

const { evaluate, exitFor } = await import('../server/strategies.js');
const { impliedSide } = await import('../server/strategyRegistry.js');
const { DEFAULT_CONFIG } = await import('../server/store.js');
const { validateStrategySettings } = await import('../server/strategyConfig.js');

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
// 1h candles: slow uptrend (above EMA200) with small ranges; `last` = close of the final candle
const bars = (n, last) => Array.from({ length: n }, (_, i) => {
  const c = i === n - 1 && last != null ? last : 100 * 1.0005 ** i;
  const o = i ? 100 * 1.0005 ** (i - 1) : c;
  return { t: T0 + i * H, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1, T: T0 + (i + 1) * H - 1 };
});
const cfg = () => ({ ...structuredClone(DEFAULT_CONFIG.strategies.VOL_BREAKOUT), shortEnabled: true });

test('Vol Breakout: long only on the candle that crosses day open + k x ATR, with the trend', () => {
  const base = bars(300);
  const day0 = Math.floor(base[299].t / 86_400_000) * 86_400_000;
  const open = base.find((c) => c.t >= day0).o;
  const s0 = evaluate('VOL_BREAKOUT', base, cfg());
  assert.equal(s0.ready, true);
  assert.equal(s0.longCond, false, 'no breakout in a quiet trend');
  const up = evaluate('VOL_BREAKOUT', bars(300, s0.view.upper * 1.01), cfg());
  assert.ok(up.view.dayOpen === open);
  assert.equal(up.longCond, true);
  const dn = evaluate('VOL_BREAKOUT', bars(300, s0.view.lower * 0.99), cfg());
  assert.equal(dn.shortCond, false, 'no short above the trend EMA');
});

test('Vol Breakout: time exit after maxHoldBars, trail exit otherwise', () => {
  const s = evaluate('VOL_BREAKOUT', bars(300), cfg());
  const hold = cfg().params.maxHoldBars;
  const pos = (barsAgo) => ({ side: 'LONG', entryTime: s.candleTime + s.barMs - barsAgo * H });
  assert.deepEqual(exitFor('VOL_BREAKOUT', { ...s, longExit: false }, pos(hold - 1)), { exit: false, reason: 'STRATEGY_EXIT' });
  assert.deepEqual(exitFor('VOL_BREAKOUT', { ...s, longExit: false }, pos(hold)), { exit: true, reason: 'TIME_EXIT' });
  assert.deepEqual(exitFor('VOL_BREAKOUT', { ...s, longExit: false }, { side: 'LONG', time: s.candleTime + s.barMs - hold * H }), { exit: true, reason: 'TIME_EXIT' }, 'backtester position (time)');
  // other strategies have no holding limit
  assert.equal(exitFor('TURTLE', { longExit: false }, { side: 'LONG', entryTime: 0 }).exit, false);
});

test('Vol Breakout: START sync never joins a breakout older than the holding limit', () => {
  const b = bars(300);
  const s0 = evaluate('VOL_BREAKOUT', b.slice(0, 280), cfg());
  b[279] = { ...b[279], c: s0.view.upper * 1.01, h: s0.view.upper * 1.02 }; // breakout 20 bars ago
  const recent = impliedSide('VOL_BREAKOUT', b, cfg());
  assert.equal(recent?.side ?? null, recent ? 'LONG' : null);
  const short = impliedSide('VOL_BREAKOUT', b, { ...cfg(), params: { ...cfg().params, maxHoldBars: 5 } });
  assert.equal(short, null, '20 bars > 5-bar holding limit');
});

test('Vol Breakout settings are validated', () => {
  const cur = cfg();
  assert.equal(validateStrategySettings('VOL_BREAKOUT', { ...cur, params: { ...cur.params, k: 2.5 } }, cur).params.k, 2.5);
  assert.throws(() => validateStrategySettings('VOL_BREAKOUT', { ...cur, params: { ...cur.params, maxHoldBars: 0 } }, cur));
});

test('Vol Breakout: stricter short side (own k, EMA falling, own holding time)', () => {
  const down = Array.from({ length: 300 }, (_, i) => 100 * 0.9995 ** i);
  const mk = (closes) => closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { t: T0 + i * H, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1, T: T0 + (i + 1) * H - 1 }; });
  const c = cfg();
  const s0 = evaluate('VOL_BREAKOUT', mk(down), c);
  assert.ok(s0.view.lower < s0.view.dayOpen);
  const crash = (lv) => mk([...down.slice(0, 299), lv]);
  // between k3 and k5: a long would count, a short needs the full shortK = 5
  const mid = s0.view.dayOpen - (s0.view.dayOpen - s0.view.lower) * 0.8;
  assert.equal(evaluate('VOL_BREAKOUT', crash(mid), c).shortCond, false);
  assert.equal(evaluate('VOL_BREAKOUT', crash(s0.view.lower * 0.99), c).shortCond, true);
  // crash below the EMA while the EMA is still rising vs 72 bars ago -> no short
  const rising = Array.from({ length: 299 }, (_, i) => 100 * 1.0003 ** i);
  const r = evaluate('VOL_BREAKOUT', mk([...rising, 80]), c);
  assert.ok(r.close < r.view.lower && r.close < r.view.trend, 'crossed the level and below the EMA');
  assert.equal(r.shortCond, false);
  assert.equal(evaluate('VOL_BREAKOUT', mk([...rising, 80]), { ...c, params: { ...c.params, shortSlopeBars: 0 } }).shortCond, true, 'slope filter off -> short');
  // own holding time for shorts
  const hold = (side) => exitFor('VOL_BREAKOUT', { ...s0, shortExit: false, longExit: false }, { side, entryTime: s0.candleTime + s0.barMs - 12 * H }).reason;
  assert.equal(hold('SHORT'), 'TIME_EXIT');
  assert.equal(hold('LONG'), 'STRATEGY_EXIT');
});
