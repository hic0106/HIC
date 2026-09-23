// Controller decision rules. Pure, deterministic, every decision carries its reasons.
// The controller only chooses a status from a fixed ladder; each status maps to a bounded multiplier.

export const STATUS_ORDER = ['PAUSED', 'REDUCED', 'CAUTIOUS', 'NORMAL', 'BOOSTED'];
export const MAX_MULTIPLIER = 1.25; // hard ceiling, never configurable above this
export const DEFAULT_MULTIPLIERS = { PAUSED: 0, REDUCED: 0.5, CAUTIOUS: 0.75, NORMAL: 1, BOOSTED: 1.25 };

const rank = (s) => STATUS_ORDER.indexOf(s);
const minStatus = (a, b) => (rank(a) <= rank(b) ? a : b);
const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const pct = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);

// Validated multiplier table: monotonic, 0 <= m <= 1.25, NORMAL = 1. Invalid config -> defaults.
export function multiplierTable(cfg) {
  const t = { ...DEFAULT_MULTIPLIERS, ...(cfg || {}) };
  let prev = -1;
  for (const s of STATUS_ORDER) {
    const v = t[s];
    if (!Number.isFinite(v) || v < 0 || v > MAX_MULTIPLIER || v < prev) return { ...DEFAULT_MULTIPLIERS };
    prev = v;
  }
  if (t.NORMAL !== 1 || t.PAUSED !== 0) return { ...DEFAULT_MULTIPLIERS };
  return t;
}

// Normalized score components in [-1, 1]; weighted sum in [-1, 1].
export function scoreMetrics(m, cfg) {
  const s = cfg.scale;
  const w = cfg.weights;
  const components = {
    return: m.ret.main == null ? 0 : clamp((m.ret.main * 100) / s.returnPct),
    drawdown: clamp(1 - (2 * Math.abs(m.currentDD) * 100) / s.drawdownPct),
    riskAdjusted: clamp(((m.sharpe ?? 0) / s.sharpe + (m.sortino ?? 0) / s.sortino) / 2),
    consistency: m.consistency == null ? 0 : clamp(2 * m.consistency - 1),
  };
  // long-term check: negative stability-window return pulls consistency down
  if (m.ret.stability != null && m.ret.stability < 0) components.consistency = clamp(components.consistency - 0.5);
  const wsum = w.return + w.drawdown + w.riskAdjusted + w.consistency || 1;
  const score = (components.return * w.return + components.drawdown * w.drawdown + components.riskAdjusted * w.riskAdjusted + components.consistency * w.consistency) / wsum;
  return { score: clamp(score), components };
}

function statusFromScore(score, th) {
  if (score >= th.boost) return 'BOOSTED';
  if (score >= th.normal) return 'NORMAL';
  if (score >= th.cautious) return 'CAUTIOUS';
  return 'REDUCED'; // PAUSED only via the drawdown guard
}

/**
 * @returns {{status, score, components, reasons: string[], guards: string[]}}
 */
export function decide({ metrics: m, prevStatus = 'NORMAL', side, regime, sideActive = true, exposureFlag = null, correlationFlag = null, cfg }) {
  const reasons = [];
  const guards = [];
  if (!sideActive) return { status: 'NORMAL', score: null, components: null, reasons: ['side not traded (disabled / not supported) — no change'], guards };
  if (!m || m.historyDays < cfg.minHistoryDays) {
    return { status: 'NORMAL', score: null, components: null, reasons: [`insufficient history: ${m?.historyDays ?? 0}/${cfg.minHistoryDays} daily equity records — kept NORMAL`], guards };
  }
  const { score, components } = scoreMetrics(m, cfg);
  let status = statusFromScore(score, cfg.thresholds);
  reasons.push(`score ${score.toFixed(2)} (ret ${components.return.toFixed(2)}, dd ${components.drawdown.toFixed(2)}, risk ${components.riskAdjusted.toFixed(2)}, cons ${components.consistency.toFixed(2)}) → ${status}`);
  reasons.push(`90D return ${pct(m.ret.main)}, ${m.stabilityWindow}D ${pct(m.ret.stability)}, 30D ${pct(m.ret.fast)}`);
  reasons.push(`current DD ${pct(m.currentDD)}, max DD ${pct(m.maxDD)}, Sharpe ${m.sharpe?.toFixed(2) ?? '—'}, Sortino ${m.sortino?.toFixed(2) ?? '—'}`);

  // ---- caps (guards only ever lower the status)
  let cap = 'BOOSTED';
  const g = cfg.guards;
  const dd = Math.abs(m.currentDD) * 100;
  const capTo = (s, why) => { if (rank(s) < rank(cap)) cap = s; guards.push(why); };
  if (dd >= g.pauseDDPct) { status = 'PAUSED'; capTo('PAUSED', `drawdown ${dd.toFixed(1)}% >= ${g.pauseDDPct}% → PAUSED`); }
  else if (dd >= g.reduceDDPct) capTo('REDUCED', `drawdown ${dd.toFixed(1)}% >= ${g.reduceDDPct}% → max REDUCED`);
  else if (dd >= g.noBoostDDPct) capTo('NORMAL', `drawdown ${dd.toFixed(1)}% >= ${g.noBoostDDPct}% → boost blocked`);
  if (m.consecutiveLosses >= g.cautionConsecLosses && (m.ret.main ?? 0) < 0) capTo('CAUTIOUS', `${m.consecutiveLosses} consecutive losses with negative 90D return → max CAUTIOUS`);
  else if (m.consecutiveLosses >= g.noBoostConsecLosses) capTo('NORMAL', `${m.consecutiveLosses} consecutive losses → boost blocked`);
  if (regime === 'HIGH_VOLATILITY') capTo(g.highVolCap, `HIGH_VOLATILITY regime → max ${g.highVolCap}`);
  if (regime === 'SIDEWAYS') capTo('NORMAL', 'SIDEWAYS regime → trend-following boost blocked');
  const boostRegimes = cfg.boostRegimes[side] || [];
  if (!boostRegimes.includes(regime)) capTo('NORMAL', `${side} boost not allowed in ${regime}`);
  if (exposureFlag) capTo('NORMAL', exposureFlag);
  if (correlationFlag) capTo('NORMAL', correlationFlag);
  status = minStatus(status, cap);

  // ---- change-rate limits: at most one step up per evaluation; no increase after recent losses
  if (rank(status) > rank(prevStatus)) {
    if ((m.ret.fast ?? 0) < 0) { guards.push(`30D return ${pct(m.ret.fast)} negative → no increase after losses`); status = prevStatus; }
    else if (rank(status) > rank(prevStatus) + 1) { guards.push(`upgrade limited to one step (${prevStatus} → ${STATUS_ORDER[rank(prevStatus) + 1]})`); status = STATUS_ORDER[rank(prevStatus) + 1]; }
  }
  return { status, score, components, reasons, guards };
}
