// "Go Blind": hide every money amount from the user (and the AI bot) while saving.
// Redaction is done on the server side of the API (and in the shared service for the browser demo), so the UI
// never receives the numbers: amounts become null, and money-looking text becomes "[hidden]".
// Kept visible: goal names, statuses, dates, approvals, emergency controls, and the goal-reached event.

export const HIDDEN = '[hidden]';
export const BLIND_MAX_FAILURES = 5;
export const BLIND_LOCKOUT_MS = 15 * 60_000;

// Keys whose values are money or reveal progress toward the goal.
const MONEY_KEY = /Cents$|^(progress\w*|pullsNeeded|projectedFinish\w*|percentSaved)$/;
// "$1,234.56", "-$5", "$ 20", "1,500.00", "12.50", "80%" (the last one only when attached to a number).
const MONEY_TEXT = [/[-−]?\$\s?\d[\d,]*(?:\.\d+)?/g, /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, /\b\d+\.\d{2}\b(?![\d:-])/g, /\b\d+(?:\.\d+)?\s?%/g];

export function redactText(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const re of MONEY_TEXT) out = out.replace(re, HIDDEN);
  return out;
}

/** Deep copy with every money value nulled and money text replaced. `skip` = top-level keys left untouched. */
export function redactDeep(value, { skip = [] } = {}, depth = 0) {
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, {}, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (depth === 0 && skip.includes(k)) { out[k] = v; continue; }
      out[k] = MONEY_KEY.test(k) ? null : redactDeep(v, {}, depth + 1);
    }
    return out;
  }
  return typeof value === 'string' ? redactText(value) : value;
}

export const emptyBlind = () => ({ on: false, stayUntilGoal: false, stayGoalId: null, enabledAt: null, enabledBy: null, failures: [], lockedUntil: null, passcodeHash: null });

export const BENEFITS_MESSAGES = {
  near: 'Your savings are getting close to the SSI resource limit. Consider an ABLE account or talk to SSA.',
  over: 'Your savings may be at or over the SSI resource limit. Consider an ABLE account or talk to SSA soon.',
};
