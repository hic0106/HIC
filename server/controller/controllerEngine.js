// Self-Improving Controller (V1).
// Sits between the existing strategy signals and the existing execution engine. It never creates
// BUY/SELL/LONG/SHORT signals, never edits strategy rules, stops, leverage, base order amounts or
// the enabled flag. It only chooses, per strategy × side, a status from a fixed ladder whose
// multiplier (0 … 1.25) scales the user's base order amount for NEW entries.
import { ALL_STRATEGIES as STRATEGIES, META as STRATEGY_META, STRATEGY_CLASS, symbolsForStrategy } from '../strategyRegistry.js';
import { SYMBOLS } from '../store.js';
import { ASSET_CLASSES, symbolsOfClass } from '../assets.js';
import { equityCurve, windowReturn, drawdowns, dayNum } from './performanceEvaluator.js';
import { computeMetrics, returnCorrelation } from './performanceEvaluator.js';
import { detectRegime } from './regimeDetector.js';
import { decide, multiplierTable, MAX_MULTIPLIER, STATUS_ORDER } from './decisionRules.js';
import { ControllerStore } from './controllerStore.js';
import { ShadowPortfolio, emptyShadowState, sideKey } from './shadowPortfolio.js';
import { ParameterCandidateManager } from './parameterCandidateManager.js';
import { timeframeOf } from '../scheduler/timeframes.js';

export const CONTROLLER_MODES = ['OFF', 'OBSERVE', 'PAPER_AUTO', 'LIVE_APPROVAL'];
const SIDES = ['LONG', 'SHORT'];
const DAY_MS = 86_400_000;
const utcDay = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

export class Controller {
  constructor({ store, md, engine, log, cstore = new ControllerStore(), symbols = SYMBOLS }) {
    this.store = store;
    this.md = md;
    this.engine = engine;
    this.log = log;
    this.cstore = cstore;
    this.symbols = symbols;
    this.params = new ParameterCandidateManager();
    this.shadow = new ShadowPortfolio({
      md, symbols, getConfig: () => this.store.config,
      proposedMultiplier: (st, side) => this.proposedMultiplier(st, side),
      state: cstore.state.shadow || emptyShadowState(),
    });
    cstore.state.shadow = this.shadow.state;
    this.timer = null;
  }

  get cfg() { return this.store.config.controller; }
  get state() { return this.cstore.state; }
  table() { return multiplierTable(this.cfg.multipliers); }
  // Long-only strategies (TSMOM, all QQQ) have no SHORT key.
  keys() {
    return STRATEGIES.flatMap((st) => SIDES.filter((side) => side === 'LONG' || STRATEGY_META[st].supportsShort)
      .map((side) => ({ strategy: st, side, key: sideKey(st, side), assetClass: STRATEGY_CLASS[st] })));
  }
  nSlots(strategy) { return Math.max(1, symbolsForStrategy(strategy).length); }
  sideActive(strategy, side) {
    const s = this.store.config.strategies[strategy];
    return side === 'LONG' || (STRATEGY_META[strategy].supportsShort && !!s.shortEnabled);
  }

  // ---------- lifecycle (all handlers isolated: a controller error never stops trading)
  start() {
    const safe = (fn) => (...a) => { try { fn(...a); } catch (e) { this.enterFailSafe(e); } };
    this.md.on('candleClose', safe(({ symbol, interval }) => { this.shadow.onCandleClose(symbol, interval); this.cstore.save(); }));
    safe(() => this.recordTimeframeChanges())();
    this.md.on('price', safe(({ symbol, price }) => this.shadow.onPrice(symbol, price)));
    this.md.on('funding', safe((f) => this.shadow.onFunding(f)));
    this.timer = setInterval(safe(() => this.tick()), 60_000);
    this.timer.unref?.();
    safe(() => { this.shadow.processAll(); this.tick(); })();
    this.log.info(`Controller started — mode ${this.cfg.mode} (orders ${this.cfg.mode === 'OBSERVE' || this.cfg.mode === 'OFF' ? 'NOT affected' : 'affected per mode'})`, 'CONTROLLER');
  }

  tick(now = Date.now()) {
    const day = utcDay(now);
    if (this.shadow.state.lastSnapDay !== day) {
      this.shadow.snapshot(day, (s) => this.md.price(s));
      this.cstore.save();
    }
    if (this.isDue(now)) this.evaluate('scheduled', now);
  }

  isDue(now = Date.now()) {
    if (this.cfg.mode === 'OFF') return false;
    const last = this.state.lastEvaluation;
    return !last || now - last >= this.cfg.reevalDays * DAY_MS;
  }

  nextEvaluation() {
    const last = this.state.lastEvaluation;
    return last ? last + this.cfg.reevalDays * DAY_MS : null;
  }

  // ---------- sizing (called by the execution engine before each NEW entry)
  proposedMultiplier(strategy, side) {
    if (this.cfg.mode === 'OFF') return 1;
    const st = this.state.sides[sideKey(strategy, side)]?.status || 'NORMAL';
    return this.table()[st];
  }

  getSizing(strategy, side, tradingMode) {
    try {
      const mode = this.cfg.mode;
      const capUsdt = this.cfg.maxOrderUsdt?.[strategy]?.[side] ?? null;
      if (this.state.failSafe) return { multiplier: 1, status: 'FAIL_SAFE', capUsdt };
      const uses = (tradingMode === 'PAPER' && (mode === 'PAPER_AUTO' || mode === 'LIVE_APPROVAL')) || (tradingMode === 'LIVE' && mode === 'LIVE_APPROVAL');
      if (!uses) return { multiplier: 1, status: mode === 'OFF' ? 'OFF' : 'NOT_APPLIED', capUsdt };
      const a = this.state.applied[tradingMode]?.[sideKey(strategy, side)];
      if (!a) return { multiplier: 1, status: 'NORMAL', capUsdt };
      if (!STATUS_ORDER.includes(a.status)) throw new Error(`invalid applied status ${a.status}`);
      const m = this.table()[a.status];
      if (!Number.isFinite(m) || m < 0 || m > MAX_MULTIPLIER) throw new Error(`invalid multiplier ${m}`);
      return { multiplier: m, status: a.status, capUsdt };
    } catch (e) {
      this.enterFailSafe(e);
      return { multiplier: 1, status: 'FAIL_SAFE', capUsdt: null };
    }
  }

  enterFailSafe(e) {
    if (!this.state.failSafe) this.log.error(`Controller error: ${e.message} — FAIL SAFE (all multipliers 1.00x). Trading continues.`, 'CONTROLLER_FAIL_SAFE');
    this.state.failSafe = { since: Date.now(), error: e.message };
    this.cstore.save();
  }

  // Signal timeframe changes (e.g. Turtle/ADX 1d -> 4h after upgrade) are recorded as parameter changes,
  // so performance before/after is evaluated separately.
  recordTimeframeChanges() {
    const cur = Object.fromEntries(STRATEGIES.map((st) => [st, timeframeOf(st, this.store.config)]));
    const prev = this.state.timeframes;
    this.state.timeframes = cur;
    if (!prev) { // first run with timeframe tracking: before this version every strategy used daily / session candles
      for (const st of STRATEGIES) if (STRATEGY_CLASS[st] === 'CRYPTO' && cur[st] !== '1d') this.onStrategyConfigChanged(st, { timeframe: '1d' }, { timeframe: cur[st] });
    } else {
      for (const st of STRATEGIES) if (prev[st] && prev[st] !== cur[st]) this.onStrategyConfigChanged(st, { timeframe: prev[st] }, { timeframe: cur[st] });
    }
    this.cstore.save();
  }

  // ---------- evaluation
  lastParamChange(strategy) {
    return [...(this.state.changes || [])].reverse().find((c) => c.strategy === strategy && c.significant) || null;
  }

  metricsFor(strategy, side, now) {
    const k = sideKey(strategy, side);
    let series = this.shadow.state.series[k] || [];
    let trades = this.shadow.state.trades.filter((t) => t.strategy === strategy && t.side === side);
    const change = this.lastParamChange(strategy);
    const n = this.nSlots(strategy);
    const info = change ? changeSplit(series, change, n) : null;
    if (change && this.cfg.resetHistoryOnParamChange) {
      // data produced under the old parameters is not mixed into the evaluation
      series = series.filter((p) => p.day >= change.day);
      trades = trades.filter((t) => t.entryTime >= change.at);
    }
    const m = computeMetrics({ series, trades, nSlots: n, windows: this.cfg.windows, lowTradeCount: this.cfg.lowTradeCountForExtended, now });
    m.change = info;
    m.historyReset = !!(change && this.cfg.resetHistoryOnParamChange);
    return m;
  }

  // ---------- strategy / controller config change markers
  onStrategyConfigChanged(strategy, prev, next) {
    try {
      const fields = diffObj(prev, next);
      if (!fields.length) return;
      const significant = fields.some((f) => /^(params|stop|takeProfit|shortEnabled|timeframe)/.test(f.path));
      const now = Date.now();
      const ch = { id: `${strategy}:${now}`, at: now, day: utcDay(now), strategy, significant, fields };
      (this.state.changes ||= []).push(ch);
      if (next?.timeframe && this.state.timeframes) this.state.timeframes[strategy] = timeframeOf(strategy, { strategies: { [strategy]: next } });
      if (this.state.changes.length > 500) this.state.changes.shift();
      this.cstore.appendHistory({
        type: 'CONFIG_CHANGE', timestamp: new Date(now).toISOString(), controller_mode: this.cfg.mode, strategy, side: 'ALL',
        previous_status: null, new_status: null, previous_multiplier: null, new_multiplier: null,
        '30d_return': null, '90d_return': null, '180d_return': null, current_drawdown: null, max_drawdown: null,
        sharpe: null, sortino: null, profit_factor: null, trade_count: null, market_regime: null,
        reason: fields.map((f) => `${f.path} ${JSON.stringify(f.from)}→${JSON.stringify(f.to)}`).join('; '),
        significant, history_reset: significant && !!this.cfg.resetHistoryOnParamChange, approved_by_user: true, applied: true, trigger: 'user',
      });
      this.cstore.saveNow();
      this.log.info(`Controller: ${strategy} config change recorded (${significant ? 'PARAMETER change — performance evaluated separately from now' : 'non-parameter change'})`, 'CONFIG_CHANGE');
    } catch (e) {
      this.enterFailSafe(e);
    }
  }

  classSeries(cls) {
    const byDay = new Map();
    for (const st of STRATEGIES.filter((x) => STRATEGY_CLASS[x] === cls)) for (const p of this.strategySeries(st)) {
      const e = byDay.get(p.day) || { day: p.day, cum: 0, open: 0 };
      e.cum += p.cum; e.open += p.open; byDay.set(p.day, e);
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  // Crypto vs TradFi performance, evaluated separately (never ranked against each other).
  classPerformance(now = Date.now()) {
    const out = {};
    for (const cls of ASSET_CLASSES) {
      const sts = STRATEGIES.filter((x) => STRATEGY_CLASS[x] === cls && this.store.config.strategies[x].enabled);
      const slots = Math.max(1, sts.reduce((a, st) => a + this.nSlots(st), 0));
      const m = computeMetrics({ series: this.classSeries(cls), trades: this.shadow.state.trades.filter((t) => STRATEGY_CLASS[t.strategy] === cls), nSlots: slots, windows: this.cfg.windows, now });
      const pf = this.shadow.state.portfolio.at(-1)?.byClass?.[cls] || { baseline: 0, controller: 0 };
      out[cls] = { strategies: sts, symbols: symbolsOfClass(cls), metrics: compactMetrics(m), baselinePnl: pf.baseline, controllerPnl: pf.controller, regime: this.state.regimes?.[cls]?.regime || null };
    }
    return out;
  }

  strategySeries(strategy) {
    const byDay = new Map();
    for (const side of SIDES) for (const p of this.shadow.state.series[sideKey(strategy, side)] || []) {
      const e = byDay.get(p.day) || { day: p.day, cum: 0, open: 0 };
      e.cum += p.cum; e.open += p.open; byDay.set(p.day, e);
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  correlations() {
    const out = [];
    for (let i = 0; i < STRATEGIES.length; i++) for (let j = i + 1; j < STRATEGIES.length; j++) {
      const a = STRATEGIES[i], b = STRATEGIES[j];
      const corr = returnCorrelation(this.strategySeries(a), this.strategySeries(b), this.nSlots(a), this.cfg.windows.main);
      out.push({ a, b, classA: STRATEGY_CLASS[a], classB: STRATEGY_CLASS[b], corr, high: corr != null && corr > this.cfg.guards.correlationThreshold });
    }
    return out;
  }

  exposure() {
    const acct = this.engine.accountSummary();
    const equity = acct.equity || 0;
    const coins = {};
    for (const sym of this.symbols) {
      const b = acct.bySymbol[sym];
      coins[sym] = { long: b.long, short: b.short, net: b.net, gross: b.long + b.short, grossPct: equity > 0 ? ((b.long + b.short) / equity) * 100 : null };
    }
    const byClass = {};
    for (const cls of ASSET_CLASSES) {
      const b = acct.byClass?.[cls] || { long: 0, short: 0, net: 0, gross: 0 };
      byClass[cls] = { long: b.long, short: b.short, net: b.net, gross: b.gross, grossPct: equity > 0 ? (b.gross / equity) * 100 : null };
    }
    return { equity, long: acct.longExp, short: acct.shortExp, net: acct.netExp, gross: acct.longExp + acct.shortExp, coins, byClass };
  }

  exposureFlag(strategy, exp) {
    const lim = this.cfg.guards.maxCoinExposurePctForBoost;
    if (!(lim > 0)) return null;
    const coins = new Set(this.engine.positionsList().filter((p) => p.strategy === strategy).map((p) => p.symbol));
    for (const c of coins) {
      const g = exp.coins[c]?.grossPct;
      if (g != null && g > lim) return `${c.replace('USDT', '')} gross exposure ${g.toFixed(0)}% of equity > ${lim}% → boost blocked`;
    }
    return null;
  }

  evaluate(trigger = 'manual', now = Date.now()) {
    try {
      if (this.cfg.mode === 'OFF') return { ok: false, msg: 'Controller is OFF' };
      const mode = this.cfg.mode;
      const table = this.table();
      // regime per asset class: CRYPTO from BTC UTC dailies, TRADFI from QQQ US-session candles
      const regimes = {
        CRYPTO: detectRegime(this.md.s.BTCUSDT?.daily || [], this.cfg.regime),
        TRADFI_INDEX: detectRegime(this.md.s.QQQUSDT?.daily || [], this.cfg.regimeTradfi || this.cfg.regime),
      };
      const reg = regimes.CRYPTO;
      const exp = this.exposure();
      const corr = this.correlations();
      const decisions = {};
      for (const { strategy, side, key, assetClass } of this.keys()) {
        const metrics = this.metricsFor(strategy, side, now);
        const prev = this.state.sides[key]?.status || 'NORMAL';
        const d = decide({
          metrics, prevStatus: prev, side, regime: regimes[assetClass].regime, sideActive: this.sideActive(strategy, side),
          exposureFlag: this.exposureFlag(strategy, exp), cfg: this.cfg,
        });
        if (!this.store.config.strategies[strategy].enabled) d.reasons.unshift('strategy DISABLED by user (controller never re-enables it)');
        if (metrics.historyReset) d.reasons.unshift(`evaluating only data since parameter change ${metrics.change?.day}`);
        decisions[key] = { strategy, side, prev, metrics, ...d };
      }
      // correlation guard (off by default; values always shown in UI/log)
      for (const c of corr) {
        if (!c.high || c.classA !== c.classB) continue; // guard only within an asset class
        this.log.info(`Controller: ${c.a}/${c.b} return correlation ${c.corr.toFixed(2)} > ${this.cfg.guards.correlationThreshold}`, 'CONTROLLER_CORR');
        if (!this.cfg.guards.correlationGuard) continue;
        for (const side of SIDES) {
          const A = decisions[sideKey(c.a, side)], B = decisions[sideKey(c.b, side)];
          if (A.status === 'BOOSTED' && B.status === 'BOOSTED') {
            const low = (A.score ?? 0) >= (B.score ?? 0) ? B : A;
            low.status = 'NORMAL';
            low.guards.push(`correlation ${c.a}/${c.b} ${c.corr.toFixed(2)} → only one BOOSTED`);
          }
        }
      }

      const applyPaper = mode === 'PAPER_AUTO' || mode === 'LIVE_APPROVAL';
      const summary = [];
      for (const { strategy, side, key } of this.keys()) {
        const d = decisions[key];
        const m = d.metrics;
        const mult = table[d.status];
        const reason = [...d.reasons, ...d.guards].join('; ');
        this.state.sides[key] = {
          status: d.status, multiplier: mult, score: d.score, components: d.components, reasons: d.reasons, guards: d.guards, evaluatedAt: now,
          metrics: compactMetrics(m),
        };
        const prevPaper = this.state.applied.PAPER[key]?.status || 'NORMAL';
        if (applyPaper) this.state.applied.PAPER[key] = { status: d.status, multiplier: mult, at: now };
        let pendingId = null;
        const liveCur = this.state.applied.LIVE[key]?.status || 'NORMAL';
        this.state.pending = this.state.pending.filter((p) => p.key !== key);
        if (mode === 'LIVE_APPROVAL' && d.status !== liveCur) {
          pendingId = `${key}:${now}`;
          this.state.pending.push({ id: pendingId, key, strategy, side, from: liveCur, to: d.status, fromMult: table[liveCur], toMult: mult, reason, createdAt: now, regime: regimes[STRATEGY_CLASS[strategy]].regime });
        }
        this.cstore.appendHistory(historyRecord({
          now, mode, strategy, side, prev: d.prev, next: d.status, table, m, regime: regimes[STRATEGY_CLASS[strategy]].regime, reason, trigger, assetClass: STRATEGY_CLASS[strategy],
          approved: false, applied: applyPaper, appliedTo: applyPaper ? 'PAPER' : null, prevApplied: prevPaper, pendingId,
        }));
        if (d.prev !== d.status) summary.push(`${strategy} ${side} ${d.prev}→${d.status}`);
      }
      this.state.regime = { ...reg, at: now };
      this.state.regimes = Object.fromEntries(Object.entries(regimes).map(([k, v]) => [k, { ...v, at: now }]));
      this.state.lastEvaluation = now;
      if (this.state.failSafe) { this.log.warn('Controller evaluation succeeded — leaving FAIL SAFE', 'CONTROLLER'); this.state.failSafe = null; }
      this.cstore.saveNow();
      this.log.info(`Controller evaluation (${trigger}, ${mode}) regime CRYPTO ${reg.regime} / TRADFI ${regimes.TRADFI_INDEX.regime}: ${summary.length ? summary.join(', ') : 'no status change'}${this.state.pending.length ? ` — ${this.state.pending.length} LIVE recommendation(s) pending approval` : ''}`, 'CONTROLLER_EVAL');
      return { ok: true };
    } catch (e) {
      this.enterFailSafe(e);
      return { ok: false, msg: e.message };
    }
  }

  // ---------- LIVE approval
  approve(id) {
    if (this.cfg.mode !== 'LIVE_APPROVAL') return { ok: false, msg: 'Controller is not in LIVE_APPROVAL mode' };
    const p = this.state.pending.find((x) => x.id === id);
    if (!p) return { ok: false, msg: 'recommendation not found (expired or replaced)' };
    const table = this.table();
    this.state.applied.LIVE[p.key] = { status: p.to, multiplier: table[p.to], at: Date.now(), approvedBy: 'user' };
    this.state.pending = this.state.pending.filter((x) => x.id !== id);
    this.cstore.appendHistory({ ...this.decisionEvent(p, true, true), note: 'user approved LIVE change' });
    this.cstore.saveNow();
    this.log.warn(`Controller LIVE change APPROVED: ${p.strategy} ${p.side} ${p.from} → ${p.to} (${table[p.from]}x → ${table[p.to]}x)`, 'CONTROLLER_APPROVE');
    return { ok: true };
  }

  reject(id) {
    const p = this.state.pending.find((x) => x.id === id);
    if (!p) return { ok: false, msg: 'recommendation not found' };
    this.state.pending = this.state.pending.filter((x) => x.id !== id);
    this.cstore.appendHistory({ ...this.decisionEvent(p, false, false), note: 'user rejected LIVE change' });
    this.cstore.saveNow();
    this.log.info(`Controller LIVE change rejected: ${p.strategy} ${p.side} ${p.from} → ${p.to}`, 'CONTROLLER_REJECT');
    return { ok: true };
  }

  decisionEvent(p, approved, applied) {
    const s = this.state.sides[p.key] || {};
    const m = s.metrics || {};
    return {
      timestamp: new Date().toISOString(), controller_mode: this.cfg.mode, strategy: p.strategy, side: p.side,
      previous_status: p.from, new_status: applied ? p.to : p.from, previous_multiplier: p.fromMult, new_multiplier: applied ? p.toMult : p.fromMult,
      '30d_return': m.ret30 ?? null, '90d_return': m.ret90 ?? null, '180d_return': m.retStab ?? null,
      current_drawdown: m.currentDD ?? null, max_drawdown: m.maxDD ?? null, sharpe: m.sharpe ?? null, sortino: m.sortino ?? null,
      profit_factor: m.profitFactor ?? null, trade_count: m.tradeCount ?? null, market_regime: p.regime,
      reason: p.reason, approved_by_user: approved, applied, applied_to: applied ? 'LIVE' : null, trigger: 'user',
    };
  }

  // ---------- mode / kill switch
  setMode(mode) {
    if (!CONTROLLER_MODES.includes(mode)) return { ok: false, msg: 'invalid controller mode' };
    if (mode === 'OFF') return this.disable();
    const prev = this.cfg.mode;
    this.cfg.mode = mode;
    if (prev === 'LIVE_APPROVAL' && mode !== 'LIVE_APPROVAL') { this.state.applied.LIVE = {}; this.state.pending = []; }
    if ((mode === 'PAPER_AUTO' || mode === 'LIVE_APPROVAL') && !(prev === 'PAPER_AUTO' || prev === 'LIVE_APPROVAL')) {
      // start PAPER from the latest recommendation
      for (const { key } of this.keys()) {
        const s = this.state.sides[key];
        if (s) this.state.applied.PAPER[key] = { status: s.status, multiplier: this.table()[s.status], at: Date.now() };
      }
    }
    if (mode === 'OBSERVE') this.state.applied.PAPER = {};
    this.store.saveConfig();
    this.cstore.saveNow();
    this.log.warn(`Controller mode ${prev} → ${mode}`, 'CONTROLLER_MODE');
    return { ok: true };
  }

  disable() {
    this.cfg.mode = 'OFF';
    this.state.applied = { PAPER: {}, LIVE: {} };
    this.state.pending = [];
    this.state.failSafe = null;
    this.store.saveConfig();
    this.cstore.saveNow();
    this.log.warn('DISABLE CONTROLLER — all multipliers reset to 1.00x. Strategies keep running unchanged.', 'CONTROLLER_DISABLED');
    return { ok: true };
  }

  // ---------- UI data
  compact() {
    const mode = this.cfg.mode;
    const table = this.table();
    const tradingMode = this.engine.mode;
    const rows = this.keys().map(({ strategy, side, key }) => {
      const s = this.state.sides[key];
      const sizing = this.getSizing(strategy, side, tradingMode);
      return { strategy, side, key, assetClass: STRATEGY_CLASS[strategy], active: this.sideActive(strategy, side), recommended: s?.status || 'NORMAL', recommendedMult: table[s?.status || 'NORMAL'], applied: sizing.status, appliedMult: sizing.multiplier };
    });
    return {
      mode, failSafe: this.state.failSafe, lastEvaluation: this.state.lastEvaluation, nextEvaluation: this.nextEvaluation(),
      regime: this.state.regime?.regime || null, regimes: Object.fromEntries(Object.entries(this.state.regimes || {}).map(([k, v]) => [k, v.regime])), pending: this.state.pending.length, rows,
      shadow: this.shadow.summary((sym) => this.md.price(sym)),
    };
  }

  detail() {
    const tradingMode = this.engine.mode;
    const table = this.table();
    const strategies = this.keys().map(({ strategy, side, key }) => {
      const s = this.state.sides[key] || null;
      const sizing = this.getSizing(strategy, side, tradingMode);
      const base = this.engine.amountFor(strategy, side);
      const actual = this.engine.controllerSizing(strategy, side, base).amount;
      return {
        strategy, side, key, assetClass: STRATEGY_CLASS[strategy], active: this.sideActive(strategy, side), enabled: this.store.config.strategies[strategy].enabled,
        recommended: s?.status || 'NORMAL', recommendedMult: table[s?.status || 'NORMAL'],
        applied: sizing.status, appliedMult: sizing.multiplier, baseAmount: base, actualAmount: actual,
        score: s?.score ?? null, components: s?.components ?? null, reasons: s?.reasons || [], guards: s?.guards || [],
        metrics: s?.metrics || compactMetrics(this.metricsFor(strategy, side, Date.now())),
      };
    });
    return {
      ...this.compact(), tradingMode, table, config: this.cfg, regimeDetail: this.state.regime, regimeDetails: this.state.regimes || {},
      classPerformance: this.classPerformance(), changes: (this.state.changes || []).slice(-100),
      strategies, pendingList: this.state.pending, correlations: this.correlations(), exposure: this.exposure(),
      shadowSeries: this.shadow.state.portfolio.slice(-400), history: this.cstore.recentHistory(200),
      parameterCandidates: { enabled: this.params.enabled },
    };
  }
}

function compactMetrics(m) {
  return {
    historyDays: m.historyDays, ret30: m.ret?.fast ?? null, ret90: m.ret?.main ?? null, retStab: m.ret?.stability ?? null, stabilityWindow: m.stabilityWindow,
    currentDD: m.currentDD, maxDD: m.maxDD, sharpe: m.sharpe, sortino: m.sortino, downsideVol: m.downsideVol,
    profitFactor: Number.isFinite(m.profitFactor) ? m.profitFactor : (m.profitFactor === Infinity ? 999 : null),
    winRate: m.winRate, avgWin: m.avgWin, avgLoss: m.avgLoss, tradeCount: m.tradeCount, consecutiveLosses: m.consecutiveLosses,
    exposure: m.exposure, daysSinceLastTrade: m.daysSinceLastTrade, consistency: m.consistency,
    change: m.change || null, historyReset: !!m.historyReset,
  };
}

// Performance since the last parameter change vs the same-length window before it.
function changeSplit(series, change, nSlots) {
  const curve = equityCurve(series, nSlots);
  const cd = dayNum(change.day);
  const after = curve.filter((p) => p.d >= cd);
  const before = curve.filter((p) => p.d <= cd);
  const days = after.length ? after[after.length - 1].d - cd : 0;
  const len = Math.max(days, 1);
  const beforeWin = before.filter((p) => p.d >= cd - Math.min(len, 90));
  return {
    day: change.day, at: change.at, days,
    retAfter: after.length >= 2 ? windowReturn(after, days + 1) : null,
    ddAfter: after.length ? drawdowns(after).currentDD : null,
    retBefore: beforeWin.length >= 2 ? windowReturn(beforeWin, len) : null,
    beforeDays: beforeWin.length ? beforeWin[beforeWin.length - 1].d - beforeWin[0].d : 0,
  };
}

function diffObj(a, b, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const pa = a?.[k], pb = b?.[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (pa && pb && typeof pa === 'object' && typeof pb === 'object') out.push(...diffObj(pa, pb, path));
    else if (JSON.stringify(pa) !== JSON.stringify(pb)) out.push({ path, from: pa ?? null, to: pb ?? null });
  }
  return out;
}

function historyRecord({ now, mode, strategy, side, prev, next, table, m, regime, reason, trigger, approved, applied, appliedTo, prevApplied, pendingId, assetClass }) {
  return {
    type: 'DECISION', asset_class: assetClass || null,
    timestamp: new Date(now).toISOString(), controller_mode: mode, strategy, side,
    previous_status: prev, new_status: next, previous_multiplier: table[prev], new_multiplier: table[next],
    '30d_return': m.ret?.fast ?? null, '90d_return': m.ret?.main ?? null, '180d_return': m.ret?.stability ?? null,
    stability_window_days: m.stabilityWindow,
    current_drawdown: m.currentDD ?? null, max_drawdown: m.maxDD ?? null, sharpe: m.sharpe ?? null, sortino: m.sortino ?? null,
    profit_factor: Number.isFinite(m.profitFactor) ? m.profitFactor : null, trade_count: m.tradeCount ?? 0, history_days: m.historyDays,
    market_regime: regime, reason, approved_by_user: approved, applied, applied_to: appliedTo, previous_applied_paper: prevApplied,
    pending_live_id: pendingId, trigger,
  };
}
