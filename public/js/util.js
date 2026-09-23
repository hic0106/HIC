export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf = {};
const fmt = (d) => (nf[d] ||= new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const ok = (v) => v != null && Number.isFinite(Number(v));

export const fNum = (v, d = 2) => (ok(v) ? fmt(d).format(Number(v)) : '—');
export const fUsd = (v, d = 2) => (ok(v) ? fmt(d).format(v) : '—');
export const fSigned = (v, d = 2) => (ok(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(d).format(Math.abs(v))}` : '—');
export const fPct = (v, d = 2) => (ok(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%` : '—');
export const cls = (v) => (!ok(v) || Math.abs(v) < 1e-12 ? '' : v > 0 ? 'up' : 'down');

export function stepDecimals(step) {
  const s = String(step ?? '');
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.replace(/0+$/, '').length - i - 1;
}
export function fPrice(v, f) {
  if (!ok(v)) return '—';
  const d = f?.tickSize ? stepDecimals(f.tickSize) : v >= 1000 ? 1 : v >= 10 ? 2 : 4;
  return fmt(d).format(v);
}
export const pad = (n) => String(n).padStart(2, '0');
export function fTime(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
export function fDateTime(ts) { if (!ts) return '—'; const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function fDur(ms) {
  if (!ok(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(s % 60)}s`;
}

export async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-HIC': '1' }, body: body ? JSON.stringify(body) : undefined });
  let j;
  try { j = await r.json(); } catch { j = { ok: false, msg: `HTTP ${r.status}` }; }
  return j;
}

export function toast(msg, kind = '') {
  const d = document.createElement('div');
  d.className = `toast ${kind}`;
  d.textContent = msg;
  document.getElementById('toasts').appendChild(d);
  setTimeout(() => d.remove(), kind === 'err' ? 7000 : 3500);
}

// Local time with zone label (KST when the browser is in Korea); ET for US-session items.
const LOCAL_TZ = (() => { const off = -new Date().getTimezoneOffset(); if (off === 540) return 'KST'; const h = off / 60; return `UTC${h >= 0 ? '+' : ''}${h}`; })();
export function fZone(ts, { date = 'auto' } = {}) {
  if (!ts) return '—';
  const d = new Date(ts), now = new Date();
  const same = d.toDateString() === now.toDateString();
  const tmr = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = date === 'never' || (date === 'auto' && same) ? '' : tmr && date === 'auto' ? 'Tomorrow ' : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} `;
  return `${day}${hm} ${LOCAL_TZ}`;
}
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
export function fET(ts) {
  if (!ts) return '—';
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month}-${p.day} ${p.hour}:${p.minute} ET`;
}
