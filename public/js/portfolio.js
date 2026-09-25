// PORTFOLIO screen: real account (Exchange View) + strategy attribution (Strategy View).
// Data: WS 'portfolio' pushes (on every fill / close / account update, else every 2 s) + /api/portfolio/equity.
import { $, $$, esc, fUsd, fSigned, fPct, fNum, fPrice, fDur, fZone, cls, api, toast } from './util.js';
import { ST_COLOR } from './chart.js';
import { confirmDialog } from './modals.js';

const LC = window.LightweightCharts;
const SYM_COLOR = { BTCUSDT: '#f7931a', ETHUSDT: '#627eea', XRPUSDT: '#9aa4b1', QQQUSDT: '#26c6da', CASH: '#2b3440' };
// other coins (dynamic universe): stable color from the symbol name
const PALETTE = ['#e07a5f', '#81b29a', '#f2cc8f', '#9b5de5', '#00bbf9', '#f15bb5', '#90be6d', '#43aa8b', '#ff9f1c', '#8d99ae'];
const symColor = (s) => SYM_COLOR[s] || PALETTE[[...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const CLASS_COLOR = { CRYPTO: '#f0b90b', TRADFI_INDEX: '#26c6da', CASH: '#2b3440' };
const SHORT = { TURTLE: '터틀', ADX: 'ADX', TSMOM: 'TSMOM', RAYNER: 'Rayner', QQQ_EMA_TREND: 'QQQ EMA', QQQ_TSMOM: 'QQQ TSMOM', QQQ_SMA200: 'QQQ SMA200', QQQ_TURTLE_50_20: 'QQQ 터틀50/20', UNATTRIBUTED: '미귀속(수동)' };
const SIDE = { LONG: '롱', SHORT: '숏' };
const LBL = { ALL: '전체', CRYPTO: '코인', TRADFI: 'QQQ', LONG: '롱', SHORT: '숏', TURTLE: '터틀', ADX: 'ADX', TSMOM: 'TSMOM', RAYNER: 'Rayner', QQQ: 'QQQ', TODAY: '오늘', '7D': '7일', '30D': '30일', '1D': '1일', '1M': '1개월', '3M': '3개월' };
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
      <div class="pf-card"><div class="panel-h">자산 변화 <span class="pf-tools"><span class="seg" id="pfRange">${['1D', '7D', '1M', '3M', 'ALL'].map((r) => `<button data-r="${r}" class="${r === P.range ? 'on' : ''}">${LBL[r]}</button>`).join('')}</span>
        <label class="muted"><input type="checkbox" id="pfOverlay" ${P.overlay ? 'checked' : ''}> 전략별 손익 함께 보기</label></span></div>
        <div id="pfCurve"></div><div class="pf-dd" id="pfDd"></div></div>
      <div class="pf-card"><div class="panel-h">자산 배분 <span class="muted">총 자산 중 증거금 비중</span></div><div id="pfAlloc"></div></div>
    </div>
    <div class="pf-row two">
      <div class="pf-card"><div class="panel-h">롱 / 숏 규모 <span class="muted">숏은 음수 자산이 아니라 숏 포지션 규모</span></div><div id="pfExpo"></div></div>
      <div class="pf-card"><div class="panel-h">전략별 자산 <span class="muted">봇 장부 기준 전략별 구분</span></div><div id="pfStrat"></div></div>
    </div>
    <div class="pf-row two">
      <div class="pf-card"><div class="panel-h">거래소 실제 계좌 <span class="muted" id="pfExSrc"></span></div><div id="pfExchange"></div></div>
      <div class="pf-card"><div class="panel-h">포지션 대조 <span class="muted">거래소(기준) vs 봇 장부 · 자동 수정 안 함</span></div><div id="pfRecon"></div></div>
    </div>
    <div class="pf-card"><div class="panel-h">전체 포지션 <span class="pf-tools" id="pfPosFilter">
        <span class="seg" data-f="cls">${['ALL', 'CRYPTO', 'TRADFI'].map((x) => `<button data-v="${x}" class="${x === 'ALL' ? 'on' : ''}">${LBL[x]}</button>`).join('')}</span>
        <span class="seg" data-f="side">${['ALL', 'LONG', 'SHORT'].map((x) => `<button data-v="${x}" class="${x === 'ALL' ? 'on' : ''}">${LBL[x]}</button>`).join('')}</span>
        <span class="seg" data-f="st">${['ALL', 'TURTLE', 'ADX', 'TSMOM', 'RAYNER', 'QQQ'].map((x) => `<button data-v="${x}" class="${x === 'ALL' ? 'on' : ''}">${LBL[x]}</button>`).join('')}</span></span></div>
      <div id="pfPositions"></div></div>
    <div class="pf-row two">
      <div class="pf-card"><div class="panel-h">손익 분석 <span class="pf-tools"><span class="seg" id="pfPeriod">${['TODAY', '7D', '30D', 'ALL'].map((x) => `<button data-v="${x}" class="${x === P.period ? 'on' : ''}">${LBL[x]}</button>`).join('')}</span>
        <span class="seg" id="pfGroup">${[['bySymbol', '종목별'], ['byStrategy', '전략별'], ['byClass', '자산군별']].map(([k, l]) => `<button data-v="${k}" class="${k === P.group ? 'on' : ''}">${l}</button>`).join('')}</span></span></div><div id="pfPnl"></div></div>
      <div class="pf-card"><div class="panel-h">매매손익 · 수수료 · 펀딩비 · 순손익</div><div id="pfCosts"></div></div>
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
  $('#pfExchange', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-sell],[data-move]'); if (!b) return;
    if (b.dataset.move) moveUsdt(); else { const [wallet, asset] = b.dataset.sell.split(':'); sellAsset(wallet, asset); }
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
  $('#pfWarn').innerHTML = warn ? `<div class="pf-banner"><b>포지션 불일치 경고</b> ${d.reconciliation.warnings.map((w) => esc(w.replace('Exchange Qty', '거래소 수량').replace('Internal', '봇 장부').replace('Diff', '차이').replace(' LONG ', ' 롱 ').replace(' SHORT ', ' 숏 '))).join(' · ')} <span class="muted">— 거래소 포지션이 봇 장부와 다릅니다 (수동 거래 또는 외부 변경). 숨기거나 자동으로 고치지 않습니다.</span></div>` : '';
  const ctl = d.controllerMode && d.controllerMode !== 'OFF' ? `<span class="tag OFF" title="자동 조절은 신규 진입 금액만 바꿉니다">자동조절 ${esc({ OBSERVE: '관찰만', PAPER_AUTO: '모의 자동', LIVE_APPROVAL: '실전 승인제' }[d.controllerMode] || d.controllerMode)}</span>` : '';
  $('#pfSummary').innerHTML = [
    d.exchange.live && d.exchange.wallets?.total != null
      ? kpi('총 자산 <i>USDT · 전체 지갑</i>', fUsd(d.exchange.wallets.total), '', `선물 ${fUsd(s.equity)}${d.exchange.wallets.error ? ' · <span class="warn" title="' + esc(d.exchange.wallets.error) + '">일부 조회 실패</span>' : ''}`, true)
      : kpi('총 자산 <i>USDT</i>', fUsd(s.equity), '', d.exchange.live ? `실전 · Binance ${esc(d.exchange.source === 'WS' ? '실시간' : d.exchange.source === 'REST' ? '조회' : d.exchange.source)}${d.exchange.wallets?.error ? ' · <span class="warn">전체 지갑 조회 실패</span>' : ''}` : '모의투자', true),
    kpi('오늘 손익 <i>09시 기준</i>', fSigned(s.todayPnl), cls(s.todayPnl), s.baseCapital ? fPct(s.todayPnl / s.baseCapital * 100) : '', true),
    kpi('총 수익률', s.totalReturnPct != null ? fPct(s.totalReturnPct) : '—', cls(s.totalReturnPct), s.baseCapital ? `원금 ${fUsd(s.baseCapital, 0)}` : '원금 미설정', true),
    kpi('주문 가능', fUsd(s.available)), kpi('투자 원금', fUsd(s.invested), '', '진입가 기준'), kpi('포지션 가치', fUsd(s.positionValue), '', '현재가 기준'),
    kpi('평가손익', fSigned(s.unrealized), cls(s.unrealized), '거래소 기준'), kpi('오늘 실현손익', fSigned(s.realizedToday), cls(s.realizedToday), s.realizedTodaySource === 'BINANCE_INCOME' ? 'Binance 정산 기준' : '봇 장부 기준'),
    kpi('누적 손익', fSigned(s.totalPnl), cls(s.totalPnl), '수수료·펀딩 반영'),
    kpi('고점 대비 하락', d.drawdown.currentPct != null ? `−${d.drawdown.currentPct.toFixed(2)}%` : '—', d.drawdown.currentPct > 0 ? 'down' : '', d.drawdown.maxPct != null ? `최대 −${d.drawdown.maxPct.toFixed(2)}%` : '기록 없음'),
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
  const items = [...a.bySymbol.map((x) => ({ k: x.symbol, label: x.symbol.replace('USDT', ''), v: x.margin, pct: x.pct, notional: x.notional, c: symColor(x.symbol) })), { k: 'CASH', label: '현금', v: a.cash, pct: a.cashPct, c: SYM_COLOR.CASH }];
  const cl = a.byClass;
  const bar = (k, v) => `<div class="pf-bar"><span style="width:${Math.max(0, Math.min(100, v || 0))}%;background:${CLASS_COLOR[k]}"></span></div>`;
  $('#pfAlloc').innerHTML = `<div class="pf-alloc">${donut(items)}
    <table class="t compact"><thead><tr><th>자산</th><th>증거금</th><th>포지션 금액</th><th>%</th><th></th></tr></thead><tbody>
    ${items.map((x) => `<tr><td><i class="sw-dot" style="background:${x.c}"></i>${x.label}</td><td>${fNum(x.v, 2)}</td><td>${x.notional != null ? fNum(x.notional, 2) : ''}</td><td>${x.pct != null ? x.pct.toFixed(1) + '%' : '—'}</td><td class="l" style="width:34%"><div class="pf-bar"><span style="width:${Math.max(0, Math.min(100, x.pct || 0))}%;background:${x.c}"></span></div></td></tr>`).join('')}
    </tbody></table></div>
    <table class="t compact"><tbody>${[['CRYPTO', '코인'], ['TRADFI_INDEX', 'QQQ'], ['CASH', '현금']].map(([k, l]) => `<tr><td style="width:80px">${l}</td><td style="width:90px">${fNum(cl[k]?.margin, 2)}</td><td style="width:60px">${cl[k]?.pct != null ? cl[k].pct.toFixed(1) + '%' : '—'}</td><td class="l">${bar(k, cl[k]?.pct)}</td></tr>`).join('')}</tbody></table>`;
}

function renderExpo() {
  const x = P.data.exposure;
  const max = Math.max(x.grossLong, x.grossShort, Math.abs(x.net), 1);
  const line = (l, v, c) => `<div class="pf-exp"><label>${l}</label><div class="pf-bar"><span style="width:${(Math.abs(v) / max) * 100}%;background:${c}"></span></div><b class="${l === '순 노출' ? cls(v) : ''}">${l === '순 노출' ? fSigned(v) : fUsd(v)}</b></div>`;
  const rows = Object.entries(x.bySymbol).filter(([, b]) => b.rows.length).map(([sym, b]) => `<tr class="grp"><td>${sym.replace('USDT', '')}</td><td class="up">${fNum(b.long, 2)}</td><td class="down">${fNum(b.short, 2)}</td><td>${fNum(b.gross, 2)}</td><td class="${cls(b.net)}">${fSigned(b.net)}</td></tr>
    ${b.rows.map((r) => `<tr><td class="l" style="padding-left:18px">${SHORT[r.strategy] || r.strategy} <span class="side-${r.side}">${SIDE[r.side]}</span></td><td colspan="3"></td><td class="${cls(r.value)}">${fSigned(r.value)}</td></tr>`).join('')}`).join('');
  $('#pfExpo').innerHTML = `${line('롱 합계', x.grossLong, 'var(--up)')}${line('숏 합계', x.grossShort, 'var(--down)')}${line('순 노출', x.net, 'var(--info)')}
    <div class="muted" style="padding:2px 10px 4px">총 규모 ${fUsd(x.gross)} · 코인 롱 ${fNum(x.byClass.CRYPTO.long, 0)} / 숏 ${fNum(x.byClass.CRYPTO.short, 0)} · QQQ 롱 ${fNum(x.byClass.TRADFI_INDEX.long, 0)} / 숏 ${fNum(x.byClass.TRADFI_INDEX.short, 0)}</div>
    ${rows ? `<table class="t compact"><thead><tr><th>종목 / 전략</th><th>롱</th><th>숏</th><th>합계</th><th>순</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">포지션 없음</div>'}`;
}

function renderStrat() {
  const d = P.data;
  let last = null;
  const rows = d.strategyView.map((s) => { const g = s.assetClass !== last ? `<tr class="grp"><td colspan="9">${s.assetClass === 'CRYPTO' ? '코인' : '미국지수 · QQQ'}</td></tr>` : ''; last = s.assetClass; return g + `<tr class="${s.enabled || s.positions ? '' : 'dim'}">
    <td class="l"><i class="sw-dot" style="background:${ST_COLOR[s.strategy]}"></i><b>${SHORT[s.strategy]}</b>${s.ctrlMultipliers.some((m) => m !== 1) ? ` <span class="tag PENDING" title="보유 포지션의 자동 조절 배수">×${s.ctrlMultipliers.join('/')}</span>` : ''}</td>
    <td>${s.positions}</td><td>${fNum(s.invested, 2)}</td><td>${fNum(s.positionValue, 2)}</td><td class="up">${fNum(s.long, 0)}</td><td class="down">${fNum(s.short, 0)}</td>
    <td class="${cls(s.unrealized)}">${fSigned(s.unrealized)}</td><td class="${cls(s.realizedToday)}">${fSigned(s.realizedToday)}</td><td class="${cls(s.realizedTotal)}">${fSigned(s.realizedTotal)}</td></tr>`; }).join('');
  const t = (k) => d.strategyView.reduce((a, s) => a + s[k], 0);
  $('#pfStrat').innerHTML = `<table class="t compact"><thead><tr><th>전략</th><th>포지션</th><th>투자 원금</th><th>현재 가치</th><th>롱</th><th>숏</th><th>평가손익</th><th>오늘 실현</th><th>누적 실현</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><td>합계</td><td>${t('positions')}</td><td>${fNum(t('invested'), 2)}</td><td>${fNum(t('positionValue'), 2)}</td><td class="up">${fNum(t('long'), 0)}</td><td class="down">${fNum(t('short'), 0)}</td><td class="${cls(t('unrealized'))}">${fSigned(t('unrealized'))}</td><td class="${cls(t('realizedToday'))}">${fSigned(t('realizedToday'))}</td><td class="${cls(t('realizedTotal'))}">${fSigned(t('realizedTotal'))}</td></tr>
    ${d.unattributedValue ? `<tr><td colspan="9" class="l warn">+ 전략에 속하지 않은 거래소 포지션 ${fUsd(d.unattributedValue)} (수동 거래 등)</td></tr>` : ''}</tfoot></table>`;
}

function renderExchange() {
  const e = P.data.exchange;
  const f = (sym) => P.data._filters?.[sym];
  $('#pfExSrc').textContent = e.live ? `Binance · ${e.source === 'WS' ? '실시간 반영' : '주기 조회'}${e.stream ? ' · 실시간 연결 ' + ({ CONNECTED: '연결됨', CONNECTING: '연결 중', DISCONNECTED: '끊김', ERROR: '오류', OFF: '꺼짐' }[e.stream] || e.stream) : ''}${e.updatedAt ? ' · ' + fZone(e.updatedAt) : ''}` : '모의투자 가상 계좌';
  $('#pfExchange').innerHTML = `<table class="t compact kv pf-kv"><tbody>
      <tr><td>지갑 잔고</td><td>${fUsd(e.wallet)}</td><td>USDT 마진 잔고</td><td>${fUsd(e.marginBalance)}</td></tr>
      <tr><td>주문 가능</td><td>${fUsd(e.available)}</td><td>평가손익</td><td class="${cls(e.unrealized)}">${fSigned(e.unrealized)}</td></tr>
      ${e.error ? `<tr><td colspan="4" class="l down">${esc(e.error)}</td></tr>` : ''}</tbody></table>
    ${assetsHtml(e)}
    ${e.positions.length ? `<table class="t compact"><thead><tr><th>종목</th><th>방향</th><th>수량</th><th>진입가</th><th>현재가</th><th>포지션 금액</th><th>증거금</th><th>평가손익</th><th>청산가</th><th>레버리지</th></tr></thead><tbody>
      ${e.positions.map((p) => `<tr><td class="l">${p.symbol}</td><td class="l side-${p.side}">${SIDE[p.side]}</td><td>${p.qty}</td><td>${fPrice(p.entryPrice, f(p.symbol))}</td><td>${fPrice(p.markPrice, f(p.symbol))}</td><td>${fNum(p.notional, 2)}</td><td>${fNum(p.initialMargin, 2)}</td><td class="${cls(p.unrealized)}">${fSigned(p.unrealized)}</td><td>${p.liquidationPrice ? fPrice(p.liquidationPrice, f(p.symbol)) : '—'}</td><td>${p.leverage ? p.leverage + '배' : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">거래소 포지션 없음</div>'}`;
}

const WALLET_KO = { Spot: '현물', Funding: '펀딩', 'Cross Margin': '교차 마진', 'Isolated Margin': '격리 마진', 'USDⓈ-M Futures': 'USDⓈ-M 선물', 'COIN-M Futures': 'COIN-M 선물', Earn: 'Earn', Options: '옵션', 'Trading Bots': '트레이딩 봇', 'Copy Trading': '카피 트레이딩' };
// futures wallet: every asset (the totals above are USDT only in single-asset mode) + every Binance wallet
function assetsHtml(e) {
  if (!e.live) return '';
  const other = (e.assets || []).filter((a) => a.asset !== 'USDT');
  const fut = (e.assets || []).length ? `<div class="sub-h">선물 지갑 자산 <span class="muted">USDT 외 자산 포함 · 합계 ${fUsd(e.assetsTotalUsdt)}${other.length ? ' · 위 총 자산은 USDT만 계산 (단일자산 모드)' : ''}</span></div>
    <table class="t compact"><thead><tr><th>자산</th><th>지갑 잔고</th><th>마진 잔고</th><th>평가손익</th><th>가격 (USDT)</th><th>USDT 환산</th><th></th></tr></thead><tbody>
    ${e.assets.map((a) => `<tr><td class="l"><b>${esc(a.asset)}</b></td><td>${fNum(a.wallet, 6)}</td><td>${fNum(a.margin, 6)}</td><td class="${cls(a.unrealized)}">${fSigned(a.unrealized, 4)}</td><td>${a.price != null ? fNum(a.price, 4) : '—'}</td><td>${a.valueUsdt != null ? fUsd(a.valueUsdt) : '<span class="muted">가격 없음</span>'}</td><td>${a.asset !== 'USDT' ? `<button class="btn small ghost" data-sell="FUTURES:${esc(a.asset)}">판매</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '';
  const w = e.wallets;
  const all = !w ? '<div class="empty">Binance 전체 지갑 조회 중…</div>'
    : w.error && !w.list.length ? `<div class="empty down">전체 지갑 조회 실패: ${esc(w.error)}<br><span class="muted">API 키 권한(Enable Reading)과 IP 제한을 확인하세요</span></div>`
    : `<div class="sub-h">Binance 전체 자산 <span class="muted">모든 지갑 · USDT 환산 · 합계 <b>${fUsd(w.total)}</b>${w.at ? ' · ' + fZone(w.at) : ''}${w.error ? ` · <span class="warn">마지막 조회 실패: ${esc(w.error)}</span>` : ''}</span></div>
    <table class="t compact"><thead><tr><th>지갑</th><th>잔고 (USDT)</th><th class="l">자산</th></tr></thead><tbody>
    ${w.list.filter((x) => x.balance > 0 || x.assets.length).map((x) => `<tr><td class="l">${esc(WALLET_KO[x.name] || x.name)}</td><td>${fUsd(x.balance)}</td><td class="l muted">${x.assets.slice(0, 12).map((b) => `${esc(b.asset)} ${fNum(b.free + b.locked + b.freeze, 6)}${x.name === 'Spot' && b.free > 0 ? (b.asset === 'USDT' ? ` <button class="btn small ghost" data-move="1">선물로 이동</button>` : ` <button class="btn small ghost" data-sell="SPOT:${esc(b.asset)}">판매</button>`) : ''}`).join(' · ')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">잔고 없음</td></tr>'}</tbody></table>`;
  return fut + all;
}

// ---- asset sale (spot market sell for USDT; typed confirmation)
async function sellAsset(wallet, asset) {
  const pv = await api('POST', '/api/wallet/preview', { wallet, asset, amount: 'ALL' });
  if (!pv.ok) return toast(`판매 불가: ${pv.msg}`, 'err');
  const p = pv.plan;
  const input = await confirmDialog({
    title: `${asset} 판매 (시장가 → USDT)`, danger: true, word: 'SELL', okText: '판매',
    html: `<p>${wallet === 'FUTURES' ? '선물 지갑 → 현물 지갑으로 옮긴 뒤 ' : '현물 지갑에서 '}<b>${esc(p.symbol)}</b> 현물 시장가로 판매합니다. 체결가는 현재가와 다를 수 있습니다.</p>
      <table class="t compact kv"><tbody><tr><td>판매 가능</td><td>${fNum(p.available, 8)} ${esc(asset)}</td></tr><tr><td>현재가</td><td>${fNum(p.price, 6)} USDT</td></tr><tr><td>예상 수령 (전량)</td><td>≈ ${fUsd(p.estUsdt)} USDT (수수료 전)</td></tr></tbody></table>
      <p><label>판매 수량 <input type="number" id="sellAmt" step="any" min="0" value="${p.qty}"> ${esc(asset)}</label></p>
      <p><label><input type="checkbox" id="sellToFut" checked> 받은 USDT를 선물 지갑으로 이동</label></p>
      <p class="muted">API 키 권한 필요: 현물 거래${wallet === 'FUTURES' ? ' + 유니버설 전송' : ''} (출금 권한은 필요 없음). 수량 단위보다 작은 잔량은 현물 지갑에 남습니다.</p>`,
    read: () => ({ amount: $('#sellAmt').value, toFutures: $('#sellToFut').checked }),
  });
  if (!input) return;
  toast(`${asset} 판매 요청 중…`);
  const r = await api('POST', '/api/wallet/sell', { wallet, asset, amount: input.amount, toFutures: input.toFutures, confirm: 'SELL' });
  const detail = (r.steps || []).map((x) => `${x.ok === false ? '✖' : '✔'} ${x.msg}`).join('\n');
  toast(`${r.ok ? '완료' : '실패'}: ${r.msg}${detail ? '\n' + detail : ''}`, r.ok ? 'ok' : 'err');
}

async function moveUsdt() {
  const ok = await confirmDialog({ title: '현물 USDT → 선물 지갑', word: 'MOVE', okText: '이동', html: '<p>현물 지갑의 사용 가능한 USDT 전부를 USDⓈ-M 선물 지갑으로 옮깁니다. (유니버설 전송 권한 필요)</p>' });
  if (!ok) return;
  const r = await api('POST', '/api/wallet/usdt-to-futures', { amount: 'ALL', confirm: 'MOVE' });
  toast(r.msg, r.ok ? 'ok' : 'err');
}

function renderRecon() {
  const r = P.data.reconciliation;
  if (r.na === 'PAPER') { $('#pfRecon').innerHTML = '<div class="empty">모의투자 모드 — 봇 장부가 곧 계좌라 대조할 거래소가 없습니다</div>'; return; }
  if (r.na === 'NO_SNAPSHOT') { $('#pfRecon').innerHTML = '<div class="empty">Binance 계좌 정보를 불러오는 중…</div>'; return; }
  $('#pfRecon').innerHTML = `<div class="pf-recon ${r.ok ? 'ok' : 'bad'}">${r.ok ? '● 일치 — 거래소 포지션과 봇 장부가 같습니다' : '● 포지션 불일치'} <span class="muted">${r.checkedAt ? fZone(r.checkedAt) : ''}</span></div>
    ${r.rows.length ? `<table class="t compact"><thead><tr><th>종목</th><th>방향</th><th>거래소 수량</th><th>봇 장부 수량</th><th>차이</th><th>상태</th></tr></thead><tbody>
    ${r.rows.map((x) => `<tr><td class="l">${x.symbol}</td><td class="l side-${x.side}">${SIDE[x.side]}</td><td>${x.exchangeQty}</td><td>${x.internalQty}</td><td class="${x.diff ? 'warn' : ''}">${x.diffText}</td><td class="${x.status === 'OK' ? 'up' : x.status === 'SYNCING' ? 'warn' : 'down'}"><b>${{ OK: '일치', SYNCING: '동기화 중', MISMATCH: '불일치' }[x.status] || x.status}</b></td></tr>`).join('')}</tbody></table>` : '<div class="empty">거래소와 장부 모두 포지션 없음</div>'}`;
}

function renderPositions() {
  const d = P.data;
  const F = P.filter;
  let rows = d.positions.filter((p) => (F.cls === 'ALL' || (F.cls === 'CRYPTO' ? p.assetClass === 'CRYPTO' : p.assetClass === 'TRADFI_INDEX'))
    && (F.side === 'ALL' || p.side === F.side) && (F.st === 'ALL' || (F.st === 'QQQ' ? p.strategy.startsWith('QQQ_') : p.strategy === F.st)));
  const k = P.sort.k;
  rows = rows.slice().sort((a, b) => { const va = a[k] ?? -Infinity, vb = b[k] ?? -Infinity; return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * P.sort.dir; });
  const f = (sym) => d._filters?.[sym];
  const cols = [['assetClass', '자산군'], ['strategy', '전략'], ['symbol', '종목'], ['side', '방향'], ['leverage', '레버리지'], ['entryPrice', '진입가'], ['markPrice', '현재가'], ['qty', '수량'], ['positionValue', '가치'], ['margin', '증거금'], ['unrealized', '평가손익'], ['pnlPct', '수익률'], ['stopPrice', '손절가'], ['funding', '펀딩비'], ['holdingMs', '보유기간']];
  const arrow = (c) => (c === k ? (P.sort.dir < 0 ? ' ▼' : ' ▲') : '');
  $('#pfPositions').innerHTML = rows.length ? `<table class="t"><thead><tr>${cols.map(([c, l]) => `<th data-k="${c}" class="sortable ${['assetClass', 'strategy', 'symbol', 'side'].includes(c) ? 'l' : ''}">${l}${arrow(c)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((p) => `<tr class="${p.attributed ? '' : 'unattr'}" title="${esc(p.note || '')}"><td class="l">${p.assetClass === 'CRYPTO' ? '코인' : 'QQQ'}</td><td class="l"><b>${SHORT[p.strategy] || p.strategy}</b>${p.ctrlMultiplier != null && p.ctrlMultiplier !== 1 ? ` <span class="tag PENDING">×${p.ctrlMultiplier}</span>` : ''}</td><td class="l">${p.symbol}</td><td class="l side-${p.side}">${SIDE[p.side]}</td>
      <td>${p.leverage ? p.leverage + '배' : '—'}</td><td>${fPrice(p.entryPrice, f(p.symbol))}</td><td>${fPrice(p.markPrice, f(p.symbol))}</td><td>${p.qty}</td><td>${fNum(p.positionValue, 2)}</td><td>${fNum(p.margin, 2)}</td>
      <td class="${cls(p.unrealized)}">${fSigned(p.unrealized)}</td><td class="${cls(p.pnlPct)}">${p.pnlPct != null ? fPct(p.pnlPct) : '—'}</td>
      <td class="down">${p.stopPrice ? fPrice(p.stopPrice, f(p.symbol)) : p.attributed ? '없음' : '—'}${p.exStop ? ` <span class="tag ${p.exStop === 'NEW' ? 'LONG' : 'PENDING'}">거래소</span>` : ''}</td>
      <td class="${cls(p.funding)}">${p.funding != null ? fNum(p.funding, 4) : '—'}</td><td>${p.holdingMs != null ? fDur(p.holdingMs) : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">포지션 없음</div>';
}

function renderPnl() {
  const d = P.data;
  if (!d) return;
  const per = d.pnl[P.period];
  const g = per[P.group];
  const label = (k) => (P.group === 'byStrategy' ? SHORT[k] || k : P.group === 'byClass' ? (k === 'CRYPTO' ? '코인' : 'QQQ') : k);
  const rows = Object.entries(g).sort((a, b) => b[1].net - a[1].net).map(([k, v]) => `<tr><td class="l"><b>${label(k)}</b></td><td>${v.trades}</td><td class="${cls(v.gross)}">${fSigned(v.gross)}</td><td class="down">${fNum(-v.fees, 4)}</td><td class="${cls(v.funding)}">${fNum(v.funding, 4)}</td><td class="${cls(v.realized)}">${fSigned(v.realized)}</td><td class="${cls(v.unrealized)}">${fSigned(v.unrealized)}</td><td class="${cls(v.net)}"><b>${fSigned(v.net)}</b></td></tr>`).join('');
  const t = per.total;
  const ex = d.exchangeIncome?.[P.period];
  $('#pfPnl').innerHTML = `<table class="t compact"><thead><tr><th>${P.group === 'bySymbol' ? '종목' : P.group === 'byStrategy' ? '전략' : '자산군'}</th><th>거래수</th><th>매매손익</th><th>수수료</th><th>펀딩비</th><th>실현손익(순)</th><th>평가손익(보유 중)</th><th>합계</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8" class="l muted">거래 / 포지션 없음</td></tr>'}</tbody>
    <tfoot><tr><td>합계 (${LBL[P.period] || '전체'})</td><td>${t.trades}</td><td class="${cls(t.gross)}">${fSigned(t.gross)}</td><td class="down">${fNum(-t.fees, 4)}</td><td>${fNum(t.funding, 4)}</td><td class="${cls(t.realized)}">${fSigned(t.realized)}</td><td></td><td></td></tr>
    ${ex ? `<tr><td class="l">Binance 정산 기록</td><td></td><td class="${cls(ex.realized)}">${fSigned(ex.realized)}</td><td class="down">${fNum(ex.commission, 4)}</td><td>${fNum(ex.funding, 4)}</td><td class="${cls(ex.net)}">${fSigned(ex.net)}</td><td colspan="2" class="l muted">거래소 기록 (수동 거래 포함)</td></tr>` : ''}</tfoot></table>
    <div class="muted" style="padding:4px 10px">실현손익 = 기간 중 청산된 거래 (진입·청산 수수료와 펀딩 반영). 평가손익 = 현재 보유 중인 포지션.</div>`;
}

function renderCosts() {
  const c = P.data.costs;
  const row = (l, v, c2) => `<tr><td>${l}</td><td class="${c2 ?? cls(v)}">${fSigned(v)}</td></tr>`;
  $('#pfCosts').innerHTML = `<table class="t kv pf-costs"><tbody>${row('매매손익 (가격 변동)', c.gross)}${row('수수료 (진입 + 청산)', -c.fees, 'down')}${row('펀딩비 (받은 금액 − 낸 금액)', c.funding)}<tr class="grp"><td>순손익</td><td class="${cls(c.net)}"><b>${fSigned(c.net)}</b></td></tr></tbody></table>
    <div class="muted" style="padding:6px 10px">${P.data.mode === 'LIVE' ? '실전' : '모의투자'} 장부의 청산 거래 + 보유 포지션 기준. 슬리피지는 체결가에 포함.</div>`;
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
  P.series = P.chart.addSeries(LC.AreaSeries, { lineColor: '#f0b90b', topColor: 'rgba(240,185,11,.25)', bottomColor: 'rgba(240,185,11,0)', lineWidth: 2, title: '총 자산' });
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
  $('#pfDd').innerHTML = `${r.points.length}개 기록 (${LBL[P.range] || '전체'}) · 현재 하락 <b class="${dd?.currentPct > 0 ? 'down' : ''}">${dd?.currentPct != null ? '−' + dd.currentPct.toFixed(2) + '%' : '—'}</b> · 최대 하락 <b class="down">${dd?.maxPct != null ? '−' + dd.maxPct.toFixed(2) + '%' : '—'}</b> <span class="muted">저장된 계좌 자산 기준, 입출금 제외${P.overlay ? ' · 왼쪽 축: 전략별 누적 손익' : ''}</span>`;
}
