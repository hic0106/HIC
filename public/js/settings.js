// Strategies tab: operational settings. Values are applied only when Save is pressed.
import { $, $$, esc, api, toast } from './util.js';
import { confirmDialog } from './modals.js';

const LABEL = {
  TURTLE: '터틀 20/10 · 롱 + 숏', ADX: 'ADX 추세 · 롱 + 숏', TSMOM: '30일 모멘텀 · 롱 / 현금', RAYNER: 'EMA50 + MACD · 롱 + 숏',
  QQQ_EMA_TREND: 'EMA 추세 · 롱 / 현금', QQQ_TSMOM: '장기 모멘텀 · 롱 / 현금',
  QQQ_SMA200: 'SMA200 추세 · 선택', QQQ_TURTLE_50_20: '느린 터틀 50/20 · 선택',
};
const PARAMS = {
  TURTLE: [['entryPeriod', '진입 기간 (봉)', 1], ['exitPeriod', '청산 기간 (봉)', 1], ['smaFilter', '숏 허용 SMA 기간', 1]],
  ADX: [['adxPeriod', 'ADX 기간', 1], ['threshold', 'ADX 기준값', 0.5], ['smaFilter', '숏 허용 SMA 기간', 1]],
  TSMOM: [['lookback', '모멘텀 기간 (일)', 1]],
  RAYNER: [['emaPeriod', 'EMA 기간', 1], ['fastPeriod', 'MACD Fast', 1], ['slowPeriod', 'MACD Slow', 1], ['signalPeriod', 'MACD Signal', 1],
    ['slopeLookback', 'EMA 기울기 비교 (봉 전)', 1], ['momentumLookback', '히스토그램 비교 봉 수', 1], ['momentumMultiplier', '모멘텀 배수', 0.1],
    ['stopLookback', '구조 손절 기간 (봉)', 1], ['targetLookback', '히스토그램 목표 기간 (봉)', 1], ['maxEntriesPerTrend', '추세당 최대 진입', 1]],
  QQQ_EMA_TREND: [['fastEma', '빠른 EMA', 1], ['slowEma', '느린 EMA', 1], ['sma200Filter', 'SMA200 위일 때만 진입', 'bool']],
  QQQ_TSMOM: [['lookback', '모멘텀 기간 (미국장 세션)', 'select:63,126,189,252'], ['sma200Filter', 'SMA200 위일 때만 진입', 'bool']],
  QQQ_SMA200: [['smaPeriod', 'SMA 기간', 1]],
  QQQ_TURTLE_50_20: [['entryPeriod', '진입 기간 (세션)', 1], ['exitPeriod', '청산 기간 (세션)', 1]],
};
const paramInput = (k, v, st) => {
  if (st === 'bool') return `<span>${sw(`p.${k}`, !!v)}</span>`;
  if (String(st).startsWith('select:')) return `<select name="p.${k}">${st.slice(7).split(',').map((x) => `<option ${Number(x) === Number(v) ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
  return numIn(`p.${k}`, v, st, 'min="1"');
};

let dirty = {};

export function renderStrategiesTab(root, S, onSaved) {
  if (Object.values(dirty).some(Boolean) && root.childElementCount) return; // keep unsaved edits
  const cfg = S.config;
  const mode = cfg.general.mode;
  const u = S.snap?.universe || S.meta.universe || {};
  const uc = cfg.cryptoUniverse || {};
  root.innerHTML = `<div class="set-row-h">코인 · Binance USDT-M · 거래대금 상위 ${uc.watchTopN ?? u.watchTopN ?? 20}개 감시 · 상위 ${uc.tradeTopN ?? u.tradeTopN ?? 15}개 신규진입 · 마감된 캔들로 신호 확인 (터틀·ADX·Rayner 4시간, TSMOM 1일) · 손절은 실시간</div>
    <div class="set-grid">${S.meta.cryptoStrategies.map((n) => stratCol(n, cfg.strategies[n], mode, S.meta.supportsShort[n])).join('')}${generalCol(cfg.general)}</div>
    <div class="set-row-h">코인 종목 선정 · 24시간 거래대금(USDT) 순위 · 감시 목록 변경은 프로그램 재시작 시 반영 (보유 포지션·주문·거래소 손절이 있는 종목은 순위와 관계없이 계속 감시)</div>
    <div class="set-grid four">${universeCol(uc, u)}</div>
    <div class="set-row-h">미국지수 · QQQUSDT (나스닥100 ETF QQQ 선물) · 롱 / 현금만 · 미국 정규장 마감 때 신호 확인 · Binance 과거 데이터 제한적 (2026-04-06 상장)</div>
    <div class="set-grid four">${S.meta.tradfiStrategies.map((n) => stratCol(n, cfg.strategies[n], mode, S.meta.supportsShort[n])).join('')}</div>`;
  dirty = {};

  $$('.set-col', root).forEach((col) => {
    const name = col.dataset.name;
    col.addEventListener('input', () => { dirty[name] = true; $('.dirty', col).classList.add('show'); syncDisabled(col); });
    syncDisabled(col);
    $('[data-act=revert]', col).onclick = () => { dirty = {}; renderStrategiesTab(root, S, onSaved); };
    $('[data-act=save]', col).onclick = async () => {
      const settings = name === 'GENERAL' ? readGeneral(col) : name === 'UNIVERSE' ? readUniverse(col) : readStrategy(col);
      const url = name === 'GENERAL' ? '/api/config/general' : name === 'UNIVERSE' ? '/api/config/universe' : `/api/config/strategy/${name}`;
      let r = await api('POST', url, { settings });
      if (!r.ok && r.needConfirm) {
        const w = await confirmDialog({ title: `${name} 설정을 실전에 적용`, danger: true, word: 'APPLY',
          html: '<p>LIVE 자동매매가 실행 중입니다. 저장한 설정은 다음 캔들 마감 평가부터 적용되며, 이미 보유 중인 포지션의 Stop 가격은 변경되지 않습니다.</p>' });
        if (!w) return;
        r = await api('POST', url, { settings, confirm: 'APPLY' });
      }
      if (!r.ok) return toast(r.msg || '저장 실패', 'err');
      toast(`${name === 'GENERAL' ? '공통' : name === 'UNIVERSE' ? '종목 선정' : name} 설정을 저장했습니다${r.restartRequired ? ' · 감시 목록은 재시작 후 반영' : ''}`, 'ok');
      dirty[name] = false;
      $('.dirty', col).classList.remove('show');
      await onSaved();
    };
    const reset = $('[data-act=resetPaper]', col);
    if (reset) reset.onclick = async () => {
      const w = await confirmDialog({ title: '모의투자 계좌 초기화', danger: true, word: 'RESET',
        html: `<p>Paper 계좌의 포지션·주문·거래내역을 모두 지우고 잔고를 Paper Initial Balance(저장된 값)로 초기화합니다.</p>` });
      if (!w) return;
      const r = await api('POST', '/api/paper/reset', { confirm: 'RESET' });
      r.ok ? toast('모의투자 계좌를 초기화했습니다', 'ok') : toast(r.msg, 'err');
    };
  });
}

const sw = (name, on, label = ['켜짐', '꺼짐']) => `<label class="sw"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}><span></span></label><span class="sw-lbl" data-for="${name}">${on ? label[0] : label[1]}</span>`;
const numIn = (name, v, step = 'any', extra = '') => `<input type="number" name="${name}" value="${esc(v)}" step="${step}" ${extra}>`;

function stratCol(name, c, mode, supportsShort) {
  const a = c.amounts;
  const act = (m) => (m === mode ? 'act' : '');
  return `<div class="set-col" data-name="${name}">
    <div class="set-h"><span><b>${name}</b><small>${LABEL[name]}</small></span><span>${sw('enabled', c.enabled, ['켜짐', '꺼짐'])}</span></div>
    <div class="set-sec">1회 주문금액 (USDT, 증거금)</div>
    <div class="fr amt"><span></span><span class="hd ${act('PAPER')}">모의${mode === 'PAPER' ? ' ●' : ''}</span><span class="hd ${act('LIVE')}">실전${mode === 'LIVE' ? ' ●' : ''}</span></div>
    <div class="fr amt"><label>롱 주문금액</label>${numIn('PAPER.long', a.PAPER.long, 1, `min="0" class="${act('PAPER')}"`)}${numIn('LIVE.long', a.LIVE.long, 1, `min="0" class="${act('LIVE')}"`)}</div>
    ${supportsShort ? `<div class="fr"><label>숏 사용</label><span>${sw('shortEnabled', c.shortEnabled)}</span></div>
    <div class="fr amt" data-dep="shortEnabled"><label>숏 주문금액</label>${numIn('PAPER.short', a.PAPER.short, 1, `min="0" class="${act('PAPER')}"`)}${numIn('LIVE.short', a.LIVE.short, 1, `min="0" class="${act('LIVE')}"`)}</div>`
      : '<div class="fr"><label>숏</label><span class="muted" style="text-align:right">없음 (롱 / 현금 전략)</span></div>'}
    <div class="fr"><label>레버리지 (배)</label>${numIn('leverage', c.leverage ?? 1, 1, `min="1" max="${c.timeframe ? 20 : 10}"`)}</div>
    <div class="note">포지션 규모 = 주문금액 × 레버리지. 같은 종목의 거래소 레버리지는 켜진 전략 중 가장 높은 값으로 설정. 변경은 봇 정지 상태에서만 가능.</div>
    ${c.timeframe ? `<div class="set-sec">신호 캔들</div>
    <div class="fr"><label>캔들 (마감 기준)</label><select name="timeframe">${['4h', '1d'].map((t) => `<option value="${t}" ${t === c.timeframe ? 'selected' : ''}>${t === '4h' ? '4시간' : '1일'}</option>`).join('')}</select></div>` : ''}
    <div class="set-sec">진입 / 청산 조건</div>
    ${PARAMS[name].map(([k, l, st]) => `<div class="fr"><label>${l}</label>${paramInput(k, c.params[k], st)}</div>`).join('')}
    <div class="set-sec">손절 (비상 Stop)</div>
    <div class="fr"><label>손절 방식</label><select name="stop.mode">${[...(name === 'RAYNER' ? ['STRUCTURE'] : []), 'ATR_DYNAMIC', 'FIXED_PERCENT', 'OFF'].map((m) => `<option value="${m}" ${m === c.stop.mode ? 'selected' : ''}>${{ STRUCTURE: '구조 (저점/고점)', ATR_DYNAMIC: 'ATR 변동폭', FIXED_PERCENT: '고정 %', OFF: '사용 안 함' }[m]}</option>`).join('')}</select></div>
    ${name === 'RAYNER' ? `<div class="fr" data-stop="STRUCTURE"><label>구조 손절</label><span class="muted" style="text-align:right">롱 ${c.params.stopLookback}봉 최저가 · 숏 ${c.params.stopLookback}봉 최고가</span></div>` : ''}
    <div class="fr" data-stop="ATR_DYNAMIC"><label>ATR 기간</label>${numIn('stop.atrPeriod', c.stop.atrPeriod, 1, 'min="2"')}</div>
    <div class="fr" data-stop="ATR_DYNAMIC"><label>ATR 배수</label>${numIn('stop.atrMult', c.stop.atrMult, 0.1, 'min="0.1"')}</div>
    <div class="fr" data-stop="ATR_DYNAMIC"><label>최소 손절 %</label>${numIn('stop.minPct', c.stop.minPct, 0.5, 'min="0.1"')}</div>
    <div class="fr" data-stop="ATR_DYNAMIC"><label>최대 손절 %</label>${numIn('stop.maxPct', c.stop.maxPct, 0.5, 'min="0.1"')}</div>
    <div class="fr" data-stop="FIXED_PERCENT"><label>고정 손절 %</label>${numIn('stop.fixedPct', c.stop.fixedPct, 0.5, 'min="0.1"')}</div>
    <div class="set-sec">익절</div>
    <div class="fr"><label>익절 사용</label><span>${sw('tp.enabled', c.takeProfit.enabled)}</span></div>
    <div class="fr" data-dep="tp.enabled"><label>익절 %</label>${numIn('tp.pct', c.takeProfit.pct, 1, 'min="0.1"')}</div>
    <div class="note">${name === 'RAYNER'
      ? '롱: 종가 > EMA, EMA 상승(비교 봉 전보다 높음), 히스토그램 > 0 이고 직전 N봉 최대값 × 배수 초과. 숏은 대칭. 구조 손절 = 신호 봉 포함 최근 N봉 최저가(롱)/최고가(숏), 진입 후 고정 (체결가 반대편이면 진입 취소). 청산: 히스토그램이 진입 때 고정한 최근 N봉 최대(롱)/최소(숏)값을 넘으면 익절, 종가가 EMA 반대편이거나 히스토그램 부호가 바뀌면 청산. 같은 추세에서 최대 진입 횟수 제한 (종가가 EMA 반대편에 마감하면 초기화).'
      : '손절가 = 진입가 × (1 ∓ ATR×배수/진입가, 최소~최대 % 범위). 신규 진입부터 적용, 보유 포지션 손절가는 유지. 전략 청산과 손절 중 먼저 발생한 쪽으로 청산.'}</div>
    <div class="set-actions"><span class="dirty">● 저장 안 됨</span><button class="btn ghost small" data-act="revert">되돌리기</button><button class="btn primary" data-act="save">${name} 저장</button></div>
  </div>`;
}

function generalCol(g) {
  return `<div class="set-col" data-name="GENERAL">
    <div class="set-h"><span><b>공통 설정</b><small>주문 · 비용 · 안전</small></span></div>
    <div class="set-sec">비용 (손익에 반영)</div>
    <div class="fr"><label>시장가 수수료 %</label>${numIn('takerFeePct', g.takerFeePct, 0.001, 'min="0"')}</div>
    <div class="fr"><label>지정가 수수료 %</label>${numIn('makerFeePct', g.makerFeePct, 0.001, 'min="0"')}</div>
    <div class="fr"><label>슬리피지 % (모의·백테스트)</label>${numIn('slippagePct', g.slippagePct, 0.01, 'min="0"')}</div>
    <div class="fr"><label>펀딩비 반영</label><span>${sw('includeFunding', g.includeFunding)}</span></div>
    <div class="set-sec">원금</div>
    <div class="fr"><label>모의투자 시작 잔고</label>${numIn('paperInitialBalance', g.paperInitialBalance, 100, 'min="1"')}</div>
    <div class="note">총 수익률 = 누적 손익 / 원금. 실전 원금은 현재 계좌 자산(실시간).</div>
    <div class="set-sec">안전 장치</div>
    <div class="fr"><label>거래소 손절주문 (실전)</label><span>${sw('exchangeStops', g.exchangeStops)}</span></div>
    <div class="fr" data-dep="exchangeStops"><label>손절 기준 가격</label><select name="stopWorkingType">${['CONTRACT_PRICE', 'MARK_PRICE'].map((m) => `<option value="${m}" ${m === g.stopWorkingType ? 'selected' : ''}>${m === 'CONTRACT_PRICE' ? '최근 체결가' : '마크 가격'}</option>`).join('')}</select></div>
    <div class="note">켜면 실전 진입 직후 Binance에 손절주문(STOP_MARKET)을 걸어 PC/프로그램이 꺼져도 손절됩니다. 봇이 청산할 때는 이 주문을 먼저 취소합니다.</div>
    <div class="fr"><label>봇 정지 중에도 손절</label><span>${sw('stopsActiveWhenStopped', g.stopsActiveWhenStopped, ['작동', '꺼짐'])}</span></div>
    <div class="fr"><label>시세 지연 한도 (초)</label>${numIn('dataStaleSec', g.dataStaleSec, 1, 'min="5"')}</div>
    <div class="fr"><label>잔고 여유분 %</label>${numIn('balanceBufferPct', g.balanceBufferPct, 0.5, 'min="0"')}</div>
    <div class="set-actions"><span class="dirty">● 저장 안 됨</span><button class="btn ghost small" data-act="resetPaper">모의계좌 초기화</button><button class="btn ghost small" data-act="revert">되돌리기</button><button class="btn primary" data-act="save">공통 설정 저장</button></div>
  </div>`;
}

function universeCol(c, u) {
  const rank = (u.rows || []).filter((r) => r.rank != null || r.protected).map((r) => `<span class="${r.tradeAllowed ? '' : 'muted'}" title="${r.quoteVolume != null ? `24h ${Math.round(r.quoteVolume / 1e6).toLocaleString()}M USDT` : ''}${r.protected ? ' · 보호(보유/주문/손절)' : ''}">${r.rank != null ? `#${r.rank}` : '#-'} ${r.symbol.replace('USDT', '')}${r.protected ? '*' : ''}</span>`).join(' ');
  const src = { LIVE: '실시간 순위', CACHE: '저장된 순위 (조회 실패)', FALLBACK: '기본 종목 (조회 실패)', STATIC: '고정 종목' }[u.source] || u.source || '—';
  return `<div class="set-col" data-name="UNIVERSE">
    <div class="set-h"><span><b>종목 선정</b><small>거래대금 상위 코인 · 동적</small></span></div>
    <div class="set-sec">현재 상태</div>
    <div class="fr"><label>기준</label><span class="muted" style="text-align:right">${esc(src)}${u.rankedAt ? ` · ${new Date(u.rankedAt).toLocaleString()}` : ''}</span></div>
    <div class="fr"><label>감시 / 신규진입</label><span style="text-align:right">${(u.watchSymbols || []).length} / ${(u.tradeSymbols || []).length}개</span></div>
    <div class="note">${rank || '순위 없음'}${u.pending ? `<br><span class="warn">재시작 시 감시 목록 변경: +${esc((u.pending.add || []).join(' ') || '-')} / -${esc((u.pending.remove || []).join(' ') || '-')}</span>` : ''}<br>흐린 종목 = 감시만 (신규진입 안 함) · * = 보유/주문/손절 보호</div>
    <div class="set-sec">선정 기준</div>
    <div class="fr"><label>감시 종목 수</label>${numIn('watchTopN', c.watchTopN ?? 20, 1, 'min="1" max="50"')}</div>
    <div class="fr"><label>신규진입 종목 수</label>${numIn('tradeTopN', c.tradeTopN ?? 15, 1, 'min="1" max="50"')}</div>
    <div class="fr"><label>최소 상장 기간 (일)</label>${numIn('minListingDays', c.minListingDays ?? 90, 1, 'min="0"')}</div>
    <div class="fr"><label>스테이블코인 제외</label><span>${sw('excludeStablecoinBases', c.excludeStablecoinBases !== false)}</span></div>
    <div class="fr"><label>항상 포함</label><input type="text" name="alwaysInclude" value="${esc((c.alwaysInclude || []).join(', '))}"></div>
    <div class="set-sec">백테스트</div>
    <div class="fr"><label>과거 거래대금 순위 사용</label><span>${sw('backtestDynamic', c.backtestDynamic !== false)}</span></div>
    <div class="fr" data-dep="backtestDynamic"><label>순위 계산 기간 (일)</label>${numIn('backtestRankLookbackDays', c.backtestRankLookbackDays ?? 30, 1, 'min="1"')}</div>
    <div class="fr" data-dep="backtestDynamic"><label>리밸런싱 주기 (일)</label>${numIn('backtestRebalanceDays', c.backtestRebalanceDays ?? 7, 1, 'min="1"')}</div>
    <div class="note">백테스트는 현재 감시 종목 안에서 각 시점 직전 기간의 거래대금만으로 진입 종목을 다시 고릅니다 (미래 데이터 미사용). 과거에 상위였다가 지금 빠진 코인은 포함되지 않습니다.</div>
    <div class="set-actions"><span class="dirty">● 저장 안 됨</span><button class="btn ghost small" data-act="revert">되돌리기</button><button class="btn primary" data-act="save">종목 선정 저장</button></div>
  </div>`;
}

function readUniverse(col) {
  const val = (n) => v(col, n)?.value;
  const chk = (n) => !!v(col, n)?.checked;
  return {
    watchTopN: val('watchTopN'), tradeTopN: val('tradeTopN'), minListingDays: val('minListingDays'),
    excludeStablecoinBases: chk('excludeStablecoinBases'), backtestDynamic: chk('backtestDynamic'),
    backtestRankLookbackDays: val('backtestRankLookbackDays'), backtestRebalanceDays: val('backtestRebalanceDays'),
    alwaysInclude: String(val('alwaysInclude') || '').split(/[\s,]+/).filter(Boolean),
  };
}

function syncDisabled(col) {
  $$('.sw input', col).forEach((i) => {
    const l = $(`.sw-lbl[data-for="${i.name}"]`, col);
    if (l) {
      const on = i.checked;
      const lbl = i.name === 'enabled' ? ['켜짐', '꺼짐'] : i.name === 'stopsActiveWhenStopped' ? ['작동', '꺼짐'] : ['켜짐', '꺼짐'];
      l.textContent = on ? lbl[0] : lbl[1];
      l.className = `sw-lbl ${on ? 'up' : 'muted'}`;
    }
  });
  $$('[data-dep]', col).forEach((r) => { const i = $(`[name="${r.dataset.dep}"]`, col); r.classList.toggle('disabled', !!i && !i.checked); });
  const mode = $('[name="stop.mode"]', col)?.value;
  $$('[data-stop]', col).forEach((r) => r.classList.toggle('disabled', r.dataset.stop !== mode));
}

const v = (col, n) => $(`[name="${n}"]`, col);
function readStrategy(col) {
  const val = (n) => v(col, n)?.value;
  const chk = (n) => !!v(col, n)?.checked;
  const params = {};
  $$('[name^="p."]', col).forEach((i) => { params[i.name.slice(2)] = i.type === 'checkbox' ? i.checked : i.value; });
  return {
    enabled: chk('enabled'), shortEnabled: chk('shortEnabled'), timeframe: val('timeframe'), leverage: val('leverage'),
    amounts: { PAPER: { long: val('PAPER.long'), short: val('PAPER.short') ?? 0 }, LIVE: { long: val('LIVE.long'), short: val('LIVE.short') ?? 0 } },
    params,
    stop: { mode: val('stop.mode'), atrPeriod: val('stop.atrPeriod'), atrMult: val('stop.atrMult'), minPct: val('stop.minPct'), maxPct: val('stop.maxPct'), fixedPct: val('stop.fixedPct') },
    takeProfit: { enabled: chk('tp.enabled'), pct: val('tp.pct') },
  };
}
function readGeneral(col) {
  const o = {};
  $$('input, select', col).forEach((i) => { if (i.name) o[i.name] = i.type === 'checkbox' ? i.checked : i.value; });
  return o;
}
