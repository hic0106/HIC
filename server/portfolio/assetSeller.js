// Sells a non-USDT asset for USDT on the Binance SPOT market (portfolio screen, user-initiated only).
//   FUTURES wallet: transfer asset futures -> spot (UMFUTURE_MAIN), market SELL <ASSET>USDT, USDT back to futures
//   SPOT wallet   : market SELL <ASSET>USDT, optionally move the USDT to futures (MAIN_UMFUTURE)
// Key permissions needed: "Enable Spot & Margin Trading" (+ "Permits Universal Transfer" for transfers).
// Never withdraws. A sell whose result is unknown (timeout) is never resent: it is queried by clientOrderId.
import { BinanceError, floorToStep, fmtQty } from '../binance.js';

const f8 = (x) => (Math.floor(x * 1e8 + 1e-6) / 1e8).toFixed(8).replace(/\.?0+$/, '');
const PERM_HINT = 'API 키 권한 확인: 현물 거래(Enable Spot & Margin Trading), 선물↔현물 이동(Permits Universal Transfer)';

export function spotFilters(info, symbol) {
  const s = (info?.symbols || []).find((x) => x.symbol === symbol);
  if (!s) return null;
  const f = Object.fromEntries((s.filters || []).map((x) => [x.filterType, x]));
  const lot = f.LOT_SIZE || {};
  const mlot = f.MARKET_LOT_SIZE || {};
  const step = Number(Number(mlot.stepSize) > 0 ? mlot.stepSize : lot.stepSize) || 0;
  return {
    symbol, status: s.status, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset, step,
    minQty: Math.max(Number(lot.minQty) || 0, Number(mlot.minQty) || 0),
    maxQty: Math.min(Number(lot.maxQty) || Infinity, Number(mlot.maxQty) > 0 ? Number(mlot.maxQty) : Infinity),
    minNotional: f.NOTIONAL ? (f.NOTIONAL.applyMinToMarket === false ? 0 : Number(f.NOTIONAL.minNotional) || 0) : Number(f.MIN_NOTIONAL?.minNotional) || 0,
  };
}

export class AssetSeller {
  constructor({ getClient, log, onDone = () => {} }) {
    this.getClient = getClient;
    this.log = log;
    this.onDone = onDone;
    this.busy = false;
    this.last = null; // last job result (UI)
  }

  // Validates and returns the plan without sending anything (UI preview).
  async plan({ wallet, asset, amount = null, futuresAssets = [] }) {
    const c = this.getClient();
    asset = String(asset || '').toUpperCase();
    if (!/^[A-Z0-9]{2,15}$/.test(asset) || asset === 'USDT') throw new Error('판매할 수 없는 자산입니다');
    if (!['FUTURES', 'SPOT'].includes(wallet)) throw new Error('지갑 구분 오류');
    const symbol = `${asset}USDT`;
    const f = spotFilters(await c.spotExchangeInfo(symbol).catch(() => null), symbol);
    if (!f || f.status !== 'TRADING') throw new Error(`${symbol} 현물 거래쌍이 없거나 거래 중이 아닙니다`);
    let available;
    if (wallet === 'FUTURES') {
      const a = futuresAssets.find((x) => x.asset === asset);
      if (!a) throw new Error(`선물 지갑에 ${asset} 없음`);
      available = Math.max(0, Math.min(a.wallet, a.maxWithdraw ?? a.wallet)); // part may be locked as margin
    } else {
      const acct = await c.spotAccount();
      available = Number((acct.balances || []).find((b) => b.asset === asset)?.free || 0);
    }
    const want = amount == null || amount === 'ALL' ? available : Number(amount);
    if (!(want > 0)) throw new Error('판매 수량이 0입니다');
    if (want > available + 1e-12) throw new Error(`판매 가능 수량 ${f8(available)} ${asset} 초과`);
    const qty = floorToStep(want, f.step);
    const price = Number((await c.spotPrice(symbol)).price);
    if (!(qty > 0) || qty < f.minQty) throw new Error(`최소 수량 ${f.minQty} ${asset} 미만`);
    if (qty > f.maxQty) throw new Error(`최대 수량 ${f.maxQty} ${asset} 초과`);
    if (qty * price < f.minNotional) throw new Error(`최소 주문금액 ${f.minNotional} USDT 미만 (약 ${(qty * price).toFixed(2)} USDT)`);
    return { wallet, asset, symbol, available, qty, transferQty: wallet === 'FUTURES' ? Number(f8(want)) : 0, price, estUsdt: qty * price, filters: f };
  }

  async sell({ wallet, asset, amount, toFutures = true, futuresAssets = [] }) {
    if (this.busy) return { ok: false, msg: '다른 판매가 진행 중입니다' };
    this.busy = true;
    const steps = [];
    const step = (s) => { steps.push({ at: Date.now(), ...s }); this.log?.[s.ok === false ? 'error' : 'info'](`ASSET SELL ${asset}: ${s.msg}`, 'ASSET_SELL'); };
    const c = this.getClient();
    let p;
    try {
      p = await this.plan({ wallet, asset, amount, futuresAssets });
      // 1) futures -> spot
      if (wallet === 'FUTURES') {
        try {
          const r = await c.transfer('UMFUTURE_MAIN', p.asset, f8(p.transferQty));
          step({ kind: 'TRANSFER_OUT', ok: true, msg: `선물 → 현물 ${f8(p.transferQty)} ${p.asset} (tranId ${r?.tranId ?? '-'})` });
        } catch (e) {
          step({ kind: 'TRANSFER_OUT', ok: false, msg: `선물 → 현물 이동 실패: ${e.message}` });
          return this.finish({ ok: false, msg: `${e.message} — ${PERM_HINT}`, steps, plan: p });
        }
      }
      // 2) market sell (never resent: unknown -> query by clientOrderId)
      const clientOrderId = `HIC-SELL-${p.asset.slice(0, 6)}-${Date.now().toString(36)}`;
      let o;
      try {
        o = await c.spotOrder({ symbol: p.symbol, side: 'SELL', type: 'MARKET', quantity: fmtQty(p.qty, p.filters.step), newClientOrderId: clientOrderId, newOrderRespType: 'FULL' });
      } catch (e) {
        if (e instanceof BinanceError && e.definitive) {
          step({ kind: 'SELL', ok: false, msg: `판매 주문 거부: ${e.message}${wallet === 'FUTURES' ? ` — ${p.asset}는 현물 지갑에 있음` : ''}` });
          return this.finish({ ok: false, msg: `${e.message} — ${PERM_HINT}`, steps, plan: p });
        }
        try { o = await c.spotQueryOrder(p.symbol, clientOrderId); } catch { /* unknown */ }
        if (!o) {
          step({ kind: 'SELL', ok: false, msg: `판매 주문 결과 확인 불가 (${e.message}) — 재전송 안 함. Binance 주문내역에서 ${clientOrderId} 확인` });
          return this.finish({ ok: false, msg: '판매 결과 확인 불가 (재전송 안 함)', steps, plan: p });
        }
      }
      const executed = Number(o.executedQty || 0);
      const quote = Number(o.cummulativeQuoteQty || 0);
      const feeUsdt = (o.fills || []).filter((x) => x.commissionAsset === 'USDT').reduce((a, x) => a + Number(x.commission), 0);
      const received = Math.max(0, quote - feeUsdt);
      step({ kind: 'SELL', ok: executed > 0, msg: `${p.symbol} 시장가 판매 ${o.status} ${executed} ${p.asset} → ${received.toFixed(4)} USDT (평균 ${executed ? (quote / executed).toPrecision(6) : '-'}, 수수료 ${(o.fills || []).map((x) => `${x.commission} ${x.commissionAsset}`).join(', ') || '-'})` });
      if (!(executed > 0)) return this.finish({ ok: false, msg: `판매 체결 없음 (${o.status})`, steps, plan: p });
      // 3) USDT -> futures
      if (toFutures && received > 0) {
        try {
          const r = await c.transfer('MAIN_UMFUTURE', 'USDT', f8(received));
          step({ kind: 'TRANSFER_IN', ok: true, msg: `현물 → 선물 ${f8(received)} USDT (tranId ${r?.tranId ?? '-'})` });
        } catch (e) {
          step({ kind: 'TRANSFER_IN', ok: false, msg: `현물 → 선물 USDT 이동 실패: ${e.message} — USDT는 현물 지갑에 있음` });
          return this.finish({ ok: false, partial: true, msg: `판매 완료, USDT 이동 실패 (${e.message})`, steps, plan: p });
        }
      }
      return this.finish({ ok: true, msg: `${executed} ${p.asset} 판매 → ${received.toFixed(4)} USDT${toFutures ? ' (선물 지갑)' : ' (현물 지갑)'}`, steps, plan: p, received });
    } catch (e) {
      step({ kind: 'CHECK', ok: false, msg: e.message });
      return this.finish({ ok: false, msg: e.message, steps, plan: p || null });
    } finally {
      this.busy = false;
    }
  }

  // Spot USDT -> futures (e.g. after a failed step 3).
  async moveUsdtToFutures(amount) {
    if (this.busy) return { ok: false, msg: '다른 작업이 진행 중입니다' };
    this.busy = true;
    try {
      const c = this.getClient();
      const free = Number(((await c.spotAccount()).balances || []).find((b) => b.asset === 'USDT')?.free || 0);
      const amt = amount == null || amount === 'ALL' ? free : Math.min(Number(amount), free);
      if (!(amt > 0)) return { ok: false, msg: '현물 지갑 USDT 없음' };
      const r = await c.transfer('MAIN_UMFUTURE', 'USDT', f8(amt));
      this.log?.info(`USDT spot -> futures ${f8(amt)} (tranId ${r?.tranId ?? '-'})`, 'ASSET_SELL');
      this.onDone();
      return { ok: true, msg: `${f8(amt)} USDT 선물 지갑으로 이동` };
    } catch (e) {
      return { ok: false, msg: `${e.message} — ${PERM_HINT}` };
    } finally {
      this.busy = false;
    }
  }

  finish(r) { this.last = { at: Date.now(), ...r }; try { this.onDone(); } catch { /* ignore */ } return r; }
}
