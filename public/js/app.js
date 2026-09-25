// HIC Trading Terminal — frontend (vanilla JS, lightweight-charts v5 standalone).
import { $, $$, esc, fUsd, fSigned, fPct, fNum, fPrice, fDur, fTime, fDateTime, cls, api, toast } from './util.js';
import { ChartView } from './chart.js';
import { renderStrategiesTab } from './settings.js';
import { confirmDialog, openApiModal } from './modals.js';
import { mountController, unmountController, controllerHeaderHtml, statusTag } from './controller.js';
import { renderScheduler, setSignals, addSignal, scheduleLine } from './scheduler.js';
import { mountPortfolio, update as updatePortfolio } from './portfolio.js';
import { mountBacktest } from './backtest.js';
import { SIDE, MODE, STATUS, EXIT, ORDER_STATUS, STRAT, TF, sigKo } from './ko.js';

const SHORT = { TURTLE: '터틀', ADX: 'ADX', TSMOM: 'TSMOM', RAYNER: 'Rayner', TREND_RIDER: '추세 라이더', QQQ_EMA_TREND: 'QQQ EMA 추세', QQQ_TSMOM: 'QQQ TSMOM', QQQ_SMA200: 'QQQ SMA200', QQQ_TURTLE_50_20: 'QQQ 터틀 50/20' };
const CHIP = { TURTLE: '터틀', ADX: 'ADX', TSMOM: 'TSM', RAYNER: 'RAY', TREND_RIDER: 'RDR', QQQ_EMA_TREND: 'EMA', QQQ_TSMOM: 'TSM', QQQ_SMA200: 'SMA', QQQ_TURTLE_50_20: 'T50' };
const stratsOf = (sym) => S.meta.strategiesBySymbol[sym] || [];
const classOf = (sym) => S.meta.symbolMeta[sym]?.asset_class || 'CRYPTO';
const isLongOnly = (st) => !S.meta.supportsShort[st];
const levSummary = () => Object.entries(S.config.strategies).filter(([, c]) => c.enabled).map(([n, c]) => `${n} ${c.leverage ?? 1}배`).join(' · ');
const S = {
  snap: null, config: null, meta: null, sel: localGet('sel', 'BTCUSDT'), tab: 'positions',
  logs: [], logFilter: 'ALL', errCount: 0, view: localGet('view', 'terminal'), portfolio: null,
};

function localGet(k, d) { try { return localStorage.getItem(`hic.${k}`) ?? d; } catch { return d; } }
function localSet(k, v) { try { localStorage.setItem(`hic.${k}`, v); } catch { /* ignore */ } }

const chart = new ChartView($('#chart'), $('#ctLegend'), $('#chartMsg'));

// ---------------- bootstrap
async function init() {
  const c = await api('GET', '/api/config');
  S.config = c.config; S.meta = c.meta;
  buildIntervalSeg();
  bindUi();
  selectSymbol(S.sel);
  setView(S.view);
  connectWs();
}

function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'snapshot') { S.snap = m.data; render(); }
    else if (m.type === 'kline') chart.onKline(m.data);
    else if (m.type === 'portfolio') { S.portfolio = m.data; if (S.snap) S.portfolio._filters = Object.fromEntries(Object.entries(S.snap.symbols).map(([k, v]) => [k, v.filters])); if (S.view === 'portfolio') updatePortfolio(S.portfolio); }
    else if (m.type === 'signals') { setSignals(m.data); if (S.tab === 'scheduler') renderBottom(); }
    else if (m.type === 'signal') { addSignal(m.data); if (S.tab === 'scheduler') renderBottom(true); }
    else if (m.type === 'log') addLogs([m.data]);
    else if (m.type === 'logs') { S.logs = []; $('#logList').innerHTML = ''; addLogs(m.data); }
  };
  ws.onclose = () => {
    $('#sMarket').className = 'dot bad'; $('#sMarket').textContent = '서버 꺼짐';
    setTimeout(connectWs, 2000);
  };
}

// ---------------- UI bindings
function setView(v) {
  S.view = ['portfolio', 'backtest'].includes(v) ? v : 'terminal';
  localSet('view', S.view);
  document.body.classList.toggle('view-portfolio', S.view !== 'terminal');
  $('#portfolio').classList.toggle('hidden', S.view !== 'portfolio');
  $('#backtest').classList.toggle('hidden', S.view !== 'backtest');
  if (S.view === 'backtest') mountBacktest($('#backtest'));
  $$('#viewSwitch button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
  if (S.view === 'portfolio') { mountPortfolio($('#portfolio'), S.meta); if (S.portfolio) updatePortfolio(S.portfolio); } else chart.resize();
}

function bindUi() {
  $('#viewSwitch').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    S.tab = b.dataset.tab;
    $$('#tabs button[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab-pane').forEach((p) => p.classList.toggle('on', p.id === `tab-${S.tab}`));
    if (S.tab === 'strategies') openStrategies();
    if (S.tab === 'controller') mountController($('#tab-controller')); else unmountController();
    if (S.tab === 'log') { S.errCount = 0; updateErrBadge(); scrollLog(); }
    renderBottom(true);
  });
  $('#btnMax').onclick = () => { document.body.classList.toggle('bottom-max'); chart.resize(); };
  $('#logBar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    S.logFilter = b.dataset.f;
    $$('#logBar button').forEach((x) => x.classList.toggle('on', x === b));
    rebuildLog();
  });
  $('#toggleSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-t]');
    if (!b) return;
    b.classList.toggle('on');
    chart.setToggle(b.dataset.t, b.classList.contains('on'));
    if (S.snap) chart.updateOverlays(S.snap, S.sel);
  });
  $$('#toggleSeg button').forEach((b) => chart.setToggle(b.dataset.t, b.classList.contains('on')));

  $('#btnStart').onclick = async () => {
    const live = S.snap?.mode === 'LIVE';
    let body = {};
    if (live) {
      const w = await confirmDialog({ title: '실전 자동매매 시작', danger: true, word: 'LIVE',
        html: `<p>실계좌(<b>${S.snap.conn.testnet ? '테스트넷' : '실제 계좌'}</b>)에서 자동매매를 시작합니다.</p><p>전략별 레버리지(${levSummary()})와 실전 주문금액이 적용됩니다.</p>` });
      if (!w) return;
      body = { confirm: 'LIVE' };
    }
    const r = await api('POST', '/api/bot/start', body);
    r.ok ? toast('봇을 시작했습니다', 'ok') : toast(r.msg, 'err');
  };
  $('#btnStop').onclick = async () => {
    const ok = await confirmDialog({ title: '봇 전체 정지', danger: true,
      html: `<p>모든 전략 실행과 신규 주문을 중단합니다.</p><p><b>기존 포지션은 청산되지 않습니다.</b> 손절(Stop)은 ${S.snap?.stopsActiveWhenStopped ? '<span class="up">계속 동작</span>' : '<span class="down">중단</span>'}합니다 (전략 설정 › 공통 설정).</p>`, okText: '봇 전체 정지' });
    if (!ok) return;
    const r = await api('POST', '/api/bot/stop');
    r.ok ? toast('모든 봇을 정지했습니다', 'ok') : toast(r.msg, 'err');
  };
  $('#btnCloseAll').onclick = async () => {
    const n = S.snap?.positions.length || 0;
    if (!n) return toast('보유 포지션이 없습니다');
    const w = await confirmDialog({ title: '전체 포지션 청산', danger: true, word: 'CLOSE ALL',
      html: `<p><b>${MODE[S.snap.mode]}</b> 모드의 포지션 <b>${n}개</b>를 모두 시장가로 청산합니다 (청산 사유: 전체 비상청산).</p><p>봇 실행 상태는 변경되지 않습니다.</p>` });
    if (!w) return;
    const r = await api('POST', '/api/positions/close-all', { confirm: 'CLOSE ALL' });
    r.ok ? toast('모든 포지션을 청산했습니다', 'ok') : toast(r.msg || '일부 청산 실패 — 시스템 로그 확인', 'err');
  };
  $('#btnApi').onclick = () => openApiModal();
  $('#modeSwitch').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.disabled || b.dataset.mode === S.snap?.mode) return;
    const mode = b.dataset.mode;
    let body = { mode };
    if (mode === 'LIVE') {
      const w = await confirmDialog({ title: '실전 모드로 전환', danger: true, word: 'LIVE',
        html: '<p>실전 모드에서는 실제 Binance 선물 계좌로 주문합니다.</p><p>전환 후에도 [봇 시작]을 눌러야 자동매매가 시작됩니다.</p>' });
      if (!w) return;
      body.confirm = 'LIVE';
    }
    const r = await api('POST', '/api/mode', body);
    if (r.ok) { toast(`모드: ${MODE[mode]}`, 'ok'); await reloadConfig(); } else toast(r.msg, 'err');
  });

  // delegated actions in bottom tables
  $('#tabBody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-close]');
    if (b) {
      const [strategy, symbol] = b.dataset.close.split(':');
      const ok = await confirmDialog({ title: '포지션 청산', danger: true, html: `<p><b>${SHORT[strategy] || strategy} ${symbol}</b> 포지션을 시장가로 청산합니다 (수동 청산).</p>`, okText: '청산' });
      if (!ok) return;
      const r = await api('POST', '/api/positions/close', { strategy, symbol });
      r.ok ? toast('포지션을 청산했습니다', 'ok') : toast(r.msg, 'err');
    }
    const row = e.target.closest('[data-sym]');
    if (row && !b) selectSymbol(row.dataset.sym);
  });
  $('#wlBody').addEventListener('click', (e) => { const r = e.target.closest('[data-sym]'); if (r) selectSymbol(r.dataset.sym); });
  window.addEventListener('resize', () => chart.resize());
  window.addEventListener('hic:config', reloadConfig);
}

async function reloadConfig() {
  const c = await api('GET', '/api/config');
  S.config = c.config;
  if (S.tab === 'strategies') openStrategies();
}

function openStrategies() {
  renderStrategiesTab($('#tab-strategies'), S, reloadConfig);
}

function buildIntervalSeg() {
  const cur = localGet('iv', '1d');
  // main intervals as buttons, every other Binance interval in the "기타" dropdown
  const main = S.meta.intervals;
  const more = (S.meta.chartIntervals || []).filter((i) => !main.includes(i));
  $('#intervalSeg').innerHTML = [...main, S.meta.sessionInterval].map((i) => `<button data-iv="${i}" class="${i === cur ? 'on' : ''}" ${i === S.meta.sessionInterval ? 'title="미국 정규장 일봉 (QQQ 신호 기준)"' : ''}>${i === S.meta.sessionInterval ? '미국장 1일' : TF[i] || i}</button>`).join('')
    + (more.length ? `<select id="ivMore" class="${more.includes(cur) ? 'on' : ''}" title="다른 캔들 시간"><option value="">기타</option>${more.map((i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${TF[i] || i}</option>`).join('')}</select>` : '');
  chart.interval = cur;
  const pick = (iv) => {
    $$('#intervalSeg button').forEach((x) => x.classList.toggle('on', x.dataset.iv === iv));
    const sel = $('#ivMore');
    if (sel) { sel.value = more.includes(iv) ? iv : ''; sel.classList.toggle('on', more.includes(iv)); }
    chart.interval = iv;
    localSet('iv', iv);
    chart.load(S.sel).then(() => S.snap && chart.updateOverlays(S.snap, S.sel));
  };
  $('#intervalSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-iv]'); if (b) pick(b.dataset.iv); });
  $('#ivMore')?.addEventListener('change', (e) => { if (e.target.value) pick(e.target.value); });
}

function selectSymbol(sym) {
  if (!S.meta.symbols.includes(sym)) sym = S.meta.symbols[0];
  S.sel = sym;
  localSet('sel', sym);
  const isSession = S.meta.symbolMeta[sym]?.session === 'US_REGULAR_MARKET';
  const sb = $(`#intervalSeg button[data-iv="${S.meta.sessionInterval}"]`);
  if (sb) sb.style.display = isSession ? '' : 'none';
  if (!isSession && chart.interval === S.meta.sessionInterval) {
    chart.interval = '1d';
    $$('#intervalSeg button').forEach((x) => x.classList.toggle('on', x.dataset.iv === '1d'));
    if ($('#ivMore')) { $('#ivMore').value = ''; $('#ivMore').classList.remove('on'); }
  }
  chart.load(sym).then(() => S.snap && chart.updateOverlays(S.snap, sym));
  if (S.snap) render();
}

// ---------------- render
function render() {
  const s = S.snap;
  if (!s) return;
  renderTop(s);
  renderWatchlist(s);
  renderRight(s);
  renderSummary(s);
  renderBottom();
  chart.updateOverlays(s, S.sel);
}

function renderTop(s) {
  const a = s.account;
  const live = s.mode === 'LIVE';
  const mb = $('#modeBadge');
  mb.textContent = live ? (s.conn.testnet ? '실전·테스트' : '실전') : '모의투자';
  mb.className = `mode-badge ${live ? 'live' : 'paper'}`;
  $$('#modeSwitch button').forEach((b) => { b.classList.toggle('on', b.dataset.mode === s.mode); b.disabled = s.runState === 'RUNNING'; });
  document.title = `${a.equity != null ? fUsd(a.equity, 0) : '—'} · ${MODE[s.mode]} ${STATUS[s.runState] || s.runState} — HIC`;

  // LIVE: total of every Binance wallet (spot + futures + ...); futures USDT margin shown below it
  const w = live ? s.wallets : null;
  $('#kEquity').textContent = w?.total != null ? fUsd(w.total) : a.equity != null ? fUsd(a.equity) : '—';
  $('#kEqCcy').textContent = w?.total != null ? 'USDT · 전체 지갑' : 'USDT';
  $('#kEqSub').textContent = w?.total != null ? `선물 ${fUsd(a.equity)}` : live && w?.error ? '전체 지갑 조회 실패 · 선물만' : '';
  $('#kEqSub').title = w?.error || '';
  setSigned($('#kToday'), a.todayPnl, fSigned(a.todayPnl));
  $('#kTodayPct').textContent = a.baseCapital ? fPct(a.todayPnl / a.baseCapital * 100) : '';
  setSigned($('#kReturn'), a.totalReturnPct, a.totalReturnPct != null ? fPct(a.totalReturnPct) : '—');
  $('#kBase').textContent = a.baseCapital ? `원금 ${fUsd(a.baseCapital, 0)}` : '원금 미설정';
  $('#kAvail').textContent = a.available != null ? fUsd(a.available) : '—';
  $('#kInvested').textContent = fUsd(a.invested);
  setSigned($('#kTotalPnl'), a.totalPnl, fSigned(a.totalPnl));
  $('#kLong').textContent = fUsd(a.longExp);
  $('#kShort').textContent = fUsd(a.shortExp);
  setSigned($('#kNet'), a.netExp, fSigned(a.netExp));

  setDot($('#sMarket'), s.conn.market === 'CONNECTED' ? 'ok' : 'bad', STATUS[s.conn.market] || s.conn.market);
  const ex = s.conn.exchange;
  setDot($('#sExchange'), ex === 'CONNECTED' ? 'ok' : ex === 'PAPER' ? 'off' : ex === 'NO_KEYS' || ex === 'UNVERIFIED' ? 'warn' : 'bad', ex === 'PAPER' ? '해당없음(모의)' : STATUS[ex] || ex);
  $('#sExchange').title = s.conn.liveError || '';
  setDot($('#sBot'), s.runState === 'RUNNING' ? 'ok' : 'bad', STATUS[s.runState] || s.runState);
  const age = s.lastDataUpdate ? (Date.now() - s.lastDataUpdate) / 1000 : null;
  const rc = s.reconciliation;
  if (rc) {
    if (rc.na === 'PAPER') setDot($('#sRecon'), 'off', '모의');
    else if (rc.na) setDot($('#sRecon'), 'warn', '대기');
    else setDot($('#sRecon'), rc.ok ? 'ok' : 'bad', rc.ok ? '일치' : '불일치');
    $('#sRecon').title = (rc.warnings || []).join('\n');
  }
  if (s.risk) {
    setDot($('#sRisk'), s.risk.liquidation?.length ? 'bad' : s.risk.stopsActive ? 'ok' : 'warn', `${s.risk.stopsActive ? '작동' : '꺼짐'} ${s.risk.watched}개`);
    $('#sRisk').title = `실시간 손절 감시: ${s.risk.watched}개 포지션을 가격이 바뀔 때마다 확인${s.risk.nearStop?.length ? ` · ${s.risk.nearStop.length}개 손절가 1% 이내` : ''}${s.risk.liquidation?.length ? ' · 청산 위험' : ''}`;
  }
  $('#sLast').innerHTML = s.lastDataUpdate ? `<span class="${age > 10 ? 'down' : ''}">${fTime(s.lastDataUpdate)}</span>` : '—';
  $('#btnStart').disabled = s.runState === 'RUNNING';
  $('#btnStop').disabled = s.runState !== 'RUNNING';
}

function setSigned(el, v, text) { el.textContent = text; el.className = cls(v); }
function setDot(el, k, t) { el.className = `dot ${k}`; el.textContent = t; }

function slotOf(s, st, sym) { return s.slots.find((x) => x.strategy === st && x.symbol === sym); }
function stLetter(status) {
  return { LONG: ['L', '롱'], SHORT: ['S', '숏'], FLAT: ['W', '대기'], PENDING: ['P', '주문중'], UNKNOWN: ['U', '확인중'], OFF: ['O', '꺼짐'] }[status] || ['W', status];
}

function renderWatchlist(s) {
  let lastClass = null;
  $('#wlBody').innerHTML = S.meta.symbols.map((sym) => {
    const c = classOf(sym);
    const head = c !== lastClass ? `<div class="wl-group">${S.meta.classLabel[c]}</div>` : '';
    lastClass = c;
    return head + wlRow(s, sym);
  }).join('');
  expTable(s);
}

function wlRow(s, sym) {
    const m = s.symbols[sym];
    const t = m.ticker;
    const f = m.filters;
    const e = s.account.bySymbol[sym];
    const netTag = e.long > 0 && e.short > 0 ? 'MIXED' : e.long > 0 ? 'LONG' : e.short > 0 ? 'SHORT' : 'FLAT';
    const netKo = { MIXED: '롱+숏', LONG: '롱', SHORT: '숏', FLAT: '없음' }[netTag];
    const chips = stratsOf(sym).map((st) => {
      const sl = slotOf(s, st, sym);
      let [k, label] = stLetter(sl.status);
      if (isLongOnly(st) && sl.status === 'FLAT') { k = 'W'; label = '현금'; }
      return `<div class="st-chip"><i>${CHIP[st]}</i><span class="st-${k}">${label}</span></div>`;
    }).join('');
    const um = m.underlyingMarket;
    const uv = m.universe;
    const sub = m.unavailable ? '<span class="tag SHORT" title="' + esc(m.unavailable) + '">사용 불가</span>'
      : uv && !uv.tradeAllowed ? '<span class="tag WAIT" title="거래대금 진입 순위 밖: 신규 진입 없음, 보유 포지션·손절·청산은 계속 관리">감시만</span>'
      : um ? `<span class="tag ${um.underlying === 'OPEN' ? 'LONG' : 'WAIT'}" title="미국 정규장 상태">미국장 ${um.underlying === 'OPEN' ? '개장' : '폐장'}</span>` : '';
    return `<div class="wl-row ${sym === S.sel ? 'sel' : ''}" data-sym="${sym}">
      <div class="wl-top"><span class="wl-sym">${uv ? `<span class="wl-rank" title="24시간 거래대금 순위${uv.quoteVolume != null ? ` · ${fNum(uv.quoteVolume / 1e6, 0)}M USDT` : ''}">#${uv.rank ?? '-'}</span>` : ''}${sym.replace('USDT', '')}<small>USDT</small></span><span class="wl-px ${cls(t?.changePct)}">${fPrice(m.price, f)}</span></div>
      <div class="wl-mid"><span><span class="tag ${netTag}">${netKo}</span> ${sub}</span><span class="${cls(t?.changePct)}">${t ? fPct(t.changePct) : '—'}</span></div>
      <div class="wl-strats ${stratsOf(sym).length > 3 ? 'four' : ''}">${chips}</div></div>`;
}

function expTable(s) {
  const a = s.account;
  const row = (sym) => { const e = a.bySymbol[sym]; return `<tr data-sym="${sym}"><td>${sym.replace('USDT', '')}</td><td class="up">${fNum(e.long, 0)}</td><td class="down">${fNum(e.short, 0)}</td><td class="${cls(e.net)}">${fSigned(e.net, 0)}</td></tr>`; };
  const body = S.meta.assetClasses.map((c) => {
    const k = a.byClass?.[c] || { long: 0, short: 0, net: 0 };
    const syms = S.meta.symbols.filter((x) => classOf(x) === c);
    return `<tr class="grp"><td>${S.meta.classLabel[c]}</td><td class="up">${fNum(k.long, 0)}</td><td class="down">${fNum(k.short, 0)}</td><td class="${cls(k.net)}">${fSigned(k.net, 0)}</td></tr>${syms.map(row).join('')}`;
  }).join('');
  $('#expTable').innerHTML = `<thead><tr><th>종목</th><th>롱</th><th>숏</th><th>순</th></tr></thead><tbody>${body}</tbody>
    <tfoot><tr><td>합계</td><td class="up">${fNum(a.longExp, 0)}</td><td class="down">${fNum(a.shortExp, 0)}</td><td class="${cls(a.netExp)}">${fSigned(a.netExp, 0)}</td></tr>
    <tr><td>총 규모</td><td colspan="3">${fNum(a.grossExp, 0)} · 코인 ${fNum(a.byClass?.CRYPTO?.gross, 0)} · QQQ ${fNum(a.byClass?.TRADFI_INDEX?.gross, 0)}</td></tr></tfoot>`;
}

function renderRight(s) {
  const sym = S.sel;
  const m = s.symbols[sym];
  const f = m.filters;
  const t = m.ticker || {};
  const mk = m.mark || {};
  const e = s.account.bySymbol[sym];
  $('#rSym').textContent = sym;
  $('#ctSymbol').textContent = sym;
  $('#ctPrice').textContent = fPrice(m.price, f);
  $('#ctPrice').className = `ct-price ${cls(t.changePct)}`;
  $('#ctChange').innerHTML = t.changePct != null ? `<span class="${cls(t.changePct)}">${fSigned(t.change, f ? decimals(f.tickSize) : 2)} (${fPct(t.changePct)})</span>` : '';
  const nf = mk.nextFundingTime ? fDur(mk.nextFundingTime - Date.now()) : '—';
  $('#mktTable').innerHTML = [
    ['현재가 / 마크가', `${fPrice(m.price, f)} / ${fPrice(mk.price, f)}`],
    ['24시간 변동', `<span class="${cls(t.changePct)}">${t.changePct != null ? fPct(t.changePct) : '—'}</span>`],
    ['24시간 고가 / 저가', `${fPrice(t.high, f)} / ${fPrice(t.low, f)}`],
    ['24시간 거래대금', t.quoteVol != null ? `${fNum(t.quoteVol / 1e6, 1)}M USDT` : '—'],
    ['펀딩비 / 다음 정산', `<span class="${cls(-(mk.fundingRate || 0))}">${mk.fundingRate != null ? (mk.fundingRate * 100).toFixed(4) + '%' : '—'}</span> / ${nf}`],
    ['투자 규모 롱 / 숏', `<span class="up">${fNum(e.long, 0)}</span> / <span class="down">${fNum(e.short, 0)}</span>`],
    ['순 노출', `<span class="${cls(e.net)}">${fSigned(e.net, 0)}</span> · 손익 <span class="${cls(e.pnl)}">${fSigned(e.pnl)}</span>`],
    ['최소 주문액 / 수량 단위', f ? `${f.minNotional} / ${f.stepSize}` : '—'],
    ...(m.universe ? [['거래대금 순위', `#${m.universe.rank ?? '-'} · ${m.universe.tradeAllowed ? '<span class="up">신규진입 가능</span>' : '<span class="warn">감시만 (신규진입 안 함)</span>'}`]] : []),
    ...(m.underlyingMarket ? [
      ['자산 종류', `미국 지수 <span class="muted">${esc(m.underlying)}</span>`],
      ['미국 정규장', `<span class="${m.underlyingMarket.underlying === 'OPEN' ? 'up' : 'muted'}">${m.underlyingMarket.underlying === 'OPEN' ? '개장' : '폐장'}</span> <span class="muted">${m.underlyingMarket.underlying === 'OPEN' ? fTime(m.underlyingMarket.closesAt) + ' 마감' : m.underlyingMarket.nextOpen ? fDateTime(m.underlyingMarket.nextOpen) + ' 개장' : ''}</span>`],
      [`Binance ${sym}`, m.unavailable ? `<span class="down">사용 불가</span>` : `<span class="up">${f?.status === 'TRADING' ? '거래 가능' : esc(f?.status || '—')}</span> <span class="muted">24시간</span>`],
      ['신호 데이터', `미국 정규장 일봉 ${m.signalCandles}개`],
      ['과거 데이터', `<span class="warn">제한적</span> <span class="muted">(Binance 2026-04-06 상장)</span>`],
    ] : []),
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  $('#stratStatus').innerHTML = stratsOf(sym).map((st) => stratCard(s, st, sym, f)).join('');
  renderOrderBook(m, f);
}

function stratCard(s, st, sym, f) {
  const sl = slotOf(s, st, sym);
  const cfg = S.config.strategies[st];
  const amt = cfg.amounts[s.mode];
  const p = s.positions.find((x) => x.strategy === st && x.symbol === sym);
  let [, label] = stLetter(sl.status);
  if (isLongOnly(st) && sl.status === 'FLAT') label = '현금';
  const tagCls = sl.status === 'FLAT' ? 'WAIT' : sl.status;
  const v = sl.view || {};
  const rows = [];
  const add = (k, val, c = '') => rows.push(`<div><span>${k}</span><span class="${c}">${val}</span></div>`);
  if (p) {
    add('진입가', fPrice(p.entryPrice, f));
    add('현재가', fPrice(p.markPrice, f));
    add('수익률', `${fPct(p.pricePct)}`, cls(p.pricePct));
    add('순손익', fSigned(p.pnl), cls(p.pnl));
    add('주문금액', `${fNum(p.orderAmount, 0)} USDT`);
    add('손절가', p.stopPrice ? fPrice(p.stopPrice, f) : '없음', 'down');
  } else {
    add('롱 주문금액', `${fNum(amt.long, 0)} USDT`);
    add('숏 주문금액', isLongOnly(st) ? '롱 전용' : cfg.shortEnabled ? `${fNum(amt.short, 0)} USDT` : '꺼짐');
  }
  const tf = (s.scheduler || []).find((r) => r.strategy === st && r.symbol === sym);
  const U = tf && tf.timeframe !== '1d' && TF[tf.timeframe] ? `봉(${TF[tf.timeframe]})` : '일';
  if (st === 'TURTLE') {
    const pp = cfg.params;
    add(`${pp.entryPeriod}${U} 최고가`, fPrice(v.entryHigh, f)); add(`${pp.entryPeriod}${U} 최저가`, fPrice(v.entryLow, f));
    add(`${pp.exitPeriod}${U} 최저가`, fPrice(v.exitLow, f)); add(`${pp.exitPeriod}${U} 최고가`, fPrice(v.exitHigh, f));
    add('SMA200', fPrice(v.sma, f), v.sma && s.symbols[sym].price < v.sma ? 'down' : 'up');
  } else if (st === 'ADX') {
    add('ADX', fNum(v.adx, 1), v.adx > cfg.params.threshold ? 'warn' : '');
    add('+DI / -DI', `<span class="up">${fNum(v.plusDI, 1)}</span>/<span class="down">${fNum(v.minusDI, 1)}</span>`);
    add('SMA200', fPrice(v.sma, f), v.sma && s.symbols[sym].price < v.sma ? 'down' : 'up');
  } else if (st === 'TSMOM') {
    add('30일 모멘텀', v.momentumPct != null ? fPct(v.momentumPct) : '—', cls(v.momentumPct));
  } else if (st === 'TREND_RIDER') {
    const pp = cfg.params;
    add(`${pp.entryPeriod}${U} 최고가 / 최저가`, `${fPrice(v.entryHigh, f)} / ${fPrice(v.entryLow, f)}`);
    add(`SMA${pp.smaFilter}`, fPrice(v.sma, f), v.sma && s.symbols[sym].price < v.sma ? 'down' : 'up');
    add('롱 추적 청산선', fPrice(v.longTrail, f), 'down'); add('숏 추적 청산선', fPrice(v.shortTrail, f), 'up');
  } else if (st === 'RAYNER') {
    const pp = cfg.params;
    const hd = (x) => (x == null ? '—' : Math.abs(x) >= 1 ? fNum(x, 3) : Number(x).toPrecision(4));
    add(`EMA${pp.emaPeriod}`, fPrice(v.ema, f), v.ema && s.symbols[sym].price < v.ema ? 'down' : 'up');
    add('MACD 히스토그램', hd(v.hist), cls(v.hist));
    // with a position: the target fixed at entry (never updated), otherwise the current 25-bar extreme
    add(`롱 히스토그램 목표${p?.side === 'LONG' ? ' (진입 고정)' : ''}`, hd(p?.side === 'LONG' && p.histTarget != null ? p.histTarget : v.longTarget));
    add(`숏 히스토그램 목표${p?.side === 'SHORT' ? ' (진입 고정)' : ''}`, hd(p?.side === 'SHORT' && p.histTarget != null ? p.histTarget : v.shortTarget));
    add('추세 내 진입 (롱/숏)', `${sl.trendCount?.LONG ?? 0} / ${sl.trendCount?.SHORT ?? 0} (최대 ${pp.maxEntriesPerTrend})`);
    if (!p) add('구조 손절 (롱/숏)', `${fPrice(v.longStop, f)} / ${fPrice(v.shortStop, f)}`);
  } else if (st === 'QQQ_EMA_TREND') {
    add(`EMA${cfg.params.fastEma}`, fPrice(v.fastEma, f), v.fastEma > v.slowEma ? 'up' : 'down');
    add(`EMA${cfg.params.slowEma}`, fPrice(v.slowEma, f));
  } else if (st === 'QQQ_TSMOM') {
    add(`${cfg.params.lookback}세션 모멘텀`, v.momentumPct != null ? fPct(v.momentumPct) : '—', cls(v.momentumPct));
  } else if (st === 'QQQ_SMA200') {
    add(`SMA${cfg.params.smaPeriod}`, fPrice(v.sma, f));
    add('추세', v.sma == null ? '—' : v.above ? '위' : '아래', v.above ? 'up' : 'down');
  } else if (st === 'QQQ_TURTLE_50_20') {
    add(`${cfg.params.entryPeriod}세션 최고가`, fPrice(v.entryHigh, f)); add(`${cfg.params.exitPeriod}세션 최저가`, fPrice(v.exitLow, f));
  }
  if (!p && sl.pending == null) add('청산 규칙', sl.exitRule);
  const notes = [];
  if (p) notes.push(`청산: ${sl.exitRule}${p.stopPct ? ` · 손절폭 ${p.stopPct.toFixed(1)}%` : ''}${p.exStop ? ` · 거래소 손절주문 <span class="${p.exStop.status === 'NEW' ? 'up' : 'warn'}">${ORDER_STATUS[p.exStop.status] || p.exStop.status}</span>` : ''}`);
  if (sl.pending) notes.push(`<span class="warn">주문 처리 중: ${sl.pending.action === 'OPEN' ? '진입' : '청산'} ${SIDE[sl.pending.side]} ${sl.pending.clientOrderId}</span>`);
  if (sl.block?.LONG || sl.block?.SHORT) notes.push('<span class="warn">재진입 대기: 손절 후 조건이 한 번 꺼질 때까지 대기</span>');
  if (v.notReady) notes.push(`<span class="warn">${esc(v.notReady)}</span>`);
  if (tf) notes.push(scheduleLine(tf));
  if (sl.evalCandle) notes.push(`마지막 신호: ${esc(sigKo(sl.lastSignal || ''))}`);
  if (!cfg.enabled) notes.push('<span class="muted">꺼짐 (선택 전략)</span>');
  return `<div class="strat-card"><div class="sc-h"><b>${SHORT[st]}</b><span class="tag ${tagCls}">${p ? SIDE[p.side] : label}</span></div>
    <div class="sc-grid">${rows.join('')}</div><div class="sc-note">${notes.join('<br>')}</div></div>`;
}

function renderOrderBook(m, f) {
  const d = m.depth;
  if (!d) { $('#orderBook').innerHTML = '<div class="empty">호가 없음</div>'; return; }
  const n = 9;
  const asks = d.asks.slice(0, n).reverse();
  const bids = d.bids.slice(0, n);
  const max = Math.max(...asks.map((x) => x[1]), ...bids.map((x) => x[1]), 1e-9);
  const row = (x, side) => `<div class="ob-row ${side}"><div class="bar" style="width:${(x[1] / max) * 100}%"></div><span class="${side === 'ask' ? 'down' : 'up'}">${fPrice(x[0], f)}</span><span>${fNum(x[1], 3)}</span><span>${fNum(x[0] * x[1], 0)}</span></div>`;
  const spread = d.asks[0] && d.bids[0] ? d.asks[0][0] - d.bids[0][0] : null;
  $('#orderBook').innerHTML = `<div class="ob-row" style="color:var(--mute)"><span>가격</span><span>수량</span><span>USDT</span></div>
    ${asks.map((x) => row(x, 'ask')).join('')}
    <div class="ob-mid"><span>${fPrice(m.price, f)}</span><span class="muted" style="font-size:11px">스프레드 ${spread != null ? fPrice(spread, f) : '—'}</span></div>
    ${bids.map((x) => row(x, 'bid')).join('')}`;
}

function renderSummary(s) {
  $('#sumMode').textContent = `${MODE[s.mode]} 설정금액 → 실제 주문금액`;
  $('#sumCtl').innerHTML = controllerHeaderHtml(s.controller);
  const ctl = (st, side) => s.controller?.rows?.find((r) => r.strategy === st && r.side === side);
  const ctlCell = (st, side) => {
    const r = ctl(st, side);
    if (!r || !r.active) return '<span class="muted">—</span>';
    const applied = r.applied === 'NOT_APPLIED' || r.applied === 'OFF' ? null : r.applied;
    return `${statusTag(r.recommended, r.recommendedMult)}${applied ? '' : ' <span class="muted">관찰</span>'}`;
  };
  const amt = (base, actual) => (Math.abs(actual - base) < 1e-9 ? fNum(base, 0) : `${fNum(base, 0)}→<b class="warn">${fNum(actual, 0)}</b>`);
  let lastC = null;
  const rows = s.strategies.map((x) => { const g = x.assetClass !== lastC ? `<tr class="grp"><td colspan="10">${S.meta.classLabel[x.assetClass]}</td></tr>` : ''; lastC = x.assetClass; return g + `<tr><td><b>${SHORT[x.strategy] || x.strategy}</b></td>
    <td class="${x.enabled ? 'up' : 'down'}">${x.enabled ? '켜짐' : '꺼짐'}</td>
    <td>${amt(x.longAmount, x.longActual)}</td><td>${isLongOnly(x.strategy) ? '롱 전용' : x.shortEnabled ? amt(x.shortAmount, x.shortActual) : '꺼짐'}</td>
    <td class="l">롱 ${ctlCell(x.strategy, 'LONG')}${isLongOnly(x.strategy) ? '' : ` 숏 ${ctlCell(x.strategy, 'SHORT')}`}</td>
    <td><span class="up">롱 ${x.longs}</span> / <span class="down">숏 ${x.shorts}</span></td>
    <td class="${cls(x.unrealized)}">${fSigned(x.unrealized)}</td><td class="${cls(x.realized)}">${fSigned(x.realized)}</td>
    <td>${x.trades}</td><td>${x.winRate != null ? x.winRate.toFixed(0) + '%' : '—'}</td></tr>`; }).join('');
  const tu = s.strategies.reduce((a, x) => a + x.unrealized, 0), tr = s.strategies.reduce((a, x) => a + x.realized, 0);
  $('#stratSumTable').innerHTML = `<thead><tr><th>전략</th><th>상태</th><th>롱 금액</th><th>숏 금액</th><th class="l">자동 조절</th><th>보유</th><th>평가손익</th><th>실현손익</th><th>거래수</th><th>승률</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><td>합계</td><td></td><td></td><td></td><td></td><td>${s.positions.length}</td><td class="${cls(tu)}">${fSigned(tu)}</td><td class="${cls(tr)}">${fSigned(tr)}</td><td>${s.trades.length}</td><td></td></tr></tfoot>`;
  const a = s.account;
  $('#acctTable').innerHTML = [
    ['지갑 잔고', a.wallet != null ? fUsd(a.wallet) : '—'],
    ['평가손익(순)', `<span class="${cls(a.unrealizedNet)}">${fSigned(a.unrealizedNet)}</span>`],
    ['실현손익(순)', `<span class="${cls(a.realized)}">${fSigned(a.realized)}</span>`],
    ['코인 손익', `<span class="${cls(a.byClass?.CRYPTO?.pnl)}">${fSigned(a.byClass?.CRYPTO?.pnl)}</span>`],
    ['QQQ 손익', `<span class="${cls(a.byClass?.TRADFI_INDEX?.pnl)}">${fSigned(a.byClass?.TRADFI_INDEX?.pnl)}</span>`],
    ['누적 손익', `<span class="${cls(a.totalPnl)}">${fSigned(a.totalPnl)}</span>`],
    ['총 / 코인 / QQQ 규모', `${fNum(a.grossExp, 0)} / ${fNum(a.byClass?.CRYPTO?.gross, 0)} / ${fNum(a.byClass?.TRADFI_INDEX?.gross, 0)}`],
    ['원금', a.baseCapital ? fUsd(a.baseCapital) : '—'],
    ['레버리지', `${levSummary()}${s.mode === 'LIVE' && s.conn.hedgeMode != null ? ` · ${s.conn.hedgeMode ? '양방향(Hedge)' : '<span class="down">단방향</span>'}` : ''}`],
    ['수수료 / 슬리피지', `${S.config.general.takerFeePct}% / ${S.config.general.slippagePct}%`],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}

// ---------------- bottom tabs
function renderBottom(force = false) {
  const s = S.snap;
  if (!s) return;
  $('#cntPos').textContent = s.positions.length;
  const openOrders = buildOpenOrders(s);
  $('#cntOrd').textContent = openOrders.filter((o) => o.status !== 'ACTIVE').length || openOrders.length;
  $('#cntTrd').textContent = s.trades.length;
  const cc = $('#cntCtl');
  cc.textContent = s.controller?.pending || 0;
  cc.classList.toggle('err', !!s.controller?.pending || !!s.controller?.failSafe);
  cc.classList.toggle('has', !!s.controller?.pending || !!s.controller?.failSafe);
  $('#tabHint').textContent = S.tab === 'strategies' ? `저장을 눌러야 적용됩니다 · 현재 모드 ${MODE[s.mode]}` : S.tab === 'scheduler' ? '신호는 캔들 마감 때만 확인 · 마감 후 오래 지난 진입 신호는 건너뜀 · 청산은 항상 실행' : S.tab === 'controller' ? '자동 조절은 신규 진입 금액만 바꿉니다 · 신호/손절/레버리지는 그대로' : '';
  if (S.tab === 'positions') renderPositions(s);
  else if (S.tab === 'orders') renderOrders(s, openOrders);
  else if (S.tab === 'trades') renderTrades(s);
  else if (S.tab === 'scheduler') {
    const pane = $('#tab-scheduler');
    // do not re-render while a filter dropdown is in use; refresh at most every 2 s unless a new signal arrived
    if (pane.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    if (!force && Date.now() - (S._schedAt || 0) < 2000) return;
    S._schedAt = Date.now();
    const top = pane.scrollTop;
    renderScheduler(pane, s);
    pane.scrollTop = top;
  }
}

function renderPositions(s) {
  if (!s.positions.length) { $('#tab-positions').innerHTML = `<div class="empty">보유 포지션 없음 (${MODE[s.mode]})</div>`; return; }
  const f = (sym) => s.symbols[sym].filters;
  const rows = s.positions.map((p) => `<tr data-sym="${p.symbol}">
    <td class="l"><b>${SHORT[p.strategy] || p.strategy}</b></td><td class="l">${p.symbol}</td><td class="l side-${p.side}">${SIDE[p.side]}</td>
    <td>${fPrice(p.entryPrice, f(p.symbol))}</td><td>${fPrice(p.markPrice, f(p.symbol))}</td>
    <td>${fNum(p.orderAmount, 2)}${p.ctrlMultiplier != null && p.ctrlMultiplier !== 1 ? ` <span class="warn" title="설정금액 ${fNum(p.baseAmount, 2)} × 자동조절 ${p.ctrlMultiplier}">×${p.ctrlMultiplier}</span>` : ''}</td><td>${p.qty}</td><td>${fNum(p.currentValue, 2)}</td>
    <td class="${cls(p.pnl)}">${fSigned(p.pnl)}</td><td class="${cls(p.pnlPct)}">${fPct(p.pnlPct)}</td>
    <td class="down">${p.stopPrice ? fPrice(p.stopPrice, f(p.symbol)) : '없음'} ${exBadge(p)}</td><td class="muted">${p.stopDistPct != null ? p.stopDistPct.toFixed(2) + '%' : ''}</td>
    <td>${fNum(p.funding ? -p.funding : 0, 4)}</td><td>${fDur(p.holdingMs)}</td>
    <td><button class="btn small danger" data-close="${p.strategy}:${p.symbol}" ${p.status === 'PENDING' || p.status === 'UNKNOWN' ? 'disabled' : ''}>청산</button></td></tr>`).join('');
  const tv = s.positions.reduce((a, p) => a + p.currentValue, 0), tp = s.positions.reduce((a, p) => a + p.pnl, 0), ta = s.positions.reduce((a, p) => a + p.orderAmount, 0);
  $('#tab-positions').innerHTML = `<table class="t"><thead><tr><th>전략</th><th>종목</th><th>방향</th><th>진입가</th><th>현재가(마크)</th><th>주문금액</th><th>수량</th><th>현재 가치</th><th>순손익</th><th>수익률</th><th>손절가</th><th>손절까지</th><th>펀딩비</th><th>보유기간</th><th></th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><td>합계</td><td></td><td></td><td></td><td></td><td>${fNum(ta, 2)}</td><td></td><td>${fNum(tv, 2)}</td><td class="${cls(tp)}">${fSigned(tp)}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr></tfoot></table>`;
}

function exBadge(p) {
  if (!p.exStop) return p.stopPrice && S.snap?.mode === 'LIVE' ? '<span class="tag OFF" title="거래소 손절주문 없음 — 봇이 감시">봇</span>' : '';
  const st = p.exStop.status;
  const c = st === 'NEW' ? 'LONG' : st === 'FAILED' ? 'SHORT' : 'PENDING';
  return `<span class="tag ${c}" title="Binance 손절주문 ${esc(ORDER_STATUS[st] || st)} ${esc(p.exStop.error || '')}">거래소${st === 'NEW' ? '' : ' ' + esc(ORDER_STATUS[st] || st)}</span>`;
}

function buildOpenOrders(s) {
  const out = [];
  for (const o of s.orders) if (['SUBMITTED', 'UNKNOWN'].includes(o.status)) out.push(o);
  for (const p of s.positions) {
    if (p.exStop) out.push({ time: p.exStop.placedAt, strategy: p.strategy, symbol: p.symbol, side: p.side === 'LONG' ? 'SELL' : 'BUY', positionSide: p.side, type: '거래소 손절주문', price: p.exStop.triggerPrice, amount: p.currentValue, qty: p.exStop.qty, status: p.exStop.status === 'NEW' ? 'ACTIVE' : p.exStop.status, reason: p.exStop.clientAlgoId, error: p.exStop.error });
    if (p.stopPrice) out.push({ time: p.entryTime, strategy: p.strategy, symbol: p.symbol, side: p.side === 'LONG' ? 'SELL' : 'BUY', positionSide: p.side, type: `${p.stopMode === 'FIXED_PERCENT' ? '고정' : 'ATR'} 손절 (봇 감시)`, price: p.stopPrice, amount: p.currentValue, qty: p.qty, status: 'ACTIVE', reason: p.exStop?.status === 'NEW' ? '예비 (거래소 미체결 15초 후)' : '' });
    if (p.tpPrice) out.push({ time: p.entryTime, strategy: p.strategy, symbol: p.symbol, side: p.side === 'LONG' ? 'SELL' : 'BUY', positionSide: p.side, type: '익절 (봇 감시)', price: p.tpPrice, amount: p.currentValue, qty: p.qty, status: 'ACTIVE' });
  }
  return out;
}

function orderRow(o, s) {
  const f = s.symbols[o.symbol]?.filters;
  const st = o.status;
  const c = st === 'FILLED' ? 'up' : ['REJECTED', 'NOT_PLACED', 'FAILED'].includes(st) ? 'down' : ['UNKNOWN', 'PLACING', 'TRIGGERED', 'REPLACE'].includes(st) ? 'warn' : '';
  return `<tr data-sym="${o.symbol}"><td class="l">${fDateTime(o.time)}</td><td class="l"><b>${SHORT[o.strategy] || o.strategy}</b></td><td class="l">${o.symbol}</td>
    <td class="l"><span class="${o.side === 'BUY' ? 'up' : 'down'}">${o.side === 'BUY' ? '매수' : '매도'}</span> <span class="muted">${SIDE[o.positionSide] || o.positionSide}${o.action ? ' ' + (o.action === 'OPEN' ? '진입' : '청산') : ''}</span></td>
    <td class="l">${o.type === 'MARKET' ? '시장가' : o.type === 'STOP_MARKET' ? '손절(거래소)' : o.type}</td><td>${o.price != null ? fPrice(o.price, f) : o.refPrice ? `~${fPrice(o.refPrice, f)}` : '시장가'}</td>
    <td>${fNum(o.amount, 2)}</td><td>${o.qty ?? ''}</td><td class="${c}">${ORDER_STATUS[st] || st}</td><td class="l muted" title="${esc(o.error || '')}">${esc(EXIT[o.reason] || o.reason || o.error || '')}</td></tr>`;
}

function renderOrders(s, open) {
  const head = '<thead><tr><th>시간</th><th>전략</th><th>종목</th><th>구분</th><th>유형</th><th>가격</th><th>금액</th><th>수량</th><th>상태</th><th>비고</th></tr></thead>';
  $('#tab-orders').innerHTML = `<div class="sub-h">대기 중인 주문 · 처리 중 시장가 · 거래소 손절주문 · 봇 감시 손절/익절</div>
    ${open.length ? `<table class="t">${head}<tbody>${open.map((o) => orderRow(o, s)).join('')}</tbody></table>` : '<div class="empty">대기 주문 없음</div>'}
    <div class="sub-h">주문 기록 (${MODE[s.mode]})</div>
    ${s.orders.length ? `<table class="t">${head}<tbody>${s.orders.map((o) => orderRow(o, s)).join('')}</tbody></table>` : '<div class="empty">주문 기록 없음</div>'}`;
}

function renderTrades(s) {
  if (!s.trades.length) { $('#tab-trades').innerHTML = `<div class="empty">청산된 거래 없음 (${MODE[s.mode]})</div>`; return; }
  const f = (sym) => s.symbols[sym].filters;
  const rows = s.trades.map((t) => `<tr data-sym="${t.symbol}"><td class="l">${fDateTime(t.entryTime)}</td><td class="l">${fDateTime(t.exitTime)}</td><td class="l"><b>${SHORT[t.strategy] || t.strategy}</b></td><td class="l">${t.symbol}</td><td class="l side-${t.side}">${SIDE[t.side]}</td>
    <td>${fPrice(t.entryPrice, f(t.symbol))}</td><td>${fPrice(t.exitPrice, f(t.symbol))}</td><td>${fNum(t.orderAmount, 2)}</td>
    <td class="${cls(t.grossPnl)}">${fSigned(t.grossPnl)}</td><td class="down">${fNum(-t.fee, 4)}</td><td class="${cls(t.funding)}">${fNum(t.funding, 4)}</td>
    <td class="${cls(t.netPnl)}"><b>${fSigned(t.netPnl)}</b></td><td class="${cls(t.returnPct)}">${fPct(t.returnPct)}</td><td class="l">${exitTag(t.exitReason)}</td></tr>`).join('');
  const sum = (k) => s.trades.reduce((a, t) => a + t[k], 0);
  $('#tab-trades').innerHTML = `<table class="t"><thead><tr><th>진입 시간</th><th>청산 시간</th><th>전략</th><th>종목</th><th>방향</th><th>진입가</th><th>청산가</th><th>주문금액</th><th>매매손익</th><th>수수료</th><th>펀딩비</th><th>순손익</th><th>수익률</th><th>청산 사유</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><td>합계 ${s.trades.length}건</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td class="${cls(sum('grossPnl'))}">${fSigned(sum('grossPnl'))}</td><td class="down">${fNum(-sum('fee'), 4)}</td><td>${fNum(sum('funding'), 4)}</td><td class="${cls(sum('netPnl'))}">${fSigned(sum('netPnl'))}</td><td></td><td></td></tr></tfoot></table>`;
}

function exitTag(r) {
  const c = { STRATEGY_EXIT: 'muted', ATR_STOP: 'down', FIXED_STOP: 'down', TAKE_PROFIT: 'up', MANUAL_EXIT: 'warn', EMERGENCY_CLOSE: 'down' }[r] || '';
  return `<span class="${c}">${EXIT[r] || r}</span>`;
}

// ---------------- log
function addLogs(list) {
  const box = $('#logList');
  const frag = document.createDocumentFragment();
  for (const e of list) {
    S.logs.push(e);
    if (e.level === 'ERROR' && S.tab !== 'log') S.errCount++;
    if (passFilter(e)) frag.appendChild(logEl(e));
  }
  box.appendChild(frag);
  if (S.logs.length > 2000) { S.logs.splice(0, S.logs.length - 2000); while (box.children.length > 2000) box.firstChild.remove(); }
  updateErrBadge();
  scrollLog();
}
const passFilter = (e) => S.logFilter === 'ALL' || e.level === S.logFilter || (S.logFilter === 'WARN' && e.level === 'ERROR');
function logEl(e) {
  const d = document.createElement('div');
  d.className = `lg ${e.level}`;
  d.innerHTML = `<span class="ts">${fTime(e.ts)}</span><span class="lv">${e.level}</span><span class="code">${esc(e.code || '')}</span><span class="msg" title="${esc(e.msg)}">${esc(e.msg)}</span>`;
  return d;
}
function rebuildLog() {
  const box = $('#logList');
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const e of S.logs) if (passFilter(e)) frag.appendChild(logEl(e));
  box.appendChild(frag);
  scrollLog();
}
function scrollLog() { if ($('#logAuto').checked && S.tab === 'log') { const p = $('#tab-log'); p.scrollTop = p.scrollHeight; } }
function updateErrBadge() { const b = $('#cntErr'); b.textContent = S.errCount; b.classList.toggle('has', S.errCount > 0); }

function decimals(step) { const s = String(step); const i = s.indexOf('.'); return i < 0 ? 0 : s.replace(/0+$/, '').length - i - 1; }

init().catch((e) => toast(`화면 초기화 실패: ${e.message}`, "err"));
