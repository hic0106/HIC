import test from 'node:test';
import assert from 'node:assert/strict';

process.env.HIC_LOG_STDOUT = '0';
const { AssetSeller, spotFilters } = await import('../server/portfolio/assetSeller.js');
const { BinanceError } = await import('../server/binance.js');

const info = (symbol) => ({ symbols: [{ symbol, status: 'TRADING', baseAsset: symbol.replace('USDT', ''), quoteAsset: 'USDT', filters: [
  { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '1000', stepSize: '0.001' }, { filterType: 'MARKET_LOT_SIZE', minQty: '0', maxQty: '1000', stepSize: '0' },
  { filterType: 'NOTIONAL', minNotional: '5', applyMinToMarket: true }] }] });
function fakeClient(over = {}) {
  const calls = [];
  const c = {
    calls,
    spotExchangeInfo: async (s) => info(s),
    spotPrice: async () => ({ price: '600' }),
    spotAccount: async () => ({ balances: [{ asset: 'BNB', free: '0.2', locked: '0' }, { asset: 'USDT', free: '50', locked: '0' }] }),
    transfer: async (type, asset, amount) => { calls.push(['transfer', type, asset, amount]); return { tranId: 1 }; },
    spotOrder: async (p) => { calls.push(['order', p]); return { status: 'FILLED', executedQty: p.quantity, cummulativeQuoteQty: String(Number(p.quantity) * 600), fills: [{ commission: '0.3', commissionAsset: 'USDT' }] }; },
    spotQueryOrder: async () => null,
    ...over,
  };
  return c;
}
const fut = [{ asset: 'BNB', wallet: 0.5004, margin: 0.5004, maxWithdraw: 0.5004 }, { asset: 'USDT', wallet: 100, margin: 100 }];

test('filters: MARKET_LOT_SIZE step 0 falls back to LOT_SIZE step', () => {
  const f = spotFilters(info('BNBUSDT'), 'BNBUSDT');
  assert.equal(f.step, 0.001);
  assert.equal(f.minNotional, 5);
});

test('futures asset: transfer out -> market sell (step-rounded) -> USDT (minus USDT fee) back to futures', async () => {
  const c = fakeClient();
  const s = new AssetSeller({ getClient: () => c });
  const r = await s.sell({ wallet: 'FUTURES', asset: 'BNB', amount: 'ALL', toFutures: true, futuresAssets: fut });
  assert.equal(r.ok, true, r.msg);
  assert.deepEqual(c.calls[0], ['transfer', 'UMFUTURE_MAIN', 'BNB', '0.5004']);
  assert.equal(c.calls[1][1].quantity, '0.500');
  assert.equal(c.calls[1][1].side, 'SELL');
  assert.equal(c.calls[1][1].type, 'MARKET');
  assert.deepEqual(c.calls[2], ['transfer', 'MAIN_UMFUTURE', 'USDT', '299.7']);
});

test('USDT, over-available and below min notional are refused before anything is sent', async () => {
  const c = fakeClient();
  const s = new AssetSeller({ getClient: () => c });
  assert.equal((await s.sell({ wallet: 'SPOT', asset: 'USDT' })).ok, false);
  assert.match((await s.sell({ wallet: 'SPOT', asset: 'BNB', amount: 1 })).msg, /초과/);
  assert.match((await s.sell({ wallet: 'SPOT', asset: 'BNB', amount: 0.005 })).msg, /최소 주문금액/);
  assert.equal(c.calls.length, 0);
});

test('sell rejected after the transfer: stops, asset reported in spot, no transfer back', async () => {
  const c = fakeClient({ spotOrder: async () => { throw new BinanceError('HTTP 400 -2010 insufficient', { code: -2010, status: 400, definitive: true }); } });
  const s = new AssetSeller({ getClient: () => c });
  const r = await s.sell({ wallet: 'FUTURES', asset: 'BNB', amount: 'ALL', futuresAssets: fut });
  assert.equal(r.ok, false);
  assert.ok(r.steps.some((x) => /현물 지갑에 있음/.test(x.msg)));
  assert.equal(c.calls.filter((x) => x[1] === 'MAIN_UMFUTURE').length, 0);
});

test('unknown sell result is queried by clientOrderId, never resent', async () => {
  let sent = 0;
  const c = fakeClient({
    spotOrder: async () => { sent++; throw new BinanceError('network error: timeout', { definitive: false }); },
    spotQueryOrder: async (sym, id) => ({ status: 'FILLED', executedQty: '0.2', cummulativeQuoteQty: '120', fills: [] }),
  });
  const s = new AssetSeller({ getClient: () => c });
  const r = await s.sell({ wallet: 'SPOT', asset: 'BNB', amount: 'ALL', toFutures: false });
  assert.equal(sent, 1);
  assert.equal(r.ok, true);
  assert.equal(r.received, 120);
});

test('missing transfer permission: clear message, nothing sold', async () => {
  const c = fakeClient({ transfer: async () => { throw new BinanceError('HTTP 401 -2015 Invalid API-key, IP, or permissions for action.', { code: -2015, status: 401, definitive: true }); } });
  const s = new AssetSeller({ getClient: () => c });
  const r = await s.sell({ wallet: 'FUTURES', asset: 'BNB', amount: 'ALL', futuresAssets: fut });
  assert.equal(r.ok, false);
  assert.match(r.msg, /Universal Transfer/);
  assert.equal(c.calls.filter((x) => x[0] === 'order').length, 0);
});
