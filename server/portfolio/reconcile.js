// Exchange vs internal (strategy ledger) position reconciliation.
// The exchange is the truth source: differences are reported, never auto-corrected or hidden.
const SIDES = ['LONG', 'SHORT'];

const decimalsOf = (step) => {
  const s = String(step ?? '');
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.replace(/0+$/, '').length - i - 1;
};

// exchange: [{ symbol, positionSide, positionAmt }] (Binance /fapi/v3/account or /positionRisk rows)
export function reconcilePositions({ slots, exchange, filters = {}, symbols }) {
  const ledger = {};
  const pending = new Set();
  for (const s of Object.values(slots || {})) {
    if (s.pending) pending.add(s.symbol);
    if (!s.position) continue;
    const k = `${s.symbol}:${s.position.side}`;
    ledger[k] = (ledger[k] || 0) + s.position.qty;
  }
  const rows = [];
  for (const symbol of symbols) for (const side of SIDES) {
    const p = (exchange || []).find((x) => x.symbol === symbol && (x.positionSide || 'BOTH') === side);
    const exchangeQty = p ? Math.abs(Number(p.positionAmt)) : 0;
    const internalQty = ledger[`${symbol}:${side}`] || 0;
    if (!exchangeQty && !internalQty) continue;
    const step = filters[symbol]?.stepSize || 0;
    const d = decimalsOf(step || 1e-8);
    const diff = Number((exchangeQty - internalQty).toFixed(Math.min(d, 12)));
    const mismatch = Math.abs(exchangeQty - internalQty) > step / 2 + 1e-12;
    rows.push({
      symbol, side, exchangeQty, internalQty, diff, diffText: `${diff > 0 ? '+' : ''}${diff}`,
      // an order in flight can make the ledger lag the exchange for a moment
      status: mismatch ? (pending.has(symbol) ? 'SYNCING' : 'MISMATCH') : 'OK',
      unattributedQty: diff > 0 ? diff : 0,
    });
  }
  const mismatches = rows.filter((r) => r.status === 'MISMATCH');
  return {
    ok: mismatches.length === 0, rows, mismatches,
    warnings: mismatches.map((r) => `${r.symbol.replace('USDT', '')} ${r.side} Exchange Qty ${r.exchangeQty} Internal ${r.internalQty} Diff ${r.diffText}`),
  };
}
