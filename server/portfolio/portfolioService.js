// Portfolio: account state (Exchange View = truth source) + strategy attribution (Strategy View).
// LIVE : Binance REST snapshot (/fapi/v3/account + /fapi/v3/positionRisk) refreshed periodically and
//        updated between snapshots by the User Data Stream (ACCOUNT_UPDATE / ORDER_TRADE_UPDATE).
// PAPER: the simulated paper account is the "exchange".
// Mismatches between exchange and strategy ledger are reported (RECONCILIATION WARNING), never hidden or fixed.
import { EventEmitter } from 'node:events';
import { SYMBOLS } from '../store.js';
import { assetClassOf, ASSET_CLASSES } from '../assets.js';
import { ALL_STRATEGIES, STRATEGY_CLASS } from '../strategyRegistry.js';
import { endpoints } from '../binance.js';
import { reconcilePositions } from './reconcile.js';
import { UserDataStream } from './userDataStream.js';
import { EquityHistory } from './equityHistory.js';

const DAY = 86_400_000;
const dirOf = (side) => (side === 'LONG' ? 1 : -1);
const utcDayStart = (ts = Date.now()) => Math.floor(ts / DAY) * DAY;
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
const PERIODS = { TODAY: null, '7D': 7 * DAY, '30D': 30 * DAY, ALL: Infinity };

export class PortfolioService extends EventEmitter {
  constructor({ store, engine, md, log, history = new EquityHistory(), userStream = null, now = () => Date.now() }) {
    super();
    this.store = store;
    this.engine = engine;
    this.md = md;
    this.log = log;
    this.history = history;
    this.now = now;
    this.exchange = null; // LIVE snapshot { wallet, available, marginBalance, unrealized, positions[], restAt, wsAt, source }
    this.recon = { ok: true, rows: [], mismatches: [], warnings: [], checkedAt: null };
    this.mmSeen = {};
    this.uds = userStream;
    this.timers = [];
  }

  // ---------- lifecycle
  start() {
    if (!this.uds) {
      this.uds = new UserDataStream({ getClient: () => this.engine.liveClient, wsBase: endpoints(!!this.store.secrets.testnet).ws, log: this.log });
    }
    this.uds.on('account', (a, raw) => { this.applyAccountUpdate(a, raw); this.changed('account update'); });
    this.uds.on('order', (o) => this.onOrderUpdate(o));
    this.uds.on('connected', () => this.refreshExchange('user stream connected').catch(() => {}));
    this.engine.events.on('change', () => {
      this.refreshSoon();
      this.recordEquity(true);
      this.changed('engine');
    });
    const every = (ms, fn) => { const t = setInterval(() => fn().catch?.((e) => this.log.warn(`portfolio: ${e.message}`, 'PORTFOLIO')), ms); t.unref?.(); this.timers.push(t); };
    every(15_000, async () => this.tick());
    every(60_000, async () => this.refreshIncome());
    every(60_000, async () => this.recordEquity());
    this.tick().catch(() => {});
  }

  async tick() {
    this.manageStream();
    if (this.isLive()) await this.refreshExchange('periodic');
    this.reconcile();
    this.recordEquity();
  }

  isLive() { return this.engine.mode === 'LIVE' && !!this.engine.liveClient?.hasKeys(); }

  manageStream() {
    const want = this.isLive() && this.engine.live.status === 'CONNECTED';
    if (this._client && this._client !== this.engine.liveClient) { this.uds.stop(); this.exchange = null; } // API key changed
    this._client = this.engine.liveClient;
    if (want && !this.uds.running) {
      this.uds.wsBase = endpoints(!!this.store.secrets.testnet).ws;
      this.uds.start();
    } else if (!want && this.uds.running) this.uds.stop();
  }

  changed(reason) { this.emit('change', reason); }

  refreshSoon() {
    if (!this.isLive() || this._soon) return;
    this._soon = setTimeout(() => { this._soon = null; this.refreshExchange('after fill').then(() => this.changed('rest')).catch(() => {}); }, 800);
    this._soon.unref?.();
  }

  // ---------- exchange state (LIVE)
  async refreshExchange(reason) {
    if (!this.isLive() || this._refreshing) return;
    this._refreshing = true;
    try {
      const c = this.engine.liveClient;
      const [acct, risk] = await Promise.all([c.account(), c.positionRisk()]);
      this.applyRest(acct, risk);
      this.engine.live.exchangePositions = (acct.positions || []).filter((p) => SYMBOLS.includes(p.symbol));
      this.reconcile();
    } catch (e) {
      if (this.exchange) this.exchange.error = e.message;
      if (!this._restErr || this.now() - this._restErr > 300_000) { this._restErr = this.now(); this.log.warn(`Portfolio REST snapshot failed (${reason}): ${e.message}`, 'PORTFOLIO'); }
    } finally {
      this._refreshing = false;
    }
  }

  applyRest(acct, risk) {
    const lev = this.engine.live.leverage || {};
    const positions = (Array.isArray(risk) ? risk : []).filter((p) => Number(p.positionAmt) !== 0).map((p) => {
      const qty = Math.abs(Number(p.positionAmt));
      const side = p.positionSide === 'SHORT' || (p.positionSide === 'BOTH' && Number(p.positionAmt) < 0) ? 'SHORT' : 'LONG';
      return {
        symbol: p.symbol, side, qty, entryPrice: Number(p.entryPrice), markPrice: Number(p.markPrice),
        notional: Math.abs(Number(p.notional)), unrealized: Number(p.unRealizedProfit), liquidationPrice: Number(p.liquidationPrice) || null,
        initialMargin: Number(p.initialMargin ?? p.positionInitialMargin) || null, leverage: lev[p.symbol] ?? null, updateTime: Number(p.updateTime) || null,
      };
    });
    this.exchange = {
      source: 'REST', restAt: this.now(), wsAt: this.exchange?.wsAt ?? null, error: null,
      wallet: Number(acct.totalWalletBalance), available: Number(acct.availableBalance),
      marginBalance: Number(acct.totalMarginBalance), unrealized: Number(acct.totalUnrealizedProfit),
      positionInitialMargin: Number(acct.totalPositionInitialMargin ?? acct.totalInitialMargin) || null,
      positions,
    };
  }

  // ACCOUNT_UPDATE: a.B balances { a, wb, cw, bc }, a.P positions { s, pa, ep, up, ps, ... }, a.m reason
  applyAccountUpdate(a, raw = {}) {
    if (!this.exchange) return; // wait for the first REST snapshot
    const ex = this.exchange;
    const usdt = (a.B || []).find((b) => b.a === 'USDT');
    if (usdt) ex.wallet = Number(usdt.wb);
    for (const p of a.P || []) {
      if (!SYMBOLS.includes(p.s)) continue;
      const side = p.ps === 'SHORT' || (p.ps === 'BOTH' && Number(p.pa) < 0) ? 'SHORT' : 'LONG';
      const qty = Math.abs(Number(p.pa));
      const i = ex.positions.findIndex((x) => x.symbol === p.s && x.side === side);
      if (qty === 0) { if (i >= 0) ex.positions.splice(i, 1); } else {
        const mark = this.md.s[p.s]?.mark?.price ?? this.md.price(p.s) ?? Number(p.ep);
        const row = { ...(i >= 0 ? ex.positions[i] : { symbol: p.s, side, leverage: this.engine.live.leverage?.[p.s] ?? null, liquidationPrice: null, initialMargin: null }),
          qty, entryPrice: Number(p.ep), unrealized: Number(p.up), markPrice: mark, notional: qty * mark, updateTime: raw.T ?? null };
        if (i >= 0) ex.positions[i] = row; else ex.positions.push(row);
      }
      // keep the engine's exchange view (used for stop placement safety) consistent
      const ep = (this.engine.live.exchangePositions ||= []);
      const j = ep.findIndex((x) => x.symbol === p.s && x.positionSide === p.ps);
      if (j >= 0) ep[j] = { ...ep[j], positionAmt: p.pa }; else ep.push({ symbol: p.s, positionSide: p.ps, positionAmt: p.pa });
    }
    ex.unrealized = sum(ex.positions, (p) => p.unrealized);
    ex.marginBalance = ex.wallet + ex.unrealized;
    ex.source = 'WS';
    ex.wsAt = this.now();
    if (a.m === 'FUNDING_FEE') this.log.info('Funding fee settled (user data stream)', 'FUNDING');
    this.reconcile();
  }

  // ORDER_TRADE_UPDATE .o: c clientOrderId, X status, x exec type, l last qty, L last price, rp realized, n fee
  onOrderUpdate(o) {
    const filled = o.X === 'FILLED' || o.X === 'PARTIALLY_FILLED';
    if (!filled) return;
    const id = String(o.c || '');
    if (id.startsWith('HIC-X')) {
      // Binance emergency stop filled while we watch -> record it now instead of waiting for the next sync
      this.engine.syncExchangeStops().catch?.(() => {});
    } else if (id.startsWith('HIC-')) {
      this.engine.resolveUnknownOrders().catch?.(() => {});
    } else {
      this.log.warn(`External order fill on ${o.s} ${o.ps || ''} ${o.S} ${o.l} @ ${o.L} (not placed by this bot) — shown as UNATTRIBUTED, not hidden`, 'EXTERNAL_ORDER');
    }
    this.refreshSoon();
    this.changed('order update');
  }

  async refreshIncome() {
    if (!this.isLive()) return;
    const m = this.history.m('LIVE');
    const now = this.now();
    let start = Math.max((m.incomeCursor ?? 0) + 1, now - 30 * DAY);
    for (let page = 0; page < 10; page++) {
      const rows = await this.engine.liveClient.income({ startTime: start, endTime: now });
      if (!Array.isArray(rows) || !rows.length) break;
      this.history.addIncome('LIVE', rows);
      const maxT = Math.max(...rows.map((r) => Number(r.time)));
      m.incomeCursor = maxT;
      if (rows.length < 1000) break;
      start = maxT + 1;
    }
    if (m.incomeCursor == null) m.incomeCursor = now - 1;
  }

  // ---------- reconciliation (LIVE)
  reconcile() {
    if (this.engine.mode !== 'LIVE' || !this.exchange) {
      this.recon = { ok: true, rows: [], mismatches: [], warnings: [], checkedAt: this.now(), na: this.engine.mode === 'PAPER' ? 'PAPER' : 'NO_SNAPSHOT' };
      return this.recon;
    }
    const exRows = this.exchange.positions.map((p) => ({ symbol: p.symbol, positionSide: p.side, positionAmt: p.qty }));
    const r = reconcilePositions({ slots: this.engine.ms('LIVE').slots, exchange: exRows, filters: this.md.filters, symbols: SYMBOLS });
    // a mismatch must persist across two checks >= 5 s apart (a fill can reach WS before the ledger)
    const now = this.now();
    const confirmed = [];
    for (const row of r.rows) {
      const k = `${row.symbol}:${row.side}`;
      if (row.status !== 'MISMATCH') { delete this.mmSeen[k]; continue; }
      const first = this.mmSeen[k] && this.mmSeen[k].diff === row.diff ? this.mmSeen[k].at : now;
      this.mmSeen[k] = { at: first, diff: row.diff };
      if (now - first >= 5000) confirmed.push(row); else row.status = 'SYNCING';
    }
    const newly = confirmed.filter((x) => !this.recon.mismatches?.some((y) => y.symbol === x.symbol && y.side === x.side && y.diff === x.diff));
    for (const x of newly) this.log.warn(`RECONCILIATION WARNING ${x.symbol} ${x.side}: Exchange Qty ${x.exchangeQty} Internal ${x.internalQty} Diff ${x.diffText}`, 'POSITION_MISMATCH');
    this.recon = { ...r, mismatches: confirmed, ok: confirmed.length === 0, warnings: confirmed.map((x) => `${x.symbol.replace('USDT', '')} ${x.side} Exchange Qty ${x.exchangeQty} Internal ${x.internalQty} Diff ${x.diffText}`), checkedAt: now };
    return this.recon;
  }

  // ---------- equity history
  strategyCum(mode) {
    const ms = this.engine.ms(mode);
    const out = {};
    for (const st of ALL_STRATEGIES) out[st] = 0;
    for (const t of ms.trades) out[t.strategy] = (out[t.strategy] || 0) + t.netPnl;
    for (const p of this.engine.positionsList(mode)) out[p.strategy] = (out[p.strategy] || 0) + p.pnl;
    for (const k of Object.keys(out)) out[k] = Number(out[k].toFixed(4));
    return out;
  }

  recordEquity(force = false) {
    const now = this.now();
    if (!force && now - (this._lastRec || 0) < 55_000) return;
    this._lastRec = now;
    const pa = this.engine.paperAccount();
    this.history.record('PAPER', { equity: pa.equity, wallet: pa.wallet, unrealized: pa.unrealized, strat: this.strategyCum('PAPER') }, now);
    const ex = this.exchange;
    if (this.isLive() && ex && now - Math.max(ex.restAt || 0, ex.wsAt || 0) < 120_000) {
      this.history.record('LIVE', { equity: ex.marginBalance, wallet: ex.wallet, unrealized: ex.unrealized, strat: this.strategyCum('LIVE') }, now);
    }
  }

  equitySeries(range = '1M', mode = this.engine.mode) {
    const pts = this.history.series(mode, range, this.now());
    return { mode, range, strategies: ALL_STRATEGIES, points: pts.map((p) => ({ t: p.t, equity: p.equity, adj: p.equity - (p.flow || 0), strat: p.strat })) };
  }

  // ---------- views
  exchangeView(mode) {
    if (mode === 'PAPER') {
      const pa = this.engine.paperAccount();
      const agg = {};
      for (const p of this.engine.positionsList('PAPER')) {
        const k = `${p.symbol}:${p.side}`;
        const a = (agg[k] ||= { symbol: p.symbol, side: p.side, qty: 0, cost: 0, notional: 0, unrealized: 0, leverage: p.leverage, liquidationPrice: null, markPrice: p.markPrice });
        a.qty += p.qty; a.cost += p.entryNotional; a.notional += p.currentValue; a.unrealized += p.grossPnl;
      }
      const positions = Object.values(agg).map((a) => ({ ...a, qty: Number(a.qty.toFixed(8)), entryPrice: a.cost / a.qty, initialMargin: a.notional / (a.leverage || 1) }));
      return { source: 'PAPER (simulated account)', live: false, wallet: pa.wallet, available: pa.available, marginBalance: pa.equity, unrealized: pa.unrealized, positions, updatedAt: this.now(), stream: 'N/A' };
    }
    const ex = this.exchange;
    const acct = this.engine.live.account;
    if (!ex) {
      return { source: acct ? 'REST (account only)' : 'NO DATA', live: true, wallet: acct?.wallet ?? null, available: acct?.available ?? null, marginBalance: acct?.equity ?? null, unrealized: acct?.unrealized ?? null, positions: [], updatedAt: this.engine.live.lastCheck || null, stream: this.uds?.status || 'OFF', error: this.engine.live.error };
    }
    return { source: ex.source, live: true, wallet: ex.wallet, available: ex.available, marginBalance: ex.marginBalance, unrealized: ex.unrealized, positions: ex.positions, updatedAt: Math.max(ex.restAt || 0, ex.wsAt || 0), restAt: ex.restAt, wsAt: ex.wsAt, stream: this.uds?.status || 'OFF', error: ex.error };
  }

  build() {
    const e = this.engine;
    const mode = e.mode;
    const now = this.now();
    const dayStart = utcDayStart(now);
    const ms = e.ms(mode);
    const acct = e.accountSummary();
    const exView = this.exchangeView(mode);
    const ledger = e.positionsList(mode);
    const trades = ms.trades;
    const recon = mode === 'LIVE' ? this.recon : { ok: true, rows: [], mismatches: [], warnings: [], na: 'PAPER' };

    // --- positions: strategy-attributed rows + UNATTRIBUTED residuals from the exchange
    const exPos = (sym, side) => exView.positions.find((p) => p.symbol === sym && p.side === side);
    const rows = ledger.map((p) => {
      const x = exPos(p.symbol, p.side);
      return {
        assetClass: assetClassOf(p.symbol), strategy: p.strategy, symbol: p.symbol, side: p.side, leverage: p.leverage,
        entryPrice: p.entryPrice, markPrice: p.markPrice, qty: p.qty, positionValue: p.currentValue, cost: p.entryNotional,
        margin: p.currentValue / (p.leverage || 1), unrealized: p.pnl, grossPnl: p.grossPnl, pnlPct: p.pnlPct, stopPrice: p.stopPrice,
        stopDistPct: p.stopDistPct, exStop: p.exStop?.status || null, funding: -(p.funding || 0), fees: p.entryFee, holdingMs: p.holdingMs,
        entryTime: p.entryTime, ctrlMultiplier: p.ctrlMultiplier ?? 1, liquidationPrice: x?.liquidationPrice ?? null, attributed: true,
      };
    });
    if (mode === 'LIVE') {
      for (const r of recon.rows) {
        if (!(r.diff > 0) || r.status === 'SYNCING') continue;
        const x = exPos(r.symbol, r.side);
        const mark = x?.markPrice ?? e.md.price(r.symbol);
        rows.push({
          assetClass: assetClassOf(r.symbol), strategy: 'UNATTRIBUTED', symbol: r.symbol, side: r.side, leverage: x?.leverage ?? null,
          entryPrice: x?.entryPrice ?? null, markPrice: mark, qty: r.diff, positionValue: r.diff * mark, cost: x?.entryPrice ? r.diff * x.entryPrice : null,
          margin: x?.leverage ? (r.diff * mark) / x.leverage : null, unrealized: x?.entryPrice ? (mark - x.entryPrice) * r.diff * dirOf(r.side) : null,
          pnlPct: null, stopPrice: null, funding: null, holdingMs: null, liquidationPrice: x?.liquidationPrice ?? null, attributed: false,
          note: 'exchange position not opened by a strategy (manual / external)',
        });
      }
    }

    // --- exposure (shorts shown as short exposure, not as negative assets)
    const exposure = { grossLong: 0, grossShort: 0, net: 0, gross: 0, bySymbol: {}, byClass: {} };
    for (const c of ASSET_CLASSES) exposure.byClass[c] = { long: 0, short: 0, net: 0, gross: 0 };
    for (const sym of SYMBOLS) exposure.bySymbol[sym] = { long: 0, short: 0, net: 0, gross: 0, rows: [] };
    for (const r of rows) {
      const b = exposure.bySymbol[r.symbol];
      const v = r.positionValue || 0;
      if (r.side === 'LONG') { b.long += v; exposure.grossLong += v; exposure.byClass[r.assetClass].long += v; } else { b.short += v; exposure.grossShort += v; exposure.byClass[r.assetClass].short += v; }
      b.rows.push({ strategy: r.strategy, side: r.side, value: v * dirOf(r.side) });
    }
    for (const b of [...Object.values(exposure.bySymbol), ...Object.values(exposure.byClass)]) { b.net = b.long - b.short; b.gross = b.long + b.short; }
    exposure.net = exposure.grossLong - exposure.grossShort;
    exposure.gross = exposure.grossLong + exposure.grossShort;

    // --- allocation of equity: margin per asset + cash
    const equity = exView.marginBalance ?? acct.equity;
    const alloc = {};
    for (const sym of SYMBOLS) alloc[sym] = { symbol: sym, assetClass: assetClassOf(sym), margin: 0, notional: 0 };
    const allocSrc = mode === 'LIVE' && this.exchange ? exView.positions : rows;
    for (const p of allocSrc) {
      const a = alloc[p.symbol];
      if (!a) continue;
      const notional = p.notional ?? p.positionValue ?? 0;
      a.notional += notional;
      a.margin += p.initialMargin ?? p.margin ?? notional / (p.leverage || 1);
    }
    const usedMargin = sum(Object.values(alloc), (a) => a.margin);
    const cash = Math.max(0, (equity ?? 0) - usedMargin);
    const pctOf = (v) => (equity > 0 ? (v / equity) * 100 : null);
    const allocation = {
      equity, usedMargin, cash, cashPct: pctOf(cash),
      bySymbol: Object.values(alloc).map((a) => ({ ...a, pct: pctOf(a.margin) })),
      byClass: {
        ...Object.fromEntries(ASSET_CLASSES.map((c) => { const m = sum(Object.values(alloc).filter((a) => a.assetClass === c), (a) => a.margin); return [c, { margin: m, pct: pctOf(m) }]; })),
        CASH: { margin: cash, pct: pctOf(cash) },
      },
    };

    // --- strategy view (attribution)
    const todayTrades = trades.filter((t) => t.exitTime >= dayStart);
    const strategyView = ALL_STRATEGIES.map((st) => {
      const sp = ledger.filter((p) => p.strategy === st);
      const tr = trades.filter((t) => t.strategy === st);
      return {
        strategy: st, assetClass: STRATEGY_CLASS[st], enabled: !!this.store.config.strategies[st]?.enabled, positions: sp.length,
        invested: sum(sp, (p) => p.entryNotional), positionValue: sum(sp, (p) => p.currentValue),
        long: sum(sp.filter((p) => p.side === 'LONG'), (p) => p.currentValue), short: sum(sp.filter((p) => p.side === 'SHORT'), (p) => p.currentValue),
        unrealized: sum(sp, (p) => p.pnl), realizedToday: sum(todayTrades.filter((t) => t.strategy === st), (t) => t.netPnl), realizedTotal: sum(tr, (t) => t.netPnl),
        fees: sum(tr, (t) => t.fee) + sum(sp, (p) => p.entryFee), funding: sum(tr, (t) => t.funding) - sum(sp, (p) => p.funding), trades: tr.length,
        ctrlMultipliers: [...new Set(sp.map((p) => p.ctrlMultiplier ?? 1))],
      };
    });
    const unattributedValue = sum(rows.filter((r) => !r.attributed), (r) => r.positionValue);

    // --- PnL breakdown by period × group (realized from closed trades in the period; unrealized = open, current)
    const group = (list, keyFn, open) => {
      const g = {};
      const slot = (k) => (g[k] ||= { realized: 0, gross: 0, fees: 0, funding: 0, trades: 0, unrealized: 0 });
      for (const t of list) { const s = slot(keyFn(t)); s.realized += t.netPnl; s.gross += t.grossPnl; s.fees += t.fee; s.funding += t.funding; s.trades++; }
      for (const p of open) slot(keyFn(p)).unrealized += p.pnl;
      for (const s of Object.values(g)) s.net = s.realized + s.unrealized;
      return g;
    };
    const pnl = {};
    for (const [k, span] of Object.entries(PERIODS)) {
      const from = k === 'TODAY' ? dayStart : span === Infinity ? -Infinity : now - span;
      const list = trades.filter((t) => t.exitTime >= from);
      pnl[k] = {
        bySymbol: group(list, (t) => t.symbol, ledger), byStrategy: group(list, (t) => t.strategy, ledger),
        byClass: group(list, (t) => assetClassOf(t.symbol), ledger),
        total: { realized: sum(list, (t) => t.netPnl), gross: sum(list, (t) => t.grossPnl), fees: sum(list, (t) => t.fee), funding: sum(list, (t) => t.funding), trades: list.length },
      };
    }
    // exchange income (LIVE truth for realized PnL / fees / funding)
    let exchangeIncome = null;
    if (mode === 'LIVE') {
      const inc = this.history.m('LIVE').income;
      const agg = (from) => { const l = inc.filter((r) => r.time >= from && r.asset === 'USDT'); const by = (ty) => sum(l.filter((r) => r.incomeType === ty), (r) => r.income); return { realized: by('REALIZED_PNL'), commission: by('COMMISSION'), funding: by('FUNDING_FEE'), transfer: by('TRANSFER'), net: by('REALIZED_PNL') + by('COMMISSION') + by('FUNDING_FEE') }; };
      exchangeIncome = { TODAY: agg(dayStart), '7D': agg(now - 7 * DAY), '30D': agg(now - 30 * DAY), cursor: this.history.m('LIVE').incomeCursor };
    }

    // --- costs (ALL): gross / fees / funding / net
    const costs = {
      gross: sum(trades, (t) => t.grossPnl) + sum(ledger, (p) => p.grossPnl),
      fees: sum(trades, (t) => t.fee) + sum(ledger, (p) => p.entryFee),
      funding: sum(trades, (t) => t.funding) - sum(ledger, (p) => p.funding),
    };
    costs.net = costs.gross - costs.fees + costs.funding;

    const dd = this.history.drawdown(mode);
    const realizedToday = mode === 'LIVE' && exchangeIncome && this.history.m('LIVE').incomeCursor ? exchangeIncome.TODAY.net : sum(todayTrades, (t) => t.netPnl);
    const ctl = (() => { try { return this.engine.controller?.cfg?.mode || 'OFF'; } catch { return 'OFF'; } })();

    return {
      ts: now, mode, runState: e.runState, controllerMode: ctl,
      summary: {
        equity, available: exView.available, wallet: exView.wallet, unrealized: exView.unrealized,
        invested: sum(rows, (r) => r.cost), positionValue: sum(rows, (r) => r.positionValue),
        realizedToday, realizedTodaySource: mode === 'LIVE' && exchangeIncome?.cursor ? 'BINANCE_INCOME' : 'LEDGER',
        todayPnl: acct.todayPnl, totalPnl: acct.totalPnl, totalReturnPct: acct.totalReturnPct, baseCapital: acct.baseCapital,
      },
      exchange: exView, strategyView, unattributedValue, reconciliation: recon, allocation, exposure,
      positions: rows, pnl, exchangeIncome, costs, drawdown: dd,
    };
  }
}
