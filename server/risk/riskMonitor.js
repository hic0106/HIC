// RiskMonitor: real-time protection, independent of the StrategyScheduler (never waits for a candle close).
//   - every price tick -> engine.onPrice (existing ATR / fixed emergency stop + take profit logic)
//   - liquidation distance (LIVE, from Binance positionRisk liquidationPrice vs mark price)
//   - unexpected exchange positions / position mismatch (reported, never auto-fixed)
//   - market data / exchange connection state
//   - manual emergency close (CLOSE ALL) -> portfolio refreshed immediately
// Stop prices are fixed at entry from the ATR of the confirmed (closed) signal candle; nothing here recomputes them.
const LIQ_WARN_PCT = 10; // warn when mark price is within 10% of the liquidation price

export class RiskMonitor {
  constructor({ engine, md, log, portfolio = null }) {
    this.engine = engine;
    this.md = md;
    this.log = log;
    this.portfolio = portfolio;
    this.lastPrice = {};
    this.lastLiqWarn = {};
    this.events = { stopChecks: 0, lastStopCheckAt: null };
    this.timer = null;
  }

  start() {
    this.md.on('price', ({ symbol, price }) => this.onPrice(symbol, price));
    this.md.on('status', (s) => { this.connection = s; });
    this.timer = setInterval(() => { try { this.checkLiquidation(); } catch (e) { this.log.warn(`risk check error: ${e.message}`, 'RISK'); } }, 5000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  onPrice(symbol, price) {
    this.lastPrice[symbol] = { price, at: Date.now() };
    this.events.stopChecks++;
    this.events.lastStopCheckAt = Date.now();
    this.engine.onPrice(symbol, price);
  }

  checkLiquidation() {
    const rows = this.portfolio?.exchange?.positions || [];
    if (this.engine.mode !== 'LIVE') return [];
    const out = [];
    for (const p of rows) {
      if (!(p.liquidationPrice > 0) || !(p.markPrice > 0)) continue;
      const dist = Math.abs(p.markPrice - p.liquidationPrice) / p.markPrice * 100;
      if (dist < LIQ_WARN_PCT) {
        out.push({ symbol: p.symbol, side: p.side, dist });
        const k = `${p.symbol}:${p.side}`;
        if (!this.lastLiqWarn[k] || Date.now() - this.lastLiqWarn[k] > 300_000) {
          this.lastLiqWarn[k] = Date.now();
          this.log.error(`LIQUIDATION RISK ${p.symbol} ${p.side}: mark ${p.markPrice} liquidation ${p.liquidationPrice} (${dist.toFixed(2)}% away)`, 'LIQUIDATION_RISK');
        }
      }
    }
    this.liqWarnings = out;
    return out;
  }

  async emergencyCloseAll(reason = 'EMERGENCY_CLOSE') {
    const r = await this.engine.closeAll(reason);
    this.engine.emitChange('emergency close');
    return r;
  }

  status() {
    const e = this.engine;
    const positions = e.positionsList();
    const near = positions.filter((p) => p.stopDistPct != null && p.stopDistPct < 1).map((p) => ({ strategy: p.strategy, symbol: p.symbol, side: p.side, stopDistPct: p.stopDistPct }));
    return {
      stopsActive: e.runState === 'RUNNING' || !!e.cfg.general.stopsActiveWhenStopped,
      watched: positions.filter((p) => p.stopPrice != null).length,
      nearStop: near,
      liquidation: this.liqWarnings || [],
      lastStopCheckAt: this.events.lastStopCheckAt,
      market: this.md.status,
      exchange: e.mode === 'LIVE' ? e.live.status : 'PAPER',
    };
  }
}
