// Strategies tab: operational settings. Values are applied only when Save is pressed.
import { $, $$, esc, api, toast } from './util.js';
import { confirmDialog } from './modals.js';

const LABEL = {
  TURTLE: 'Turtle 20/10 · Long + Short', ADX: 'ADX Trend · Long + Short', TSMOM: '30D Time-Series Momentum · Long + Cash',
  QQQ_EMA_TREND: 'EMA Trend · Long / Cash', QQQ_TSMOM: 'Long-Term TSMOM · Long / Cash',
  QQQ_SMA200: 'SMA200 Regime · optional', QQQ_TURTLE_50_20: 'Slow Turtle 50/20 · optional',
};
const PARAMS = {
  TURTLE: [['entryPeriod', 'Entry Period (bars)', 1], ['exitPeriod', 'Exit Period (bars)', 1], ['smaFilter', 'Short SMA Filter', 1]],
  ADX: [['adxPeriod', 'ADX Period', 1], ['threshold', 'ADX Threshold', 0.5], ['smaFilter', 'Short SMA Filter', 1]],
  TSMOM: [['lookback', 'Lookback (D)', 1]],
  QQQ_EMA_TREND: [['fastEma', 'Fast EMA', 1], ['slowEma', 'Slow EMA', 1], ['sma200Filter', 'SMA200 entry filter', 'bool']],
  QQQ_TSMOM: [['lookback', 'Lookback (US sessions)', 'select:63,126,189,252'], ['sma200Filter', 'SMA200 entry filter', 'bool']],
  QQQ_SMA200: [['smaPeriod', 'SMA Period', 1]],
  QQQ_TURTLE_50_20: [['entryPeriod', 'Entry Period (sessions)', 1], ['exitPeriod', 'Exit Period (sessions)', 1]],
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
  root.innerHTML = `<div class="set-row-h">CRYPTO · BTCUSDT / ETHUSDT / XRPUSDT · signals on closed Binance candles (Turtle / ADX 4H, TSMOM 1D) · stops real-time</div>
    <div class="set-grid">${S.meta.cryptoStrategies.map((n) => stratCol(n, cfg.strategies[n], mode, S.meta.supportsShort[n])).join('')}${generalCol(cfg.general)}</div>
    <div class="set-row-h">TRADFI · QQQUSDT (Invesco QQQ index perpetual) · LONG / CASH only · signals on US regular-session close (America/New_York) · Binance native history LIMITED (since 2026-04-06)</div>
    <div class="set-grid four">${S.meta.tradfiStrategies.map((n) => stratCol(n, cfg.strategies[n], mode, S.meta.supportsShort[n])).join('')}</div>`;
  dirty = {};

  $$('.set-col', root).forEach((col) => {
    const name = col.dataset.name;
    col.addEventListener('input', () => { dirty[name] = true; $('.dirty', col).classList.add('show'); syncDisabled(col); });
    syncDisabled(col);
    $('[data-act=revert]', col).onclick = () => { dirty = {}; renderStrategiesTab(root, S, onSaved); };
    $('[data-act=save]', col).onclick = async () => {
      const settings = name === 'GENERAL' ? readGeneral(col) : readStrategy(col);
      const url = name === 'GENERAL' ? '/api/config/general' : `/api/config/strategy/${name}`;
      let r = await api('POST', url, { settings });
      if (!r.ok && r.needConfirm) {
        const w = await confirmDialog({ title: `APPLY ${name} SETTINGS TO LIVE`, danger: true, word: 'APPLY',
          html: '<p>LIVE 자동매매가 실행 중입니다. 저장한 설정은 다음 캔들 마감 평가부터 적용되며, 이미 보유 중인 포지션의 Stop 가격은 변경되지 않습니다.</p>' });
        if (!w) return;
        r = await api('POST', url, { settings, confirm: 'APPLY' });
      }
      if (!r.ok) return toast(r.msg || 'Save failed', 'err');
      toast(`${name} settings saved`, 'ok');
      dirty[name] = false;
      $('.dirty', col).classList.remove('show');
      await onSaved();
    };
    const reset = $('[data-act=resetPaper]', col);
    if (reset) reset.onclick = async () => {
      const w = await confirmDialog({ title: 'RESET PAPER ACCOUNT', danger: true, word: 'RESET',
        html: `<p>Paper 계좌의 포지션·주문·거래내역을 모두 지우고 잔고를 Paper Initial Balance(저장된 값)로 초기화합니다.</p>` });
      if (!w) return;
      const r = await api('POST', '/api/paper/reset', { confirm: 'RESET' });
      r.ok ? toast('Paper account reset', 'ok') : toast(r.msg, 'err');
    };
  });
}

const sw = (name, on, label = ['ON', 'OFF']) => `<label class="sw"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}><span></span></label><span class="sw-lbl" data-for="${name}">${on ? label[0] : label[1]}</span>`;
const numIn = (name, v, step = 'any', extra = '') => `<input type="number" name="${name}" value="${esc(v)}" step="${step}" ${extra}>`;

function stratCol(name, c, mode, supportsShort) {
  const a = c.amounts;
  const act = (m) => (m === mode ? 'act' : '');
  return `<div class="set-col" data-name="${name}">
    <div class="set-h"><span><b>${name}</b><small>${LABEL[name]}</small></span><span>${sw('enabled', c.enabled, ['ENABLED', 'DISABLED'])}</span></div>
    <div class="set-sec">Order Amount (USDT, fixed per order)</div>
    <div class="fr amt"><span></span><span class="hd ${act('PAPER')}">PAPER${mode === 'PAPER' ? ' ●' : ''}</span><span class="hd ${act('LIVE')}">LIVE${mode === 'LIVE' ? ' ●' : ''}</span></div>
    <div class="fr amt"><label>Long Order Amount</label>${numIn('PAPER.long', a.PAPER.long, 1, `min="0" class="${act('PAPER')}"`)}${numIn('LIVE.long', a.LIVE.long, 1, `min="0" class="${act('LIVE')}"`)}</div>
    ${supportsShort ? `<div class="fr"><label>Short Enabled</label><span>${sw('shortEnabled', c.shortEnabled)}</span></div>
    <div class="fr amt" data-dep="shortEnabled"><label>Short Order Amount</label>${numIn('PAPER.short', a.PAPER.short, 1, `min="0" class="${act('PAPER')}"`)}${numIn('LIVE.short', a.LIVE.short, 1, `min="0" class="${act('LIVE')}"`)}</div>`
      : '<div class="fr"><label>Short</label><span class="muted" style="text-align:right">OFF (LONG / CASH)</span></div>'}
    ${c.timeframe ? `<div class="set-sec">Signal Timeframe</div>
    <div class="fr"><label>Candle (closed only)</label><select name="timeframe">${['4h', '1d'].map((t) => `<option value="${t}" ${t === c.timeframe ? 'selected' : ''}>${t.toUpperCase()}</option>`).join('')}</select></div>` : ''}
    <div class="set-sec">Entry / Exit Parameters</div>
    ${PARAMS[name].map(([k, l, st]) => `<div class="fr"><label>${l}</label>${paramInput(k, c.params[k], st)}</div>`).join('')}
    <div class="set-sec">Emergency Stop Loss</div>
    <div class="fr"><label>Stop Loss Mode</label><select name="stop.mode">${['ATR_DYNAMIC', 'FIXED_PERCENT', 'OFF'].map((m) => `<option ${m === c.stop.mode ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
    <div class="fr" data-stop="ATR_DYNAMIC"><label>ATR Period</label>${numIn('stop.atrPeriod', c.stop.atrPeriod, 1, 'min="2"')}</div>
    <div class="fr" data-stop="ATR_DYNAMIC"><label>ATR Multiplier</label>${numIn('stop.atrMult', c.stop.atrMult, 0.1, 'min="0.1"')}</div>
    <div class="fr" data-stop="ATR_DYNAMIC"><label>Minimum Stop %</label>${numIn('stop.minPct', c.stop.minPct, 0.5, 'min="0.1"')}</div>
    <div class="fr" data-stop="ATR_DYNAMIC"><label>Maximum Stop %</label>${numIn('stop.maxPct', c.stop.maxPct, 0.5, 'min="0.1"')}</div>
    <div class="fr" data-stop="FIXED_PERCENT"><label>Fixed Stop %</label>${numIn('stop.fixedPct', c.stop.fixedPct, 0.5, 'min="0.1"')}</div>
    <div class="set-sec">Take Profit</div>
    <div class="fr"><label>Take Profit</label><span>${sw('tp.enabled', c.takeProfit.enabled)}</span></div>
    <div class="fr" data-dep="tp.enabled"><label>Take Profit %</label>${numIn('tp.pct', c.takeProfit.pct, 1, 'min="0.1"')}</div>
    <div class="note">Stop = Entry × (1 ∓ clamp(ATR×Mult / Entry, Min%, Max%)). 신규 진입부터 적용, 보유 포지션 Stop은 유지. 전략 Exit와 Stop 중 먼저 발생한 조건으로 청산.</div>
    <div class="set-actions"><span class="dirty">● UNSAVED CHANGES</span><button class="btn ghost small" data-act="revert">Revert</button><button class="btn primary" data-act="save">SAVE ${name}</button></div>
  </div>`;
}

function generalCol(g) {
  return `<div class="set-col" data-name="GENERAL">
    <div class="set-h"><span><b>GENERAL</b><small>Execution · Costs · Risk</small></span></div>
    <div class="set-sec">Futures Execution</div>
    <div class="fr"><label>Leverage Crypto (x)</label>${numIn('leverage', g.leverage, 1, 'min="1" max="20"')}</div>
    <div class="fr"><label>Leverage TradFi QQQ (x)</label>${numIn('leverageTradfi', g.leverageTradfi ?? 1, 1, 'min="1" max="10"')}</div>
    <div class="note">기본 1x. 주문금액 = 포지션 명목금액(Notional). 레버리지는 증거금만 줄이며 자동으로 올리지 않음. 변경은 봇 정지 상태에서만 가능.</div>
    <div class="set-sec">Costs (PnL 반영)</div>
    <div class="fr"><label>Taker Fee %</label>${numIn('takerFeePct', g.takerFeePct, 0.001, 'min="0"')}</div>
    <div class="fr"><label>Maker Fee %</label>${numIn('makerFeePct', g.makerFeePct, 0.001, 'min="0"')}</div>
    <div class="fr"><label>Slippage % (Paper)</label>${numIn('slippagePct', g.slippagePct, 0.01, 'min="0"')}</div>
    <div class="fr"><label>Include Funding Fee</label><span>${sw('includeFunding', g.includeFunding)}</span></div>
    <div class="set-sec">Capital</div>
    <div class="fr"><label>Paper Initial Balance</label>${numIn('paperInitialBalance', g.paperInitialBalance, 100, 'min="1"')}</div>
    <div class="fr"><label>Live Base Capital</label>${numIn('liveBaseCapital', g.liveBaseCapital ?? '', 1, 'min="1" placeholder="auto"')}</div>
    <div class="note">Total Return % = Total PnL / Base Capital. LIVE 값이 비어 있으면 최초 연결 시 계좌 Equity로 자동 설정.</div>
    <div class="set-sec">Safety</div>
    <div class="fr"><label>Binance Stop Orders (LIVE)</label><span>${sw('exchangeStops', g.exchangeStops)}</span></div>
    <div class="fr" data-dep="exchangeStops"><label>Stop Trigger Price</label><select name="stopWorkingType">${['CONTRACT_PRICE', 'MARK_PRICE'].map((m) => `<option ${m === g.stopWorkingType ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
    <div class="note">ON이면 LIVE 진입 직후 Binance에 STOP_MARKET을 등록해 PC/프로그램이 꺼져도 손절이 실행됩니다. 봇이 청산할 때는 이 주문을 먼저 취소합니다. CONTRACT_PRICE = 최근 체결가, MARK_PRICE = 마크가격.</div>
    <div class="fr"><label>Emergency Stops when STOPPED</label><span>${sw('stopsActiveWhenStopped', g.stopsActiveWhenStopped, ['ACTIVE', 'OFF'])}</span></div>
    <div class="fr"><label>Data Delay Limit (sec)</label>${numIn('dataStaleSec', g.dataStaleSec, 1, 'min="5"')}</div>
    <div class="fr"><label>Balance Buffer %</label>${numIn('balanceBufferPct', g.balanceBufferPct, 0.5, 'min="0"')}</div>
    <div class="set-actions"><span class="dirty">● UNSAVED CHANGES</span><button class="btn ghost small" data-act="resetPaper">Reset Paper</button><button class="btn ghost small" data-act="revert">Revert</button><button class="btn primary" data-act="save">SAVE GENERAL</button></div>
  </div>`;
}

function syncDisabled(col) {
  $$('.sw input', col).forEach((i) => {
    const l = $(`.sw-lbl[data-for="${i.name}"]`, col);
    if (l) {
      const on = i.checked;
      const lbl = i.name === 'enabled' ? ['ENABLED', 'DISABLED'] : i.name === 'stopsActiveWhenStopped' ? ['ACTIVE', 'OFF'] : ['ON', 'OFF'];
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
    enabled: chk('enabled'), shortEnabled: chk('shortEnabled'), timeframe: val('timeframe'),
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
