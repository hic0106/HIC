// Controller persistence: state (data/controller.json) + append-only decision history (data/controller-history.jsonl).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../store.js';

const STATE_FILE = path.join(DATA_DIR, 'controller.json');
const HISTORY_FILE = path.join(DATA_DIR, 'controller-history.jsonl');

export function emptyControllerState() {
  return {
    version: 1,
    lastEvaluation: null,
    regime: null,
    // recommended (controller decision) per `${strategy}:${side}`
    sides: {},
    // multipliers actually applied to orders, per trading mode
    applied: { PAPER: {}, LIVE: {} },
    pending: [], // LIVE approval queue
    shadow: null, // ShadowPortfolio state
    failSafe: null, // { since, error } when the controller fell back to 1.00
  };
}

export class ControllerStore {
  constructor() {
    this.state = { ...emptyControllerState(), ...readJson(STATE_FILE, {}) };
    this.history = [];
    try {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
      this.history = lines.slice(-2000).map((l) => JSON.parse(l));
    } catch { /* no history yet */ }
    this._timer = null;
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.saveNow(); }, 1000);
    this._timer.unref?.();
  }

  saveNow() {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, STATE_FILE);
  }

  appendHistory(rec) {
    this.history.push(rec);
    if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(rec)}\n`);
  }

  recentHistory(n = 200) { return this.history.slice(-n).reverse(); }
}

function readJson(f, fb) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; }
}
