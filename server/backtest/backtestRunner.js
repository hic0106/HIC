// Loads historical Binance data (public endpoints, no API key) and runs the backtester for every strategy.
import fs from 'node:fs';
import path from 'node:path';
import { ALL_STRATEGIES, STRATEGY_CLASS, symbolsForStrategy } from '../strategyRegistry.js';
import { timeframeOf, US_SESSION, TF_MS } from '../scheduler/timeframes.js';
import { SYMBOL_META, isSessionSymbol } from '../assets.js';
import { BinanceUsSessionProvider } from '../dataProviders.js';
import { DATA_DIR } from '../store.js';
import { backtestStrategy, computeMetrics, LIVE_WINDOW } from './backtester.js';

const DAY = 86_400_000;
const FILE = path.join(DATA_DIR, 'backtest-last.json');
const toCandle = (a) => ({ t: a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], v: +a[5], T: a[6] });

export class BacktestRunner {
  constructor({ store, md, log, rest }) {
    this.store = store;
    this.md = md;
    this.log = log;
    this.rest = rest; // public Binance REST client
    this.status = { state: 'IDLE', progress: 0, msg: '' };
    this.last = null;
    this.candles = {};
    try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); this.last = j.result; this.candles = j.candles || {}; } catch { /* none */ }
  }

  async klines(symbol, interval, startTime, endTime) {
    const ms = TF_MS[interval];
    const out = new Map();
    let start = startTime;
    for (let guard = 0; guard < 40 && start < endTime; guard++) {
      const rows = await this.rest.publicGet('/fapi/v1/klines', { symbol, interval, startTime: start, limit: 1500 });
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) { const c = toCandle(r); out.set(c.t, c); }
      const lastT = rows[rows.length - 1][0];
      if (lastT + ms <= start) break; // server ignored startTime
      start = lastT + ms;
      if (rows.length < 1500) break;
    }
    const now = Date.now();
    return [...out.values()].filter((c) => c.T < Math.min(now, endTime + ms)).sort((a, b) => a.t - b.t);
  }

  async fundingRates(symbol, startTime, endTime) {
    const out = [];
    let start = startTime;
    for (let guard = 0; guard < 20 && start < endTime; guard++) {
      const rows = await this.rest.publicGet('/fapi/v1/fundingRate', { symbol, startTime: start, endTime, limit: 1000 });
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) out.push({ time: Number(r.fundingTime), rate: Number(r.fundingRate) });
      const lastT = Number(rows[rows.length - 1].fundingTime);
      if (lastT < start) break;
      start = lastT + 1;
      if (rows.length < 1000) break;
    }
    return out.sort((a, b) => a.time - b.time);
  }

  async sessionCandles(symbol) {
    const st = this.md.s?.[symbol];
    if (st?.daily?.length && st.session) return st.daily;
    const p = new BinanceUsSessionProvider({ rest: this.rest, symbol, listedAt: SYMBOL_META[symbol].listedAt, getCalendar: () => this.store.config.general.usCalendar, log: this.log });
    await p.fetchRange(SYMBOL_META[symbol].listedAt);
    return p.sessions(0);
  }

  // Loads (or reuses, 30 min) candles + funding for the given timeframes. need: [{ s, tf }]
  async loadData(config, days, need, onMsg = () => {}) {
    const end = Date.now();
    const start = end - days * DAY;
    const c = (this.cache && this.cache.days === days && end - this.cache.at < 30 * 60_000) ? this.cache : { days, at: end, start, end, data: {}, funding: {} };
    let k = 0;
    for (const { s, tf } of need) {
      if (c.data[tf]?.[s]) continue;
      onMsg(`loading ${s} ${tf === US_SESSION ? 'US sessions' : tf}`, Math.round((k++ / (need.length + 3)) * 70));
      let rows;
      if (tf === US_SESSION || isSessionSymbol(s)) rows = await this.sessionCandles(s);
      else rows = await this.klines(s, tf, c.start - (LIVE_WINDOW[tf] + 5) * TF_MS[tf], c.end); // live-equivalent warm-up before the start
      (c.data[tf] ||= {})[s] = rows;
    }
    if (config.general.includeFunding) {
      for (const s of new Set(need.map((x) => x.s))) {
        if (c.funding[s]) continue;
        onMsg(`loading ${s} funding history`);
        try { c.funding[s] = await this.fundingRates(s, c.start, c.end); } catch (e) { c.funding[s] = []; this.log.warn(`backtest: ${s} funding history unavailable (${e.message})`, 'BACKTEST'); }
      }
    }
    this.cache = c;
    return c;
  }

  needFor(config, strategies) {
    const need = new Map();
    for (const st of strategies) for (const s of symbolsForStrategy(st)) need.set(`${s}|${timeframeOf(st, config)}`, { s, tf: timeframeOf(st, config) });
    return [...need.values()];
  }

  // One strategy over [from, to) of the loaded period (built-in strategy or AI rule strategy via `custom`)
  runOne({ config, ctx, strategy, custom = null, capital, compound, from = ctx.start, to = ctx.end }) {
    const tf = custom ? custom.timeframe : timeframeOf(strategy, config);
    return backtestStrategy({ strategy: strategy || custom?.meta?.label || 'AI', config, data: ctx.data[tf] || {}, funding: ctx.funding, start: from, end: to, capital, compound, custom });
  }

  // Full period + in-sample (first 70%) + out-of-sample (last 30%) - used by the AI improvement loop
  runSplit(args, isFrac = 0.7) {
    const { ctx } = args;
    const cut = ctx.start + (ctx.end - ctx.start) * isFrac;
    return { full: this.runOne(args), inSample: this.runOne({ ...args, from: ctx.start, to: cut }), outSample: this.runOne({ ...args, from: cut, to: ctx.end }), cut };
  }

  async run({ days = 365, capital = 1_000_000, compound = true, strategies = ALL_STRATEGIES } = {}) {
    if (this.status.state === 'RUNNING') return { ok: false, msg: 'backtest already running' };
    const config = structuredClone(this.store.config); // snapshot of the user's current settings
    this.status = { state: 'RUNNING', progress: 0, msg: 'loading data', startedAt: Date.now() };
    try {
      const ctx = await this.loadData(config, days, this.needFor(config, strategies), (msg, progress) => { this.status.msg = msg; if (progress != null) this.status.progress = progress; });
      const { start, end, data } = ctx;
      const results = [];
      for (const [i, st] of strategies.entries()) {
        this.status.msg = `running ${st}`;
        this.status.progress = 70 + Math.round((i / strategies.length) * 30);
        const r = this.runOne({ config, ctx, strategy: st, capital, compound });
        r.assetClass = STRATEGY_CLASS[st];
        results.push(r);
        await new Promise((res) => setImmediate(res)); // keep the server responsive
      }
      const portfolio = combine(results, capital);
      // candles in the test period for the chart view
      const candles = {};
      for (const [tf, bySym] of Object.entries(data)) for (const [s, rows] of Object.entries(bySym)) {
        candles[`${s}|${tf}`] = rows.filter((c) => c.t >= start - 60 * (TF_MS[tf] || DAY) && c.T < end).map(({ t, o, h, l, c, v, T }) => ({ t, o, h, l, c, v, T }));
      }
      this.candles = candles;
      this.last = {
        ranAt: Date.now(), start, end, days, capital, compound, currency: 'KRW',
        settings: { general: { takerFeePct: config.general.takerFeePct, slippagePct: config.general.slippagePct, includeFunding: config.general.includeFunding } },
        results: results.map((r) => ({ ...r, equity: thin(r.equity, 1500), benchmark: thin(r.benchmark, 1500) })), portfolio,
      };
      try { fs.writeFileSync(FILE, JSON.stringify({ result: this.last, candles })); } catch { /* disk issue: keep in memory */ }
      this.status = { state: 'DONE', progress: 100, msg: 'done', finishedAt: Date.now() };
      this.log.info(`Backtest ${days}d done: ${results.map((r) => `${r.strategy} ${r.metrics.returnPct.toFixed(1)}%`).join(' · ')}`, 'BACKTEST');
      return { ok: true };
    } catch (e) {
      this.status = { state: 'ERROR', progress: 0, msg: e.message };
      this.log.error(`Backtest failed: ${e.message}`, 'BACKTEST');
      return { ok: false, msg: e.message };
    }
  }
}

// keep at most n points (last point always kept)
function thin(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

// Sum of all strategy accounts (each started with `capital`), sampled per UTC day with forward fill.
function combine(results, capital) {
  const days = new Set();
  const perStrat = results.map((r) => {
    const m = new Map();
    for (const p of r.equity) { const d = Math.floor(p.t / DAY); m.set(d, p.equity); days.add(d); }
    return m;
  });
  const sorted = [...days].sort((a, b) => a - b);
  const lastVal = results.map(() => capital);
  const equity = sorted.map((d) => {
    perStrat.forEach((m, i) => { if (m.has(d)) lastVal[i] = m.get(d); });
    return { t: d * DAY, equity: lastVal.reduce((a, x) => a + x, 0) };
  });
  const total = capital * results.length;
  const trades = results.flatMap((r) => r.trades);
  return { capital: total, equity, metrics: computeMetrics({ equity, trades, capital: total, timeline: equity.map((p) => p.t) }) };
}
