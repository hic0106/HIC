// Market data: REST bootstrap + combined WebSocket streams (routed /market and /public paths).
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { BinanceClient, endpoints, parseSymbolFilters } from './binance.js';
import { SYMBOL_META, isSessionSymbol, assetClassOf } from './assets.js';
import { BinanceUsSessionProvider } from './dataProviders.js';
import { DEFAULT_US_CALENDAR, marketStatus } from './session.js';
import { US_SESSION } from './scheduler/timeframes.js';

export const CHART_INTERVALS = ['5m', '15m', '1h', '4h', '1d'];
export const SESSION_INTERVAL = 'US1D'; // chart of US regular-session candles (QQQ signal data)
const DAILY = '1d';
const DAILY_HISTORY = 500;
// Closed-candle series kept for strategies: only the intervals crypto strategies use (config), 1000 bars each
// (SMA200 warm-up; 1000 x 4h ≈ 166 days). '1d' uses the daily series. Intervals in CHART_INTERVALS arrive by
// WebSocket; the others (1m, 3m, 30m, 2h, 6h, 8h, 12h, 3d, 1w, 1M) are polled via REST after each expected close.
const BAR_KEEP = 1000;
const POLL_LIMIT = 99; // < 100 -> request weight 1

// v = base asset volume, qv = quote asset volume (USDT turnover: REST index 7, ws field "q")
export const toCandle = (a) => ({ t: a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], v: +a[5], T: a[6], qv: a[7] != null ? +a[7] : null });
const wsCandle = (k) => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, T: k.T, qv: k.q != null ? +k.q : null });

// Streams per watched symbol. Every watched symbol currently gets all chart intervals + ticker + mark + depth
// (Top 20 ≈ 150 market streams on one connection; Binance allows 1024).
// TODO(load): strategies only need 4h / 1d klines + ticker + markPrice for every watched symbol; 5m/15m/1h klines and
// depth could be subscribed for the symbol selected in the UI only (would need runtime SUBSCRIBE / UNSUBSCRIBE).
export const STRATEGY_STREAM_INTERVALS = ['4h', '1d'];

export class MarketData extends EventEmitter {
  constructor(symbols, logger, { getCalendar, barIntervals = ['4h'] } = {}) {
    super();
    this.symbols = symbols;
    this.barIntervals = new Set(barIntervals.filter((i) => i !== DAILY));
    this.log = logger;
    this.getCalendar = getCalendar || (() => DEFAULT_US_CALENDAR);
    const ep = endpoints(false); // market data always from mainnet (public, no key)
    this.rest = new BinanceClient({ restBase: ep.rest });
    this.wsBase = ep.ws;
    this.filters = {};
    this.s = {};
    for (const sym of symbols) {
      this.s[sym] = {
        daily: [], // closed daily candles (QQQ: closed US regular-session candles)
        forming: null, // current (open) daily candle
        bars: Object.fromEntries([...this.barIntervals].map((i) => [i, []])), // closed candles for strategies, per interval
        formingBar: {}, // interval -> open candle
        last: null, lastTs: 0,
        ticker: null, mark: null, depth: null,
        assetClass: assetClassOf(sym), unavailable: null,
        // QQQ: US regular-session signal provider; crypto: UTC daily (null)
        session: isSessionSymbol(sym) ? new BinanceUsSessionProvider({ rest: this.rest, symbol: sym, listedAt: SYMBOL_META[sym].listedAt, getCalendar: () => this.getCalendar(), log: logger }) : null,
      };
    }
    this.status = 'CONNECTING';
    this.lastUpdate = 0;
    this.sockets = {};
    this.chartCache = new Map();
  }

  async start() {
    await this.loadExchangeInfo();
    for (const sym of this.symbols) {
      if (!this.s[sym].session) {
        // a watched (e.g. protected) crypto symbol that no longer exists on Binance must not block the others
        if (!this.filters[sym]) { this.markUnavailable(sym, 'symbol not found in Binance exchangeInfo'); continue; }
        await this.loadDaily(sym); await this.loadBars(sym); continue;
      }
      // TradFi symbols are isolated: a failure never blocks crypto trading
      if (!this.filters[sym]) { this.markUnavailable(sym, 'symbol not found in Binance exchangeInfo'); continue; }
      try { await this.loadSession(sym); } catch (e) { this.markUnavailable(sym, `session history load failed: ${e.message}`); }
    }
    const live = this.symbols.filter((s) => !this.s[s].unavailable);
    this.connect('market', live.flatMap((s) => {
      const l = s.toLowerCase();
      const extra = this.s[s].session ? [`${l}@kline_${this.s[s].session.interval}`] : [];
      return [...CHART_INTERVALS.map((i) => `${l}@kline_${i}`), ...extra, `${l}@ticker`, `${l}@markPrice@1s`];
    }));
    this.connect('public', live.map((s) => `${s.toLowerCase()}@depth20@500ms`));
    setInterval(() => this.watchdog(), 5000);
    setInterval(() => this.loadExchangeInfo().catch((e) => this.log.warn(`exchangeInfo refresh failed: ${e.message}`, 'API_ERROR')), 3600_000);
  }

  async loadExchangeInfo() {
    const info = await this.rest.exchangeInfo();
    for (const s of info.symbols) {
      if (this.symbols.includes(s.symbol)) this.filters[s.symbol] = parseSymbolFilters(s);
    }
    this.log.info(`Exchange info loaded (${Object.keys(this.filters).length} symbols): ${Object.values(this.filters).map((f) => `${f.symbol} step=${f.stepSize} minNotional=${f.minNotional} ${f.status}`).join(', ')}`);
  }

  markUnavailable(sym, reason) {
    this.s[sym].unavailable = reason;
    this.log.error(`${sym} unavailable: ${reason} — other symbols continue`, 'SYMBOL_UNAVAILABLE');
  }

  // QQQ: build US regular-session daily candles from Binance 30m bars.
  async loadSession(sym) {
    const st = this.s[sym];
    await st.session.fetchRange(SYMBOL_META[sym].listedAt);
    st.daily = st.session.sessions(0);
    st.lastSessionT = st.daily.length ? st.daily[st.daily.length - 1].t : 0;
    const last = st.session.sortedBars().at(-1);
    if (last && !st.last) st.last = last.c;
    this.log.info(`${sym} US-session candles built: ${st.daily.length} sessions from Binance ${st.session.interval} bars (native history LIMITED since listing)`);
  }

  async checkSessionClose(sym, reason = 'session close') {
    const st = this.s[sym];
    if (!st.session || st.unavailable || st._sessionBusy) return;
    st._sessionBusy = true;
    try {
      let fresh = st.session.sessions(st.lastSessionT);
      fresh = fresh.filter((c) => c.t > st.lastSessionT);
      if (!fresh.length) return;
      if (fresh.some((c) => c.bars < c.expectedBars)) {
        await st.session.fetchRange(fresh[0].t - 60 * 60_000); // fill ws gaps via REST
        fresh = st.session.sessions(st.lastSessionT).filter((c) => c.t > st.lastSessionT);
      }
      for (const c of fresh) {
        if (c.bars < c.expectedBars) this.log.warn(`${sym} session ${c.day}: ${c.bars}/${c.expectedBars} bars available`, 'DATA_GAP');
        st.lastSessionT = c.t;
        this.appendClosed(sym, c, `US session ${c.day} close (${reason})`);
      }
    } catch (e) {
      this.log.error(`${sym} session close processing failed: ${e.message}`, 'API_ERROR');
    } finally {
      st._sessionBusy = false;
    }
  }

  underlyingStatus(sym) {
    if (!this.s[sym]?.session) return null;
    return marketStatus(Date.now(), this.getCalendar());
  }

  async loadDaily(sym) {
    const rows = await this.rest.klines(sym, DAILY, DAILY_HISTORY + 1);
    const candles = rows.map(toCandle);
    const now = Date.now();
    const st = this.s[sym];
    st.daily = candles.filter((c) => c.T < now);
    st.forming = candles.find((c) => c.T >= now) || null;
    if (!st.last && st.forming) st.last = st.forming.c;
    this.log.info(`${sym} daily candles loaded (${st.daily.length} closed)`);
    return st.daily;
  }

  async loadBars(sym, ivs = [...this.barIntervals]) {
    const st = this.s[sym];
    for (const iv of ivs) {
      const rows = (await this.rest.klines(sym, iv, Math.min(1500, BAR_KEEP + 1))).map(toCandle);
      const now = Date.now();
      st.bars[iv] = rows.filter((c) => c.T < now);
      st.formingBar[iv] = rows.find((c) => c.T >= now) || null;
      this.log.info(`${sym} ${iv} candles loaded (${st.bars[iv].length} closed)`);
    }
  }

  connect(route, streams) {
    const url = `${this.wsBase}/${route}/stream?streams=${streams.join('/')}`;
    let retry = 0;
    const open = () => {
      const ws = new WebSocket(url);
      this.sockets[route] = ws;
      ws.on('open', () => {
        retry = 0;
        this.log.info(`WebSocket ${route} connected (${streams.length} streams)`);
        this.setStatus();
        if (route === 'market') this.resyncDaily('ws reconnect');
      });
      ws.on('message', (buf) => {
        try { this.onMessage(JSON.parse(buf)); } catch (e) { this.log.warn(`ws parse error ${e.message}`); }
      });
      ws.on('close', () => {
        this.log.error(`WebSocket ${route} disconnected`, 'CONNECTION_LOST');
        this.setStatus();
        const delay = Math.min(30000, 1000 * 2 ** retry++);
        setTimeout(open, delay);
      });
      ws.on('error', (e) => this.log.warn(`WebSocket ${route} error: ${e.message}`, 'CONNECTION_ERROR'));
    };
    open();
  }

  setStatus() {
    const socks = Object.values(this.sockets);
    const ok = socks.length === 2 && socks.every((w) => w.readyState === WebSocket.OPEN);
    const s = ok ? 'CONNECTED' : (this.status === 'CONNECTING' ? 'CONNECTING' : 'DISCONNECTED');
    if (s !== this.status) { this.status = s; this.emit('status', s); }
  }

  onMessage(msg) {
    const d = msg.data;
    if (!d) return;
    const st = this.s[d.s];
    if (!st) return;
    this.lastUpdate = Date.now();
    if (d.e === 'kline') {
      const c = wsCandle(d.k);
      const interval = d.k.i;
      this.emit('kline', { symbol: d.s, interval, candle: c, closed: d.k.x });
      this.updateChartCache(d.s, interval, c);
      if (st.session && interval === st.session.interval) { st.session.onBar(c); return; }
      if (!st.session && this.barIntervals.has(interval)) {
        if (d.k.x) { this.appendBar(d.s, interval, c); st.formingBar[interval] = null; } else st.formingBar[interval] = c;
        return;
      }
      if (st.session && interval === DAILY) {
        // 24/7 Binance daily candle: price only — QQQ signals use US-session candles
        st.last = c.c;
        st.lastTs = this.lastUpdate;
        this.emit('price', { symbol: d.s, price: c.c });
        return;
      }
      if (interval === DAILY) {
        st.last = c.c;
        st.lastTs = this.lastUpdate;
        if (d.k.x) {
          this.appendClosed(d.s, c);
          st.forming = null;
        } else {
          st.forming = c;
        }
        this.emit('price', { symbol: d.s, price: c.c });
      }
    } else if (d.e === '24hrTicker') {
      st.ticker = { change: +d.p, changePct: +d.P, last: +d.c, high: +d.h, low: +d.l, vol: +d.v, quoteVol: +d.q };
    } else if (d.e === 'markPriceUpdate') {
      const prev = st.mark;
      st.mark = { price: +d.p, index: +d.i, fundingRate: +d.r, nextFundingTime: d.T };
      this.emit('mark', { symbol: d.s, price: st.mark.price });
      if (prev && prev.nextFundingTime && d.T > prev.nextFundingTime) {
        // funding settled at prev.nextFundingTime with prev.fundingRate
        this.emit('funding', { symbol: d.s, time: prev.nextFundingTime, rate: prev.fundingRate, markPrice: prev.price });
      }
    } else if (d.e === 'depthUpdate') {
      st.depth = { bids: d.b.slice(0, 15).map(([p, q]) => [+p, +q]), asks: d.a.slice(0, 15).map(([p, q]) => [+p, +q]), ts: d.E };
    }
  }

  appendClosed(sym, c, note = null) {
    const st = this.s[sym];
    const lastT = st.daily.length ? st.daily[st.daily.length - 1].t : 0;
    if (c.t <= lastT) return; // duplicate
    st.daily.push(c);
    if (st.daily.length > DAILY_HISTORY + 50) st.daily.splice(0, st.daily.length - DAILY_HISTORY);
    this.log.info(`${sym.replace('USDT', '')} ${note || 'daily candle closed'} C=${c.c}`);
    this.emit('candleClose', { symbol: sym, interval: st.session ? US_SESSION : DAILY, candle: c });
  }

  appendBar(sym, interval, c) {
    const arr = this.s[sym].bars[interval];
    const lastT = arr.length ? arr[arr.length - 1].t : 0;
    if (c.t <= lastT) return false; // duplicate close event
    const prev = arr[arr.length - 1];
    if (prev && c.t !== prev.T + 1) this.log.warn(`${sym} ${interval} candle gap: ${new Date(prev.T + 1).toISOString()} → ${new Date(c.t).toISOString()}`, 'DATA_GAP');
    arr.push(c);
    if (arr.length > BAR_KEEP + 100) arr.splice(0, arr.length - BAR_KEEP);
    this.emit('candleClose', { symbol: sym, interval, candle: c });
    return true;
  }

  async resyncBars(sym, interval, reason) {
    const st = this.s[sym];
    if (!st || st._resync?.[interval]) return;
    (st._resync ||= {})[interval] = true;
    try {
      // everything after the last stored bar (a long outage must not leave holes in the series)
      const arr = st.bars[interval] || (st.bars[interval] = []);
      let from = arr.length ? arr[arr.length - 1].t + 1 : Date.now() - 5 * 4 * 3600_000;
      let n = 0;
      for (let page = 0; page < 20; page++) {
        const rows = (await this.rest.publicGet('/fapi/v1/klines', { symbol: sym, interval, startTime: from, limit: POLL_LIMIT })).map(toCandle);
        const now = Date.now();
        for (const c of rows) if (c.T < now && this.appendBar(sym, interval, c)) n++;
        if (rows.length < POLL_LIMIT) break;
        from = rows[rows.length - 1].t + 1;
      }
      if (n && CHART_INTERVALS.includes(interval)) this.log.warn(`${sym} ${n} missed ${interval} close(s) recovered via REST (${reason})`, 'DATA_RESYNC');
    } catch (e) {
      this.log.error(`${sym} ${interval} resync failed: ${e.message}`, 'API_ERROR');
    } finally {
      st._resync[interval] = false;
    }
  }

  // Non-streamed interval: fetch new closed bars ~3 s after the next close is due (1M / unknown length: every 5 min).
  pollBars(sym, interval, now = Date.now()) {
    const st = this.s[sym];
    const last = st.bars[interval]?.at(-1);
    if (!last) return;
    const due = interval === '1M' ? (st._pollAt?.[interval] || 0) + 300_000 : last.T + 1 + (last.T + 1 - last.t) + 3000;
    if (now < due) return;
    (st._pollAt ||= {})[interval] = now;
    this.resyncBars(sym, interval, 'poll');
  }

  // A strategy switched to an interval that is not loaded yet: load its history for every symbol, then keep it.
  async ensureInterval(interval) {
    if (interval === DAILY || this.barIntervals.has(interval)) return false;
    this.barIntervals.add(interval);
    for (const sym of this.symbols) {
      const st = this.s[sym];
      if (st.session || st.unavailable) continue;
      st.bars[interval] ||= [];
      try { await this.loadBars(sym, [interval]); } catch (e) { this.log.error(`${sym} ${interval} history load failed: ${e.message}`, 'API_ERROR'); }
    }
    this.log.info(`${interval} candles loaded for strategies (${CHART_INTERVALS.includes(interval) ? 'WebSocket' : 'REST poll after each close'})`, 'SCHEDULER');
    return true;
  }

  // If a daily close was missed (ws gap), refetch via REST and emit closes for new candles.
  async resyncDaily(reason) {
    for (const sym of this.symbols) {
      const st = this.s[sym];
      if (st.session) { this.checkSessionClose(sym, reason); continue; }
      for (const iv of this.barIntervals) this.resyncBars(sym, iv, reason);
      const lastT = st.daily.length ? st.daily[st.daily.length - 1].t : 0;
      try {
        const rows = (await this.rest.publicGet('/fapi/v1/klines', { symbol: sym, interval: DAILY, startTime: lastT + 1, limit: 1500 })).map(toCandle);
        const now = Date.now();
        for (const c of rows) if (c.T < now && c.t > lastT) {
          this.log.warn(`${sym} missed daily close recovered via REST (${reason})`, 'DATA_RESYNC');
          this.appendClosed(sym, c);
        }
      } catch (e) {
        this.log.error(`${sym} daily resync failed: ${e.message}`, 'API_ERROR');
      }
    }
  }

  watchdog() {
    this.setStatus();
    const now = Date.now();
    for (const sym of this.symbols) {
      const st = this.s[sym];
      if (st.session && now - (st._lastSessionCheck || 0) >= 30_000) { st._lastSessionCheck = now; this.checkSessionClose(sym); }
    }
    for (const sym of this.symbols) {
      const st = this.s[sym];
      if (st.session) continue;
      for (const iv of this.barIntervals) {
        if (!CHART_INTERVALS.includes(iv)) { this.pollBars(sym, iv, now); continue; } // no stream: REST after each close
        const fb = st.formingBar[iv];
        if (fb && now > fb.T + 10_000) { st.formingBar[iv] = null; this.resyncBars(sym, iv, 'close event missing'); }
      }
      // forming candle end passed but no close event within 10s -> resync
      if (st.forming && now > st.forming.T + 10_000) {
        st.forming = null;
        this.resyncDaily('close event missing');
        break;
      }
    }
  }

  isStale(sym, maxSec) {
    const st = this.s[sym];
    return !st.lastTs || Date.now() - st.lastTs > maxSec * 1000;
  }

  // Chart data: REST fetch cached then kept updated by ws.
  async chartKlines(sym, interval, limit = 1000) {
    if (interval === SESSION_INTERVAL) {
      const st = this.s[sym];
      if (!st.session) throw new Error('US session candles only for session symbols');
      return st.daily.map(({ t, o, h, l, c, v, T }) => ({ t, o, h, l, c, v, T }));
    }
    const key = `${sym}:${interval}`;
    const cached = this.chartCache.get(key);
    if (cached && Date.now() - cached.fetched < 5 * 60_000 && cached.candles.length >= Math.min(limit, 900)) return cached.candles;
    const rows = await this.rest.klines(sym, interval, limit);
    const candles = rows.map(toCandle);
    this.chartCache.set(key, { fetched: Date.now(), candles });
    return candles;
  }

  updateChartCache(sym, interval, c) {
    const e = this.chartCache.get(`${sym}:${interval}`);
    if (!e) return;
    const arr = e.candles;
    const last = arr[arr.length - 1];
    if (last && last.t === c.t) arr[arr.length - 1] = c;
    else if (!last || c.t > last.t) { arr.push(c); if (arr.length > 1500) arr.shift(); }
  }

  price(sym) { return this.s[sym]?.last ?? null; }
}
