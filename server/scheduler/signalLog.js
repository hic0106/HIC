// Signal Log: one record per strategy evaluation of a closed candle, also when nothing happens.
// Kept in memory (recent) and appended to data/signals/signals-YYYY-MM-DD.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR } from '../store.js';

const DIR = path.join(DATA_DIR, 'signals');
const MAX = 3000;

export class SignalLog extends EventEmitter {
  constructor({ persist = true } = {}) {
    super();
    this.persist = persist;
    this.items = [];
    if (persist) {
      fs.mkdirSync(DIR, { recursive: true });
      this.loadRecent();
    }
  }

  loadRecent() {
    try {
      const files = fs.readdirSync(DIR).filter((f) => /^signals-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-3);
      for (const f of files) {
        for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { this.items.push(JSON.parse(line)); } catch { /* skip broken line */ }
        }
      }
      if (this.items.length > MAX) this.items.splice(0, this.items.length - MAX);
    } catch { /* first run */ }
  }

  add(rec) {
    const r = { ts: Date.now(), ...rec };
    this.items.push(r);
    if (this.items.length > MAX) this.items.splice(0, this.items.length - MAX);
    if (this.persist) {
      try { fs.appendFileSync(path.join(DIR, `signals-${new Date(r.ts).toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(r)}\n`); } catch { /* disk issue must not stop trading */ }
    }
    this.emit('signal', r);
    return r;
  }

  recent({ limit = 500, strategy, symbol } = {}) {
    let out = this.items;
    if (strategy) out = out.filter((x) => x.strategy === strategy);
    if (symbol) out = out.filter((x) => x.symbol === symbol);
    return out.slice(-limit);
  }
}
