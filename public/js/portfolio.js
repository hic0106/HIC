// PORTFOLIO screen: real account (Exchange View) + strategy attribution (Strategy View).
// Data: WS 'portfolio' pushes (on every fill / close / account update, else every 2 s) + /api/portfolio/equity.
import { $, $$, esc, fUsd, fSigned, fPct, fNum, fPrice, fDur, fZone, cls, api } from './util.js';
import { ST_COLOR } from './chart.js';

const LC = window.LightweightCharts;
const SYM_COLOR = { BTCUSDT: '#f7931a', ETHUSDT: '#627eea', XRPUSDT: '#9aa4b1', QQQUSDT: '#26c6da', CASH: '#2b3440' };
const CLASS_COLOR = { CRYPTO: '#f0b90b', TRADFI_INDEX: '#26c6da', CASH: '#2b3440' };
const SHORT = { TURTLE: 'TURTLE', ADX: 'ADX', TSMOM: 'TSMOM', QQQ_EMA_TREND: 'QQQ EMA', QQQ_TSMOM: 'QQQ TSMOM', QQQ_SMA200: 'QQQ SMA200', QQQ_TURTLE_50_20: 'QQQ T50/20', UNATTRIBUTED: 'UNATTRIBUTED' };
const TZ = -new Date().getTimezoneOffset() * 60;

const P = {
  root: null, data: null, meta: null, range: localGet('pfRange', '1M'), overlay: localGet('pfOverlay', '0') === '1',
  period: 'TODAY', group: 'byStrategy', filter: { cls: 'ALL', side: 'ALL', st: 'ALL' }, sort: { k: 'positionValue', dir: -1 },
  chart: null, series: null, stratSeries: {}, lastCurve: 0,
};
function localGet(k, d) { try { return localStorage.getItem(`hic.${k}`) ?? d; } catch { return d; } }
function localSet(k, v) { try { localStorage.setItem(`hic.${k}`, v); } catch { /* ignore */ } }

export function mountPortfolio(root, meta) {
  P.meta = meta;
  if (P.root === root) { loadCurve(); return; }
  P.root = root;
  root.innerHTML = `
    <div id="pfWarn"></div>
    <div class="pf-summary" id="pfSummary"></div>
    <div class="pf-row two">
      <div class="pf-card"><div class="panel-h">EQUITY CURVE <span class="pf-tools"><span class="seg" id="pfRange">${['1D', '7D', '1M', '3M', 'ALL'].map((r) => `<button data-r="${r}" class="${r === P.range ? 'on' : ''}">${r}</button>`).join('')}</span>
        <label class="muted"><input type="checkbox" id="pfOverlay" ${P.overlay ? 'checked' : ''}> strategy PnL overlay</label></span></div>
        <div id="pfCurve"></div><div class="pf-dd" id="pfDd"></div></div>
      <div class="pf-card"><div class="panel-h">ASSET ALLOCATION <span class="muted">margin share of equity</span></div><div id="pfAlloc"></div></div>
    </div>
    <div class="pf-row two">
      <div class="pf-card"><div class="panel-h">LONG / SHORT EXPOSURE <span class="muted">short = short exposure (not a negative asset)</span></div><div id="pfExpo"></div></div>
      <div class="pf-card"><div class="panel-h">STRATEGY ALLOCATION <span class="muted">Strategy View · attribution of the bot ledger</span></div><div id="pfStrat"></div></div>
    </div>
    <div class="pf-row two">
      <div class="pf-card"><div class="panel-h">EXCHANGE VIEW <span class="muted" id="pfExSrc"></span></div><div id="pfExchange"></div></div>
      <div class="pf-card"><div class="panel-h">RECONCILIATION <span class="muted">exchange (truth) vs strategy ledger · never auto-fixed</span></div><div id="pfRecon"></div></div>
    </div>
    <div class="pf-card"><div class="panel-h">ALL POSITIONS <span class="pf-tools" id="pfPosFilter">
        <span class="seg" data-f="cls">${['ALL', 'CRYPTO', 'TRADFI'].map((x) => `<button data-v="${x}" class="${x === 'ALL' ? 'on' : ''}">${x}</button>`).join('')}</span>
        <span class="seg" data-f="side">${['ALL', 'LONG', 'SHORT'].map((x) => `<button data-v="${x}" class="${x === 'ALL' ? 'on' : ''}">${x}</button>`).join('')}</span>
        <span class="seg" data-f="st">${['ALL', 'TURTLE', 'ADX', 'TSMOM', 'QQQ'].map((x) => `<button data-v="${x}" class="${x === 'ALL' ? 'on' : ''}">${x}</button>`).join('')}</span></span></div>
      <div id="pfPositions"></div></div>
    <div class="pf-row two">
      <div class="pf-card"><div class="panel-h">PNL BREAKDOWN <span class="pf-tools"><span class="seg" id="pfPeriod">${['TODAY', '7D', '30D', 'ALL'].map((x) => `<button data-v="${x}" class="${x === P.period ? 'on' : ''}">${x}</button>`).join('')}</span>
        <span class="seg" id="pfGroup">${[['bySymbol', 'SYMBOL'], ['byStrategy', 'STRATEGY'], ['byClass', 'ASSET CLASS']].map(([k, l]) => `<button data-v="${k}" class="${k === P.group ? 'on' : ''}">${l}</button>`).join('')}</span></span></div><div id="pfPnl"></div></div>
      <div class="pf-card"><div class="panel-h">GROSS PNL · FEES · FUNDING · NET</div><div id="pfCosts"></div></div>
    </div>`;
  $('#pfRange', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; P.range = b.dataset.r; localSet('pfRange', P.range); $$('#pfRange button', root).forEach((x) => x.classList.toggle('on', x === b)); loadCurve(); };
  $('#pfOverlay', root).onchange = (e) => { P.overlay = e.target.checked; localSet('pfOverlay', P.overlay ? '1' : '0'); loadCurve(); };
  $('#pfPeriod', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; P.period = b.dataset.v; $$('#pfPeriod button', root).forEach((x) => x.classList.toggle('on', x === b)); renderPnl(); };
  $('#pfGroup', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; P.group = b.dataset.v; $$('#pfGroup button', root).forEach((x) => x.classList.toggle('on', x === b)); renderPnl(); };
  $('#pfPosFilter', root).onclick = (e) => {
    const b = e.target.closest('button'); const seg = e.target.closest('.seg'); if (!b || !seg) return;
    P.filter[seg.dataset.f] = b.dataset.v; $$('button', seg).forEach((x) => x.classList.toggle('on', x === b)); renderPositions();
  };
  $('#pfPositions', root).addEventListener('click', (e) => {
    const th = e.target.closest('th[data-k]'); if (!th) return;
    P.sort = { k: th.dataset.k, dir: P.sort.k === th.dataset.k ? -P.sort.dir : -1 }; renderPositions();
  });
  initChart();
  loadCurve();
  if (P.data) update(P.data);
}

export function update(d) {
  P.data = d;
  if (!P.root || !P.root.isConnected || P.root.offsetParent === null || d.error) return;
  renderSummary(); renderAlloc(); renderExpo(); renderStrat(); renderExchange(); renderRecon(); renderPositions(); renderPnl(); renderCosts();
  if (Date.now() - P.lastCurve > 60_000) loadCurve();
}

const kpi = (label, value, c = '', sub = '', xl = false) => `<div class="pf-kpi ${xl ? 'xl' : ''}"><label>${label}</label><div class="${c}">${value}</div>${sub ? `<small>${sub}</small>` : ''}</div>`;

function renderSummary() {
  const d = P.data, s = d.summary;
  const warn = d.reconciliation && !d.reconciliation.ok;
  $('#pfWarn').innerHTML = warn ? `<div class="pf-banner"><b>RECONCILIATION WARNING · POSITION MISMATCH</b> ${d.reconciliation.warnings.map(esc).join(' · ')} <span class="muted">— exchange position differs from the strategy ledger (manual trade / external change). Nothing is hidden or auto-corrected.</span></div>` : '';
  const ctl = d.controllerMode && d.controllerMode !== 'OFF' ? `<span class="tag OFF" title="Controller only scales new entry sizes">CTRL ${esc(d.controllerMode)}</span>` : '';
  $('#pfSummary').innerHTML = [
    kpi('Total Equity <i>USDT</i>', fUsd(s.equity), '', d.exchange.live ? `LIVE · Binance ${esc(d.exchange.source)}` : 'PAPER · simulated', true),
    kpi("Today's PnL <i>UTC 00:00</i>", fSigned(s.todayPnl), cls(s.todayPnl), s.baseCapital ? fPct(s.todayPnl / s.baseCapital * 100) : '', true),
    kpi('Total Return', s.totalReturnPct != null ? fPct(s.totalReturnPct) : '—', cls(s.totalReturnPct), s.baseCapital ? `base ${fUsd(s.baseCapital, 0)}` : 'base not set', true),
    kpi('Available', fUsd(s.available)), kpi('Total Invested', fUsd(s.invested), '', 'entry value'), kpi('Position Value', fUsd(s.positionValue), '', 'mark value'),
    kpi('Unrealized PnL', fSigned(s.unrealized), cls(s.unrealized), 'exchange'), kpi('Realized Today', fSigned(s.realizedToday), cls(s.realizedToday), s.realizedTodaySource === 'BINANCE_INCOME' ? 'Binance income' : 'ledger'),
    kpi('Total PnL', fSigned(s.totalPnl), cls(s.totalPnl), 'net of fees/funding'),
    kpi('Drawdown', d.drawdown.currentPct != null ? `−${d.drawdown.currentPct.toFixed(2)}%` : '—', d.drawdown.currentPct > 0 ? 'down' : '', d.drawdown.maxPct != null ? `max −${d.drawdown.maxPct.toFixed(2)}%` : 'no history'),
    `<div class="pf-kpi badge">${ctl}<small>${fZone(d.ts)}</small></div>`,
  ].join('');
}

function donut(parts) {
  const total = parts.reduce((a, p) => a + p.v, 0) || 1;
  let off = 0;
  const R = 52, C = 2 * Math.PI * R;
  const segs = parts.filter((p) => p.v > 0).map((p) => { const len = (p.v / total) * C; const s = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${p.c}" stroke-width="20" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}"/>`; off += len; return s; }).join('');
  return `<svg viewBox="0 0 140 140" class="pf-donut"><g transform="rotate(-90 70 70)">${segs}</g></svg>`;
}

function renderAlloc() {
  const a = P.data.allocation;
  const items = [...a.bySymbol.map((x) => ({ k: x.symbol, label: x.symbol.replace('USDT', ''), v: x.margin, pct: x.pct, notional: x.notional, c: SYM_COLOR[x.symbol] })), { k: 'CASH', label: 'CASH', v: a.cash, pct: a.cashPct, c: SYM_COLOR.CASH }];
  const cl = a.byClass;
  const bar = (k, v) => `<div class="pf-bar"><span style="width:${Math.max(0, Math.min(100, v || 0))}%;background:${CLASS_COLOR[k]}"></span></div>`;
  $('#pfAlloc').innerHTML = `<div class="pf-alloc">${donut(items)}
    <table class="t compact"><thead><tr><th>Asset</th><th>Margin</th><th>Notional</th><th>%</th><th></th></tr></thead><tbody>
    ${items.map((x) => `<tr><td><i class="sw-dot" style="background:${x.c}"></i>${x.label}</td><td>${fNum(x.v, 2)}</td><td>${x.notional != null ? fNum(x.notional, 2) : ''}</td><td>${x.pct != null ? x.pct.toFixed(1) + '%' : '—'}</td><td class="l" style="width:34%"><div class="pf-bar"><span style="width:${Math.max(0, Math.min(100, x.pct || 0))}%;background:${x.c}"></span></div></td></tr>`).join('')}
    </tbody></table></div>
    <table class="t compact"><tbody>${[['CRYPTO', 'CRYPTO'], ['TRADFI_INDEX', 'TRADFI'], ['CASH', 'CASH']].map(([k, l]) => `<tr><td style="width:80px">${l}</td><td style="width:90px">${fNum(cl[k]?.margin, 2)}</td><td style="width:60px">${cl[k]?.pct != null ? cl[k].pct.toFixed(1) + '%' : '—'}</td><td class="l">${bar(k, cl[k]?.pct)}</td></tr>`).join('')}</tbody></table>`;
}

function renderExpo() {
  const x = P.data.exposure;
  const max = Math.max(x.grossLong, x.grossShort, Math.abs(x.net), 1);
  const line = (l, v, c) => `<div class="pf-exp"><label>${l}</label><div class="pf-bar"><span style="width:${(Math.abs(v) / max) * 100}%;background:${c}"></span></div><b class="${l === 'NET' ? cls(v) : ''}">${l === 'NET' ? fSigned(v) : fUsd(v)}</b></div>`;
  const rows = Object.entries(x.bySymbol).filter(([, b]) => b.rows.length).map(([sym, b]) => `<tr class="grp"><td>${sym.replace('USDT', '')}</td><td class="up">${fNum(b.long, 2)}</td><td class="down">${fNum(b.short, 2)}</td><td>${fNum(b.gross, 2)}</td><td class="${cls(b.net)}">${fSigned(b.net)}</td></tr>
    ${b.rows.map((r) => `<tr><td class="l" style="padding-left:18px">${SHORT[r.strategy] || r.strategy} <span class="side-${r.side}">${r.side}</span></td><td colspan="3"></td><td class="${cls(r.value)}">${fSigned(r.value)}</td></tr>`).join('')}`).join('');
  $('#pfExpo').innerHTML = `${line('GROSS LONG', x.grossLong, 'var(--up)')}${line('GROSS SHORT', x.grossShort, 'var(--down)')}${line('NET', x.net, 'var(--info)')}
    <div class="muted" style="padding:2px 10px 4px">Gross ${fUsd(x.gross)} · Crypto L ${fNum(x.byClass.CRYPTO.long, 0)} / S ${fNum(x.byClass.CRYPTO.short, 0)} · TradFi L ${fNum(x.byClass.TRADFI_INDEX.long, 0)} / S ${fNum(x.byClass.TRADFI_INDEX.short, 0)}</div>
    ${rows ? `<table class="t compact"><thead><tr><th>Coin / Strategy</th><th>Long</th><th>Short</th><th>Gross</th><th>Net</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No exposure</div>'}`;
}

function renderStrat() {
  const d = P.data;
  let last = null;
  const rows = d.strategyView.map((s) => { const g = s.assetClass !== last ? `<tr class="grp"><td colspan="9">${s.assetClass === 'CRYPTO' ? 'CRYPTO' : 'TRADFI · QQQ'}</td></tr>` : ''; last = s.assetClass; return g + `<tr class="${s.enabled || s.positions ? '' : 'dim'}">
    <td class="l"><i class="sw-dot" style="background:${ST_COLOR[s.strategy]}"></i><b>${SHORT[s.strategy]}</b>${s.ctrlMultipliers.some((m) => m !== 1) ? ` <span class="tag PENDING" title="controller multiplier on open entries">×${s.ctrlMultipliers.join('/')}</span>` : ''}</td>
    <td>${s.positions}</td><td>${fNum(s.invested, 2)}</td><td>${fNum(s.positionValue, 2)}</td><td class="up">${fNum(s.long, 0)}</td><td class="down">${fNum(s.short, 0)}</td>
    <td class="${cls(s.unrealized)}">${fSigned(s.unrealized)}</td><td class="${cls(s.realizedToday)}">${fSigned(s.realizedToday)}</td><td class="${cls(s.realizedTotal)}">${fSigned(s.realizedTotal)}</td></tr>`; }).join('');
  const t = (k) => d.strategyView.reduce((a, s) => a + s[k], 0);
  $('#pfStrat').innerHTML = `<table class="t compact"><thead><tr><th>Strategy</th><th>Pos</th><th>Invested</th><th>Value</th><th>Long</th><th>Short</th><th>Unrealized</th><th>Realized Today</th><th>Realized All</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><td>TOTAL</td><td>${t('positions')}</td><td>${fNum(t('invested'), 2)}</td><td>${fNum(t('positionValue'), 2)}</td><td class="up">${fNum(t('long'), 0)}</td><td class="down">${fNum(t('short'), 0)}</td><td class="${cls(t('unrealized'))}">${fSigned(t('unrealized'))}</td><td class="${cls(t('realizedToday'))}">${fSigned(t('realizedToday'))}</td><td class="${cls(t('realizedTotal'))}">${fSigned(t('realizedTotal'))}</td></tr>
    ${d.unattributedValue ? `<tr><td colspan="9" class="l warn">+ UNATTRIBUTED exchange positions ${fUsd(d.unattributedValue)} (not in any strategy)</td></tr>` : ''}</tfoot></table>`;
}

function renderExchange() {
  const e = P.data.exchange;
  const f = (sym) => P.data._filters?.[sym];
  $('#pfExSrc').textContent = e.live ? `Binance · ${e.source}${e.stream ? ' · User Stream ' + e.stream : ''}${e.updatedAt ? ' · ' + fZone(e.updatedAt) : ''}` : e.source;
  $('#pfExchange').innerHTML = `<table class="t compact kv pf-kv"><tbody>
      <tr><td>Wallet Balance</td><td>${fUsd(e.wallet)}</td><td>Margin Balance (Equity)</td><td>${fUsd(e.marginBalance)}</td></tr>
      <tr><td>Available Balance</td><td>${fUsd(e.available)}</td><td>Unrealized PnL</td><td class="${cls(e.unrealized)}">${fSigned(e.unrealized)}</td></tr>
      ${e.error ? `<tr><td colspan="4" class="l down">${esc(e.error)}</td></tr>` : ''}</tbody></table>
    ${e.positions.length ? `<table class="t compact"><thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th><th>Notional</th><th>Margin</th><th>Unrealized</th><th>Liq. Price</th><th>Lev</th></tr></thead><tbody>
      ${e.positions.map((p) => `<tr><td class="l">${p.symbol}</td><td class="l side-${p.side}">${p.side}</td><td>${p.qty}</td><td>${fPrice(p.entryPrice, f(p.symbol))}</td><td>${fPrice(p.markPrice, f(p.symbol))}</td><td>${fNum(p.notional, 2)}</td><td>${fNum(p.initialMargin, 2)}</td><td class="${cls(p.unrealized)}">${fSigned(p.unrealized)}</td><td>${p.liquidationPrice ? fPrice(p.liquidationPrice, f(p.symbol)) : '—'}</td><td>${p.leverage ? p.leverage + 'x' : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No exchange positions</div>'}`;
}

function renderRecon() {
  const r = P.data.reconciliation;
  if (r.na === 'PAPER') { $('#pfRecon').innerHTML = '<div class="empty">PAPER mode — the internal ledger is the account (no exchange to reconcile)</div>'; return; }
  if (r.na === 'NO_SNAPSHOT') { $('#pfRecon').innerHTML = '<div class="empty">Waiting for the first Binance snapshot…</div>'; return; }
  $('#pfRecon').innerHTML = `<div class="pf-recon ${r.ok ? 'ok' : 'bad'}">${r.ok ? '● RECONCILED — exchange positions match strategy ledger' : '● POSITION MISMATCH'} <span class="muted">${r.checkedAt ? fZone(r.checkedAt) : ''}</span></div>
    ${r.rows.length ? `<table class="t compact"><thead><tr><th>Symbol</th><th>Side</th><th>Exchange Qty</th><th>Internal Qty</th><th>Diff</th><th>Status</th></tr></thead><tbody>
    ${r.rows.map((x) => `<tr><td class="l">${x.symbol}</td><td class="l side-${x.side}">${x.side}</td><td>${x.exchangeQty}</td><td>${x.internalQty}</td><td class="${x.diff ? 'warn' : ''}">${x.diffText}</td><td class="${x.status === 'OK' ? 'up' : x.status === 'SYNCING' ? 'warn' : 'down'}"><b>${x.status}</b></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No positions on exchange or ledger</div>'}`;
}

function renderPositions() {
  const d = P.data;
  const F = P.filter;
  let rows = d.positions.filter((p) => (F.cls === 'ALL' || (F.cls === 'CRYPTO' ? p.assetClass === 'CRYPTO' : p.assetClass === 'TRADFI_INDEX'))
    && (F.side === 'ALL' || p.side === F.side) && (F.st === 'ALL' || (F.st === 'QQQ' ? p.strategy.startsWith('QQQ_') : p.strategy === F.st)));
  const k = P.sort.k;
  rows = rows.slice().sort((a, b) => { const va = a[k] ?? -Infinity, vb = b[k] ?? -Infinity; return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * P.sort.dir; });
  const f = (sym) => d._filters?.[sym];
  const cols = [['assetClass', 'Class'], ['strategy', 'Strategy'], ['symbol', 'Symbol'], ['side', 'Side'], ['leverage', 'Lev'], ['entryPrice', 'Entry'], ['markPrice', 'Mark'], ['qty', 'Qty'], ['positionValue', 'Value'], ['margin', 'Margin'], ['unrealized', 'Unrealized'], ['pnlPct', 'PnL %'], ['stopPrice', 'Stop'], ['funding', 'Funding'], ['holdingMs', 'Holding']];
  const arrow = (c) => (c === k ? (P.sort.dir < 0 ? ' ▼' : ' ▲') : '');
  $('#pfPositions').innerHTML = rows.length ? `<table class="t"><thead><tr>${cols.map(([c, l]) => `<th data-k="${c}" class="sortable ${['assetClass', 'strategy', 'symbol', 'side'].includes(c) ? 'l' : ''}">${l}${arrow(c)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((p) => `<tr class="${p.attributed ? '' : 'unattr'}" title="${esc(p.note || '')}"><td class="l">${p.assetClass === 'CRYPTO' ? 'CRYPTO' : 'TRADFI'}</td><td class="l"><b>${SHORT[p.strategy] || p.strategy}</b>${p.ctrlMultiplier != null && p.ctrlMultiplier !== 1 ? ` <span class="tag PENDING">×${p.ctrlMultiplier}</span>` : ''}</td><td class="l">${p.symbol}</td><td class="l side-${p.side}">${p.side}</td>
      <td>${p.leverage ? p.leverage + 'x' : '—'}</td><td>${fPrice(p.entryPrice, f(p.symbol))}</td><td>${fPrice(p.markPrice, f(p.symbol))}</td><td>${p.qty}</td><td>${fNum(p.positionValue, 2)}</td><td>${fNum(p.margin, 2)}</td>
      <td class="${cls(p.unrealized)}">${fSigned(p.unrealized)}</td><td class="${cls(p.pnlPct)}">${p.pnlPct != null ? fPct(p.pnlPct) : '—'}</td>
      <td class="down">${p.stopPrice ? fPrice(p.stopPrice, f(p.symbol)) : p.attributed ? 'OFF' : '—'}${p.exStop ? ` <span class="tag ${p.exStop === 'NEW' ? 'LONG' : 'PENDING'}">EX</span>` : ''}</td>
      <td class="${cls(p.funding)}">${p.funding != null ? fNum(p.funding, 4) : '—'}</td><td>${p.holdingMs != null ? fDur(p.holdingMs) : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No positions</div>';
}

function renderPnl() {
  const d = P.data;
  if (!d) return;
  const per = d.pnl[P.period];
  const g = per[P.group];
  const label = (k) => (P.group === 'byStrategy' ? SHORT[k] || k : P.group === 'byClass' ? (k === 'CRYPTO' ? 'CRYPTO' : 'TRADFI') : k);
  const rows = Object.entries(g).sort((a, b) => b[1].net - a[1].net).map(([k, v]) => `<tr><td class="l"><b>${label(k)}</b></td><td>${v.trades}</td><td class="${cls(v.gross)}">${fSigned(v.gross)}</td><td class="down">${fNum(-v.fees, 4)}</td><td class="${cls(v.funding)}">${fNum(v.funding, 4)}</td><td class="${cls(v.realized)}">${fSigned(v.realized)}</td><td class="${cls(v.unrealized)}">${fSigned(v.unrealized)}</td><td class="${cls(v.net)}"><b>${fSigned(v.net)}</b></td></tr>`).join('');
  const t = per.total;
  const ex = d.exchangeIncome?.[P.period];
  $('#pfPnl').innerHTML = `<table class="t compact"><thead><tr><th>${P.group === 'bySymbol' ? 'Symbol' : P.group === 'byStrategy' ? 'Strategy' : 'Asset Class'}</th><th>Trades</th><th>Gross</th><th>Fees</th><th>Funding</th><th>Realized (net)</th><th>Unrealized (open)</th><th>Net</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8" class="l muted">No trades / positions</td></tr>'}</tbody>
    <tfoot><tr><td>TOTAL ${P.period}</td><td>${t.trades}</td><td class="${cls(t.gross)}">${fSigned(t.gross)}</td><td class="down">${fNum(-t.fees, 4)}</td><td>${fNum(t.funding, 4)}</td><td class="${cls(t.realized)}">${fSigned(t.realized)}</td><td></td><td></td></tr>
    ${ex ? `<tr><td class="l">BINANCE INCOME</td><td></td><td class="${cls(ex.realized)}">${fSigned(ex.realized)}</td><td class="down">${fNum(ex.commission, 4)}</td><td>${fNum(ex.funding, 4)}</td><td class="${cls(ex.net)}">${fSigned(ex.net)}</td><td colspan="2" class="l muted">exchange record (all trades incl. manual)</td></tr>` : ''}</tfoot></table>
    <div class="muted" style="padding:4px 10px">Realized = trades closed in the period (net of entry+exit fees and funding). Unrealized = currently open positions.</div>`;
}

function renderCosts() {
  const c = P.data.costs;
  const row = (l, v, c2) => `<tr><td>${l}</td><td class="${c2 ?? cls(v)}">${fSigned(v)}</td></tr>`;
  $('#pfCosts').innerHTML = `<table class="t kv pf-costs"><tbody>${row('Gross PnL (price move)', c.gross)}${row('Fees (entry + exit)', -c.fees, 'down')}${row('Funding (net received)', c.funding)}<tr class="grp"><td>NET PNL</td><td class="${cls(c.net)}"><b>${fSigned(c.net)}</b></td></tr></tbody></table>
    <div class="muted" style="padding:6px 10px">All closed trades + open positions of the ${P.data.mode} ledger. Slippage is inside the fill prices.</div>`;
}

// ---------- equity curve
function initChart() {
  const el = $('#pfCurve');
  if (!LC || !el) return;
  P.chart = LC.createChart(el, {
    autoSize: true, localization: { locale: 'en-US' },
    layout: { background: { type: 'solid', color: '#0b0e11' }, textColor: '#8b949e', fontSize: 11 },
    grid: { vertLines: { color: '#141920' }, horzLines: { color: '#141920' } },
    rightPriceScale: { borderColor: '#222933' }, leftPriceScale: { visible: false, borderColor: '#222933' },
    timeScale: { borderColor: '#222933', timeVisible: true, secondsVisible: false },
  });
  P.series = P.chart.addSeries(LC.AreaSeries, { lineColor: '#f0b90b', topColor: 'rgba(240,185,11,.25)', bottomColor: 'rgba(240,185,11,0)', lineWidth: 2, title: 'Equity' });
}

async function loadCurve() {
  if (!P.chart) return;
  P.lastCurve = Date.now();
  const r = await api('GET', `/api/portfolio/equity?range=${P.range}`);
  if (!r || !Array.isArray(r.points)) return;
  const dedup = (arr) => { const out = []; for (const p of arr) { if (out.length && out.at(-1).time >= p.time) out[out.length - 1] = p; else out.push(p); } return out; };
  P.series.setData(dedup(r.points.map((p) => ({ time: Math.floor(p.t / 1000) + TZ, value: p.equity }))));
  for (const s of Object.values(P.stratSeries)) P.chart.removeSeries(s);
  P.stratSeries = {};
  if (P.overlay) {
    P.chart.applyOptions({ leftPriceScale: { visible: true } });
    for (const st of r.strategies) {
      const pts = r.points.filter((p) => p.strat && p.strat[st] != null);
      if (!pts.some((p) => Math.abs(p.strat[st]) > 1e-9)) continue;
      const s = P.chart.addSeries(LC.LineSeries, { color: ST_COLOR[st] || '#888', lineWidth: 1, priceScaleId: 'left', title: SHORT[st], priceLineVisible: false, lastValueVisible: false });
      s.setData(dedup(pts.map((p) => ({ time: Math.floor(p.t / 1000) + TZ, value: p.strat[st] }))));
      P.stratSeries[st] = s;
    }
  } else P.chart.applyOptions({ leftPriceScale: { visible: false } });
  P.chart.timeScale().fitContent();
  const dd = P.data?.drawdown;
  $('#pfDd').innerHTML = `${r.points.length} samples (${P.range}) · Current DD <b class="${dd?.currentPct > 0 ? 'down' : ''}">${dd?.currentPct != null ? '−' + dd.currentPct.toFixed(2) + '%' : '—'}</b> · Max DD <b class="down">${dd?.maxPct != null ? '−' + dd.maxPct.toFixed(2) + '%' : '—'}</b> <span class="muted">from stored account equity, deposits/withdrawals excluded${P.overlay ? ' · left axis: cumulative strategy PnL' : ''}</span>`;
}
