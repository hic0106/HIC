// CONTROLLER tab: Self-Improving Controller dashboard, approvals, shadow comparison, history, settings.
import { $, $$, esc, api, toast, fNum, fSigned, fDateTime, cls } from './util.js';
import { confirmDialog } from './modals.js';

const LC = window.LightweightCharts;
const MODES = [['OFF', '끄기'], ['OBSERVE', '관찰만'], ['PAPER_AUTO', '모의 자동적용'], ['LIVE_APPROVAL', '실전 승인제']];
const MODE_KO = Object.fromEntries(MODES);
const ST_KO = { BOOSTED: '확대', NORMAL: '정상', CAUTIOUS: '주의', REDUCED: '축소', PAUSED: '중지', FAIL_SAFE: '안전모드' };
const RG_KO = { BULL_TREND: '상승 추세', BEAR_TREND: '하락 추세', HIGH_VOLATILITY: '고변동', SIDEWAYS: '횡보', NORMAL: '보통' };
const SIDE_KO = { LONG: '롱', SHORT: '숏' };
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)}%`);
const n2 = (x) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(2));
const statusCls = (s) => ({ BOOSTED: 'LONG', NORMAL: 'WAIT', CAUTIOUS: 'PENDING', REDUCED: 'SHORT', PAUSED: 'OFF', FAIL_SAFE: 'UNKNOWN' }[s] || 'WAIT');
export const statusTag = (s, m) => `<span class="tag ${statusCls(s)}">${esc(ST_KO[s] || s)}${m != null ? ` ${Number(m).toFixed(2)}×` : ''}</span>`;
const REGIME_CLS = { BULL_TREND: 'LONG', BEAR_TREND: 'SHORT', HIGH_VOLATILITY: 'UNKNOWN', SIDEWAYS: 'PENDING', NORMAL: 'WAIT' };
export const regimeTag = (r) => (r ? `<span class="tag ${REGIME_CLS[r] || 'WAIT'}">${RG_KO[r] || r}</span>` : '<span class="tag WAIT">—</span>');

let D = null; // last detail
let chart = null, sBase = null, sCtl = null, markersApi = null;
const CLASS_LABEL = { CRYPTO: '코인', TRADFI_INDEX: 'QQQ' };
let built = false, settingsDirty = false, timer = null;

export function controllerHeaderHtml(c) {
  if (!c) return '';
  const fs = c.failSafe ? ' <span class="tag UNKNOWN">안전모드</span>' : '';
  const tr = c.regimes?.TRADFI_INDEX;
  return `자동 조절 <b class="${c.mode === 'OFF' ? 'muted' : 'warn'}">${MODE_KO[c.mode] || c.mode}</b>${fs} · 코인 ${regimeTag(c.regime)}${tr ? ` QQQ ${regimeTag(tr)}` : ''}${c.pending ? ` · <span class="warn">승인 대기 ${c.pending}</span>` : ''}`;
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
    <button class="btn ghost small" id="ctlEval">지금 평가</button>
    <button class="btn stop small" id="ctlKill">자동 조절 끄기</button>
  </div>
  <div class="ctl-grid">
    <div class="ctl-main">
      <div class="sub-h">전략별 조절 · 주문금액 × 배수(0 ~ 1.25) · 신호·손절·레버리지·설정금액은 절대 바꾸지 않음</div>
      <div id="ctlTable"></div>
      <div class="sub-h">자산군별 성과 (코인과 QQQ는 따로 평가)</div>
      <div id="ctlClass"></div>
      <div id="ctlPending"></div>
      <div class="sub-h">조절 기록 (모든 결정과 이유)</div>
      <div id="ctlHistory"></div>
    </div>
    <div class="ctl-side">
      <div class="sub-h">가상 비교 · 기본 1.00배 vs 자동 조절 적용 (가상, 주문 없음)</div>
      <div id="ctlShadow"></div>
      <div id="ctlChart"></div>
      <div class="sub-h">시장 국면 (규칙 기반 · 코인 = BTC · QQQ = 미국 정규장)</div>
      <div id="ctlRegimeDetail"></div>
      <div class="sub-h">전략 간 수익 상관관계 (90일)</div>
      <div id="ctlCorr"></div>
      <div class="sub-h">종목별 투자 규모 (현재 포지션)</div>
      <div id="ctlExp"></div>
      <div class="sub-h">자동 조절 설정</div>
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
      const w = await confirmDialog({ title: '자동 조절 · 실전 승인제', danger: true, word: 'LIVE',
        html: '<p>실전 계좌에 대해 변경을 <b>추천</b>만 합니다. 승인한 변경만 실전 주문금액에 적용됩니다.</p><p>모의투자 계좌에는 자동 적용됩니다.</p>' });
      if (!w) return;
      body.confirm = 'LIVE';
    }
    if (mode === 'OFF') return kill();
    const r = await api('POST', '/api/controller/mode', body);
    r.ok ? toast(`자동 조절 모드: ${MODE_KO[mode]}`, 'ok') : toast(r.msg, 'err');
    refresh();
  });
  $('#ctlEval').onclick = async () => {
    const r = await api('POST', '/api/controller/evaluate');
    r.ok ? toast('평가했습니다', 'ok') : toast(r.msg, 'err');
    refresh();
  };
  $('#ctlKill').onclick = kill;
  root.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-approve]');
    const rj = e.target.closest('[data-reject]');
    if (a) {
      const p = D.pendingList.find((x) => x.id === a.dataset.approve);
      const w = await confirmDialog({ title: '실전 변경 승인', danger: true, word: 'APPROVE',
        html: `<p><b>${esc(p.strategy)} ${SIDE_KO[p.side]}</b> ${esc(ST_KO[p.from] || p.from)} → <b>${esc(ST_KO[p.to] || p.to)}</b></p><p>주문 배수 ${p.fromMult.toFixed(2)} → <b>${p.toMult.toFixed(2)}</b> (신규 실전 진입부터 적용)</p><p class="muted">${esc(p.reason)}</p>` });
      if (!w) return;
      const r = await api('POST', '/api/controller/approve', { id: p.id, confirm: 'APPROVE' });
      r.ok ? toast('승인했습니다', 'ok') : toast(r.msg, 'err');
      refresh();
    } else if (rj) {
      const r = await api('POST', '/api/controller/reject', { id: rj.dataset.reject });
      r.ok ? toast('거절했습니다', 'ok') : toast(r.msg, 'err');
      refresh();
    }
  });
}

async function kill() {
  const w = await confirmDialog({ title: '자동 조절 끄기', danger: true,
    html: '<p>자동 조절을 즉시 끕니다. 모든 배수가 <b>1.00×</b>로 돌아가고 대기 중인 추천은 삭제됩니다.</p><p>전략과 주문 엔진은 그대로 계속 동작합니다.</p>', okText: '끄기' });
  if (!w) return;
  const r = await api('POST', '/api/controller/disable');
  r.ok ? toast('자동 조절을 껐습니다 — 모든 배수 1.00×', 'ok') : toast(r.msg, 'err');
  refresh();
}

async function refresh() {
  const d = await api('GET', '/api/controller');
  if (!d || d.ok === false) return;
  D = d;
  $$('#ctlMode button').forEach((b) => b.classList.toggle('on', b.dataset.m === d.mode));
  $('#ctlTimes').textContent = `마지막 평가 ${d.lastEvaluation ? fDateTime(d.lastEvaluation) : '—'} · 다음 ${d.nextEvaluation ? fDateTime(d.nextEvaluation) : d.mode === 'OFF' ? '—' : '다음 확인 때'} · ${d.config.reevalDays}일마다 · 거래 모드 ${d.tradingMode === 'LIVE' ? '실전' : '모의'}`;
  $('#ctlRegime').innerHTML = `시장 국면 코인 ${regimeTag(d.regime)} QQQ ${regimeTag(d.regimes?.TRADFI_INDEX)}${d.failSafe ? ` <span class="tag UNKNOWN" title="${esc(d.failSafe.error)}">안전모드 1.00×</span>` : ''}`;
  $('#ctlPendingCnt').innerHTML = d.pendingList.length ? `<span class="warn">승인 대기 추천 ${d.pendingList.length}건</span>` : '';
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
  const appliedNote = d.mode === 'OBSERVE' ? '관찰만' : d.mode === 'OFF' ? '꺼짐' : '';
  let lastC = null;
  const rows = d.strategies.map((s) => {
    const m = s.metrics || {};
    const reason = [...s.guards, ...s.reasons].join(' · ');
    const grp = s.assetClass !== lastC ? `<tr class="grp"><td colspan="22">${CLASS_LABEL[s.assetClass] || s.assetClass}</td></tr>` : '';
    lastC = s.assetClass;
    const ch = m.change;
    const chCell = ch ? `<span title="${ch.day} 이후: ${pct(ch.retAfter)} (${ch.days}일) · 변경 전 같은 기간: ${pct(ch.retBefore)}${m.historyReset ? ' · 변경 이후 데이터로만 평가' : ''}"><span class="${cls(ch.retAfter)}">${pct(ch.retAfter)}</span>/${ch.days}일 <span class="muted">전 ${pct(ch.retBefore)}</span>${m.historyReset ? ' <span class="tag PENDING">초기화</span>' : ''}</span>` : '<span class="muted">—</span>';
    return grp + `<tr class="${s.active ? '' : 'dim'}">
      <td class="l"><b>${s.strategy}</b>${s.enabled ? '' : ' <span class="tag OFF">꺼짐</span>'}</td><td class="l side-${s.side}">${SIDE_KO[s.side]}</td>
      <td class="l">${s.active ? statusTag(s.recommended, s.recommendedMult) : '<span class="muted">해당없음</span>'}</td>
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
  $('#ctlTable').innerHTML = `<table class="t compact"><thead><tr><th>전략</th><th>방향</th><th>추천</th><th>적용 (${d.tradingMode === 'LIVE' ? '실전' : '모의'})</th><th>설정금액</th><th>실제금액</th>
    <th>30일</th><th>90일</th><th>180일</th><th>현재 낙폭</th><th>최대 낙폭</th><th>샤프</th><th>소르티노</th><th>손익비</th><th>승률</th><th>거래수</th><th>연속손실</th><th>노출</th><th>기록일</th><th>점수</th><th class="l">설정 변경 이후</th><th>이유</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderClass(d) {
  const cp = d.classPerformance || {};
  $('#ctlClass').innerHTML = `<table class="t compact"><thead><tr><th>자산군</th><th>종목</th><th>켜진 전략</th><th>국면</th><th>기본 손익</th><th>조절 손익</th><th>30일</th><th>90일</th><th>180일</th><th>현재 낙폭</th><th>최대 낙폭</th><th>샤프</th><th>기록일</th></tr></thead><tbody>
    ${Object.entries(cp).map(([c, v]) => { const m = v.metrics || {}; return `<tr><td class="l"><b>${CLASS_LABEL[c] || c}</b></td><td class="l">${v.symbols.map((x) => x.replace('USDT', '')).join(' ')}</td><td class="l">${v.strategies.join(', ') || '—'}</td>
      <td class="l">${regimeTag(v.regime)}</td><td class="${cls(v.baselinePnl)}">${fSigned(v.baselinePnl)}</td><td class="${cls(v.controllerPnl)}">${fSigned(v.controllerPnl)}</td>
      <td class="${cls(m.ret30)}">${pct(m.ret30)}</td><td class="${cls(m.ret90)}">${pct(m.ret90)}</td><td class="${cls(m.retStab)}">${pct(m.retStab)}</td><td class="down">${pct(m.currentDD)}</td><td class="down">${pct(m.maxDD)}</td><td>${n2(m.sharpe)}</td><td>${m.historyDays ?? 0}</td></tr>`; }).join('')}
  </tbody></table>`;
}

function renderPending(d) {
  if (!d.pendingList.length) { $('#ctlPending').innerHTML = ''; return; }
  $('#ctlPending').innerHTML = `<div class="sub-h warn">승인 대기 중인 실전 추천 (${d.pendingList.length})</div>
    <table class="t compact"><tbody>${d.pendingList.map((p) => `<tr>
      <td class="l"><b>${p.strategy}</b> <span class="side-${p.side}">${SIDE_KO[p.side]}</span></td>
      <td class="l">${statusTag(p.from, p.fromMult)} → ${statusTag(p.to, p.toMult)}</td>
      <td class="l reason" title="${esc(p.reason)}">${esc(p.reason)}</td><td class="muted">${fDateTime(p.createdAt)}</td>
      <td><button class="btn small start" data-approve="${esc(p.id)}">승인</button> <button class="btn small danger" data-reject="${esc(p.id)}">거절</button></td></tr>`).join('')}</tbody></table>`;
}

function renderHistory(d) {
  const h = d.history.slice(0, 60);
  if (!h.length) { $('#ctlHistory').innerHTML = '<div class="empty">아직 조절 기록 없음</div>'; return; }
  $('#ctlHistory').innerHTML = `<table class="t compact"><thead><tr><th>시간</th><th>모드</th><th>전략</th><th>방향</th><th>이전</th><th>변경</th><th>배수</th><th>90일</th><th>현재 낙폭</th><th>국면</th><th>승인</th><th>적용</th><th>이유</th></tr></thead><tbody>${h.map((r) => r.type === 'CONFIG_CHANGE' ? `<tr class="chg">
    <td class="l">${fDateTime(Date.parse(r.timestamp))}</td><td class="l">${esc(MODE_KO[r.controller_mode] || r.controller_mode)}</td><td class="l"><b>${esc(r.strategy)}</b></td><td class="l">전체</td>
    <td class="l" colspan="8"><span class="tag ${r.significant ? 'PENDING' : 'WAIT'}">${r.significant ? '전략 조건 변경' : '설정 변경'}</span>${r.history_reset ? ' <span class="muted">변경 이후 데이터로만 평가</span>' : ''}</td>
    <td class="l reason" title="${esc(r.reason)}">${esc(r.reason)}</td></tr>` : `<tr>
    <td class="l">${fDateTime(Date.parse(r.timestamp))}</td><td class="l">${esc(MODE_KO[r.controller_mode] || r.controller_mode)}</td><td class="l"><b>${esc(r.strategy)}</b></td><td class="l side-${r.side}">${SIDE_KO[r.side] || r.side}</td>
    <td class="l">${esc(ST_KO[r.previous_status] || r.previous_status)}</td><td class="l">${r.previous_status !== r.new_status ? `<b class="warn">${esc(ST_KO[r.new_status] || r.new_status)}</b>` : esc(ST_KO[r.new_status] || r.new_status)}</td>
    <td>${Number(r.previous_multiplier).toFixed(2)}→${Number(r.new_multiplier).toFixed(2)}</td><td class="${cls(r['90d_return'])}">${pct(r['90d_return'])}</td><td class="down">${pct(r.current_drawdown)}</td>
    <td class="l">${esc(RG_KO[r.market_regime] || r.market_regime || '')}</td><td>${r.approved_by_user ? '예' : '—'}</td><td>${r.applied ? `<span class="up">${esc(r.applied_to || '예')}</span>` : '아니오'}</td>
    <td class="l reason" title="${esc(r.reason + (r.note ? ' · ' + r.note : ''))}">${esc(r.note || r.reason)}</td></tr>`).join('')}</tbody></table>`;
}

function renderShadow(d) {
  const s = d.shadow;
  const diff = s.controllerPnl - s.baselinePnl;
  $('#ctlShadow').innerHTML = `<table class="t compact kv"><tbody>
    <tr><td>기본 손익 (1.00배)</td><td class="${cls(s.baselinePnl)}">${fSigned(s.baselinePnl)} USDT</td></tr>
    <tr><td>조절 적용 손익</td><td class="${cls(s.controllerPnl)}">${fSigned(s.controllerPnl)} USDT</td></tr>
    <tr><td>조절 − 기본</td><td class="${cls(diff)}"><b>${fSigned(diff)} USDT</b></td></tr>
    <tr><td>가상 거래 / 보유</td><td>${s.trades} / ${s.openPositions}</td></tr>
    <tr><td>일별 기록</td><td>${s.days}일 (판단에 최소 ${d.config.minHistoryDays}일 필요)</td></tr></tbody></table>`;
  const el = $('#ctlChart');
  if (!chart && LC) {
    chart = LC.createChart(el, { autoSize: true, localization: { locale: 'en-US' }, layout: { background: { type: 'solid', color: '#0b0e11' }, textColor: '#8b949e', fontSize: 10 },
      grid: { vertLines: { color: '#141920' }, horzLines: { color: '#141920' } }, rightPriceScale: { borderColor: '#222933' }, timeScale: { borderColor: '#222933' } });
    sBase = chart.addSeries(LC.LineSeries, { color: '#8b949e', lineWidth: 1, title: '기본', priceLineVisible: false });
    sCtl = chart.addSeries(LC.LineSeries, { color: '#f0b90b', lineWidth: 2, title: '조절', priceLineVisible: false });
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
        .map(({ time, c }) => ({ time, position: 'aboveBar', color: c.significant ? '#f0b90b' : '#8b949e', shape: c.significant ? 'arrowDown' : 'circle', text: `${c.strategy.replace('QQQ_', 'Q ')}${c.significant ? ' 조건변경' : ''}` }))
        .sort((a, b) => (a.time < b.time ? -1 : 1));
      markersApi.setMarkers(mk);
    }
  }
}

function renderRegime(d) {
  const all = d.regimeDetails && Object.keys(d.regimeDetails).length ? d.regimeDetails : (d.regimeDetail ? { CRYPTO: d.regimeDetail } : null);
  if (!all) { $('#ctlRegimeDetail').innerHTML = '<div class="empty">아직 평가 안 됨</div>'; return; }
  $('#ctlRegimeDetail').innerHTML = Object.entries(all).map(([c, r]) => regimeTable(c, r)).join('');
}

function regimeTable(c, r) {
  const i = r.inputs || {};
  const ref = c === 'CRYPTO' ? 'BTC' : 'QQQ';
  return `<table class="t compact kv"><tbody>
    <tr><td><b>${CLASS_LABEL[c] || c}</b> 국면</td><td>${regimeTag(r.regime)}</td></tr>
    <tr><td>${ref} / SMA200</td><td>${fNum(i.price, 0)} / ${fNum(i.sma200, 0)}</td></tr>
    <tr><td>30일 / 90일 수익률</td><td><span class="${cls(i.ret30)}">${pct(i.ret30)}</span> / <span class="${cls(i.ret90)}">${pct(i.ret90)}</span></td></tr>
    <tr><td>ATR% / 30일 변동성</td><td>${pct(i.atrPct, 2)} / ${pct(i.vol30, 0)}</td></tr>
    <tr><td>ADX(14)</td><td>${n2(i.adx)}</td></tr>
    <tr><td>판단 근거</td><td class="reason">${esc((r.reasons || []).join('; '))}</td></tr></tbody></table>`;
}


function renderCorr(d) {
  $('#ctlCorr').innerHTML = `<table class="t compact kv"><tbody>${d.correlations.filter((c) => c.corr != null || c.classA === c.classB).map((c) => `<tr><td>${c.a} / ${c.b}${c.classA !== c.classB ? ' <span class="muted">다른 자산군</span>' : ''}</td><td class="${c.high ? 'warn' : ''}">${c.corr == null ? '데이터 부족' : c.corr.toFixed(2)}${c.high ? ' 높음' : ''}</td></tr>`).join('')}
    <tr><td>제한 (&gt; ${d.config.guards.correlationThreshold})</td><td>${d.config.guards.correlationGuard ? '<span class="up">켜짐</span>' : '<span class="muted">표시만</span>'}</td></tr></tbody></table>`;
}

function renderExposure(d) {
  const e = d.exposure;
  $('#ctlExp').innerHTML = `<table class="t compact"><thead><tr><th>종목</th><th>총 규모</th><th>자산 대비</th><th>롱</th><th>숏</th><th>순</th></tr></thead><tbody>
    ${Object.entries(e.coins).map(([k, c]) => `<tr><td>${k.replace('USDT', '')}</td><td>${fNum(c.gross, 0)}</td><td class="${c.grossPct > d.config.guards.maxCoinExposurePctForBoost ? 'warn' : ''}">${c.grossPct != null ? c.grossPct.toFixed(0) + '%' : '—'}</td><td class="up">${fNum(c.long, 0)}</td><td class="down">${fNum(c.short, 0)}</td><td class="${cls(c.net)}">${fSigned(c.net, 0)}</td></tr>`).join('')}
    ${Object.entries(e.byClass || {}).map(([c, v]) => `<tr class="grp"><td>${CLASS_LABEL[c] || c}</td><td>${fNum(v.gross, 0)}</td><td>${v.grossPct != null ? v.grossPct.toFixed(0) + '%' : '—'}</td><td class="up">${fNum(v.long, 0)}</td><td class="down">${fNum(v.short, 0)}</td><td class="${cls(v.net)}">${fSigned(v.net, 0)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>합계</td><td>${fNum(e.gross, 0)}</td><td></td><td class="up">${fNum(e.long, 0)}</td><td class="down">${fNum(e.short, 0)}</td><td class="${cls(e.net)}">${fSigned(e.net, 0)}</td></tr></tfoot></table>`;
}

function renderSettings(d) {
  const c = d.config;
  const inp = (name, v, step = 'any') => `<input type="number" name="${name}" value="${v ?? ''}" step="${step}">`;
  const row = (label, html) => `<div class="fr"><label>${label}</label>${html}</div>`;
  $('#ctlSettings').innerHTML = `<div class="ctl-set">
    ${row('재평가 주기', `<select name="reevalDays">${[1, 7, 14, 30].map((x) => `<option value="${x}" ${x === c.reevalDays ? 'selected' : ''}>${x}일</option>`).join('')}</select>`)}
    ${row('최소 기록 일수', inp('minHistoryDays', c.minHistoryDays, 1))}
    ${row('평가 기간 단기/주', `<span class="pair">${inp('windows.fast', c.windows.fast, 1)}${inp('windows.main', c.windows.main, 1)}</span>`)}
    ${row('안정성/확장 기간', `<span class="pair">${inp('windows.stability', c.windows.stability, 1)}${inp('windows.extended', c.windows.extended, 1)}</span>`)}
    <div class="set-sec">점수 가중치</div>
    ${row('수익 / 낙폭', `<span class="pair">${inp('weights.return', c.weights.return, 0.05)}${inp('weights.drawdown', c.weights.drawdown, 0.05)}</span>`)}
    ${row('위험조정 / 일관성', `<span class="pair">${inp('weights.riskAdjusted', c.weights.riskAdjusted, 0.05)}${inp('weights.consistency', c.weights.consistency, 0.05)}</span>`)}
    ${row('기준 확대/정상', `<span class="pair">${inp('thresholds.boost', c.thresholds.boost, 0.05)}${inp('thresholds.normal', c.thresholds.normal, 0.05)}</span>`)}
    ${row('기준 주의', inp('thresholds.cautious', c.thresholds.cautious, 0.05))}
    <div class="set-sec">안전 기준</div>
    ${row('낙폭 확대금지 / 축소 %', `<span class="pair">${inp('guards.noBoostDDPct', c.guards.noBoostDDPct, 1)}${inp('guards.reduceDDPct', c.guards.reduceDDPct, 1)}</span>`)}
    ${row('낙폭 중지 %', inp('guards.pauseDDPct', c.guards.pauseDDPct, 1))}
    ${row('연속손실 확대금지 / 주의', `<span class="pair">${inp('guards.noBoostConsecLosses', c.guards.noBoostConsecLosses, 1)}${inp('guards.cautionConsecLosses', c.guards.cautionConsecLosses, 1)}</span>`)}
    ${row('상관관계 기준', inp('guards.correlationThreshold', c.guards.correlationThreshold, 0.05))}
    ${row('상관관계 제한', `<label class="sw"><input type="checkbox" name="guards.correlationGuard" ${c.guards.correlationGuard ? 'checked' : ''}><span></span></label>`)}
    ${row('종목 노출 % (확대 금지)', inp('guards.maxCoinExposurePctForBoost', c.guards.maxCoinExposurePctForBoost, 5))}
    <div class="set-sec">최대 주문금액 USDT (빈칸 = 제한 없음)</div>
    ${capStrats(d).map((st) => row(`${st} 롱 / 숏`, `<span class="pair">${inp(`cap.${st}.LONG`, c.maxOrderUsdt[st]?.LONG, 1)}${inp(`cap.${st}.SHORT`, c.maxOrderUsdt[st]?.SHORT, 1)}</span>`)).join('')}
    <div class="set-sec">전략 조건 변경 시</div>
    ${row('변경 이후 데이터로만 평가', `<label class="sw"><input type="checkbox" name="resetHistoryOnParamChange" ${c.resetHistoryOnParamChange ? 'checked' : ''}><span></span></label>`)}
    <div class="note">배수 고정: 중지 0 · 축소 0.5 · 주의 0.75 · 정상 1.0 · 확대 1.25(최대).</div>
    <div class="set-actions"><span class="dirty" id="ctlDirty">● 저장 안 됨</span><button class="btn primary small" id="ctlSave">설정 저장</button></div></div>`;
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
    toast('자동 조절 설정을 저장했습니다', 'ok');
    settingsDirty = false;
    refresh();
  };
}

function capStrats(d) { return [...new Set(d.strategies.map((x) => x.strategy))]; }
