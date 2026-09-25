// $3,000 Hard Lock vault: unlock only by settled balance >= goal, one-time unlock code (hash only, expiry),
// withdrawals need code + confirmation, Roll Over & Relock (exact example + partial/full/raise/milestones),
// loosening blocked mid-goal, optional hardship release (non-Hard-Lock goals only), emergency stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, setupActive, advanceUntil } from './helpers.js';
import { addDays } from '../server/dates.js';
import { newUnlockCode } from '../server/secrets.js';

const SIM = { SIM_DATE: '2026-10-05' };
/** $3,000 default goal with $500 weekly deposits -> unlocked after 6 settled deposits. */
async function reachGoal(call, opts = {}) {
  await setupActive(call, { amountCents: 50000, ...opts });
  return advanceUntil(call, (x) => x.goal.status === 'unlocked', 80);
}

test('unlock code: generated at the milestone, crypto-random, shown once, only a hash stored', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  const st = await reachGoal(call);
  assert.equal(st.goal.status, 'unlocked');
  assert.equal(st.totals.vaultCents, 300000);
  assert.equal(st.vault.codeWaitingToBeShown, true);
  assert.ok(st.notifications.some((n) => n.type === 'goal_reached'), 'in-app milestone banner');
  assert.ok(!JSON.stringify(st.notifications).match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/), 'notifications never contain the code');
  const r = await call('/api/vault/reveal-code', {});
  assert.equal(r.status, 200);
  assert.match(r.data.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal((await call('/api/vault/reveal-code', {})).status, 410, 'shown once');
  const raw = fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8');
  assert.ok(!raw.includes(r.data.code) && !raw.includes(r.data.code.replace(/-/g, '')), 'plaintext code not stored');
  assert.match(raw, /"hash": "scrypt\$/);
  assert.ok(!JSON.stringify((await call('/api/state')).data).includes('scrypt$'), 'hash not exposed');
  const codes = new Set([...Array(200)].map(() => newUnlockCode()));
  assert.equal(codes.size, 200, 'no collisions in 200 codes');
});

test('unlock code: expiry, wrong-code lockout, regeneration invalidates the old code, single use', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  await call('/api/settings', { unlock: { codeExpiryDays: 2, maxAttempts: 3 } });
  await reachGoal(call);
  const { code } = (await call('/api/vault/reveal-code', {})).data;
  await call('/api/sandbox/clock/advance', { days: 3 });
  let r = await call('/api/vault/withdraw', { amountCents: 1000, unlockCode: code, confirm: true });
  assert.equal(r.status, 410); assert.equal(r.data.error, 'code_expired');
  assert.equal((await call('/api/vault/regenerate-code', {})).status, 400, 'needs confirmation');
  const fresh = (await call('/api/vault/regenerate-code', { confirm: true })).data.code;
  r = await call('/api/vault/withdraw', { amountCents: 1000, unlockCode: code, confirm: true });
  assert.equal(r.data.error, 'bad_code', 'old code no longer works');
  assert.equal((await call('/api/vault/withdraw', { amountCents: 1000, unlockCode: fresh })).data.error, 'confirm_required');
  r = await call('/api/vault/withdraw', { amountCents: 1000, unlockCode: fresh, confirm: true });
  assert.equal(r.status, 200); assert.equal(r.data.simulated, true);
  r = await call('/api/vault/withdraw', { amountCents: 1000, unlockCode: fresh, confirm: true });
  assert.equal(r.data.error, 'code_used', 'single use');
  const again = (await call('/api/vault/regenerate-code', { confirm: true })).data.code;
  for (let i = 0; i < 3; i++) await call('/api/vault/withdraw', { amountCents: 1000, unlockCode: 'AAAA-BBBB-CCCC', confirm: true });
  r = await call('/api/vault/withdraw', { amountCents: 1000, unlockCode: again, confirm: true });
  assert.equal(r.status, 429); assert.equal(r.data.error, 'code_locked');
  assert.equal((await call('/api/state')).data.totals.vaultCents, 299000);
});

test('Hard Lock: no withdrawal, unlock or override path while saving', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  await setupActive(call, { amountCents: 50000 });
  const st = await advanceUntil(call, (x) => x.totals.vaultCents >= 100000, 30);
  assert.equal(st.goal.status, 'saving'); assert.equal(st.goal.hardLock, true);
  let r = await call('/api/vault/withdraw', { amountCents: 1000, unlockCode: 'AAAA-BBBB-CCCC', confirm: true });
  assert.equal(r.status, 423); assert.equal(r.data.error, 'vault_locked');
  assert.equal((await call('/api/vault/reveal-code', {})).status, 423);
  assert.equal((await call('/api/vault/regenerate-code', { confirm: true })).status, 423);
  assert.equal((await call('/api/rollover/execute', { mode: 'partial', withdrawCents: 1000, newTargetCents: 400000, confirm: true })).status, 423);
  r = await call('/api/hardship/request', { amountCents: 1000, typed: st.hardshipPhrase, confirm: true });
  assert.equal(r.status, 403); assert.equal(r.data.error, 'hard_lock');
  for (const p of ['/api/vault/unlock', '/api/vault/override', '/api/admin/unlock', '/api/emergency/unlock', '/api/emergency/withdraw', '/api/lock/disable']) {
    assert.equal((await call(p, { confirm: true })).status, 404, `${p} does not exist`);
  }
  r = await call('/api/emergency/stop', { confirm: true });
  assert.equal(r.status, 200); assert.equal(r.data.lockUnchanged, true);
  const after = (await call('/api/state')).data;
  assert.equal(after.goal.status, 'saving', 'emergency stop never unlocks');
  assert.equal(after.totals.vaultCents, st.totals.vaultCents, 'emergency stop never releases money');
  assert.equal(after.schedule.status, 'paused');
  assert.equal((await call('/api/vault/withdraw', { amountCents: 1000, unlockCode: 'X', confirm: true })).status, 423);
  const cp = await call('/api/real-transfers/activate', { benefitAck: true });
  assert.equal(cp.status, 403);
});

test('loosening a locked goal is blocked; raising the goal or adding time is allowed', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  // Draft (before authorization): anything goes, including Hard Lock off + hardship options.
  let st = (await call('/api/state')).data;
  assert.equal(st.goal.draft, true);
  assert.equal((await call('/api/goal', { targetCents: 200000 })).status, 200);
  assert.equal((await call('/api/goal', { targetCents: 300000, hardLock: false, hardship: { enabled: true, coolingOffDays: 45 } })).status, 200);
  assert.equal((await call('/api/goal', { hardLock: true })).status, 200);
  st = (await call('/api/state')).data;
  assert.equal(st.goal.hardship.enabled, false, 'Hard Lock removes the hardship option entirely');
  await setupActive(call, { amountCents: 50000 });
  st = (await call('/api/state')).data;
  assert.equal(st.goal.draft, false); assert.ok(st.goal.lockedAt);
  const g = st.goal;
  const blocked = [
    { targetCents: 299999 },
    { hardLock: false },
    { hardLock: false, hardship: { enabled: true, coolingOffDays: 30 } },
    { releaseDate: addDays(g.releaseDate, -1) },
  ];
  for (const body of blocked) {
    const r = await call('/api/goal', body);
    assert.equal(r.status, 423, JSON.stringify(body)); assert.equal(r.data.error, 'lock_loosening_blocked');
  }
  assert.equal((await call('/api/goal', { targetCents: 350000 })).status, 200, 'raise allowed');
  assert.equal((await call('/api/goal', { releaseDate: addDays(g.releaseDate, 30) })).status, 200, 'more time allowed');
  assert.equal((await call('/api/goal', { unlockRule: 'goal_and_date' })).status, 200, 'stricter unlock rule allowed');
  assert.equal((await call('/api/goal', { unlockRule: 'goal' })).status, 423, 'dropping the date requirement blocked');
  assert.equal((await call('/api/goal', { name: 'New mattress', milestonesCents: [100000, 200000] })).status, 200);
  // Settings are defaults for NEW goals only; they never loosen the locked goal.
  assert.equal((await call('/api/settings', { hardLock: { defaultOn: false }, goal: { lockDays: 30, targetCents: 100000 } })).status, 200);
  st = (await call('/api/state')).data;
  assert.equal(st.goal.hardLock, true); assert.equal(st.goal.targetCents, 350000);
  assert.ok(st.audit.filter((e) => e.type === 'lock_loosening_refused').length >= 5, 'refusals are audited');
});

test('Roll Over & Relock, exact example: 3000 -> withdraw 1000 -> 2000 left -> goal 4000 -> needs 2000 -> relocked, deposits continue', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  let st = await reachGoal(call);
  assert.equal(st.totals.vaultCents, 300000);
  const p = (await call('/api/rollover/preview', { mode: 'partial', withdrawCents: 100000, newTargetCents: 400000 })).data;
  assert.deepEqual([p.vaultCents, p.withdrawCents, p.remainingCents, p.newTargetCents, p.additionalNeededCents], [300000, 100000, 200000, 400000, 200000]);
  assert.equal(p.pullsNeeded, 4); assert.equal(p.requiresUnlockCode, true); assert.deepEqual(p.errors, []);
  const { code } = (await call('/api/vault/reveal-code', {})).data;
  assert.equal((await call('/api/rollover/execute', { mode: 'partial', withdrawCents: 100000, newTargetCents: 400000, confirm: true })).data.error, 'bad_code', 'code required');
  assert.equal((await call('/api/rollover/execute', { mode: 'partial', withdrawCents: 100000, newTargetCents: 400000, unlockCode: code })).data.error, 'confirm_required');
  const r = await call('/api/rollover/execute', { mode: 'partial', withdrawCents: 100000, newTargetCents: 400000, unlockCode: code, confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  st = (await call('/api/state')).data;
  assert.equal(st.totals.withdrawalsCents, 100000);
  assert.equal(st.totals.vaultCents, 200000, '2000 left, still locked');
  assert.equal(st.goal.targetCents, 400000); assert.equal(st.goal.cycle, 2);
  assert.equal(st.goal.status, 'saving'); assert.ok(st.goal.lockedAt, 'relocked immediately');
  assert.equal(st.goal.remainingCents, 200000, 'needs 2000 more');
  assert.equal(st.goal.hardLock, true);
  assert.equal(st.schedule.status, 'active', 'deposits continue');
  assert.equal(st.cycles.length, 1);
  assert.deepEqual([st.cycles[0].targetCents, st.cycles[0].withdrawCents, st.cycles[0].remainingCents, st.cycles[0].nextTargetCents], [300000, 100000, 200000, 400000]);
  assert.equal((await call('/api/vault/withdraw', { amountCents: 100, unlockCode: code, confirm: true })).status, 423, 'locked again');
  st = await advanceUntil(call, (x) => x.goal.status === 'unlocked', 60);
  assert.equal(st.goal.status, 'unlocked'); assert.equal(st.totals.vaultCents, 400000);
  assert.equal(st.transfers.filter((x) => x.goalId === st.goal.id).length, 4, '4 more $500 deposits in cycle 2');
  assert.ok(st.audit.some((e) => e.type === 'rollover_relocked'));
});

test('rollover: raise-only (no code), full withdrawal close, full withdrawal restart, custom milestones', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  let st = await reachGoal(call);
  // raise-only: nothing withdrawn, no code needed
  let r = await call('/api/rollover/execute', { mode: 'raise', newTargetCents: 450000, milestonesCents: [350000, 400000], confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  st = (await call('/api/state')).data;
  assert.equal(st.totals.vaultCents, 300000); assert.equal(st.totals.withdrawalsCents, 0);
  assert.equal(st.goal.targetCents, 450000); assert.equal(st.goal.status, 'saving');
  assert.deepEqual(st.goal.milestones.map((m) => m.targetCents), [350000, 400000]);
  st = await advanceUntil(call, (x) => x.goal.milestones[0].reachedOn, 30);
  assert.ok(st.notifications.some((n) => n.type === 'milestone' && /3,500/.test(n.title)), 'custom milestone notification');
  assert.equal(st.goal.status, 'saving', 'a milestone does not unlock');
  st = await advanceUntil(call, (x) => x.goal.status === 'unlocked', 60);
  assert.equal(st.totals.vaultCents, 450000);
  // full withdrawal + restart: vault empties, new goal starts from zero
  let code = (await call('/api/vault/reveal-code', {})).data.code;
  r = await call('/api/rollover/execute', { mode: 'full', fullAction: 'restart', newTargetCents: 300000, unlockCode: code, confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  st = (await call('/api/state')).data;
  assert.equal(st.totals.vaultCents, 0); assert.equal(st.goal.cycle, 3); assert.equal(st.goal.status, 'saving'); assert.equal(st.schedule.status, 'active');
  st = await advanceUntil(call, (x) => x.goal.status === 'unlocked', 80);
  // full withdrawal + close: no more deposits
  code = (await call('/api/vault/reveal-code', {})).data.code;
  r = await call('/api/rollover/execute', { mode: 'full', fullAction: 'close', unlockCode: code, confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  st = (await call('/api/state')).data;
  assert.equal(st.goal.status, 'closed'); assert.equal(st.schedule.status, 'completed'); assert.equal(st.schedule.completedReason, 'goal_closed');
  const n = st.transfers.length;
  await call('/api/sandbox/clock/advance', { days: 60 });
  assert.equal((await call('/api/state')).data.transfers.length, n, 'no deposits after closing');
  assert.equal(st.cycles.length, 3, 'full history of every cycle');
  assert.deepEqual(st.cycles.map((c) => c.mode), ['raise', 'full', 'full']);
  assert.equal(st.auditIntegrity.ok, true);
});

test('rollover validation: partial must keep something and aim higher', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  await reachGoal(h.call);
  const bad = [
    { mode: 'partial', withdrawCents: 0, newTargetCents: 400000 },
    { mode: 'partial', withdrawCents: 300000, newTargetCents: 400000 },
    { mode: 'partial', withdrawCents: 100000, newTargetCents: 150000 },
    { mode: 'raise', newTargetCents: 250000 },
  ];
  for (const b of bad) assert.ok((await h.call('/api/rollover/preview', b)).data.errors.length > 0, JSON.stringify(b));
});

test('hardship release (only for goals created without Hard Lock): typed confirmation, cooling-off, cancellable, logged', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  assert.equal((await call('/api/goal', { hardLock: false, hardship: { enabled: true, coolingOffDays: 3 } })).status, 400, 'cooling-off minimum is 7 days');
  assert.equal((await call('/api/goal', { hardLock: false, hardship: { enabled: true, coolingOffDays: 30 } })).status, 200);
  await setupActive(call, { amountCents: 50000 });
  let st = await advanceUntil(call, (x) => x.totals.vaultCents >= 100000, 30);
  assert.equal((await call('/api/goal', { hardship: { enabled: true, coolingOffDays: 10 } })).status, 423, 'cannot shorten the cooling-off mid-goal');
  assert.equal((await call('/api/hardship/request', { amountCents: 50000, typed: 'yes', confirm: true })).status, 400, 'typed phrase required');
  let r = await call('/api/hardship/request', { amountCents: 50000, typed: st.hardshipPhrase, confirm: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.availableOn, addDays(st.today, 30));
  assert.equal((await call('/api/hardship/complete', { typed: st.hardshipPhrase, confirm: true })).status, 423, 'still cooling off');
  assert.equal((await call('/api/hardship/cancel', {})).status, 200);
  r = await call('/api/hardship/request', { amountCents: 50000, typed: st.hardshipPhrase, confirm: true });
  await call('/api/schedule/pause', {});
  await call('/api/sandbox/clock/advance', { days: 29 });
  assert.equal((await call('/api/hardship/complete', { typed: st.hardshipPhrase, confirm: true })).status, 423);
  await call('/api/sandbox/clock/advance', { days: 1 });
  const before = (await call('/api/state')).data.totals.vaultCents;
  r = await call('/api/hardship/complete', { typed: st.hardshipPhrase, confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  st = (await call('/api/state')).data;
  assert.equal(st.totals.vaultCents, before - 50000);
  assert.equal(st.goal.status, 'saving', 'the rest stays locked');
  for (const ty of ['hardship_requested', 'hardship_cancelled', 'hardship_released']) assert.ok(st.audit.some((e) => e.type === ty), ty);
});
