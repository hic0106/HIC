/* Minimal canvas charts for the research lab (no external dependencies). */
(function (global) {
  "use strict";

  const css = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(50, Math.floor(rect.width));
    const h = Math.max(50, Math.floor(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toISOString().replace("T", " ").slice(0, 16);
  }

  function niceNum(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (a >= 1e4) return (v / 1e3).toFixed(1) + "k";
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(3);
    return v.toPrecision(3);
  }

  class CandleChart {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.opts = Object.assign({ volume: true, interactive: true, minBars: 20 }, opts);
      this.bars = [];
      this.meta = {};
      this.view = [0, 0];
      this.hover = null;
      if (this.opts.interactive) this._bind();
      this._ro = new ResizeObserver(() => this.draw());
      this._ro.observe(canvas);
    }

    setData(bars, meta = {}) {
      this.bars = bars || [];
      this.meta = meta;
      const n = this.bars.length;
      const span = Math.min(n, meta.initialSpan || n);
      this.view = [Math.max(0, n - span), n];
      this.draw();
    }

    _bind() {
      const c = this.canvas;
      let drag = null;
      c.addEventListener("wheel", (e) => {
        e.preventDefault();
        const [a, b] = this.view;
        const span = b - a;
        const n = this.bars.length;
        const f = e.deltaY > 0 ? 1.15 : 0.87;
        const ns = Math.max(this.opts.minBars, Math.min(n, Math.round(span * f)));
        const rect = c.getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        const center = a + span * frac;
        let na = Math.round(center - ns * frac);
        na = Math.max(0, Math.min(n - ns, na));
        this.view = [na, na + ns];
        this.draw();
      }, { passive: false });
      c.addEventListener("mousedown", (e) => { drag = { x: e.clientX, view: this.view.slice() }; });
      window.addEventListener("mouseup", () => { drag = null; });
      c.addEventListener("mousemove", (e) => {
        const rect = c.getBoundingClientRect();
        if (drag) {
          const span = drag.view[1] - drag.view[0];
          const dx = e.clientX - drag.x;
          const shift = Math.round(-dx / rect.width * span);
          const n = this.bars.length;
          let na = Math.max(0, Math.min(n - span, drag.view[0] + shift));
          this.view = [na, na + span];
        }
        this.hover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        this.draw();
      });
      c.addEventListener("mouseleave", () => { this.hover = null; this.draw(); });
    }

    draw() {
      const { ctx, w, h } = fitCanvas(this.canvas);
      const bg = css("--chart-bg", "#0b0f14");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      const bars = this.bars;
      if (!bars.length) {
        ctx.fillStyle = css("--muted", "#7d8a99");
        ctx.font = "12px ui-monospace, monospace";
        ctx.fillText("no data", 12, 20);
        return;
      }
      const [a, b] = this.view;
      const vis = bars.slice(a, b);
      const padR = 64, padT = 8, padB = 18;
      const volH = this.opts.volume ? Math.round((h - padT - padB) * 0.22) : 0;
      const priceH = h - padT - padB - volH - (volH ? 6 : 0);
      let lo = Infinity, hi = -Infinity, vmax = 0;
      for (const r of vis) { lo = Math.min(lo, r[3]); hi = Math.max(hi, r[2]); vmax = Math.max(vmax, r[5]); }
      const span = hi - lo || hi * 1e-3 || 1;
      lo -= span * 0.04; hi += span * 0.04;
      const plotW = w - padR;
      const cw = plotW / vis.length;
      const py = (p) => padT + (hi - p) / (hi - lo) * priceH;
      const grid = css("--grid", "#1b2430");
      ctx.strokeStyle = grid; ctx.lineWidth = 1;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillStyle = css("--muted", "#7d8a99");
      for (let g = 0; g <= 4; g++) {
        const y = padT + priceH * g / 4;
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(plotW, y + 0.5); ctx.stroke();
        ctx.fillText(niceNum(hi - (hi - lo) * g / 4), plotW + 6, y + 3);
      }
      const m = this.meta;
      const rel = (i) => i - a;
      // shaded regions: [{from, to, color}]
      for (const s of (m.shades || [])) {
        const x0 = Math.max(0, rel(s.from)) * cw, x1 = Math.min(vis.length, rel(s.to) + 1) * cw;
        if (x1 > x0) { ctx.fillStyle = s.color; ctx.fillRect(x0, padT, x1 - x0, priceH + volH + 6); }
      }
      if (m.highlight) {
        const [h0, h1] = m.highlight;
        const x0 = Math.max(0, rel(h0)) * cw, x1 = Math.min(vis.length, rel(h1) + 1) * cw;
        if (x1 > x0) {
          ctx.fillStyle = css("--hl", "rgba(245,158,11,0.13)");
          ctx.fillRect(x0, padT, x1 - x0, priceH);
        }
      }
      const up = css("--up", "#26a69a"), dn = css("--down", "#ef5350");
      const bw = Math.max(1, cw * 0.66);
      vis.forEach((r, i) => {
        const x = i * cw + cw / 2;
        const isUp = r[4] >= r[1];
        ctx.strokeStyle = ctx.fillStyle = isUp ? up : dn;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, py(r[2])); ctx.lineTo(Math.round(x) + 0.5, py(r[3])); ctx.stroke();
        const y0 = py(Math.max(r[1], r[4])), y1 = py(Math.min(r[1], r[4]));
        ctx.fillRect(x - bw / 2, y0, bw, Math.max(1, y1 - y0));
        if (volH && vmax > 0) {
          const vh = volH * r[5] / vmax;
          ctx.globalAlpha = 0.55;
          ctx.fillRect(x - bw / 2, h - padB - vh, bw, vh);
          ctx.globalAlpha = 1;
        }
      });
      for (const mk of (m.markers || [])) {
        const i = rel(mk.i);
        if (i < 0 || i >= vis.length) continue;
        const x = i * cw + cw / 2;
        const r = vis[i];
        const col = mk.type === "exit" ? css("--amber", "#f59e0b") : mk.type === "signal" ? css("--violet", "#a78bfa")
          : (mk.side === "short" ? dn : css("--accent", "#2dd4bf"));
        ctx.fillStyle = col;
        const y = mk.type === "exit" ? py(r[2]) - 10 : py(r[3]) + 10;
        ctx.beginPath();
        if (mk.type === "exit") { ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y - 5); ctx.lineTo(x, y + 2); }
        else { ctx.moveTo(x - 5, y + 5); ctx.lineTo(x + 5, y + 5); ctx.lineTo(x, y - 2); }
        ctx.fill();
        if (mk.label) { ctx.font = "10px ui-monospace, monospace"; ctx.fillText(mk.label, x + 6, y); }
      }
      if (m.vline != null) {
        const i = rel(m.vline);
        if (i >= 0 && i < vis.length) {
          ctx.strokeStyle = css("--amber", "#f59e0b"); ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(i * cw + cw / 2, padT); ctx.lineTo(i * cw + cw / 2, padT + priceH); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      ctx.fillStyle = css("--muted", "#7d8a99");
      ctx.fillText(fmtTime(vis[0][0]), 4, h - 4);
      const last = fmtTime(vis[vis.length - 1][0]);
      ctx.fillText(last, plotW - ctx.measureText(last).width - 4, h - 4);
      if (this.hover && this.hover.x < plotW) {
        const i = Math.min(vis.length - 1, Math.max(0, Math.floor(this.hover.x / cw)));
        const r = vis[i];
        ctx.strokeStyle = css("--cross", "#3b4a5c");
        ctx.beginPath(); ctx.moveTo(i * cw + cw / 2, padT); ctx.lineTo(i * cw + cw / 2, h - padB); ctx.stroke();
        const txt = `${fmtTime(r[0])}  O ${niceNum(r[1])}  H ${niceNum(r[2])}  L ${niceNum(r[3])}  C ${niceNum(r[4])}  V ${niceNum(r[5])}`;
        ctx.font = "11px ui-monospace, monospace";
        const tw = ctx.measureText(txt).width + 10;
        ctx.fillStyle = "rgba(10,14,20,0.9)"; ctx.fillRect(6, padT + 2, tw, 18);
        ctx.fillStyle = css("--text", "#d7dee7"); ctx.fillText(txt, 11, padT + 15);
      }
    }
  }

  class LineChart {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.opts = Object.assign({ log: false, percent: false }, opts);
      this.series = [];
      this.shades = [];
      this.hover = null;
      canvas.addEventListener("mousemove", (e) => {
        const r = canvas.getBoundingClientRect(); this.hover = e.clientX - r.left; this.draw();
      });
      canvas.addEventListener("mouseleave", () => { this.hover = null; this.draw(); });
      this._ro = new ResizeObserver(() => this.draw());
      this._ro.observe(canvas);
    }

    setData(series, shades = [], vlines = []) {
      this.series = series; this.shades = shades; this.vlines = vlines; this.draw();
    }

    draw() {
      const { ctx, w, h } = fitCanvas(this.canvas);
      ctx.fillStyle = css("--chart-bg", "#0b0f14"); ctx.fillRect(0, 0, w, h);
      const pts = this.series.flatMap((s) => s.points);
      if (!pts.length) return;
      const padR = 64, padT = 10, padB = 18, plotW = w - padR, plotH = h - padT - padB;
      let t0 = Infinity, t1 = -Infinity, lo = Infinity, hi = -Infinity;
      const tf = this.opts.log ? (v) => Math.log(Math.max(v, 1e-9)) : (v) => v;
      for (const [t, v] of pts) { t0 = Math.min(t0, t); t1 = Math.max(t1, t); lo = Math.min(lo, tf(v)); hi = Math.max(hi, tf(v)); }
      if (hi === lo) { hi += 1; lo -= 1; }
      const px = (t) => (t - t0) / (t1 - t0 || 1) * plotW;
      const py = (v) => padT + (hi - tf(v)) / (hi - lo) * plotH;
      for (const s of this.shades) {
        ctx.fillStyle = s.color; ctx.fillRect(px(s.from), padT, px(s.to) - px(s.from), plotH);
        ctx.fillStyle = css("--muted", "#7d8a99"); ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(s.label, px(s.from) + 4, padT + 12);
      }
      ctx.strokeStyle = css("--grid", "#1b2430"); ctx.fillStyle = css("--muted", "#7d8a99");
      ctx.font = "10px ui-monospace, monospace";
      for (let g = 0; g <= 4; g++) {
        const y = padT + plotH * g / 4;
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(plotW, y + 0.5); ctx.stroke();
        let val = hi - (hi - lo) * g / 4; if (this.opts.log) val = Math.exp(val);
        ctx.fillText(this.opts.percent ? (val * 100).toFixed(1) + "%" : niceNum(val), plotW + 6, y + 3);
      }
      for (const vl of (this.vlines || [])) {
        ctx.strokeStyle = css("--amber", "#f59e0b"); ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(px(vl.t), padT); ctx.lineTo(px(vl.t), padT + plotH); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = css("--amber", "#f59e0b"); ctx.fillText(vl.label, px(vl.t) - 60, padT + 24);
      }
      for (const s of this.series) {
        ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.6;
        if (s.dashed) ctx.setLineDash([5, 4]);
        ctx.beginPath();
        s.points.forEach(([t, v], i) => { const x = px(t), y = py(v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
      }
      ctx.fillStyle = css("--muted", "#7d8a99");
      ctx.fillText(fmtTime(t0).slice(0, 10), 4, h - 4);
      const e = fmtTime(t1).slice(0, 10); ctx.fillText(e, plotW - ctx.measureText(e).width, h - 4);
      let ly = padT + 14;
      for (const s of this.series) {
        if (!s.label) continue;
        ctx.fillStyle = s.color; ctx.fillRect(plotW - 150, ly - 8, 10, 3);
        ctx.fillStyle = css("--text", "#d7dee7"); ctx.fillText(s.label, plotW - 136, ly - 4); ly += 14;
      }
      if (this.hover != null && this.hover < plotW && this.series[0]) {
        const t = t0 + this.hover / plotW * (t1 - t0);
        ctx.strokeStyle = css("--cross", "#3b4a5c");
        ctx.beginPath(); ctx.moveTo(this.hover, padT); ctx.lineTo(this.hover, padT + plotH); ctx.stroke();
        const p0 = this.series[0].points;
        let best = p0[0];
        for (const p of p0) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
        const txt = `${fmtTime(best[0])}  ${this.opts.percent ? (best[1] * 100).toFixed(2) + "%" : niceNum(best[1])}`;
        ctx.fillStyle = "rgba(10,14,20,0.9)"; ctx.fillRect(6, padT, ctx.measureText(txt).width + 10, 16);
        ctx.fillStyle = css("--text", "#d7dee7"); ctx.fillText(txt, 11, padT + 12);
      }
    }
  }

  function barChart(canvas, values, labels, opts = {}) {
    const { ctx, w, h } = fitCanvas(canvas);
    ctx.fillStyle = css("--chart-bg", "#0b0f14"); ctx.fillRect(0, 0, w, h);
    const n = values.length; if (!n) return;
    const mx = Math.max(...values.map(Math.abs), 1e-12);
    const zeroY = opts.signed ? h / 2 : h - 14;
    const bw = (w - 10) / n;
    values.forEach((v, i) => {
      const bh = (opts.signed ? (h / 2 - 16) : (h - 24)) * Math.abs(v) / mx;
      ctx.fillStyle = v >= 0 ? (opts.color || css("--accent", "#2dd4bf")) : css("--down", "#ef5350");
      ctx.fillRect(5 + i * bw + 1, v >= 0 ? zeroY - bh : zeroY, Math.max(1, bw - 2), bh);
    });
    ctx.fillStyle = css("--muted", "#7d8a99"); ctx.font = "9px ui-monospace, monospace";
    (labels || []).forEach((l, i) => { if (l !== "") ctx.fillText(l, 5 + i * bw, h - 3); });
  }

  global.LabCharts = { CandleChart, LineChart, barChart, fmtTime, niceNum };
})(window);
