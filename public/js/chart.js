// Candlestick chart (TradingView lightweight-charts v5) with strategy entry / stop overlays.
import { api, fPct, fNum, stepDecimals } from './util.js';

const LC = window.LightweightCharts;
const IV_MS = { '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '6h': 21600e3, '8h': 28800e3, '12h': 43200e3, '1d': 86400e3, '3d': 259200e3, '1w': 604800e3, '1M': 2592000e3, US1D: 86400e3 };
export const ST_COLOR = { TURTLE: '#f0b90b', ADX: '#3d8bfd', TSMOM: '#c77dff', QQQ_EMA_TREND: '#26c6da', QQQ_TSMOM: '#ff8a65', QQQ_SMA200: '#9ccc65', QQQ_TURTLE_50_20: '#ffd54f' };
const toggleKey = (st) => (st.startsWith('QQQ_') ? 'QQQ' : st);
const TZ = -new Date().getTimezoneOffset() * 60; // display local time
const toT = (ms) => Math.floor(ms / 1000) + TZ;

export class ChartView {
  constructor(el, legendEl, msgEl) {
    this.el = el; this.legendEl = legendEl; this.msgEl = msgEl;
    this.interval = '1d';
    this.symbol = null;
    this.data = [];
    this.toggles = {};
    this.lines = new Map();
    this.markerSig = '';
    this.precisionKey = '';
    this.chart = LC.createChart(el, {
      autoSize: true,
      localization: { locale: 'en-US' },
      layout: { background: { type: 'solid', color: '#0b0e11' }, textColor: '#8b949e', fontSize: 11, fontFamily: 'Consolas, "JetBrains Mono", monospace' },
      grid: { vertLines: { color: '#141920' }, horzLines: { color: '#141920' } },
      crosshair: { mode: LC.CrosshairMode.Normal, vertLine: { color: '#4b5563', labelBackgroundColor: '#2b3440' }, horzLine: { color: '#4b5563', labelBackgroundColor: '#2b3440' } },
      rightPriceScale: { borderColor: '#222933', scaleMargins: { top: 0.08, bottom: 0.2 } },
      timeScale: { borderColor: '#222933', rightOffset: 10, timeVisible: true, secondsVisible: false },
      handleScroll: true, handleScale: true,
    });
    this.candle = this.chart.addSeries(LC.CandlestickSeries, {
      upColor: '#0ecb81', downColor: '#f6465d', borderVisible: false, wickUpColor: '#0ecb81', wickDownColor: '#f6465d',
    });
    this.vol = this.chart.addSeries(LC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    this.sma = this.chart.addSeries(LC.LineSeries, { color: '#8e7cc3', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    this.markers = LC.createSeriesMarkers(this.candle, []);
    this.chart.subscribeCrosshairMove((p) => this.legend(p));
  }

  resize() { /* autoSize handles it */ }
  setToggle(k, on) { this.toggles[k] = on; if (k === 'sma') this.drawSma(); this.markerSig = ''; }

  async load(symbol) {
    this.symbol = symbol;
    this.msgEl.textContent = '불러오는 중…';
    const rows = await api('GET', `/api/klines?symbol=${symbol}&interval=${this.interval}`);
    if (!Array.isArray(rows)) { this.msgEl.textContent = rows.msg || '차트 데이터 오류'; return; }
    this.msgEl.textContent = '';
    this.data = rows.map((r) => ({ time: toT(r.t), open: r.o, high: r.h, low: r.l, close: r.c, v: r.v }));
    this.candle.setData(this.data.map(({ v, ...c }) => c));
    this.vol.setData(this.data.map((c) => ({ time: c.time, value: c.v, color: c.close >= c.open ? 'rgba(14,203,129,.35)' : 'rgba(246,70,93,.35)' })));
    this.chart.applyOptions({ timeScale: { timeVisible: !['1d', '3d', '1w', '1M', 'US1D'].includes(this.interval) } });
    this.drawSma();
    this.markerSig = '';
    this.precisionKey = '';
    this.chart.timeScale().setVisibleLogicalRange({ from: this.data.length - 160, to: this.data.length + 8 });
    this.legend(null);
  }

  drawSma() {
    if (!this.toggles.sma || this.interval !== '1d' || this.data.length < 200) { this.sma.setData([]); return; }
    const out = [];
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) {
      sum += this.data[i].close;
      if (i >= 200) sum -= this.data[i - 200].close;
      if (i >= 199) out.push({ time: this.data[i].time, value: sum / 200 });
    }
    this.sma.setData(out);
  }

  onKline({ symbol, interval, candle: k, closed }) {
    if (symbol !== this.symbol || interval !== this.interval || !this.data.length) return;
    const bar = { time: toT(k.t), open: k.o, high: k.h, low: k.l, close: k.c };
    const last = this.data[this.data.length - 1];
    if (bar.time < last.time) return;
    if (bar.time === last.time) this.data[this.data.length - 1] = { ...bar, v: k.v };
    else this.data.push({ ...bar, v: k.v });
    this.candle.update(bar);
    this.vol.update({ time: bar.time, value: k.v, color: k.c >= k.o ? 'rgba(14,203,129,.35)' : 'rgba(246,70,93,.35)' });
    if (closed && interval === '1d') this.drawSma();
    this.legend(null);
  }

  legend(p) {
    let d = p && p.time ? p.seriesData.get(this.candle) : null;
    let v;
    if (d) v = this.data.find((x) => x.time === p.time)?.v;
    else if (this.data.length) { const l = this.data[this.data.length - 1]; d = l; v = l.v; }
    if (!d) { this.legendEl.textContent = ''; return; }
    const ch = ((d.close / d.open) - 1) * 100;
    const c = ch >= 0 ? 'up' : 'down';
    const dp = this.dec ?? 2;
    this.legendEl.innerHTML = `시 <b class="${c}">${d.open.toFixed(dp)}</b> 고 <b class="${c}">${d.high.toFixed(dp)}</b> 저 <b class="${c}">${d.low.toFixed(dp)}</b> 종 <b class="${c}">${d.close.toFixed(dp)}</b> <span class="${c}">${fPct(ch)}</span> 거래량 ${fNum(v, 0)}`;
  }

  setLine(key, opts) {
    const cur = this.lines.get(key);
    if (cur) cur.applyOptions(opts);
    else this.lines.set(key, this.candle.createPriceLine({ lineWidth: 1, axisLabelVisible: true, ...opts }));
  }

  updateOverlays(snap, sym) {
    if (sym !== this.symbol) return;
    const f = snap.symbols[sym]?.filters;
    if (f && this.precisionKey !== `${sym}:${f.tickSize}`) {
      this.dec = stepDecimals(f.tickSize);
      this.candle.applyOptions({ priceFormat: { type: 'price', precision: this.dec, minMove: Number(f.tickSize) } });
      this.precisionKey = `${sym}:${f.tickSize}`;
    }
    const want = new Set();
    const put = (k, o) => { want.add(k); this.setLine(k, o); };
    for (const p of snap.positions.filter((x) => x.symbol === sym)) {
      if (!this.toggles[toggleKey(p.strategy)]) continue;
      const col = ST_COLOR[p.strategy];
      put(`E:${p.strategy}`, { price: p.entryPrice, color: col, lineStyle: LC.LineStyle.Solid, title: `${p.strategy} ${p.side === 'LONG' ? '롱' : '숏'} ${fPct(p.pricePct)}` });
      if (this.toggles.stops && p.stopPrice) put(`S:${p.strategy}`, { price: p.stopPrice, color: '#f6465d', lineStyle: LC.LineStyle.Dashed, title: `${p.strategy} 손절` });
      if (this.toggles.stops && p.tpPrice) put(`T:${p.strategy}`, { price: p.tpPrice, color: '#0ecb81', lineStyle: LC.LineStyle.Dashed, title: `${p.strategy} 익절` });
    }
    const tv = snap.slots.find((x) => x.strategy === 'TURTLE' && x.symbol === sym)?.view || {};
    const av = snap.slots.find((x) => x.strategy === 'ADX' && x.symbol === sym)?.view || {};
    const smaV = tv.sma ?? av.sma;
    if (this.toggles.sma && this.interval !== '1d' && smaV) put('SMA', { price: smaV, color: '#8e7cc3', lineStyle: LC.LineStyle.Dotted, title: 'D SMA200' });
    if (this.toggles.channel && tv.entryHigh) {
      put('CH20H', { price: tv.entryHigh, color: '#5b6472', lineStyle: LC.LineStyle.Dotted, title: '진입 고가' });
      put('CH20L', { price: tv.entryLow, color: '#5b6472', lineStyle: LC.LineStyle.Dotted, title: '진입 저가' });
      put('CH10H', { price: tv.exitHigh, color: '#3b424c', lineStyle: LC.LineStyle.SparseDotted, title: '청산 고가' });
      put('CH10L', { price: tv.exitLow, color: '#3b424c', lineStyle: LC.LineStyle.SparseDotted, title: '청산 저가' });
    }
    for (const [k, line] of this.lines) if (!want.has(k)) { this.candle.removePriceLine(line); this.lines.delete(k); }

    // trade markers (entries/exits) snapped to bar times
    const trades = snap.trades.filter((t) => t.symbol === sym && this.toggles[toggleKey(t.strategy)]);
    const opens = snap.positions.filter((p) => p.symbol === sym && this.toggles[toggleKey(p.strategy)]);
    const sig = `${this.interval}:${this.toggles.markers}:${trades.length}:${opens.map((p) => p.entryTime).join(',')}:${this.data.length ? this.data[0].time : 0}`;
    if (sig === this.markerSig) return;
    this.markerSig = sig;
    if (!this.toggles.markers || !this.data.length) { this.markers.setMarkers([]); return; }
    const ms = IV_MS[this.interval];
    const first = this.data[0].time;
    const snapT = (ts) => toT(Math.floor(ts / ms) * ms);
    const mk = [];
    const entry = (st, side, ts, px) => mk.push({ time: snapT(ts), position: side === 'LONG' ? 'belowBar' : 'aboveBar', color: ST_COLOR[st], shape: side === 'LONG' ? 'arrowUp' : 'arrowDown', text: `${st[0]}${side[0]} ${px}` });
    for (const t of trades) {
      entry(t.strategy, t.side, t.entryTime, fNum(t.entryPrice, this.dec));
      mk.push({ time: snapT(t.exitTime), position: t.side === 'LONG' ? 'aboveBar' : 'belowBar', color: t.netPnl >= 0 ? '#0ecb81' : '#f6465d', shape: 'circle', text: `${t.strategy[0]}X ${t.returnPct.toFixed(1)}%` });
    }
    for (const p of opens) entry(p.strategy, p.side, p.entryTime, fNum(p.entryPrice, this.dec));
    this.markers.setMarkers(mk.filter((m) => m.time >= first).sort((a, b) => a.time - b.time));
  }
}
