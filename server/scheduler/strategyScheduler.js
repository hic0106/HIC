// StrategyScheduler: decides WHEN each strategy instance (strategy × symbol × timeframe) is evaluated.
//   - driven by candle-close events from market data (kline x=true / US session close), not by wall clock
//   - wall clock is only used for UI (next expected candle) and as a fallback when a close event was missed
//   - dedup key (strategy, symbol, timeframe, candle close time) persisted in state -> survives restarts
//   - restart / late start: only the latest closed candle is evaluated; exits run, stale entries are skipped
// It never manages stops (RiskMonitor does) and never changes strategy rules or order logic.
import { strategiesForSymbol, STRATEGY_CLASS } from '../strategyRegistry.js';
import { SYMBOLS } from '../store.js';
import { SYMBOL_META } from '../assets.js';
import { marketStatus, nextSessionClose, DEFAULT_US_CALENDAR } from '../session.js';
import { timeframeOf, barsFor, scheduleTypeOf, TF_MS, TF_LABEL, US_SESSION } from './timeframes.js';

export const DEFAULT_SCHEDULER_CONFIG = {
  // A NEW entry is only executed if the signal candle closed at most this many minutes ago.
  entryGraceMin: { '5m': 3, '4h': 30, '1d': 120, [US_SESSION]: 120 },
  retrySec: 15, // fallback check / retry of transient skips (same candle only)
};

const B = (x) => (x ? 'True' : 'False');
const n = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(d));
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

// Human-readable condition summary for the Signal Log (values come from the strategy's own evaluation).
export function describeSignal(strategy, sig, scfg) {
  if (!sig?.ready) return sig?.reason || 'not ready';
  const p = scfg.params, v = sig.view || {};
  switch (strategy) {
    case 'TURTLE': return `${p.entryPeriod}H Breakout=${B(sig.longCond)} ${p.entryPeriod}L Breakdown=${B(sig.shortCond)} ${p.exitPeriod}L Exit=${B(sig.longExit)} ${p.exitPeriod}H Exit=${B(sig.shortExit)}`;
    case 'ADX': return `ADX=${n(v.adx, 1)} +DI=${n(v.plusDI, 1)} -DI=${n(v.minusDI, 1)} Long=${B(sig.longCond)} Short=${B(sig.shortCond)} LongExit=${B(sig.longExit)} ShortExit=${B(sig.shortExit)}`;
    case 'TSMOM': return `Mom${p.lookback}=${pct(v.momentumPct)} Long=${B(sig.longCond)} Exit=${B(sig.longExit)}`;
    case 'RAYNER': return `EMA${p.emaPeriod}=${n(v.ema, 4)} Hist=${n(v.hist, 6)} LongTarget=${n(v.longTarget, 6)} ShortTarget=${n(v.shortTarget, 6)} Long=${B(sig.longCond)} Short=${B(sig.shortCond)} LongExit=${B(sig.longExit)} ShortExit=${B(sig.shortExit)}`;
    case 'QQQ_EMA_TREND': return `EMA${p.fastEma}=${n(v.fastEma)} EMA${p.slowEma}=${n(v.slowEma)} Long=${B(sig.longCond)} Exit=${B(sig.longExit)}`;
    case 'QQQ_TSMOM': return `Mom${p.lookback}=${pct(v.momentumPct)} Long=${B(sig.longCond)} Exit=${B(sig.longExit)}`;
    case 'QQQ_SMA200': return `SMA${p.smaPeriod}=${n(v.sma)} Long=${B(sig.longCond)} Exit=${B(sig.longExit)}`;
    case 'QQQ_TURTLE_50_20': return `${p.entryPeriod}H Breakout=${B(sig.longCond)} ${p.exitPeriod}L Exit=${B(sig.longExit)}`;
    default: return `Long=${B(sig.longCond)} Short=${B(sig.shortCond)}`;
  }
}

export class StrategyScheduler {
  constructor({ store, md, engine, log, signalLog, symbols = SYMBOLS, now = () => Date.now() }) {
    this.store = store;
    this.md = md;
    this.engine = engine;
    this.log = log;
    this.signalLog = signalLog;
    this.symbols = symbols;
    this.now = now;
    this.inflight = new Set();
    this.timer = null;
    engine.scheduler = this;
  }

  get config() { return this.store.config; }
  get scfg() {
    const c = this.config.general.scheduler || {};
    return { ...DEFAULT_SCHEDULER_CONFIG, ...c, entryGraceMin: { ...DEFAULT_SCHEDULER_CONFIG.entryGraceMin, ...(c.entryGraceMin || {}) } };
  }
  calendar() { return this.config.general.usCalendar || DEFAULT_US_CALENDAR; }

  instances() {
    const out = [];
    for (const symbol of this.symbols) for (const strategy of strategiesForSymbol(symbol)) {
      const timeframe = timeframeOf(strategy, this.config);
      out.push({ key: `${strategy}:${symbol}:${timeframe}`, strategy, symbol, timeframe, type: scheduleTypeOf(timeframe) });
    }
    return out;
  }

  // Persisted per trading mode (PAPER and LIVE slots are separate books).
  entry(inst, mode = this.engine.mode) {
    const ms = this.store.state.modes[mode];
    const sch = (ms.scheduler ||= {});
    return (sch[inst.key] ||= { lastEvaluatedCandle: null, lastEvaluatedOpen: null, evaluatedAt: null, lastCheckAt: null, lastSeenCandle: null, lastResult: null, lastLogKey: null, retry: false, evaluations: 0 });
  }

  start() {
    this.md.on('candleClose', ({ symbol, interval }) => this.onCandleClose(symbol, interval));
    this.timer = setInterval(() => this.tick(), this.scfg.retrySec * 1000);
    this.timer.unref?.();
    this.log.info(`StrategyScheduler started: ${this.instances().map((i) => `${i.strategy}/${i.symbol.replace('USDT', '')}@${TF_LABEL[i.timeframe]}`).join(' ')}`, 'SCHEDULER');
  }

  stop() { clearInterval(this.timer); }

  onCandleClose(symbol, interval) {
    const list = this.instances().filter((i) => i.symbol === symbol && i.timeframe === interval);
    return Promise.all(list.map((i) => this.run(i, interval === US_SESSION ? 'US market close' : `${TF_LABEL[interval]} candle close`)));
  }

  // Bot start / mode switch / config save / boot: evaluate the latest closed candle of every instance once.
  catchUp(trigger) {
    return Promise.all(this.instances().map((i) => this.run(i, trigger)));
  }

  // Fallback (missed close event) + retries of transient skips. Never re-evaluates a finished candle.
  tick() {
    const running = this.engine.runState === 'RUNNING';
    const jobs = [];
    for (const inst of this.instances()) {
      const last = barsFor(this.md, inst.strategy, inst.symbol, this.config).at(-1);
      if (!last) continue;
      const e = this.entry(inst);
      if (e.lastEvaluatedCandle != null && last.T <= e.lastEvaluatedCandle) continue;
      if (e.lastSeenCandle !== last.T) jobs.push(this.run(inst, 'fallback (close event missed)'));
      else if (running && e.retry) jobs.push(this.run(inst, 'retry'));
    }
    return Promise.all(jobs);
  }

  // Evaluations run one at a time (single queue): two strategies entering at the same candle close must not
  // both pass the balance check against the same available balance before either order is filled.
  run(inst, trigger) {
    if (this.inflight.has(inst.key)) return Promise.resolve({ result: 'BUSY' });
    if (this.md.s[inst.symbol]?.unavailable) return Promise.resolve({ result: 'SYMBOL_UNAVAILABLE' });
    this.inflight.add(inst.key);
    const p = (this.queue || Promise.resolve()).then(() => this.runNow(inst, trigger)).finally(() => this.inflight.delete(inst.key));
    this.queue = p.catch(() => {});
    return p;
  }

  async runNow(inst, trigger) {
    try {
      const bars = barsFor(this.md, inst.strategy, inst.symbol, this.config);
      const last = bars.at(-1);
      if (!last) return { result: 'NO_DATA' };
      const now = this.now();
      const mode = this.engine.mode;
      const e = this.entry(inst, mode);
      e.lastCheckAt = now;
      const closeT = last.T;
      if (e.lastEvaluatedCandle != null && closeT <= e.lastEvaluatedCandle) return { result: 'DUPLICATE', duplicate: true };

      const closedAt = closeT + 1;
      const graceMin = this.scfg.entryGraceMin[inst.timeframe] ?? 60;
      const ageMin = (now - closedAt) / 60_000;
      const stale = ageMin > graceMin;
      const missed = e.lastEvaluatedCandle != null ? bars.filter((c) => c.T > e.lastEvaluatedCandle && c.T < closeT).length : 0;

      const res = await this.engine.evaluateSlot(inst.strategy, inst.symbol, trigger, {
        bars, allowEntry: !stale, candleClose: closedAt, staleReason: `closed ${ageMin.toFixed(0)}m ago > grace ${graceMin}m`,
      });
      const final = res.final || res.result === 'NOT_READY';
      e.lastSeenCandle = closeT;
      e.lastResult = res.result;
      e.retry = !!res.transient;
      if (final) {
        e.lastEvaluatedCandle = closeT;
        e.lastEvaluatedOpen = last.t;
        e.evaluatedAt = now;
        e.evaluations = (e.evaluations || 0) + 1;
        this.store.saveStateNow(); // dedup key must survive a crash / restart
        if (missed > 0) this.log.warn(`${inst.strategy} ${inst.symbol} ${TF_LABEL[inst.timeframe]}: ${missed} earlier candle(s) closed while not evaluated — evaluated the latest closed candle only (indicators rebuilt from full history, no stale orders)`, 'CATCH_UP');
      }
      const logKey = `${closeT}:${res.result}`;
      if (e.lastLogKey !== logKey) {
        e.lastLogKey = logKey;
        this.record(inst, last, res, trigger, { stale, ageMin, final, mode });
      }
      return { ...res, final };
    } catch (err) {
      this.log.error(`${inst.strategy} ${inst.symbol} scheduler evaluation error: ${err.message}`, 'ENGINE_ERROR');
      return { result: 'ERROR', error: err.message };
    }
  }

  record(inst, candle, res, trigger, { stale, ageMin, final, mode }) {
    const scfg = this.config.strategies[inst.strategy];
    const detail = describeSignal(inst.strategy, res.sig, scfg);
    const tf = TF_LABEL[inst.timeframe];
    const msg = `${inst.strategy} ${inst.symbol} ${tf} ${inst.timeframe === US_SESSION ? 'Session Closed' : 'Candle Closed'} C=${candle.c} ${detail} Result=${res.result}`;
    const rec = {
      mode, runState: this.engine.runState, strategy: inst.strategy, symbol: inst.symbol, timeframe: inst.timeframe,
      candleOpen: candle.t, candleClose: candle.T + 1, close: candle.c, trigger, detail, result: res.result, final,
      stale, ageMin: Math.round(ageMin), flags: res.sig?.ready ? { longCond: res.sig.longCond, shortCond: res.sig.shortCond, longExit: res.sig.longExit, shortExit: res.sig.shortExit } : null,
      msg,
    };
    this.signalLog?.add(rec);
    this.log.info(msg, 'SIGNAL_EVAL');
  }

  // ---------- UI
  nextExpected(inst, last, now) {
    if (inst.timeframe === US_SESSION) return nextSessionClose(now, this.calendar())?.close ?? null;
    if (last) { // derived from candle length (works with accelerated mock time too)
      const len = last.T + 1 - last.t;
      let next = last.T + 1 + len;
      while (next <= now) next += len;
      return next;
    }
    const ms = TF_MS[inst.timeframe];
    return Math.floor(now / ms) * ms + ms;
  }

  snapshot() {
    const now = this.now();
    const running = this.engine.runState === 'RUNNING';
    return this.instances().map((inst) => {
      const e = this.entry(inst);
      const bars = barsFor(this.md, inst.strategy, inst.symbol, this.config);
      const last = bars.at(-1);
      const enabled = !!this.config.strategies[inst.strategy]?.enabled;
      const unavailable = this.md.s[inst.symbol]?.unavailable;
      const row = {
        key: inst.key, strategy: inst.strategy, symbol: inst.symbol, timeframe: inst.timeframe, timeframeLabel: TF_LABEL[inst.timeframe],
        scheduleType: inst.type, assetClass: STRATEGY_CLASS[inst.strategy],
        lastEvaluatedCandle: e.lastEvaluatedCandle != null ? e.lastEvaluatedCandle + 1 : null,
        lastClosedCandle: last ? last.T + 1 : null,
        lastCheckAt: e.lastCheckAt, lastResult: e.lastResult, evaluations: e.evaluations || 0,
        nextExpectedCandle: this.nextExpected(inst, last, now),
        status: unavailable ? 'UNAVAILABLE' : !enabled ? 'DISABLED' : !running ? 'STOPPED' : e.retry ? 'RETRYING' : 'RUNNING',
        entryGraceMin: this.scfg.entryGraceMin[inst.timeframe],
      };
      if (inst.timeframe === US_SESSION) {
        const m = marketStatus(now, this.calendar());
        row.signalSession = 'US Regular Market Close (America/New_York)';
        row.executionMarket = `Binance ${inst.symbol} 24/7`;
        row.underlying = SYMBOL_META[inst.symbol]?.underlying;
        row.market = m.underlying;
        row.marketClosesAt = m.closesAt;
        row.marketNextOpen = m.nextOpen;
      }
      return row;
    });
  }
}
