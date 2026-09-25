import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HIC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hic-rider-'));
process.env.HIC_LOG_STDOUT = '0';

const { evaluate } = await import('../server/strategies.js');
const { DEFAULT_CONFIG } = await import('../server/store.js');
const { validateStrategySettings } = await import('../server/strategyConfig.js');

const D = 86_400_000;
const bars = (closes) => closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { t: i * D, o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: 1, T: (i + 1) * D - 1 }; });
const cfg = () => structuredClone(DEFAULT_CONFIG.strategies.TREND_RIDER);
const up = Array.from({ length: 260 }, (_, i) => 100 * 1.003 ** i);
const dn = Array.from({ length: 260 }, (_, i) => 100 * 0.997 ** i);

test('Trend Rider: breakout only with the SMA trend, Chandelier trailing exit', () => {
  const long = evaluate('TREND_RIDER', bars([...up, up.at(-1) * 1.02]), cfg());
  assert.equal(long.ready, true);
  assert.equal(long.longCond, true);
  assert.equal(long.shortCond, false, 'no short above the SMA');
  assert.equal(long.longExit, false);
  assert.ok(long.view.longTrail < long.close);

  // sharp drop below HH(22) - 3 x ATR(22): long exit (trend still above SMA200, no short)
  const crash = [...up, up.at(-1) * 0.9];
  const ex = evaluate('TREND_RIDER', bars(crash), cfg());
  assert.equal(ex.longExit, true);
  assert.equal(ex.shortCond, false);

  const short = evaluate('TREND_RIDER', bars([...dn, dn.at(-1) * 0.98]), cfg());
  assert.equal(short.shortCond, true);
  assert.equal(short.longCond, false, 'no long below the SMA');

  assert.equal(evaluate('TREND_RIDER', bars(up.slice(0, 100)), cfg()).ready, false);
});

test('Trend Rider settings are validated', () => {
  const cur = cfg();
  const next = validateStrategySettings('TREND_RIDER', { ...cur, params: { ...cur.params, trailMult: 4 } }, cur);
  assert.equal(next.params.trailMult, 4);
  assert.throws(() => validateStrategySettings('TREND_RIDER', { ...cur, params: { ...cur.params, trailMult: 0 } }, cur));
});
