// HIC Trading Terminal — frontend (vanilla JS, lightweight-charts v5 standalone).
import { $, $$, esc, fUsd, fSigned, fPct, fNum, fPrice, fDur, fTime, fDateTime, cls, api, toast } from './util.js';
import { ChartView } from './chart.js';
import { renderStrategiesTab } from './settings.js';
import { confirmDialog, openApiModal } from './modals.js';
import { mountController, unmountController, controllerHeaderHtml, statusTag } from './controller.js';

const SHORT = { TURTLE: 'TURTLE', ADX: 'ADX', TSMOM: 'TSMOM', QQQ_EMA_TREND: 'QQQ EMA TREND', QQQ_TSMOM: 'QQQ TSMOM', QQQ_SMA200: 'QQQ SMA200', QQQ_TURTLE_50_20: 'QQQ TURTLE 50/20' };
const CHIP = { TURTLE: 'TURT', ADX: 'ADX', TSMOM: 'TSMOM', QQQ_EMA_TREND: 'EMA', QQQ_TSMOM: 'TSM', QQQ_SMA200: 'SMA', QQQ_TURTLE_50_20: 'T50' };
const stratsOf = (sym) => S.meta.strategiesBySymbol[sym] || [];
const classOf = (sym) => S.meta.symbolMeta[sym]?.asset_class || 'CRYPTO';
const isLongOnly = (st) => !S.meta.supportsShort[st];
const S = {
  snap: null, config: null, meta: null, sel: localGet('sel', 'BTCUSDT'), tab: 'positions',
  logs: [], logFilter: 'ALL', errCount: 0,
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
  connectWs();
}

function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'snapshot') { S.snap = m.data; render(); }
    else if (m.type === 'kline') chart.onKline(m.data);
    else if (m.type === 'log') addLogs([m.data]);
    else if (m.type === 'logs') { S.logs = []; $('#logList').innerHTML = ''; addLogs(m.data); }
  };
  ws.onclose = () => {
    $('#sMarket').className = 'dot bad'; $('#sMarket').textContent = 'SERVER OFFLINE';
    setTimeout(connectWs, 2000);
  };
}

// ---------------- UI bindings
function bindUi() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    S.tab = b.dataset.tab;
    $$('#tabs button[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab-pane').forEach((p) => p.classList.toggle('on', p.id === `tab-${S.tab}`));
    if (S.tab === 'strategies') openStrategies();
    if (S.tab === 'controller') mountController($('#tab-controller')); else unmountController();
    if (S.tab === 'log') { S.errCount = 0; updateErrBadge(); scrollLog(); }
    renderBottom();
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
      const w = await confirmDialog({ title: 'START LIVE TRADING', danger: true, word: 'LIVE',
        html: `<p>실계좌(<b>${S.snap.conn.testnet ? 'TESTNET' : 'MAINNET'}</b>)에서 자동매매를 시작합니다.</p><p>Leverage <b>${S.config.general.leverage}x</b>, 전략별 LIVE 주문금액이 적용됩니다.</p>` });
      if (!w) return;
      body = { confirm: 'LIVE' };
    }
    const r = await api('POST', '/api/bot/start', body);
    r.ok ? toast('Bots started', 'ok') : toast(r.msg, 'err');
  };
  $('#btnStop').onclick = async () => {
    const ok = await confirmDialog({ title: 'STOP ALL BOTS', danger: true,
      html: `<p>모든 전략 실행과 신규 주문을 중단합니다.</p><p><b>기존 포지션은 청산되지 않습니다.</b> Emergency Stop은 ${S.snap?.stopsActiveWhenStopped ? '<span class="up">계속 동작</span>' : '<span class="down">중단</span>'}합니다 (Strategies › General 설정).</p>`, okText: 'STOP ALL BOTS' });
    if (!ok) return;
    const r = await api('POST', '/api/bot/stop');
    r.ok ? toast('All bots stopped', 'ok') : toast(r.msg, 'err');
  };
  $('#btnCloseAll').onclick = async () => {
    const n = S.snap?.positions.length || 0;
    if (!n) return toast('No open positions');
    const w = await confirmDialog({ title: 'CLOSE ALL POSITIONS', danger: true, word: 'CLOSE ALL',
      html: `<p><b>${S.snap.mode}</b> 모드의 포지션 <b>${n}개</b>를 모두 시장가로 청산합니다 (Exit Reason: EMERGENCY_CLOSE).</p><p>봇 실행 상태는 변경되지 않습니다.</p>` });
    if (!w) return;
    const r = await api('POST', '/api/positions/close-all', { confirm: 'CLOSE ALL' });
    r.ok ? toast('All positions closed', 'ok') : toast(r.msg || 'Some closes failed — see System Log', 'err');
  };
  $('#btnApi').onclick = () => openApiModal();
  $('#modeSwitch').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.disabled || b.dataset.mode === S.snap?.mode) return;
    const mode = b.dataset.mode;
    let body = { mode };
    if (mode === 'LIVE') {
      const w = await confirmDialog({ title: 'SWITCH TO LIVE MODE', danger: true, word: 'LIVE',
        html: '<p>LIVE 모드에서는 실제 Binance USDT-M Futures 계좌로 주문합니다.</p><p>전환 후에도 START BOTS를 눌러야 자동매매가 시작됩니다.</p>' });
      if (!w) return;
      body.confirm = 'LIVE';
    }
    const r = await api('POST', '/api/mode', body);
    if (r.ok) { toast(`Mode: ${mode}`, 'ok'); await reloadConfig(); } else toast(r.msg, 'err');
  });

  // delegated actions in bottom tables
  $('#tabBody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-close]');
    if (b) {
      const [strategy, symbol] = b.dataset.close.split(':');
      const ok = await confirmDialog({ title: 'CLOSE POSITION', danger: true, html: `<p><b>${strategy} ${symbol}</b> 포지션을 시장가로 청산합니다 (MANUAL_EXIT).</p>`, okText: 'CLOSE' });
      if (!ok) return;
      const r = await api('POST', '/api/positions/close', { strategy, symbol });
      r.ok ? toast('Position closed', 'ok') : toast(r.msg, 'err');
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
  $('#intervalSeg').innerHTML = [...S.meta.intervals, S.meta.sessionInterval].map((i) => `<button data-iv="${i}" class="${i === cur ? 'on' : ''}" ${i === S.meta.sessionInterval ? 'title="US regular-session daily candles (QQQ signal data)"' : ''}>${i === S.meta.sessionInterval ? 'US 1D' : i.toUpperCase()}</button>`).join('');
  chart.interval = cur;
  $('#intervalSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-iv]');
    if (!b) return;
    $$('#intervalSeg button').forEach((x) => x.classList.toggle('on', x === b));
    chart.interval = b.dataset.iv;
    localSet('iv', b.dataset.iv);
    chart.load(S.sel).then(() => S.snap && chart.updateOverlays(S.snap, S.sel));
  });
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
  mb.textContent = live ? (s.conn.testnet ? 'LIVE·TEST' : 'LIVE') : 'PAPER';
  mb.className = `mode-badge ${live ? 'live' : 'paper'}`;
  $$('#modeSwitch button').forEach((b) => { b.classList.toggle('on', b.dataset.mode === s.mode); b.disabled = s.runState === 'RUNNING'; });
  document.title = `${a.equity != null ? fUsd(a.equity, 0) : '—'} · ${s.mode} ${s.runState} — HIC`;

  $('#kEquity').textContent = a.equity != null ? fUsd(a.equity) : '—';
  setSigned($('#kToday'), a.todayPnl, fSigned(a.todayPnl));
  $('#kTodayPct').textContent = a.baseCapital ? fPct(a.todayPnl / a.baseCapital * 100) : '';
  setSigned($('#kReturn'), a.totalReturnPct, a.totalReturnPct != null ? fPct(a.totalReturnPct) : '—');
  $('#kBase').textContent = a.baseCapital ? `base ${fUsd(a.baseCapital, 0)}` : 'base not set';
  $('#kAvail').textContent = a.available != null ? fUsd(a.available) : '—';
  $('#kInvested').textContent = fUsd(a.invested);
  setSigned($('#kTotalPnl'), a.totalPnl, fSigned(a.totalPnl));
  $('#kLong').textContent = fUsd(a.longExp);
  $('#kShort').textContent = fUsd(a.shortExp);
  setSigned($('#kNet'), a.netExp, fSigned(a.netExp));

  setDot($('#sMarket'), s.conn.market === 'CONNECTED' ? 'ok' : 'bad', s.conn.market);
  const ex = s.conn.exchange;
  setDot($('#sExchange'), ex === 'CONNECTED' ? 'ok' : ex === 'PAPER' ? 'off' : ex === 'NO_KEYS' || ex === 'UNVERIFIED' ? 'warn' : 'bad', ex === 'PAPER' ? 'N/A (PAPER)' : ex);
  $('#sExchange').title = s.conn.liveError || '';
  setDot($('#sBot'), s.runState === 'RUNNING' ? 'ok' : 'bad', s.runState);
  const age = s.lastDataUpdate ? (Date.now() - s.lastDataUpdate) / 1000 : null;
  $('#sLast').innerHTML = s.lastDataUpdate ? `<span class="${age > 10 ? 'down' : ''}">${fTime(s.lastDataUpdate)}</span>` : '—';
  $('#btnStart').disabled = s.runState === 'RUNNING';
  $('#btnStop').disabled = s.runState !== 'RUNNING';
}

function setSigned(el, v, text) { el.textContent = text; el.className = cls(v); }
function setDot(el, k, t) { el.className = `dot ${k}`; el.textContent = t; }

function slotOf(s, st, sym) { return s.slots.find((x) => x.strategy === st && x.symbol === sym); }
function stLetter(status) {
  return { LONG: ['L', 'LONG'], SHORT: ['S', 'SHORT'], FLAT: ['W', 'WAIT'], PENDING: ['P', 'PEND'], UNKNOWN: ['U', 'UNKN'], OFF: ['O', 'OFF'] }[status] || ['W', status];
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
    const chips = stratsOf(sym).map((st) => {
      const sl = slotOf(s, st, sym);
      let [k, label] = stLetter(sl.status);
      if (isLongOnly(st) && sl.status === 'FLAT') { k = 'W'; label = 'CASH'; }
      return `<div class="st-chip"><i>${CHIP[st]}</i><span class="st-${k}">${label}</span></div>`;
    }).join('');
    const um = m.underlyingMarket;
    const sub = m.unavailable ? '<span class="tag SHORT" title="' + esc(m.unavailable) + '">UNAVAILABLE</span>'
      : um ? `<span class="tag ${um.underlying === 'OPEN' ? 'LONG' : 'WAIT'}" title="Underlying US regular session">US ${um.underlying}</span>` : '';
    return `<div class="wl-row ${sym === S.sel ? 'sel' : ''}" data-sym="${sym}">
      <div class="wl-top"><span class="wl-sym">${sym.replace('USDT', '')}<small>USDT</small></span><span class="wl-px ${cls(t?.changePct)}">${fPrice(m.price, f)}</span></div>
      <div class="wl-mid"><span><span class="tag ${netTag}">${netTag}</span> ${sub}</span><span class="${cls(t?.changePct)}">${t ? fPct(t.changePct) : '—'}</span></div>
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
  $('#expTable').innerHTML = `<thead><tr><th>Asset</th><th>Long</th><th>Short</th><th>Net</th></tr></thead><tbody>${body}</tbody>
    <tfoot><tr><td>TOTAL</td><td class="up">${fNum(a.longExp, 0)}</td><td class="down">${fNum(a.shortExp, 0)}</td><td class="${cls(a.netExp)}">${fSigned(a.netExp, 0)}</td></tr>
    <tr><td>GROSS</td><td colspan="3">${fNum(a.grossExp, 0)} · Crypto ${fNum(a.byClass?.CRYPTO?.gross, 0)} · TradFi ${fNum(a.byClass?.TRADFI_INDEX?.gross, 0)}</td></tr></tfoot>`;
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
    ['Last / Mark', `${fPrice(m.price, f)} / ${fPrice(mk.price, f)}`],
    ['24h Change', `<span class="${cls(t.changePct)}">${t.changePct != null ? fPct(t.changePct) : '—'}</span>`],
    ['24h High / Low', `${fPrice(t.high, f)} / ${fPrice(t.low, f)}`],
    ['24h Volume', t.quoteVol != null ? `${fNum(t.quoteVol / 1e6, 1)}M USDT` : '—'],
    ['Funding / Next', `<span class="${cls(-(mk.fundingRate || 0))}">${mk.fundingRate != null ? (mk.fundingRate * 100).toFixed(4) + '%' : '—'}</span> / ${nf}`],
    ['Exposure L / S', `<span class="up">${fNum(e.long, 0)}</span> / <span class="down">${fNum(e.short, 0)}</span>`],
    ['Net Exposure', `<span class="${cls(e.net)}">${fSigned(e.net, 0)}</span> · PnL <span class="${cls(e.pnl)}">${fSigned(e.pnl)}</span>`],
    ['Min Notional / Step', f ? `${f.minNotional} / ${f.stepSize}` : '—'],
    ...(m.underlyingMarket ? [
      ['Asset Class', `TRADFI INDEX <span class="muted">${esc(m.underlying)}</span>`],
      ['Underlying Market', `<span class="${m.underlyingMarket.underlying === 'OPEN' ? 'up' : 'muted'}">${m.underlyingMarket.underlying}</span> <span class="muted">${m.underlyingMarket.underlying === 'OPEN' ? 'closes ' + fTime(m.underlyingMarket.closesAt) : m.underlyingMarket.nextOpen ? 'opens ' + fDateTime(m.underlyingMarket.nextOpen) : ''}</span>`],
      [`Binance ${sym}`, m.unavailable ? `<span class="down">UNAVAILABLE</span>` : `<span class="up">${esc(f?.status || '—')}</span> <span class="muted">24/7</span>`],
      ['Signal Data', `US session 1D · ${m.signalCandles} sess.`],
      ['Native History', `<span class="warn">${esc(m.nativeHistory)}</span> <span class="muted">(Binance, since 2026-04-06)</span>`],
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
  if (isLongOnly(st) && sl.status === 'FLAT') label = 'CASH';
  const tagCls = sl.status === 'FLAT' ? 'WAIT' : sl.status;
  const v = sl.view || {};
  const rows = [];
  const add = (k, val, c = '') => rows.push(`<div><span>${k}</span><span class="${c}">${val}</span></div>`);
  if (p) {
    add('Entry', fPrice(p.entryPrice, f));
    add('Current', fPrice(p.markPrice, f));
    add('PnL', `${fPct(p.pricePct)}`, cls(p.pricePct));
    add('Net', fSigned(p.pnl), cls(p.pnl));
    add('Order', `${fNum(p.orderAmount, 0)} USDT`);
    add('Stop', p.stopPrice ? fPrice(p.stopPrice, f) : 'OFF', 'down');
  } else {
    add('Long Order', `${fNum(amt.long, 0)} USDT`);
    add('Short Order', isLongOnly(st) ? 'CASH' : cfg.shortEnabled ? `${fNum(amt.short, 0)} USDT` : 'OFF');
  }
  if (st === 'TURTLE') {
    add('20D High', fPrice(v.entryHigh, f)); add('20D Low', fPrice(v.entryLow, f));
    add('10D Low', fPrice(v.exitLow, f)); add('10D High', fPrice(v.exitHigh, f));
    add('SMA200', fPrice(v.sma, f), v.sma && s.symbols[sym].price < v.sma ? 'down' : 'up');
  } else if (st === 'ADX') {
    add('ADX', fNum(v.adx, 1), v.adx > cfg.params.threshold ? 'warn' : '');
    add('+DI / -DI', `<span class="up">${fNum(v.plusDI, 1)}</span>/<span class="down">${fNum(v.minusDI, 1)}</span>`);
    add('SMA200', fPrice(v.sma, f), v.sma && s.symbols[sym].price < v.sma ? 'down' : 'up');
  } else if (st === 'TSMOM') {
    add('30D Mom.', v.momentumPct != null ? fPct(v.momentumPct) : '—', cls(v.momentumPct));
  } else if (st === 'QQQ_EMA_TREND') {
    add(`EMA${cfg.params.fastEma}`, fPrice(v.fastEma, f), v.fastEma > v.slowEma ? 'up' : 'down');
    add(`EMA${cfg.params.slowEma}`, fPrice(v.slowEma, f));
  } else if (st === 'QQQ_TSMOM') {
    add(`${cfg.params.lookback}D Mom.`, v.momentumPct != null ? fPct(v.momentumPct) : '—', cls(v.momentumPct));
  } else if (st === 'QQQ_SMA200') {
    add(`SMA${cfg.params.smaPeriod}`, fPrice(v.sma, f));
    add('Regime', v.sma == null ? '—' : v.above ? 'ABOVE' : 'BELOW', v.above ? 'up' : 'down');
  } else if (st === 'QQQ_TURTLE_50_20') {
    add(`${cfg.params.entryPeriod}D High`, fPrice(v.entryHigh, f)); add(`${cfg.params.exitPeriod}D Low`, fPrice(v.exitLow, f));
  }
  if (!p && sl.pending == null) add('Exit Rule', sl.exitRule);
  const notes = [];
  if (p) notes.push(`Exit: ${sl.exitRule}${p.stopPct ? ` · Stop ${p.stopPct.toFixed(1)}%` : ''}${p.exStop ? ` · Binance stop <span class="${p.exStop.status === 'NEW' ? 'up' : 'warn'}">${p.exStop.status}</span>` : ''}`);
  if (sl.pending) notes.push(`<span class="warn">Pending ${sl.pending.action} ${sl.pending.side} ${sl.pending.clientOrderId}</span>`);
  if (sl.block?.LONG || sl.block?.SHORT) notes.push('<span class="warn">Re-arm: waiting condition reset after stop</span>');
  if (v.notReady) notes.push(`<span class="warn">${esc(v.notReady)}</span>`);
  if (sl.evalCandle) notes.push(`Last eval: ${fDateTime(sl.evalCandle).slice(0, 10)} ${S.meta.strategyClass[st] === 'CRYPTO' ? 'D' : 'US session'} · ${esc(sl.lastSignal || '')}`);
  if (!cfg.enabled) notes.push('<span class="muted">disabled (optional / research)</span>');
  return `<div class="strat-card"><div class="sc-h"><b>${SHORT[st]}</b><span class="tag ${tagCls}">${p ? p.side : label}</span></div>
    <div class="sc-grid">${rows.join('')}</div><div class="sc-note">${notes.join('<br>')}</div></div>`;
}

function renderOrderBook(m, f) {
  const d = m.depth;
  if (!d) { $('#orderBook').innerHTML = '<div class="empty">no depth</div>'; return; }
  const n = 9;
  const asks = d.asks.slice(0, n).reverse();
  const bids = d.bids.slice(0, n);
  const max = Math.max(...asks.map((x) => x[1]), ...bids.map((x) => x[1]), 1e-9);
  const row = (x, side) => `<div class="ob-row ${side}"><div class="bar" style="width:${(x[1] / max) * 100}%"></div><span class="${side === 'ask' ? 'down' : 'up'}">${fPrice(x[0], f)}</span><span>${fNum(x[1], 3)}</span><span>${fNum(x[0] * x[1], 0)}</span></div>`;
  const spread = d.asks[0] && d.bids[0] ? d.asks[0][0] - d.bids[0][0] : null;
  $('#orderBook').innerHTML = `<div class="ob-row" style="color:var(--mute)"><span>Price</span><span>Qty</span><span>USDT</span></div>
    ${asks.map((x) => row(x, 'ask')).join('')}
    <div class="ob-mid"><span>${fPrice(m.price, f)}</span><span class="muted" style="font-size:11px">spread ${spread != null ? fPrice(spread, f) : '—'}</span></div>
    ${bids.map((x) => row(x, 'bid')).join('')}`;
}

function renderSummary(s) {
  $('#sumMode').textContent = `${s.mode} base → actual`;
  $('#sumCtl').innerHTML = controllerHeaderHtml(s.controller);
  const ctl = (st, side) => s.controller?.rows?.find((r) => r.strategy === st && r.side === side);
  const ctlCell = (st, side) => {
    const r = ctl(st, side);
    if (!r || !r.active) return '<span class="muted">—</span>';
    const applied = r.applied === 'NOT_APPLIED' || r.applied === 'OFF' ? null : r.applied;
    return `${statusTag(r.recommended, r.recommendedMult)}${applied ? '' : ' <span class="muted">obs</span>'}`;
  };
  const amt = (base, actual) => (Math.abs(actual - base) < 1e-9 ? fNum(base, 0) : `${fNum(base, 0)}→<b class="warn">${fNum(actual, 0)}</b>`);
  let lastC = null;
  const rows = s.strategies.map((x) => { const g = x.assetClass !== lastC ? `<tr class="grp"><td colspan="10">${S.meta.classLabel[x.assetClass]}</td></tr>` : ''; lastC = x.assetClass; return g + `<tr><td><b>${SHORT[x.strategy] || x.strategy}</b></td>
    <td class="${x.enabled ? 'up' : 'down'}">${x.enabled ? 'ON' : 'OFF'}</td>
    <td>${amt(x.longAmount, x.longActual)}</td><td>${isLongOnly(x.strategy) ? 'CASH' : x.shortEnabled ? amt(x.shortAmount, x.shortActual) : 'OFF'}</td>
    <td class="l">L ${ctlCell(x.strategy, 'LONG')}${isLongOnly(x.strategy) ? '' : ` S ${ctlCell(x.strategy, 'SHORT')}`}</td>
    <td><span class="up">${x.longs}L</span> / <span class="down">${x.shorts}S</span></td>
    <td class="${cls(x.unrealized)}">${fSigned(x.unrealized)}</td><td class="${cls(x.realized)}">${fSigned(x.realized)}</td>
    <td>${x.trades}</td><td>${x.winRate != null ? x.winRate.toFixed(0) + '%' : '—'}</td></tr>`; }).join('');
  const tu = s.strategies.reduce((a, x) => a + x.unrealized, 0), tr = s.strategies.reduce((a, x) => a + x.realized, 0);
  $('#stratSumTable').innerHTML = `<thead><tr><th>Strategy</th><th>State</th><th>Long Amt</th><th>Short Amt</th><th class="l">Controller</th><th>Open</th><th>Unrealized</th><th>Realized</th><th>Trades</th><th>Win</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><td>TOTAL</td><td></td><td></td><td></td><td></td><td>${s.positions.length}</td><td class="${cls(tu)}">${fSigned(tu)}</td><td class="${cls(tr)}">${fSigned(tr)}</td><td>${s.trades.length}</td><td></td></tr></tfoot>`;
  const a = s.account;
  $('#acctTable').innerHTML = [
    ['Wallet Balance', a.wallet != null ? fUsd(a.wallet) : '—'],
    ['Unrealized (net)', `<span class="${cls(a.unrealizedNet)}">${fSigned(a.unrealizedNet)}</span>`],
    ['Realized (net)', `<span class="${cls(a.realized)}">${fSigned(a.realized)}</span>`],
    ['Crypto PnL', `<span class="${cls(a.byClass?.CRYPTO?.pnl)}">${fSigned(a.byClass?.CRYPTO?.pnl)}</span>`],
    ['TradFi PnL', `<span class="${cls(a.byClass?.TRADFI_INDEX?.pnl)}">${fSigned(a.byClass?.TRADFI_INDEX?.pnl)}</span>`],
    ['Total PnL', `<span class="${cls(a.totalPnl)}">${fSigned(a.totalPnl)}</span>`],
    ['Gross / Crypto / TradFi Exp', `${fNum(a.grossExp, 0)} / ${fNum(a.byClass?.CRYPTO?.gross, 0)} / ${fNum(a.byClass?.TRADFI_INDEX?.gross, 0)}`],
    ['Base Capital', a.baseCapital ? fUsd(a.baseCapital) : '—'],
    ['Leverage C / T', `${S.config.general.leverage}x / ${S.config.general.leverageTradfi ?? 1}x${s.mode === 'LIVE' && s.conn.hedgeMode != null ? ` · ${s.conn.hedgeMode ? 'Hedge' : '<span class="down">One-way</span>'}` : ''}`],
    ['Fee / Slippage', `${S.config.general.takerFeePct}% / ${S.config.general.slippagePct}%`],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}

// ---------------- bottom tabs
function renderBottom() {
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
  $('#tabHint').textContent = S.tab === 'strategies' ? `Editing applies only on Save · current mode ${s.mode}` : S.tab === 'controller' ? 'Controller sizes NEW entries only · signals / stops / leverage untouched' : '';
  if (S.tab === 'positions') renderPositions(s);
  else if (S.tab === 'orders') renderOrders(s, openOrders);
  else if (S.tab === 'trades') renderTrades(s);
}

function renderPositions(s) {
  if (!s.positions.length) { $('#tab-positions').innerHTML = `<div class="empty">No open positions (${s.mode})</div>`; return; }
  const f = (sym) => s.symbols[sym].filters;
  const rows = s.positions.map((p) => `<tr data-sym="${p.symbol}">
    <td class="l"><b>${p.strategy}</b></td><td class="l">${p.symbol}</td><td class="l side-${p.side}">${p.side}</td>
    <td>${fPrice(p.entryPrice, f(p.symbol))}</td><td>${fPrice(p.markPrice, f(p.symbol))}</td>
    <td>${fNum(p.orderAmount, 2)}${p.ctrlMultiplier != null && p.ctrlMultiplier !== 1 ? ` <span class="warn" title="base ${fNum(p.baseAmount, 2)} × controller ${p.ctrlMultiplier}">×${p.ctrlMultiplier}</span>` : ''}</td><td>${p.qty}</td><td>${fNum(p.currentValue, 2)}</td>
    <td class="${cls(p.pnl)}">${fSigned(p.pnl)}</td><td class="${cls(p.pnlPct)}">${fPct(p.pnlPct)}</td>
    <td class="down">${p.stopPrice ? fPrice(p.stopPrice, f(p.symbol)) : 'OFF'} ${exBadge(p)}</td><td class="muted">${p.stopDistPct != null ? p.stopDistPct.toFixed(2) + '%' : ''}</td>
    <td>${fNum(p.funding ? -p.funding : 0, 4)}</td><td>${fDur(p.holdingMs)}</td>
    <td><button class="btn small danger" data-close="${p.strategy}:${p.symbol}" ${p.status === 'PENDING' || p.status === 'UNKNOWN' ? 'disabled' : ''}>Close</button></td></tr>`).join('');
  const tv = s.positions.reduce((a, p) => a + p.currentValue, 0), tp = s.positions.reduce((a, p) => a + p.pnl, 0), ta = s.positions.reduce((a, p) => a + p.orderAmount, 0);
  $('#tab-positions').innerHTML = `<table class="t"><thead><tr><th>Strategy</th><th>Symbol</th><th>Side</th><th>Entry Price</th><th>Mark Price</th><th>Order Amt</th><th>Quantity</th><th>Current Value</th><th>PnL (net)</th><th>PnL %</th><th>Stop Price</th><th>To Stop</th><th>Funding</th><th>Holding</th><th></th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><td>TOTAL</td><td></td><td></td><td></td><td></td><td>${fNum(ta, 2)}</td><td></td><td>${fNum(tv, 2)}</td><td class="${cls(tp)}">${fSigned(tp)}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr></tfoot></table>`;
}

function exBadge(p) {
  if (!p.exStop) return p.stopPrice && S.snap?.mode === 'LIVE' ? '<span class="tag OFF" title="Binance stop not placed">BOT</span>' : '';
  const st = p.exStop.status;
  const c = st === 'NEW' ? 'LONG' : st === 'FAILED' ? 'SHORT' : 'PENDING';
  return `<span class="tag ${c}" title="Binance STOP_MARKET ${esc(st)} ${esc(p.exStop.error || '')}">EX${st === 'NEW' ? '' : ' ' + esc(st)}</span>`;
}

function buildOpenOrders(s) {
  const out = [];
  for (const o of s.orders) if (['SUBMITTED', 'UNKNOWN'].includes(o.status)) out.push(o);
  for (const p of s.positions) {
    if (p.exStop) out.push({ time: p.exStop.placedAt, strategy: p.strategy, symbol: p.symbol, side: p.side === 'LONG' ? 'SELL' : 'BUY', positionSide: p.side, type: 'STOP_MARKET (Binance)', price: p.exStop.triggerPrice, amount: p.currentValue, qty: p.exStop.qty, status: p.exStop.status === 'NEW' ? 'ACTIVE' : p.exStop.status, reason: p.exStop.clientAlgoId, error: p.exStop.error });
    if (p.stopPrice) out.push({ time: p.entryTime, strategy: p.strategy, symbol: p.symbol, side: p.side === 'LONG' ? 'SELL' : 'BUY', positionSide: p.side, type: `${p.stopMode === 'FIXED_PERCENT' ? 'FIXED' : 'ATR'} STOP (bot)`, price: p.stopPrice, amount: p.currentValue, qty: p.qty, status: 'ACTIVE', reason: p.exStop?.status === 'NEW' ? 'backup (15s after breach)' : '' });
    if (p.tpPrice) out.push({ time: p.entryTime, strategy: p.strategy, symbol: p.symbol, side: p.side === 'LONG' ? 'SELL' : 'BUY', positionSide: p.side, type: 'TAKE PROFIT (bot)', price: p.tpPrice, amount: p.currentValue, qty: p.qty, status: 'ACTIVE' });
  }
  return out;
}

function orderRow(o, s) {
  const f = s.symbols[o.symbol]?.filters;
  const st = o.status;
  const c = st === 'FILLED' ? 'up' : ['REJECTED', 'NOT_PLACED', 'FAILED'].includes(st) ? 'down' : ['UNKNOWN', 'PLACING', 'TRIGGERED', 'REPLACE'].includes(st) ? 'warn' : '';
  return `<tr data-sym="${o.symbol}"><td class="l">${fDateTime(o.time)}</td><td class="l"><b>${o.strategy}</b></td><td class="l">${o.symbol}</td>
    <td class="l"><span class="${o.side === 'BUY' ? 'up' : 'down'}">${o.side}</span> <span class="muted">${o.positionSide}${o.action ? ' ' + o.action : ''}</span></td>
    <td class="l">${o.type}</td><td>${o.price != null ? fPrice(o.price, f) : o.refPrice ? `~${fPrice(o.refPrice, f)}` : 'MKT'}</td>
    <td>${fNum(o.amount, 2)}</td><td>${o.qty ?? ''}</td><td class="${c}">${st}</td><td class="l muted" title="${esc(o.error || '')}">${esc(o.reason || o.error || '')}</td></tr>`;
}

function renderOrders(s, open) {
  const head = '<thead><tr><th>Time</th><th>Strategy</th><th>Symbol</th><th>Side</th><th>Type</th><th>Price</th><th>Amount</th><th>Qty</th><th>Status</th><th>Note</th></tr></thead>';
  $('#tab-orders').innerHTML = `<div class="sub-h">OPEN ORDERS · pending market orders · Binance STOP_MARKET · bot-side stops</div>
    ${open.length ? `<table class="t">${head}<tbody>${open.map((o) => orderRow(o, s)).join('')}</tbody></table>` : '<div class="empty">No open orders</div>'}
    <div class="sub-h">ORDER HISTORY (${s.mode})</div>
    ${s.orders.length ? `<table class="t">${head}<tbody>${s.orders.map((o) => orderRow(o, s)).join('')}</tbody></table>` : '<div class="empty">No orders yet</div>'}`;
}

function renderTrades(s) {
  if (!s.trades.length) { $('#tab-trades').innerHTML = `<div class="empty">No closed trades (${s.mode})</div>`; return; }
  const f = (sym) => s.symbols[sym].filters;
  const rows = s.trades.map((t) => `<tr data-sym="${t.symbol}"><td class="l">${fDateTime(t.entryTime)}</td><td class="l">${fDateTime(t.exitTime)}</td><td class="l"><b>${t.strategy}</b></td><td class="l">${t.symbol}</td><td class="l side-${t.side}">${t.side}</td>
    <td>${fPrice(t.entryPrice, f(t.symbol))}</td><td>${fPrice(t.exitPrice, f(t.symbol))}</td><td>${fNum(t.orderAmount, 2)}</td>
    <td class="${cls(t.grossPnl)}">${fSigned(t.grossPnl)}</td><td class="down">${fNum(-t.fee, 4)}</td><td class="${cls(t.funding)}">${fNum(t.funding, 4)}</td>
    <td class="${cls(t.netPnl)}"><b>${fSigned(t.netPnl)}</b></td><td class="${cls(t.returnPct)}">${fPct(t.returnPct)}</td><td class="l">${exitTag(t.exitReason)}</td></tr>`).join('');
  const sum = (k) => s.trades.reduce((a, t) => a + t[k], 0);
  $('#tab-trades').innerHTML = `<table class="t"><thead><tr><th>Entry Time</th><th>Exit Time</th><th>Strategy</th><th>Symbol</th><th>Side</th><th>Entry Price</th><th>Exit Price</th><th>Order Amt</th><th>Gross PnL</th><th>Fee</th><th>Funding</th><th>Net PnL</th><th>Return %</th><th>Exit Reason</th></tr></thead>
    <tbody>${rows}</tbody><tfoot><tr><td>TOTAL ${s.trades.length}</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td class="${cls(sum('grossPnl'))}">${fSigned(sum('grossPnl'))}</td><td class="down">${fNum(-sum('fee'), 4)}</td><td>${fNum(sum('funding'), 4)}</td><td class="${cls(sum('netPnl'))}">${fSigned(sum('netPnl'))}</td><td></td><td></td></tr></tfoot></table>`;
}

function exitTag(r) {
  const c = { STRATEGY_EXIT: 'muted', ATR_STOP: 'down', FIXED_STOP: 'down', TAKE_PROFIT: 'up', MANUAL_EXIT: 'warn', EMERGENCY_CLOSE: 'down' }[r] || '';
  return `<span class="${c}">${r}</span>`;
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

init().catch((e) => toast(`Init failed: ${e.message}`, 'err'));
