// Indicator functions. Input: arrays of closed candles {t, o, h, l, c, v}.
// All functions return values aligned to the candle index (null where not enough data).

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function trueRange(candles) {
  return candles.map((k, i) => {
    if (i === 0) return k.h - k.l;
    const pc = candles[i - 1].c;
    return Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
  });
}

// Wilder ATR (RMA). First value = simple mean of first `period` TRs (starting at index 1).
export function atr(candles, period) {
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Wilder ADX / +DI / -DI.
export function adx(candles, period) {
  const n = candles.length;
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const adxOut = new Array(n).fill(null);
  if (n < period * 2 + 1) return { adx: adxOut, plusDI, minusDI };

  const tr = trueRange(candles);
  const pdm = new Array(n).fill(0);
  const mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
  }

  let sTR = 0, sP = 0, sM = 0;
  for (let i = 1; i <= period; i++) { sTR += tr[i]; sP += pdm[i]; sM += mdm[i]; }
  const dx = new Array(n).fill(null);
  const calc = (i) => {
    const p = sTR === 0 ? 0 : (100 * sP) / sTR;
    const m = sTR === 0 ? 0 : (100 * sM) / sTR;
    plusDI[i] = p;
    minusDI[i] = m;
    dx[i] = p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
  };
  calc(period);
  for (let i = period + 1; i < n; i++) {
    sTR = sTR - sTR / period + tr[i];
    sP = sP - sP / period + pdm[i];
    sM = sM - sM / period + mdm[i];
    calc(i);
  }
  // First ADX = mean of first `period` DX values (index period .. 2*period-1)
  let sum = 0;
  for (let i = period; i < period * 2; i++) sum += dx[i];
  let prev = sum / period;
  adxOut[period * 2 - 1] = prev;
  for (let i = period * 2; i < n; i++) {
    prev = (prev * (period - 1) + dx[i]) / period;
    adxOut[i] = prev;
  }
  return { adx: adxOut, plusDI, minusDI };
}

// Highest high / lowest low of the `period` candles BEFORE index i (current candle excluded).
export function priorHigh(candles, i, period) {
  if (i - period < 0) return null;
  let m = -Infinity;
  for (let j = i - period; j < i; j++) m = Math.max(m, candles[j].h);
  return m;
}

export function priorLow(candles, i, period) {
  if (i - period < 0) return null;
  let m = Infinity;
  for (let j = i - period; j < i; j++) m = Math.min(m, candles[j].l);
  return m;
}

// Cumulative log return over `lookback` candles = sum(ln(c_k / c_{k-1})) = ln(c_i / c_{i-lookback}).
export function logMomentum(candles, i, lookback) {
  if (i - lookback < 0) return null;
  return Math.log(candles[i].c / candles[i - lookback].c);
}
