// Pre-pull rules pipeline. Each rule gets a context and returns one of:
//   { action: 'proceed', amountCents }   (may lower the amount, e.g. goal cap)
//   { action: 'defer', reason }          (try again on the next business day, up to deferMaxBusinessDays)
//   { action: 'skip', reason }           (this period is skipped for good; logged)
//   { action: 'hold', reason }           (nothing to do right now, e.g. goal covered by pending transfers)
// Add a rule with registerRule(name, fn, { before }) - no rebuild of the engine needed.
const rules = [];
export function registerRule(name, fn, { before } = {}) {
  const i = before ? rules.findIndex((r) => r.name === before) : -1;
  if (i >= 0) rules.splice(i, 0, { name, fn }); else rules.push({ name, fn });
}
export function listRules() { return rules.map((r) => r.name); }

// 1. Goal cap: never pull past the goal; the last pull is reduced. Pending transfers count toward the cap.
registerRule('goalCap', async (ctx) => {
  const remaining = ctx.goal.targetCents - ctx.totals.vaultCents - ctx.totals.pendingCents;
  if (remaining <= 0) return { action: 'hold', reason: 'Goal already covered by settled + pending deposits.' };
  return { action: 'proceed', amountCents: Math.min(ctx.amountCents, remaining) };
});

// 2. Overdraft protection: check the funding account's available balance before every pull.
registerRule('balanceBuffer', async (ctx) => {
  const { safety } = ctx.settings;
  let bal = null;
  try { bal = await ctx.getBalance(); } catch (e) { bal = { error: e.message }; }
  const unknown = !bal || bal.availableCents == null;
  if (unknown) {
    if (!safety.requireBalanceCheck) return { action: 'proceed', amountCents: ctx.amountCents, note: 'balance unavailable; check not required' };
    return { action: safety.onInsufficientFunds === 'skip' ? 'skip' : 'defer', reason: `Could not read available balance${bal?.error ? ` (${bal.error})` : ''}; not pulling blind.` };
  }
  const after = bal.availableCents - ctx.amountCents;
  if (after < safety.bufferCents) {
    return { action: safety.onInsufficientFunds === 'skip' ? 'skip' : 'defer',
      reason: `Available $${(bal.availableCents / 100).toFixed(2)} - pull $${(ctx.amountCents / 100).toFixed(2)} would leave less than the $${(safety.bufferCents / 100).toFixed(2)} safety buffer.`,
      availableCents: bal.availableCents };
  }
  return { action: 'proceed', amountCents: ctx.amountCents, availableCents: bal.availableCents };
});

export async function runRules(ctx) {
  const trace = [];
  let amountCents = ctx.amountCents;
  for (const r of rules) {
    const out = await r.fn({ ...ctx, amountCents });
    trace.push({ rule: r.name, ...out });
    if (out.action !== 'proceed') return { ...out, rule: r.name, trace };
    amountCents = out.amountCents;
  }
  return { action: 'proceed', amountCents, trace };
}
