// CONTROLLER tab: Self-Improving Controller dashboard, approvals, shadow comparison, history, settings.
import { $, $$, esc, api, toast, fNum, fSigned, fDateTime, cls } from './util.js';
import { confirmDialog } from './modals.js';

const LC = window.LightweightCharts;
const MODES = [['OFF', 'OFF'], ['OBSERVE', 'OBSERVE'], ['PAPER_AUTO', 'PAPER AUTO'], ['LIVE_APPROVAL', 'LIVE APPROVAL']];
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)}%`);
const n2 = (x) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(2));
const statusCls = (s) => ({ BOOSTED: 'LONG', NORMAL: 'WAIT', CAUTIOUS: 'PENDING', REDUCED: 'SHORT', PAUSED: 'OFF', FAIL_SAFE: 'UNKNOWN' }[s] || 'WAIT');
export const statusTag = (s, m) => `<span class="tag ${statusCls(s)}">${esc(s)}${m != null ? ` ${Number(m).toFixed(2)}×` : ''}</span>`;
const REGIME_CLS = { BULL_TREND: 'LONG', BEAR_TREND: 'SHORT', HIGH_VOLATILITY: 'UNKNOWN', SIDEWAYS: 'PENDING', NORMAL: 'WAIT' };
export const regimeTag = (r) => (r ? `<span class="tag ${REGIME_CLS[r] || 'WAIT'}">${r.replace('_', ' ')}</span>` : '<span class="tag WAIT">—</span>');

let D = null; // last detail
let chart = null, sBase = null, sCtl = null, markersApi = null;
const CLASS_LABEL = { CRYPTO: 'CRYPTO', TRADFI_INDEX: 'TRADFI' };
let built = false, settingsDirty = false, timer = null;

export function controllerHeaderHtml(c) {
  if (!c) return '';
  const fs = c.failSafe ? ' <span class="tag UNKNOWN">FAIL SAFE</span>' : '';
  const tr = c.regimes?.TRADFI_INDEX;
  return `CONTROLLER <b class="${c.mode === 'OFF' ? 'muted' : 'warn'}">${c.mode.replace('_', ' ')}</b>${fs} · C ${regimeTag(c.regime)}${tr ? ` T ${regimeTag(tr)}` : ''}${c.pending ? ` · <span class="warn">${c.pending} pending</span>` : ''}`;
}

export function mountController(root) {
  if (!built) build(root);
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 5000);
}
export function unmountController() { clearInterval(timer); timer = null; }

function build(root) {
  root.innerHTML = `
  <div class="ctl-bar">
    <div class="seg" id="ctlMode">${MODES.map(([k, l]) => `<button data-m="${k}">${l}</button>`).join('')}</div>
    <span id="ctlTimes" class="muted"></span>
    <span id="ctlRegime"></span>
    <span id="ctlPendingCnt"></span>
    <span style="flex:1"></span>
    <button class="btn ghost small" id="ctlEval">EVALUATE NOW</button>
    <button class="btn stop small" id="ctlKill">DISABLE CONTROLLER</button>
  </div>
  <div class="ctl-grid">
    <div class="ctl-main">
      <div class="sub-h">STRATEGY CONTROL · base order × multiplier (0 – 1.25) · controller never changes signals, stops, leverage or base amounts</div>
      <div id="ctlTable"></div>
      <div class="sub-h">ASSET CLASS PERFORMANCE (evaluated separately — Crypto and TradFi are not ranked against each other)</div>
      <div id="ctlClass"></div>
      <div id="ctlPending"></div>
      <div class="sub-h">CONTROLLER HISTORY (every decision + reason)</div>
      <div id="ctlHistory"></div>
    </div>
    <div class="ctl-side">
      <div class="sub-h">SHADOW PORTFOLIO · Baseline 1.00× vs Controller (virtual, no orders)</div>
      <div id="ctlShadow"></div>
      <div id="ctlChart"></div>
      <div class="sub-h">MARKET REGIME (rule-based · CRYPTO = BTC · TRADFI = QQQ US sessions)</div>
      <div id="ctlRegimeDetail"></div>
      <div class="sub-h">STRATEGY RETURN CORRELATION (90D)</div>
      <div id="ctlCorr"></div>
      <div class="sub-h">COIN EXPOSURE (current positions)</div>
      <div id="ctlExp"></div>
      <div class="sub-h">CONTROLLER SETTINGS</div>
      <div id="ctlSettings"></div>
    </div>
  </div>`;
  built = true;

  $('#ctlMode').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-m]');
    if (!b || b.dataset.m === D?.mode) return;
    const mode = b.dataset.m;
    let body = { mode };
    if (mode === 'LIVE_APPROVAL') {
      const w = await confirmDialog({ title: 'CONTROLLER · LIVE APPROVAL', danger: true, word: 'LIVE',
        html: '<p>LIVE 계좌에 대해 Controller가 변경을 <b>추천</b>합니다. 승인(APPROVE)한 변경만 LIVE 주문금액에 적용됩니다.</p><p>PAPER 계좌에는 자동 적용됩니다.</p>' });
      if (!w) return;
      body.confirm = 'LIVE';
    }
    if (mode === 'OFF') return kill();
    const r = await api('POST', '/api/controller/mode', body);
    r.ok ? toast(`Controller mode: ${mode}`, 'ok') : toast(r.msg, 'err');
    refresh();
  });
  $('#ctlEval').onclick = async () => {
    const r = await api('POST', '/api/controller/evaluate');
    r.ok ? toast('Controller evaluated', 'ok') : toast(r.msg, 'err');
    refresh();
  };
  $('#ctlKill').onclick = kill;
  root.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-approve]');
    const rj = e.target.closest('[data-reject]');
    if (a) {
      const p = D.pendingList.find((x) => x.id === a.dataset.approve);
      const w = await confirmDialog({ title: 'APPROVE LIVE CONTROLLER CHANGE', danger: true, word: 'APPROVE',
        html: `<p><b>${esc(p.strategy)} ${esc(p.side)}</b> ${esc(p.from)} → <b>${esc(p.to)}</b></p><p>Order multiplier ${p.fromMult.toFixed(2)} → <b>${p.toMult.toFixed(2)}</b> (신규 LIVE 진입부터 적용)</p><p class="muted">${esc(p.reason)}</p>` });
      if (!w) return;
      const r = await api('POST', '/api/controller/approve', { id: p.id, confirm: 'APPROVE' });
      r.ok ? toast('Approved', 'ok') : toast(r.msg, 'err');
      refresh();
    } else if (rj) {
      const r = await api('POST', '/api/controller/reject', { id: rj.dataset.reject });
      r.ok ? toast('Rejected', 'ok') : toast(r.msg, 'err');
      refresh();
    }
  });
}

async function kill() {
  const w = await confirmDialog({ title: 'DISABLE CONTROLLER', danger: true,
    html: '<p>Controller를 즉시 끕니다. 모든 multiplier가 <b>1.00×</b>로 돌아가고 대기 중인 추천은 삭제됩니다.</p><p>Turtle / ADX / TSMOM 전략과 주문 엔진은 그대로 계속 동작합니다.</p>', okText: 'DISABLE CONTROLLER' });
  if (!w) return;
  const r = await api('POST', '/api/controller/disable');
  r.ok ? toast('Controller disabled — all multipliers 1.00×', 'ok') : toast(r.msg, 'err');
  refresh();
}

async function refresh() {
  const d = await api('GET', '/api/controller');
  if (!d || d.ok === false) return;
  D = d;
  $$('#ctlMode button').forEach((b) => b.classList.toggle('on', b.dataset.m === d.mode));
  $('#ctlTimes').textContent = `Last eval ${d.lastEvaluation ? fDateTime(d.lastEvaluation) : '—'} · Next ${d.nextEvaluation ? fDateTime(d.nextEvaluation) : d.mode === 'OFF' ? '—' : 'on next check'} · every ${d.config.reevalDays}D · trading ${d.tradingMode}`;
  $('#ctlRegime').innerHTML = `Regime C ${regimeTag(d.regime)} T ${regimeTag(d.regimes?.TRADFI_INDEX)}${d.failSafe ? ` <span class="tag UNKNOWN" title="${esc(d.failSafe.error)}">FAIL SAFE 1.00×</span>` : ''}`;
  $('#ctlPendingCnt').innerHTML = d.pendingList.length ? `<span class="warn">${d.pendingList.length} Recommendation${d.pendingList.length > 1 ? 's' : ''} Pending</span>` : '';
  renderTable(d);
  renderClass(d);
  renderPending(d);
  renderHistory(d);
  renderShadow(d);
  renderRegime(d);
  renderCorr(d);
  renderExposure(d);
  if (!settingsDirty) renderSettings(d);
}

function renderTable(d) {
  const appliedNote = d.mode === 'OBSERVE' ? 'observe only' : d.mode === 'OFF' ? 'off' : '';
  let lastC = null;
  const rows = d.strategies.map((s) => {
    const m = s.metrics || {};
    const reason = [...s.guards, ...s.reasons].join(' · ');
    const grp = s.assetClass !== lastC ? `<tr class="grp"><td colspan="22">${CLASS_LABEL[s.assetClass] || s.assetClass}</td></tr>` : '';
    lastC = s.assetClass;
    const ch = m.change;
    const chCell = ch ? `<span title="since ${ch.day}: ${pct(ch.retAfter)} (${ch.days}D) · before (same length): ${pct(ch.retBefore)}${m.historyReset ? ' · evaluation uses post-change data only' : ''}"><span class="${cls(ch.retAfter)}">${pct(ch.retAfter)}</span>/${ch.days}D <span class="muted">vs ${pct(ch.retBefore)}</span>${m.historyReset ? ' <span class="tag PENDING">RESET</span>' : ''}</span>` : '<span class="muted">—</span>';
    return grp + `<tr class="${s.active ? '' : 'dim'}">
      <td class="l"><b>${s.strategy}</b>${s.enabled ? '' : ' <span class="tag OFF">DISABLED</span>'}</td><td class="l side-${s.side}">${s.side}</td>
      <td class="l">${s.active ? statusTag(s.recommended, s.recommendedMult) : '<span class="muted">N/A</span>'}</td>
      <td class="l">${s.active ? statusTag(s.applied === 'NOT_APPLIED' || s.applied === 'OFF' ? 'NORMAL' : s.applied, s.appliedMult) : ''}${appliedNote && s.active ? ` <span class="muted">${appliedNote}</span>` : ''}</td>
      <td>${fNum(s.baseAmount, 0)}</td><td><b>${s.active ? fNum(s.actualAmount, 1) : '—'}</b></td>
      <td class="${cls(m.ret30)}">${pct(m.ret30)}</td><td class="${cls(m.ret90)}">${pct(m.ret90)}</td><td class="${cls(m.retStab)}">${pct(m.retStab)}<span class="muted">${m.stabilityWindow && m.stabilityWindow !== 180 ? ` ${m.stabilityWindow}D` : ''}</span></td>
      <td class="down">${pct(m.currentDD)}</td><td class="down">${pct(m.maxDD)}</td>
      <td>${n2(m.sharpe)}</td><td>${n2(m.sortino)}</td><td>${m.profitFactor === 999 ? '∞' : n2(m.profitFactor)}</td>
      <td>${m.winRate != null ? (m.winRate * 100).toFixed(0) + '%' : '—'}</td><td>${m.tradeCount ?? 0}</td><td>${m.consecutiveLosses ?? 0}</td>
      <td>${m.exposure != null ? (m.exposure * 100).toFixed(0) + '%' : '—'}</td><td>${m.historyDays ?? 0}</td>
      <td>${s.score != null ? s.score.toFixed(2) : '—'}</td><td class="l">${chCell}</td>
      <td class="l reason" title="${esc(reason)}">${esc(reason || '—')}</td></tr>`;
  }).join('');
  $('#ctlTable').innerHTML = `<table class="t compact"><thead><tr><th>Strategy</th><th>Side</th><th>Recommended</th><th>Applied (${d.tradingMode})</th><th>Base</th><th>Actual</th>
    <th>30D</th><th>90D</th><th>180D</th><th>Cur DD</th><th>Max DD</th><th>Sharpe</th><th>Sortino</th><th>PF</th><th>Win</th><th>Trades</th><th>Consec L</th><th>Expo</th><th>Hist D</th><th>Score</th><th class="l">Since change</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderClass(d) {
  const cp = d.classPerformance || {};
  $('#ctlClass').innerHTML = `<table class="t compact"><thead><tr><th>Asset Class</th><th>Symbols</th><th>Strategies (enabled)</th><th>Regime</th><th>Baseline PnL</th><th>Controller PnL</th><th>30D</th><th>90D</th><th>180D</th><th>Cur DD</th><th>Max DD</th><th>Sharpe</th><th>Hist D</th></tr></thead><tbody>
    ${Object.entries(cp).map(([c, v]) => { const m = v.metrics || {}; return `<tr><td class="l"><b>${CLASS_LABEL[c] || c}</b></td><td class="l">${v.symbols.map((x) => x.replace('USDT', '')).join(' ')}</td><td class="l">${v.strategies.join(', ') || '—'}</td>
      <td class="l">${regimeTag(v.regime)}</td><td class="${cls(v.baselinePnl)}">${fSigned(v.baselinePnl)}</td><td class="${cls(v.controllerPnl)}">${fSigned(v.controllerPnl)}</td>
      <td class="${cls(m.ret30)}">${pct(m.ret30)}</td><td class="${cls(m.ret90)}">${pct(m.ret90)}</td><td class="${cls(m.retStab)}">${pct(m.retStab)}</td><td class="down">${pct(m.currentDD)}</td><td class="down">${pct(m.maxDD)}</td><td>${n2(m.sharpe)}</td><td>${m.historyDays ?? 0}</td></tr>`; }).join('')}
  </tbody></table>`;
}

function renderPending(d) {
  if (!d.pendingList.length) { $('#ctlPending').innerHTML = ''; return; }
  $('#ctlPending').innerHTML = `<div class="sub-h warn">LIVE RECOMMENDATIONS PENDING APPROVAL (${d.pendingList.length})</div>
    <table class="t compact"><tbody>${d.pendingList.map((p) => `<tr>
      <td class="l"><b>${p.strategy}</b> <span class="side-${p.side}">${p.side}</span></td>
      <td class="l">${statusTag(p.from, p.fromMult)} → ${statusTag(p.to, p.toMult)}</td>
      <td class="l reason" title="${esc(p.reason)}">${esc(p.reason)}</td><td class="muted">${fDateTime(p.createdAt)}</td>
      <td><button class="btn small start" data-approve="${esc(p.id)}">APPROVE</button> <button class="btn small danger" data-reject="${esc(p.id)}">REJECT</button></td></tr>`).join('')}</tbody></table>`;
}

function renderHistory(d) {
  const h = d.history.slice(0, 60);
  if (!h.length) { $('#ctlHistory').innerHTML = '<div class="empty">No controller decisions yet</div>'; return; }
  $('#ctlHistory').innerHTML = `<table class="t compact"><thead><tr><th>Time</th><th>Mode</th><th>Strategy</th><th>Side</th><th>Prev</th><th>New</th><th>Mult</th><th>90D</th><th>Cur DD</th><th>Regime</th><th>Approved</th><th>Applied</th><th>Reason</th></tr></thead><tbody>${h.map((r) => r.type === 'CONFIG_CHANGE' ? `<tr class="chg">
    <td class="l">${fDateTime(Date.parse(r.timestamp))}</td><td class="l">${esc(r.controller_mode)}</td><td class="l"><b>${esc(r.strategy)}</b></td><td class="l">ALL</td>
    <td class="l" colspan="8"><span class="tag ${r.significant ? 'PENDING' : 'WAIT'}">${r.significant ? 'PARAMETER CHANGE' : 'SETTING CHANGE'}</span>${r.history_reset ? ' <span class="muted">controller evaluates post-change data only</span>' : ''}</td>
    <td class="l reason" title="${esc(r.reason)}">${esc(r.reason)}</td></tr>` : `<tr>
    <td class="l">${fDateTime(Date.parse(r.timestamp))}</td><td class="l">${esc(r.controller_mode)}</td><td class="l"><b>${esc(r.strategy)}</b></td><td class="l side-${r.side}">${r.side}</td>
    <td class="l">${esc(r.previous_status)}</td><td class="l">${r.previous_status !== r.new_status ? `<b class="warn">${esc(r.new_status)}</b>` : esc(r.new_status)}</td>
    <td>${Number(r.previous_multiplier).toFixed(2)}→${Number(r.new_multiplier).toFixed(2)}</td><td class="${cls(r['90d_return'])}">${pct(r['90d_return'])}</td><td class="down">${pct(r.current_drawdown)}</td>
    <td class="l">${esc(r.market_regime || '')}</td><td>${r.approved_by_user ? 'YES' : '—'}</td><td>${r.applied ? `<span class="up">${esc(r.applied_to || 'YES')}</span>` : 'NO'}</td>
    <td class="l reason" title="${esc(r.reason + (r.note ? ' · ' + r.note : ''))}">${esc(r.note || r.reason)}</td></tr>`).join('')}</tbody></table>`;
}

function renderShadow(d) {
  const s = d.shadow;
  const diff = s.controllerPnl - s.baselinePnl;
  $('#ctlShadow').innerHTML = `<table class="t compact kv"><tbody>
    <tr><td>Baseline PnL (1.00×)</td><td class="${cls(s.baselinePnl)}">${fSigned(s.baselinePnl)} USDT</td></tr>
    <tr><td>Controller PnL</td><td class="${cls(s.controllerPnl)}">${fSigned(s.controllerPnl)} USDT</td></tr>
    <tr><td>Controller − Baseline</td><td class="${cls(diff)}"><b>${fSigned(diff)} USDT</b></td></tr>
    <tr><td>Virtual trades / open</td><td>${s.trades} / ${s.openPositions}</td></tr>
    <tr><td>Daily records</td><td>${s.days} days (min ${d.config.minHistoryDays} for decisions)</td></tr></tbody></table>`;
  const el = $('#ctlChart');
  if (!chart && LC) {
    chart = LC.createChart(el, { autoSize: true, localization: { locale: 'en-US' }, layout: { background: { type: 'solid', color: '#0b0e11' }, textColor: '#8b949e', fontSize: 10 },
      grid: { vertLines: { color: '#141920' }, horzLines: { color: '#141920' } }, rightPriceScale: { borderColor: '#222933' }, timeScale: { borderColor: '#222933' } });
    sBase = chart.addSeries(LC.LineSeries, { color: '#8b949e', lineWidth: 1, title: 'Baseline', priceLineVisible: false });
    sCtl = chart.addSeries(LC.LineSeries, { color: '#f0b90b', lineWidth: 2, title: 'Controller', priceLineVisible: false });
  }
  if (chart) {
    const pts = d.shadowSeries.map((p) => ({ time: p.day, b: p.baseline, c: p.controller }));
    sBase.setData(pts.map((p) => ({ time: p.time, value: p.b })));
    sCtl.setData(pts.map((p) => ({ time: p.time, value: p.c })));
    // config-change markers (snapped to the nearest recorded day)
    if (!markersApi && LC.createSeriesMarkers) markersApi = LC.createSeriesMarkers(sCtl, []);
    if (markersApi) {
      const days = pts.map((p) => p.time);
      const mk = (d.changes || []).map((c) => ({ time: days.find((x) => x >= c.day), c })).filter((x) => x.time)
        .map(({ time, c }) => ({ time, position: 'aboveBar', color: c.significant ? '#f0b90b' : '#8b949e', shape: c.significant ? 'arrowDown' : 'circle', text: `${c.strategy.replace('QQQ_', 'Q ')}${c.significant ? ' params' : ''}` }))
        .sort((a, b) => (a.time < b.time ? -1 : 1));
      markersApi.setMarkers(mk);
    }
  }
}

function renderRegime(d) {
  const all = d.regimeDetails && Object.keys(d.regimeDetails).length ? d.regimeDetails : (d.regimeDetail ? { CRYPTO: d.regimeDetail } : null);
  if (!all) { $('#ctlRegimeDetail').innerHTML = '<div class="empty">Not evaluated yet</div>'; return; }
  $('#ctlRegimeDetail').innerHTML = Object.entries(all).map(([c, r]) => regimeTable(c, r)).join('');
}

function regimeTable(c, r) {
  const i = r.inputs || {};
  const ref = c === 'CRYPTO' ? 'BTC' : 'QQQ';
  return `<table class="t compact kv"><tbody>
    <tr><td><b>${CLASS_LABEL[c] || c}</b> regime</td><td>${regimeTag(r.regime)}</td></tr>
    <tr><td>${ref} / SMA200</td><td>${fNum(i.price, 0)} / ${fNum(i.sma200, 0)}</td></tr>
    <tr><td>30D / 90D return</td><td><span class="${cls(i.ret30)}">${pct(i.ret30)}</span> / <span class="${cls(i.ret90)}">${pct(i.ret90)}</span></td></tr>
    <tr><td>ATR% / Vol 30D</td><td>${pct(i.atrPct, 2)} / ${pct(i.vol30, 0)}</td></tr>
    <tr><td>ADX(14)</td><td>${n2(i.adx)}</td></tr>
    <tr><td>Rule</td><td class="reason">${esc((r.reasons || []).join('; '))}</td></tr></tbody></table>`;
}


function renderCorr(d) {
  $('#ctlCorr').innerHTML = `<table class="t compact kv"><tbody>${d.correlations.filter((c) => c.corr != null || c.classA === c.classB).map((c) => `<tr><td>${c.a} / ${c.b}${c.classA !== c.classB ? ' <span class="muted">cross-asset</span>' : ''}</td><td class="${c.high ? 'warn' : ''}">${c.corr == null ? 'insufficient data' : c.corr.toFixed(2)}${c.high ? ' HIGH' : ''}</td></tr>`).join('')}
    <tr><td>Guard (&gt; ${d.config.guards.correlationThreshold})</td><td>${d.config.guards.correlationGuard ? '<span class="up">ON</span>' : '<span class="muted">display only</span>'}</td></tr></tbody></table>`;
}

function renderExposure(d) {
  const e = d.exposure;
  $('#ctlExp').innerHTML = `<table class="t compact"><thead><tr><th>Coin</th><th>Gross</th><th>% Eq</th><th>Long</th><th>Short</th><th>Net</th></tr></thead><tbody>
    ${Object.entries(e.coins).map(([k, c]) => `<tr><td>${k.replace('USDT', '')}</td><td>${fNum(c.gross, 0)}</td><td class="${c.grossPct > d.config.guards.maxCoinExposurePctForBoost ? 'warn' : ''}">${c.grossPct != null ? c.grossPct.toFixed(0) + '%' : '—'}</td><td class="up">${fNum(c.long, 0)}</td><td class="down">${fNum(c.short, 0)}</td><td class="${cls(c.net)}">${fSigned(c.net, 0)}</td></tr>`).join('')}
    ${Object.entries(e.byClass || {}).map(([c, v]) => `<tr class="grp"><td>${CLASS_LABEL[c] || c}</td><td>${fNum(v.gross, 0)}</td><td>${v.grossPct != null ? v.grossPct.toFixed(0) + '%' : '—'}</td><td class="up">${fNum(v.long, 0)}</td><td class="down">${fNum(v.short, 0)}</td><td class="${cls(v.net)}">${fSigned(v.net, 0)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>TOTAL</td><td>${fNum(e.gross, 0)}</td><td></td><td class="up">${fNum(e.long, 0)}</td><td class="down">${fNum(e.short, 0)}</td><td class="${cls(e.net)}">${fSigned(e.net, 0)}</td></tr></tfoot></table>`;
}

function renderSettings(d) {
  const c = d.config;
  const inp = (name, v, step = 'any') => `<input type="number" name="${name}" value="${v ?? ''}" step="${step}">`;
  const row = (label, html) => `<div class="fr"><label>${label}</label>${html}</div>`;
  $('#ctlSettings').innerHTML = `<div class="ctl-set">
    ${row('Re-evaluation', `<select name="reevalDays">${[1, 7, 14, 30].map((x) => `<option value="${x}" ${x === c.reevalDays ? 'selected' : ''}>${x} day${x > 1 ? 's' : ''}</option>`).join('')}</select>`)}
    ${row('Min history days', inp('minHistoryDays', c.minHistoryDays, 1))}
    ${row('Windows fast/main', `<span class="pair">${inp('windows.fast', c.windows.fast, 1)}${inp('windows.main', c.windows.main, 1)}</span>`)}
    ${row('Stability/extended', `<span class="pair">${inp('windows.stability', c.windows.stability, 1)}${inp('windows.extended', c.windows.extended, 1)}</span>`)}
    <div class="set-sec">Score weights</div>
    ${row('Return / Drawdown', `<span class="pair">${inp('weights.return', c.weights.return, 0.05)}${inp('weights.drawdown', c.weights.drawdown, 0.05)}</span>`)}
    ${row('Risk-adj / Consistency', `<span class="pair">${inp('weights.riskAdjusted', c.weights.riskAdjusted, 0.05)}${inp('weights.consistency', c.weights.consistency, 0.05)}</span>`)}
    ${row('Thresholds boost/normal', `<span class="pair">${inp('thresholds.boost', c.thresholds.boost, 0.05)}${inp('thresholds.normal', c.thresholds.normal, 0.05)}</span>`)}
    ${row('Threshold cautious', inp('thresholds.cautious', c.thresholds.cautious, 0.05))}
    <div class="set-sec">Guards</div>
    ${row('DD no-boost / reduce %', `<span class="pair">${inp('guards.noBoostDDPct', c.guards.noBoostDDPct, 1)}${inp('guards.reduceDDPct', c.guards.reduceDDPct, 1)}</span>`)}
    ${row('DD pause %', inp('guards.pauseDDPct', c.guards.pauseDDPct, 1))}
    ${row('Consec. losses no-boost / caution', `<span class="pair">${inp('guards.noBoostConsecLosses', c.guards.noBoostConsecLosses, 1)}${inp('guards.cautionConsecLosses', c.guards.cautionConsecLosses, 1)}</span>`)}
    ${row('Correlation threshold', inp('guards.correlationThreshold', c.guards.correlationThreshold, 0.05))}
    ${row('Correlation guard', `<label class="sw"><input type="checkbox" name="guards.correlationGuard" ${c.guards.correlationGuard ? 'checked' : ''}><span></span></label>`)}
    ${row('Coin exposure % (no boost)', inp('guards.maxCoinExposurePctForBoost', c.guards.maxCoinExposurePctForBoost, 5))}
    <div class="set-sec">Max order USDT (hard cap, blank = none)</div>
    ${capStrats(d).map((st) => row(`${st} long / short`, `<span class="pair">${inp(`cap.${st}.LONG`, c.maxOrderUsdt[st]?.LONG, 1)}${inp(`cap.${st}.SHORT`, c.maxOrderUsdt[st]?.SHORT, 1)}</span>`)).join('')}
    <div class="set-sec">Parameter changes</div>
    ${row('Evaluate post-change data only', `<label class="sw"><input type="checkbox" name="resetHistoryOnParamChange" ${c.resetHistoryOnParamChange ? 'checked' : ''}><span></span></label>`)}
    <div class="note">Multipliers fixed: PAUSED 0 · REDUCED 0.5 · CAUTIOUS 0.75 · NORMAL 1.0 · BOOSTED 1.25 (max). Parameter optimization: OFF (V1).</div>
    <div class="set-actions"><span class="dirty" id="ctlDirty">● UNSAVED CHANGES</span><button class="btn primary small" id="ctlSave">SAVE CONTROLLER</button></div></div>`;
  const box = $('#ctlSettings');
  box.oninput = () => { settingsDirty = true; $('#ctlDirty').classList.add('show'); };
  $('#ctlSave').onclick = async () => {
    const v = (n) => box.querySelector(`[name="${n}"]`);
    const g = (n) => v(n).value;
    const settings = {
      reevalDays: Number(g('reevalDays')), minHistoryDays: g('minHistoryDays'),
      windows: { fast: g('windows.fast'), main: g('windows.main'), stability: g('windows.stability'), extended: g('windows.extended') },
      weights: { return: g('weights.return'), drawdown: g('weights.drawdown'), riskAdjusted: g('weights.riskAdjusted'), consistency: g('weights.consistency') },
      thresholds: { boost: g('thresholds.boost'), normal: g('thresholds.normal'), cautious: g('thresholds.cautious') },
      guards: {
        noBoostDDPct: g('guards.noBoostDDPct'), reduceDDPct: g('guards.reduceDDPct'), pauseDDPct: g('guards.pauseDDPct'),
        noBoostConsecLosses: g('guards.noBoostConsecLosses'), cautionConsecLosses: g('guards.cautionConsecLosses'),
        correlationThreshold: g('guards.correlationThreshold'), correlationGuard: v('guards.correlationGuard').checked,
        maxCoinExposurePctForBoost: g('guards.maxCoinExposurePctForBoost'),
      },
      maxOrderUsdt: Object.fromEntries(capStrats(D).map((st) => [st, { LONG: g(`cap.${st}.LONG`), SHORT: g(`cap.${st}.SHORT`) }])),
      resetHistoryOnParamChange: v('resetHistoryOnParamChange').checked,
    };
    const r = await api('POST', '/api/controller/config', { settings });
    if (!r.ok) return toast(r.msg, 'err');
    toast('Controller settings saved', 'ok');
    settingsDirty = false;
    refresh();
  };
}

function capStrats(d) { return [...new Set(d.strategies.map((x) => x.strategy))]; }
