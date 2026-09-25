// Mobile screen (/m): account, positions, bot controls. Polls /api/mobile (compact payload) every 2 s while visible.
import { $, $$, esc, fUsd, fSigned, fPct, fNum, fPrice, fDateTime, fDur, fTime, cls, api } from './util.js';
import { SIDE, MODE, STATUS, EXIT, STRAT, codeKo } from './ko.js';

const M = { d: null, tab: 'pos', timer: null, busy: false, lastOk: 0 };
const tick = (p) => (p.tick ? { tickSize: p.tick } : null);

function toast(msg, kind = '') {
  const t = $('#mToast');
  t.textContent = msg; t.className = `m-toast show ${kind}`;
  clearTimeout(t._h); t._h = setTimeout(() => { t.className = 'm-toast'; }, kind === 'err' ? 6000 : 3000);
}

// bottom-sheet confirmation; word = text the user must type (LIVE / CLOSE ALL)
function confirmSheet({ title, html, word = null, okText = '확인', danger = false }) {
  return new Promise((resolve) => {
    const m = $('#mModal');
    $('#mBox').innerHTML = `<h3>${esc(title)}</h3><div>${html}</div>${word ? `<p>계속하려면 <b>${esc(word)}</b> 입력</p><input id="mWord" autocomplete="off" autocapitalize="characters" spellcheck="false">` : ''}
      <div class="acts"><button class="btn" id="mNo">취소</button><button class="btn ${danger ? 'danger' : 'go'}" id="mYes" ${word ? 'disabled' : ''}>${esc(okText)}</button></div>`;
    m.classList.remove('hidden');
    const done = (v) => { m.classList.add('hidden'); $('#mBox').innerHTML = ''; resolve(v); };
    $('#mNo').onclick = () => done(false);
    $('#mYes').onclick = () => done(true);
    m.onclick = (e) => { if (e.target === m) done(false); };
    if (word) { const i = $('#mWord'); i.focus(); i.oninput = () => { $('#mYes').disabled = i.value.trim().toUpperCase() !== word; }; }
  });
}

async function load() {
  if (M.busy) return;
  M.busy = true;
  try {
    const r = await fetch('/api/mobile', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    M.d = await r.json();
    M.lastOk = Date.now();
    render();
  } catch (e) {
    $('#mAge').textContent = '연결 끊김';
    $('#mAge').className = 'down';
  } finally { M.busy = false; }
}

function schedule() {
  clearInterval(M.timer);
  if (document.visibilityState === 'visible') { load(); M.timer = setInterval(load, 2000); }
}

const dot = (el, k, text) => { el.className = `dot ${k}`; el.textContent = text; };

function render() {
  const d = M.d, a = d.account, live = d.mode === 'LIVE';
  $('#mMode').textContent = live ? (d.conn.testnet ? '실전·테스트' : '실전') : '모의투자';
  $('#mMode').className = `badge ${live ? 'live' : 'paper'}`;
  const running = d.runState === 'RUNNING';
  $('#mRun').textContent = running ? '실행 중' : '정지';
  $('#mRun').className = `badge ${running ? 'run' : 'stopped'}`;
  dot($('#mConnMk'), d.conn.market === 'CONNECTED' ? 'ok' : 'bad', '시세');
  dot($('#mConnEx'), d.conn.exchange === 'CONNECTED' ? 'ok' : d.conn.exchange === 'PAPER' ? '' : 'bad', live ? '거래소' : '모의');
  $('#mAge').textContent = fTime(d.ts);
  $('#mAge').className = 'muted';

  const w = live ? d.wallets : null;
  $('#mTotalLbl').innerHTML = w?.total != null ? '총 자산 <i>USDT · 전체 지갑</i>' : '총 자산 <i>USDT</i>';
  $('#mTotal').textContent = w?.total != null ? fUsd(w.total) : fUsd(a.equity);
  $('#mTotalSub').textContent = w?.total != null ? `선물 ${fUsd(a.equity)}${w.error ? ' · 일부 조회 실패' : ''}` : live ? '' : '모의투자 가상 계좌';
  const set = (id, v, text) => { const el = $(id); el.textContent = text; el.className = cls(v); };
  set('#mToday', a.todayPnl, fSigned(a.todayPnl));
  $('#mTodayPct').textContent = a.baseCapital ? fPct(a.todayPnl / a.baseCapital * 100) : '';
  set('#mRet', a.totalReturnPct, a.totalReturnPct != null ? fPct(a.totalReturnPct) : '—');
  $('#mBase').textContent = `누적 ${fSigned(a.totalPnl)}`;
  set('#mUnreal', a.unrealizedNet, fSigned(a.unrealizedNet));
  $('#mAvail').textContent = fUsd(a.available);

  // warnings: disconnected, liquidation risk, near stops, reconciliation mismatch, exchange error
  const warn = [];
  if (d.conn.market !== 'CONNECTED') warn.push(['', '시세 연결 끊김 — 손절 감시가 멈출 수 있습니다']);
  if (live && d.conn.exchange !== 'CONNECTED') warn.push(['', `거래소 ${STATUS[d.conn.exchange] || d.conn.exchange}${d.conn.liveError ? ': ' + d.conn.liveError : ''}`]);
  if (d.risk?.liquidation?.length) warn.push(['', `청산 위험 ${d.risk.liquidation.length}건`]);
  if (d.risk?.nearStop?.length) warn.push(['w', `손절가 1% 이내: ${d.risk.nearStop.map((x) => `${STRAT[x.strategy] || x.strategy} ${x.symbol.replace('USDT', '')}`).join(', ')}`]);
  if (d.reconciliation && !d.reconciliation.ok) warn.push(['', `포지션 불일치: ${d.reconciliation.warnings.slice(0, 2).join(' · ')}`]);
  if (d.pending.length) warn.push(['w', `주문 처리 중 ${d.pending.length}건`]);
  $('#mWarn').innerHTML = warn.map(([k, t]) => `<div class="banner ${k}">${esc(t)}</div>`).join('');

  $('#bStart').disabled = running;
  $('#bStop').disabled = !running;
  $('#bCloseAll').disabled = !d.positions.length;

  $('#cPos').textContent = d.positions.length;
  const errs = d.alerts.filter((x) => x.level === 'ERROR' && Date.now() - x.ts < 3600_000).length;
  $('#cAlert').textContent = errs || '';
  renderPositions(d); renderStrategies(d); renderTrades(d); renderAlerts(d);
}

function renderPositions(d) {
  $('#t-pos').innerHTML = d.positions.length ? d.positions.map((p) => `<div class="item">
      <div class="row"><span><span class="sym">${p.symbol.replace('USDT', '')}</span> <span class="tag ${p.side}">${SIDE[p.side]}</span> <span class="sub">${esc(STRAT[p.strategy] || p.strategy)} · ${p.leverage || 1}배</span></span>
        <span class="pnl ${cls(p.pnl)}">${fSigned(p.pnl)}</span></div>
      <div class="row sub"><span>${fDur(Date.now() - p.entryTime)} 보유 · 금액 ${fNum(p.orderAmount, 2)}</span><span class="${cls(p.pnl)}">${fPct(p.pnlPct)}</span></div>
      <div class="grid"><div><span>진입가</span>${fPrice(p.entryPrice, tick(p))}</div><div><span>현재가</span>${fPrice(p.markPrice, tick(p))}</div><div><span>수량</span>${p.qty}</div>
        <div><span>손절가</span><b class="down">${p.stopPrice ? fPrice(p.stopPrice, tick(p)) : '없음'}</b></div><div><span>손절까지</span>${p.stopDistPct != null ? p.stopDistPct.toFixed(2) + '%' : '—'}</div>
        <div><span>거래소 손절</span>${p.exStop ? (p.exStop.status === 'NEW' ? '<b class="up">등록</b>' : esc(p.exStop.status)) : live() ? '<b class="warn">없음</b>' : '—'}</div></div>
      <div class="row"><span class="sub">${p.tpPrice ? `익절가 ${fPrice(p.tpPrice, tick(p))}` : ''}</span><button class="btn small danger" data-close="${esc(p.strategy)}|${esc(p.symbol)}">청산</button></div>
    </div>`).join('') : '<div class="empty">보유 포지션 없음</div>';
}
const live = () => M.d?.mode === 'LIVE';

function renderStrategies(d) {
  $('#t-strat').innerHTML = d.strategies.map((s) => `<div class="item">
      <div class="row"><span><b>${esc(STRAT[s.strategy] || s.strategy)}</b> <span class="tag ${s.enabled ? 'ON' : 'OFF'}">${s.enabled ? '켜짐' : '꺼짐'}</span></span><span class="pnl ${cls(s.realized + s.unrealized)}">${fSigned(s.realized + s.unrealized)}</span></div>
      <div class="grid"><div><span>보유</span>롱 ${s.longs} / 숏 ${s.shorts}</div><div><span>평가손익</span><b class="${cls(s.unrealized)}">${fSigned(s.unrealized)}</b></div><div><span>거래 · 승률</span>${s.trades} · ${s.winRate != null ? s.winRate.toFixed(0) + '%' : '—'}</div></div>
    </div>`).join('') + '<p class="sub muted" style="text-align:center">전략 설정 변경은 PC 화면에서</p>';
}

function renderTrades(d) {
  $('#t-trades').innerHTML = d.trades.length ? d.trades.map((t) => `<div class="item">
      <div class="row"><span><span class="sym">${t.symbol.replace('USDT', '')}</span> <span class="tag ${t.side}">${SIDE[t.side]}</span> <span class="sub">${esc(STRAT[t.strategy] || t.strategy)}</span></span><span class="pnl ${cls(t.netPnl)}">${fSigned(t.netPnl)}</span></div>
      <div class="row sub"><span>${fDateTime(t.exitTime)} · ${esc(EXIT[t.exitReason] || t.exitReason || '')}</span><span class="${cls(t.returnPct)}">${fPct(t.returnPct)}</span></div>
    </div>`).join('') : '<div class="empty">거래 내역 없음</div>';
}

function renderAlerts(d) {
  $('#t-alerts').innerHTML = d.alerts.length ? d.alerts.map((e) => `<div class="alert ${e.level}"><time>${fTime(e.ts)}</time>${esc(codeKo(e.msg))}</div>`).join('') : '<div class="empty">알림 없음</div>';
}

// ---- actions (same endpoints and typed confirmations as the PC screen)
async function startBot() {
  const isLive = live();
  const ok = await confirmSheet({ title: `봇 시작 (${MODE[M.d.mode]})`, word: isLive ? 'LIVE' : null, okText: '시작', danger: isLive,
    html: `<p>${isLive ? '실제 자금으로 자동매매를 시작합니다.' : '모의투자로 자동매매를 시작합니다.'}</p>` });
  if (!ok) return;
  const r = await api('POST', '/api/bot/start', isLive ? { confirm: 'LIVE' } : {});
  toast(r.ok ? '봇 시작' : `시작 실패: ${r.msg}`, r.ok ? 'ok' : 'err'); load();
}
async function stopBot() {
  const ok = await confirmSheet({ title: '봇 전체 정지', okText: '정지', html: '<p>신규 주문과 전략 청산을 멈춥니다. 보유 포지션과 손절은 유지됩니다.</p>' });
  if (!ok) return;
  const r = await api('POST', '/api/bot/stop');
  toast(r.ok ? '봇 정지' : `정지 실패: ${r.msg}`, r.ok ? 'ok' : 'err'); load();
}
async function closeAll() {
  const ok = await confirmSheet({ title: '전체 포지션 청산', word: 'CLOSE ALL', okText: '전체 청산', danger: true, html: `<p>${M.d.positions.length}개 포지션을 시장가로 청산합니다.</p>` });
  if (!ok) return;
  const r = await api('POST', '/api/positions/close-all', { confirm: 'CLOSE ALL' });
  toast(r.ok ? '전체 청산 요청 완료' : `일부 실패: ${r.msg || (r.results || []).filter((x) => !x.ok).map((x) => `${x.symbol} ${x.msg}`).join(', ')}`, r.ok ? 'ok' : 'err'); load();
}
async function closeOne(strategy, symbol) {
  const p = M.d.positions.find((x) => x.strategy === strategy && x.symbol === symbol);
  const ok = await confirmSheet({ title: `${symbol.replace('USDT', '')} ${SIDE[p?.side] || ''} 청산`, okText: '청산', danger: true,
    html: `<p>${esc(STRAT[strategy] || strategy)} 포지션을 시장가로 청산합니다. 현재 손익 <b class="${cls(p?.pnl)}">${fSigned(p?.pnl)}</b></p>` });
  if (!ok) return;
  const r = await api('POST', '/api/positions/close', { strategy, symbol });
  toast(r.ok ? '청산 완료' : `청산 실패: ${codeKo(r.msg || r.code || '')}`, r.ok ? 'ok' : 'err'); load();
}

$('#bStart').onclick = startBot;
$('#bStop').onclick = stopBot;
$('#bCloseAll').onclick = closeAll;
$('#t-pos').addEventListener('click', (e) => { const b = e.target.closest('[data-close]'); if (b) { const [st, sym] = b.dataset.close.split('|'); closeOne(st, sym); } });
$('#mTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-t]'); if (!b) return;
  M.tab = b.dataset.t;
  $$('#mTabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.tab').forEach((x) => x.classList.toggle('on', x.id === `t-${M.tab}`));
});
$('#toDesktop').onclick = () => { try { localStorage.setItem('hic.desktop', '1'); } catch { /* ignore */ } };
document.addEventListener('visibilitychange', schedule);
schedule();
