// Scheduler tab: strategy instances (timeframe / last evaluated candle / next candle) + Signal Log.
import { $, esc, fZone, fET, fDateTime } from './util.js';
import { STATUS, TF, MODE, resultKo, detailKo } from './ko.js';

const S = { signals: [], filter: { strategy: '', symbol: '', result: '' } };
const SHORT = { TURTLE: '터틀', ADX: 'ADX', TSMOM: 'TSMOM', RAYNER: 'Rayner', QQQ_EMA_TREND: 'QQQ EMA', QQQ_TSMOM: 'QQQ TSMOM', QQQ_SMA200: 'QQQ SMA200', QQQ_TURTLE_50_20: 'QQQ 터틀50/20' };

const TRIG = (t = '') => t.replace('4H candle close', '4시간 캔들 마감').replace('1D candle close', '1일 캔들 마감').replace('US market close', '미국장 마감').replace('bot start', '봇 시작').replace('init', '프로그램 시작').replace('fallback (close event missed)', '보조 확인(마감 신호 누락)').replace('retry', '재시도').replace('config saved', '설정 저장');

export function setSignals(list) { S.signals = list.slice(-2000); }
export function addSignal(r) { S.signals.push(r); if (S.signals.length > 2000) S.signals.shift(); }

const statusCls = (s) => ({ RUNNING: 'up', RETRYING: 'warn', STOPPED: 'down', DISABLED: 'muted', UNAVAILABLE: 'down' }[s] || '');
const resultCls = (r = '') => (/ENTRY (LONG|SHORT)$/.test(r) || r.includes('· ENTRY') ? 'up' : r.startsWith('EXIT') ? 'warn' : /SKIP|STALE|FAILED|ERROR/.test(r) ? 'down' : 'muted');

// Compact line for the right-panel strategy card
export function scheduleLine(row) {
  if (!row) return '';
  const st = `<span class="${statusCls(row.status)}">${STATUS[row.status] || row.status}</span>`;
  if (row.timeframe === 'US_SESSION') {
    return `미국 정규장 마감 기준 · 미국장 <span class="${row.market === 'OPEN' ? 'up' : 'muted'}">${STATUS[row.market]}</span> · 다음 확인 ${fET(row.nextExpectedCandle)} · ${st}`;
  }
  return `${TF[row.timeframe]} 캔들 · 마지막 확인 ${fZone(row.lastEvaluatedCandle)} · 다음 확인 ${fZone(row.nextExpectedCandle)} · ${st}`;
}

export function renderScheduler(root, snap) {
  const rows = snap.scheduler || [];
  const inst = rows.map((r) => {
    const us = r.timeframe === 'US_SESSION';
    return `<tr data-sym="${r.symbol}"><td class="l"><b>${SHORT[r.strategy] || r.strategy}</b></td><td class="l">${r.symbol}</td><td class="l">${TF[r.timeframe]}</td>
      <td class="l">${us ? '미국장 마감' : '캔들 마감'}</td>
      <td>${fZone(r.lastEvaluatedCandle, { date: 'always' })}</td><td>${fZone(r.lastClosedCandle, { date: 'always' })}</td>
      <td>${us ? fET(r.nextExpectedCandle) : fZone(r.nextExpectedCandle)}</td>
      <td class="l">${us ? `<span class="${r.market === 'OPEN' ? 'up' : 'muted'}">미국장 ${STATUS[r.market]}</span> <span class="muted">주문: Binance 24시간</span>` : '<span class="muted">Binance 캔들</span>'}</td>
      <td class="l ${resultCls(r.lastResult)}">${esc(resultKo(r.lastResult) || '—')}</td><td>${r.evaluations}</td><td>${r.entryGraceMin}분</td>
      <td class="${statusCls(r.status)}"><b>${STATUS[r.status] || r.status}</b></td></tr>`;
  }).join('');
  const f = S.filter;
  const list = S.signals.filter((x) => (!f.strategy || x.strategy === f.strategy) && (!f.symbol || x.symbol === f.symbol) && (!f.result || (f.result === 'ACTION' ? /ENTRY|EXIT/.test(x.result) && !/SKIPPED/.test(x.result) : x.result === f.result || x.result.startsWith(f.result))));
  const opts = (vals, cur, lab = (v) => v) => `<option value="">전체</option>${vals.map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${lab(v)}</option>`).join('')}`;
  const strategies = [...new Set(rows.map((r) => r.strategy))], symbols = [...new Set(rows.map((r) => r.symbol))];
  const sig = list.slice(-400).reverse().map((x) => `<tr data-sym="${x.symbol}"><td class="l">${fDateTime(x.ts)}</td><td class="l">${MODE[x.mode] || x.mode}</td><td class="l"><b>${SHORT[x.strategy] || x.strategy}</b></td><td class="l">${x.symbol}</td>
    <td class="l">${TF[x.timeframe] || x.timeframe}</td><td>${x.timeframe === 'US_SESSION' ? fET(x.candleClose) : fZone(x.candleClose, { date: 'always' })}</td>
    <td class="l muted">${esc(TRIG(x.trigger))}</td><td class="l reason" title="${esc(detailKo(x.detail))}">${esc(detailKo(x.detail))}</td><td class="l ${resultCls(x.result)}"><b>${esc(resultKo(x.result))}</b></td></tr>`).join('');
  root.innerHTML = `<div class="sub-h">신호 확인 일정 · 캔들이 마감될 때만 전략을 확인합니다 · 손절은 가격이 바뀔 때마다 실시간 감시 (캔들 마감을 기다리지 않음)</div>
    <table class="t"><thead><tr><th>전략</th><th>종목</th><th>캔들</th><th>확인 시점</th><th>마지막 확인한 캔들</th><th>마지막 마감 캔들</th><th>다음 확인</th><th>장 / 주문</th><th>마지막 결과</th><th>확인 횟수</th><th>진입 허용 시간</th><th>상태</th></tr></thead><tbody>${inst}</tbody></table>
    <div class="sub-h sig-bar">신호 기록 · 모든 확인 결과 (신호 없음 포함)
      <span>전략 <select data-f="strategy">${opts(strategies, f.strategy, (v) => SHORT[v] || v)}</select> 종목 <select data-f="symbol">${opts(symbols, f.symbol)}</select>
      결과 <select data-f="result">${opts(['ACTION', 'HOLD', 'BOT_STOPPED', 'STALE_ENTRY_SKIPPED', 'SKIP', 'NOT_READY', 'DISABLED'], f.result, (v) => ({ ACTION: '진입/청산', HOLD: '유지', BOT_STOPPED: '봇 정지 중', STALE_ENTRY_SKIPPED: '늦은 신호 건너뜀', SKIP: '보류', NOT_READY: '데이터 부족', DISABLED: '전략 꺼짐' }[v]))}</select></span></div>
    ${sig ? `<table class="t"><thead><tr><th>시간</th><th>모드</th><th>전략</th><th>종목</th><th>캔들</th><th>캔들 마감</th><th>계기</th><th class="l">조건</th><th class="l">결과</th></tr></thead><tbody>${sig}</tbody></table>` : '<div class="empty">아직 확인 기록 없음</div>'}`;
  root.querySelectorAll('select[data-f]').forEach((s) => { s.onchange = () => { S.filter[s.dataset.f] = s.value; renderScheduler(root, snap); }; });
}
