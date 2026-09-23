// Confirmation dialog and Binance API key modal.
import { $, esc, api, toast, fUsd } from './util.js';

const modal = () => $('#modal');
const box = () => $('#modalBox');
function close() { modal().classList.add('hidden'); box().innerHTML = ''; box().className = 'modal-box'; }

// Returns true when confirmed. If `word` is set, user must type it exactly.
export function confirmDialog({ title, html, word = null, okText = 'CONFIRM', danger = false }) {
  return new Promise((resolve) => {
    box().innerHTML = `<div class="m-h ${danger ? 'danger' : ''}">${esc(title)}<span>⚠</span></div>
      <div class="m-b">${html}${word ? `<p>계속하려면 <b>${esc(word)}</b> 를 입력하세요.</p><input type="text" id="cfWord" autocomplete="off" spellcheck="false">` : ''}</div>
      <div class="m-f"><button class="btn ghost" id="cfNo">Cancel</button><button class="btn ${danger ? 'stop' : 'primary'}" id="cfYes" ${word ? 'disabled' : ''}>${esc(okText)}</button></div>`;
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
  box().innerHTML = `<div class="m-h">BINANCE API KEY <span class="muted">USDT-M Futures</span></div>
    <div class="m-b">
      <div class="m-grid">
        <label>Status</label><div id="apiStatus">${statusHtml(s)}</div>
        <label>API Key</label><input type="text" id="apiKey" placeholder="${s.hasKey ? esc(s.apiKeyMasked) + ' (저장됨 — 변경 시에만 입력)' : 'API Key'}" autocomplete="off" spellcheck="false">
        <label>Secret Key</label><input type="password" id="apiSecret" placeholder="${s.hasKey ? '•••••••• (저장됨 — 변경 시에만 입력)' : 'Secret Key'}" autocomplete="new-password">
        <label>Environment</label><label style="color:var(--text)"><input type="checkbox" id="apiTestnet" ${s.testnet ? 'checked' : ''}> Futures Testnet (demo-fapi.binance.com)</label>
      </div>
      <div class="m-info">
        · 키는 이 PC의 <b>data/secrets.json</b>에만 저장되며(권한 600) 화면으로 다시 전송되지 않습니다.<br>
        · Binance API 관리에서 <b>Enable Futures</b>만 허용, <b>Withdrawals 비활성</b>, <b>IP 제한</b> 설정을 권장합니다.<br>
        · Long/Short 동시 운용을 위해 계정 Position Mode는 <b>Hedge Mode</b>여야 합니다.
      </div>
      <div id="apiResult" class="m-info" style="display:none"></div>
    </div>
    <div class="m-f">
      <button class="btn danger" id="apiDel" ${s.hasKey ? '' : 'disabled'}>Delete Key</button>
      <button class="btn ghost" id="apiHedge" style="display:${s.hedgeMode === false ? '' : 'none'}">Enable Hedge Mode</button>
      <span style="flex:1"></span>
      <button class="btn ghost" id="apiClose">Close</button>
      <button class="btn ghost" id="apiTest" ${s.hasKey ? '' : 'disabled'}>Test Connection</button>
      <button class="btn primary" id="apiSave">Save</button>
    </div>`;
  modal().classList.remove('hidden');
  $('#apiClose').onclick = close;
  $('#apiSave').onclick = async () => {
    const apiKey = $('#apiKey').value.trim(), apiSecret = $('#apiSecret').value.trim();
    if (!s.hasKey && (!apiKey || !apiSecret)) return toast('API Key와 Secret Key를 모두 입력하세요', 'err');
    const r = await api('POST', '/api/secrets', { apiKey, apiSecret, testnet: $('#apiTestnet').checked });
    if (!r.ok) return toast(r.msg, 'err');
    toast('API key saved', 'ok');
    await test();
  };
  const test = async () => {
    const out = $('#apiResult');
    out.style.display = '';
    out.textContent = 'Testing…';
    const r = await api('POST', '/api/secrets/test');
    $('#apiTest').disabled = false; $('#apiDel').disabled = false;
    out.innerHTML = r.success
      ? `<span class="up">✔ CONNECTED</span> · Equity ${fUsd(r.account?.equity)} · Available ${fUsd(r.account?.available)} USDT<br>Position Mode: ${r.hedgeMode ? '<span class="up">Hedge</span>' : '<span class="down">One-way</span>'} · Leverage ${Object.entries(r.leverage || {}).map(([k, v]) => `${k.replace('USDT', '')} ${v}x`).join(' ')}`
      : `<span class="down">✖ ${esc(r.msg || r.status)}</span>`;
    $('#apiStatus').innerHTML = statusHtml(r);
    $('#apiHedge').style.display = r.hedgeMode === false ? '' : 'none';
  };
  $('#apiTest').onclick = test;
  $('#apiHedge').onclick = async () => {
    const ok = await confirmDialog({ title: 'ENABLE HEDGE MODE', html: '<p>Binance 계정의 USDT-M Position Mode를 Hedge Mode로 변경합니다. 열린 포지션/주문이 있으면 Binance가 거부합니다.</p>', okText: 'ENABLE' });
    if (!ok) return openApiModal();
    const r = await api('POST', '/api/live/hedge-mode');
    r.ok ? toast('Hedge Mode enabled', 'ok') : toast(r.msg, 'err');
    openApiModal();
  };
  $('#apiDel').onclick = async () => {
    const r = await api('DELETE', '/api/secrets');
    r.ok ? (toast('API key deleted', 'ok'), openApiModal()) : toast(r.msg, 'err');
  };
}

function statusHtml(s) {
  const st = s.status;
  const c = st === 'CONNECTED' ? 'up' : st === 'NO_KEYS' || st === 'UNVERIFIED' ? 'warn' : 'down';
  return `<span class="${c}">${st}</span>${s.error ? ` <span class="muted">${esc(s.error)}</span>` : ''}`;
}
