// BACKTEST screen: replay of the current strategy settings over past Binance data (no orders).
import { $, $$, esc, fNum, fSigned, fPct, fDateTime, cls, api, toast } from './util.js';
import { ST_COLOR } from './chart.js';

const LC = window.LightweightCharts;
const TZ = -new Date().getTimezoneOffset() * 60;
const toT = (ms) => Math.floor(ms / 1000) + TZ;
const SHORT = { TURTLE: 'TURTLE', ADX: 'ADX', TSMOM: 'TSMOM', QQQ_EMA_TREND: 'QQQ EMA', QQQ_TSMOM: 'QQQ TSMOM', QQQ_SMA200: 'QQQ SMA200', QQQ_TURTLE_50_20: 'QQQ T50/20' };
const TFL = { '4h': '4H', '1d': '1D', US_SESSION: 'US SESSION' };
const won = (v) => (v == null || !Number.isFinite(v) ? '—' : `₩${fNum(v, 0)}`);
const wonS = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}₩${fNum(Math.abs(v), 0)}`);
const pf = (v) => (v == null ? '—' : v === Infinity || v === 'Infinity' ? '∞' : fNum(v, 2));

const B = { root: null, res: null, sel: null, sym: null, eqChart: null, cChart: null, poll: null };

export function mountBacktest(root) {
  if (B.root === root) return;
  B.root = root;
  root.innerHTML = `
    <div class="pf-card bt-bar">
      <b>BACKTEST</b>
      <label>Period <input type="number" id="btDays" value="365" min="7" max="1000" step="1"> days</label>
      <label>Capital per strategy <input type="number" id="btCap" value="1000000" min="1000" step="100000"> ₩</label>
      <label><input type="checkbox" id="btComp" checked> Compound</label>
      <button class="btn primary" id="btRun">▶ RUN BACKTEST</button>
      <span id="btStatus" class="muted"></span>
      <span class="muted bt-note">현재 저장된 전략 설정(파라미터·Timeframe·Stop·Short·수수료·슬리피지·펀딩) 그대로 · 신호=마감 캔들, 체결=다음 캔들 시가 · 주문 없음</span>
    </div>
    <div class="pf-card"><div class="panel-h">RESULTS <span class="muted" id="btMeta"></span></div><div id="btSummary"><div class="empty">RUN BACKTEST를 누르면 Binance 과거 데이터로 계산합니다 (PC에서 실행).</div></div></div>
    <div class="pf-row two">
      <div class="pf-card"><div class="panel-h">EQUITY <span class="muted" id="btEqTitle"></span></div><div id="btEq" class="bt-chart"></div></div>
      <div class="pf-card"><div class="panel-h">METRICS <span class="muted" id="btMTitle"></span></div><div id="btMetrics"></div></div>
    </div>
    <div class="pf-card"><div class="panel-h">CHART · trades on the strategy's candles <span class="pf-tools" id="btSyms"></span></div><div id="btCandle" class="bt-chart tall"></div></div>
    <div class="pf-card"><div class="panel-h">TRADES <span class="muted" id="btTrTitle"></span></div><div id="btTrades"></div></div>`;
  $('#btRun').onclick = run;
  $('#btSummary').addEventListener('click', (e) => { const r = e.target.closest('tr[data-st]'); if (r) select(r.dataset.st); });
  $('#btSyms').addEventListener('click', (e) => { const b = e.target.closest('button[data-sym]'); if (b) { B.sym = b.dataset.sym; renderDetail(); } });
  $('#btTrades').addEventListener('click', (e) => { const r = e.target.closest('tr[data-i]'); if (r) focusTrade(Number(r.dataset.i)); });
  initCharts();
  load();
}

async function run() {
  const body = { days: Number($('#btDays').value), capital: Number($('#btCap').value), compound: $('#btComp').checked };
  const r = await api('POST', '/api/backtest/run', body);
  if (!r.ok) return toast(r.msg || 'backtest failed', 'err');
  pollStatus();
}

function pollStatus() {
  clearInterval(B.poll);
  B.poll = setInterval(async () => {
    const s = await api('GET', '/api/backtest/status');
    $('#btStatus').innerHTML = s.state === 'RUNNING' ? `<span class="warn">RUNNING ${s.progress}% · ${esc(s.msg)}</span>` : s.state === 'ERROR' ? `<span class="down">ERROR ${esc(s.msg)}</span>` : '';
    $('#btRun').disabled = s.state === 'RUNNING';
    if (s.state !== 'RUNNING') { clearInterval(B.poll); if (s.state === 'DONE') load(); }
  }, 700);
}

async function load() {
  const r = await api('GET', '/api/backtest/result');
  if (!r || !r.results) { const s = await api('GET', '/api/backtest/status'); if (s.state === 'RUNNING') pollStatus(); return; }
  B.res = r;
  $('#btDays').value = r.days; $('#btCap').value = r.capital; $('#btComp').checked = r.compound;
  renderSummary();
  select(B.sel && r.results.some((x) => x.strategy === B.sel) ? B.sel : 'PORTFOLIO');
}

function renderSummary() {
  const r = B.res;
  $('#btMeta').textContent = `${fDateTime(r.start)} → ${fDateTime(r.end)} · ₩${fNum(r.capital, 0)} per strategy · ${r.compound ? 'compound' : 'fixed size'} · fee ${r.settings.general.takerFeePct}% · slip ${r.settings.general.slippagePct}% · funding ${r.settings.general.includeFunding ? 'ON' : 'OFF'} · run ${fDateTime(r.ranAt)}`;
  const bhRet = (x) => { const b = x.benchmark; return b.length ? (b[b.length - 1].equity / x.capital - 1) * 100 : null; };
  const row = (x) => { const m = x.metrics; return `<tr data-st="${x.strategy}" class="${B.sel === x.strategy ? 'sel' : ''}">
    <td class="l"><i class="sw-dot" style="background:${ST_COLOR[x.strategy]}"></i><b>${SHORT[x.strategy]}</b>${x.enabled ? '' : ' <span class="muted">(disabled)</span>'}</td>
    <td class="l">${TFL[x.timeframe]}</td><td class="l">${x.symbols.map((s) => s.replace('USDT', '')).join(' ')}</td>
    <td>${won(m.finalEquity)}</td><td class="${cls(m.profit)}">${wonS(m.profit)}</td><td class="${cls(m.returnPct)}"><b>${fPct(m.returnPct)}</b></td>
    <td class="down">${m.maxDrawdownPct ? '−' + m.maxDrawdownPct.toFixed(2) + '%' : '0.00%'}</td><td>${m.trades}</td><td>${m.winRatePct != null ? m.winRatePct.toFixed(0) + '%' : '—'}</td>
    <td>${pf(m.profitFactor)}</td><td>${m.sharpe != null ? m.sharpe.toFixed(2) : '—'}</td><td class="down">${wonS(-x.fees)}</td><td class="${cls(x.funding)}">${wonS(x.funding)}</td>
    <td class="${cls(bhRet(x))}">${fPct(bhRet(x))}</td><td class="l muted bt-notes" title="${esc(x.notes.join('\n'))}">${esc(x.notes[0] || '')}</td></tr>`; };
  const P = r.portfolio, pm = P.metrics;
  $('#btSummary').innerHTML = `<table class="t"><thead><tr><th>Strategy</th><th>TF</th><th>Symbols</th><th>Final</th><th>Profit</th><th>Return</th><th>Max DD</th><th>Trades</th><th>Win</th><th>PF</th><th>Sharpe</th><th>Fees</th><th>Funding</th><th>Buy&amp;Hold</th><th class="l">Notes</th></tr></thead>
    <tbody>${r.results.map(row).join('')}</tbody>
    <tfoot><tr data-st="PORTFOLIO" class="${B.sel === 'PORTFOLIO' ? 'sel' : ''}"><td class="l">ALL STRATEGIES (₩${fNum(P.capital, 0)})</td><td></td><td></td><td>${won(pm.finalEquity)}</td><td class="${cls(pm.profit)}">${wonS(pm.profit)}</td><td class="${cls(pm.returnPct)}">${fPct(pm.returnPct)}</td>
    <td class="down">−${pm.maxDrawdownPct.toFixed(2)}%</td><td>${pm.trades}</td><td>${pm.winRatePct != null ? pm.winRatePct.toFixed(0) + '%' : '—'}</td><td>${pf(pm.profitFactor)}</td><td>${pm.sharpe != null ? pm.sharpe.toFixed(2) : '—'}</td><td></td><td></td><td></td><td class="l muted">sum of all strategy accounts (daily)</td></tr></tfoot></table>`;
}

function select(st) {
  B.sel = st;
  $$('#btSummary tr[data-st]').forEach((r) => r.classList.toggle('sel', r.dataset.st === st));
  const x = cur();
  B.sym = x ? (x.symbols.includes(B.sym) ? B.sym : x.symbols[0]) : null;
  renderDetail();
}
const cur = () => B.res?.results.find((x) => x.strategy === B.sel) || null;

function renderDetail() {
  const r = B.res;
  const x = cur();
  const eq = x ? x.equity : r.portfolio.equity;
  const m = x ? x.metrics : r.portfolio.metrics;
  $('#btEqTitle').textContent = x ? `${SHORT[x.strategy]} vs Buy & Hold (${x.symbols.map((s) => s.replace('USDT', '')).join('+')})` : 'all strategies (sum)';
  B.eqS.setData(dedup(eq.map((p) => ({ time: toT(p.t), value: p.equity }))));
  B.bhS.setData(x ? dedup(x.benchmark.map((p) => ({ time: toT(p.t), value: p.equity }))) : []);
  B.eqS.applyOptions({ color: x ? ST_COLOR[x.strategy] : '#f0b90b' });
  B.eqChart.timeScale().fitContent();
  $('#btMTitle').textContent = x ? SHORT[x.strategy] : 'ALL';
  const kv = [
    ['Final Equity', won(m.finalEquity)], ['Profit', `<span class="${cls(m.profit)}">${wonS(m.profit)}</span>`], ['Return', `<span class="${cls(m.returnPct)}">${fPct(m.returnPct)}</span>`],
    ['CAGR', m.cagrPct != null ? fPct(m.cagrPct) : '—'], ['Max Drawdown', `<span class="down">−${m.maxDrawdownPct.toFixed(2)}%</span>`], ['Longest DD', `${fNum(m.longestDrawdownDays, 1)} days`],
    ['Trades (W / L)', `${m.trades} (${m.wins} / ${m.losses})`], ['Win Rate', m.winRatePct != null ? m.winRatePct.toFixed(1) + '%' : '—'], ['Profit Factor', pf(m.profitFactor)],
    ['Avg Win / Loss', `<span class="up">${wonS(m.avgWin)}</span> / <span class="down">${wonS(m.avgLoss)}</span>`], ['Best / Worst Trade', `${fPct(m.bestTrade)} / ${fPct(m.worstTrade)}`],
    ['Sharpe (daily, ann.)', m.sharpe != null ? m.sharpe.toFixed(2) : '—'], ['Avg Holding', m.avgHoldDays != null ? `${fNum(m.avgHoldDays, 1)} days` : '—'],
    ['Exit Reasons', Object.entries(m.byReason || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'],
    ...(x ? [['Settings', `${TFL[x.timeframe]} · ${esc(JSON.stringify(x.params))} · stop ${x.stop.mode}${x.stop.mode === 'ATR_DYNAMIC' ? ` ATR${x.stop.atrPeriod}×${x.stop.atrMult} ${x.stop.minPct}–${x.stop.maxPct}%` : x.stop.mode === 'FIXED_PERCENT' ? ` ${x.stop.fixedPct}%` : ''} · short ${x.shortEnabled ? 'ON' : 'OFF'}`],
      ['Open at End', x.openPositions.length ? x.openPositions.map((p) => `${p.symbol.replace('USDT', '')} ${p.side} ${wonS(p.unrealized)}`).join(' · ') : 'none'],
      ...(x.notes.length ? [['Notes', `<span class="warn">${x.notes.map(esc).join('<br>')}</span>`]] : [])] : []),
  ];
  $('#btMetrics').innerHTML = `<table class="t kv bt-kv"><tbody>${kv.map(([k, v]) => `<tr><td>${k}</td><td class="l">${v}</td></tr>`).join('')}</tbody></table>`;
  $('#btSyms').innerHTML = x ? x.symbols.map((s) => `<button class="btn small ${s === B.sym ? 'primary' : 'ghost'}" data-sym="${s}">${s}</button>`).join(' ') : '<span class="muted">select a strategy row</span>';
  renderTrades();
  loadCandles();
}

function renderTrades() {
  const x = cur();
  const list = x ? x.trades : B.res.results.flatMap((r) => r.trades);
  const rows = list.map((t, i) => ({ t, i })).filter(({ t }) => !x || t.symbol === B.sym || !B.sym).reverse();
  $('#btTrTitle').textContent = x ? `${SHORT[x.strategy]} ${B.sym || ''} · ${rows.length} trades (click → chart)` : `${rows.length} trades`;
  $('#btTrades').innerHTML = rows.length ? `<table class="t"><thead><tr><th>Strategy</th><th>Symbol</th><th>Side</th><th>Entry Time</th><th>Entry</th><th>Exit Time</th><th>Exit</th><th>Size</th><th>Stop</th><th>Gross</th><th>Fees</th><th>Funding</th><th>Net</th><th>Return</th><th class="l">Exit Reason</th></tr></thead><tbody>
    ${rows.map(({ t, i }) => `<tr data-i="${i}"><td class="l">${SHORT[t.strategy]}</td><td class="l">${t.symbol}</td><td class="l side-${t.side}">${t.side}</td><td>${fDateTime(t.entryTime)}</td><td>${px(t.entryPrice)}</td><td>${fDateTime(t.exitTime)}</td><td>${px(t.exitPrice)}</td>
      <td>${won(t.notional)}</td><td class="muted">${t.stopPrice ? px(t.stopPrice) : 'OFF'}</td><td class="${cls(t.gross)}">${wonS(t.gross)}</td><td class="down">${wonS(-t.fees)}</td><td class="${cls(t.funding)}">${wonS(t.funding)}</td>
      <td class="${cls(t.net)}"><b>${wonS(t.net)}</b></td><td class="${cls(t.returnPct)}">${fPct(t.returnPct)}</td><td class="l ${t.reason === 'STRATEGY_EXIT' ? 'muted' : 'down'}">${t.reason}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No trades in the period</div>';
}
const px = (v) => (v >= 1000 ? fNum(v, 1) : v >= 10 ? fNum(v, 2) : fNum(v, 4));

async function loadCandles() {
  const x = cur();
  if (!x || !B.sym) { B.candle.setData([]); B.markers.setMarkers([]); return; }
  const rows = await api('GET', `/api/backtest/candles?symbol=${B.sym}&tf=${x.timeframe}`);
  const data = dedup((Array.isArray(rows) ? rows : []).map((c) => ({ time: toT(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
  B.candle.setData(data);
  B.cChart.applyOptions({ timeScale: { timeVisible: x.timeframe === '4h' } });
  const mk = [];
  for (const t of x.trades.filter((t) => t.symbol === B.sym)) {
    const L = t.side === 'LONG';
    mk.push({ time: toT(t.entryTime), position: L ? 'belowBar' : 'aboveBar', shape: L ? 'arrowUp' : 'arrowDown', color: L ? '#0ecb81' : '#f6465d', text: `${L ? 'L' : 'S'} ${px(t.entryPrice)}` });
    mk.push({ time: toT(t.exitTime), position: L ? 'aboveBar' : 'belowBar', shape: 'circle', color: t.net >= 0 ? '#3d8bfd' : '#f0b90b', text: `${t.reason === 'STRATEGY_EXIT' ? 'X' : t.reason.replace('_STOP', ' STOP')} ${fPct(t.returnPct, 1)}` });
  }
  for (const p of x.openPositions.filter((p) => p.symbol === B.sym)) mk.push({ time: toT(p.entryTime), position: p.side === 'LONG' ? 'belowBar' : 'aboveBar', shape: p.side === 'LONG' ? 'arrowUp' : 'arrowDown', color: '#c77dff', text: `${p.side[0]} open` });
  mk.sort((a, b) => a.time - b.time);
  B.markers.setMarkers(mk);
  B.cChart.timeScale().fitContent();
}

function focusTrade(i) {
  const x = cur();
  const list = x ? x.trades : B.res.results.flatMap((r) => r.trades);
  const t = list[i];
  if (!t) return;
  if (!x) { select(t.strategy); B.sym = t.symbol; renderDetail(); }
  else if (t.symbol !== B.sym) { B.sym = t.symbol; renderDetail(); }
  const pad = (t.exitTime - t.entryTime) * 0.6 + 5 * 86_400_000;
  setTimeout(() => B.cChart.timeScale().setVisibleRange({ from: toT(t.entryTime - pad), to: toT(t.exitTime + pad) }), 300);
}

function dedup(arr) { const out = []; for (const p of arr) { if (out.length && out.at(-1).time >= p.time) out[out.length - 1] = p; else out.push(p); } return out; }

function initCharts() {
  const base = { autoSize: true, localization: { locale: 'en-US' }, layout: { background: { type: 'solid', color: '#0b0e11' }, textColor: '#8b949e', fontSize: 11 },
    grid: { vertLines: { color: '#141920' }, horzLines: { color: '#141920' } }, rightPriceScale: { borderColor: '#222933' }, timeScale: { borderColor: '#222933' } };
  B.eqChart = LC.createChart($('#btEq'), base);
  B.eqS = B.eqChart.addSeries(LC.LineSeries, { color: '#f0b90b', lineWidth: 2, title: 'Strategy', priceFormat: { type: 'price', precision: 0, minMove: 1 } });
  B.bhS = B.eqChart.addSeries(LC.LineSeries, { color: '#5b6472', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, title: 'Buy & Hold', priceFormat: { type: 'price', precision: 0, minMove: 1 } });
  B.cChart = LC.createChart($('#btCandle'), { ...base, timeScale: { ...base.timeScale, timeVisible: true } });
  B.candle = B.cChart.addSeries(LC.CandlestickSeries, { upColor: '#0ecb81', downColor: '#f6465d', borderVisible: false, wickUpColor: '#0ecb81', wickDownColor: '#f6465d' });
  B.markers = LC.createSeriesMarkers(B.candle, []);
}
