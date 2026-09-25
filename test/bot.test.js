// Bot API: auth, scopes, rate limit, audit logging, approval gating, and the things a bot can never do.
// Also: user API auth (passcode session) and the bot CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startApp, setupActive, advanceUntil, TEST_PASSCODE } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIM = { SIM_DATE: '2026-10-05' };
const ALL = ['read', 'propose', 'pause', 'request'];
async function newKey(call, scopes = ALL, name = 'Grok') { const r = await call('/api/bot-keys', { name, scopes }); assert.equal(r.status, 200); return r.data; }

test('user API requires the passcode session; bot keys are refused there', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  assert.equal((await h.raw('/api/state')).status, 401, 'no session -> 401');
  const k = await newKey(h.call);
  const r = await h.raw('/api/state', undefined, { Authorization: `Bearer ${k.key}` });
  assert.equal(r.status, 403); assert.equal(r.data.error, 'bot_key_not_accepted');
  for (const p of ['/api/emergency/stop', '/api/real-transfers/activate', '/api/approvals/approve', '/api/vault/reveal-code', '/api/settings', '/api/bot-keys']) {
    assert.equal((await h.raw(p, { confirm: true, benefitAck: true }, { Authorization: `Bearer ${k.key}` })).status, 403, p);
    assert.equal((await h.raw(p, { confirm: true, benefitAck: true })).status, 401, p);
  }
  assert.equal((await h.raw('/api/auth/setup', { passcode: 'another-passcode' })).status, 409, 'setup only once');
  for (let i = 0; i < 5; i++) assert.equal((await h.raw('/api/auth/login', { passcode: 'wrong-wrong' })).status, 401);
  assert.equal((await h.raw('/api/auth/login', { passcode: TEST_PASSCODE })).status, 429, 'login rate-limited');
});

test('bot keys: shown once, stored hashed, scoped, revocable; auth failures are logged', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const k = await newKey(h.call, ['read']);
  assert.match(k.key, /^ldbk_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
  const raw = fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8');
  assert.ok(!raw.includes(k.key.split('.')[1]), 'secret not stored');
  const st = (await h.call('/api/state')).data;
  assert.ok(st.botKeys.every((x) => !('secretHash' in x)), 'hash not exposed to the UI either');
  const bot = h.bot(k.key);
  assert.equal((await bot('/bot/v1/status')).status, 200);
  assert.equal((await h.raw('/bot/v1/status')).status, 401);
  assert.equal((await h.bot(`${k.key.slice(0, -2)}xx`)('/bot/v1/status')).status, 401);
  let r = await bot('/bot/v1/schedule/pause', {});
  assert.equal(r.status, 403); assert.equal(r.data.error, 'insufficient_scope');
  assert.equal((await bot('/bot/v1/goals/propose', { targetCents: 400000 })).status, 403);
  await h.call('/api/bot-keys/revoke', { id: k.id });
  r = await bot('/bot/v1/status');
  assert.equal(r.status, 401); assert.match(r.data.message, /revoked/);
  const after = (await h.call('/api/state')).data;
  assert.ok(after.botActivity.some((a) => a.status === 401 && a.keyId === null));
  assert.ok(after.botActivity.some((a) => a.status === 403 && a.keyId === k.id));
});

test('bot rate limit (per key)', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  await h.call('/api/settings', { bot: { rateLimitPerMinute: 5 } });
  const bot = h.bot((await newKey(h.call, ['read'])).key);
  const codes = []; for (let i = 0; i < 7; i++) codes.push((await bot('/bot/v1/status')).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  const st = (await h.call('/api/state')).data;
  assert.equal(st.botActivity.filter((a) => a.status === 429).length, 2, 'rate-limited calls are logged too');
});

test('every bot call is audit-logged, visible in-app, and the audit chain cannot be deleted or edited', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  await setupActive(h.call, { amountCents: 25000 });
  const bot = h.bot((await newKey(h.call)).key);
  const before = (await h.call('/api/state')).data.auditCount;
  const calls = [['/bot/v1/status'], ['/bot/v1/goals'], ['/bot/v1/transfers'], ['/bot/v1/schedule'], ['/bot/v1/approvals'], ['/bot/v1/activity'],
    ['/bot/v1/audit'], ['/bot/v1/audit', undefined, 'DELETE'], ['/bot/v1/transfers', undefined, 'DELETE'], ['/bot/v1/audit/1', {}, 'PATCH'], ['/bot/v1/audit/clear', {}]];
  const statuses = [];
  for (const [p, b, m] of calls) statuses.push((await bot(p, b, m)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 404, 405, 405, 405, 404]);
  const st = (await h.call('/api/state')).data;
  assert.equal(st.botActivity.length, calls.length, 'every call visible in the Bot activity log');
  assert.ok(st.auditCount >= before + calls.length, 'audit only grows');
  assert.equal(st.audit.filter((e) => e.type === 'bot_call').length, calls.length);
  assert.equal(st.auditIntegrity.ok, true);
  // Tampering with the file is detected by the hash chain.
  const file = path.join(h.dataDir, 'db.json');
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  db.audit.splice(3, 1);
  fs.writeFileSync(file, JSON.stringify(db));
  assert.equal((await h.call('/api/audit/verify')).data.ok, false, 'deleting an entry breaks the chain');
});

test('bot can never read tokens, credentials, hashes or authorization details', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  await setupActive(h.call, { amountCents: 25000 });
  await advanceUntil(h.call, (x) => x.transfers.length >= 2, 20);
  const bot = h.bot((await newKey(h.call)).key);
  let blob = '';
  for (const p of ['/bot/v1/status', '/bot/v1/goals', '/bot/v1/transfers', '/bot/v1/schedule', '/bot/v1/approvals', '/bot/v1/activity']) blob += JSON.stringify((await bot(p)).data);
  for (const bad of ['accessToken', 'mock-access', 'accessTokenEnc', '"v1.', 'secretHash', 'passcodeHash', 'scrypt$', 'providerTransferId', 'providerAccountId', 'mock_tr_', 'textHash', 'userAgent', 'signerName']) {
    assert.ok(!blob.includes(bad), `bot response leaks ${bad}`);
  }
  for (const type of ['read_tokens', 'read_credentials']) assert.equal((await bot('/bot/v1/requests', { type })).status, 403);
});

test('sensitive actions only become pending approvals; they run after the user approves with confirmation', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  await setupActive(call, { amountCents: 50000 });
  const bot = h.bot((await newKey(call)).key);
  // goal change proposal
  let r = await bot('/bot/v1/goals/propose', { targetCents: 350000, reason: 'you asked me to aim higher' });
  assert.equal(r.status, 202); assert.equal(r.data.approval.status, 'pending');
  assert.equal((await call('/api/state')).data.goal.targetCents, 300000, 'nothing changed yet');
  assert.equal((await call('/api/approvals/approve', { id: r.data.approval.id })).status, 400, 'explicit confirmation required');
  assert.equal((await call('/api/approvals/approve', { id: r.data.approval.id, confirm: true })).status, 200);
  assert.equal((await call('/api/state')).data.goal.targetCents, 350000);
  // loosening proposals are refused outright; lock mechanics are user-only
  assert.equal((await bot('/bot/v1/goals/propose', { targetCents: 100000 })).data.error, 'lock_loosening_blocked');
  assert.equal((await bot('/bot/v1/goals/propose', { hardLock: false })).data.error, 'forbidden_for_bot');
  assert.equal((await bot('/bot/v1/goals/propose', { hardship: { enabled: true } })).data.error, 'forbidden_for_bot');
  // schedule amount change -> approval -> needs a fresh ACH authorization signed by the user
  r = await bot('/bot/v1/requests', { type: 'schedule_change', payload: { amountCents: 60000 } });
  assert.equal(r.status, 202);
  let st = (await call('/api/state')).data;
  assert.equal(st.schedule.amountCents, 50000, 'amount unchanged until approved');
  r = await call('/api/approvals/approve', { id: r.data.approval.id, confirm: true });
  assert.equal(r.status, 200); assert.equal(r.data.result.next, '#/authorize');
  st = (await call('/api/state')).data;
  assert.equal(st.schedule.amountCents, 60000); assert.equal(st.schedule.status, 'needs_authorization', 'no pulls at the new amount until the user re-authorizes');
  // funding-account change, revoke, settings: all approval-gated; the user can reject
  r = await bot('/bot/v1/requests', { type: 'change_funding_account', payload: { fundingAccountId: st.accounts.find((a) => a.mask === '2210').id } });
  assert.equal(r.status, 202);
  assert.equal((await call('/api/approvals/reject', { id: r.data.approval.id })).status, 200);
  assert.equal((await call('/api/state')).data.roles.fundingAccountId, st.roles.fundingAccountId);
  r = await bot('/bot/v1/requests', { type: 'settings_change', payload: { 'safety.bufferCents': 20000 } });
  assert.equal(r.status, 202);
  assert.equal((await bot('/bot/v1/requests', { type: 'settings_change', payload: { 'hardLock.defaultOn': false } })).data.error, 'forbidden_for_bot');
  assert.equal((await bot('/bot/v1/requests', { type: 'settings_change', payload: { 'bot.rateLimitPerMinute': 600 } })).data.error, 'forbidden_for_bot', 'cannot raise its own limits');
  const ap = (await bot('/bot/v1/approvals')).data.approvals;
  assert.ok(ap.some((a) => a.status === 'approved') && ap.some((a) => a.status === 'rejected') && ap.some((a) => a.status === 'pending'));
});

test('bot pause is immediate; resume needs approval; withdrawals need the goal-based unlock AND the user\'s code', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  await setupActive(call, { amountCents: 50000 });
  const bot = h.bot((await newKey(call)).key);
  assert.equal((await bot('/bot/v1/requests', { type: 'withdrawal', payload: { amountCents: 1000 } })).status, 423, 'vault locked: not even a request');
  assert.equal((await bot('/bot/v1/rollovers/prepare', { mode: 'partial', withdrawCents: 1000, newTargetCents: 400000 })).status, 423);
  let r = await bot('/bot/v1/schedule/pause', {});
  assert.equal(r.status, 200); assert.equal(r.data.status, 'paused');
  r = await bot('/bot/v1/requests', { type: 'resume_schedule' });
  assert.equal(r.status, 202);
  assert.equal((await call('/api/state')).data.schedule.status, 'paused');
  await call('/api/approvals/approve', { id: r.data.approval.id, confirm: true });
  assert.equal((await call('/api/state')).data.schedule.status, 'active');
  await advanceUntil(call, (x) => x.goal.status === 'unlocked', 80);
  // Bot prepares the exact rollover example; the user approves with the unlock code.
  r = await bot('/bot/v1/rollovers/prepare', { mode: 'partial', withdrawCents: 100000, newTargetCents: 400000 });
  assert.equal(r.status, 202);
  assert.deepEqual([r.data.preview.remainingCents, r.data.preview.additionalNeededCents], [200000, 200000]);
  assert.equal(r.data.approval.requiresUnlockCode, true);
  const id = r.data.approval.id;
  let a = await call('/api/approvals/approve', { id, confirm: true });
  assert.equal(a.status, 403); assert.equal(a.data.error, 'bad_code');
  assert.equal((await call('/api/state')).data.approvals.find((x) => x.id === id).status, 'pending', 'still pending after a wrong/missing code');
  const { code } = (await call('/api/vault/reveal-code', {})).data;
  a = await call('/api/approvals/approve', { id, confirm: true, unlockCode: code });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const st = (await call('/api/state')).data;
  assert.equal(st.goal.targetCents, 400000); assert.equal(st.totals.vaultCents, 200000); assert.equal(st.goal.status, 'saving');
});

test('bot can never unlock, bypass, switch to production, disable emergency controls or delete audit', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  await setupActive(h.call, { amountCents: 50000 });
  const bot = h.bot((await newKey(h.call)).key);
  for (const type of ['unlock', 'early_unlock', 'bypass_lock', 'hardship_release', 'disable_hard_lock', 'lower_goal', 'switch_production', 'enable_real_money', 'disable_emergency', 'disable_emergency_stop', 'delete_audit', 'edit_audit', 'hide_transaction', 'delete_transaction', 'create_bot_key']) {
    const r = await bot('/bot/v1/requests', { type });
    assert.equal(r.status, 403, type); assert.equal(r.data.error, 'forbidden_for_bot');
  }
  for (const p of ['/bot/v1/unlock', '/bot/v1/production', '/bot/v1/emergency/disable', '/bot/v1/emergency/stop', '/bot/v1/keys', '/bot/v1/real-transfers/activate']) {
    assert.equal((await bot(p, {})).status, 404, p);
  }
  const st = (await h.call('/api/state')).data;
  assert.equal(st.goal.status, 'saving'); assert.equal(st.realMoneyEnabled, false);
  assert.equal(st.approvals.length, 0, 'forbidden requests never reach the inbox');
  assert.ok(st.audit.filter((e) => e.type === 'bot_forbidden_request').length >= 15);
});

test('emergency stop (user only): pauses deposits, revokes all bot keys, cancels pending approvals, never unlocks', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  const { call } = h;
  await setupActive(call, { amountCents: 50000 });
  let st = await advanceUntil(call, (x) => x.totals.vaultCents >= 50000, 20);
  const k1 = await newKey(call); const k2 = await newKey(call, ['read'], 'Backup');
  const bot = h.bot(k1.key);
  await bot('/bot/v1/goals/propose', { targetCents: 400000 });
  assert.equal((await call('/api/emergency/stop', {})).status, 400, 'explicit confirmation required');
  const r = await call('/api/emergency/stop', { confirm: true });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.schedulePaused, r.data.botKeysRevoked, r.data.approvalsCancelled, r.data.lockUnchanged], [true, 2, 1, true]);
  assert.equal((await bot('/bot/v1/status')).status, 401);
  assert.equal((await h.bot(k2.key)('/bot/v1/status')).status, 401);
  const after = (await call('/api/state')).data;
  assert.equal(after.schedule.status, 'paused'); assert.equal(after.goal.status, 'saving');
  assert.equal(after.totals.vaultCents, st.totals.vaultCents);
  assert.equal(after.approvals[0].status, 'cancelled');
  const n = after.transfers.length;
  await call('/api/sandbox/clock/advance', { days: 30 });
  assert.equal((await call('/api/state')).data.transfers.length, n, 'no deposits after emergency stop');
});

test('OpenAPI spec documents every bot route with its scope', async () => {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/bot-api.openapi.json'), 'utf8'));
  const h = await startApp(SIM);
  try {
    for (const r of h.app.bot.routes) {
      const [m, p] = r.split(' ');
      assert.ok(spec.paths[p]?.[m.toLowerCase()], `${r} missing from OpenAPI`);
    }
    assert.equal(Object.values(spec.paths).flatMap((x) => Object.keys(x)).length, h.app.bot.routes.length, 'no undocumented or stale paths');
  } finally { await h.close(); }
});

test('bot-cli.js drives the bot API from a shell', async (t) => {
  const h = await startApp(SIM);
  t.after(h.close);
  await setupActive(h.call, { amountCents: 50000 });
  const k = await newKey(h.call);
  const run = promisify(execFile);
  const env = { ...process.env, LDB_BOT_KEY: k.key, LDB_URL: h.base };
  const j = async (...args) => JSON.parse((await run(process.execPath, ['bot-cli.js', ...args], { cwd: ROOT, env })).stdout);
  const s = await j('status');
  assert.equal(s.httpStatus, 200); assert.equal(s.goal.targetCents, 300000);
  assert.equal((await j('goals')).active.hardLock, true);
  assert.equal((await j('propose-goal', '--target', '3500', '--reason', 'test')).approval.type, 'goal_change');
  assert.equal((await j('approvals')).approvals.length, 1);
  assert.equal((await j('pause')).status, 'paused');
  await assert.rejects(run(process.execPath, ['bot-cli.js', 'prepare-rollover', '--withdraw', '1000', '--new-target', '4000'], { cwd: ROOT, env }), (e) => JSON.parse(e.stdout).httpStatus === 423);
  await assert.rejects(run(process.execPath, ['bot-cli.js', 'request', 'unlock'], { cwd: ROOT, env }), (e) => JSON.parse(e.stdout).httpStatus === 403);
});
