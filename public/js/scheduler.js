// Scheduler tab: strategy instances (timeframe / last evaluated candle / next candle) + Signal Log.
import { $, esc, fZone, fET, fDateTime } from './util.js';

const S = { signals: [], filter: { strategy: '', symbol: '', result: '' } };
const SHORT = { TURTLE: 'TURTLE', ADX: 'ADX', TSMOM: 'TSMOM', QQQ_EMA_TREND: 'QQQ EMA', QQQ_TSMOM: 'QQQ TSMOM', QQQ_SMA200: 'QQQ SMA200', QQQ_TURTLE_50_20: 'QQQ T50/20' };

export function setSignals(list) { S.signals = list.slice(-2000); }
export function addSignal(r) { S.signals.push(r); if (S.signals.length > 2000) S.signals.shift(); }

const statusCls = (s) => ({ RUNNING: 'up', RETRYING: 'warn', STOPPED: 'down', DISABLED: 'muted', UNAVAILABLE: 'down' }[s] || '');
const resultCls = (r = '') => (/ENTRY (LONG|SHORT)$/.test(r) || r.includes('· ENTRY') ? 'up' : r.startsWith('EXIT') ? 'warn' : /SKIP|STALE|FAILED|ERROR/.test(r) ? 'down' : 'muted');

// Compact line for the right-panel strategy card
export function scheduleLine(row) {
  if (!row) return '';
  const st = `<span class="${statusCls(row.status)}">${row.status}</span>`;
  if (row.timeframe === 'US_SESSION') {
    return `${row.timeframeLabel} · Signal: US Market Close · Market <span class="${row.market === 'OPEN' ? 'up' : 'muted'}">${row.market}</span> · Next Eval ${fET(row.nextExpectedCandle)} · ${st}`;
  }
  return `${row.timeframeLabel} · Last Check ${fZone(row.lastEvaluatedCandle)} · Next Candle ${fZone(row.nextExpectedCandle)} · ${st}`;
}

export function renderScheduler(root, snap) {
  const rows = snap.scheduler || [];
  const inst = rows.map((r) => {
    const us = r.timeframe === 'US_SESSION';
    return `<tr data-sym="${r.symbol}"><td class="l"><b>${SHORT[r.strategy] || r.strategy}</b></td><td class="l">${r.symbol}</td><td class="l">${r.timeframeLabel}</td>
      <td class="l">${us ? 'US_MARKET_CLOSE' : 'CANDLE_CLOSE'}</td>
      <td>${fZone(r.lastEvaluatedCandle, { date: 'always' })}</td><td>${fZone(r.lastClosedCandle, { date: 'always' })}</td>
      <td>${us ? fET(r.nextExpectedCandle) : fZone(r.nextExpectedCandle)}</td>
      <td class="l">${us ? `<span class="${r.market === 'OPEN' ? 'up' : 'muted'}">US ${r.market}</span> <span class="muted">exec: Binance 24/7</span>` : '<span class="muted">Binance UTC klines</span>'}</td>
      <td class="l ${resultCls(r.lastResult)}">${esc(r.lastResult || '—')}</td><td>${r.evaluations}</td><td>${r.entryGraceMin}m</td>
      <td class="${statusCls(r.status)}"><b>${r.status}</b></td></tr>`;
  }).join('');
  const f = S.filter;
  const list = S.signals.filter((x) => (!f.strategy || x.strategy === f.strategy) && (!f.symbol || x.symbol === f.symbol) && (!f.result || (f.result === 'ACTION' ? /ENTRY|EXIT/.test(x.result) && !/SKIPPED/.test(x.result) : x.result === f.result || x.result.startsWith(f.result))));
  const opts = (vals, cur) => `<option value="">ALL</option>${vals.map((v) => `<option ${v === cur ? 'selected' : ''}>${v}</option>`).join('')}`;
  const strategies = [...new Set(rows.map((r) => r.strategy))], symbols = [...new Set(rows.map((r) => r.symbol))];
  const sig = list.slice(-400).reverse().map((x) => `<tr data-sym="${x.symbol}"><td class="l">${fDateTime(x.ts)}</td><td class="l">${x.mode}</td><td class="l"><b>${SHORT[x.strategy] || x.strategy}</b></td><td class="l">${x.symbol}</td>
    <td class="l">${x.timeframe === 'US_SESSION' ? 'US SESSION' : x.timeframe.toUpperCase()}</td><td>${x.timeframe === 'US_SESSION' ? fET(x.candleClose) : fZone(x.candleClose, { date: 'always' })}</td>
    <td class="l muted">${esc(x.trigger)}</td><td class="l reason" title="${esc(x.detail)}">${esc(x.detail)}</td><td class="l ${resultCls(x.result)}"><b>${esc(x.result)}</b></td></tr>`).join('');
  root.innerHTML = `<div class="sub-h">STRATEGY SCHEDULER · evaluation on candle close (kline x=true / US session close) · stops are real-time (RiskMonitor), never wait for a close</div>
    <table class="t"><thead><tr><th>Strategy</th><th>Symbol</th><th>Timeframe</th><th>Schedule</th><th>Last Evaluated Candle</th><th>Last Closed</th><th>Next Expected</th><th>Session / Market</th><th>Last Result</th><th>Evals</th><th>Entry Grace</th><th>Status</th></tr></thead><tbody>${inst}</tbody></table>
    <div class="sub-h sig-bar">SIGNAL LOG · every evaluation (also HOLD / no signal)
      <span>Strategy <select data-f="strategy">${opts(strategies, f.strategy)}</select> Symbol <select data-f="symbol">${opts(symbols, f.symbol)}</select>
      Result <select data-f="result">${opts(['ACTION', 'HOLD', 'BOT_STOPPED', 'STALE_ENTRY_SKIPPED', 'SKIP', 'NOT_READY', 'DISABLED'], f.result)}</select></span></div>
    ${sig ? `<table class="t"><thead><tr><th>Time</th><th>Mode</th><th>Strategy</th><th>Symbol</th><th>TF</th><th>Candle Close</th><th>Trigger</th><th class="l">Conditions</th><th class="l">Result</th></tr></thead><tbody>${sig}</tbody></table>` : '<div class="empty">No evaluations yet</div>'}`;
  root.querySelectorAll('select[data-f]').forEach((s) => { s.onchange = () => { S.filter[s.dataset.f] = s.value; renderScheduler(root, snap); }; });
}
