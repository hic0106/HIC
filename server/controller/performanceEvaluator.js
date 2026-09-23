// Performance metrics from a strategy's daily mark-to-market equity curve + closed virtual trades.
// Pure functions: no I/O, no side effects.
//
// series: [{ day: 'YYYY-MM-DD', cum }]  cum = cumulative net PnL in units of one slot's notional
// (realized + unrealized, 1.00x baseline sizing). Equity index = 1 + cum / nSlots.

const ANN = Math.sqrt(365);
export const dayNum = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

export function equityCurve(series, nSlots) {
  return series.map((p) => ({ day: p.day, d: dayNum(p.day), eq: 1 + p.cum / nSlots, open: p.open || 0 }));
}

function returnsOf(curve) {
  const out = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].eq;
    if (prev > 0) out.push({ d: curve[i].d, r: curve[i].eq / prev - 1 });
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function std(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

// Equity value at (or last before) day number d; falls back to the first point (partial window).
function eqAt(curve, d) {
  let v = null;
  for (const p of curve) { if (p.d <= d) v = p; else break; }
  return v ?? curve[0];
}

export function windowReturn(curve, days) {
  if (curve.length < 2) return null;
  const end = curve[curve.length - 1];
  const start = eqAt(curve, end.d - days);
  return start.eq > 0 ? end.eq / start.eq - 1 : null;
}

export function drawdowns(curve) {
  let peak = -Infinity, maxDD = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.eq);
    maxDD = Math.min(maxDD, p.eq / peak - 1);
  }
  const last = curve[curve.length - 1];
  return { currentDD: curve.length ? last.eq / peak - 1 : 0, maxDD };
}

export function riskRatios(rets) {
  const r = rets.map((x) => x.r);
  if (r.length < 20) return { sharpe: null, sortino: null, downsideVol: null, vol: null };
  const m = mean(r);
  const s = std(r);
  const downside = Math.sqrt(r.reduce((a, x) => a + Math.min(x, 0) ** 2, 0) / r.length);
  return {
    sharpe: s > 1e-12 ? (m / s) * ANN : null,
    sortino: downside > 1e-12 ? (m / downside) * ANN : null,
    downsideVol: downside * ANN,
    vol: s == null ? null : s * ANN,
  };
}

// Share of positive non-overlapping 30-day blocks (performance consistency).
export function consistency(curve, blockDays = 30) {
  if (curve.length < 2) return { ratio: null, blocks: 0 };
  const endD = curve[curve.length - 1].d;
  let pos = 0, n = 0;
  for (let e = endD; e - blockDays >= curve[0].d; e -= blockDays) {
    const a = eqAt(curve, e - blockDays), b = eqAt(curve, e);
    if (a.eq > 0) { n++; if (b.eq / a.eq - 1 > 0) pos++; }
  }
  return { ratio: n ? pos / n : null, blocks: n };
}

export function tradeStats(trades) {
  const wins = trades.filter((t) => t.ret > 0), losses = trades.filter((t) => t.ret <= 0);
  const gw = wins.reduce((s, t) => s + t.ret, 0), gl = Math.abs(losses.reduce((s, t) => s + t.ret, 0));
  let consec = 0;
  for (const t of [...trades].sort((a, b) => b.exitTime - a.exitTime)) { if (t.ret <= 0) consec++; else break; }
  return {
    tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    avgWin: wins.length ? gw / wins.length : null,
    avgLoss: losses.length ? -gl / losses.length : null,
    profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null),
    consecutiveLosses: consec,
  };
}

/**
 * @param {object} p
 * @param {Array} p.series daily MTM points (sorted by day)
 * @param {Array} p.trades closed virtual trades {exitTime, ret}
 * @param {number} p.nSlots number of symbols the strategy trades (capital normalization)
 * @param {object} p.windows {fast, main, stability, extended}
 * @param {number} p.lowTradeCount if fewer trades than this in the stability window, use the extended window
 * @param {number} p.now ms timestamp
 */
export function computeMetrics({ series, trades, nSlots, windows, lowTradeCount = 5, now = Date.now() }) {
  const curve = equityCurve(series, nSlots);
  const out = { historyDays: curve.length, ret: {}, stabilityWindow: windows.stability };
  if (curve.length < 2) return { ...out, currentDD: 0, maxDD: 0, sharpe: null, sortino: null, downsideVol: null, consistency: null, ...tradeStats([]), exposure: null, daysSinceLastTrade: null };
  const endD = curve[curve.length - 1].d;
  const since = (days) => curve.filter((p) => p.d >= endD - days);
  const tradesSince = (days) => trades.filter((t) => t.exitTime >= now - days * 86_400_000);

  let stab = windows.stability;
  if (windows.extended && tradesSince(stab).length < lowTradeCount) stab = windows.extended; // sparse traders (Turtle)
  out.stabilityWindow = stab;

  out.ret = { fast: windowReturn(curve, windows.fast), main: windowReturn(curve, windows.main), stability: windowReturn(curve, stab) };
  const dd = drawdowns(since(stab));
  const risk = riskRatios(returnsOf(since(windows.main)));
  const cons = consistency(since(stab));
  const mainCurve = since(windows.main);
  const last = trades.reduce((m, t) => Math.max(m, t.exitTime), 0);
  return {
    ...out,
    currentDD: dd.currentDD, maxDD: dd.maxDD,
    ...risk,
    consistency: cons.ratio, consistencyBlocks: cons.blocks,
    ...tradeStats(tradesSince(stab)),
    exposure: mainCurve.length ? mainCurve.filter((p) => p.open > 0).length / mainCurve.length : null,
    daysSinceLastTrade: last ? Math.floor((now - last) / 86_400_000) : null,
  };
}

// Pearson correlation of daily returns between two curves (aligned by day).
export function returnCorrelation(seriesA, seriesB, nSlots, days = 90, minPoints = 30) {
  const ra = new Map(returnsOf(equityCurve(seriesA, nSlots)).map((x) => [x.d, x.r]));
  const rb = returnsOf(equityCurve(seriesB, nSlots));
  const endD = rb.length ? rb[rb.length - 1].d : 0;
  const xs = [], ys = [];
  for (const { d, r } of rb) if (d >= endD - days && ra.has(d)) { xs.push(ra.get(d)); ys.push(r); }
  if (xs.length < minPoints) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
