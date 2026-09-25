// Minimal Binance USDT-M Futures REST client (public + HMAC signed).
import crypto from 'node:crypto';

export const ENDPOINTS = {
  mainnet: { rest: 'https://fapi.binance.com', ws: 'wss://fstream.binance.com' },
  testnet: { rest: 'https://demo-fapi.binance.com', ws: 'wss://demo-fstream.binance.com' },
};

// Env overrides (used by the local mock exchange for development).
export function endpoints(testnet) {
  const base = testnet ? ENDPOINTS.testnet : ENDPOINTS.mainnet;
  return {
    rest: process.env.BINANCE_REST_BASE || base.rest,
    ws: process.env.BINANCE_WS_BASE || base.ws,
  };
}

// definitive = exchange answered and the request was certainly NOT executed.
// definitive=false = outcome unknown (timeout, network, 5xx, -1007) -> never blindly resend.
export class BinanceError extends Error {
  constructor(message, { code = null, status = null, definitive = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.definitive = definitive;
  }
}

const TS_MARGIN_MS = 500; // sign 0.5 s in the past: tolerates clock drift ahead (limit +1 s) within recvWindow 5 s

export class BinanceClient {
  constructor({ restBase, apiKey = '', apiSecret = '', timeoutMs = 10000 }) {
    this.restBase = restBase;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.timeoutMs = timeoutMs;
    this.timeOffset = 0;
    this.timeSyncedAt = 0;
    this.recvWindow = 5000;
  }

  hasKeys() { return !!(this.apiKey && this.apiSecret); }

  async _fetch(method, url, headers = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, { method, headers, signal: ctrl.signal });
    } catch (e) {
      throw new BinanceError(`network error: ${e.name === 'AbortError' ? 'timeout' : e.message}`, { definitive: false });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) {
      const code = body && typeof body === 'object' ? body.code : null;
      const msg = body && typeof body === 'object' ? body.msg : String(text).slice(0, 200);
      // 4xx with an error code: rejected by exchange (not executed). -1007 = timeout, status unknown.
      const definitive = res.status >= 400 && res.status < 500 && code !== -1007 && res.status !== 408;
      throw new BinanceError(`HTTP ${res.status} ${code ?? ''} ${msg}`.trim(), { code, status: res.status, definitive });
    }
    return body;
  }

  async publicGet(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this._fetch('GET', `${this.restBase}${path}${qs ? '?' + qs : ''}`);
  }

  async syncTime() {
    const t0 = Date.now();
    const r = await this.publicGet('/fapi/v1/time');
    const t1 = Date.now();
    this.timeOffset = r.serverTime - Math.round((t0 + t1) / 2);
    this.timeSyncedAt = t1;
    return this.timeOffset;
  }

  // Binance rejects a signed request (-1021) if timestamp > serverTime + 1000 ms or serverTime - timestamp > recvWindow.
  // The PC clock drifts: re-sync every 10 min, sign slightly in the past (margin), and on -1021 re-sync + retry once
  // (-1021 = rejected before processing, so a retry never duplicates an order).
  async signed(method, path, params = {}) {
    if (!this.hasKeys()) throw new BinanceError('API key not configured', { definitive: true, code: 'NO_KEYS' });
    if (Date.now() - this.timeSyncedAt > 10 * 60_000) { try { await this.syncTime(); } catch { /* keep last offset */ } }
    try {
      return await this._signedOnce(method, path, params);
    } catch (e) {
      if (!(e instanceof BinanceError) || e.code !== -1021) throw e;
      await this.syncTime();
      return this._signedOnce(method, path, params);
    }
  }

  async _signedOnce(method, path, params) {
    const p = { ...params, recvWindow: this.recvWindow, timestamp: Date.now() + this.timeOffset - TS_MARGIN_MS };
    const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
    const sig = crypto.createHmac('sha256', this.apiSecret).update(qs).digest('hex');
    return this._fetch(method, `${this.restBase}${path}?${qs}&signature=${sig}`, { 'X-MBX-APIKEY': this.apiKey });
  }

  // USER_STREAM endpoints: API key header only, no signature.
  async keyed(method, path) {
    if (!this.apiKey) throw new BinanceError('API key not configured', { definitive: true, code: 'NO_KEYS' });
    return this._fetch(method, `${this.restBase}${path}`, { 'X-MBX-APIKEY': this.apiKey });
  }

  // ---- public
  exchangeInfo() { return this.publicGet('/fapi/v1/exchangeInfo'); }
  klines(symbol, interval, limit = 500) { return this.publicGet('/fapi/v1/klines', { symbol, interval, limit }); }

  // ---- private
  account() { return this.signed('GET', '/fapi/v3/account'); }
  positionRisk(symbol) { return this.signed('GET', '/fapi/v3/positionRisk', symbol ? { symbol } : {}); }
  positionMode() { return this.signed('GET', '/fapi/v1/positionSide/dual'); }
  setPositionMode(dual) { return this.signed('POST', '/fapi/v1/positionSide/dual', { dualSidePosition: dual ? 'true' : 'false' }); }
  symbolConfig(symbol) { return this.signed('GET', '/fapi/v1/symbolConfig', symbol ? { symbol } : {}); }
  setLeverage(symbol, leverage) { return this.signed('POST', '/fapi/v1/leverage', { symbol, leverage }); }
  newOrder(params) { return this.signed('POST', '/fapi/v1/order', params); }
  queryOrder(symbol, origClientOrderId) { return this.signed('GET', '/fapi/v1/order', { symbol, origClientOrderId }); }
  userTrades(symbol, orderId) { return this.signed('GET', '/fapi/v1/userTrades', { symbol, orderId }); }
  // Income history (REALIZED_PNL / COMMISSION / FUNDING_FEE / TRANSFER ...). Only the last 3 months are kept by Binance.
  income(params = {}) { return this.signed('GET', '/fapi/v1/income', { limit: 1000, ...params }); }

  // User Data Stream: listenKey valid 60 min, extended by keepalive (PUT).
  startUserStream() { return this.keyed('POST', '/fapi/v1/listenKey'); }
  keepaliveUserStream() { return this.keyed('PUT', '/fapi/v1/listenKey'); }
  closeUserStream() { return this.keyed('DELETE', '/fapi/v1/listenKey'); }

  // Conditional orders (STOP_MARKET etc.) live in the Algo service since 2025-12-09.
  // A triggered algo order becomes a regular order whose clientOrderId = clientAlgoId.
  newAlgoOrder(params) { return this.signed('POST', '/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', ...params }); }
  cancelAlgoOrder(clientAlgoId) { return this.signed('DELETE', '/fapi/v1/algoOrder', { clientAlgoId }); }
  openAlgoOrders(symbol) { return this.signed('GET', '/fapi/v1/openAlgoOrders', { algoType: 'CONDITIONAL', symbol }); }
}

// ---- exchange filter helpers
export function parseSymbolFilters(s) {
  const f = Object.fromEntries(s.filters.map((x) => [x.filterType, x]));
  const lot = f.MARKET_LOT_SIZE || f.LOT_SIZE;
  return {
    symbol: s.symbol,
    status: s.status,
    contractType: s.contractType,
    tickSize: Number(f.PRICE_FILTER?.tickSize ?? 0),
    stepSize: Number(lot?.stepSize ?? f.LOT_SIZE?.stepSize ?? 0),
    minQty: Number(lot?.minQty ?? f.LOT_SIZE?.minQty ?? 0),
    maxQty: Number(lot?.maxQty ?? f.LOT_SIZE?.maxQty ?? Infinity),
    minNotional: Number(f.MIN_NOTIONAL?.notional ?? 5),
    quantityPrecision: s.quantityPrecision,
    pricePrecision: s.pricePrecision,
  };
}

function decimals(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.replace(/0+$/, '').length - i - 1;
}

// Round DOWN to step size (never exceeds the configured order amount).
export function floorToStep(qty, step) {
  if (!(step > 0)) return qty;
  const d = decimals(step);
  const n = Math.floor(qty / step + 1e-9);
  return Number((n * step).toFixed(d));
}

export function fmtQty(qty, step) {
  return qty.toFixed(decimals(step));
}

// Round a price to tick size; dir -1 = down, 1 = up, 0 = nearest.
export function roundToTick(price, tick, dir = 0) {
  if (!(tick > 0)) return price;
  const d = decimals(tick);
  const x = price / tick;
  const n = dir < 0 ? Math.floor(x + 1e-9) : dir > 0 ? Math.ceil(x - 1e-9) : Math.round(x);
  return Number((n * tick).toFixed(d));
}

export function fmtPrice(price, tick) {
  return price.toFixed(decimals(tick));
}
