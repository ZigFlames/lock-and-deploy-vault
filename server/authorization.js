// ACH debit authorization text (Nacha-style recurring WEB debit authorization; sandbox wording).
// The exact text shown, its SHA-256 hash, the timestamp, IP and user agent are stored when accepted.
import { describeSchedule } from './schedule.js';
import { prettyDate } from './dates.js';
import { sha256 } from './crypto.js';

export const AUTH_TEXT_VERSION = 'ach-auth-v2-sandbox';
export const BENEFIT_ACK_VERSION = 'benefit-limit-v1';

export const BENEFIT_WARNING = [
  'SSI counts money in bank accounts as a resource. SSA lists the SSI resource limit as $2,000 for an individual and $3,000 for a couple, generally counted on the first moment of the month.',
  'A goal like $3,000 in a savings account could put you over the limit and affect SSI (and, in many states, Medicaid). Other programs (SNAP, Medicaid, housing) may have their own asset rules.',
  'An ABLE account may be an option for eligible people: SSA excludes up to $100,000 in an ABLE account from SSI resources. Starting January 1, 2026, ABLE eligibility covers disability that began before age 46.',
  'Spending the money on the goal (for example, the mattress) in the same month it is saved can matter. Verify with SSA (ssa.gov, 1-800-772-1213) or a benefits counselor. This is not legal or financial advice.',
];

const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function buildAuthorizationText({ signerName, funding, destination, schedule, goal, firstDate }) {
  const text = [
    'ACH DEBIT AUTHORIZATION. SANDBOX / TEST MODE: NO REAL MONEY WILL MOVE.',
    '',
    `I, ${signerName || '[your name]'}, authorize Lock & Deploy (a personal prototype) to initiate recurring ACH debit entries from my ${funding.institutionName} ${funding.name} account ending in ${funding.mask} ` +
      `and to deposit the same amounts to my ${destination.institutionName} ${destination.name} account ending in ${destination.mask}.`,
    `Amount and timing: ${describeSchedule(schedule)}. First debit on or after ${prettyDate(firstDate)}. If a date falls on a weekend or bank holiday, the debit is initiated on the next business day.`,
    `Debits stop automatically when ${money(goal.targetCents)} has settled for "${goal.name}". The final debit may be smaller so the goal is not exceeded. If I later confirm a "Roll Over & Relock" in the app, debits continue at the same amount and timing toward the new goal I confirm there.`,
    'Before each debit the app checks the available balance when the bank connection supports it and skips or delays the debit if it would leave less than my safety buffer.',
    'I can pause future debits at any time in the app. Pausing, revoking and the emergency stop only stop future debits: they never unlock or release money already saved. I can revoke this authorization at any time in the app (More > Log > Revoke authorization); revocation applies to debits not yet sent to the bank. A debit already sent may not be stoppable, but a still-pending transfer can be cancelled individually.',
    'If a debit is returned (for example, for insufficient funds), it will not be retried automatically.',
    'I will keep a copy of this authorization. It stays in effect until I revoke it or change the amount, timing or accounts, which requires a new authorization.',
  ].join('\n');
  return { version: AUTH_TEXT_VERSION, text, textHash: sha256(text) };
}
