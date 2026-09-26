// Go Blind: hide every amount (UI + bot), passcode-only off with a lockout, "stay blind until goal",
// bot redaction/refusal, and the benefits (SSI) guard that stays visible while blind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, setupActive, advanceUntil, TEST_PASSCODE } from './helpers.js';
import { redactText, redactDeep, HIDDEN } from '../server/blind.js';

const SIM = { SIM_DATE: '2026-10-05' };
const ALL = ['read', 'propose', 'pause', 'request'];
const MONEY_JSON = /"[A-Za-z]*Cents"\s*:\s*-?\d|\$\s?\d|"(progress\w*|percentSaved)"\s*:\s*\d/;
const newKey = async (call, scopes = ALL) => (await call('/api/bot-keys', { name: 'Grok', scopes })).data;
const audits = async (h) => (await h.call('/api/state')).data.audit.map((a) => a.type);

test('redactText / redactDeep hide money text and amount fields but keep statuses and dates', () => {
  assert.equal(redactText('Deposit $500.00 on 2026-10-09 (25%)'), `Deposit ${HIDDEN} on 2026-10-09 (${HIDDEN})`);
  assert.equal(redactText('Saved 1,500 of 3000.00'), `Saved ${HIDDEN} of ${HIDDEN}`);
  const r = redactDeep({ vaultCents: 1, goal: { name: 'Car', status: 'saving', targetCents: 300000, progressSettled: 0.5, releaseDate: '2027-01-01' }, list: [{ amountCents: 5, date: '2026-10-09', summary: 'Raise to $4,000.00' }] });
  assert.equal(r.vaultCents, null); assert.equal(r.goal.targetCents, null); assert.equal(r.goal.progressSettled, null);
  assert.equal(r.goal.status, 'saving'); assert.equal(r.goal.releaseDate, '2027-01-01'); assert.equal(r.list[0].date, '2026-10-09');
  assert.equal(r.list[0].summary, `Raise to ${HIDDEN}`);
});

test('Go Blind on: confirm required; state hides every amount; off with the app passcode; key events logged', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  await setupActive(h.call, { amountCents: 50000 });
  await advanceUntil(h.call, (x) => x.totals.vaultCents >= 50000, 20);
  assert.equal((await h.call('/api/blind/on', {})).status, 400, 'confirm required');
  let r = await h.call('/api/blind/on', { confirm: true });
  assert.equal(r.status, 200); assert.equal(r.data.on, true); assert.equal(r.data.redacted, true); assert.equal(r.data.needsPasscodeSetup, false);
  const st = (await h.call('/api/state')).data;
  const json = JSON.stringify(st);
  assert.ok(!MONEY_JSON.test(json), `no amounts in /api/state: ${json.match(MONEY_JSON)?.[0]}`);
  assert.equal(st.totals.vaultCents, null); assert.equal(st.goal.targetCents, null);
  assert.equal(st.goal.status, 'saving'); assert.equal(st.goal.name.length > 0, true, 'goal name kept');
  assert.equal(st.schedule.status, 'active', 'deposit status kept'); assert.match(st.schedule.nextPulls[0].date || st.schedule.nextPulls[0], /\d{4}-\d{2}-\d{2}/, 'next deposit date kept');
  assert.equal(st.blind.on, true);
  for (const p of ['/api/transfers', '/api/settings']) { const x = await h.call(p); if (x.status === 200) assert.ok(!MONEY_JSON.test(JSON.stringify(x.data)), p); }
  assert.equal((await h.call('/api/sandbox/reset', { confirm: true })).status, 423, 'reset cannot be used to escape Go Blind');
  // Pause / resume / emergency stop still work while blind.
  assert.equal((await h.call('/api/schedule/pause', {})).status, 200);
  assert.equal((await h.call('/api/schedule/resume', {})).status, 200);
  r = await h.call('/api/blind/off', { passcode: 'nope-nope' });
  assert.equal(r.status, 401); assert.equal(r.data.triesLeft, 4);
  r = await h.call('/api/blind/off', { passcode: TEST_PASSCODE });
  assert.equal(r.status, 200); assert.equal(r.data.on, false);
  assert.ok((await h.call('/api/state')).data.totals.vaultCents >= 50000, 'amounts visible again');
  const types = await audits(h);
  for (const k of ['blind_on', 'blind_off_failed', 'blind_off']) assert.ok(types.includes(k), k);
});

test('wrong passcode: 5 tries then a 15-minute lockout (even the right passcode is refused), logged', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  let now = Date.now(); h.app.service.nowMs = () => now;
  await h.call('/api/blind/on', { confirm: true });
  for (let i = 1; i <= 4; i++) { const r = await h.call('/api/blind/off', { passcode: `wrong-${i}` }); assert.equal(r.status, 401); assert.equal(r.data.triesLeft, 5 - i); }
  let r = await h.call('/api/blind/off', { passcode: 'wrong-5' });
  assert.equal(r.status, 429); assert.equal(r.data.error, 'blind_locked_out'); assert.ok(r.data.lockedUntil);
  r = await h.call('/api/blind/off', { passcode: TEST_PASSCODE });
  assert.equal(r.status, 429, 'right passcode refused during lockout');
  assert.ok((await h.call('/api/blind')).data.lockedUntil);
  now += 14 * 60_000; assert.equal((await h.call('/api/blind/off', { passcode: TEST_PASSCODE })).status, 429, 'still locked at 14 min');
  now += 2 * 60_000; r = await h.call('/api/blind/off', { passcode: TEST_PASSCODE });
  assert.equal(r.status, 200, 'unlocked after 15 min'); assert.equal(r.data.on, false);
  const types = await audits(h);
  assert.equal(types.filter((x) => x === 'blind_off_failed').length, 5); assert.ok(types.includes('blind_off_lockout')); assert.ok(types.includes('blind_off_refused'));
});

test('stay blind until goal: no passcode override, cannot be removed, ends when the vault unlocks (unlock still shows)', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  await setupActive(h.call, { amountCents: 50000 });
  // Turning on without stay, then ADDING stay mid-goal is allowed (tighten only).
  await h.call('/api/blind/on', { confirm: true });
  let r = await h.call('/api/blind/on', { confirm: true, stayUntilGoal: true });
  assert.equal(r.status, 200); assert.equal(r.data.stayUntilGoal, true);
  r = await h.call('/api/blind/on', { confirm: true, stayUntilGoal: false });
  assert.equal(r.status, 423); assert.equal(r.data.error, 'lock_loosening_blocked');
  r = await h.call('/api/blind/off', { passcode: TEST_PASSCODE });
  assert.equal(r.status, 423); assert.equal(r.data.error, 'blind_until_goal', 'right passcode does not override');
  // Settings cannot sneak amounts out either.
  const st0 = (await h.call('/api/state')).data; assert.equal(st0.blind.stayUntilGoal, true);
  const st = await advanceUntil(h.call, (x) => x.goal.status === 'unlocked', 80);
  assert.equal(st.goal.status, 'unlocked');
  assert.equal(st.blind.on, true); assert.equal(st.blind.redacted, false, 'after unlock amounts may show for withdrawal/rollover');
  assert.equal(st.totals.vaultCents, 300000);
  assert.ok(st.notifications.some((n) => n.type === 'goal_reached'), 'milestone banner shows');
  r = await h.call('/api/blind/off', { passcode: TEST_PASSCODE });
  assert.equal(r.status, 200); assert.equal(r.data.on, false);
  const types = await audits(h);
  for (const k of ['blind_stay_until_goal_added', 'lock_loosening_refused', 'blind_off_refused', 'blind_off']) assert.ok(types.includes(k), k);
});

test('bot: responses redacted with blindMode:true; bot can turn blind ON but never OFF, never choose stay, never read amounts', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  await setupActive(h.call, { amountCents: 50000 });
  await advanceUntil(h.call, (x) => x.totals.vaultCents >= 50000, 20);
  const k = await newKey(h.call); const bot = h.bot(k.key);
  let r = await bot('/bot/v1/status');
  assert.equal(r.data.blindMode, false); assert.ok(r.data.balances.settledLockedCents >= 50000, 'amounts visible before blind');
  assert.equal((await bot('/bot/v1/blind/on', { stayUntilGoal: true })).status, 403, 'bot cannot choose stay-until-goal');
  r = await bot('/bot/v1/blind/on', {});
  assert.equal(r.status, 200); assert.equal(r.data.blindMode, true); assert.equal(r.data.blind.on, true);
  for (const p of ['/bot/v1/status', '/bot/v1/goals', '/bot/v1/transfers', '/bot/v1/schedule', '/bot/v1/approvals', '/bot/v1/activity']) {
    r = await bot(p);
    assert.equal(r.status, 200, p); assert.equal(r.data.blindMode, true, p);
    assert.ok(!MONEY_JSON.test(JSON.stringify(r.data)), `${p} leaks: ${JSON.stringify(r.data).match(MONEY_JSON)?.[0]}`);
  }
  r = await bot('/bot/v1/status');
  assert.equal(r.data.balances.settledLockedCents, null); assert.equal(r.data.goal.targetCents, null);
  assert.equal(r.data.goal.status, 'saving'); assert.equal(r.data.goalReached, false); assert.equal(r.data.schedule.status, 'active');
  assert.match(r.data.today, /^\d{4}-\d{2}-\d{2}$/, 'dates still visible');
  r = await bot('/bot/v1/blind/off', {});
  assert.equal(r.status, 403); assert.equal(r.data.error, 'forbidden_for_bot'); assert.equal(r.data.blindMode, true);
  for (const type of ['blind_off', 'reveal_amounts', 'remove_stay_blind']) {
    r = await bot('/bot/v1/requests', { type, payload: {} });
    assert.equal(r.status, 403, type); assert.equal(r.data.error, 'forbidden_for_bot', type);
  }
  // Bot cannot use settings / proposals to learn or change the benefits guard.
  r = await bot('/bot/v1/goals/propose', { targetCents: 400000, reason: 'bigger' });
  assert.ok(!MONEY_JSON.test(JSON.stringify(r.data)), 'proposal echo redacted');
  assert.equal((await h.call('/api/blind')).data.on, true, 'still on');
  const st = (await h.call('/api/state')).data;
  assert.ok(st.audit.some((a) => a.type === 'blind_on' && a.detail?.by === 'bot'));
  assert.ok(st.audit.some((a) => a.type === 'bot_forbidden_request' && a.detail?.type === 'blind_off'));
});

test('bot sees goalReached once the vault unlocks while blind', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  await setupActive(h.call, { amountCents: 50000 });
  const k = await newKey(h.call); const bot = h.bot(k.key);
  await bot('/bot/v1/blind/on', {});
  await advanceUntil(h.call, (x) => x.goal.status === 'unlocked', 80);
  const r = await bot('/bot/v1/status');
  assert.equal(r.data.goalReached, true); assert.equal(r.data.goal.status, 'unlocked'); assert.equal(r.data.blindMode, true);
  assert.equal(r.data.balances.settledLockedCents, null, 'bot still never gets amounts while blind is on');
});

test('benefits guard: SSI alert (near / over) is non-numeric and shows while blind; bots cannot change it', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  await setupActive(h.call, { amountCents: 50000 });
  assert.equal((await h.call('/api/settings', { benefits: { receivesSSI: true, resourceLimitCents: 250000, warnAtPercent: 80 } })).status, 200);
  assert.equal((await h.call('/api/settings', { benefits: { warnAtPercent: 20 } })).status, 400, 'warn % validated');
  await h.call('/api/blind/on', { confirm: true });
  let st = (await h.call('/api/state')).data;
  assert.equal(st.benefitsAlert, null, 'no alert at $0');
  st = await advanceUntil(h.call, () => h.app.service.totals().vaultCents >= 200000, 40);
  assert.equal(h.app.service.totals().vaultCents, 200000);
  assert.equal(st.benefitsAlert.level, 'near');
  assert.match(st.benefitsAlert.message, /getting close to the SSI resource limit\. Consider an ABLE account or talk to SSA\./);
  assert.ok(!/\d/.test(st.benefitsAlert.message), 'alert has no numbers');
  assert.ok(!MONEY_JSON.test(JSON.stringify(st)));
  st = await advanceUntil(h.call, () => h.app.service.totals().vaultCents >= 250000, 40);
  assert.equal(st.benefitsAlert.level, 'over'); assert.ok(!/\d/.test(st.benefitsAlert.message));
  const k = await newKey(h.call); const bot = h.bot(k.key);
  const r = await bot('/bot/v1/status'); assert.equal(r.data.benefitsAlert, 'over');
  const b = await bot('/bot/v1/requests', { type: 'change_setting', payload: { benefits: { receivesSSI: false } } });
  assert.notEqual(b.status, 200);
  // Pending deposits do not count toward the alert (settled only).
  await h.call('/api/settings', { benefits: { receivesSSI: false } });
  assert.equal((await h.call('/api/state')).data.benefitsAlert, null);
});

test('stay blind until goal chosen at turn-on (fresh app, default goal) blocks off even with the right passcode', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  const r = await h.call('/api/blind/on', { confirm: true, stayUntilGoal: true });
  assert.equal(r.status, 200); assert.equal(r.data.on, true); assert.equal(r.data.stayUntilGoal, true);
  assert.equal((await h.call('/api/blind/off', { passcode: TEST_PASSCODE })).status, 423);
  assert.equal((await h.call('/api/sandbox/reset', { confirm: true })).status, 423, 'no reset escape');
});
