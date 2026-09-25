// Local mock of the Binance USDT-M Futures API (REST + routed WS) for development/testing.
// Generates synthetic prices. "Days" can be accelerated with MOCK_DAY_MS (default 86400000).
// Usage: npm run mock   then   npm run dev:mock
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_PORT || 9901);
const DAY = Number(process.env.MOCK_DAY_MS || 86_400_000);
// intraday candles scale with the accelerated day (QQQ 30m bars stay real-time: US session calendar)
const F = DAY / 86_400_000;
const INTERVALS = { '5m': 300_000 * F, '15m': 900_000 * F, '30m': 1_800_000 * F, '1h': 3_600_000 * F, '4h': 14_400_000 * F, '1d': DAY };
// REST klines: every Binance interval (1M ≈ 30 days); WS broadcasts only INTERVALS
const REST_MS = { ...INTERVALS, '1m': 60_000 * F, '3m': 180_000 * F, '2h': 7_200_000 * F, '6h': 21_600_000 * F, '8h': 28_800_000 * F, '12h': 43_200_000 * F, '3d': 3 * DAY, '1w': 7 * DAY, '1M': 30 * DAY };
const QQQ_MS = { '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000 };
// qv = synthetic 24h quote volume (USDT) for the universe ranking; listedDays = days since onboardDate
const SYMS = {
  BTCUSDT: { p: 86000, vol: 0.03, step: '0.001', minQty: '0.001', minNotional: '100', tick: '0.10', qv: 9e9 },
  ETHUSDT: { p: 3200, vol: 0.035, step: '0.001', minQty: '0.001', minNotional: '20', tick: '0.01', qv: 6e9 },
  SOLUSDT: { p: 150, vol: 0.05, step: '0.01', minQty: '0.01', minNotional: '5', tick: '0.01', qv: 3e9 },
  XRPUSDT: { p: 2.4, vol: 0.045, step: '0.1', minQty: '0.1', minNotional: '5', tick: '0.0001', qv: 2e9 },
  DOGEUSDT: { p: 0.2, vol: 0.06, step: '1', minQty: '1', minNotional: '5', tick: '0.00001', qv: 1.5e9 },
  BNBUSDT: { p: 600, vol: 0.03, step: '0.01', minQty: '0.01', minNotional: '5', tick: '0.01', qv: 8e8 },
  ADAUSDT: { p: 0.7, vol: 0.05, step: '1', minQty: '1', minNotional: '5', tick: '0.0001', qv: 5e8 },
  // excluded by the universe filter: stablecoin base, new listing
  USDCUSDT: { p: 1, vol: 0.0005, step: '1', minQty: '1', minNotional: '5', tick: '0.0001', qv: 7e9 },
  NEWUSDT: { p: 1.5, vol: 0.08, step: '1', minQty: '1', minNotional: '5', tick: '0.0001', qv: 4e9, listedDays: 20 },
  // TradFi index perpetual (listed 2026-04-06); deterministic 30m path so history pages are consistent
  QQQUSDT: { p: 600, vol: 0.012, step: '0.01', minQty: '0.01', minNotional: '5', tick: '0.01', tradfi: true, qv: 1e8 },
};
const QQQ_LISTED = Date.UTC(2026, 3, 6);
const qqqPrice = (t) => {
  const d = (t - QQQ_LISTED) / 86_400_000;
  return 520 * Math.exp(0.0009 * d + 0.04 * Math.sin(d / 23) + 0.01 * Math.sin(t / 5_400_000));
};
const qqqBar = (t, ms) => {
  const o = qqqPrice(t), c = qqqPrice(t + ms);
  const v = 50 + (t / ms) % 40;
  return [t, o, Math.max(o, c) * 1.0008, Math.min(o, c) * 0.9992, c, v, t + ms - 1, v * (o + c) / 2];
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
  for (let d = 1000; d >= 1; d--) {
    const drift = Math.sin((1000 - d) / 45) * 0.012;
    const o = p;
    const cl = o * Math.exp(drift + c.vol * gauss());
    const h = Math.max(o, cl) * (1 + Math.abs(gauss()) * c.vol * 0.4);
    const l = Math.min(o, cl) * (1 - Math.abs(gauss()) * c.vol * 0.4);
    const v = (c.qv / c.p) * (0.6 + rnd() * 0.8); // base volume so that quote volume ≈ c.qv per day
    arr.push({ t: dayStart - d * DAY, o, h, l, c: cl, v });
    p = cl;
  }
  hist[s] = { daily: arr, price: p, forming: { t: dayStart, o: p, h: p, l: p, c: p, v: 0 }, funding: 0.0001, nextFunding: Math.ceil(now0 / (DAY / 3)) * (DAY / 3) };
}

function klines(sym, interval, limit, startTime) {
  const ms = SYMS[sym].tradfi && QQQ_MS[interval] ? QQQ_MS[interval] : REST_MS[interval];
  if (!ms) return [];
  const h = hist[sym];
  if (SYMS[sym].tradfi && interval !== '1d') {
    const now = Date.now();
    const lastOpen = Math.floor(now / ms) * ms;
    let t0 = startTime ? Math.ceil(Math.max(startTime, QQQ_LISTED) / ms) * ms : lastOpen - (limit - 1) * ms;
    const out = [];
    for (let t = t0; t <= lastOpen && out.length < limit; t += ms) out.push(qqqBar(t, ms));
    return out;
  }
  const all = [...h.daily, h.forming];
  if (interval === '1d') {
    const rows = startTime ? all.filter((k) => k.t >= startTime).slice(0, limit) : all.slice(-limit);
    return rows.map((k) => [k.t, k.o, k.h, k.l, k.c, k.v, k.t + DAY - 1, k.v * (k.o + k.c) / 2]);
  }
  // Intraday synthetic, deterministic: path inside each daily candle (consistent across paged requests)
  const end = Math.floor(Date.now() / ms) * ms;
  let t0 = startTime ? Math.ceil(startTime / ms) * ms : end - (limit - 1) * ms;
  t0 = Math.max(t0, all[0].t);
  const at = (t) => {
    const d = all[Math.min(all.length - 1, Math.max(0, Math.floor((t - all[0].t) / DAY)))];
    const f = Math.min(1, Math.max(0, (t - d.t) / DAY));
    const base = d === h.forming ? d.o + (h.price - d.o) * f : d.o + (d.c - d.o) * f;
    return base * (1 + 0.004 * Math.sin(t / 3_600_000) + 0.002 * Math.sin(t / 700_000));
  };
  const out = [];
  for (let t = t0; t <= end && out.length < limit; t += ms) {
    const o = at(t), c = t + ms > Date.now() ? h.price : at(t + ms);
    const v = 10 + ((t / ms) % 90);
    out.push([t, o, Math.max(o, c) * 1.002, Math.min(o, c) * 0.998, c, v, t + ms - 1, v * (o + c) / 2]);
  }
  return out;
}

// ---- simulated account (hedge mode)
const acct = { wallet: 5000, otherAssets: { BNB: 0.5, USDC: 120 }, spot: { USDT: 300, BTC: 0.002, ETH: 0.05 }, dual: true, leverage: Object.fromEntries(Object.keys(SYMS).map((s) => [s, 1])), positions: {}, orders: {} };
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
  const priv = !['/fapi/v1/time', '/fapi/v1/exchangeInfo', '/fapi/v1/klines', '/fapi/v1/fundingRate', '/fapi/v1/ticker/24hr', '/fapi/v2/ticker/price', '/api/v3/exchangeInfo', '/api/v3/ticker/price'].includes(p) && !p.startsWith('/mock/');
  if (priv && !req.headers['x-mbx-apikey']) return json(res, 401, { code: -2015, msg: 'Invalid API-key' });
  if (p === '/fapi/v1/time') return json(res, 200, { serverTime: Date.now() });
  if (p === '/fapi/v1/exchangeInfo') {
    return json(res, 200, { symbols: Object.entries(SYMS).map(([s, c]) => ({ symbol: s, status: 'TRADING', contractType: c.tradfi ? 'TRADIFI_PERPETUAL' : 'PERPETUAL', quantityPrecision: 3, pricePrecision: 2,
      baseAsset: s.replace(/USDT$/, ''), quoteAsset: 'USDT', marginAsset: 'USDT', underlyingType: c.tradfi ? 'EQUITY' : 'COIN',
      onboardDate: Date.now() - (c.listedDays ?? 1500) * 86_400_000,
      filters: [{ filterType: 'PRICE_FILTER', tickSize: c.tick }, { filterType: 'LOT_SIZE', stepSize: c.step, minQty: c.minQty, maxQty: '1000000' }, { filterType: 'MARKET_LOT_SIZE', stepSize: c.step, minQty: c.minQty, maxQty: '100000' }, { filterType: 'MIN_NOTIONAL', notional: c.minNotional }] })) });
  }
  if (p === '/fapi/v2/ticker/price') return json(res, 200, Object.keys(SYMS).map((s) => ({ symbol: s, price: String(hist[s].price) })));
  // ---- spot (asset sale): exchangeInfo / price / account / market order / universal transfer
  if (p === '/api/v3/exchangeInfo') {
    const base = String(q.symbol || '').replace(/USDT$/, '');
    if (!(base in acct.otherAssets || base in acct.spot || hist[q.symbol])) return json(res, 400, { code: -1121, msg: 'Invalid symbol.' });
    return json(res, 200, { symbols: [{ symbol: q.symbol, status: 'TRADING', baseAsset: base, quoteAsset: 'USDT', filters: [{ filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '100000', stepSize: '0.001' }, { filterType: 'MARKET_LOT_SIZE', minQty: '0', maxQty: '100000', stepSize: '0' }, { filterType: 'NOTIONAL', minNotional: '5', applyMinToMarket: true }] }] });
  }
  if (p === '/api/v3/ticker/price') return json(res, 200, { symbol: q.symbol, price: String(spotPx(q.symbol.replace(/USDT$/, ''))) });
  if (p === '/api/v3/account') return json(res, 200, { balances: Object.entries(acct.spot).map(([a, v]) => ({ asset: a, free: String(v), locked: '0' })) });
  if (p === '/api/v3/order' && req.method === 'POST') {
    const base = q.symbol.replace(/USDT$/, ''), qty = Number(q.quantity);
    if (q.side !== 'SELL' || q.type !== 'MARKET') return json(res, 400, { code: -1102, msg: 'mock: SELL MARKET only' });
    if (!((acct.spot[base] || 0) >= qty - 1e-12)) return json(res, 400, { code: -2010, msg: 'Account has insufficient balance for requested action.' });
    const px = spotPx(base), quote = qty * px, fee = quote * 0.001;
    acct.spot[base] -= qty; acct.spot.USDT = (acct.spot.USDT || 0) + quote - fee;
    const o = { symbol: q.symbol, orderId: ++oid, clientOrderId: q.newClientOrderId, status: 'FILLED', executedQty: String(qty), cummulativeQuoteQty: String(quote), fills: [{ price: String(px), qty: String(qty), commission: String(fee), commissionAsset: 'USDT' }] };
    spotOrders[q.newClientOrderId] = o;
    return json(res, 200, o);
  }
  if (p === '/api/v3/order') return spotOrders[q.origClientOrderId] ? json(res, 200, spotOrders[q.origClientOrderId]) : json(res, 400, { code: -2013, msg: 'Order does not exist.' });
  if (p === '/sapi/v1/asset/transfer' && req.method === 'POST') {
    const amt = Number(q.amount), a = q.asset;
    if (q.type === 'UMFUTURE_MAIN') {
      const have = a === 'USDT' ? acct.wallet : acct.otherAssets[a] || 0;
      if (have < amt - 1e-12) return json(res, 400, { code: -5002, msg: 'Insufficient balance' });
      if (a === 'USDT') acct.wallet -= amt; else acct.otherAssets[a] -= amt;
      acct.spot[a] = (acct.spot[a] || 0) + amt;
    } else if (q.type === 'MAIN_UMFUTURE') {
      if ((acct.spot[a] || 0) < amt - 1e-12) return json(res, 400, { code: -5002, msg: 'Insufficient balance' });
      acct.spot[a] -= amt;
      if (a === 'USDT') acct.wallet += amt; else acct.otherAssets[a] = (acct.otherAssets[a] || 0) + amt;
    } else return json(res, 400, { code: -1102, msg: 'mock: bad transfer type' });
    return json(res, 200, { tranId: ++oid });
  }
  if (p === '/sapi/v1/asset/wallet/balance') {
    const px = (a) => (a === 'USDT' ? 1 : hist[`${a}USDT`]?.price ?? 0);
    const futUsdt = acct.wallet + Object.entries(acct.otherAssets).reduce((t, [a, v]) => t + v * px(a), 0);
    const spotUsdt = Object.entries(acct.spot).reduce((t, [a, v]) => t + v * px(a), 0);
    return json(res, 200, [
      { activate: true, balance: String(spotUsdt), walletName: 'Spot', assetBalances: Object.entries(acct.spot).map(([a, v]) => ({ asset: a, free: String(v), locked: '0', freeze: '0' })) },
      { activate: true, balance: '0', walletName: 'Funding', assetBalances: [] },
      { activate: true, balance: String(futUsdt), walletName: 'USDⓈ-M Futures', assetBalances: [] },
      { activate: true, balance: '0', walletName: 'Earn', assetBalances: [] },
    ]);
  }
  if (p === '/fapi/v1/ticker/24hr') {
    const row = (s) => ({ symbol: s, lastPrice: String(hist[s].price), volume: String(SYMS[s].qv / hist[s].price), quoteVolume: String(SYMS[s].qv), closeTime: Date.now() });
    if (q.symbol) return SYMS[q.symbol] ? json(res, 200, row(q.symbol)) : json(res, 400, { code: -1121, msg: 'Invalid symbol.' });
    return json(res, 200, Object.keys(SYMS).map(row));
  }
  if (p === '/fapi/v1/fundingRate') {
    const st = Number(q.startTime || Date.now() - 30 * 86_400_000), et = Number(q.endTime || Date.now()), step = 8 * 3_600_000;
    const out = [];
    for (let t = Math.ceil(st / step) * step; t <= et && out.length < Number(q.limit || 100); t += step) out.push({ symbol: q.symbol, fundingTime: t, fundingRate: String(0.0001 * (1 + Math.sin(t / 86_400_000 / 9))), markPrice: '0' });
    return json(res, 200, out);
  }
  if (p === '/fapi/v1/klines') {
    if (!SYMS[q.symbol]) return json(res, 400, { code: -1121, msg: 'Invalid symbol.' });
    return json(res, 200, klines(q.symbol, q.interval, Math.min(1500, Number(q.limit || 500)), q.startTime ? Number(q.startTime) : null));
  }
  if (p === '/fapi/v3/account') {
    const u2 = unreal();
    return json(res, 200, { totalWalletBalance: String(acct.wallet), totalUnrealizedProfit: String(u2), totalMarginBalance: String(acct.wallet + u2), availableBalance: String(acct.wallet + u2 - margin()),
      // single-asset mode: totals are USDT only; other assets are listed here
      assets: [{ asset: 'USDT', walletBalance: String(acct.wallet), unrealizedProfit: String(u2), marginBalance: String(acct.wallet + u2), maxWithdrawAmount: String(Math.max(0, acct.wallet + u2 - margin())) },
        ...Object.entries(acct.otherAssets).map(([a, v]) => ({ asset: a, walletBalance: String(v), unrealizedProfit: '0', marginBalance: String(v), maxWithdrawAmount: String(v) }))],
      positions: Object.values(acct.positions).map((x) => ({ symbol: x.symbol, positionSide: x.side, positionAmt: String(x.side === 'LONG' ? x.qty : -x.qty) })) });
  }
  if (p === '/fapi/v3/positionRisk') {
    return json(res, 200, Object.values(acct.positions).map((x) => {
      const mk = hist[x.symbol].price * 1.0001, lev = acct.leverage[x.symbol] || 1, d = x.side === 'LONG' ? 1 : -1;
      return { symbol: x.symbol, positionSide: x.side, positionAmt: String(d * x.qty), entryPrice: String(x.entry), breakEvenPrice: String(x.entry), markPrice: String(mk),
        unRealizedProfit: String((mk - x.entry) * x.qty * d), liquidationPrice: String(lev <= 1 && d > 0 ? 0 : x.entry * (1 - d / lev * 0.95)), notional: String(d * x.qty * mk),
        marginAsset: 'USDT', initialMargin: String((x.qty * mk) / lev), positionInitialMargin: String((x.qty * mk) / lev), updateTime: Date.now() };
    }));
  }
  if (p === '/fapi/v1/income') {
    const st = Number(q.startTime || 0), et = Number(q.endTime || Date.now());
    return json(res, 200, incomes.filter((r) => r.time >= st && r.time <= et).slice(0, Number(q.limit || 100)));
  }
  if (p === '/fapi/v1/listenKey') {
    if (req.method === 'POST') { listenKey ||= `mockListenKey${Date.now()}`; return json(res, 200, { listenKey }); }
    if (req.method === 'PUT') return listenKey ? json(res, 200, {}) : json(res, 400, { code: -1125, msg: 'This listenKey does not exist.' });
    if (req.method === 'DELETE') { listenKey = null; return json(res, 200, {}); }
  }
  if (p === '/mock/external') { // dev: simulate a manual position opened in the Binance app
    const o = fillOrder({ symbol: q.symbol, side: q.side || 'BUY', positionSide: q.positionSide || 'LONG', quantity: q.qty, newClientOrderId: `web_${Date.now()}` });
    return json(res, 200, o);
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
const spotOrders = {};
const spotPx = (a) => (a === 'USDT' ? 1 : a === 'USDC' ? 0.9999 : hist[`${a}USDT`]?.price ?? 1);
const algos = {};
const incomes = [];
let listenKey = null;
let tran = 1;
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
  const fee = qty * px * 0.0005;
  acct.wallet -= fee;
  const now = Date.now();
  if (!opening) incomes.push({ symbol: s, incomeType: 'REALIZED_PNL', income: String((px - pos.entry) * qty * (pos.side === 'LONG' ? 1 : -1)), asset: 'USDT', time: now, tranId: tran++, tradeId: String(oid) });
  incomes.push({ symbol: s, incomeType: 'COMMISSION', income: String(-fee), asset: 'USDT', time: now, tranId: tran++, tradeId: String(oid) });
  setTimeout(() => pushUserData(q, px, qty, fee), 20);
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
    if (c.tradfi) h.price = qqqPrice(now);
    else h.price *= Math.exp(c.vol * Math.sqrt(dt) * gauss() * (DAY < 86_400_000 ? 1 : 3) + Math.sin(now / DAY / 7) * 0.02 * dt);
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
      const bms = c.tradfi && QQQ_MS[iv] ? QQQ_MS[iv] : ms;
      const t = Math.floor(now / bms) * bms;
      const bk = `${s}:${iv}`;
      if (barStart[bk] && barStart[bk].t !== t) broadcast('market', `${s.toLowerCase()}@kline_${iv}`, klineMsg(s, iv, barStart[bk], true, bms)); // closed (x=true)
      if (!barStart[bk] || barStart[bk].t !== t) barStart[bk] = { t, o: h.price, h: h.price, l: h.price, c: h.price, v: 0 };
      const b = barStart[bk];
      b.c = h.price; b.h = Math.max(b.h, h.price); b.l = Math.min(b.l, h.price); b.v += rnd();
      broadcast('market', `${s.toLowerCase()}@kline_${iv}`, klineMsg(s, iv, b, false, bms));
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

// ---- user data stream (/private route)
function pushUserData(q, px, qty, fee) {
  if (!listenKey) return;
  const E = Date.now();
  broadcast('private', listenKey, { e: 'ORDER_TRADE_UPDATE', E, T: E, o: { s: q.symbol, c: q.newClientOrderId, S: q.side, o: 'MARKET', q: String(qty), ap: String(px), X: 'FILLED', x: 'TRADE', l: String(qty), L: String(px), n: String(fee), N: 'USDT', ps: q.positionSide, rp: '0' } });
  broadcast('private', listenKey, { e: 'ACCOUNT_UPDATE', E, T: E, a: { m: 'ORDER', B: [{ a: 'USDT', wb: String(acct.wallet), cw: String(acct.wallet), bc: '0' }],
    P: ['LONG', 'SHORT'].map((side) => { const x = acct.positions[posKey(q.symbol, side)]; return { s: q.symbol, pa: String(x ? (side === 'LONG' ? x.qty : -x.qty) : 0), ep: String(x?.entry || 0), up: String(x ? (hist[q.symbol].price - x.entry) * x.qty * (side === 'LONG' ? 1 : -1) : 0), mt: 'cross', iw: '0', ps: side }; }) } });
}

function klineMsg(s, i, k, x, ms = DAY) {
  return { e: 'kline', s, k: { t: k.t, T: k.t + ms - 1, s, i, o: String(k.o), c: String(k.c), h: String(k.h), l: String(k.l), v: String(k.v), q: String(k.v * k.c), x } };
}
function broadcast(route, stream, data) {
  const msg = JSON.stringify({ stream, data });
  for (const c of wss.clients) if (c.readyState === 1 && c.route === route) c.send(msg);
}

server.listen(PORT, '127.0.0.1', () => console.log(`Mock Binance on http://127.0.0.1:${PORT} (day=${DAY}ms)`));
