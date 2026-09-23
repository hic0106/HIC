// Local mock of the Binance USDT-M Futures API (REST + routed WS) for development/testing.
// Generates synthetic prices. "Days" can be accelerated with MOCK_DAY_MS (default 86400000).
// Usage: npm run mock   then   npm run dev:mock
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_PORT || 9901);
const DAY = Number(process.env.MOCK_DAY_MS || 86_400_000);
const INTERVALS = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': DAY };
const SYMS = {
  BTCUSDT: { p: 86000, vol: 0.03, step: '0.001', minQty: '0.001', minNotional: '100', tick: '0.10' },
  ETHUSDT: { p: 3200, vol: 0.035, step: '0.001', minQty: '0.001', minNotional: '20', tick: '0.01' },
  XRPUSDT: { p: 2.4, vol: 0.045, step: '0.1', minQty: '0.1', minNotional: '5', tick: '0.0001' },
};

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// Build daily history with regime drift so strategies produce signals.
const hist = {};
const now0 = Date.now();
const dayStart = Math.floor(now0 / DAY) * DAY;
for (const [s, c] of Object.entries(SYMS)) {
  let p = c.p * 0.55;
  const arr = [];
  for (let d = 600; d >= 1; d--) {
    const drift = Math.sin((600 - d) / 45) * 0.012;
    const o = p;
    const cl = o * Math.exp(drift + c.vol * gauss());
    const h = Math.max(o, cl) * (1 + Math.abs(gauss()) * c.vol * 0.4);
    const l = Math.min(o, cl) * (1 - Math.abs(gauss()) * c.vol * 0.4);
    arr.push({ t: dayStart - d * DAY, o, h, l, c: cl, v: 1000 + rnd() * 5000 });
    p = cl;
  }
  hist[s] = { daily: arr, price: p, forming: { t: dayStart, o: p, h: p, l: p, c: p, v: 0 }, funding: 0.0001, nextFunding: Math.ceil(now0 / (DAY / 3)) * (DAY / 3) };
}

function klines(sym, interval, limit) {
  const ms = INTERVALS[interval];
  const h = hist[sym];
  if (interval === '1d') {
    const rows = [...h.daily, h.forming].slice(-limit);
    return rows.map((k) => [k.t, k.o, k.h, k.l, k.c, k.v, k.t + DAY - 1]);
  }
  // Intraday synthetic: interpolate within daily candles
  const out = [];
  const end = Math.floor(Date.now() / ms) * ms;
  let p = h.price;
  const tmp = [];
  for (let i = 0; i < limit; i++) {
    const t = end - i * ms;
    const c = p;
    const o = c / Math.exp(SYMS[sym].vol * 0.15 * gauss() * Math.sqrt(ms / 86_400_000) * 3);
    tmp.push([t, o, Math.max(o, c) * 1.001, Math.min(o, c) * 0.999, c, 10 + rnd() * 100, t + ms - 1]);
    p = o;
  }
  for (let i = tmp.length - 1; i >= 0; i--) out.push(tmp[i]);
  return out;
}

// ---- simulated account (hedge mode)
const acct = { wallet: 5000, dual: true, leverage: { BTCUSDT: 1, ETHUSDT: 1, XRPUSDT: 1 }, positions: {}, orders: {} };
const posKey = (s, side) => `${s}:${side}`;
function unreal() {
  let u = 0;
  for (const p of Object.values(acct.positions)) u += (hist[p.symbol].price - p.entry) * p.qty * (p.side === 'LONG' ? 1 : -1);
  return u;
}
function margin() {
  let m = 0;
  for (const p of Object.values(acct.positions)) m += (p.qty * hist[p.symbol].price) / acct.leverage[p.symbol];
  return m;
}

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const q = Object.fromEntries(u.searchParams);
  const p = u.pathname;
  const priv = p !== '/fapi/v1/time' && p !== '/fapi/v1/exchangeInfo' && p !== '/fapi/v1/klines';
  if (priv && !req.headers['x-mbx-apikey']) return json(res, 401, { code: -2015, msg: 'Invalid API-key' });
  if (p === '/fapi/v1/time') return json(res, 200, { serverTime: Date.now() });
  if (p === '/fapi/v1/exchangeInfo') {
    return json(res, 200, { symbols: Object.entries(SYMS).map(([s, c]) => ({ symbol: s, status: 'TRADING', contractType: 'PERPETUAL', quantityPrecision: 3, pricePrecision: 2,
      filters: [{ filterType: 'PRICE_FILTER', tickSize: c.tick }, { filterType: 'LOT_SIZE', stepSize: c.step, minQty: c.minQty, maxQty: '1000000' }, { filterType: 'MARKET_LOT_SIZE', stepSize: c.step, minQty: c.minQty, maxQty: '100000' }, { filterType: 'MIN_NOTIONAL', notional: c.minNotional }] })) });
  }
  if (p === '/fapi/v1/klines') return json(res, 200, klines(q.symbol, q.interval, Math.min(1500, Number(q.limit || 500))));
  if (p === '/fapi/v3/account') {
    const u2 = unreal();
    return json(res, 200, { totalWalletBalance: String(acct.wallet), totalUnrealizedProfit: String(u2), totalMarginBalance: String(acct.wallet + u2), availableBalance: String(acct.wallet + u2 - margin()),
      positions: Object.values(acct.positions).map((x) => ({ symbol: x.symbol, positionSide: x.side, positionAmt: String(x.side === 'LONG' ? x.qty : -x.qty) })) });
  }
  if (p === '/fapi/v1/positionSide/dual') {
    if (req.method === 'POST') { acct.dual = q.dualSidePosition === 'true'; return json(res, 200, { code: 200, msg: 'success' }); }
    return json(res, 200, { dualSidePosition: acct.dual });
  }
  if (p === '/fapi/v1/symbolConfig') return json(res, 200, [{ symbol: q.symbol, marginType: 'CROSSED', leverage: acct.leverage[q.symbol] }]);
  if (p === '/fapi/v1/leverage') { acct.leverage[q.symbol] = Number(q.leverage); return json(res, 200, { symbol: q.symbol, leverage: Number(q.leverage) }); }
  if (p === '/fapi/v1/order' && req.method === 'POST') {
    if (process.env.MOCK_FAIL === 'timeout') { acct.orders[q.newClientOrderId] = fillOrder(q); return; } // never respond
    const o = fillOrder(q);
    if (o.error) return json(res, 400, o.error);
    acct.orders[q.newClientOrderId] = o;
    return json(res, 200, o);
  }
  if (p === '/fapi/v1/order') {
    const o = acct.orders[q.origClientOrderId];
    return o ? json(res, 200, o) : json(res, 400, { code: -2013, msg: 'Order does not exist.' });
  }
  if (p === '/fapi/v1/algoOrder' && req.method === 'POST') {
    if (q.algoType !== 'CONDITIONAL' || q.type !== 'STOP_MARKET' || !q.triggerPrice || !q.positionSide) return json(res, 400, { code: -1102, msg: 'bad algo params' });
    if (process.env.MOCK_FAIL === 'algo') return json(res, 400, { code: -2021, msg: 'Order would immediately trigger.' });
    const a = { algoId: ++oid, clientAlgoId: q.clientAlgoId, algoType: 'CONDITIONAL', orderType: q.type, symbol: q.symbol, side: q.side, positionSide: q.positionSide, quantity: q.quantity, triggerPrice: q.triggerPrice, workingType: q.workingType || 'CONTRACT_PRICE', algoStatus: 'NEW', createTime: Date.now() };
    algos[q.clientAlgoId] = a;
    return json(res, 200, a);
  }
  if (p === '/fapi/v1/algoOrder' && req.method === 'DELETE') {
    const a = algos[q.clientAlgoId];
    if (!a || a.algoStatus !== 'NEW') return json(res, 400, { code: -2011, msg: 'Unknown order sent.' });
    a.algoStatus = 'CANCELED';
    return json(res, 200, { algoId: a.algoId, clientAlgoId: a.clientAlgoId, code: '200', msg: 'success' });
  }
  if (p === '/fapi/v1/openAlgoOrders') return json(res, 200, Object.values(algos).filter((a) => a.algoStatus === 'NEW' && (!q.symbol || a.symbol === q.symbol)));
  if (p === '/mock/algos') return json(res, 200, algos);
  if (p === '/mock/price') { hist[q.symbol].price *= Number(q.mul); return json(res, 200, { price: hist[q.symbol].price }); } // dev: shift price
  if (p === '/fapi/v1/userTrades') {
    const o = Object.values(acct.orders).find((x) => String(x.orderId) === q.orderId);
    return json(res, 200, o ? [{ commission: String(o.executedQty * o.avgPrice * 0.0005), commissionAsset: 'USDT' }] : []);
  }
  json(res, 404, { code: -1, msg: 'not found' });
});

let oid = 1000;
const algos = {};
function fillOrder(q) {
  const s = q.symbol, qty = Number(q.quantity), px = hist[s].price;
  const k = posKey(s, q.positionSide);
  const opening = (q.side === 'BUY') === (q.positionSide === 'LONG');
  const pos = acct.positions[k];
  if (!opening && (!pos || pos.qty < qty - 1e-9)) return { error: { code: -2022, msg: 'ReduceOnly Order is rejected.' } };
  if (opening) {
    if (acct.wallet + unreal() - margin() < (qty * px) / acct.leverage[s]) return { error: { code: -2019, msg: 'Margin is insufficient.' } };
    if (pos) { pos.entry = (pos.entry * pos.qty + px * qty) / (pos.qty + qty); pos.qty += qty; } else acct.positions[k] = { symbol: s, side: q.positionSide, qty, entry: px };
  } else {
    acct.wallet += (px - pos.entry) * qty * (pos.side === 'LONG' ? 1 : -1);
    pos.qty -= qty;
    if (pos.qty <= 1e-9) delete acct.positions[k];
  }
  acct.wallet -= qty * px * 0.0005;
  return { orderId: ++oid, clientOrderId: q.newClientOrderId, symbol: s, status: 'FILLED', avgPrice: String(px), executedQty: String(qty), cumQuote: String(qty * px), side: q.side, positionSide: q.positionSide };
}

// ---- WebSocket (/market/stream and /public/stream)
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => { ws.route = req.url.split('/')[1]; wss.emit('connection', ws, req); }));

const barStart = {};
setInterval(() => {
  const now = Date.now();
  for (const [s, c] of Object.entries(SYMS)) {
    const h = hist[s];
    const f = h.forming;
    if (now >= f.t + DAY) {
      const closed = { ...f };
      h.daily.push(closed);
      broadcast('market', `${s.toLowerCase()}@kline_1d`, klineMsg(s, '1d', closed, true));
      h.forming = { t: f.t + DAY, o: f.c, h: f.c, l: f.c, c: f.c, v: 0 };
    }
    const dt = 0.5 / (DAY / 1000);
    h.price *= Math.exp(c.vol * Math.sqrt(dt) * gauss() * (DAY < 86_400_000 ? 1 : 3) + Math.sin(now / DAY / 7) * 0.02 * dt);
    for (const a of Object.values(algos)) {
      if (a.symbol !== s || a.algoStatus !== 'NEW') continue;
      const px = a.workingType === 'MARK_PRICE' ? h.price * 1.0001 : h.price;
      const hit = a.side === 'SELL' ? px <= Number(a.triggerPrice) : px >= Number(a.triggerPrice);
      if (!hit) continue;
      const o = fillOrder({ symbol: s, side: a.side, positionSide: a.positionSide, quantity: a.quantity, newClientOrderId: a.clientAlgoId });
      a.algoStatus = o.error ? 'REJECTED' : 'FINISHED';
      if (!o.error) acct.orders[a.clientAlgoId] = { ...o, type: 'MARKET', origType: 'STOP_MARKET' };
      console.log(`algo ${a.clientAlgoId} triggered @ ${px} -> ${a.algoStatus}`);
    }
    const fm = h.forming;
    fm.c = h.price; fm.h = Math.max(fm.h, h.price); fm.l = Math.min(fm.l, h.price); fm.v += rnd() * 5;
    for (const [iv, ms] of Object.entries(INTERVALS)) {
      if (iv === '1d') { broadcast('market', `${s.toLowerCase()}@kline_1d`, klineMsg(s, '1d', fm, false)); continue; }
      const t = Math.floor(now / ms) * ms;
      const bk = `${s}:${iv}`;
      if (!barStart[bk] || barStart[bk].t !== t) barStart[bk] = { t, o: h.price, h: h.price, l: h.price, c: h.price, v: 0 };
      const b = barStart[bk];
      b.c = h.price; b.h = Math.max(b.h, h.price); b.l = Math.min(b.l, h.price); b.v += rnd();
      broadcast('market', `${s.toLowerCase()}@kline_${iv}`, klineMsg(s, iv, b, false, ms));
    }
    const d0 = h.daily[h.daily.length - 1];
    broadcast('market', `${s.toLowerCase()}@ticker`, { e: '24hrTicker', s, p: String(h.price - d0.c), P: String(((h.price / d0.c) - 1) * 100), c: String(h.price), h: String(fm.h), l: String(fm.l), v: String(fm.v), q: String(fm.v * h.price) });
    if (now >= h.nextFunding) h.nextFunding += DAY / 3;
    broadcast('market', `${s.toLowerCase()}@markPrice@1s`, { e: 'markPriceUpdate', s, p: String(h.price * 1.0001), i: String(h.price), r: String(h.funding), T: h.nextFunding });
    const tick = Number(c.tick);
    const bids = [], asks = [];
    for (let i = 1; i <= 20; i++) { bids.push([String(h.price - i * tick * 3), String(rnd() * 5)]); asks.push([String(h.price + i * tick * 3), String(rnd() * 5)]); }
    broadcast('public', `${s.toLowerCase()}@depth20@500ms`, { e: 'depthUpdate', E: now, s, b: bids, a: asks });
  }
}, 500);

function klineMsg(s, i, k, x, ms = DAY) {
  return { e: 'kline', s, k: { t: k.t, T: k.t + ms - 1, s, i, o: String(k.o), c: String(k.c), h: String(k.h), l: String(k.l), v: String(k.v), x } };
}
function broadcast(route, stream, data) {
  const msg = JSON.stringify({ stream, data });
  for (const c of wss.clients) if (c.readyState === 1 && c.route === route) c.send(msg);
}

server.listen(PORT, '127.0.0.1', () => console.log(`Mock Binance on http://127.0.0.1:${PORT} (day=${DAY}ms)`));
