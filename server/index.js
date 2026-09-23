// HTTP + WebSocket server for the trading terminal UI. Binds to localhost only by default.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Store, SYMBOLS } from './store.js';
import { Logger } from './logger.js';
import { MarketData, CHART_INTERVALS } from './marketData.js';
import { Engine } from './engine.js';
import { STRATEGIES, STRATEGY_META } from './strategies.js';
import { Controller, CONTROLLER_MODES } from './controller/controllerEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8420);

const store = new Store();
const log = new Logger(store);
const md = new MarketData(SYMBOLS, log);
const engine = new Engine(store, md, log);
// Controller layer: strategies -> controller (size multiplier) -> existing execution engine
const controller = new Controller({ store, md, engine, log });
engine.controller = controller;
const fullSnapshot = () => {
  const s = engine.snapshot();
  try { s.controller = controller.compact(); } catch (e) { s.controller = { mode: 'ERROR', error: e.message }; }
  return s;
};

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
app.get('/api/config', (req, res) => res.json({ config: store.config, meta: { symbols: SYMBOLS, strategies: STRATEGIES, intervals: CHART_INTERVALS, supportsShort: Object.fromEntries(STRATEGIES.map((s) => [s, STRATEGY_META[s].supportsShort])) } }));
app.get('/api/logs', (req, res) => res.json(log.recent(1000)));

app.get('/api/klines', async (req, res) => {
  const { symbol, interval } = req.query;
  if (!SYMBOLS.includes(symbol) || !CHART_INTERVALS.includes(interval)) return res.status(400).json({ ok: false, msg: 'bad params' });
  try { res.json(await md.chartKlines(symbol, interval, 1000)); } catch (e) { res.status(502).json({ ok: false, msg: e.message }); }
});

// ---- strategy / general settings (applied only on Save)
const num = (v, { min = -Infinity, max = Infinity, int = false } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new Error(`invalid number: ${v}`);
  return n;
};

app.post('/api/config/strategy/:name', (req, res) => {
  const name = req.params.name;
  const cur = store.config.strategies[name];
  if (!cur) return ok(res, { ok: false, msg: 'unknown strategy' });
  if (engine.mode === 'LIVE' && engine.runState === 'RUNNING' && !confirmed(req, 'APPLY')) return ok(res, { ok: false, msg: 'LIVE running: confirmation required', needConfirm: true });
  try {
    const b = req.body.settings;
    const amt = (x) => num(x, { min: 0, max: 1e7 });
    const next = {
      enabled: !!b.enabled,
      shortEnabled: STRATEGY_META[name].supportsShort ? !!b.shortEnabled : false,
      amounts: {
        PAPER: { long: amt(b.amounts.PAPER.long), short: amt(b.amounts.PAPER.short ?? 0) },
        LIVE: { long: amt(b.amounts.LIVE.long), short: amt(b.amounts.LIVE.short ?? 0) },
      },
      params: {},
      stop: {
        mode: ['ATR_DYNAMIC', 'FIXED_PERCENT', 'OFF'].includes(b.stop.mode) ? b.stop.mode : (() => { throw new Error('bad stop mode'); })(),
        atrPeriod: num(b.stop.atrPeriod, { min: 2, max: 200, int: true }),
        atrMult: num(b.stop.atrMult, { min: 0.1, max: 20 }),
        minPct: num(b.stop.minPct, { min: 0.1, max: 90 }),
        maxPct: num(b.stop.maxPct, { min: 0.1, max: 90 }),
        fixedPct: num(b.stop.fixedPct, { min: 0.1, max: 90 }),
      },
      takeProfit: { enabled: !!b.takeProfit.enabled, pct: num(b.takeProfit.pct, { min: 0.1, max: 1000 }) },
    };
    if (next.stop.minPct > next.stop.maxPct) throw new Error('Min Stop % must be <= Max Stop %');
    const P = { min: 2, max: 400, int: true };
    if (name === 'TURTLE') next.params = { entryPeriod: num(b.params.entryPeriod, P), exitPeriod: num(b.params.exitPeriod, P), smaFilter: num(b.params.smaFilter, P) };
    if (name === 'ADX') next.params = { adxPeriod: num(b.params.adxPeriod, P), threshold: num(b.params.threshold, { min: 1, max: 100 }), smaFilter: num(b.params.smaFilter, P) };
    if (name === 'TSMOM') next.params = { lookback: num(b.params.lookback, P) };
    store.config.strategies[name] = next;
    store.saveConfig();
    log.info(`${name} settings saved (${engine.mode}${engine.runState === 'RUNNING' ? ', applies from next evaluation; open positions keep their stops' : ''})`, 'CONFIG_SAVED', { amounts: next.amounts, params: next.params, stop: next.stop });
    engine.evaluateAll('config saved');
    ok(res);
  } catch (e) {
    ok(res, { ok: false, msg: e.message });
  }
});

app.post('/api/config/general', (req, res) => {
  try {
    const b = req.body.settings;
    const g = store.config.general;
    const lev = num(b.leverage, { min: 1, max: 20, int: true });
    if (lev !== g.leverage && engine.runState === 'RUNNING') throw new Error('Stop bots before changing leverage');
    const next = {
      ...g,
      leverage: lev,
      takerFeePct: num(b.takerFeePct, { min: 0, max: 1 }),
      makerFeePct: num(b.makerFeePct, { min: 0, max: 1 }),
      slippagePct: num(b.slippagePct, { min: 0, max: 5 }),
      includeFunding: !!b.includeFunding,
      paperInitialBalance: num(b.paperInitialBalance, { min: 1, max: 1e9 }),
      liveBaseCapital: b.liveBaseCapital === '' || b.liveBaseCapital == null ? null : num(b.liveBaseCapital, { min: 1, max: 1e10 }),
      stopsActiveWhenStopped: !!b.stopsActiveWhenStopped,
      dataStaleSec: num(b.dataStaleSec, { min: 5, max: 600, int: true }),
      balanceBufferPct: num(b.balanceBufferPct, { min: 0, max: 50 }),
      exchangeStops: !!b.exchangeStops,
      stopWorkingType: ['CONTRACT_PRICE', 'MARK_PRICE'].includes(b.stopWorkingType) ? b.stopWorkingType : g.stopWorkingType,
    };
    store.config.general = next;
    store.saveConfig();
    log.info('General settings saved', 'CONFIG_SAVED', { leverage: next.leverage, fee: next.takerFeePct, slip: next.slippagePct });
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
  ok(res, await engine.closeAll('EMERGENCY_CLOSE'));
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
      next.maxOrderUsdt[st][side] = v === '' || v == null ? null : n(v, { min: 1, max: 1e7 });
    }
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

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) { ws.close(1008, 'origin'); return; }
  ws.send(JSON.stringify({ type: 'logs', data: log.recent(500) }));
  ws.send(JSON.stringify({ type: 'snapshot', data: fullSnapshot() }));
});
const broadcast = (msg) => {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};
setInterval(() => { if (wss.clients.size) broadcast({ type: 'snapshot', data: fullSnapshot() }); }, 1000);
log.on('log', (e) => broadcast({ type: 'log', data: e }));
const klineThrottle = new Map();
md.on('kline', (k) => {
  const key = `${k.symbol}:${k.interval}`;
  const now = Date.now();
  if (!k.closed && now - (klineThrottle.get(key) || 0) < 250) return;
  klineThrottle.set(key, now);
  broadcast({ type: 'kline', data: k });
});

process.on('unhandledRejection', (e) => log.error(`unhandled: ${e?.message || e}`, 'ENGINE_ERROR'));
const shutdown = () => { store.saveStateNow(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, async () => {
  log.info(`HIC Terminal listening on http://${HOST}:${PORT} — mode ${store.config.general.mode}, bots STOPPED (press START to run)`);
  const boot = async () => {
    try {
      await md.start();
      engine.evaluateAll('init');
      controller.start();
      if (engine.mode === 'LIVE') engine.verifyLive(false);
    } catch (e) {
      log.error(`Market data init failed: ${e.message} — retrying in 15s`, 'API_ERROR');
      setTimeout(boot, 15000);
    }
  };
  boot();
});
