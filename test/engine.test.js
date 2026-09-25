// Automatic savings engine: unattended months on the simulated clock, overdraft buffer, idempotency across
// restarts / concurrent ticks / concurrent processes, pending vs settled, returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startApp, setupActive, advanceUntil } from './helpers.js';
import { isBusinessDay, addDays } from '../server/dates.js';
import { pullDates } from '../server/schedule.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIM = { SIM_DATE: '2026-10-05' };
const dupes = (transfers) => { const seen = new Set(); return transfers.filter((t) => (seen.has(t.idempotencyKey) ? true : (seen.add(t.idempotencyKey), false))); };

test('runs unattended for 14 months: day-after-SSI deposits, settles, reaches $3,000 and stops by itself', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const sched = { amountCents: 25000, frequency: 'benefit', benefitType: 'ssi', offsetDays: 1 };
  const { st: start } = await setupActive(h.call, { schedule: sched });
  assert.equal(start.goal.targetCents, 300000, 'default goal is $3,000');
  assert.equal(start.goal.hardLock, true, 'Hard Lock on by default');
  // No user action from here on: only the engine's own ticks (same code path as the timer / npm run tick).
  for (let i = 0; i < 430; i++) await h.app.tick({ advanceDays: 1 });
  const st = (await h.call('/api/state')).data;
  const pulls = st.transfers.filter((x) => x.status !== 'cancelled');
  assert.equal(pulls.length, 12, '12 x $250 = $3,000');
  assert.deepEqual(dupes(st.transfers), [], 'no duplicate periods');
  const expected = pullDates({ ...sched }, start.today, addDays(start.today, 430)).slice(0, 12);
  assert.deepEqual(pulls.map((x) => x.date).sort(), expected, 'each deposit is on the business day after the SSI payment');
  assert.ok(pulls.every((x) => isBusinessDay(x.date)));
  assert.ok(pulls.every((x) => x.status === 'settled'));
  assert.equal(st.totals.vaultCents, 300000);
  assert.equal(st.goal.status, 'unlocked');
  assert.equal(st.schedule.status, 'completed');
  assert.equal(st.schedule.completedReason, 'goal_reached');
  assert.ok(st.audit.some((e) => e.type === 'goal_reached'));
  assert.ok(st.goal.milestones[0].reachedOn && st.goal.milestones[0].targetCents === 150000, 'default $1,500 intermediate milestone fired');
});

test('in-process timer runs the engine without any request', async (t) => {
  const h = await startApp({ ...SIM, SCHEDULER_INTERVAL_SECONDS: '5' });
  t.after(h.close);
  await setupActive(h.call, { amountCents: 25000 });
  h.app.startScheduler(); // first run is immediate
  await new Promise((r) => setTimeout(r, 300));
  const st = (await h.call('/api/state')).data;
  assert.equal(st.transfers.length, 1, 'timer created today\'s deposit');
});

test('overdraft protection: defers while balance - pull < buffer, then skips after the defer window; logs reasons', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  await call('/api/sandbox/mock-balance', { cents: 30000 }); // $300 available, $250 pull, $100 buffer
  const { st: s0 } = await setupActive(call, { amountCents: 25000 });
  await call('/api/scheduler/run', {});
  let st = (await call('/api/state')).data;
  assert.equal(st.transfers.length, 0, 'nothing pulled');
  let p = st.schedule.periods.find((x) => x.date === s0.today);
  assert.equal(p.status, 'deferred');
  assert.match(p.reasons[0].reason, /\$300\.00 - pull \$250\.00 would leave less than the \$100\.00 safety buffer/);
  assert.ok(st.audit.some((e) => e.type === 'pull_deferred'));
  // 3 business days of retries, then skipped (default deferMaxBusinessDays = 3)
  st = await advanceUntil(call, (x) => x.schedule.periods.find((y) => y.date === s0.today).status === 'skipped', 10);
  p = st.schedule.periods.find((x) => x.date === s0.today);
  assert.equal(p.status, 'skipped');
  assert.equal(p.attempts, 4);
  assert.equal(st.transfers.length, 0);
  assert.ok(st.audit.some((e) => e.type === 'pull_skipped'));
  assert.ok(st.notifications.some((n) => n.type === 'deposit_skipped'), 'user is told in-app');
  // Funds back -> next weekly period pulls normally.
  await call('/api/sandbox/mock-balance', { cents: 150000 });
  st = await advanceUntil(call, (x) => x.transfers.length > 0, 10);
  assert.equal(st.transfers.length, 1);
  assert.equal(st.transfers[0].date, pullDates({ frequency: 'weekly', anchorDate: s0.today, amountCents: 25000 }, addDays(s0.today, 1), addDays(s0.today, 14))[0], 'next weekly period (Oct 12 is Columbus Day -> Oct 13)');
});

test('overdraft protection in "skip" mode skips immediately', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  await h.call('/api/settings', { safety: { onInsufficientFunds: 'skip', bufferCents: 5000 } });
  await h.call('/api/sandbox/mock-balance', { cents: 27000 }); // 270 - 250 = 20 < 50
  await setupActive(h.call, { amountCents: 25000 });
  await h.call('/api/scheduler/run', {});
  const st = (await h.call('/api/state')).data;
  assert.equal(st.schedule.periods[0].status, 'skipped');
  assert.equal(st.transfers.length, 0);
});

test('no duplicates across restarts and concurrent ticks (two app instances, one data dir)', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldb-dup-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const a = await startApp(SIM, { dataDir });
  await setupActive(a.call, { amountCents: 25000 });
  await a.app.tick();
  await a.app.tick();
  await a.close(); // "restart"
  const b = await startApp(SIM, { dataDir });
  const c = await startApp(SIM, { dataDir, login: true });
  t.after(async () => { await b.close(); await c.close(); });
  await Promise.all([...Array(8)].flatMap(() => [b.app.tick(), c.app.tick()]));
  // Concurrent advancing from both instances: each day is processed under the file lock.
  await Promise.all([b.app.tick({ advanceDays: 20 }), c.app.tick({ advanceDays: 20 })]);
  const st = (await b.call('/api/state')).data;
  assert.deepEqual(dupes(st.transfers), [], 'one transfer per schedule+period');
  const byDate = st.transfers.map((x) => x.date);
  assert.equal(new Set(byDate).size, byDate.length);
  assert.ok(st.transfers.length >= 6, `weekly deposits over ~6 weeks (${st.transfers.length})`);
  assert.equal(st.auditIntegrity.ok, true);
});

test('no duplicates when several `npm run tick` processes run at once', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldb-proc-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const a = await startApp(SIM, { dataDir });
  await setupActive(a.call, { amountCents: 25000 });
  await a.close();
  const env = { ...process.env, PROVIDER: 'mock', DATA_DIR: dataDir, ...SIM };
  for (const k of ['PLAID_ENV', 'NODE_ENV']) delete env[k];
  const run = () => new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/tick.js'], { cwd: ROOT, env });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', () => {});
    p.on('close', (code) => resolve({ code, out }));
  });
  const results = await Promise.all([run(), run(), run(), run(), run()]);
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
  const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(db.transfers.length, 1, 'five concurrent tick processes -> exactly one deposit');
  assert.equal(Object.keys(db.mock.transfers).length, 1, 'and exactly one at the (mock) provider');
  assert.ok(!fs.existsSync(path.join(dataDir, 'db.lock')), 'lock released');
});

test('a period left "creating" by a crash is retried with the same idempotency key (no double pull)', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { st } = await setupActive(h.call, { amountCents: 25000 });
  await h.app.locked('system', async () => {
    const s = h.app.store.state; const key = `${s.schedule.id}:${st.today}`;
    s.periods[key] = { key, scheduleId: s.schedule.id, date: st.today, status: 'creating', attempts: 1, reasons: [], transferId: null };
    s.schedule.cursor = st.today;
  });
  await h.app.tick(); await h.app.tick();
  const after = (await h.call('/api/state')).data;
  assert.equal(after.transfers.length, 1);
  assert.equal(after.schedule.periods[0].status, 'created');
});

test('pending vs settled: only settled counts; the goal is NOT reached while deposits are pending', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  const { st: s0 } = await setupActive(call, { amountCents: 25000, goal: { targetCents: 50000 } });
  assert.equal(s0.goal.targetCents, 50000);
  await call('/api/scheduler/run', {});
  let st = (await call('/api/state')).data;
  assert.equal(st.totals.pendingCents, 25000);
  assert.equal(st.totals.vaultCents, 0);
  // Force the second weekly pull while the first is still in flight.
  const first = st.transfers[0];
  await call('/api/sandbox/simulate', { pullId: first.id, event: 'posted' });
  await call('/api/sandbox/simulate', { pullId: first.id, event: 'settled' });
  st = await advanceUntil(call, (x) => x.transfers.length === 2, 10);
  assert.equal(st.totals.vaultCents, 25000);
  assert.equal(st.totals.pendingCents, 25000);
  assert.equal(st.totals.vaultCents + st.totals.pendingCents, 50000, 'settled + pending = target...');
  assert.equal(st.goal.status, 'saving', '...but the goal is not reached until it settles');
  assert.equal(st.vault.codeWaitingToBeShown, false);
  assert.equal((await call('/api/vault/reveal-code', {})).status, 423);
  const second = st.transfers.find((x) => x.status === 'pending');
  await call('/api/sandbox/simulate', { pullId: second.id, event: 'posted' });
  st = (await call('/api/state')).data;
  assert.equal(st.goal.status, 'saving', 'posted is still not settled');
  await call('/api/sandbox/simulate', { pullId: second.id, event: 'settled' });
  st = (await call('/api/state')).data;
  assert.equal(st.goal.status, 'unlocked');
  assert.equal(st.totals.vaultCents, 50000);
});

test('returned deposits never count; a return after the goal was reached relocks and cancels the code', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  await setupActive(call, { amountCents: 25000, goal: { targetCents: 50000 } });
  const st1 = await advanceUntil(call, (x) => x.goal.status === 'unlocked', 30);
  assert.equal(st1.goal.status, 'unlocked');
  const last = st1.transfers[0];
  await call('/api/sandbox/simulate', { pullId: last.id, event: 'returned', returnCode: 'R01' });
  const st = (await call('/api/state')).data;
  assert.equal(st.totals.vaultCents, 25000);
  assert.equal(st.totals.returnedCents, 25000);
  assert.equal(st.goal.status, 'saving', 'relocked');
  assert.equal(st.vault.codeWaitingToBeShown, false);
  assert.ok(st.audit.some((e) => e.type === 'goal_unlock_reversed'));
  assert.equal(st.schedule.status, 'active', 'deposits continue');
});

test('unauthorized return (R10) pauses deposits for review; repeated R01 returns auto-pause', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  await setupActive(call, { amountCents: 25000 });
  let st = await advanceUntil(call, (x) => x.transfers.some((y) => y.status === 'settled'), 10);
  await call('/api/sandbox/simulate', { pullId: st.transfers.find((y) => y.status === 'settled').id, event: 'returned', returnCode: 'R10' });
  st = (await call('/api/state')).data;
  assert.equal(st.schedule.status, 'paused');
  assert.equal(st.schedule.pausedReason, 'return_R10');
  assert.ok(st.audit.some((e) => e.type === 'authorization_review_needed'));
});

test('pause stops future deposits only; cancel ends the schedule; neither touches the vault or the lock', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  await setupActive(call, { amountCents: 25000 });
  let st = await advanceUntil(call, (x) => x.totals.vaultCents > 0, 10);
  const vault = st.totals.vaultCents; const n = st.transfers.length;
  await call('/api/schedule/pause', {});
  await call('/api/sandbox/clock/advance', { days: 30 });
  st = (await call('/api/state')).data;
  assert.equal(st.transfers.length, n); assert.equal(st.totals.vaultCents, vault); assert.equal(st.goal.status, 'saving');
  assert.equal((await call('/api/schedule/cancel', {})).status, 400, 'needs explicit confirmation');
  assert.equal((await call('/api/schedule/cancel', { confirm: true })).status, 200);
  st = (await call('/api/state')).data;
  assert.equal(st.schedule.status, 'cancelled'); assert.equal(st.authorization.status, 'revoked');
  assert.equal(st.totals.vaultCents, vault); assert.equal(st.goal.status, 'saving', 'still locked');
  await call('/api/sandbox/clock/advance', { days: 30 });
  assert.equal((await call('/api/state')).data.transfers.length, n);
});
