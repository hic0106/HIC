// AI strategy rule format (JSON, declarative). Claude writes strategies in this format; nothing is executed
// as code - the rules are validated and interpreted here with the existing indicator functions.
//   indicators : [{ id, type, period, source }]
//   long/short : { enabled, entry: { mode: all|any, rules[] }, exit: { mode, rules[] } }
//   rule       : { left: operand, op, right: operand }     operand: { kind: indicator|price|value, ref, value, offset, mult }
// Conventions (same as the built-in strategies): signals on CLOSED candles; HIGHEST/LOWEST exclude the current bar.
import { sma, ema, atr, adx } from '../indicators.js';
import { symbolsOfClass } from '../assets.js';

export const IND_TYPES = ['SMA', 'EMA', 'RSI', 'ATR', 'ADX', 'PLUS_DI', 'MINUS_DI', 'HIGHEST', 'LOWEST', 'MOMENTUM_PCT'];
export const PRICE_REFS = ['close', 'open', 'high', 'low', 'volume'];
export const OPS = ['>', '<', '>=', '<=', 'crossAbove', 'crossBelow'];
export const DSL_SYMBOLS = symbolsOfClass('CRYPTO'); // QQQ has too little history for new strategies
const SOURCES = ['close', 'open', 'high', 'low'];
const FIELD = { close: 'c', open: 'o', high: 'h', low: 'l', volume: 'v' }; // candle object keys

// ---- JSON schema for structured outputs (no recursion, all objects closed, all fields required)
const operand = {
  type: 'object', additionalProperties: false, required: ['kind', 'ref', 'value', 'offset', 'mult'],
  properties: {
    kind: { type: 'string', enum: ['indicator', 'price', 'value'] },
    ref: { type: 'string', description: 'indicator id (kind=indicator) or close/open/high/low/volume (kind=price); empty for value' },
    value: { type: 'number', description: 'constant (kind=value); 0 otherwise' },
    offset: { type: 'integer', description: 'bars ago, 0 = the candle that just closed (0-10)' },
    mult: { type: 'number', description: 'multiplier applied to the operand, 1 = none (0.5-2)' },
  },
};
const rule = { type: 'object', additionalProperties: false, required: ['left', 'op', 'right'], properties: { left: operand, op: { type: 'string', enum: OPS }, right: operand } };
const condition = { type: 'object', additionalProperties: false, required: ['mode', 'rules'], properties: { mode: { type: 'string', enum: ['all', 'any'] }, rules: { type: 'array', items: rule } } };
const side = { type: 'object', additionalProperties: false, required: ['enabled', 'entry', 'exit'], properties: { enabled: { type: 'boolean' }, entry: condition, exit: condition } };
export const STRATEGY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'description', 'rationale', 'timeframe', 'symbols', 'indicators', 'long', 'short', 'stop', 'takeProfit', 'resetAfterStop'],
  properties: {
    name: { type: 'string', description: 'short name, letters/digits/underscore' },
    description: { type: 'string', description: 'Korean, 1-3 sentences: entry / exit rules in plain words' },
    rationale: { type: 'string', description: 'Korean: why this should work and when it will fail' },
    timeframe: { type: 'string', enum: ['4h', '1d'] },
    symbols: { type: 'array', items: { type: 'string', enum: DSL_SYMBOLS } },
    indicators: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['id', 'type', 'period', 'source'], properties: {
        id: { type: 'string' }, type: { type: 'string', enum: IND_TYPES }, period: { type: 'integer' }, source: { type: 'string', enum: SOURCES },
      } },
    },
    long: side, short: side,
    stop: { type: 'object', additionalProperties: false, required: ['mode', 'atrPeriod', 'atrMult', 'minPct', 'maxPct', 'fixedPct'], properties: {
      mode: { type: 'string', enum: ['ATR_DYNAMIC', 'FIXED_PERCENT', 'OFF'] }, atrPeriod: { type: 'integer' }, atrMult: { type: 'number' },
      minPct: { type: 'number' }, maxPct: { type: 'number' }, fixedPct: { type: 'number' },
    } },
    takeProfit: { type: 'object', additionalProperties: false, required: ['enabled', 'pct'], properties: { enabled: { type: 'boolean' }, pct: { type: 'number' } } },
    resetAfterStop: { type: 'boolean', description: 'after a stop exit, wait until the entry condition turns false once before re-entering' },
  },
};

// ---- validation (never trust model output)
export function validateDsl(d) {
  const err = [];
  const need = (c, m) => { if (!c) err.push(m); };
  need(d && typeof d === 'object', 'not an object');
  if (err.length) throw new Error(err.join('; '));
  const name = String(d.name || 'AI_STRATEGY').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32) || 'AI_STRATEGY';
  need(['4h', '1d'].includes(d.timeframe), 'timeframe must be 4h or 1d');
  const symbols = [...new Set((d.symbols || []).filter((s) => DSL_SYMBOLS.includes(s)))];
  need(symbols.length > 0, 'at least one symbol');
  const ids = new Set();
  const indicators = (d.indicators || []).slice(0, 12).map((x) => {
    const id = String(x.id || '').toLowerCase();
    need(/^[a-z][a-z0-9_]{0,23}$/.test(id), `bad indicator id "${x.id}"`);
    need(!ids.has(id), `duplicate indicator id "${id}"`);
    ids.add(id);
    need(IND_TYPES.includes(x.type), `bad indicator type ${x.type}`);
    const period = Math.round(Number(x.period));
    need(period >= 1 && period <= 400, `${id}: period 1-400`);
    return { id, type: x.type, period, source: SOURCES.includes(x.source) ? x.source : 'close' };
  });
  const opnd = (o, where) => {
    const kind = o?.kind;
    need(['indicator', 'price', 'value'].includes(kind), `${where}: bad operand kind`);
    if (kind === 'indicator') need(ids.has(String(o.ref).toLowerCase()), `${where}: unknown indicator "${o.ref}"`);
    if (kind === 'price') need(PRICE_REFS.includes(o.ref), `${where}: bad price ref "${o.ref}"`);
    if (kind === 'value') need(Number.isFinite(Number(o.value)), `${where}: bad value`);
    const offset = Math.round(Number(o?.offset) || 0);
    need(offset >= 0 && offset <= 10, `${where}: offset 0-10`);
    let mult = Number(o?.mult);
    if (!Number.isFinite(mult) || mult === 0) mult = 1;
    need(mult >= 0.5 && mult <= 2, `${where}: mult 0.5-2`);
    return { kind, ref: kind === 'indicator' ? String(o.ref).toLowerCase() : kind === 'price' ? o.ref : '', value: Number(o?.value) || 0, offset, mult };
  };
  const cond = (c, where, allowEmpty) => {
    const rules = (c?.rules || []).slice(0, 6).map((r, i) => {
      need(OPS.includes(r?.op), `${where}[${i}]: bad op`);
      return { left: opnd(r?.left, `${where}[${i}].left`), op: r?.op, right: opnd(r?.right, `${where}[${i}].right`) };
    });
    need(allowEmpty || rules.length > 0, `${where}: no rules`);
    return { mode: c?.mode === 'any' ? 'any' : 'all', rules };
  };
  const sideOf = (s, k) => (s?.enabled ? { enabled: true, entry: cond(s.entry, `${k}.entry`, false), exit: cond(s.exit, `${k}.exit`, true) } : { enabled: false, entry: { mode: 'all', rules: [] }, exit: { mode: 'all', rules: [] } });
  const long = sideOf(d.long, 'long');
  const short = sideOf(d.short, 'short');
  need(long.enabled || short.enabled, 'long or short must be enabled');
  const st = d.stop || {};
  const stop = {
    mode: ['ATR_DYNAMIC', 'FIXED_PERCENT', 'OFF'].includes(st.mode) ? st.mode : 'ATR_DYNAMIC',
    atrPeriod: Math.min(200, Math.max(2, Math.round(Number(st.atrPeriod) || 14))), atrMult: Math.min(20, Math.max(0.1, Number(st.atrMult) || 2)),
    minPct: Math.min(90, Math.max(0.1, Number(st.minPct) || 3)), maxPct: Math.min(90, Math.max(0.1, Number(st.maxPct) || 15)), fixedPct: Math.min(90, Math.max(0.1, Number(st.fixedPct) || 8)),
  };
  if (stop.minPct > stop.maxPct) [stop.minPct, stop.maxPct] = [stop.maxPct, stop.minPct];
  for (const [k, s] of [['long', long], ['short', short]]) if (s.enabled && !s.exit.rules.length && stop.mode === 'OFF') err.push(`${k}: needs exit rules or a stop`);
  const takeProfit = { enabled: !!d.takeProfit?.enabled, pct: Math.min(1000, Math.max(0.1, Number(d.takeProfit?.pct) || 20)) };
  if (err.length) throw new Error(err.join('; '));
  return { name, description: String(d.description || ''), rationale: String(d.rationale || ''), timeframe: d.timeframe, symbols, indicators, long, short, stop, takeProfit, resetAfterStop: !!d.resetAfterStop };
}

// ---- interpreter
function rsi(values, period) {
  const out = Array(values.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const up = Math.max(ch, 0), dn = Math.max(-ch, 0);
    if (i <= period) { g += up; l += dn; if (i === period) { g /= period; l /= period; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
    g = (g * (period - 1) + up) / period; l = (l * (period - 1) + dn) / period;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function priorExtreme(bars, key, period, fn) {
  const out = Array(bars.length).fill(null);
  for (let i = period; i < bars.length; i++) { let v = bars[i - 1][key]; for (let j = i - period; j < i; j++) v = fn(v, bars[j][key]); out[i] = v; }
  return out;
}
function series(ind, bars) {
  const src = bars.map((b) => b[FIELD[ind.source]]);
  switch (ind.type) {
    case 'SMA': return sma(src, ind.period);
    case 'EMA': return ema(src, ind.period);
    case 'RSI': return rsi(src, ind.period);
    case 'ATR': return atr(bars, ind.period);
    case 'ADX': return adx(bars, ind.period).adx;
    case 'PLUS_DI': return adx(bars, ind.period).plusDI;
    case 'MINUS_DI': return adx(bars, ind.period).minusDI;
    case 'HIGHEST': return priorExtreme(bars, ind.source === 'close' ? 'h' : FIELD[ind.source], ind.period, Math.max);
    case 'LOWEST': return priorExtreme(bars, ind.source === 'close' ? 'l' : FIELD[ind.source], ind.period, Math.min);
    case 'MOMENTUM_PCT': return src.map((v, i) => (i >= ind.period ? (v / src[i - ind.period] - 1) * 100 : null));
    default: return Array(bars.length).fill(null);
  }
}

export function compileDsl(dsl) {
  const warm = Math.max(2, ...dsl.indicators.map((x) => (['ADX', 'PLUS_DI', 'MINUS_DI'].includes(x.type) ? x.period * 2 + 2 : x.period + 2)), dsl.stop.atrPeriod + 2) + 11;
  return {
    timeframe: dsl.timeframe, symbols: dsl.symbols, warm,
    cfg: { params: {}, stop: dsl.stop, takeProfit: dsl.takeProfit, shortEnabled: dsl.short.enabled, enabled: true },
    meta: { supportsShort: dsl.short.enabled, resetAfterStop: dsl.resetAfterStop, label: dsl.name },
    prepare(bars) {
      const S = {};
      for (const ind of dsl.indicators) S[ind.id] = series(ind, bars);
      const atrS = atr(bars, dsl.stop.atrPeriod);
      const val = (o, i) => {
        const j = i - o.offset;
        if (j < 0) return null;
        let v = o.kind === 'value' ? o.value : o.kind === 'price' ? bars[j][FIELD[o.ref]] : S[o.ref][j];
        return v == null || !Number.isFinite(v) ? null : v * o.mult;
      };
      const test = (r, i) => {
        const a = val(r.left, i), b = val(r.right, i);
        if (a == null || b == null) return false;
        if (r.op === '>') return a > b; if (r.op === '<') return a < b; if (r.op === '>=') return a >= b; if (r.op === '<=') return a <= b;
        const a0 = val(r.left, i - 1), b0 = val(r.right, i - 1);
        if (a0 == null || b0 == null) return false;
        return r.op === 'crossAbove' ? a > b && a0 <= b0 : a < b && a0 >= b0;
      };
      const check = (c, i) => (c.rules.length ? (c.mode === 'all' ? c.rules.every((r) => test(r, i)) : c.rules.some((r) => test(r, i))) : false);
      return (i) => {
        if (i < warm) return { ready: false, reason: `warm-up (${i + 1}/${warm})` };
        return {
          ready: true, candleTime: bars[i].t, close: bars[i].c, atr: atrS[i],
          longCond: dsl.long.enabled && check(dsl.long.entry, i), longExit: dsl.long.enabled ? check(dsl.long.exit, i) : true,
          shortCond: dsl.short.enabled && check(dsl.short.entry, i), shortExit: dsl.short.enabled ? check(dsl.short.exit, i) : true,
        };
      };
    },
  };
}

// Korean one-line rendering of rules for the UI
export function describeRules(dsl) {
  const o = (x) => (x.kind === 'value' ? String(x.value) : `${x.ref}${x.offset ? `[${x.offset}봉 전]` : ''}${x.mult !== 1 ? `×${x.mult}` : ''}`);
  const opK = { '>': '>', '<': '<', '>=': '≥', '<=': '≤', crossAbove: '상향돌파', crossBelow: '하향돌파' };
  const c = (cd) => (cd.rules.length ? cd.rules.map((r) => `${o(r.left)} ${opK[r.op]} ${o(r.right)}`).join(cd.mode === 'all' ? ' 그리고 ' : ' 또는 ') : '(없음 — 손절/익절로만 청산)');
  const ind = dsl.indicators.map((x) => `${x.id}=${x.type}(${x.period}${x.source !== 'close' ? `,${x.source}` : ''})`).join(', ');
  return { indicators: ind, longEntry: dsl.long.enabled ? c(dsl.long.entry) : null, longExit: dsl.long.enabled ? c(dsl.long.exit) : null, shortEntry: dsl.short.enabled ? c(dsl.short.entry) : null, shortExit: dsl.short.enabled ? c(dsl.short.exit) : null };
}
