// Rule-based, interpretable market regime from BTC daily candles. No prediction models.
// The regime never creates BUY/SELL signals; it only caps controller decisions.
import { sma, atr, adx } from '../indicators.js';

export const REGIMES = ['BULL_TREND', 'BEAR_TREND', 'SIDEWAYS', 'HIGH_VOLATILITY', 'NORMAL'];

export function detectRegime(candles, cfg) {
  const n = candles.length;
  if (n < 201) return { regime: 'NORMAL', inputs: {}, reasons: [`insufficient BTC history (${n} daily candles)`] };
  const i = n - 1;
  const c = candles.map((k) => k.c);
  const price = c[i];
  const sma200 = sma(c, 200)[i];
  const ret30 = price / c[i - 30] - 1;
  const ret90 = price / c[i - 90] - 1;
  const atrPct = atr(candles, 14)[i] / price;
  const logR = [];
  for (let j = i - 29; j <= i; j++) logR.push(Math.log(c[j] / c[j - 1]));
  const m = logR.reduce((s, x) => s + x, 0) / logR.length;
  const vol30 = Math.sqrt(logR.reduce((s, x) => s + (x - m) ** 2, 0) / (logR.length - 1)) * Math.sqrt(365);
  const adx14 = adx(candles, 14).adx[i];
  const inputs = { price, sma200, ret30, ret90, atrPct, vol30, adx: adx14 };
  const pct = (x) => `${(x * 100).toFixed(1)}%`;

  if (vol30 * 100 > cfg.volHighPct || atrPct * 100 > cfg.atrHighPct) {
    return { regime: 'HIGH_VOLATILITY', inputs, reasons: [`30D realized vol ${pct(vol30)} (limit ${cfg.volHighPct}%) / ATR ${pct(atrPct)} (limit ${cfg.atrHighPct}%)`] };
  }
  const trending = adx14 != null && adx14 > cfg.adxTrend;
  if (price > sma200 && ret90 > 0 && trending) {
    return { regime: 'BULL_TREND', inputs, reasons: [`BTC above SMA200, 90D ${pct(ret90)}, ADX ${adx14.toFixed(1)}`] };
  }
  if (price < sma200 && ret90 < 0 && trending) {
    return { regime: 'BEAR_TREND', inputs, reasons: [`BTC below SMA200, 90D ${pct(ret90)}, ADX ${adx14.toFixed(1)}`] };
  }
  if (!trending && Math.abs(ret30) * 100 < cfg.sidewaysRet30Pct) {
    return { regime: 'SIDEWAYS', inputs, reasons: [`ADX ${adx14?.toFixed(1)} <= ${cfg.adxTrend}, 30D ${pct(ret30)}`] };
  }
  return { regime: 'NORMAL', inputs, reasons: ['no dominant regime rule matched'] };
}
