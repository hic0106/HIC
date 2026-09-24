// JSON persistence for config / state / secrets. Atomic writes (tmp + rename).
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.HIC_DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });

import { SYMBOLS } from './assets.js';
import { DEFAULT_US_CALENDAR } from './session.js';
import { DEFAULT_UNIVERSE } from './universeDefaults.js';

export { SYMBOLS };

const amounts = (long, short) => ({ PAPER: { long, short }, LIVE: { long, short } });

export const DEFAULT_CONFIG = {
  general: {
    mode: 'PAPER', // PAPER | LIVE (selected trading engine; bot RUNNING/STOPPED is separate)
    usCalendar: DEFAULT_US_CALENDAR, // NYSE holidays / early closes for QQQ signal sessions
    takerFeePct: 0.05,
    makerFeePct: 0.02,
    slippagePct: 0.05,
    includeFunding: true,
    paperInitialBalance: 10000,
    stopsActiveWhenStopped: true, // Emergency stops keep protecting positions after STOP ALL BOTS
    dataStaleSec: 30,
    balanceBufferPct: 2, // extra margin headroom required in balance check
    exchangeStops: true, // LIVE: also place each emergency stop on Binance (STOP_MARKET, Algo API) so it works while the PC is off
    stopWorkingType: 'CONTRACT_PRICE', // trigger source for Binance stops: CONTRACT_PRICE (last) | MARK_PRICE
    // StrategyScheduler: a NEW entry is executed only if its signal candle closed at most N minutes ago
    // (restart / late start). Exits are always executed. Stops never depend on this.
    scheduler: { entryGraceMin: { '4h': 30, '1d': 120, US_SESSION: 120 }, retrySec: 15 },
  },
  // Crypto universe (server/universe.js): Binance USDⓈ-M perpetuals ranked by 24h quoteVolume.
  // watch = top watchTopN (+ symbols with positions / orders / stops), new entries only for the top tradeTopN.
  cryptoUniverse: structuredClone(DEFAULT_UNIVERSE),
  // Self-Improving Controller (V1). Only scales base order amounts of NEW entries by a bounded multiplier.
  controller: {
    mode: 'OBSERVE', // OFF | OBSERVE | PAPER_AUTO | LIVE_APPROVAL
    reevalDays: 7,
    minHistoryDays: 90,
    windows: { fast: 30, main: 90, stability: 180, extended: 365 },
    lowTradeCountForExtended: 5, // < N trades in the stability window -> use the 365D window
    multipliers: { PAUSED: 0, REDUCED: 0.5, CAUTIOUS: 0.75, NORMAL: 1, BOOSTED: 1.25 }, // hard max 1.25
    weights: { return: 0.3, drawdown: 0.25, riskAdjusted: 0.3, consistency: 0.15 },
    scale: { returnPct: 10, drawdownPct: 15, sharpe: 1.5, sortino: 2 },
    thresholds: { boost: 0.5, normal: 0, cautious: -0.35 },
    guards: {
      noBoostDDPct: 10, reduceDDPct: 15, pauseDDPct: 25,
      noBoostConsecLosses: 3, cautionConsecLosses: 5,
      highVolCap: 'CAUTIOUS',
      correlationThreshold: 0.85, correlationGuard: false,
      maxCoinExposurePctForBoost: 50,
    },
    regime: { volHighPct: 80, atrHighPct: 6, adxTrend: 20, sidewaysRet30Pct: 5 }, // CRYPTO (BTC)
    regimeTradfi: { volHighPct: 35, atrHighPct: 3, adxTrend: 20, sidewaysRet30Pct: 3 }, // TRADFI (QQQ sessions)
    // after an entry/exit/stop PARAMETER change, evaluate only data since the change (starts again at NORMAL)
    resetHistoryOnParamChange: true,
    boostRegimes: { LONG: ['BULL_TREND', 'NORMAL'], SHORT: ['BEAR_TREND'] },
    // optional hard maximum USDT per order (null = none)
    maxOrderUsdt: {
      TURTLE: { LONG: null, SHORT: null }, ADX: { LONG: null, SHORT: null }, TSMOM: { LONG: null, SHORT: null }, RAYNER: { LONG: null, SHORT: null },
      QQQ_EMA_TREND: { LONG: null, SHORT: null }, QQQ_TSMOM: { LONG: null, SHORT: null }, QQQ_SMA200: { LONG: null, SHORT: null }, QQQ_TURTLE_50_20: { LONG: null, SHORT: null },
    },
  },
  strategies: {
    TURTLE: {
      enabled: true,
      timeframe: '4h', // signal candles (4h | 1d); rules unchanged: close vs prior N-bar channel
      shortEnabled: true,
      leverage: 1, amounts: amounts(300, 150),
      params: { entryPeriod: 20, exitPeriod: 10, smaFilter: 200 },
      stop: { mode: 'ATR_DYNAMIC', atrPeriod: 20, atrMult: 2.0, minPct: 8, maxPct: 18, fixedPct: 10 },
      takeProfit: { enabled: false, pct: 30 },
    },
    ADX: {
      enabled: true,
      timeframe: '4h',
      shortEnabled: true,
      leverage: 1, amounts: amounts(250, 125),
      params: { adxPeriod: 14, threshold: 25, smaFilter: 200 },
      stop: { mode: 'ATR_DYNAMIC', atrPeriod: 14, atrMult: 2.0, minPct: 6, maxPct: 15, fixedPct: 8 },
      takeProfit: { enabled: false, pct: 25 },
    },
    TSMOM: {
      enabled: true,
      timeframe: '1d',
      shortEnabled: false,
      leverage: 1, amounts: amounts(250, 0),
      params: { lookback: 30 },
      stop: { mode: 'ATR_DYNAMIC', atrPeriod: 20, atrMult: 3.0, minPct: 10, maxPct: 22, fixedPct: 15 },
      takeProfit: { enabled: false, pct: 40 },
    },
    // Rayner: EMA50 trend + MACD(1,50,9) histogram acceleration, structure stop, histogram target exit.
    // Off by default (backtest validation first).
    RAYNER: {
      enabled: false,
      timeframe: '4h',
      shortEnabled: true,
      leverage: 1, amounts: amounts(200, 100),
      params: {
        emaPeriod: 50, fastPeriod: 1, slowPeriod: 50, signalPeriod: 9,
        slopeLookback: 3, momentumLookback: 3, momentumMultiplier: 1.5,
        stopLookback: 10, targetLookback: 25, maxEntriesPerTrend: 2,
      },
      // STRUCTURE: lowest low / highest high of the last stopLookback closed candles at the signal candle, fixed after entry.
      // atr*/min/max/fixed fields are kept for schema compatibility (used only if the mode is switched).
      stop: { mode: 'STRUCTURE', atrPeriod: 14, atrMult: 2.0, minPct: 2, maxPct: 20, fixedPct: 8 },
      takeProfit: { enabled: false, pct: 30 },
    },
    // ---- TRADFI (QQQUSDT): LONG / CASH only, signals on US regular-session closes
    QQQ_EMA_TREND: {
      enabled: true, shortEnabled: false, leverage: 1, amounts: amounts(300, 0),
      params: { fastEma: 50, slowEma: 150, sma200Filter: false },
      stop: { mode: 'ATR_DYNAMIC', atrPeriod: 20, atrMult: 2.5, minPct: 5, maxPct: 12, fixedPct: 8 },
      takeProfit: { enabled: false, pct: 20 },
    },
    QQQ_TSMOM: {
      enabled: true, shortEnabled: false, leverage: 1, amounts: amounts(250, 0),
      params: { lookback: 126, sma200Filter: false },
      stop: { mode: 'ATR_DYNAMIC', atrPeriod: 20, atrMult: 2.5, minPct: 5, maxPct: 12, fixedPct: 8 },
      takeProfit: { enabled: false, pct: 20 },
    },
    QQQ_SMA200: {
      enabled: false, shortEnabled: false, leverage: 1, amounts: amounts(250, 0),
      params: { smaPeriod: 200 },
      stop: { mode: 'ATR_DYNAMIC', atrPeriod: 20, atrMult: 2.5, minPct: 5, maxPct: 12, fixedPct: 8 },
      takeProfit: { enabled: false, pct: 20 },
    },
    QQQ_TURTLE_50_20: {
      enabled: false, shortEnabled: false, leverage: 1, amounts: amounts(250, 0),
      params: { entryPeriod: 50, exitPeriod: 20 },
      stop: { mode: 'ATR_DYNAMIC', atrPeriod: 20, atrMult: 2.5, minPct: 5, maxPct: 12, fixedPct: 8 },
      takeProfit: { enabled: false, pct: 20 },
    },
  },
};

export function emptyModeState(mode, config) {
  return {
    mode,
    wallet: mode === 'PAPER' ? config.general.paperInitialBalance : null, // paper wallet balance
    slots: {}, // key `${strategy}:${symbol}`
    orders: [], // recent orders (max 500)
    trades: [], // closed trades (max 2000)
    daySnap: null, // { day: 'YYYY-MM-DD', totalPnl }
    realizedTotal: 0,
    scheduler: {}, // StrategyScheduler: `${strategy}:${symbol}:${timeframe}` -> last evaluated candle close (dedup)
  };
}

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data, mode = 0o644) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
}

const F = {
  config: path.join(DATA_DIR, 'config.json'),
  state: path.join(DATA_DIR, 'state.json'),
  secrets: path.join(DATA_DIR, 'secrets.json'),
};

export class Store {
  constructor() {
    this.config = deepMerge(structuredClone(DEFAULT_CONFIG), readJson(F.config, {})); // clone: edits must never leak into the defaults
    // removed settings: leverage is per strategy now, LIVE base capital = current account equity
    for (const k of ['leverage', 'leverageTradfi', 'liveBaseCapital']) delete this.config.general[k];
    const st = readJson(F.state, {});
    this.state = {
      runState: 'STOPPED', // always start STOPPED after restart (safety)
      modes: {
        PAPER: deepMerge(emptyModeState('PAPER', this.config), st.modes?.PAPER || {}),
        LIVE: deepMerge(emptyModeState('LIVE', this.config), st.modes?.LIVE || {}),
      },
    };
    this.secrets = readJson(F.secrets, { apiKey: '', apiSecret: '', testnet: false });
    this._saveTimer = null;
    this.saveConfig();
  }

  saveConfig() {
    writeJsonAtomic(F.config, this.config);
  }

  // State is saved immediately for order/position changes (call saveStateNow) and debounced otherwise.
  saveState() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.saveStateNow(); }, 1000);
  }

  saveStateNow() {
    writeJsonAtomic(F.state, { modes: this.state.modes, savedAt: Date.now() });
  }

  saveSecrets(s) {
    this.secrets = { ...this.secrets, ...s };
    writeJsonAtomic(F.secrets, this.secrets, 0o600);
    try { fs.chmodSync(F.secrets, 0o600); } catch { /* windows */ }
  }

  // Deletes the Binance key only (a Claude API key, if any, is kept).
  clearSecrets() {
    const keep = this.secrets.anthropicApiKey;
    this.secrets = { apiKey: '', apiSecret: '', testnet: false };
    if (keep) this.saveSecrets({ anthropicApiKey: keep });
    else { try { fs.unlinkSync(F.secrets); } catch { /* none */ } }
  }

  logFile(day) {
    return path.join(DATA_DIR, 'logs', `system-${day}.log`);
  }
}
