// Confirmation dialog and Binance API key modal.
import { $, esc, api, toast, fUsd } from './util.js';

const modal = () => $('#modal');
const box = () => $('#modalBox');
function close() { modal().classList.add('hidden'); box().innerHTML = ''; box().className = 'modal-box'; }

// Returns true when confirmed. If `word` is set, user must type it exactly.
export function confirmDialog({ title, html, word = null, okText = '확인', danger = false }) {
  return new Promise((resolve) => {
    box().innerHTML = `<div class="m-h ${danger ? 'danger' : ''}">${esc(title)}<span>⚠</span></div>
      <div class="m-b">${html}${word ? `<p>계속하려면 <b>${esc(word)}</b> 를 입력하세요.</p><input type="text" id="cfWord" autocomplete="off" spellcheck="false">` : ''}</div>
      <div class="m-f"><button class="btn ghost" id="cfNo">취소</button><button class="btn ${danger ? 'stop' : 'primary'}" id="cfYes" ${word ? 'disabled' : ''}>${esc(okText)}</button></div>`;
    modal().classList.remove('hidden');
    const done = (v) => { close(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    document.addEventListener('keydown', onKey);
    $('#cfNo').onclick = () => done(false);
    $('#cfYes').onclick = () => done(true);
    if (word) {
      const i = $('#cfWord');
      i.focus();
      i.oninput = () => { $('#cfYes').disabled = i.value.trim().toUpperCase() !== word; };
      i.onkeydown = (e) => { if (e.key === 'Enter' && !$('#cfYes').disabled) done(true); };
    } else $('#cfNo').focus();
  });
}

export async function openApiModal() {
  const s = await api('GET', '/api/secrets');
  box().className = 'modal-box wide';
  box().innerHTML = `<div class="m-h">BINANCE API 키 <span class="muted">USDT 선물</span></div>
    <div class="m-b">
      <div class="m-grid">
        <label>상태</label><div id="apiStatus">${statusHtml(s)}</div>
        <label>API Key</label><input type="text" id="apiKey" placeholder="${s.hasKey ? esc(s.apiKeyMasked) + ' (저장됨 — 변경 시에만 입력)' : 'API Key'}" autocomplete="off" spellcheck="false">
        <label>Secret Key</label><input type="password" id="apiSecret" placeholder="${s.hasKey ? '•••••••• (저장됨 — 변경 시에만 입력)' : 'Secret Key'}" autocomplete="new-password">
        <label>환경</label><label style="color:var(--text)"><input type="checkbox" id="apiTestnet" ${s.testnet ? 'checked' : ''}> 선물 테스트넷 (demo-fapi.binance.com)</label>
      </div>
      <div class="m-info">
        · 키는 이 PC의 <b>data/secrets.json</b>에만 저장되며(권한 600) 화면으로 다시 전송되지 않습니다.<br>
        · Binance API 관리에서 <b>Enable Reading</b>과 <b>Enable Futures</b>만 체크, <b>출금(Withdrawals) 비활성</b>, <b>IP 제한</b>을 권장합니다.<br>
        · 롱/숏 동시 운용을 위해 계정 포지션 모드는 <b>Hedge Mode(양방향)</b>여야 합니다.
      </div>
      <div id="apiResult" class="m-info" style="display:none"></div>
    </div>
    <div class="m-f">
      <button class="btn danger" id="apiDel" ${s.hasKey ? '' : 'disabled'}>키 삭제</button>
      <button class="btn ghost" id="apiHedge" style="display:${s.hedgeMode === false ? '' : 'none'}">양방향(Hedge) 모드 켜기</button>
      <span style="flex:1"></span>
      <button class="btn ghost" id="apiClose">닫기</button>
      <button class="btn ghost" id="apiTest" ${s.hasKey ? '' : 'disabled'}>연결 테스트</button>
      <button class="btn primary" id="apiSave">저장</button>
    </div>`;
  modal().classList.remove('hidden');
  $('#apiClose').onclick = close;
  $('#apiSave').onclick = async () => {
    const apiKey = $('#apiKey').value.trim(), apiSecret = $('#apiSecret').value.trim();
    if (!s.hasKey && (!apiKey || !apiSecret)) return toast('API Key와 Secret Key를 모두 입력하세요', 'err');
    const r = await api('POST', '/api/secrets', { apiKey, apiSecret, testnet: $('#apiTestnet').checked });
    if (!r.ok) return toast(r.msg, 'err');
    toast('API 키를 저장했습니다', 'ok');
    await test();
  };
  const test = async () => {
    const out = $('#apiResult');
    out.style.display = '';
    out.textContent = '확인 중…';
    const r = await api('POST', '/api/secrets/test');
    $('#apiTest').disabled = false; $('#apiDel').disabled = false;
    out.innerHTML = r.success
      ? `<span class="up">✔ 연결됨</span> · 자산 ${fUsd(r.account?.equity)} · 주문 가능 ${fUsd(r.account?.available)} USDT<br>포지션 모드: ${r.hedgeMode ? '<span class="up">양방향(Hedge)</span>' : '<span class="down">단방향(One-way)</span>'} · 레버리지 ${Object.entries(r.leverage || {}).map(([k, v]) => `${k.replace('USDT', '')} ${v}x`).join(' ')}`
      : `<span class="down">✖ ${esc(r.msg || r.status)}</span>`;
    $('#apiStatus').innerHTML = statusHtml(r);
    $('#apiHedge').style.display = r.hedgeMode === false ? '' : 'none';
  };
  $('#apiTest').onclick = test;
  $('#apiHedge').onclick = async () => {
    const ok = await confirmDialog({ title: '양방향(Hedge) 모드 켜기', html: '<p>Binance 선물 계정의 포지션 모드를 양방향(Hedge)으로 바꿉니다. 열린 포지션/주문이 있으면 Binance가 거부합니다.</p>', okText: '켜기' });
    if (!ok) return openApiModal();
    const r = await api('POST', '/api/live/hedge-mode');
    r.ok ? toast('양방향 모드를 켰습니다', 'ok') : toast(r.msg, 'err');
    openApiModal();
  };
  $('#apiDel').onclick = async () => {
    const r = await api('DELETE', '/api/secrets');
    r.ok ? (toast('API 키를 삭제했습니다', 'ok'), openApiModal()) : toast(r.msg, 'err');
  };
}

function statusHtml(s) {
  const st = s.status;
  const c = st === 'CONNECTED' ? 'up' : st === 'NO_KEYS' || st === 'UNVERIFIED' ? 'warn' : 'down';
  const ko = { CONNECTED: '연결됨', NO_KEYS: '키 없음', UNVERIFIED: '미확인', ERROR: '오류' }[st] || st;
  return `<span class="${c}">${ko}</span>${s.error ? ` <span class="muted">${esc(s.error)}</span>` : ''}`;
}
