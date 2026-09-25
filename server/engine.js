// Trading engine: strategy evaluation, pre-trade checks, paper/live execution,
// emergency stops, funding, PnL accounting and UI snapshot.
import { BinanceClient, BinanceError, endpoints, floorToStep, fmtQty, roundToTick, fmtPrice } from './binance.js';
import { ALL_STRATEGIES as STRATEGIES, META as STRATEGY_META, evaluateStrategy as evaluate, strategiesForSymbol, STRATEGY_CLASS, exitFor, entryStop, stopReasonOf, trendCounts, recordTrendEntry, impliedSide } from './strategyRegistry.js';
import { SYMBOLS, emptyModeState } from './store.js';
import { SYMBOL_META, assetClassOf, ASSET_CLASSES } from './assets.js';
import { EventEmitter } from 'node:events';
import { barsFor } from './scheduler/timeframes.js';
import { reconcilePositions } from './portfolio/reconcile.js';

const slotKey = (st, sym) => `${st}:${sym}`;
const dirOf = (side) => (side === 'LONG' ? 1 : -1);
const utcDay = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const round = (x, d = 8) => (x == null || !isFinite(x) ? x : Number(x.toFixed(d)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transient blocks: retried on next periodic evaluation within the same candle.
const TRANSIENT = new Set(['ORDER_PENDING', 'DATA_DELAY', 'EXCHANGE_DISCONNECTED', 'NO_PRICE', 'BUSY', 'STOP_CANCEL_FAILED']);
// Controller multipliers can never exceed this (defense in depth; controller enforces it too).
const CONTROLLER_MAX_MULT = 1.25;
// Exchange stop grace: when a bot-side stop breach is seen while the Binance stop is live, let Binance fill first.
const EX_STOP_GRACE_MS = 15_000;

export class Engine {
  constructor(store, market, logger) {
    this.store = store;
    this.md = market;
    this.log = logger;
    this.busy = new Set();
    this.live = { status: 'NO_KEYS', hedgeMode: null, leverage: {}, account: null, error: null, lastCheck: 0, exchangePositions: null };
    this.liveClient = null;
    this.lastTickCheck = {};
    this.events = new EventEmitter(); // 'change' after fills / closes -> portfolio refresh
    this.scheduler = null; // StrategyScheduler (candle-close driven evaluation)
    this.universe = null; // UniverseManager: crypto NEW entries only for the trade universe (exits never blocked)
    this.rebuildLiveClient();
    const paper = this.ms('PAPER');
    if (paper.baseCapital == null) paper.baseCapital = paper.wallet ?? this.cfg.general.paperInitialBalance;
    // Crash recovery: an order sent before shutdown has an unknown result -> reconcile, never resend.
    for (const slot of Object.values(this.ms('LIVE').slots)) {
      if (slot.pending) { slot.status = 'UNKNOWN'; this.log.warn(`${slot.strategy} ${slot.symbol} pending order ${slot.pending.clientOrderId} from previous run — will reconcile with Binance`, 'ORDER_UNKNOWN'); }
    }
    for (const slot of Object.values(this.ms('PAPER').slots)) if (slot.pending) this.revertPending(slot);

    // Signal evaluation is driven by StrategyScheduler (candle closes); stops by RiskMonitor (every price tick).
    market.on('funding', (f) => this.onFunding(f));
    market.on('status', (s) => { if (s !== 'CONNECTED') this.log.error(`Market data ${s}`, 'CONNECTION_LOST'); else this.log.info('Market data connected'); });

    this.timers = [
      setInterval(() => this.liveTick(), 10_000),
      setInterval(() => this.checkDataDelay(), 5_000),
    ];
    this.timers.forEach((t) => t.unref?.());
  }

  // ---------- accessors
  get cfg() { return this.store.config; }
  get mode() { return this.cfg.general.mode; }
  get runState() { return this.store.state.runState; }
  ms(mode = this.mode) { return this.store.state.modes[mode]; }

  slot(strategy, symbol, mode = this.mode) {
    const ms = this.ms(mode);
    const k = slotKey(strategy, symbol);
    if (!ms.slots[k]) {
      ms.slots[k] = { strategy, symbol, status: 'FLAT', position: null, pending: null, block: { LONG: false, SHORT: false }, lastActedCandle: null, lastSkip: null, view: null, evalCandle: null, lastSignal: 'WAIT' };
    }
    return ms.slots[k];
  }

  // Leverage is set by the user per strategy (default 1x). Nothing raises it automatically.
  // Order amount = margin; position notional = amount × strategy leverage.
  leverageFor(strategy) {
    return Number(this.cfg.strategies[strategy]?.leverage ?? 1);
  }

  // Binance leverage is per symbol (shared by every strategy on it): use the highest enabled strategy leverage.
  symbolLeverage(symbol) {
    const levs = strategiesForSymbol(symbol).filter((st) => this.cfg.strategies[st]?.enabled).map((st) => this.leverageFor(st));
    return Math.max(1, ...levs);
  }

  symbolAvailable(sym) { return !!this.md.filters[sym] && !this.md.s[sym]?.unavailable; }

  // BASE ORDER AMOUNT set by the user. Never modified by the controller.
  amountFor(strategy, side, mode = this.mode) {
    const a = this.cfg.strategies[strategy].amounts[mode];
    return side === 'LONG' ? Number(a.long) : Number(a.short);
  }

  // Actual order amount = base × controller multiplier (0 … 1.25). Any controller error -> 1.00 (fail safe).
  controllerSizing(strategy, side, base) {
    let r = { multiplier: 1, status: 'OFF', capUsdt: null };
    if (this.controller) {
      try {
        r = { ...r, ...this.controller.getSizing(strategy, side, this.mode) };
      } catch (e) {
        this.log.error(`Controller sizing error: ${e.message} — FAIL SAFE 1.00x`, 'CONTROLLER_FAIL_SAFE');
        r = { multiplier: 1, status: 'FAIL_SAFE', capUsdt: null };
      }
    }
    const m = Number(r.multiplier);
    if (!Number.isFinite(m) || m < 0 || m > CONTROLLER_MAX_MULT) {
      this.log.error(`Controller returned invalid multiplier ${r.multiplier} — FAIL SAFE 1.00x`, 'CONTROLLER_FAIL_SAFE');
      r = { multiplier: 1, status: 'FAIL_SAFE', capUsdt: null };
    }
    let amount = base * r.multiplier;
    if (r.capUsdt > 0) amount = Math.min(amount, r.capUsdt);
    amount = Math.min(amount, base * CONTROLLER_MAX_MULT);
    return { multiplier: r.multiplier, status: r.status, amount: round(amount, 8) };
  }

  // ---------- run control
  async start() {
    if (this.runState === 'RUNNING') return { ok: true };
    if (this.md.status !== 'CONNECTED') return { ok: false, msg: 'Market data not connected' };
    if (this.mode === 'LIVE') {
      const r = await this.verifyLive(true);
      if (!r.ok) return r;
    }
    this.store.state.runState = 'RUNNING';
    this.log.info(`BOTS STARTED — mode ${this.mode}`, 'BOT_START');
    this.evaluateAll('bot start');
    return { ok: true };
  }

  stopAll() {
    this.store.state.runState = 'STOPPED';
    this.log.warn(`STOP ALL BOTS — strategy execution and new orders halted. Existing positions kept.${this.cfg.general.stopsActiveWhenStopped ? ' Emergency stops remain active.' : ' Emergency stops DISABLED while stopped.'}`, 'BOT_STOP');
    return { ok: true };
  }

  setMode(mode) {
    if (!['PAPER', 'LIVE'].includes(mode)) return { ok: false, msg: 'invalid mode' };
    if (mode === this.mode) return { ok: true };
    if (this.runState === 'RUNNING') return { ok: false, msg: 'Stop bots before switching mode' };
    const cur = this.ms();
    const pend = Object.values(cur.slots).some((s) => s.pending);
    if (pend) return { ok: false, msg: 'Pending/unknown orders exist in current mode' };
    if (this.mode === 'LIVE' && Object.values(cur.slots).some((s) => s.position)) {
      return { ok: false, msg: 'Close LIVE positions before switching to PAPER (their stops would not be monitored)' };
    }
    if (mode === 'LIVE' && !this.liveClient?.hasKeys()) return { ok: false, msg: 'API key not configured' };
    this.cfg.general.mode = mode;
    this.store.saveConfig();
    this.log.warn(`Trading mode switched to ${mode}`, 'MODE_CHANGE');
    if (mode === 'LIVE') this.verifyLive(false);
    return { ok: true };
  }

  resetPaper() {
    if (this.mode === 'PAPER' && this.runState === 'RUNNING') return { ok: false, msg: 'Stop bots first' };
    this.store.state.modes.PAPER = emptyModeState('PAPER', this.cfg);
    this.store.state.modes.PAPER.baseCapital = this.cfg.general.paperInitialBalance;
    this.store.saveStateNow();
    this.log.warn(`Paper account reset to ${this.cfg.general.paperInitialBalance} USDT`, 'PAPER_RESET');
    return { ok: true };
  }

  // ---------- live exchange
  rebuildLiveClient() {
    const s = this.store.secrets;
    const ep = endpoints(!!s.testnet);
    this.liveClient = new BinanceClient({ restBase: ep.rest, spotBase: ep.spot, apiKey: s.apiKey, apiSecret: s.apiSecret });
    this.live = { ...this.live, status: this.liveClient.hasKeys() ? 'UNVERIFIED' : 'NO_KEYS', hedgeMode: null, leverage: {}, account: null, error: null };
  }

  async verifyLive(forStart) {
    const c = this.liveClient;
    if (!c.hasKeys()) { this.live.status = 'NO_KEYS'; return { ok: false, msg: 'API key not configured' }; }
    try {
      await c.syncTime();
      const acct = await c.account();
      this.live.account = parseAccount(acct);
      const pm = await c.positionMode();
      this.live.hedgeMode = !!pm.dualSidePosition;
      for (const sym of SYMBOLS) {
        if (!this.symbolAvailable(sym)) continue;
        const conf = await c.symbolConfig(sym);
        const row = Array.isArray(conf) ? conf.find((x) => x.symbol === sym) : conf;
        this.live.leverage[sym] = row ? Number(row.leverage) : null;
        this.live.marginType = row?.marginType;
      }
      this.live.status = 'CONNECTED';
      this.live.error = null;
      this.live.lastCheck = Date.now();
    } catch (e) {
      this.live.status = 'ERROR';
      this.live.error = e.message;
      this.log.error(`Binance API check failed: ${e.message}`, 'API_ERROR');
      return { ok: false, msg: e.message };
    }
    if (!this.live.hedgeMode) {
      const msg = 'Binance account is in One-way mode. Hedge Mode (dual side position) is required so LONG and SHORT strategy positions do not net out.';
      this.log.error(msg, 'POSITION_MODE');
      return { ok: false, msg };
    }
    if (forStart) {
      for (const sym of SYMBOLS) {
        if (!this.symbolAvailable(sym)) continue;
        const r = await this.ensureLeverage(sym, this.symbolLeverage(sym));
        if (!r.ok) return r;
      }
    }
    return { ok: true };
  }

  async ensureLeverage(sym, lev) {
    if (this.live.leverage[sym] === lev) return { ok: true };
    try {
      const r = await this.liveClient.setLeverage(sym, lev);
      this.live.leverage[sym] = Number(r.leverage);
      this.log.info(`${sym} leverage set to ${r.leverage}x`, 'LEVERAGE');
      return this.live.leverage[sym] === lev ? { ok: true } : { ok: false, msg: `${sym} leverage mismatch` };
    } catch (e) {
      this.log.error(`${sym} set leverage failed: ${e.message}`, 'API_ERROR');
      return { ok: false, msg: `${sym} leverage: ${e.message}` };
    }
  }

  async refreshLiveAccount() {
    const acct = await this.liveClient.account();
    this.live.account = parseAccount(acct);
    this.live.exchangePositions = (acct.positions || []).filter((p) => SYMBOLS.includes(p.symbol));
    this.live.lastCheck = Date.now();
    if (this.live.status !== 'CONNECTED' && this.live.hedgeMode) this.live.status = 'CONNECTED';
    return this.live.account;
  }

  async liveTick() {
    if (this.mode !== 'LIVE' || !this.liveClient.hasKeys()) return;
    try {
      if (this.live.status === 'UNVERIFIED' || this.live.status === 'ERROR') await this.verifyLive(false);
      else await this.refreshLiveAccount();
      this.checkPositionMismatch();
    } catch (e) {
      if (this.live.status !== 'ERROR') this.log.error(`Binance account refresh failed: ${e.message}`, 'API_ERROR');
      this.live.status = 'ERROR';
      this.live.error = e.message;
    }
    await this.resolveUnknownOrders();
    await this.syncExchangeStops();
  }

  // Exchange positions are the truth source. A mismatch is reported, never auto-fixed or hidden.
  checkPositionMismatch() {
    const ex = this.live.exchangePositions;
    if (!ex) return null;
    const r = reconcilePositions({ slots: this.ms('LIVE').slots, exchange: ex, filters: this.md.filters, symbols: SYMBOLS });
    const now = Date.now();
    for (const row of r.rows) {
      if (row.status !== 'MISMATCH') continue;
      const k = `mm:${row.symbol}:${row.side}`;
      if (!this._mm || !this._mm[k] || now - this._mm[k] > 300_000) {
        (this._mm ||= {})[k] = now;
        this.log.warn(`POSITION MISMATCH ${row.symbol} ${row.side}: Exchange Qty ${row.exchangeQty} Internal ${row.internalQty} Diff ${row.diffText}. Manual positions or external changes detected.`, 'POSITION_MISMATCH');
      }
    }
    return r;
  }

  // ---------- evaluation (StrategyScheduler decides WHEN; this decides WHAT on one closed candle)
  evaluateAll(trigger) {
    if (this.scheduler) return this.scheduler.catchUp(trigger);
    for (const sym of SYMBOLS) this.evaluateSymbol(sym, trigger);
  }

  emitChange(reason) { try { this.events.emit('change', { reason, mode: this.mode }); } catch { /* listeners isolated */ } }

  async evaluateSymbol(symbol, trigger) {
    for (const st of strategiesForSymbol(symbol)) {
      try { await this.evaluateSlot(st, symbol, trigger); } catch (e) { this.log.error(`${st} ${symbol} evaluation error: ${e.message}`, 'ENGINE_ERROR'); }
    }
  }

  // Returns an outcome for the Signal Log. final=true -> this candle is done (never evaluated again).
  // opts.allowEntry=false (stale candle after restart / late start): exits still run, new entries are skipped.
  async evaluateSlot(strategy, symbol, trigger, opts = {}) {
    const scfg = this.cfg.strategies[strategy];
    const candles = opts.bars || barsFor(this.md, strategy, symbol, this.cfg);
    const sig = evaluate(strategy, candles, scfg);
    const slot = this.slot(strategy, symbol);
    if (!sig.ready) { slot.view = { notReady: sig.reason }; return { result: 'NOT_READY', reason: sig.reason, final: false, sig }; }
    slot.view = sig.view;
    slot.evalCandle = sig.candleTime;
    if (STRATEGY_META[strategy].trendEntries) slot.trendCount = trendCounts(sig, slot.trendEntries);
    slot.signal = { longCond: sig.longCond, shortCond: sig.shortCond, longExit: sig.longExit, shortExit: sig.shortExit };
    const out = (result, final, extra = {}) => ({ result, final, sig, ...extra });

    if (this.runState !== 'RUNNING') return out('BOT_STOPPED', false);
    if (!scfg.enabled) return out('DISABLED', false);
    // start sync: a flat slot is re-checked on bot start even if this candle was already evaluated
    const startSync = !!opts.startSync && !slot.position && !slot.pending;
    if (slot.lastActedCandle === sig.candleTime && !startSync) return out('ALREADY_EVALUATED', true);
    if (slot.lastSkip && slot.lastSkip.candle !== sig.candleTime) slot.lastSkip = null;
    const sym = symbol.replace('USDT', '');
    const tag = `${strategy} ${sym}`;
    const allowEntry = opts.allowEntry !== false;

    if (slot.pending) return this.skip(slot, sig, 'ORDER_PENDING', `${tag}: order pending/unknown — evaluation deferred`);
    if (this.busy.has(slotKey(strategy, symbol))) return this.skip(slot, sig, 'BUSY', `${tag}: busy`);

    // 1) exits (always allowed: they only reduce risk)
    let exited = null;
    if (slot.position) {
      const side = slot.position.side;
      const ex = exitFor(strategy, sig, slot.position);
      if (ex.exit) {
        this.log.trade(`${tag} ${side} EXIT signal (${ex.reason === 'STRATEGY_EXIT' ? STRATEGY_META[strategy].exitRule(scfg.params) : `${ex.reason} hist ${sig.hist?.toPrecision(4)} vs target ${slot.position.histTarget?.toPrecision(4)}`})${allowEntry ? '' : ' — late evaluation'}`, 'SIGNAL');
        const r = await this.closePosition(strategy, symbol, ex.reason);
        if (!r.ok) {
          if (r.transient) return this.skip(slot, sig, r.code, r.msg);
          slot.lastActedCandle = sig.candleTime;
          return out(`EXIT_FAILED ${r.code || ''}`.trim(), true);
        }
        exited = ex.reason === 'STRATEGY_EXIT' ? `EXIT ${side}` : `EXIT ${side} ${ex.reason}`;
      } else {
        slot.lastSignal = `HOLD ${side}`;
        slot.lastActedCandle = sig.candleTime;
        slot.lastSkip = null;
        return out('HOLD', true, { side });
      }
    }

    // 2) re-arm after stop exits: state condition must turn false first
    if (!sig.longCond) slot.block.LONG = false;
    if (!sig.shortCond) slot.block.SHORT = false;

    // 3) entries
    let side = null;
    if (sig.longCond) side = 'LONG';
    else if (sig.shortCond && scfg.shortEnabled && STRATEGY_META[strategy].supportsShort) side = 'SHORT';
    // bot start: join the trend the strategy is already in (entered on an earlier candle, no exit since),
    // unless this slot was closed after the latest candle close (stop / manual close: wait for the next signal)
    let synced = null;
    if (startSync && !exited && !side) {
      const closedSince = this.ms().trades.some((t) => t.strategy === strategy && t.symbol === symbol && t.exitTime >= (opts.candleClose ?? sig.candleTime));
      synced = closedSince ? null : impliedSide(strategy, candles, scfg);
      if (synced) side = synced.side;
    }

    if (!side) {
      slot.lastSignal = exited ? `EXIT (STRATEGY_EXIT)` : 'WAIT';
      slot.lastActedCandle = sig.candleTime;
      slot.lastSkip = null;
      this.store.saveState();
      return out(exited || 'HOLD', true);
    }
    if (slot.block[side]) {
      slot.lastSignal = `WAIT (${side} re-arm)`;
      slot.lastActedCandle = sig.candleTime;
      if (slot.lastSkip?.code !== 'REARM') this.log.info(`${tag} ${side} condition true but waiting for reset after stop exit`, 'REARM');
      slot.lastSkip = null;
      return out(exited ? `${exited} · WAIT_REARM ${side}` : `WAIT_REARM ${side}`, true);
    }
    // Rayner: at most maxEntriesPerTrend entries per side until a candle closes on the other side of the EMA
    if (STRATEGY_META[strategy].trendEntries && (slot.trendCount?.[side] || 0) >= scfg.params.maxEntriesPerTrend) {
      slot.lastSignal = `WAIT (${side} max entries per trend)`;
      slot.lastActedCandle = sig.candleTime;
      slot.lastSkip = null;
      this.log.info(`${tag} ${side} signal ignored: ${slot.trendCount[side]}/${scfg.params.maxEntriesPerTrend} entries already in this trend`, 'MAX_TREND_ENTRIES');
      this.store.saveState();
      return out(exited ? `${exited} · MAX_TREND_ENTRIES ${side}` : `MAX_TREND_ENTRIES ${side}`, true);
    }
    if (!allowEntry && !startSync) {
      slot.lastSignal = `WAIT (stale ${side} signal skipped)`;
      slot.lastActedCandle = sig.candleTime;
      slot.lastSkip = null;
      this.log.warn(`${tag} ${side} entry signal from candle closed ${new Date(opts.candleClose || sig.candleTime).toISOString()} is stale (${opts.staleReason || 'late'}) — entry skipped, waiting for next candle`, 'STALE_SIGNAL_SKIPPED');
      this.store.saveState();
      return out(exited ? `${exited} · STALE_ENTRY_SKIPPED ${side}` : `STALE_ENTRY_SKIPPED ${side}`, true);
    }
    if (!slot.lastSkip) this.log.trade(synced
      ? `${tag} ${side} start sync: strategy in ${side} since candle ${new Date(synced.since).toISOString()} with no exit — entering at current price (${trigger})`
      : `${tag} ${side} signal (${trigger})`, synced ? 'START_SYNC' : 'SIGNAL');
    const r = await this.openPosition(strategy, symbol, side, sig);
    if (!r.ok && r.transient) return this.skip(slot, sig, r.code, r.msg);
    slot.lastActedCandle = sig.candleTime;
    slot.lastSkip = null;
    this.store.saveState();
    const res = r.ok ? `ENTRY ${side}` : `ENTRY_SKIPPED ${side} ${r.code || ''}`.trim();
    return out(exited ? `${exited} · ${res}` : res, true);
  }

  skip(slot, sig, code, msg) {
    if (!(slot.lastSkip && slot.lastSkip.candle === sig.candleTime && slot.lastSkip.code === code)) {
      this.log.warn(msg, code);
    }
    slot.lastSkip = { candle: sig.candleTime, code };
    const final = !TRANSIENT.has(code);
    if (final) slot.lastActedCandle = sig.candleTime;
    return { result: `SKIP ${code}`, final, sig, transient: !final };
  }

  // ---------- pre-trade checks
  async preTradeChecks(strategy, symbol, side, isExit = false) {
    const scfg = this.cfg.strategies[strategy];
    const g = this.cfg.general;
    const fail = (code, msg) => ({ ok: false, code, msg, transient: TRANSIENT.has(code) });
    const slot = this.slot(strategy, symbol);
    if (!isExit) {
      if (this.runState !== 'RUNNING') return fail('BOT_STOPPED', 'Bot not running');
      if (!scfg.enabled) return fail('STRATEGY_DISABLED', `${strategy} disabled`);
      if (side === 'SHORT' && (!scfg.shortEnabled || !STRATEGY_META[strategy].supportsShort)) return fail('SHORT_DISABLED', `${strategy} short disabled`);
      if (slot.position || slot.status !== 'FLAT') return fail('POSITION_EXISTS', `${strategy} ${symbol} already has a position (${slot.status})`);
      // checked right before every new entry (exits are never blocked by the universe)
      if (this.universe && !this.universe.isTradeAllowed(symbol)) return fail('UNIVERSE_FILTER', `${symbol} is watched but outside the top ${this.universe.cfg.tradeTopN} by 24h quote volume — new entry not allowed`);
    }
    if (slot.pending) return fail('ORDER_PENDING', `${strategy} ${symbol} has pending order`);
    if (this.md.status !== 'CONNECTED' || this.md.isStale(symbol, g.dataStaleSec)) return fail('DATA_DELAY', `${symbol} market data stale/disconnected`);
    const f = this.md.filters[symbol];
    if (!f || f.status !== 'TRADING') return fail('SYMBOL_NOT_TRADABLE', `${symbol} not tradable (${f?.status})`);
    const price = this.md.price(symbol);
    if (!(price > 0)) return fail('NO_PRICE', `${symbol} no price`);

    if (this.mode === 'LIVE') {
      if (this.live.status !== 'CONNECTED') return fail('EXCHANGE_DISCONNECTED', `Binance not connected (${this.live.status})`);
      if (!this.live.hedgeMode) return fail('POSITION_MODE', 'Hedge mode required');
    }
    if (isExit) return { ok: true, price, filters: f };

    const baseAmount = this.amountFor(strategy, side);
    if (!(baseAmount > 0)) return fail('INVALID_AMOUNT', `${strategy} ${side} order amount not set`);
    const ctrl = this.controllerSizing(strategy, side, baseAmount);
    if (ctrl.multiplier === 0) return fail('CONTROLLER_PAUSED', `${strategy} ${symbol} ${side}: controller status ${ctrl.status} (base ${baseAmount} × 0) — entry skipped`);
    const amount = ctrl.amount;
    const lev = this.leverageFor(strategy);
    const qty = floorToStep((amount * lev) / price, f.stepSize);
    if (qty < f.minQty || qty <= 0) return fail('BELOW_MIN_QTY', `${symbol} qty ${qty} < minQty ${f.minQty} (amount ${amount} USDT)`);
    if (qty > f.maxQty) return fail('ABOVE_MAX_QTY', `${symbol} qty ${qty} > maxQty ${f.maxQty}`);
    const notional = qty * price;
    if (notional < f.minNotional) return fail('BELOW_MIN_NOTIONAL', `${symbol} notional ${notional.toFixed(2)} < min ${f.minNotional} USDT`);

    const symLev = this.mode === 'LIVE' ? this.symbolLeverage(symbol) : lev;
    let available;
    if (this.mode === 'LIVE') {
      try { available = (await this.refreshLiveAccount()).available; } catch (e) { return fail('EXCHANGE_DISCONNECTED', `account read failed: ${e.message}`); }
      if (this.live.leverage[symbol] !== symLev) {
        const r = await this.ensureLeverage(symbol, symLev);
        if (!r.ok) return fail('LEVERAGE_MISMATCH', r.msg);
      }
    } else {
      available = this.paperAccount().available;
    }
    const required = (notional / symLev) * (1 + g.balanceBufferPct / 100) + notional * (g.takerFeePct / 100);
    if (available < required) return fail('INSUFFICIENT_BALANCE', `${strategy} ${symbol} ${side}: available ${available.toFixed(2)} < required ${required.toFixed(2)} USDT (order ${amount} USDT @${lev}x) — order skipped`);
    return { ok: true, price, qty, notional, amount, baseAmount, ctrl, filters: f, leverage: lev, available };
  }

  // ---------- open / close
  async openPosition(strategy, symbol, side, sig) {
    const key = slotKey(strategy, symbol);
    if (this.busy.has(key)) return { ok: false, code: 'BUSY', transient: true, msg: 'busy' };
    this.busy.add(key);
    try {
      let chk = await this.preTradeChecks(strategy, symbol, side);
      const tag = `${strategy} ${symbol.replace('USDT', '')}`;
      const scfg = this.cfg.strategies[strategy];
      if (chk.ok && scfg.stop.mode === 'STRUCTURE') {
        // structure stop must be below (long) / above (short) the expected fill price, else no entry
        const slip = this.cfg.general.slippagePct / 100;
        const es = entryStop(scfg.stop, sig, side, chk.price * (1 + dirOf(side) * slip));
        if (es.invalid) chk = { ok: false, code: 'STOP_INVALID', msg: `${tag} ${side}: structure stop ${sig?.structStop?.[side] ?? '—'} is not ${side === 'LONG' ? 'below' : 'above'} the entry price ${chk.price} — entry cancelled`, transient: false };
      }
      if (!chk.ok) {
        // watch-only symbols (outside the trade universe) are expected to be skipped: info, not a warning
        if (!chk.transient) this.log[chk.code === 'UNIVERSE_FILTER' ? 'info' : 'warn'](`${tag} ${side} order skipped: ${chk.msg}`, chk.code);
        return chk;
      }
      const ctlNote = chk.ctrl.status === 'OFF' || chk.ctrl.status === 'NOT_APPLIED' ? '' : ` (base ${chk.baseAmount} × ${chk.ctrl.multiplier} controller ${chk.ctrl.status})`;
      this.log.trade(`${tag} requested order: ${chk.amount} USDT${ctlNote} → qty ${fmtQty(chk.qty, chk.filters.stepSize)} (≈${chk.notional.toFixed(2)} USDT) ${this.mode} ${chk.leverage}x`, 'ORDER_REQUEST');
      const slot = this.slot(strategy, symbol);
      const order = this.newOrderRecord({ strategy, symbol, action: 'OPEN', side, qty: chk.qty, amount: chk.amount, refPrice: chk.price });
      slot.pending = { clientOrderId: order.clientOrderId, action: 'OPEN', side, qty: chk.qty, amount: chk.amount, baseAmount: chk.baseAmount, ctrlMultiplier: chk.ctrl.multiplier, ctrlStatus: chk.ctrl.status, atr: sig?.atr ?? null,
        structStop: sig?.structStop?.[side] ?? null, histTarget: sig?.histTarget?.[side] ?? null, signalCandle: sig?.candleTime ?? null, createdAt: Date.now(), notFound: 0 };
      slot.status = 'PENDING';
      this.store.saveStateNow(); // persist intent BEFORE sending (crash safety)
      return await this.execute(slot, order);
    } finally {
      this.busy.delete(key);
      // filled although the structure stop ended up on the wrong side of the actual fill (slippage) -> undo the entry
      const pos = this.ms().slots[key]?.position;
      if (pos?.stopInvalid && !this.ms().slots[key].pending) {
        this.log.error(`${strategy} ${symbol.replace('USDT', '')} ${pos.side} fill ${pos.entryPrice} is beyond the structure stop ${pos.stopPrice} — closing (entry cancelled)`, 'STOP_INVALID');
        await this.closePosition(strategy, symbol, 'STOP_INVALID');
      }
    }
  }

  async closePosition(strategy, symbol, reason) {
    const key = slotKey(strategy, symbol);
    const slot = this.slot(strategy, symbol);
    if (!slot.position) return { ok: false, code: 'NO_POSITION', msg: 'no position' };
    if (this.busy.has(key)) return { ok: false, code: 'BUSY', transient: true, msg: 'busy' };
    this.busy.add(key);
    try {
      const chk = await this.preTradeChecks(strategy, symbol, slot.position.side, true);
      const tag = `${strategy} ${symbol.replace('USDT', '')}`;
      if (!chk.ok) {
        this.log.error(`${tag} close (${reason}) blocked: ${chk.msg}`, chk.code);
        return chk;
      }
      if (this.mode === 'LIVE' && slot.position.exStop) {
        const c = await this.cancelExchangeStop(slot);
        if (c.triggered) return { ok: true, msg: 'exchange stop already filled' };
        if (!c.ok) {
          this.log.error(`${tag} close (${reason}) deferred: exchange stop cancel failed (${c.msg})`, 'STOP_CANCEL_FAILED');
          return { ok: false, code: 'STOP_CANCEL_FAILED', transient: true, msg: c.msg };
        }
      }
      const pos = slot.position;
      this.log.trade(`${tag} closing ${pos.side} qty ${pos.qty} reason ${reason}`, 'ORDER_REQUEST');
      const order = this.newOrderRecord({ strategy, symbol, action: 'CLOSE', side: pos.side, qty: pos.qty, amount: round(pos.qty * chk.price, 2), refPrice: chk.price, reason });
      slot.pending = { clientOrderId: order.clientOrderId, action: 'CLOSE', side: pos.side, qty: pos.qty, reason, createdAt: Date.now(), notFound: 0 };
      slot.status = 'PENDING';
      this.store.saveStateNow();
      return await this.execute(slot, order);
    } finally {
      this.busy.delete(key);
    }
  }

  newOrderRecord({ strategy, symbol, action, side, qty, amount, refPrice, reason = null }) {
    const ms = this.ms();
    const orderSide = (action === 'OPEN') === (side === 'LONG') ? 'BUY' : 'SELL';
    const clientOrderId = `HIC-${STRATEGY_META[strategy].short}${symbol.slice(0, 3)}-${action[0]}${side[0]}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const o = { id: clientOrderId, clientOrderId, time: Date.now(), mode: this.mode, strategy, symbol, action, positionSide: side, side: orderSide, type: 'MARKET', refPrice, price: null, amount, qty, status: 'SUBMITTED', reason, exchangeOrderId: null, fee: null };
    ms.orders.unshift(o);
    if (ms.orders.length > 500) ms.orders.length = 500;
    return o;
  }

  async execute(slot, order) {
    const tag = `${slot.strategy} ${slot.symbol.replace('USDT', '')}`;
    let fill;
    if (this.mode === 'PAPER') {
      fill = this.paperFill(order);
      this.log.trade(`${tag} paper order filled ${order.side} ${order.qty} @ ${fill.avgPrice}`, 'ORDER_FILLED');
    } else {
      try {
        this.log.trade(`${tag} futures order submitted ${order.side} ${order.positionSide} qty ${order.qty} (${order.clientOrderId})`, 'ORDER_SUBMITTED');
        fill = await this.liveMarketOrder(order);
      } catch (e) {
        if (e instanceof BinanceError && e.definitive) {
          order.status = 'REJECTED';
          order.error = e.message;
          this.revertPending(slot);
          this.log.error(`${tag} ORDER REJECTED: ${e.message}`, 'ORDER_REJECTED');
          this.store.saveStateNow();
          return { ok: false, code: 'ORDER_REJECTED', msg: e.message };
        }
        order.status = 'UNKNOWN';
        order.error = e.message;
        slot.status = 'UNKNOWN';
        this.log.error(`${tag} order result UNKNOWN (${e.message}). Will query by clientOrderId ${order.clientOrderId}; no resend.`, 'ORDER_UNKNOWN');
        this.store.saveStateNow();
        return { ok: false, code: 'ORDER_UNKNOWN', msg: e.message };
      }
      if (fill.pending) {
        order.status = 'UNKNOWN';
        slot.status = 'UNKNOWN';
        this.log.warn(`${tag} order not yet filled (${fill.status}); reconciling`, 'ORDER_UNKNOWN');
        this.store.saveStateNow();
        return { ok: false, code: 'ORDER_UNKNOWN', msg: 'not filled yet' };
      }
      this.log.trade(`${tag} order filled ${order.side} ${fill.executedQty} @ ${fill.avgPrice} fee ${fill.fee.toFixed(4)}`, 'ORDER_FILLED');
    }
    this.applyFill(slot, order, fill);
    if (this.mode === 'LIVE' && slot.position && !slot.position.exStop) await this.placeExchangeStop(slot);
    return { ok: true };
  }

  paperFill(order) {
    const g = this.cfg.general;
    const slip = g.slippagePct / 100;
    const px = order.refPrice * (order.side === 'BUY' ? 1 + slip : 1 - slip);
    const tick = this.md.filters[order.symbol]?.tickSize || 0;
    const avgPrice = tick > 0 ? Math.round(px / tick) * tick : px;
    return { avgPrice: round(avgPrice, 8), executedQty: order.qty, fee: order.qty * avgPrice * (g.takerFeePct / 100), exchangeOrderId: `PAPER-${Date.now()}` };
  }

  async liveMarketOrder(order) {
    const c = this.liveClient;
    const f = this.md.filters[order.symbol];
    let r = await c.newOrder({
      symbol: order.symbol, side: order.side, positionSide: order.positionSide, type: 'MARKET',
      quantity: fmtQty(order.qty, f.stepSize), newClientOrderId: order.clientOrderId, newOrderRespType: 'RESULT',
    });
    order.exchangeOrderId = r.orderId;
    for (let i = 0; i < 6 && r.status !== 'FILLED' && ['NEW', 'PARTIALLY_FILLED'].includes(r.status); i++) {
      await sleep(500);
      try { r = await c.queryOrder(order.symbol, order.clientOrderId); } catch { /* keep last */ }
    }
    return this.fillFromOrder(order, r);
  }

  async fillFromOrder(order, r) {
    const executedQty = Number(r.executedQty || 0);
    if (r.status !== 'FILLED' && !(['CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'].includes(r.status) && executedQty > 0)) {
      return { pending: true, status: r.status };
    }
    const px = (x) => Number(x.avgPrice) || (Number(x.cumQuote) / Number(x.executedQty || executedQty));
    let avgPrice = px(r);
    // the new-order response can omit avgPrice / cumQuote: read them back from the order query
    if (!(avgPrice > 0)) {
      try { avgPrice = px(await this.liveClient.queryOrder(order.symbol, order.clientOrderId)); } catch { /* checked below */ }
    }
    // never open a position without a price (no stop could be set): stays UNKNOWN, resolveUnknownOrders retries
    if (!(avgPrice > 0)) return { pending: true, status: `${r.status} (no fill price)` };
    let fee = executedQty * avgPrice * (this.cfg.general.takerFeePct / 100);
    try {
      const trades = await this.liveClient.userTrades(order.symbol, r.orderId);
      const usdt = trades.filter((t) => t.commissionAsset === 'USDT');
      if (usdt.length && usdt.length === trades.length) fee = usdt.reduce((s, t) => s + Number(t.commission), 0);
    } catch (e) {
      this.log.warn(`fee lookup failed, using configured taker fee: ${e.message}`, 'API_ERROR');
    }
    return { avgPrice, executedQty, fee, exchangeOrderId: r.orderId };
  }

  applyFill(slot, order, fill) {
    const ms = this.ms();
    const tag = `${slot.strategy} ${slot.symbol.replace('USDT', '')}`;
    order.status = 'FILLED';
    order.price = fill.avgPrice;
    order.fee = fill.fee;
    order.exchangeOrderId = fill.exchangeOrderId || order.exchangeOrderId;
    const pend = slot.pending;
    const scfg = this.cfg.strategies[slot.strategy];

    if (pend.action === 'OPEN') {
      const side = pend.side;
      const es = entryStop(scfg.stop, { atr: pend.atr, structStop: { [side]: pend.structStop } }, side, fill.avgPrice);
      const distPct = es.distPct;
      const tick = this.md.filters[slot.symbol]?.tickSize || 0;
      const stopPrice = es.stopPrice == null ? null : roundToTick(es.stopPrice, tick);
      const tpPrice = scfg.takeProfit.enabled ? fill.avgPrice * (1 + dirOf(side) * scfg.takeProfit.pct / 100) : null;
      slot.position = {
        strategy: slot.strategy, symbol: slot.symbol, side, entryPrice: fill.avgPrice, qty: fill.executedQty,
        orderAmount: pend.amount, baseAmount: pend.baseAmount ?? pend.amount, ctrlMultiplier: pend.ctrlMultiplier ?? 1, ctrlStatus: pend.ctrlStatus ?? 'OFF', entryNotional: fill.avgPrice * fill.executedQty, entryFee: fill.fee, funding: 0,
        entryTime: Date.now(), stopPrice, stopPct: distPct, stopMode: scfg.stop.mode, tpPrice, atrAtEntry: pend.atr,
        histTarget: pend.histTarget ?? null, signalCandle: pend.signalCandle ?? null, ...(es.invalid && scfg.stop.mode === 'STRUCTURE' ? { stopInvalid: true } : {}),
        leverage: this.leverageFor(slot.strategy), clientOrderId: order.clientOrderId,
      };
      slot.status = side;
      slot.lastSignal = `${side} ENTRY`;
      if (STRATEGY_META[slot.strategy].trendEntries && !slot.position.stopInvalid && pend.signalCandle != null) slot.trendEntries = recordTrendEntry(slot.trendEntries, side, pend.signalCandle);
      if (ms.wallet != null && this.mode === 'PAPER') ms.wallet -= fill.fee;
      this.log.trade(`${tag} ${side} opened @ ${fill.avgPrice} qty ${fill.executedQty}${stopPrice ? ` — stop initialized ${stopPrice.toPrecision(6)}${distPct != null ? ` (${distPct.toFixed(2)}%)` : ''} ${scfg.stop.mode}` : ' — no emergency stop'}${slot.position.histTarget != null ? ` · hist target ${slot.position.histTarget.toPrecision(4)}` : ''}`, 'STOP_INIT');
    } else {
      const pos = slot.position;
      const qty = Math.min(fill.executedQty, pos.qty);
      const frac = qty / pos.qty;
      const gross = (fill.avgPrice - pos.entryPrice) * qty * dirOf(pos.side);
      const entryFee = pos.entryFee * frac;
      const funding = pos.funding * frac;
      const fee = entryFee + fill.fee;
      const net = gross - fee - funding;
      const entryNotional = pos.entryNotional * frac;
      const trade = {
        id: order.clientOrderId, mode: this.mode, strategy: slot.strategy, symbol: slot.symbol, side: pos.side,
        entryTime: pos.entryTime, exitTime: Date.now(), entryPrice: pos.entryPrice, exitPrice: fill.avgPrice, qty,
        orderAmount: pos.orderAmount * frac, entryNotional, grossPnl: gross, fee, funding: -funding, netPnl: net,
        returnPct: (net / entryNotional) * 100, exitReason: pend.reason, ctrlMultiplier: pos.ctrlMultiplier ?? 1,
      };
      ms.trades.unshift(trade);
      if (ms.trades.length > 2000) ms.trades.length = 2000;
      ms.realizedTotal = (ms.realizedTotal || 0) + net;
      if (this.mode === 'PAPER') ms.wallet += gross - fill.fee;
      this.log.trade(`${tag} ${pos.side} closed @ ${fill.avgPrice} (${pend.reason}) net ${net >= 0 ? '+' : ''}${net.toFixed(2)} USDT (${trade.returnPct.toFixed(2)}%)`, 'POSITION_CLOSED');
      if (qty < pos.qty - 1e-12) {
        pos.qty -= qty; pos.entryFee -= entryFee; pos.funding -= funding; pos.entryNotional -= entryNotional; pos.orderAmount -= trade.orderAmount;
        if (pos.exStop) pos.exStop = { ...pos.exStop, status: 'REPLACE' };
        slot.status = pos.side;
        this.log.warn(`${tag} partial close: remaining qty ${pos.qty}`, 'PARTIAL_FILL');
      } else {
        slot.position = null;
        slot.status = 'FLAT';
        slot.lastSignal = `EXIT (${pend.reason})`;
        if (pend.reason !== 'STRATEGY_EXIT' && STRATEGY_META[slot.strategy].resetAfterStop) slot.block[pos.side] = true;
      }
    }
    slot.pending = null;
    this.store.saveStateNow();
    this.emitChange(pend.action === 'OPEN' ? 'fill' : 'close');
  }

  revertPending(slot) {
    slot.status = slot.position ? slot.position.side : 'FLAT';
    slot.pending = null;
    this.emitChange?.('revert');
  }

  async resolveUnknownOrders() {
    const ms = this.ms('LIVE');
    for (const slot of Object.values(ms.slots)) {
      const p = slot.pending;
      if (!p || slot.status !== 'UNKNOWN') continue;
      const order = ms.orders.find((o) => o.clientOrderId === p.clientOrderId)
        || { clientOrderId: p.clientOrderId, symbol: slot.symbol, strategy: slot.strategy, status: 'UNKNOWN' };
      const tag = `${slot.strategy} ${slot.symbol.replace('USDT', '')}`;
      try {
        const r = await this.liveClient.queryOrder(slot.symbol, p.clientOrderId);
        const fill = await this.fillFromOrder(order, r);
        if (fill.pending) continue;
        this.log.warn(`${tag} unknown order resolved: ${r.status} qty ${fill.executedQty}`, 'ORDER_RESOLVED');
        this.applyFill(slot, order, fill);
        if (slot.position && !slot.position.exStop) await this.placeExchangeStop(slot);
      } catch (e) {
        if (e.code === -2013) {
          p.notFound = (p.notFound || 0) + 1;
          if (p.notFound >= 3 && Date.now() - p.createdAt > 30_000) {
            order.status = 'NOT_PLACED';
            this.revertPending(slot);
            this.log.warn(`${tag} order ${p.clientOrderId} not found on exchange after ${p.notFound} checks — treated as not placed`, 'ORDER_NOT_PLACED');
            this.store.saveStateNow();
          }
        } else {
          this.log.warn(`${tag} unknown order query failed: ${e.message}`, 'API_ERROR');
        }
      }
    }
  }

  async closeAll(reason = 'EMERGENCY_CLOSE') {
    const slots = Object.values(this.ms().slots).filter((s) => s.position);
    this.log.warn(`CLOSE ALL POSITIONS requested (${slots.length} positions, ${this.mode})`, 'CLOSE_ALL');
    const results = [];
    for (const s of slots) results.push({ strategy: s.strategy, symbol: s.symbol, ...(await this.closePosition(s.strategy, s.symbol, reason)) });
    return { ok: results.every((r) => r.ok), results };
  }

  // ---------- price ticks: emergency stop / take profit
  onPrice(symbol, price) {
    const now = Date.now();
    if (now - (this.lastTickCheck[symbol] || 0) < 200) return;
    this.lastTickCheck[symbol] = now;
    const active = this.runState === 'RUNNING' || this.cfg.general.stopsActiveWhenStopped;
    if (!active) return;
    for (const st of strategiesForSymbol(symbol)) {
      const slot = this.ms().slots[slotKey(st, symbol)];
      const pos = slot?.position;
      if (!pos || slot.pending || this.busy.has(slotKey(st, symbol))) continue;
      if (now - (slot.lastStopTry || 0) < 5000) continue; // throttle retries of failed stop closes
      const d = dirOf(pos.side);
      if (pos.stopPrice != null && (price - pos.stopPrice) * d <= 0) {
        const reason = stopReasonOf(pos.stopMode);
        if (this.mode === 'LIVE' && pos.exStop?.status === 'NEW') {
          // Binance holds the stop: give it time to fill, then fall back to a bot market close.
          pos.breachAt ||= now;
          if (now - pos.breachAt < EX_STOP_GRACE_MS) { this.syncExchangeStops(true); continue; }
          this.log.warn(`${st} ${symbol.replace('USDT', '')} exchange stop not filled ${EX_STOP_GRACE_MS / 1000}s after breach — bot fallback close`, 'STOP_FALLBACK');
        }
        slot.lastStopTry = now;
        this.log.warn(`${st} ${symbol.replace('USDT', '')} ${pos.side} EMERGENCY STOP hit: price ${price} vs stop ${pos.stopPrice.toPrecision(6)}`, reason);
        this.closePosition(st, symbol, reason);
      } else if (pos.tpPrice != null && (price - pos.tpPrice) * d >= 0) {
        pos.breachAt = null;
        slot.lastStopTry = now;
        this.log.trade(`${st} ${symbol.replace('USDT', '')} TAKE PROFIT hit @ ${price}`, 'TAKE_PROFIT');
        this.closePosition(st, symbol, 'TAKE_PROFIT');
      } else {
        pos.breachAt = null;
      }
    }
  }

  // ---------- exchange-side emergency stops (LIVE, Binance Algo STOP_MARKET)
  exchangeStopsEnabled() { return this.mode === 'LIVE' && this.cfg.general.exchangeStops; }

  async placeExchangeStop(slot) {
    const pos = slot.position;
    if (!this.exchangeStopsEnabled() || !pos?.stopPrice || pos.stopInvalid) return;
    if (pos.exStop && ['NEW', 'PLACING', 'UNKNOWN', 'TRIGGERED'].includes(pos.exStop.status)) return;
    const f = this.md.filters[slot.symbol];
    const tag = `${slot.strategy} ${slot.symbol.replace('USDT', '')}`;
    const clientAlgoId = `HIC-X${STRATEGY_META[slot.strategy].short}${slot.symbol.slice(0, 3)}${pos.side[0]}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const params = {
      symbol: slot.symbol, side: pos.side === 'LONG' ? 'SELL' : 'BUY', positionSide: pos.side, type: 'STOP_MARKET',
      quantity: fmtQty(pos.qty, f.stepSize), triggerPrice: fmtPrice(pos.stopPrice, f.tickSize),
      workingType: this.cfg.general.stopWorkingType, clientAlgoId,
    };
    pos.exStop = { clientAlgoId, algoId: null, status: 'PLACING', triggerPrice: pos.stopPrice, qty: pos.qty, placedAt: Date.now(), missing: 0 };
    this.store.saveStateNow(); // persist id before sending
    try {
      const r = await this.liveClient.newAlgoOrder(params);
      pos.exStop = { ...pos.exStop, status: 'NEW', algoId: r.algoId ?? null };
      this.log.trade(`${tag} Binance STOP_MARKET placed @ ${params.triggerPrice} qty ${params.quantity} (${params.workingType}, ${clientAlgoId})`, 'EXCHANGE_STOP');
    } catch (e) {
      if (e instanceof BinanceError && e.definitive) {
        pos.exStop = { ...pos.exStop, status: 'FAILED', error: e.message, failedAt: Date.now() };
        this.log.error(`${tag} Binance stop order REJECTED: ${e.message} — bot-side stop remains active`, 'EXCHANGE_STOP_FAILED');
      } else {
        pos.exStop = { ...pos.exStop, status: 'UNKNOWN', error: e.message };
        this.log.error(`${tag} Binance stop order result UNKNOWN (${e.message}) — will verify via open algo orders`, 'EXCHANGE_STOP_UNKNOWN');
      }
    }
    this.store.saveStateNow();
  }

  // Cancels the exchange stop before a bot-initiated close.
  // Returns { ok } | { ok:false, msg } | { triggered:true } (stop already filled -> recorded as stop exit).
  async cancelExchangeStop(slot) {
    const ex = slot.position.exStop;
    const tag = `${slot.strategy} ${slot.symbol.replace('USDT', '')}`;
    if (['FAILED', 'CANCELED'].includes(ex.status)) { slot.position.exStop = null; return { ok: true }; }
    try {
      await this.liveClient.cancelAlgoOrder(ex.clientAlgoId);
      this.log.info(`${tag} Binance stop canceled (${ex.clientAlgoId})`, 'EXCHANGE_STOP');
      slot.position.exStop = null;
      this.store.saveStateNow();
      return { ok: true };
    } catch (e) {
      if (!(e instanceof BinanceError && e.definitive)) return { ok: false, msg: e.message };
      // Rejected cancel: stop may have triggered already, or never existed.
      const st = await this.checkTriggeredStop(slot);
      if (st === 'FILLED') return { triggered: true };
      if (st === 'WORKING') return { ok: false, msg: 'exchange stop is executing' };
      if (st === 'ERROR') return { ok: false, msg: 'stop state unknown' };
      slot.position.exStop = null; // not found anywhere -> safe to close with market order
      return { ok: true };
    }
  }

  // Looks up the regular order created when the algo stop triggered (same clientOrderId).
  // Returns FILLED (and records the exit) | WORKING | NONE | ERROR
  async checkTriggeredStop(slot) {
    const pos = slot.position;
    const ex = pos.exStop;
    let r;
    try {
      r = await this.liveClient.queryOrder(slot.symbol, ex.clientAlgoId);
    } catch (e) {
      return e.code === -2013 ? 'NONE' : 'ERROR';
    }
    const executed = Number(r.executedQty || 0);
    const terminal = ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'].includes(r.status);
    if (!terminal) return 'WORKING';
    if (executed <= 0) return 'NONE';
    const reason = stopReasonOf(pos.stopMode);
    const ms = this.ms('LIVE');
    const order = { id: ex.clientAlgoId, clientOrderId: ex.clientAlgoId, time: Date.now(), mode: 'LIVE', strategy: slot.strategy, symbol: slot.symbol, action: 'CLOSE', positionSide: pos.side, side: pos.side === 'LONG' ? 'SELL' : 'BUY', type: 'STOP_MARKET', refPrice: ex.triggerPrice, price: null, amount: round(executed * Number(r.avgPrice || ex.triggerPrice), 2), qty: executed, status: 'SUBMITTED', reason, exchangeOrderId: r.orderId, fee: null };
    ms.orders.unshift(order);
    const fill = await this.fillFromOrder(order, r);
    slot.pending = { clientOrderId: ex.clientAlgoId, action: 'CLOSE', side: pos.side, qty: pos.qty, reason, createdAt: Date.now(), notFound: 0 };
    pos.exStop = null;
    this.log.warn(`${slot.strategy} ${slot.symbol.replace('USDT', '')} Binance STOP_MARKET filled @ ${fill.avgPrice} qty ${fill.executedQty}`, reason);
    this.applyFill(slot, order, fill);
    return 'FILLED';
  }

  async syncExchangeStops(soon = false) {
    if (!this.exchangeStopsEnabled() || this.live.status !== 'CONNECTED' || this._syncing) return;
    if (soon && Date.now() - (this._lastStopSync || 0) < 3000) return;
    this._syncing = true;
    this._lastStopSync = Date.now();
    try {
      const openBySym = {};
      for (const slot of Object.values(this.ms('LIVE').slots)) {
        const pos = slot.position;
        const key = slotKey(slot.strategy, slot.symbol);
        if (!pos || !pos.stopPrice || slot.pending || this.busy.has(key)) continue;
        this.busy.add(key);
        try {
          await this.syncOneStop(slot, openBySym);
        } catch (e) {
          this.log.warn(`${slot.strategy} ${slot.symbol} stop sync error: ${e.message}`, 'API_ERROR');
        } finally {
          this.busy.delete(key);
        }
      }
    } finally {
      this._syncing = false;
    }
  }

  async syncOneStop(slot, openBySym) {
    const pos = slot.position;
    const ex = pos.exStop;
    const tag = `${slot.strategy} ${slot.symbol.replace('USDT', '')}`;
    if (!ex) return this.placeIfExchangeHasPosition(slot);
    if (ex.status === 'FAILED') {
      if (Date.now() - (ex.failedAt || 0) > 60_000) { pos.exStop = null; return this.placeIfExchangeHasPosition(slot); }
      return;
    }
    if (ex.status === 'REPLACE') {
      const c = await this.cancelExchangeStop(slot);
      if (c.ok && !c.triggered) return this.placeIfExchangeHasPosition(slot);
      return;
    }
    openBySym[slot.symbol] ||= await this.liveClient.openAlgoOrders(slot.symbol);
    const list = Array.isArray(openBySym[slot.symbol]) ? openBySym[slot.symbol] : (openBySym[slot.symbol]?.orders || []);
    const found = list.find((o) => o.clientAlgoId === ex.clientAlgoId);
    if (found) {
      if (ex.status !== 'NEW') this.log.info(`${tag} Binance stop confirmed open (${found.algoStatus || 'NEW'})`, 'EXCHANGE_STOP');
      pos.exStop = { ...ex, status: 'NEW', algoId: found.algoId ?? ex.algoId, missing: 0 };
      return;
    }
    if (ex.status === 'PLACING' && Date.now() - ex.placedAt < 10_000) return;
    const st = await this.checkTriggeredStop(slot);
    if (st === 'FILLED' || st === 'ERROR') return;
    if (st === 'WORKING') { pos.exStop = { ...ex, status: 'TRIGGERED' }; return; }
    pos.exStop = { ...ex, missing: (ex.missing || 0) + 1 };
    if (pos.exStop.missing >= 2) {
      this.log.warn(`${tag} Binance stop ${ex.clientAlgoId} not found (canceled/expired/rejected on exchange) — re-placing`, 'EXCHANGE_STOP_MISSING');
      pos.exStop = null;
      await this.placeIfExchangeHasPosition(slot);
    }
    this.store.saveState();
  }

  // Never place a stop for quantity the exchange position does not have.
  async placeIfExchangeHasPosition(slot) {
    const pos = slot.position;
    const exPos = this.live.exchangePositions;
    if (exPos) {
      const p = exPos.find((x) => x.symbol === slot.symbol && x.positionSide === pos.side);
      const exQty = p ? Math.abs(Number(p.positionAmt)) : 0;
      if (exQty + 1e-12 < pos.qty) {
        const k = `nostop:${slot.strategy}:${slot.symbol}`;
        if (!this._nostop?.[k] || Date.now() - this._nostop[k] > 300_000) {
          (this._nostop ||= {})[k] = Date.now();
          this.log.error(`${slot.strategy} ${slot.symbol} exchange ${pos.side} qty ${exQty} < bot qty ${pos.qty} — Binance stop not placed (check POSITION_MISMATCH)`, 'POSITION_MISMATCH');
        }
        return;
      }
    }
    await this.placeExchangeStop(slot);
  }

  onFunding({ symbol, time, rate, markPrice }) {
    if (!this.cfg.general.includeFunding) return;
    for (const mode of ['PAPER', 'LIVE']) {
      const ms = this.ms(mode);
      for (const slot of Object.values(ms.slots)) {
        const pos = slot.position;
        if (!pos || pos.symbol !== symbol || pos.entryTime >= time) continue;
        const amt = pos.qty * markPrice * rate * dirOf(pos.side); // >0 = paid
        pos.funding += amt;
        if (mode === 'PAPER') ms.wallet -= amt;
        this.log.info(`${slot.strategy} ${symbol.replace('USDT', '')} funding ${amt > 0 ? 'paid' : 'received'} ${Math.abs(amt).toFixed(4)} USDT (rate ${(rate * 100).toFixed(4)}%, ${mode})`, 'FUNDING');
      }
    }
    this.store.saveState();
  }

  checkDataDelay() {
    if (this.md.status !== 'CONNECTED') return;
    for (const sym of SYMBOLS) {
      const stale = this.md.isStale(sym, this.cfg.general.dataStaleSec);
      const k = `stale:${sym}`;
      this._stale ||= {};
      if (stale && !this._stale[k]) this.log.error(`${sym} DATA DELAY: no price update for ${this.cfg.general.dataStaleSec}s`, 'DATA_DELAY');
      if (!stale && this._stale[k]) this.log.info(`${sym} data recovered`);
      this._stale[k] = stale;
    }
  }

  // ---------- accounting
  positionsList(mode = this.mode) {
    const ms = this.ms(mode);
    return Object.values(ms.slots).filter((s) => s.position).map((s) => {
      const p = s.position;
      const mark = this.md.price(p.symbol) ?? p.entryPrice;
      const gross = (mark - p.entryPrice) * p.qty * dirOf(p.side);
      const net = gross - p.entryFee - p.funding;
      return {
        ...p, markPrice: mark, currentValue: mark * p.qty, grossPnl: gross, pnl: net,
        pnlPct: (net / p.entryNotional) * 100, pricePct: ((mark / p.entryPrice) - 1) * 100 * dirOf(p.side),
        holdingMs: Date.now() - p.entryTime, status: s.status,
        stopDistPct: p.stopPrice ? Math.abs(mark - p.stopPrice) / mark * 100 : null,
      };
    });
  }

  paperAccount() {
    const ms = this.ms('PAPER');
    const pos = this.positionsList('PAPER');
    const unreal = pos.reduce((a, p) => a + p.grossPnl, 0);
    const equity = ms.wallet + unreal;
    const used = pos.reduce((a, p) => a + p.entryNotional / (p.leverage || 1), 0);
    return { wallet: ms.wallet, equity, available: Math.max(0, equity - used), unrealized: unreal, usedMargin: used };
  }

  accountSummary() {
    const mode = this.mode;
    const ms = this.ms();
    const pos = this.positionsList();
    let acct;
    if (mode === 'PAPER') acct = this.paperAccount();
    else acct = this.live.account ? { ...this.live.account } : { equity: null, available: null, wallet: null, unrealized: null };
    const openNet = pos.reduce((a, p) => a + p.pnl, 0);
    const totalPnl = (ms.realizedTotal || 0) + openNet;
    const base = mode === 'PAPER' ? (ms.baseCapital ?? this.cfg.general.paperInitialBalance) : (this.live.account?.equity ?? null); // LIVE: current account equity
    const day = utcDay();
    if (!ms.daySnap || ms.daySnap.day !== day) { ms.daySnap = { day, totalPnl }; this.store.saveState(); }
    let longExp = 0, shortExp = 0;
    const bySymbol = {};
    for (const sym of SYMBOLS) bySymbol[sym] = { long: 0, short: 0, net: 0, pnl: 0, count: 0 };
    for (const p of pos) {
      const b = bySymbol[p.symbol];
      if (p.side === 'LONG') { longExp += p.currentValue; b.long += p.currentValue; } else { shortExp += p.currentValue; b.short += p.currentValue; }
      b.pnl += p.pnl; b.count++;
    }
    for (const b of Object.values(bySymbol)) b.net = b.long - b.short;
    // asset-class split (CRYPTO vs TRADFI): exposure + PnL (realized from closed trades + open net)
    const byClass = {};
    for (const c of ASSET_CLASSES) byClass[c] = { long: 0, short: 0, net: 0, gross: 0, unrealized: 0, realized: 0, pnl: 0, positions: 0 };
    for (const [sym, b] of Object.entries(bySymbol)) {
      const k = byClass[assetClassOf(sym)];
      k.long += b.long; k.short += b.short; k.unrealized += b.pnl; k.positions += b.count;
    }
    for (const t of ms.trades) byClass[assetClassOf(t.symbol)].realized += t.netPnl;
    for (const k of Object.values(byClass)) { k.net = k.long - k.short; k.gross = k.long + k.short; k.pnl = k.realized + k.unrealized; }
    return {
      mode, ...acct, invested: pos.reduce((a, p) => a + p.entryNotional, 0), grossExp: longExp + shortExp, byClass,
      todayPnl: totalPnl - ms.daySnap.totalPnl, totalPnl, totalReturnPct: base ? (totalPnl / base) * 100 : null, baseCapital: base,
      realized: ms.realizedTotal || 0, unrealizedNet: openNet,
      longExp, shortExp, netExp: longExp - shortExp, bySymbol, positionsCount: pos.length,
    };
  }

  strategySummary() {
    const ms = this.ms();
    const pos = this.positionsList();
    return STRATEGIES.map((st) => {
      const trades = ms.trades.filter((t) => t.strategy === st);
      const wins = trades.filter((t) => t.netPnl > 0).length;
      const sp = pos.filter((p) => p.strategy === st);
      const c = this.cfg.strategies[st];
      return {
        strategy: st, assetClass: STRATEGY_CLASS[st], enabled: c.enabled, shortEnabled: c.shortEnabled && STRATEGY_META[st].supportsShort,
        longAmount: this.amountFor(st, 'LONG'), shortAmount: this.amountFor(st, 'SHORT'),
        longActual: this.controllerSizing(st, 'LONG', this.amountFor(st, 'LONG')).amount,
        shortActual: this.controllerSizing(st, 'SHORT', this.amountFor(st, 'SHORT')).amount,
        open: sp.length, longs: sp.filter((p) => p.side === 'LONG').length, shorts: sp.filter((p) => p.side === 'SHORT').length,
        unrealized: sp.reduce((a, p) => a + p.pnl, 0), realized: trades.reduce((a, t) => a + t.netPnl, 0),
        trades: trades.length, winRate: trades.length ? (wins / trades.length) * 100 : null,
      };
    });
  }

  snapshot() {
    const ms = this.ms();
    const symbols = {};
    for (const sym of SYMBOLS) {
      const s = this.md.s[sym];
      const meta = SYMBOL_META[sym];
      symbols[sym] = {
        price: s.last, ticker: s.ticker, mark: s.mark, depth: s.depth, filters: this.md.filters[sym] || null, lastTs: s.lastTs, sma200: null,
        assetClass: meta.asset_class, marketType: meta.market_type, underlying: meta.underlying, session: meta.session,
        nativeHistory: meta.nativeHistory || 'FULL', unavailable: s.unavailable || null, signalCandles: s.daily.length,
        underlyingMarket: this.md.underlyingStatus ? this.md.underlyingStatus(sym) : null,
        universe: this.universe && meta.asset_class === 'CRYPTO' ? { rank: this.universe.rows[sym]?.rank ?? null, quoteVolume: this.universe.rows[sym]?.quoteVolume ?? null, tradeAllowed: this.universe.isTradeAllowed(sym) } : null,
      };
    }
    const slots = [];
    for (const sym of SYMBOLS) for (const st of strategiesForSymbol(sym)) {
      const s = this.slot(st, sym);
      slots.push({ strategy: st, symbol: sym, status: this.cfg.strategies[st].enabled ? s.status : (s.position ? s.status : 'OFF'), position: s.position, pending: s.pending, view: s.view, signal: s.signal, evalCandle: s.evalCandle, lastSignal: s.lastSignal, block: s.block, trendCount: s.trendCount || null, exitRule: STRATEGY_META[st].exitRule(this.cfg.strategies[st].params) });
    }
    return {
      ts: Date.now(), mode: this.mode, runState: this.runState,
      conn: { market: this.md.status, exchange: this.mode === 'LIVE' ? this.live.status : 'PAPER', testnet: !!this.store.secrets.testnet, hedgeMode: this.live.hedgeMode, leverage: this.live.leverage, liveError: this.live.error },
      lastDataUpdate: this.md.lastUpdate,
      stopsActiveWhenStopped: this.cfg.general.stopsActiveWhenStopped,
      account: this.accountSummary(),
      strategies: this.strategySummary(),
      symbols, slots,
      positions: this.positionsList(),
      orders: ms.orders.slice(0, 200),
      trades: ms.trades.slice(0, 500),
    };
  }
}

function parseAccount(a) {
  return {
    equity: Number(a.totalMarginBalance),
    wallet: Number(a.totalWalletBalance),
    available: Number(a.availableBalance),
    unrealized: Number(a.totalUnrealizedProfit),
  };
}
