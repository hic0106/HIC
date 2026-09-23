// System log: in-memory ring buffer + daily file + event emitter for UI streaming.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

export class Logger extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.buf = [];
    this.seq = 0;
  }

  // level: INFO | TRADE | WARN | ERROR ; code: short machine code e.g. ORDER_REJECTED
  log(level, msg, code = null, meta = null) {
    const e = { id: ++this.seq, ts: Date.now(), level, code, msg, meta };
    this.buf.push(e);
    if (this.buf.length > 2000) this.buf.splice(0, this.buf.length - 2000);
    const day = new Date(e.ts).toISOString().slice(0, 10);
    const line = `${new Date(e.ts).toISOString()} ${level.padEnd(5)} ${code ? `[${code}] ` : ''}${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
    fs.appendFile(this.store.logFile(day), line, () => {});
    if (process.env.HIC_LOG_STDOUT !== '0') process.stdout.write(line);
    this.emit('log', e);
    return e;
  }

  info(msg, code, meta) { return this.log('INFO', msg, code, meta); }
  trade(msg, code, meta) { return this.log('TRADE', msg, code, meta); }
  warn(msg, code, meta) { return this.log('WARN', msg, code, meta); }
  error(msg, code, meta) { return this.log('ERROR', msg, code, meta); }

  recent(n = 500) { return this.buf.slice(-n); }
}
