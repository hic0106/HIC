// JSON persistence for config / state / secrets. Atomic writes (tmp + rename).
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.HIC_DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'];

const amounts = (long, short) => ({ PAPER: { long, short }, LIVE: { long, short } });

export const DEFAULT_CONFIG = {
  general: {
    mode: 'PAPER', // PAPER | LIVE (selected trading engine; bot RUNNING/STOPPED is separate)
    leverage: 1,
    takerFeePct: 0.05,
    makerFeePct: 0.02,
    slippagePct: 0.05,
    includeFunding: true,
    paperInitialBalance: 10000,
    liveBaseCapital: null, // null = captured from first successful LIVE account read
    stopsActiveWhenStopped: true, // Emergency stops keep protecting positions after STOP ALL BOTS
    dataStaleSec: 30,
    balanceBufferPct: 2, // extra margin headroom required in balance check
  },
  strategies: {
    TURTLE: {
      enabled: true,
      shortEnabled: true,
      amounts: amounts(300, 150),
      params: { entryPeriod: 20, exitPeriod: 10, smaFilter: 200 },
      stop: { mode: 'ATR_DYNAMIC', atrPeriod: 20, atrMult: 2.0, minPct: 8, maxPct: 18, fixedPct: 10 },
      takeProfit: { enabled: false, pct: 30 },
    },
    ADX: {
      enabled: true,
      shortEnabled: true,
      amounts: amounts(250, 125),
      params: { adxPeriod: 14, threshold: 25, smaFilter: 200 },
      stop: { mode: 'ATR_DYNAMIC', atrPeriod: 14, atrMult: 2.0, minPct: 6, maxPct: 15, fixedPct: 8 },
      takeProfit: { enabled: false, pct: 25 },
    },
    TSMOM: {
      enabled: true,
      shortEnabled: false,
      amounts: amounts(250, 0),
      params: { lookback: 30 },
      stop: { mode: 'ATR_DYNAMIC', atrPeriod: 20, atrMult: 3.0, minPct: 10, maxPct: 22, fixedPct: 15 },
      takeProfit: { enabled: false, pct: 40 },
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
    this.config = deepMerge(DEFAULT_CONFIG, readJson(F.config, {}));
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

  clearSecrets() {
    this.secrets = { apiKey: '', apiSecret: '', testnet: false };
    try { fs.unlinkSync(F.secrets); } catch { /* none */ }
  }

  logFile(day) {
    return path.join(DATA_DIR, 'logs', `system-${day}.log`);
  }
}
