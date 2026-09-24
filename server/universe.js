// Crypto universe: which Binance USDⓈ-M perpetuals the terminal watches and may enter.
//   candidates : status TRADING, contractType PERPETUAL, quoteAsset USDT, crypto underlying (underlyingType COIN),
//                not a stablecoin base, listed >= minListingDays, not a TradFi symbol (QQQUSDT etc.)
//   ranking    : 24h quoteVolume (USDT turnover) from /fapi/v1/ticker/24hr — never base-asset volume
//   watch      : top watchTopN (+ alwaysInclude + PROTECTED)  -> market data, signals, position management
//   trade      : top tradeTopN (+ alwaysInclude)              -> NEW entries allowed (engine checks before ordering)
//   protected  : symbols with an open PAPER/LIVE position, a pending/unknown order or an exchange stop are always
//                watched, whatever their rank (exits / stops must never lose their data stream)
// The watch set is decided once at startup (market-data streams are subscribed once). The 24h refresh only
// re-ranks inside the subscribed set (trade permissions); watch-set changes are applied at the next restart.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { DEFAULT_UNIVERSE } from './universeDefaults.js';
import { TRADFI_META, FALLBACK_CRYPTO, registerCryptoSymbols, assetClassOf } from './assets.js';

const DAY = 86_400_000;
const FILE = path.join(DATA_DIR, 'universe.json');

export { DEFAULT_UNIVERSE };

export const STABLE_BASES = ['USDT', 'USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'USDE', 'USD1', 'BUSD', 'PYUSD', 'USDS', 'RLUSD', 'USDD', 'GUSD', 'EURI', 'AEUR', 'EUR'];

export const universeConfig = (config) => ({ ...DEFAULT_UNIVERSE, ...(config?.cryptoUniverse || {}) });

// exchangeInfo -> eligible crypto perpetuals. Returns { eligible: [{symbol, baseAsset, onboardDate}], excluded: {symbol: reason} }
export function filterCandidates(info, cfg, now = Date.now()) {
  const eligible = [], excluded = {};
  const stable = new Set(STABLE_BASES);
  for (const s of info?.symbols || []) {
    if (s.quoteAsset && s.quoteAsset !== 'USDT') continue;
    if (!s.quoteAsset && !/USDT$/.test(s.symbol)) continue;
    const base = s.baseAsset || s.symbol.replace(/USDT$/, '');
    let why = null;
    if (TRADFI_META[s.symbol]) why = 'TRADFI';
    else if (s.contractType !== 'PERPETUAL') why = s.contractType === 'TRADIFI_PERPETUAL' ? 'TRADFI' : 'NOT_PERPETUAL';
    else if (s.underlyingType && s.underlyingType !== 'COIN') why = 'NOT_CRYPTO';
    else if (s.status !== 'TRADING') why = 'NOT_TRADING';
    else if (cfg.excludeStablecoinBases && stable.has(base.toUpperCase())) why = 'STABLECOIN';
    else if (Number(s.onboardDate) > 0 && now - Number(s.onboardDate) < cfg.minListingDays * DAY) why = 'NEW_LISTING';
    if (why) excluded[s.symbol] = why;
    else eligible.push({ symbol: s.symbol, baseAsset: base, onboardDate: Number(s.onboardDate) || null });
  }
  return { eligible, excluded };
}

// Ranks eligible symbols by 24h quoteVolume and builds the watch / trade sets.
export function rankUniverse(eligible, tickers, cfg, protectedSymbols = []) {
  const qv = new Map((Array.isArray(tickers) ? tickers : []).map((t) => [t.symbol, Number(t.quoteVolume)]));
  const ranked = eligible
    .map((e) => ({ symbol: e.symbol, baseAsset: e.baseAsset, quoteVolume: qv.get(e.symbol) }))
    .filter((r) => Number.isFinite(r.quoteVolume) && r.quoteVolume > 0)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const inRanked = new Set(ranked.map((r) => r.symbol));
  const always = (cfg.alwaysInclude || []).filter((s) => inRanked.has(s));
  const uniq = (a) => [...new Set(a)];
  const watch = uniq([...ranked.slice(0, cfg.watchTopN).map((r) => r.symbol), ...always]);
  const trade = uniq([...ranked.slice(0, cfg.tradeTopN).map((r) => r.symbol), ...always]);
  const prot = uniq(protectedSymbols).filter((s) => assetClassOf(s) === 'CRYPTO' && !TRADFI_META[s]);
  const protectedAdded = prot.filter((s) => !watch.includes(s));
  return { ranked, watch: [...watch, ...protectedAdded], trade, protectedAdded };
}

// Symbols that must stay watched: open positions, pending / unknown orders, exchange-side stops (both books).
export function protectedSymbols(state) {
  const out = new Set();
  for (const mode of ['PAPER', 'LIVE']) {
    for (const slot of Object.values(state?.modes?.[mode]?.slots || {})) {
      if (slot.position || slot.pending || slot.position?.exStop || ['PENDING', 'UNKNOWN'].includes(slot.status)) out.add(slot.symbol);
    }
  }
  return [...out].filter((s) => !TRADFI_META[s]);
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms).unref?.())]);

export class UniverseManager {
  constructor({ store, rest, log, file = FILE }) {
    this.store = store;
    this.rest = rest; // public REST (no key)
    this.log = log;
    this.file = file;
    this.watch = [...FALLBACK_CRYPTO];
    this.tradeSet = new Set(FALLBACK_CRYPTO);
    this.rows = {}; // symbol -> { rank, quoteVolume }
    this.protected = [];
    this.source = 'FALLBACK';
    this.rankedAt = null;
    this.refreshedAt = null;
    this.pending = null; // watch-set change waiting for a restart
    this.excluded = {};
    this.timer = null;
  }

  get cfg() { return universeConfig(this.store.config); }

  async compute() {
    const cfg = this.cfg;
    const [info, tickers] = await Promise.all([this.rest.exchangeInfo(), this.rest.publicGet('/fapi/v1/ticker/24hr')]);
    const { eligible, excluded } = filterCandidates(info, cfg);
    const r = rankUniverse(eligible, tickers, cfg, this.protected);
    return { ...r, excluded, at: Date.now() };
  }

  // Startup: decides the watch set and registers it (before market data / engine are built).
  async init({ timeoutMs = 20_000 } = {}) {
    const cfg = this.cfg;
    this.protected = protectedSymbols(this.store.state);
    let r = null;
    if (cfg.mode === 'TOP_QUOTE_VOLUME') {
      try {
        r = await withTimeout(this.compute(), timeoutMs);
        this.source = 'LIVE';
      } catch (e) {
        const cached = this.readCache();
        this.log?.error(`Universe ranking failed (${e.message}) — ${cached ? `using saved universe from ${new Date(cached.at).toISOString()}` : `fallback ${FALLBACK_CRYPTO.join('/')}`}`, 'UNIVERSE');
        if (cached) {
          r = { ranked: cached.ranked || [], watch: [...new Set([...(cached.watch || []), ...this.protected])], trade: cached.trade || [], protectedAdded: this.protected.filter((s) => !(cached.watch || []).includes(s)), at: cached.at };
          this.source = 'CACHE';
        }
      }
    }
    if (!r) {
      const base = [...new Set([...FALLBACK_CRYPTO, ...cfg.alwaysInclude])];
      r = { ranked: [], watch: [...new Set([...base, ...this.protected])], trade: base, protectedAdded: this.protected.filter((s) => !base.includes(s)), at: null };
      if (cfg.mode !== 'TOP_QUOTE_VOLUME') this.source = 'STATIC';
    }
    this.apply(r);
    registerCryptoSymbols(this.watch, Object.fromEntries((r.ranked || []).map((x) => [x.symbol, x.baseAsset])));
    if (this.source === 'LIVE') this.writeCache(r);
    this.log?.info(`Crypto universe (${this.source}): watch ${this.watch.length} [${this.watch.map((s) => s.replace('USDT', '')).join(' ')}] · new entries ${this.tradeSet.size}${r.protectedAdded?.length ? ` · protected (position/order/stop) ${r.protectedAdded.join(' ')}` : ''}`, 'UNIVERSE');
    return this.snapshot();
  }

  apply(r) {
    this.watch = r.watch;
    this.tradeSet = new Set(r.trade.filter((s) => r.watch.includes(s)));
    this.rows = Object.fromEntries((r.ranked || []).map((x) => [x.symbol, { rank: x.rank, quoteVolume: x.quoteVolume }]));
    this.rankedAt = r.at || null;
    this.excluded = r.excluded || this.excluded;
    this.protectedAdded = r.protectedAdded || [];
  }

  // Runtime re-rank (24h). Trade permissions follow the new ranking but only inside the subscribed watch set.
  async refresh() {
    if (this.cfg.mode !== 'TOP_QUOTE_VOLUME') return { ok: false, msg: 'static universe' };
    try {
      this.protected = protectedSymbols(this.store.state);
      const r = await this.compute();
      const add = r.watch.filter((s) => !this.watch.includes(s));
      const remove = this.watch.filter((s) => !r.watch.includes(s));
      const prevTrade = this.tradeSet;
      this.tradeSet = new Set(r.trade.filter((s) => this.watch.includes(s)));
      this.rows = Object.fromEntries(r.ranked.map((x) => [x.symbol, { rank: x.rank, quoteVolume: x.quoteVolume }]));
      this.rankedAt = r.at;
      this.refreshedAt = Date.now();
      this.excluded = r.excluded;
      this.pending = add.length || remove.length ? { add, remove, at: r.at } : null;
      this.writeCache(r);
      const lost = [...prevTrade].filter((s) => !this.tradeSet.has(s));
      const gained = [...this.tradeSet].filter((s) => !prevTrade.has(s));
      this.log?.info(`Universe re-ranked: new entries ${this.tradeSet.size}${lost.length ? ` · entry off ${lost.join(' ')}` : ''}${gained.length ? ` · entry on ${gained.join(' ')}` : ''}${this.pending ? ` · watch list change on restart (+${add.join(' ') || '-'} / -${remove.join(' ') || '-'})` : ''}`, 'UNIVERSE');
      return { ok: true };
    } catch (e) {
      this.log?.warn(`Universe refresh failed: ${e.message} — keeping previous ranking`, 'UNIVERSE');
      return { ok: false, msg: e.message };
    }
  }

  start(intervalMs = DAY) {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  // Crypto only: TradFi symbols are not ranked (QQQ has its own rules).
  isTradeAllowed(symbol) {
    if (assetClassOf(symbol) !== 'CRYPTO') return true;
    return this.tradeSet.has(symbol);
  }

  cryptoWatch() { return this.watch.filter((s) => assetClassOf(s) === 'CRYPTO'); }

  snapshot() {
    const cfg = this.cfg;
    const prot = new Set(protectedSymbols(this.store.state));
    return {
      mode: cfg.mode, source: this.source, rankedAt: this.rankedAt, refreshedAt: this.refreshedAt,
      watchTopN: cfg.watchTopN, tradeTopN: cfg.tradeTopN, minListingDays: cfg.minListingDays, alwaysInclude: cfg.alwaysInclude,
      watchSymbols: this.watch, tradeSymbols: [...this.tradeSet],
      protectedSymbols: [...prot], protectedAdded: this.protectedAdded || [],
      rows: this.watch.map((s) => ({ symbol: s, rank: this.rows[s]?.rank ?? null, quoteVolume: this.rows[s]?.quoteVolume ?? null, tradeAllowed: this.tradeSet.has(s), protected: prot.has(s) })),
      pending: this.pending,
      watchChangeApplies: 'RESTART', // runtime refresh re-ranks trade permissions only
    };
  }

  readCache() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; } }
  writeCache(r) {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: r.at, watch: r.watch, trade: r.trade, ranked: r.ranked.slice(0, 60) }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch { /* keep in memory */ }
  }
}
