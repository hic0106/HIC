// Market data: REST bootstrap + combined WebSocket streams (routed /market and /public paths).
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { BinanceClient, endpoints, parseSymbolFilters } from './binance.js';

export const CHART_INTERVALS = ['5m', '15m', '1h', '4h', '1d'];
const DAILY = '1d';
const DAILY_HISTORY = 500;

const toCandle = (a) => ({ t: a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], v: +a[5], T: a[6] });
const wsCandle = (k) => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, T: k.T });

export class MarketData extends EventEmitter {
  constructor(symbols, logger) {
    super();
    this.symbols = symbols;
    this.log = logger;
    const ep = endpoints(false); // market data always from mainnet (public, no key)
    this.rest = new BinanceClient({ restBase: ep.rest });
    this.wsBase = ep.ws;
    this.filters = {};
    this.s = {};
    for (const sym of symbols) {
      this.s[sym] = {
        daily: [], // closed daily candles
        forming: null, // current (open) daily candle
        last: null, lastTs: 0,
        ticker: null, mark: null, depth: null,
      };
    }
    this.status = 'CONNECTING';
    this.lastUpdate = 0;
    this.sockets = {};
    this.chartCache = new Map();
  }

  async start() {
    await this.loadExchangeInfo();
    for (const sym of this.symbols) await this.loadDaily(sym);
    this.connect('market', this.symbols.flatMap((s) => {
      const l = s.toLowerCase();
      return [...CHART_INTERVALS.map((i) => `${l}@kline_${i}`), `${l}@ticker`, `${l}@markPrice@1s`];
    }));
    this.connect('public', this.symbols.map((s) => `${s.toLowerCase()}@depth20@500ms`));
    setInterval(() => this.watchdog(), 5000);
    setInterval(() => this.loadExchangeInfo().catch((e) => this.log.warn(`exchangeInfo refresh failed: ${e.message}`, 'API_ERROR')), 3600_000);
  }

  async loadExchangeInfo() {
    const info = await this.rest.exchangeInfo();
    for (const s of info.symbols) {
      if (this.symbols.includes(s.symbol)) this.filters[s.symbol] = parseSymbolFilters(s);
    }
    this.log.info(`Exchange info loaded: ${Object.values(this.filters).map((f) => `${f.symbol} step=${f.stepSize} minNotional=${f.minNotional} ${f.status}`).join(', ')}`);
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
      if (prev && prev.nextFundingTime && d.T > prev.nextFundingTime) {
        // funding settled at prev.nextFundingTime with prev.fundingRate
        this.emit('funding', { symbol: d.s, time: prev.nextFundingTime, rate: prev.fundingRate, markPrice: prev.price });
      }
    } else if (d.e === 'depthUpdate') {
      st.depth = { bids: d.b.slice(0, 15).map(([p, q]) => [+p, +q]), asks: d.a.slice(0, 15).map(([p, q]) => [+p, +q]), ts: d.E };
    }
  }

  appendClosed(sym, c) {
    const st = this.s[sym];
    const lastT = st.daily.length ? st.daily[st.daily.length - 1].t : 0;
    if (c.t <= lastT) return; // duplicate
    st.daily.push(c);
    if (st.daily.length > DAILY_HISTORY + 50) st.daily.splice(0, st.daily.length - DAILY_HISTORY);
    this.log.info(`${sym.replace('USDT', '')} daily candle closed C=${c.c}`);
    this.emit('dailyClose', { symbol: sym, candle: c });
  }

  // If a daily close was missed (ws gap), refetch via REST and emit closes for new candles.
  async resyncDaily(reason) {
    for (const sym of this.symbols) {
      const st = this.s[sym];
      const lastT = st.daily.length ? st.daily[st.daily.length - 1].t : 0;
      try {
        const rows = (await this.rest.klines(sym, DAILY, 5)).map(toCandle);
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
