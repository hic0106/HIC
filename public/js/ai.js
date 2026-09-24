// AI 패널 (Claude API): 손실 원인 분석 · 자동 개선(학습/검증 구간 분리) · AI 전략 생성
import { $, esc, api, toast, fNum, fPct, fDateTime } from './util.js';
import { confirmDialog } from './modals.js';

const SHORT = { TURTLE: '터틀', ADX: 'ADX', TSMOM: 'TSMOM', QQQ_EMA_TREND: 'QQQ EMA', QQQ_TSMOM: 'QQQ TSMOM', QQQ_SMA200: 'QQQ SMA200', QQQ_TURTLE_50_20: 'QQQ 터틀50/20' };
const VERDICT = { GOOD: ['좋음', 'LONG'], MIXED: ['보통', 'PENDING'], BAD: ['나쁨', 'SHORT'], NO_DATA: ['데이터 부족', 'OFF'], PASSED: ['검증 통과', 'LONG'], OVERFIT: ['과최적화 의심', 'PENDING'], WORSE: ['개선 안 됨', 'SHORT'], INVALID: ['오류', 'OFF'], FAILED: ['검증 실패', 'SHORT'] };
const SEV = { HIGH: ['높음', 'down'], MEDIUM: ['중간', 'warn'], LOW: ['낮음', 'muted'] };
const tag = (v) => { const [l, c] = VERDICT[v] || [v, 'WAIT']; return `<span class="tag ${c}">${l}</span>`; };
const pct = (v) => (v == null ? '—' : fPct(v));
const mdd = (v) => (v == null ? '—' : `−${Number(v).toFixed(2)}%`);
const A = { root: null, st: null, poll: null, impSel: localStorage.getItem('hic.aiImp') || 'TURTLE' };

export function mountAi(root) {
  if (A.root === root) { refresh(); return; }
  A.root = root;
  root.innerHTML = `
    <div class="pf-card"><div class="panel-h">AI 분석 · 자동 개선 · 전략 생성 <span class="muted" id="aiHead"></span></div>
      <div class="ai-bar">
        <button class="btn primary" id="aiAnalyze">손실 원인 분석</button>
        <span class="ai-sep"></span>
        <label>자동 개선 전략 <select id="aiImpSt">${Object.keys(SHORT).map((k) => `<option value="${k}">${SHORT[k]}</option>`).join('')}</select></label>
        <label>반복 <select id="aiImpRounds"><option>1</option><option selected>2</option><option>3</option></select>회</label>
        <button class="btn primary" id="aiImprove">자동 개선 시작</button>
        <span class="ai-sep"></span>
        <input type="text" id="aiIdea" placeholder="AI 전략 아이디어 (비우면 AI가 알아서 설계) 예: RSI 과매도 반등 + 200일선 위에서만 롱">
        <label>반복 <select id="aiGenRounds"><option>1</option><option selected>2</option><option>3</option></select>회</label>
        <button class="btn primary" id="aiGenerate">AI 전략 만들기</button>
        <span style="flex:1"></span>
        <span id="aiJob" class="muted"></span>
        <button class="btn ghost small" id="aiKey">Claude API 키</button>
      </div>
      <div class="note">Claude(${'claude-opus-5'})가 백테스트 결과를 읽고 분석·제안합니다. 실제 주문은 하지 않으며, 개선안은 [적용]을 눌러야 설정에 반영됩니다. 과최적화를 막기 위해 기간을 학습 70% / 검증 30%로 나누고, Claude에게는 학습 구간 결과만 보여줍니다. 호출마다 Claude API 사용료가 발생합니다.</div>
    </div>
    <div class="pf-card"><div class="panel-h">손실 원인 분석 <span class="muted" id="aiAnaMeta"></span></div><div id="aiAnalysis"><div class="empty">백테스트 후 [손실 원인 분석]을 누르세요</div></div></div>
    <div class="pf-card"><div class="panel-h">자동 개선 결과 <span class="muted" id="aiImpMeta"></span></div><div id="aiImp"><div class="empty">[자동 개선 시작]을 누르면 Claude가 설정 변경안을 만들고, 각 안을 자동으로 백테스트합니다</div></div></div>
    <div class="pf-card"><div class="panel-h">AI가 만든 전략 <span class="muted">규칙 형식으로 작성 · 자동 백테스트 · 저장 가능 (실거래 연결은 아직 없음)</span></div><div id="aiGen"><div class="empty">아직 없음</div></div></div>`;
  $('#aiImpSt').value = A.impSel;
  $('#aiImpSt').onchange = (e) => { A.impSel = e.target.value; try { localStorage.setItem('hic.aiImp', A.impSel); } catch { /* ignore */ } renderImp(); };
  $('#aiAnalyze').onclick = () => start('/api/ai/analyze', {});
  $('#aiImprove').onclick = () => start('/api/ai/improve', { strategy: $('#aiImpSt').value, rounds: Number($('#aiImpRounds').value) });
  $('#aiGenerate').onclick = () => start('/api/ai/generate', { idea: $('#aiIdea').value, rounds: Number($('#aiGenRounds').value) });
  $('#aiKey').onclick = keyDialog;
  root.addEventListener('click', onClick);
  refresh();
}

async function start(url, body) {
  if (!A.st?.hasKey) { await keyDialog(); if (!A.st?.hasKey) return; }
  const r = await api('POST', url, body);
  if (!r.ok) return toast(r.msg || '실패', 'err');
  toast('AI 작업을 시작했습니다 (수십 초~수 분 소요)', 'ok');
  poll();
}

function poll() {
  clearInterval(A.poll);
  A.poll = setInterval(async () => { await refresh(); if (A.st?.job?.state !== 'RUNNING') clearInterval(A.poll); }, 1500);
}

async function keyDialog() {
  const p = confirmDialog({ title: 'Claude API 키', okText: '저장',
    html: `<p>Anthropic Console(console.anthropic.com)에서 발급한 API 키(sk-ant-…)를 입력하세요. 이 PC의 data/secrets.json에만 저장되고 화면으로 다시 보내지 않습니다.</p><p>현재: <b>${A.st?.hasKey ? '설정됨' : '없음'}</b></p><input type="password" id="aiKeyIn" placeholder="sk-ant-..." autocomplete="off" style="width:100%">` });
  let k = '';
  const inp = document.getElementById('aiKeyIn'); // the modal is removed on close, so read while typing
  inp?.addEventListener('input', () => { k = inp.value.trim(); });
  inp?.focus();
  if (!(await p) || !k) return;
  const r = await api('POST', '/api/ai/key', { apiKey: k });
  r.ok ? toast('Claude API 키를 저장했습니다', 'ok') : toast(r.msg, 'err');
  await refresh();
}

async function onClick(e) {
  const ap = e.target.closest('[data-apply]');
  const sv = e.target.closest('[data-save]');
  const dl = e.target.closest('[data-del]');
  if (ap) {
    const [strategy, id] = ap.dataset.apply.split('|');
    const c = A.st.improvements[strategy].candidates.find((x) => x.id === id);
    const ok = await confirmDialog({ title: `${SHORT[strategy]} 설정 변경`, danger: c.verdict !== 'PASSED', okText: '적용',
      html: `<p><b>${esc(c.label)}</b></p><p>${c.changes.map((a) => `${esc(a.path)}: ${esc(a.from)} → <b>${esc(a.to)}</b>`).join('<br>')}</p><p>검증 구간: 수익률 ${pct(c.outSample.returnPct)}, 최대 낙폭 ${mdd(c.outSample.maxDrawdownPct)}</p>${c.verdict !== 'PASSED' ? '<p class="warn">검증 구간 기준을 통과하지 못한 안입니다.</p>' : ''}<p class="muted">주문금액과 켜짐/꺼짐은 그대로 두고, 다음 캔들 평가부터 적용됩니다. 보유 포지션의 손절가는 바뀌지 않습니다.</p>` });
    if (!ok) return;
    let r = await api('POST', '/api/ai/apply', { strategy, id });
    if (!r.ok && r.needConfirm) {
      const w = await confirmDialog({ title: '실전 실행 중 설정 변경', danger: true, word: 'APPLY', html: '<p>실전 자동매매가 실행 중입니다.</p>' });
      if (!w) return;
      r = await api('POST', '/api/ai/apply', { strategy, id, confirm: 'APPLY' });
    }
    r.ok ? (toast('설정에 적용했습니다', 'ok'), window.dispatchEvent(new Event('hic:config'))) : toast(r.msg, 'err');
    refresh();
  } else if (sv) {
    const r = await api('POST', '/api/ai/save', { id: sv.dataset.save });
    r.ok ? toast('저장했습니다', 'ok') : toast(r.msg, 'err');
    refresh();
  } else if (dl) {
    await api('POST', '/api/ai/delete', { id: dl.dataset.del });
    refresh();
  }
}

async function refresh() {
  const st = await api('GET', '/api/ai/status');
  if (!st || st.ok === false) return;
  A.st = st;
  const u = st.usage;
  $('#aiHead').textContent = `모델 ${st.model} · 키 ${st.hasKey ? '설정됨' : '없음'}${u.calls ? ` · 이번 실행 사용량 ${u.calls}회 / 입력 ${fNum(u.input, 0)} · 출력 ${fNum(u.output, 0)} 토큰` : ''}`;
  const j = st.job;
  $('#aiJob').innerHTML = j.state === 'RUNNING' ? `<span class="warn">${esc(j.msg)} ${j.progress ?? 0}%</span>` : j.state === 'ERROR' ? `<span class="down">오류: ${esc(j.msg)}</span>` : j.state === 'DONE' ? `<span class="up">완료 ${fDateTime(j.finishedAt)}</span>` : '';
  ['aiAnalyze', 'aiImprove', 'aiGenerate'].forEach((id) => { $(`#${id}`).disabled = j.state === 'RUNNING'; });
  if (j.state === 'RUNNING' && !A.poll) poll();
  renderAnalysis(); renderImp(); renderGen();
}

function renderAnalysis() {
  const a = A.st.analysis;
  if (!a) return;
  $('#aiAnaMeta').textContent = `${a.period} · 분석 ${fDateTime(a.at)}`;
  $('#aiAnalysis').innerHTML = `<div class="ai-text"><b>종합</b> ${esc(a.overall)}</div>
    ${a.strategies.map((s) => `<div class="ai-strat"><div class="ai-sh"><b>${esc(SHORT[s.strategy] || s.strategy)}</b> ${tag(s.verdict)} <span>${esc(s.summary)}</span></div>
      ${s.lossCauses.length ? `<table class="t compact"><thead><tr><th class="l">손실 원인</th><th class="l">근거</th><th>영향</th></tr></thead><tbody>${s.lossCauses.map((c) => `<tr><td class="l ai-wrap">${esc(c.cause)}</td><td class="l ai-wrap muted">${esc(c.evidence)}</td><td class="${SEV[c.severity]?.[1] || ''}">${SEV[c.severity]?.[0] || c.severity}</td></tr>`).join('')}</tbody></table>` : ''}
      ${s.suggestions.length ? `<ul class="ai-list">${s.suggestions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`).join('')}
    ${a.portfolioRisks.length ? `<div class="ai-text"><b>전체 위험</b><ul class="ai-list">${a.portfolioRisks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${a.nextSteps.length ? `<div class="ai-text"><b>다음 단계</b><ul class="ai-list">${a.nextSteps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}`;
}

const metricsCells = (m) => (m ? `<td class="${m.returnPct >= 0 ? 'up' : 'down'}">${pct(m.returnPct)}</td><td class="down">${mdd(m.maxDrawdownPct)}</td><td>${m.trades}</td>` : '<td>—</td><td>—</td><td>—</td>');

function renderImp() {
  const imp = A.st?.improvements?.[A.impSel];
  if (!imp) { $('#aiImp').innerHTML = `<div class="empty">${SHORT[A.impSel]}: 아직 자동 개선을 실행하지 않았습니다</div>`; $('#aiImpMeta').textContent = ''; return; }
  $('#aiImpMeta').textContent = `${SHORT[imp.strategy]} · 학습 ${fDateTime(imp.split.start).slice(0, 10)}~${fDateTime(imp.split.cut).slice(0, 10)} · 검증 ~${fDateTime(imp.split.end).slice(0, 10)} · ${fDateTime(imp.at)}`;
  const b = imp.baseline;
  const rows = imp.candidates.map((c) => `<tr><td class="l">${c.round}회차</td><td class="l"><b>${esc(c.label)}</b><div class="muted ai-wrap">${esc(c.hypothesis)}</div></td>
    <td class="l ai-wrap">${c.error ? `<span class="down">${esc(c.error)}</span>` : c.changes.map((a) => `${esc(a.path)}: ${esc(a.from)} → <b>${esc(a.to)}</b>`).join('<br>')}</td>
    ${metricsCells(c.inSample)}${metricsCells(c.outSample)}<td>${tag(c.verdict)}</td>
    <td>${c.error ? '' : c.appliedAt ? '<span class="up">적용됨</span>' : `<button class="btn small ${c.verdict === 'PASSED' ? 'start' : 'ghost'}" data-apply="${imp.strategy}|${c.id}">적용</button>`}</td></tr>`).join('');
  $('#aiImp').innerHTML = `<table class="t compact"><thead><tr><th class="l">회차</th><th class="l">개선안</th><th class="l">변경 내용</th><th>학습 수익률</th><th>학습 낙폭</th><th>거래</th><th>검증 수익률</th><th>검증 낙폭</th><th>거래</th><th>판정</th><th></th></tr></thead>
    <tbody><tr class="grp"><td class="l">기준</td><td class="l">현재 설정</td><td></td>${metricsCells(b.inSample)}${metricsCells(b.outSample)}<td></td><td></td></tr>${rows}</tbody></table>
    ${imp.candidates[0]?.analysis ? `<div class="ai-text"><b>Claude 분석</b> ${esc(imp.candidates[0].analysis)}</div>` : ''}
    <div class="note">판정: 학습 구간에서 기준보다 (수익률 ÷ 최대낙폭)이 좋아지고, 보지 못한 검증 구간에서도 수익률이 떨어지지 않고 낙폭이 2%p 넘게 커지지 않으면 "검증 통과".</div>`;
}

function renderGen() {
  const g = A.st?.generated?.[0];
  const saved = A.st?.saved || [];
  const ver = (v) => `<div class="ai-strat"><div class="ai-sh"><b>${v.dsl ? esc(v.dsl.name) : `${v.round}회차`}</b> ${v.error ? tag('INVALID') : tag(v.verdict)} <span class="muted">${v.round}회차${v.verdictReason ? ' · ' + esc(v.verdictReason) : ''}</span></div>
    ${v.error ? `<div class="down ai-wrap">${esc(v.error)}</div>` : `<div class="ai-text">${esc(v.dsl.description)}</div>
    <table class="t compact kv"><tbody>
      <tr><td>캔들 / 종목</td><td class="l">${v.dsl.timeframe === '4h' ? '4시간' : '1일'} · ${v.dsl.symbols.map((s) => s.replace('USDT', '')).join(' ')}</td></tr>
      <tr><td>지표</td><td class="l ai-wrap">${esc(v.rules.indicators)}</td></tr>
      ${v.rules.longEntry ? `<tr><td>롱 진입 / 청산</td><td class="l ai-wrap">${esc(v.rules.longEntry)} <span class="muted">/</span> ${esc(v.rules.longExit)}</td></tr>` : ''}
      ${v.rules.shortEntry ? `<tr><td>숏 진입 / 청산</td><td class="l ai-wrap">${esc(v.rules.shortEntry)} <span class="muted">/</span> ${esc(v.rules.shortExit)}</td></tr>` : ''}
      <tr><td>손절 / 익절</td><td class="l">${v.dsl.stop.mode === 'ATR_DYNAMIC' ? `ATR${v.dsl.stop.atrPeriod}×${v.dsl.stop.atrMult} (${v.dsl.stop.minPct}~${v.dsl.stop.maxPct}%)` : v.dsl.stop.mode === 'FIXED_PERCENT' ? `고정 ${v.dsl.stop.fixedPct}%` : '없음'} / ${v.dsl.takeProfit.enabled ? `${v.dsl.takeProfit.pct}%` : '없음'}</td></tr>
      <tr><td>학습 구간</td><td class="l">수익률 ${pct(v.inSample.returnPct)} · 낙폭 ${mdd(v.inSample.maxDrawdownPct)} · 거래 ${v.inSample.trades} · 승률 ${v.inSample.winRatePct ?? '—'}%</td></tr>
      <tr><td>검증 구간</td><td class="l"><b>수익률 ${pct(v.outSample.returnPct)}</b> · 낙폭 ${mdd(v.outSample.maxDrawdownPct)} · 거래 ${v.outSample.trades}</td></tr>
      <tr><td>설계 의도</td><td class="l ai-wrap muted">${esc(v.dsl.rationale)}</td></tr>
    </tbody></table>
    ${saved.some((s) => s.id === v.id) ? '<span class="up">저장됨</span>' : `<button class="btn small primary" data-save="${v.id}">이 전략 저장</button>`}`}</div>`;
  $('#aiGen').innerHTML = `${g ? `<div class="muted" style="padding:4px 10px">아이디어: ${esc(g.idea || '(AI 자율 설계)')} · ${fDateTime(g.at)}</div><div class="ai-grid">${g.versions.map(ver).join('')}</div>` : '<div class="empty">아직 없음</div>'}
    ${saved.length ? `<div class="sub-h">저장한 AI 전략 (${saved.length})</div><table class="t compact"><thead><tr><th class="l">이름</th><th class="l">설명</th><th>캔들</th><th>학습 수익률</th><th>검증 수익률</th><th>검증 낙폭</th><th></th></tr></thead><tbody>
      ${saved.map((s) => `<tr><td class="l"><b>${esc(s.dsl.name)}</b></td><td class="l ai-wrap">${esc(s.dsl.description)}</td><td>${s.dsl.timeframe === '4h' ? '4시간' : '1일'}</td><td>${pct(s.inSample.returnPct)}</td><td>${pct(s.outSample.returnPct)}</td><td class="down">${mdd(s.outSample.maxDrawdownPct)}</td><td><button class="btn small danger" data-del="${s.id}">삭제</button></td></tr>`).join('')}</tbody></table>` : ''}`;
}
