// Date helpers on 'YYYY-MM-DD' strings (UTC math, no time zones involved).
export const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const fmt = (dt) => dt.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
export const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
export const dow = (s) => parse(s).getUTCDay(); // 0 Sun .. 6 Sat
export const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
export function dayOfMonthDate(y, m0, day) {
  const yy = y + Math.floor(m0 / 12), mm = ((m0 % 12) + 12) % 12;
  return fmt(new Date(Date.UTC(yy, mm, Math.min(day, daysInMonth(yy, mm)))));
}
export function nthWeekday(y, m0, weekday, n) { // n>=1; n=-1 => last
  if (n === -1) { let d = dayOfMonthDate(y, m0, 31); while (dow(d) !== weekday) d = addDays(d, -1); return d; }
  let d = dayOfMonthDate(y, m0, 1); while (dow(d) !== weekday) d = addDays(d, 1); return addDays(d, 7 * (n - 1));
}
export const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fmt(parse(s)) === s;

// Federal Reserve holidays (ACH does not settle on these). Fed rule: Sunday holidays are observed Monday;
// Saturday holidays are NOT moved to Friday (Fed is open that Friday).
const holidayCache = new Map();
export function fedHolidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const fixed = [[0, 1], [5, 19], [6, 4], [10, 11], [11, 25]].map(([m, d]) => {
    let s = dayOfMonthDate(y, m, d); if (dow(s) === 0) s = addDays(s, 1); return s;
  });
  const set = new Set([
    ...fixed,
    nthWeekday(y, 0, 1, 3),  // MLK Day
    nthWeekday(y, 1, 1, 3),  // Presidents Day
    nthWeekday(y, 4, 1, -1), // Memorial Day
    nthWeekday(y, 8, 1, 1),  // Labor Day
    nthWeekday(y, 9, 1, 2),  // Columbus / Indigenous Peoples' Day
    nthWeekday(y, 10, 4, 4), // Thanksgiving
  ]);
  holidayCache.set(y, set);
  return set;
}
export const isBusinessDay = (s) => { const w = dow(s); return w !== 0 && w !== 6 && !fedHolidays(parse(s).getUTCFullYear()).has(s); };
export const nextBusinessDay = (s) => { let d = s; while (!isBusinessDay(d)) d = addDays(d, 1); return d; };
export const prevBusinessDay = (s) => { let d = s; while (!isBusinessDay(d)) d = addDays(d, -1); return d; };
export function addBusinessDays(s, n) { let d = s; let k = 0; while (k < n) { d = addDays(d, 1); if (isBusinessDay(d)) k++; } return d; }
export const prettyDate = (s) => s ? parse(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
