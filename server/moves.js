// Monthly move (three banks): Varo (SSI lands, spending) -> Step (bridge only, kept at zero) -> Current (sealed savings).
// Each month the assistant (bot) asks to move money. The request is a PENDING APPROVAL. The user approves it in the app;
// the assistant reads the decision and does the move itself (today: by hand, outside this app), in three steps:
//   1. Varo -> Step: instant (Step pulls from the Varo debit card).
//   2. Step -> Current: may take 1-3 business days to arrive, but it leaves Step right away (Step goes back to zero).
//   3. The assistant confirms the money arrived in Current (on current.com, desktop web).
// After each step it records the bank's confirmation here. This app NEVER moves money for a monthly move: it only records
// the request, the user's decision and the confirmations. The user never opens Current; the assistant does.
// In the prototype, "Simulate completion" records fake confirmations so the whole loop can be tried.
// Go Blind: summaries contain "$X", which the usual blind scrubber turns into "[hidden]" for the user and the bot.
import { AppError } from './errors.js';
import { newId } from './crypto.js';

export const MOVE_DEFAULTS = { from: 'Varo', via: 'Step', to: 'Current' };
export const MOVE_MAX_CENTS = 500000; // $5,000 per move in the prototype (sanity limit, not advice)
export const MOVE_LEGS = [
  { id: 'varo_to_step', label: 'Varo → Step (instant)', note: 'Instant only: Step pulls from the Varo debit card. If instant is not offered that day, do not use a slower method; stop and tell the user.' },
  { id: 'step_to_current', label: 'Step → Current (may take 1-3 business days, but it leaves Step right away)', note: 'Send the whole amount on. Afterwards the Step balance should be zero.' },
  { id: 'arrival_confirmed', label: 'Assistant confirms arrival in Current', note: 'Check on current.com (desktop web) that the deposit arrived, then record it here.' },
];
export const STEP_ZERO_REMINDER = 'Step is only a bridge: its balance should be zero after step 2. If anything is left in Step, move it on to Current.';
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const cleanName = (v, d) => { const s = String(v ?? d).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40); return s || d; };
const cleanConf = (v) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);
const emptyLegs = () => MOVE_LEGS.map((l) => ({ id: l.id, status: 'pending', confirmation: null, at: null, by: null }));

export class MonthlyMoves {
  constructor(service) { this.svc = service; }
  get s() { return this.svc.s; }
  get list() { if (!Array.isArray(this.s.monthlyMoves)) this.s.monthlyMoves = []; return this.s.monthlyMoves; }
  find(id) { const m = this.list.find((x) => x.id === id || x.approvalId === id); if (!m) throw new AppError(404, 'not_found', 'No such monthly move.'); return m; }
  view(m) {
    const legs = (m.legs || emptyLegs()).map((l) => ({ ...l, label: MOVE_LEGS.find((x) => x.id === l.id)?.label, note: MOVE_LEGS.find((x) => x.id === l.id)?.note }));
    const next = ['approved', 'in_progress'].includes(m.status) ? legs.find((l) => l.status !== 'done')?.id || null : null;
    return { id: m.id, approvalId: m.approvalId, month: m.month, date: m.date, amountCents: m.amountCents, from: m.from, via: m.via, to: m.to,
      status: m.status, summary: m.summary, legs, nextLeg: next, stepBalanceCents: m.stepBalanceCents ?? null, stepBalanceZero: m.stepBalanceCents == null ? null : m.stepBalanceCents === 0,
      stepZeroReminder: STEP_ZERO_REMINDER, requestedBy: m.requestedBy, createdAt: m.createdAt, decidedAt: m.decidedAt || null, completedAt: m.completedAt || null, simulated: true };
  }

  defaultAmount() { return this.s.schedule?.amountCents > 0 ? this.s.schedule.amountCents : 10000; }
  defaultDate() { const t = this.svc.today(); const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 3); return d.toISOString().slice(0, 10); }

  /** Bot (or the sync inbox) proposes this month's move -> pending approval. One open request per month. */
  propose({ amountCents, date, from, via, to, reason } = {}, key) {
    const amt = amountCents === undefined ? this.defaultAmount() : amountCents;
    if (!Number.isInteger(amt) || amt <= 0 || amt > MOVE_MAX_CENTS) throw new AppError(400, 'bad_amount', `amountCents must be a whole number of cents between 1 and ${MOVE_MAX_CENTS}.`);
    const day = date === undefined ? this.defaultDate() : String(date);
    if (!ISO.test(day) || day < this.svc.today()) throw new AppError(400, 'bad_date', 'date must be YYYY-MM-DD, today or later.');
    const month = day.slice(0, 7);
    const open = this.list.find((m) => m.month === month && ['awaiting_approval', 'approved', 'in_progress', 'done'].includes(m.status));
    if (open) throw new AppError(409, 'already_requested', `There is already a monthly move for ${month} (${open.status}).`);
    const f = cleanName(from, MOVE_DEFAULTS.from), v = cleanName(via, MOVE_DEFAULTS.via), t = cleanName(to, MOVE_DEFAULTS.to);
    if (new Set([f, v, t].map((x) => x.toLowerCase())).size !== 3) throw new AppError(400, 'same_account', 'from, via and to must be three different banks.');
    const summary = `Monthly move: ${money(amt)} ${f} → ${v} (instant) → ${t} on ${day}`;
    const m = { id: newId('mv'), month, date: day, amountCents: amt, from: f, via: v, to: t, legs: emptyLegs(), status: 'awaiting_approval', summary,
      requestedBy: key.name, createdAt: new Date().toISOString() };
    const a = this.svc.createApproval({ type: 'monthly_move', payload: { moveId: m.id, amountCents: amt, date: day, from: f, via: v, to: t, legs: MOVE_LEGS.map((l) => l.label) },
      summary: summary + (reason ? ` (bot: ${String(reason).slice(0, 140)})` : ''), key });
    m.approvalId = a.id;
    this.list.unshift(m);
    return { move: this.view(m), approval: a };
  }
  /** Called by service.approve(): records the decision. No money moves here. */
  approved(a) {
    const m = this.find(a.payload.moveId);
    m.status = 'approved'; m.decidedAt = new Date().toISOString();
    this.svc.audit('monthly_move_approved', { id: m.id, month: m.month, date: m.date, from: m.from, via: m.via, to: m.to });
    return { ok: true, note: 'Approved. Your assistant does the three steps itself (Varo → Step instant, Step → Current, confirm arrival) and records each one here. This app does not move the money.' };
  }
  closed(a, status) {
    const m = this.list.find((x) => x.approvalId === a.id); if (!m || m.status !== 'awaiting_approval') return;
    m.status = status; m.decidedAt = new Date().toISOString();
    this.svc.audit(`monthly_move_${status}`, { id: m.id, month: m.month });
  }
  /** Record one step (in order) after the assistant did it; `leg` defaults to the next one. simulate = the prototype button
   * (fills every remaining step with fake confirmations). stepBalanceCents (optional, after step 2) checks Step is back to zero. */
  complete({ id, leg, confirmation, stepBalanceCents, simulate = false } = {}, by) {
    const m = this.find(id);
    if (!m.legs) m.legs = emptyLegs();
    if (m.status === 'done') throw new AppError(409, 'already_done', 'This monthly move is already complete.');
    if (!['approved', 'in_progress'].includes(m.status)) throw new AppError(409, 'not_approved', `Only an approved move can be recorded (this one is ${m.status}). The user approves it in the app first.`);
    const todo = m.legs.filter((l) => l.status !== 'done');
    const targets = simulate && !leg ? todo : [todo[0]];
    if (leg && leg !== todo[0].id) throw new AppError(409, 'wrong_order', `Do the steps in order. Next: ${MOVE_LEGS.find((x) => x.id === todo[0].id).label}.`);
    if (stepBalanceCents !== undefined && (!Number.isInteger(stepBalanceCents) || stepBalanceCents < 0)) throw new AppError(400, 'bad_step_balance', 'stepBalanceCents must be a whole number of cents, 0 or more.');
    const now = new Date().toISOString();
    for (const l of targets) {
      let conf = cleanConf(confirmation);
      if (simulate) conf = conf && targets.length === 1 ? conf : `SIM-${l.id === 'varo_to_step' ? 'INSTANT' : l.id === 'step_to_current' ? 'ACH' : 'ARRIVED'}-${newId('c').slice(-6).toUpperCase()}`;
      if (conf.length < 3) throw new AppError(400, 'confirmation_required', 'Give the confirmation number or note from the bank (3-80 characters).');
      Object.assign(l, { status: 'done', confirmation: conf, at: now, by, simulated: !!simulate });
      if (l.id === 'step_to_current') m.stepBalanceCents = stepBalanceCents ?? (simulate ? 0 : m.stepBalanceCents ?? null);
      this.svc.audit('monthly_move_step_done', { id: m.id, month: m.month, leg: l.id, by, simulated: !!simulate });
    }
    const done = m.legs.every((l) => l.status === 'done');
    m.status = done ? 'done' : 'in_progress';
    if (done) {
      m.completedAt = now;
      this.svc.audit('monthly_move_done', { id: m.id, month: m.month, by, simulated: !!simulate });
      this.svc.notify('monthly_move_done', 'Monthly move complete', `${m.from} → ${m.via} → ${m.to}: arrival in ${m.to} confirmed.`);
    }
    const v = this.view(m);
    return { move: v, ...(m.stepBalanceCents > 0 ? { warning: `${STEP_ZERO_REMINDER} Step still shows a balance.` } : {}) };
  }
}
