// Trading session abstraction.
//   CRYPTO_24_7        : signal day = UTC daily candle
//   US_REGULAR_MARKET  : signal day = NYSE regular session 09:30–16:00 America/New_York (13:00 on early closes)
// DST is handled via Intl (America/New_York). Holidays / early closes come from config (editable).

const NY = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: NY, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });

// NYSE full-day closures and 13:00 ET early closes (NYSE Group calendar).
export const DEFAULT_US_CALENDAR = {
  holidays: [
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  ],
  earlyCloses: ['2026-11-27', '2026-12-24', '2027-11-26'],
  open: '09:30', close: '16:00', earlyClose: '13:00',
};

export function nyParts(ts) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, weekday: p.weekday, day: `${p.year}-${p.month}-${p.day}` };
}

// New York wall-clock -> UTC ms
export function nyToUtc(day, hhmm) {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target + 5 * 3600_000;
  for (let i = 0; i < 3; i++) {
    const p = nyParts(guess);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    guess += target - seen;
  }
  return guess;
}

const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// Session for a NY calendar day, or null (weekend / holiday).
export function usSession(day, cal = DEFAULT_US_CALENDAR) {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6 || cal.holidays.includes(day)) return null;
  const early = cal.earlyCloses.includes(day);
  return { day, open: nyToUtc(day, cal.open), close: nyToUtc(day, early ? cal.earlyClose : cal.close), early };
}

export function marketStatus(now = Date.now(), cal = DEFAULT_US_CALENDAR) {
  const today = nyParts(now).day;
  const s = usSession(today, cal);
  const open = !!s && now >= s.open && now < s.close;
  let next = null;
  for (let i = 0; i < 10 && !next; i++) {
    const c = usSession(addDays(today, i), cal);
    if (c && c.open > now) next = c;
  }
  return { underlying: open ? 'OPEN' : 'CLOSED', session: s, nextOpen: next?.open ?? null, closesAt: open ? s.close : null, nyTime: nyParts(now) };
}

// Sessions whose close is in (fromTs, toTs], ascending.
export function sessionsBetween(fromTs, toTs, cal = DEFAULT_US_CALENDAR) {
  const out = [];
  let day = nyParts(fromTs - 86_400_000).day;
  const end = nyParts(toTs).day;
  for (let i = 0; i < 4000 && day <= end; i++, day = addDays(day, 1)) {
    const s = usSession(day, cal);
    if (s && s.close > fromTs && s.close <= toTs) out.push(s);
  }
  return out;
}

// Aggregate intraday bars (openTime t, closeTime T) into one session candle. Returns null if no bars.
export function buildSessionCandle(session, bars) {
  const inside = bars.filter((b) => b.t >= session.open && b.t < session.close).sort((a, b) => a.t - b.t);
  if (!inside.length) return null;
  return {
    t: session.open, T: session.close, day: session.day,
    o: inside[0].o, h: Math.max(...inside.map((b) => b.h)), l: Math.min(...inside.map((b) => b.l)), c: inside[inside.length - 1].c,
    v: inside.reduce((s, b) => s + b.v, 0), bars: inside.length,
  };
}
