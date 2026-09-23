// Stored account equity history (per trading mode) for the equity curve and drawdown.
//   points : one per 5 min, last 35 days
//   daily  : last value per UTC day, kept indefinitely (3M / ALL ranges)
// Each point: { t, equity, wallet, unrealized, flow, strat: { STRATEGY: cumulative net PnL } }
// flow = cumulative deposits/withdrawals (LIVE TRANSFER income) so drawdown is not distorted by transfers.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../store.js';

const FILE = path.join(DATA_DIR, 'portfolio-history.json');
const STEP_MS = 5 * 60_000;
const KEEP_MS = 35 * 86_400_000;
const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);

const emptyMode = () => ({ points: [], daily: [], income: [], incomeCursor: null, flow: 0 });

export class EquityHistory {
  constructor({ file = FILE, persist = true } = {}) {
    this.file = file;
    this.persist = persist;
    let s = {};
    if (persist) { try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { s = {}; } }
    this.state = { modes: { PAPER: { ...emptyMode(), ...(s.modes?.PAPER || {}) }, LIVE: { ...emptyMode(), ...(s.modes?.LIVE || {}) } } };
    this._timer = null;
  }

  m(mode) { return this.state.modes[mode]; }

  record(mode, pt, now = Date.now()) {
    if (!(Number.isFinite(pt.equity))) return;
    const m = this.m(mode);
    m.trackStart ??= now;
    const p = { t: now, ...pt, flow: m.flow || 0 };
    const last = m.points.at(-1);
    if (last && now - last.t < STEP_MS) m.points[m.points.length - 1] = { ...p, t: last.t, tLast: now };
    else m.points.push(p);
    while (m.points.length && now - m.points[0].t > KEEP_MS) m.points.shift();
    const day = utcDay(now);
    const d = m.daily.at(-1);
    const dp = { ...p, day, open: d && d.day === day ? d.open : pt.equity };
    if (d && d.day === day) m.daily[m.daily.length - 1] = dp; else m.daily.push(dp);
    this.save();
  }

  // Equity at the start of the UTC day (first recorded value of the day)
  dayOpen(mode, now = Date.now()) {
    const d = this.m(mode).daily.at(-1);
    return d && d.day === utcDay(now) ? d.open : null;
  }

  series(mode, range, now = Date.now()) {
    const m = this.m(mode);
    const span = { '1D': 86_400_000, '7D': 7 * 86_400_000, '1M': 30 * 86_400_000, '3M': 90 * 86_400_000 }[range];
    if (range === '1D' || range === '7D' || range === '1M') return m.points.filter((p) => now - p.t <= span);
    const from = span ? now - span : 0;
    const firstPoint = m.points[0]?.t ?? Infinity;
    const older = m.daily.filter((p) => p.t >= from && p.t < firstPoint);
    return [...older, ...m.points.filter((p) => p.t >= from)];
  }

  // Drawdown on flow-adjusted equity (transfers excluded)
  drawdown(mode) {
    const m = this.m(mode);
    const all = [...m.daily.filter((p) => p.t < (m.points[0]?.t ?? Infinity)), ...m.points];
    let peak = -Infinity, maxDd = 0, cur = 0;
    for (const p of all) {
      const v = p.equity - (p.flow || 0);
      if (v > peak) peak = v;
      const dd = peak > 0 ? (peak - v) / peak * 100 : 0;
      if (dd > maxDd) maxDd = dd;
      cur = dd;
    }
    return { currentPct: all.length ? cur : null, maxPct: all.length ? maxDd : null, peak: Number.isFinite(peak) ? peak : null, samples: all.length };
  }

  addIncome(mode, rows) {
    const m = this.m(mode);
    const seen = new Set(m.income.map((r) => `${r.incomeType}:${r.tranId}`));
    let added = 0;
    for (const r of rows) {
      const k = `${r.incomeType}:${r.tranId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const row = { symbol: r.symbol || '', incomeType: r.incomeType, income: Number(r.income), asset: r.asset, time: Number(r.time), tranId: String(r.tranId) };
      m.income.push(row);
      // only transfers after tracking started shift the curve baseline
      if (row.incomeType === 'TRANSFER' && row.asset === 'USDT' && m.trackStart != null && row.time >= m.trackStart) m.flow = (m.flow || 0) + row.income;
      added++;
    }
    m.income.sort((a, b) => a.time - b.time);
    const cut = Date.now() - 95 * 86_400_000;
    while (m.income.length && m.income[0].time < cut) m.income.shift();
    if (added) this.save();
    return added;
  }

  save() {
    if (!this.persist || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.saveNow(); }, 10_000);
    this._timer.unref?.();
  }

  saveNow() {
    if (!this.persist) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch { /* never block trading */ }
  }
}
