// Data provider abstraction.
//   SignalDataProvider    : candles the strategy indicators are computed on
//   ExecutionDataProvider : live prices / order book / funding of the traded contract (Binance Futures)
// CRYPTO : signal = Binance UTC daily candles,  execution = Binance
// QQQ    : signal = US regular-session daily candles built from Binance QQQUSDT 30m bars (Binance-only for now;
//          can be swapped for QQQ ETF session data later), execution = Binance QQQUSDT
import { sessionsBetween, buildSessionCandle } from './session.js';

const toBar = (a) => ({ t: a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], v: +a[5], T: a[6] });
const BAR = '30m';
const BAR_MS = 30 * 60_000;

export class BinanceUsSessionProvider {
  constructor({ rest, symbol, listedAt, getCalendar, log }) {
    this.rest = rest;
    this.symbol = symbol;
    this.listedAt = listedAt || Date.now() - 400 * 86_400_000;
    this.getCalendar = getCalendar;
    this.log = log;
    this.bars = new Map(); // t -> bar (closed and forming)
    this.kind = 'BINANCE_US_SESSION';
    this.interval = BAR;
  }

  async fetchRange(startTime, endTime = Date.now()) {
    let start = Math.max(startTime, this.listedAt - BAR_MS);
    for (let guard = 0; guard < 50 && start < endTime; guard++) {
      const rows = await this.rest.publicGet('/fapi/v1/klines', { symbol: this.symbol, interval: BAR, startTime: start, limit: 1500 });
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) { const b = toBar(r); this.bars.set(b.t, b); }
      const lastT = rows[rows.length - 1][0];
      if (lastT + BAR_MS <= start) break; // no progress (server ignores startTime)
      start = lastT + BAR_MS;
      if (rows.length < 1500) break;
    }
    this.prune();
  }

  prune() {
    const cut = Date.now() - 420 * 86_400_000;
    for (const t of this.bars.keys()) if (t < cut) this.bars.delete(t);
  }

  onBar(bar) { this.bars.set(bar.t, bar); }

  sortedBars() { return [...this.bars.values()].sort((a, b) => a.t - b.t); }

  // All completed US sessions (close + settle <= now) with at least one bar.
  sessions(fromTs, now = Date.now(), settleMs = 90_000) {
    const bars = this.sortedBars().filter((b) => b.T < now); // closed bars only
    const out = [];
    const from = Math.max(fromTs, this.listedAt - 86_400_000, now - 800 * 86_400_000);
    for (const s of sessionsBetween(from, now - settleMs, this.getCalendar())) {
      const c = buildSessionCandle(s, bars);
      if (c) out.push({ ...c, expectedBars: Math.round((s.close - s.open) / BAR_MS) });
    }
    return out;
  }
}
