// HTTP + WebSocket server for the trading terminal UI. Binds to localhost only by default.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Store, SYMBOLS } from './store.js';
import { Logger } from './logger.js';
import { MarketData, CHART_INTERVALS, CHART_CHOICES, SESSION_INTERVAL } from './marketData.js';
import { Engine } from './engine.js';
import { ALL_STRATEGIES as STRATEGIES, META as STRATEGY_META, STRATEGY_CLASS, strategiesForSymbol, CRYPTO_STRATEGIES, TRADFI_STRATEGIES } from './strategyRegistry.js';
import { SYMBOL_META, ASSET_CLASSES, CLASS_LABEL, isSessionSymbol } from './assets.js';
import { Controller, CONTROLLER_MODES } from './controller/controllerEngine.js';
import { StrategyScheduler } from './scheduler/strategyScheduler.js';
import { SignalLog } from './scheduler/signalLog.js';
import { CRYPTO_TIMEFRAME_CHOICES, TF_LABEL, barIntervalsFor, timeframeOf } from './scheduler/timeframes.js';
import { RiskMonitor } from './risk/riskMonitor.js';
import { PortfolioService } from './portfolio/portfolioService.js';
import { BacktestRunner } from './backtest/backtestRunner.js';
import { validateStrategySettings, num } from './strategyConfig.js';
import { AiService } from './ai/aiService.js';
import { UniverseManager, universeConfig } from './universe.js';
import { AssetSeller } from './portfolio/assetSeller.js';
import { BinanceClient, endpoints } from './binance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8420);

const store = new Store();
const log = new Logger(store);
// Crypto universe first: the watch set (Top N by 24h quote volume + symbols with positions / orders / stops) is
// registered into SYMBOLS before market data, engine, scheduler and controller are built.
const universe = new UniverseManager({ store, rest: new BinanceClient({ restBase: endpoints(false).rest }), log });
await universe.init();
const md = new MarketData(SYMBOLS, log, { getCalendar: () => store.config.general.usCalendar, barIntervals: barIntervalsFor(store.config) });
const engine = new Engine(store, md, log);
engine.universe = universe;
// Controller layer: strategies -> controller (size multiplier) -> existing execution engine
const controller = new Controller({ store, md, engine, log });
engine.controller = controller;
// WHEN to evaluate (candle closes) is separated from real-time protection (every price tick).
const signalLog = new SignalLog();
const scheduler = new StrategyScheduler({ store, md, engine, log, signalLog });
const portfolio = new PortfolioService({ store, engine, md, log });
const risk = new RiskMonitor({ engine, md, log, portfolio });
const backtest = new BacktestRunner({ store, md, log, rest: md.rest, universe }); // public market data only, never places orders
// Asset sale (portfolio screen, user-initiated, typed confirmation): spot market sell for USDT, never withdraws
const seller = new AssetSeller({ getClient: () => engine.liveClient, log, onDone: () => { portfolio.refreshExchange('asset sale').catch(() => {}); portfolio.wallets = null; portfolio.refreshWallets().catch(() => {}); } });
const ai = new AiService({ store, backtest, controller, engine, log }); // Claude API: analysis / improvement proposals / strategy generation (never trades)
const fullSnapshot = () => {
  const s = engine.snapshot();
  try { s.controller = controller.compact(); } catch (e) { s.controller = { mode: 'ERROR', error: e.message }; }
  try { s.scheduler = scheduler.snapshot(); } catch (e) { s.scheduler = []; log.warn(`scheduler snapshot: ${e.message}`); }
  try { s.risk = risk.status(); } catch { s.risk = null; }
  try { s.universe = universe.snapshot(); } catch { s.universe = null; }
  try { s.wallets = portfolio.walletSummary(); } catch { s.wallets = null; }
  try { const r = portfolio.recon; s.reconciliation = { ok: r.ok, warnings: r.warnings, na: r.na || null }; } catch { s.reconciliation = null; }
  return s;
};
const portfolioPayload = () => { try { return portfolio.build(); } catch (e) { log.warn(`portfolio build failed: ${e.message}`, 'PORTFOLIO'); return { error: e.message }; } };

const app = express();
app.use(express.json({ limit: '100kb' }));

// CSRF guard: mutating requests must carry a custom header (not sendable cross-origin without CORS).
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-HIC') !== '1') return res.status(403).json({ ok: false, msg: 'forbidden' });
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/vendor/lightweight-charts.js', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js')));

const ok = (res, r = { ok: true }) => res.status(r.ok === false ? 400 : 200).json(r);
const confirmed = (req, word) => String(req.body?.confirm || '').trim().toUpperCase() === word;

app.get('/api/snapshot', (req, res) => res.json(fullSnapshot()));
app.get('/api/config', (req, res) => res.json({ config: store.config, meta: {
  symbols: SYMBOLS, strategies: STRATEGIES, intervals: CHART_INTERVALS, chartIntervals: CHART_CHOICES, sessionInterval: SESSION_INTERVAL,
  supportsShort: Object.fromEntries(STRATEGIES.map((s) => [s, STRATEGY_META[s].supportsShort])),
  labels: Object.fromEntries(STRATEGIES.map((s) => [s, STRATEGY_META[s].label])),
  strategyClass: STRATEGY_CLASS, cryptoStrategies: CRYPTO_STRATEGIES, tradfiStrategies: TRADFI_STRATEGIES,
  strategiesBySymbol: Object.fromEntries(SYMBOLS.map((s) => [s, strategiesForSymbol(s)])),
  symbolMeta: SYMBOL_META, assetClasses: ASSET_CLASSES, classLabel: CLASS_LABEL,
  timeframeChoices: CRYPTO_TIMEFRAME_CHOICES, timeframeLabel: TF_LABEL,
  universe: universe.snapshot(),
} }));
const sellArgs = (b) => ({ wallet: String(b.wallet || ''), asset: String(b.asset || ''), amount: b.amount === 'ALL' || b.amount == null || b.amount === '' ? 'ALL' : num(b.amount, { min: 0 }), toFutures: b.toFutures !== false, futuresAssets: portfolio.exchange?.assets || [] });
app.post('/api/wallet/preview', async (req, res) => {
  if (!engine.liveClient?.hasKeys()) return ok(res, { ok: false, msg: 'API 키 없음' });
  try { const p = await seller.plan(sellArgs(req.body || {})); ok(res, { ok: true, plan: { ...p, filters: undefined } }); } catch (e) { ok(res, { ok: false, msg: e.message }); }
});
app.post('/api/wallet/sell', async (req, res) => {
  if (!engine.liveClient?.hasKeys()) return ok(res, { ok: false, msg: 'API 키 없음' });
  if (!confirmed(req, 'SELL')) return ok(res, { ok: false, msg: 'Type SELL to confirm', needConfirm: true });
  try { ok(res, await seller.sell(sellArgs(req.body || {}))); } catch (e) { ok(res, { ok: false, msg: e.message }); }
});
app.post('/api/wallet/usdt-to-futures', async (req, res) => {
  if (!engine.liveClient?.hasKeys()) return ok(res, { ok: false, msg: 'API 키 없음' });
  if (!confirmed(req, 'MOVE')) return ok(res, { ok: false, msg: 'Type MOVE to confirm', needConfirm: true });
  ok(res, await seller.moveUsdtToFutures(req.body?.amount ?? 'ALL'));
});
app.get('/api/universe', (req, res) => res.json(universe.snapshot()));
app.post('/api/universe/refresh', async (req, res) => ok(res, await universe.refresh()));
// Universe settings: trade permissions follow on the next re-rank, the watch list (market data streams) on restart.
app.post('/api/config/universe', (req, res) => {
  try {
    const b = req.body.settings || {};
    const cur = universeConfig(store.config);
    const sym = (x) => String(x).trim().toUpperCase();
    const next = {
      ...cur,
      mode: ['TOP_QUOTE_VOLUME', 'STATIC'].includes(b.mode) ? b.mode : cur.mode,
      watchTopN: num(b.watchTopN ?? cur.watchTopN, { min: 1, max: 50, int: true }),
      tradeTopN: num(b.tradeTopN ?? cur.tradeTopN, { min: 1, max: 50, int: true }),
      minListingDays: num(b.minListingDays ?? cur.minListingDays, { min: 0, max: 3650, int: true }),
      alwaysInclude: Array.isArray(b.alwaysInclude) ? [...new Set(b.alwaysInclude.map(sym).filter((x) => /^[A-Z0-9]{2,20}USDT$/.test(x)))].slice(0, 10) : cur.alwaysInclude,
      excludeStablecoinBases: b.excludeStablecoinBases == null ? cur.excludeStablecoinBases : !!b.excludeStablecoinBases,
      backtestDynamic: b.backtestDynamic == null ? cur.backtestDynamic : !!b.backtestDynamic,
      backtestRankLookbackDays: num(b.backtestRankLookbackDays ?? cur.backtestRankLookbackDays, { min: 1, max: 365, int: true }),
      backtestRebalanceDays: num(b.backtestRebalanceDays ?? cur.backtestRebalanceDays, { min: 1, max: 90, int: true }),
    };
    if (next.tradeTopN > next.watchTopN) throw new Error('tradeTopN must be <= watchTopN');
    store.config.cryptoUniverse = next;
    store.saveConfig();
    log.info('Universe settings saved — watch list applies after restart', 'CONFIG_SAVED', { watchTopN: next.watchTopN, tradeTopN: next.tradeTopN });
    ok(res, { ok: true, restartRequired: true });
  } catch (e) { ok(res, { ok: false, msg: e.message }); }
});
app.get('/api/portfolio', (req, res) => res.json(portfolioPayload()));
app.get('/api/portfolio/equity', (req, res) => {
  const range = ['1D', '7D', '1M', '3M', 'ALL'].includes(req.query.range) ? req.query.range : '1M';
  res.json(portfolio.equitySeries(range));
});
app.post('/api/portfolio/refresh', async (req, res) => { await portfolio.refreshExchange('manual'); ok(res, { ok: true }); });
app.get('/api/signals', (req, res) => res.json(signalLog.recent({ limit: Math.min(2000, Number(req.query.limit) || 500), strategy: req.query.strategy || undefined, symbol: req.query.symbol || undefined })));
app.get('/api/scheduler', (req, res) => res.json(scheduler.snapshot()));
// ---- backtest (historical replay of the current strategy settings; no orders)
app.post('/api/backtest/run', (req, res) => {
  try {
    const b = req.body || {};
    const days = num(b.days ?? 365, { min: 7, max: 1000, int: true });
    const capital = num(b.capital ?? 1_000_000, { min: 1000, max: 1e12 });
    if (backtest.status.state === 'RUNNING') return ok(res, { ok: false, msg: 'backtest already running' });
    backtest.run({ days, capital, compound: b.compound !== false });
    ok(res, { ok: true });
  } catch (e) { ok(res, { ok: false, msg: e.message }); }
});
app.get('/api/backtest/status', (req, res) => res.json(backtest.status));
app.get('/api/backtest/result', (req, res) => res.json(backtest.last || null));
// ---- AI (Claude API)
app.get('/api/ai/status', (req, res) => res.json(ai.status()));
app.post('/api/ai/key', (req, res) => {
  const k = String(req.body?.apiKey || '').trim();
  if (!/^sk-ant-/.test(k)) return ok(res, { ok: false, msg: 'Claude API 키 형식이 아닙니다 (sk-ant-로 시작)' });
  store.saveSecrets({ anthropicApiKey: k });
  log.info('Claude API key saved', 'API_KEY');
  ok(res);
});
app.delete('/api/ai/key', (req, res) => { store.saveSecrets({ anthropicApiKey: '' }); log.warn('Claude API key deleted', 'API_KEY'); ok(res); });
app.post('/api/ai/analyze', (req, res) => ok(res, ai.analyze()));
app.post('/api/ai/improve', (req, res) => ok(res, ai.improve({ strategy: String(req.body?.strategy || ''), rounds: req.body?.rounds })));
app.post('/api/ai/generate', (req, res) => ok(res, ai.generate({ idea: String(req.body?.idea || '').slice(0, 2000), rounds: req.body?.rounds })));
app.post('/api/ai/apply', (req, res) => {
  if (engine.mode === 'LIVE' && engine.runState === 'RUNNING' && !confirmed(req, 'APPLY')) return ok(res, { ok: false, msg: 'LIVE running: confirmation required', needConfirm: true });
  try { ok(res, ai.applyCandidate({ strategy: String(req.body?.strategy || ''), id: String(req.body?.id || '') })); } catch (e) { ok(res, { ok: false, msg: e.message }); }
});
app.post('/api/ai/save', (req, res) => ok(res, ai.saveGenerated({ id: String(req.body?.id || '') })));
app.post('/api/ai/delete', (req, res) => ok(res, ai.deleteSaved({ id: String(req.body?.id || '') })));
app.get('/api/backtest/candles', (req, res) => res.json(backtest.candles[`${req.query.symbol}|${req.query.tf}`] || []));
app.get('/api/logs', (req, res) => res.json(log.recent(1000)));

app.get('/api/klines', async (req, res) => {
  const { symbol, interval } = req.query;
  const okIv = CHART_CHOICES.includes(interval) || (interval === SESSION_INTERVAL && isSessionSymbol(symbol));
  if (!SYMBOLS.includes(symbol) || !okIv) return res.status(400).json({ ok: false, msg: 'bad params' });
  try { res.json(await md.chartKlines(symbol, interval, 1000)); } catch (e) { res.status(502).json({ ok: false, msg: e.message }); }
});

// ---- strategy / general settings (applied only on Save)

app.post('/api/config/strategy/:name', (req, res) => {
  const name = req.params.name;
  const cur = store.config.strategies[name];
  if (!cur) return ok(res, { ok: false, msg: 'unknown strategy' });
  if (engine.mode === 'LIVE' && engine.runState === 'RUNNING' && !confirmed(req, 'APPLY')) return ok(res, { ok: false, msg: 'LIVE running: confirmation required', needConfirm: true });
  try {
    const next = validateStrategySettings(name, req.body.settings, cur);
    if (next.leverage !== (cur.leverage ?? 1) && engine.runState === 'RUNNING') throw new Error('Stop bots before changing leverage');
    const prevCfg = structuredClone(cur);
    store.config.strategies[name] = next;
    controller.onStrategyConfigChanged(name, prevCfg, next);
    store.saveConfig();
    log.info(`${name} settings saved (${engine.mode}${engine.runState === 'RUNNING' ? ', applies from next evaluation; open positions keep their stops' : ''})`, 'CONFIG_SAVED', { leverage: next.leverage, amounts: next.amounts, params: next.params, stop: next.stop });
    engine.evaluateAll('config saved');
    // new candle interval: load its history (all watched symbols), then evaluate again
    if (md.status === 'CONNECTED') md.ensureInterval(timeframeOf(name, store.config)).then((loaded) => { if (loaded) engine.evaluateAll('interval loaded'); }).catch((e) => log.error(`interval load failed: ${e.message}`, 'API_ERROR'));
    ok(res);
  } catch (e) {
    ok(res, { ok: false, msg: e.message });
  }
});

app.post('/api/config/general', (req, res) => {
  try {
    const b = req.body.settings;
    const g = store.config.general;
    const next = {
      ...g,
      takerFeePct: num(b.takerFeePct, { min: 0, max: 1 }),
      makerFeePct: num(b.makerFeePct, { min: 0, max: 1 }),
      slippagePct: num(b.slippagePct, { min: 0, max: 5 }),
      includeFunding: !!b.includeFunding,
      paperInitialBalance: num(b.paperInitialBalance, { min: 1, max: 1e9 }),
      stopsActiveWhenStopped: !!b.stopsActiveWhenStopped,
      dataStaleSec: num(b.dataStaleSec, { min: 5, max: 600, int: true }),
      balanceBufferPct: num(b.balanceBufferPct, { min: 0, max: 50 }),
      exchangeStops: !!b.exchangeStops,
      stopWorkingType: ['CONTRACT_PRICE', 'MARK_PRICE'].includes(b.stopWorkingType) ? b.stopWorkingType : g.stopWorkingType,
    };
    store.config.general = next;
    store.saveConfig();
    log.info('General settings saved', 'CONFIG_SAVED', { fee: next.takerFeePct, slip: next.slippagePct });
    ok(res);
  } catch (e) {
    ok(res, { ok: false, msg: e.message });
  }
});

// ---- run control
app.post('/api/bot/start', async (req, res) => {
  if (engine.mode === 'LIVE' && !confirmed(req, 'LIVE')) return ok(res, { ok: false, msg: 'LIVE start requires confirmation', needConfirm: true });
  ok(res, await engine.start());
});
app.post('/api/bot/stop', (req, res) => ok(res, engine.stopAll()));
app.post('/api/mode', (req, res) => {
  if (req.body.mode === 'LIVE' && !confirmed(req, 'LIVE')) return ok(res, { ok: false, msg: 'Type LIVE to confirm', needConfirm: true });
  ok(res, engine.setMode(req.body.mode));
});
app.post('/api/paper/reset', (req, res) => {
  if (!confirmed(req, 'RESET')) return ok(res, { ok: false, msg: 'confirmation required' });
  ok(res, engine.resetPaper());
});

app.post('/api/positions/close', async (req, res) => {
  const { strategy, symbol } = req.body;
  if (!STRATEGIES.includes(strategy) || !SYMBOLS.includes(symbol)) return ok(res, { ok: false, msg: 'bad params' });
  ok(res, await engine.closePosition(strategy, symbol, 'MANUAL_EXIT'));
});
app.post('/api/positions/close-all', async (req, res) => {
  if (!confirmed(req, 'CLOSE ALL')) return ok(res, { ok: false, msg: 'Type CLOSE ALL to confirm' });
  ok(res, await risk.emergencyCloseAll('EMERGENCY_CLOSE'));
});

// ---- Self-Improving Controller
app.get('/api/controller', (req, res) => {
  try { res.json(controller.detail()); } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});
app.post('/api/controller/mode', (req, res) => {
  const mode = req.body.mode;
  if (!CONTROLLER_MODES.includes(mode)) return ok(res, { ok: false, msg: 'invalid mode' });
  if (mode === 'LIVE_APPROVAL' && !confirmed(req, 'LIVE')) return ok(res, { ok: false, msg: 'Type LIVE to confirm', needConfirm: true });
  ok(res, controller.setMode(mode));
});
app.post('/api/controller/disable', (req, res) => ok(res, controller.disable()));
app.post('/api/controller/evaluate', (req, res) => ok(res, controller.evaluate('manual')));
app.post('/api/controller/approve', (req, res) => {
  if (!confirmed(req, 'APPROVE')) return ok(res, { ok: false, msg: 'confirmation required' });
  ok(res, controller.approve(String(req.body.id || '')));
});
app.post('/api/controller/reject', (req, res) => ok(res, controller.reject(String(req.body.id || ''))));
app.post('/api/controller/config', (req, res) => {
  try {
    const b = req.body.settings || {};
    const c = store.config.controller;
    const n = (v, o) => num(v, o);
    const next = structuredClone(c);
    if (![1, 7, 14, 30].includes(Number(b.reevalDays))) throw new Error('reevalDays must be 1, 7, 14 or 30');
    next.reevalDays = Number(b.reevalDays);
    next.minHistoryDays = n(b.minHistoryDays, { min: 30, max: 730, int: true });
    for (const k of ['fast', 'main', 'stability', 'extended']) next.windows[k] = n(b.windows[k], { min: 7, max: 730, int: true });
    if (!(next.windows.fast < next.windows.main && next.windows.main <= next.windows.stability && next.windows.stability <= next.windows.extended)) throw new Error('windows must satisfy fast < main <= stability <= extended');
    for (const k of ['return', 'drawdown', 'riskAdjusted', 'consistency']) next.weights[k] = n(b.weights[k], { min: 0, max: 1 });
    if (Object.values(next.weights).reduce((a, x) => a + x, 0) <= 0) throw new Error('weights sum must be > 0');
    for (const k of ['boost', 'normal', 'cautious']) next.thresholds[k] = n(b.thresholds[k], { min: -1, max: 1 });
    if (!(next.thresholds.boost > next.thresholds.normal && next.thresholds.normal > next.thresholds.cautious)) throw new Error('thresholds must satisfy boost > normal > cautious');
    for (const k of ['noBoostDDPct', 'reduceDDPct', 'pauseDDPct']) next.guards[k] = n(b.guards[k], { min: 1, max: 90 });
    if (!(next.guards.noBoostDDPct <= next.guards.reduceDDPct && next.guards.reduceDDPct <= next.guards.pauseDDPct)) throw new Error('drawdown guards must satisfy noBoost <= reduce <= pause');
    next.guards.noBoostConsecLosses = n(b.guards.noBoostConsecLosses, { min: 1, max: 50, int: true });
    next.guards.cautionConsecLosses = n(b.guards.cautionConsecLosses, { min: 1, max: 50, int: true });
    next.guards.correlationThreshold = n(b.guards.correlationThreshold, { min: 0.1, max: 1 });
    next.guards.correlationGuard = !!b.guards.correlationGuard;
    next.guards.maxCoinExposurePctForBoost = n(b.guards.maxCoinExposurePctForBoost, { min: 0, max: 1000 });
    for (const st of STRATEGIES) for (const side of ['LONG', 'SHORT']) {
      const v = b.maxOrderUsdt?.[st]?.[side];
      (next.maxOrderUsdt[st] ||= { LONG: null, SHORT: null })[side] = v === '' || v == null ? null : n(v, { min: 1, max: 1e7 });
    }
    next.resetHistoryOnParamChange = b.resetHistoryOnParamChange == null ? c.resetHistoryOnParamChange : !!b.resetHistoryOnParamChange;
    // multipliers / modes are NOT editable here (fixed ladder, max 1.25)
    store.config.controller = next;
    store.saveConfig();
    log.info('Controller settings saved', 'CONFIG_SAVED', { reevalDays: next.reevalDays, minHistoryDays: next.minHistoryDays, guards: next.guards });
    ok(res);
  } catch (e) {
    ok(res, { ok: false, msg: e.message });
  }
});

// ---- API keys (stored locally in data/secrets.json, chmod 600; secret is never sent back)
const mask = (k) => (k ? `${k.slice(0, 4)}${'•'.repeat(8)}${k.slice(-4)}` : '');
app.get('/api/secrets', (req, res) => {
  const s = store.secrets;
  res.json({ hasKey: !!(s.apiKey && s.apiSecret), apiKeyMasked: mask(s.apiKey), testnet: !!s.testnet, status: engine.live.status, hedgeMode: engine.live.hedgeMode, error: engine.live.error, leverage: engine.live.leverage, account: engine.live.account });
});
app.post('/api/secrets', (req, res) => {
  if (engine.runState === 'RUNNING' && engine.mode === 'LIVE') return ok(res, { ok: false, msg: 'Stop LIVE bots before changing API keys' });
  const { apiKey, apiSecret, testnet } = req.body;
  const upd = { testnet: !!testnet };
  if (apiKey) upd.apiKey = String(apiKey).trim();
  if (apiSecret) upd.apiSecret = String(apiSecret).trim();
  store.saveSecrets(upd);
  engine.rebuildLiveClient();
  log.info(`API key saved (${upd.testnet ? 'TESTNET' : 'MAINNET'})`, 'API_KEY');
  ok(res);
});
app.delete('/api/secrets', (req, res) => {
  if (engine.mode === 'LIVE') return ok(res, { ok: false, msg: 'Switch to PAPER before deleting keys' });
  store.clearSecrets();
  engine.rebuildLiveClient();
  log.warn('API key deleted', 'API_KEY');
  ok(res);
});
app.post('/api/secrets/test', async (req, res) => {
  const r = await engine.verifyLive(false);
  ok(res, { ...r, ok: true, success: r.ok, status: engine.live.status, hedgeMode: engine.live.hedgeMode, account: engine.live.account, leverage: engine.live.leverage });
});
app.post('/api/live/hedge-mode', async (req, res) => {
  try {
    await engine.liveClient.setPositionMode(true);
    log.warn('Binance position mode set to Hedge Mode', 'POSITION_MODE');
    ok(res, await engine.verifyLive(false));
  } catch (e) {
    ok(res, { ok: false, msg: e.message });
  }
});

// ---- server + ws push
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
// WebSocket origin check (browsers send Origin; a foreign web page must not open the live feed).
// Same host, or an origin listed in HIC_ALLOWED_ORIGINS (e.g. the Tailscale Serve https://<name>.ts.net address,
// whose proxy may rewrite the Host header).
const ALLOWED_ORIGINS = new Set(String(process.env.HIC_ALLOWED_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean));
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  return u.host === req.headers.host || u.host === req.headers['x-forwarded-host'] || ALLOWED_ORIGINS.has(u.origin);
}

wss.on('connection', (ws, req) => {
  if (!originAllowed(req)) { ws.close(1008, 'origin'); return; }
  ws.send(JSON.stringify({ type: 'logs', data: log.recent(500) }));
  ws.send(JSON.stringify({ type: 'snapshot', data: fullSnapshot() }));
  ws.send(JSON.stringify({ type: 'signals', data: signalLog.recent({ limit: 500 }) }));
  ws.send(JSON.stringify({ type: 'portfolio', data: portfolioPayload() }));
});
const broadcast = (msg) => {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};
setInterval(() => { if (wss.clients.size) broadcast({ type: 'snapshot', data: fullSnapshot() }); }, 1000);
log.on('log', (e) => broadcast({ type: 'log', data: e }));
signalLog.on('signal', (r) => broadcast({ type: 'signal', data: r }));
// Signal -> Order -> Fill -> Position -> Portfolio: pushed immediately on every change, else every 2 s
let pfTimer = null;
const pushPortfolio = () => { if (wss.clients.size) broadcast({ type: 'portfolio', data: portfolioPayload() }); };
portfolio.on('change', () => {
  if (pfTimer) return;
  pfTimer = setTimeout(() => { pfTimer = null; pushPortfolio(); broadcast({ type: 'snapshot', data: fullSnapshot() }); }, 150);
});
setInterval(pushPortfolio, 2000);
const klineThrottle = new Map();
md.on('kline', (k) => {
  const key = `${k.symbol}:${k.interval}`;
  const now = Date.now();
  if (!k.closed && now - (klineThrottle.get(key) || 0) < 250) return;
  klineThrottle.set(key, now);
  broadcast({ type: 'kline', data: k });
});

process.on('unhandledRejection', (e) => log.error(`unhandled: ${e?.message || e}`, 'ENGINE_ERROR'));
const shutdown = () => { store.saveStateNow(); portfolio.history.saveNow(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// listeners attached once, before market data starts (boot() may retry)
risk.start();
scheduler.start();

server.listen(PORT, HOST, async () => {
  log.info(`HIC Terminal listening on http://${HOST}:${PORT} — mode ${store.config.general.mode}, bots STOPPED (press START to run)`);
  const boot = async () => {
    try {
      await md.start();
      for (const iv of barIntervalsFor(store.config)) await md.ensureInterval(iv); // intervals changed while booting
      await scheduler.catchUp('init');
      controller.start();
      portfolio.start();
      universe.start(); // 24h re-rank (trade permissions inside the watch set)
      if (engine.mode === 'LIVE') engine.verifyLive(false);
    } catch (e) {
      log.error(`Market data init failed: ${e.message} — retrying in 15s`, 'API_ERROR');
      setTimeout(boot, 15000);
    }
  };
  boot();
});
