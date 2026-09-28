// "Did you know?" milestone cards. Every settled $100 saved (cumulative settled deposits, all goal cycles) unlocks
// the next card: a general money tip plus an encouraging line, getting more advanced as savings grow.
// General information, not financial, legal or benefits advice. No invented numbers: the only figures used are the
// SSI resource limit for an individual ($2,000), the ABLE exclusion for SSI ($100,000), and the example goals.
// Pending money never unlocks a card. Cards stay unlocked once earned.
//
// Go Blind: amounts are written as {{PLACEHOLDERS}} so the blind view can render them in words (general facts, not
// the balance), and the blind view drops the card number and "$N saved" label so no total or milestone amount shows.
export const CARD_STEP_CENTS = 10000;
const AMOUNTS = {
  SSI_LIMIT: ['$2,000', 'two thousand dollars'],
  ABLE_CAP: ['$100,000', 'one hundred thousand dollars'],
  HOUSE_GOAL: ['$10,000', 'ten thousand dollars'],
};
const SSI = 'SSI reminder: countable resources must stay under {{SSI_LIMIT}} for an individual (all regular bank accounts together). Money in an ABLE account is not counted, up to {{ABLE_CAP}}.';
const NOTE = 'General information, not financial advice.';

// tier: basics (first steps), building (around the middle), next (bigger goals). ssi: shows the SSI reminder.
export const CARDS = [
  // ---- basics ----
  ['consistency', 'basics', 'Small and steady wins', 'Saving the same amount on a schedule beats waiting for a "big" month. Automatic deposits remove the daily decision.', 'Your first card. The habit has started.'],
  ['pay-yourself-first', 'basics', 'Pay yourself first', 'Move savings right after money arrives, before spending starts. That is what your deposit schedule does for you.', 'You paid yourself first. Keep it going.'],
  ['cash-advance-fees', 'basics', 'Cash advances cost money', 'Paycheck and cash-advance features (for example Varo Advance) can charge a fee each time you use them. Small fees add up. A small savings cushion can replace them.', 'Every deposit is a step away from paying fees to borrow your own money.'],
  ['on-time', 'basics', 'On time, every time', 'Paying bills by the due date avoids late fees, and on-time payment history is one of the most important parts of a credit score.', 'Steady saver, steady payer.'],
  ['autopay-minimum', 'basics', 'Autopay the minimum', 'Setting autopay for at least the minimum payment on each bill protects you from a missed due date. You can still pay more by hand.', 'Nice. Protect the progress you are making.'],
  ['overdraft', 'basics', 'Dodge overdraft fees', 'Low-balance alerts and a small buffer in checking help avoid overdraft and NSF fees. This app keeps a buffer before every deposit for the same reason.', 'You are building a buffer that works for you.'],
  ['subscriptions', 'basics', 'Check your subscriptions', 'Look at last month\'s statement for subscriptions you forgot about. Cancelling one you don\'t use is an instant raise.', 'Another card. You are on a roll.'],
  ['needs-wants', 'basics', 'Needs vs wants', 'Before a purchase, ask: need or want? Waiting a day on wants makes impulse buys easier to skip.', 'Your future self says thanks.'],
  ['ssi-basics', 'basics', 'Know your SSI limit', 'If you get SSI, SSA looks at your countable resources at the start of each month. Plan big savings with that in mind.', 'Saving smart, not just saving.', true],
  ['able-intro', 'basics', 'What is an ABLE account?', 'An ABLE account is a savings account for people whose disability began before a certain age. For SSI, ABLE money is treated differently from a regular bank account. NY ABLE is New York\'s program.', 'Ten cards in. That is real momentum.', true],
  // ---- building ----
  ['bank-apart', 'building', 'Out of sight, out of mind', 'Keeping savings at a different bank from everyday checking, with no debit card attached, makes impulse withdrawals harder.', 'Your lock is working.'],
  ['fee-free', 'building', 'Pick fee-free accounts', 'Look for savings accounts with no monthly fee and no minimum balance. Fees quietly eat savings.', 'Keep every dollar you save.'],
  ['credit-report', 'building', 'Check your credit reports', 'You can get free credit reports from the three bureaus at AnnualCreditReport.com. Look for mistakes and dispute errors with the bureau.', 'Knowledge is power. So is this progress.'],
  ['credit-builder', 'building', 'Rebuilding credit', 'Secured cards and credit-builder loans can help rebuild credit when used lightly and paid on time. Read the fees first.', 'You are building more than savings.'],
  ['utilization', 'building', 'Keep card balances low', 'Using only a small part of your credit limit, and paying it down each month, is better for your score than carrying a big balance.', 'Discipline pays.'],
  ['emergency-fund', 'building', 'Start an emergency fund', 'An emergency fund covers surprises (a phone, a bill, a trip to the doctor) so you don\'t need a cash advance or a card balance. Keep it separate from spending money.', 'Halfway-strong. Emergencies get smaller when you are ready for them.', true],
  ['emergency-where', 'building', 'Where to keep emergency money', 'Emergency money should be easy to reach in a real emergency but not tempting every day. If you get SSI, an ABLE account can hold it without counting toward the limit.', 'Ready for the unexpected.', true],
  ['debts-in-writing', 'building', 'Settle old debts in writing', 'If you settle an old debt, get the agreement in writing before you pay, keep copies, and ask for a letter confirming it is paid or settled.', 'Clearing the past, building the future.'],
  ['debt-time-limits', 'building', 'Old debts have rules', 'Debts can have legal time limits, and collectors must follow federal rules. Before paying a very old debt, free help (such as legal aid or a nonprofit credit counselor) can explain your rights.', 'Smart moves only.'],
  ['scams', 'building', 'Spot money scams', 'No real bank or agency asks you to pay with gift cards or to send a code they texted you. When in doubt, hang up and call the number on your card or the official website.', 'Protect what you have built.'],
  ['sinking-funds', 'building', 'Sinking funds', 'For known costs (a new phone, a mattress, holidays), save a little each month ahead of time instead of paying all at once.', 'Planning ahead looks good on you.'],
  ['raise-rule', 'building', 'Save part of every raise', 'When income goes up, send part of the increase to savings before you get used to spending it.', 'Level up.'],
  ['ssi-reporting', 'building', 'Report changes to SSA', 'If you get SSI, report changes in income, resources and living situation to SSA on time. It helps avoid overpayments you would have to pay back.', 'Staying on track with your benefits too.', true],
  ['able-uses', 'building', 'What ABLE money can pay for', 'ABLE withdrawals for qualified disability expenses (a broad list that includes things like housing, transportation, education and basic living expenses) are generally not counted by SSI. Housing has special timing rules, so check first.', 'You are learning the system. That is a superpower.', true],
  ['benefits-counselor', 'building', 'Free benefits counseling', 'Free work-incentive and benefits counseling (WIPA) can explain how savings, work and benefits fit together before you make big moves.', 'Asking questions is a strength.', true],
  // ---- next goals (bigger goals: always with the SSI reminder) ----
  ['next-goal', 'next', 'Set your next goal', 'You have proven you can do this. Pick the next goal and let Roll Over & Relock carry you there.', 'Goal-level saver. Seriously impressive.', true],
  ['house-goal', 'next', 'A home down payment', 'A goal like a {{HOUSE_GOAL}} house down payment is built the same way: automatic, steady deposits and a lock. Plan where that money will sit if you get SSI.', 'Dream bigger. You have the habit now.', true],
  ['sonyma', 'next', 'First-time homebuyer programs', 'New York\'s SONYMA (State of New York Mortgage Agency) has first-time homebuyer mortgage programs and down payment help. Eligibility rules apply; check the official NY Homes and Community Renewal website or a HUD-approved housing counselor.', 'Homeownership is a real path.', true],
  ['housing-counselor', 'next', 'HUD-approved housing counseling', 'HUD-approved housing counselors offer free or low-cost help with budgeting, credit and homebuying steps. Many homebuyer programs ask for a homebuyer class.', 'Building knowledge for the big one.', true],
  ['able-for-big-goals', 'next', 'Keep big goals SSI-safe', 'Saving for a bigger goal in a regular account can push you over the SSI limit. An ABLE account is the usual way to save more while staying SSI-safe.', 'Big goals, protected.', true],
  ['home-and-ssi', 'next', 'Your home and SSI', 'For SSI, the home you live in is generally not counted as a resource, but the savings you build up to buy it can be. Plan the timing with SSA or a benefits counselor.', 'Thinking ahead like a pro.', true],
  ['mortgage-readiness', 'next', 'Getting mortgage-ready', 'Lenders look at credit history, steady income and debts. On-time payments and low balances today make that picture stronger later.', 'Every deposit counts toward that future.', true],
  ['compare-lenders', 'next', 'Compare offers', 'When you borrow for something big, compare offers from more than one lender and read the fees, not just the monthly payment.', 'Savvy.', true],
  ['estate-basics', 'next', 'ABLE and the future', 'ABLE accounts have their own rules about what happens to the money later. Read your plan\'s documents so there are no surprises.', 'Planning for the long run.', true],
  ['retirement-basics', 'next', 'Think long term', 'Once short-term goals are covered, long-term saving matters too. Ask how any retirement account would affect SSI before opening one.', 'Long-term thinker.', true],
  ['protect-identity', 'next', 'Guard your identity', 'Freezing your credit at the three bureaus is free and blocks new accounts in your name. You can lift it when you apply for credit.', 'Protected and progressing.', true],
  ['insurance-basics', 'next', 'Protect the basics', 'Renters insurance is often inexpensive and can protect your belongings. Get quotes before you need it.', 'You are covering all the bases.', true],
  ['teach-someone', 'next', 'Pass it on', 'Teaching someone what you learned (pay yourself first, lock it, automate it) is one of the best ways to keep the habit yourself.', 'You are an example now.', true],
  ['review-yearly', 'next', 'Yearly money check-up', 'Once a year, review accounts, fees, credit reports and your SSI/ABLE situation. Small fixes add up.', 'Consistent all year long.', true],
  ['all-cards', 'next', 'Collection complete', 'You unlocked every card. Keep going: set the next goal, keep the lock, and keep your savings SSI-safe.', 'Legend status. Proud of you.', true],
].map(([id, tier, title, tip, cheer, ssi = false], i) => ({ n: i + 1, id, tier, title, tip, cheer, ssi: ssi || tier === 'next' }));

const fill = (s, blind) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => AMOUNTS[k][blind ? 1 : 0]);
export const cardAtCents = (n) => n * CARD_STEP_CENTS;

/** Text of one card. blind=true: no card number, no amount label, general amounts written in words. */
export function renderCard(c, { blind = false } = {}) {
  const base = { id: c.id, tier: c.tier, title: c.title, tip: fill(c.tip, blind), cheer: c.cheer, ssiReminder: c.ssi ? fill(SSI, blind) : null, note: NOTE };
  return blind ? { ...base, heading: 'New milestone unlocked' } : { ...base, n: c.n, heading: `Card ${c.n} · ${fill(`$${(cardAtCents(c.n) / 100).toLocaleString('en-US')}`, false)} saved`, atCents: cardAtCents(c.n) };
}

export const emptyCards = () => ({ unlocked: [] }); // [{ id, n, unlockedAt, clockDate, seenAt }]

// ---------- "Speed up" cards: computed live from the real plan (never hard-coded) ----------
// Inputs: goal target, settled + pending totals, the deposit amount and schedule dates (nextPullDates).
// Blind: no dollar amounts at all, not even deposit sizes: "double / triple your deposit", time differences and dates.
export const HOUSE_EXAMPLE_CENTS = 1000000;
const SSI_LIMIT_CENTS = 200000;
const MULTIPLIERS = [[2, 'double'], [3, 'triple']];
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const monthYear = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const perLabel = (s) => ({ weekly: '/week', biweekly: ' every 2 weeks', monthly: '/month', benefit: '/month' }[s.frequency] || ' per deposit');
const dayDiff = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
export function sooner(days) {
  if (days <= 0) return 'about the same time';
  if (days >= 60) { const m = Math.round(days / 30.44); return `about ${m} month${m === 1 ? '' : 's'} sooner`; }
  if (days >= 14) { const w = Math.round(days / 7); return `about ${w} weeks sooner`; }
  return `about ${days} day${days === 1 ? '' : 's'} sooner`;
}

/**
 * @param {{goal, totals, schedule, datesFrom: (n:number)=>string[], blind:boolean}} p  datesFrom(n) = the next n deposit dates.
 * @returns {{cards: object[], reason: string|null}}
 */
export function speedUpCards({ goal, totals, schedule, datesFrom, blind = false }) {
  const s = schedule;
  if (!goal || goal.status !== 'saving') return { cards: [], reason: goal ? 'goal_reached' : 'no_goal' };
  if (!s || !['active', 'paused', 'needs_authorization'].includes(s.status) || !(s.amountCents > 0)) return { cards: [], reason: 'no_schedule' };
  const amt = s.amountCents;
  const saved = totals.vaultCents + totals.pendingCents;
  const remaining = Math.max(0, goal.targetCents - saved);
  if (!remaining) return { cards: [], reason: 'goal_covered' };
  const finishFor = (perDeposit, need) => { const n = Math.ceil(need / perDeposit); return n > 1200 ? null : datesFrom(n).at(-1) || null; };
  const base = finishFor(amt, remaining);
  const cards = [];
  const ssiReminder = (blind || goal.targetCents > SSI_LIMIT_CENTS) ? fill(SSI, blind) : null;
  for (const [m, word] of MULTIPLIERS) {
    const f = finishFor(amt * m, remaining);
    if (!base || !f) continue;
    const diff = dayDiff(f, base);
    cards.push({ id: `speedup-x${m}`, kind: 'speed_up', multiplier: m,
      title: blind ? `Speed up: ${word} your deposit` : `Speed up: ${usd(amt * m)}${perLabel(s)}`,
      tip: blind ? `${word[0].toUpperCase()}${word.slice(1)} your deposit and you'd reach your goal ${sooner(diff)} (around ${monthYear(f)} instead of ${monthYear(base)}).`
        : `Raise your deposit from ${usd(amt)} to ${usd(amt * m)}${perLabel(s)} and you'd reach your ${usd(goal.targetCents)} goal ${sooner(diff)} (around ${monthYear(f)} instead of ${monthYear(base)}).`,
      finishOn: f, currentFinishOn: base, soonerDays: diff, ssiReminder, note: 'Projection from your current plan and settled balance. Deposits that are deferred, skipped or returned push dates back.',
      action: { kind: 'raise_deposit', multiplier: m, label: blind ? `${word[0].toUpperCase()}${word.slice(1)} my deposit` : `Raise to ${usd(amt * m)}${perLabel(s)}`, note: 'Raising the deposit needs a new ACH authorization. Deposits can only go up from here, never down, through this button.' } });
  }
  const houseNeed = HOUSE_EXAMPLE_CENTS - saved;
  if (houseNeed > 0) {
    const at1 = finishFor(amt, houseNeed), at2 = finishFor(amt * 2, houseNeed);
    if (at1) cards.push({ id: 'pace-house', kind: 'long_range', title: 'At this pace',
      tip: blind ? `At your current pace you'd reach a ${AMOUNTS.HOUSE_GOAL[1]} home down payment goal around ${monthYear(at1)}${at2 ? `, or around ${monthYear(at2)} if you doubled your deposit` : ''}.`
        : `At ${usd(amt)}${perLabel(s)} you'd reach ${usd(HOUSE_EXAMPLE_CENTS)} (a home down payment goal) around ${monthYear(at1)}${at2 ? `, or around ${monthYear(at2)} at ${usd(amt * 2)}${perLabel(s)}` : ''}.`,
      finishOn: at1, ssiReminder: fill(SSI, blind), note: 'A long-range example, not a plan. Above the SSI limit, keep savings in an ABLE account if you get SSI.' });
  }
  return { cards, reason: null };
}
