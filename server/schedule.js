// Pull-date math. All pulls land on ACH business days.
import { addDays, dayOfMonthDate, nthWeekday, parse, nextBusinessDay, prevBusinessDay, diffDays, isValidDate, prettyDate } from './dates.js';

export const FREQUENCIES = {
  benefit: 'After my benefit payment arrives',
  monthly: 'Monthly on a set day',
  biweekly: 'Every 2 weeks',
  weekly: 'Every week',
};

// When benefits arrive (SSA schedule rules; verify your own deposit date with SSA / your bank).
export const BENEFIT_TYPES = {
  ssi: 'SSI: 1st of the month (earlier business day if the 1st is a weekend/holiday)',
  ssdi_3rd: 'SS/SSDI: the 3rd of the month',
  ssdi_wed2: 'SS/SSDI: 2nd Wednesday (birthday 1st-10th)',
  ssdi_wed3: 'SS/SSDI: 3rd Wednesday (birthday 11th-20th)',
  ssdi_wed4: 'SS/SSDI: 4th Wednesday (birthday 21st-31st)',
  custom: 'Other: a fixed day of the month',
};

/** Date the benefit is expected to arrive in month (y, m0). */
export function benefitDate(y, m0, s) {
  switch (s.benefitType) {
    case 'ssi': return prevBusinessDay(dayOfMonthDate(y, m0, 1));
    case 'ssdi_3rd': return prevBusinessDay(dayOfMonthDate(y, m0, 3));
    case 'ssdi_wed2': return prevBusinessDay(nthWeekday(y, m0, 3, 2));
    case 'ssdi_wed3': return prevBusinessDay(nthWeekday(y, m0, 3, 3));
    case 'ssdi_wed4': return prevBusinessDay(nthWeekday(y, m0, 3, 4));
    default: return prevBusinessDay(dayOfMonthDate(y, m0, s.benefitDay || 1));
  }
}

/** Raw (calendar) occurrences in [from, to], before business-day adjustment. */
function rawOccurrences(s, from, to) {
  const out = [];
  const f = parse(from);
  if (s.frequency === 'weekly' || s.frequency === 'biweekly') {
    const step = s.frequency === 'weekly' ? 7 : 14;
    let d = s.anchorDate;
    const gap = diffDays(d, from);
    if (gap > 0) d = addDays(d, Math.ceil(gap / step) * step);
    for (; d <= to; d = addDays(d, step)) out.push(d);
    return out;
  }
  for (let i = -1; i < 400; i++) {
    const y = f.getUTCFullYear(), m0 = f.getUTCMonth() + i;
    const d = s.frequency === 'monthly'
      ? dayOfMonthDate(y, m0, s.dayOfMonth)
      : addDays(benefitDate(y + Math.floor(m0 / 12), ((m0 % 12) + 12) % 12, s), Number(s.offsetDays) || 0);
    if (d > addDays(to, 10)) break;
    out.push(d);
  }
  return out;
}

/** Business-day pull dates within [from, to]. */
export function pullDates(s, from, to) {
  const seen = new Set();
  const out = [];
  for (const raw of rawOccurrences(s, addDays(from, -10), to)) {
    const d = nextBusinessDay(raw);
    if (d >= from && d <= to && !seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out.sort();
}

export const nextPullDates = (s, from, n = 4) => pullDates(s, from, addDays(from, 400)).slice(0, n);

export function describeSchedule(s) {
  if (!s) return 'No schedule';
  const amt = `$${(s.amountCents / 100).toFixed(2)}`;
  switch (s.frequency) {
    case 'weekly': return `${amt} every week starting ${prettyDate(s.anchorDate)}`;
    case 'biweekly': return `${amt} every 2 weeks starting ${prettyDate(s.anchorDate)}`;
    case 'monthly': return `${amt} monthly on day ${s.dayOfMonth}`;
    case 'benefit': {
      const off = Number(s.offsetDays) || 0;
      const when = off === 0 ? 'on the day' : `${off} day${off === 1 ? '' : 's'} after`;
      return `${amt} ${when} my benefit arrives (${BENEFIT_TYPES[s.benefitType] || 'custom'}${s.benefitType === 'custom' ? `, day ${s.benefitDay}` : ''})`;
    }
    default: return amt;
  }
}

export function validateSchedule(s) {
  const e = [];
  if (!Number.isInteger(s.amountCents) || s.amountCents < 100) e.push('Amount must be at least $1.00.');
  if (s.amountCents > 500000) e.push('Amount above $5,000 per pull is not allowed in this prototype.');
  if (!FREQUENCIES[s.frequency]) e.push('Choose a frequency.');
  if ((s.frequency === 'weekly' || s.frequency === 'biweekly') && !isValidDate(s.anchorDate)) e.push('Pick a start date.');
  if (s.frequency === 'monthly' && !(s.dayOfMonth >= 1 && s.dayOfMonth <= 31)) e.push('Day of month must be 1-31.');
  if (s.frequency === 'benefit') {
    if (!BENEFIT_TYPES[s.benefitType]) e.push('Choose when your benefit arrives.');
    if (s.benefitType === 'custom' && !(s.benefitDay >= 1 && s.benefitDay <= 31)) e.push('Benefit day must be 1-31.');
    if (!(s.offsetDays >= 0 && s.offsetDays <= 10)) e.push('Days after benefit must be 0-10.');
  }
  return e;
}
