// End-to-end API test of the mock flow: link -> roles -> goal -> schedule -> benefit ack -> authorization ->
// scheduled pulls -> statuses -> pause/resume -> cancel -> return -> goal cap -> production refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp } from './helpers.js';
import { addDays } from '../server/dates.js';

test('mock provider: full savings-lock flow over HTTP', async (t) => {
  const h = await startApp();
  t.after(h.close);
  const { call } = h;
  let st = (await call('/api/state')).data;
  assert.equal(st.provider.id, 'mock');
  assert.equal(st.realMoneyEnabled, false);
  const today = st.today;

  // Link two fictional banks via token exchange (no credentials involved).
  const bad = await call('/api/link/exchange', { publicToken: 'username:password' });
  assert.equal(bad.status, 400);
  const tok = await call('/api/link/token', { role: 'funding' });
  assert.match(tok.data.linkToken, /^mock-link-/);
  assert.equal((await call('/api/link/exchange', { publicToken: 'mock-public-mock_goldcoast-abc12345' })).status, 200);
  assert.equal((await call('/api/link/exchange', { publicToken: 'mock-public-mock_harbor-def67890' })).status, 200);
  st = (await call('/api/state')).data;
  assert.equal(st.accounts.length, 4);
  assert.ok(st.accounts.every((a) => !('accessToken' in a) && !('accessTokenEnc' in a)));
  assert.ok(st.items.every((i) => !('accessTokenEnc' in i)), 'state API must not expose tokens');
  const funding = st.accounts.find((a) => a.mask === '4821');
  const savings = st.accounts.find((a) => a.mask === '9034');

  // Roles
  assert.equal((await call('/api/accounts/roles', { fundingAccountId: funding.id, destinationAccountId: funding.id })).status, 400);
  assert.equal((await call('/api/accounts/roles', { fundingAccountId: funding.id, destinationAccountId: savings.id })).status, 200);

  // Goal + schedule
  assert.equal((await call('/api/goal', { name: 'Mattress', targetCents: 300000, releaseDate: addDays(today, -1) })).status, 400);
  assert.equal((await call('/api/goal', { name: 'Mattress', targetCents: 300000, releaseDate: addDays(today, 400) })).status, 200);
  const sched = { amountCents: 50000, frequency: 'benefit', benefitType: 'ssi', offsetDays: 1 };
  const pv = await call('/api/schedule/preview', sched);
  assert.equal(pv.data.errors.length, 0);
  assert.equal(pv.data.dates.length, 4);
  assert.equal(pv.data.pullsNeeded, 6);
  assert.equal((await call('/api/schedule', { ...sched, amountCents: 0 })).status, 400);
  assert.equal((await call('/api/schedule', sched)).status, 200);
  st = (await call('/api/state')).data;
  assert.equal(st.schedule.status, 'needs_authorization');
  assert.equal(st.overBenefitLimit, true, '$3,000 goal is above the SSI $2,000 limit');

  // Nothing is pulled before authorization, even if time passes.
  await call('/api/sandbox/clock/advance', { days: 40 });
  assert.equal((await call('/api/state')).data.transfers.length, 0, 'no pulls without authorization');

  // Authorization requires the benefit acknowledgement first, then exact text hash + checkbox.
  const text = (await call('/api/authorization/text', { signerName: 'Lance Test' })).data;
  assert.match(text.text, /ACH DEBIT AUTHORIZATION/);
  assert.match(text.text, /ending in 4821/);
  assert.match(text.text, /revoke/i);
  let r = await call('/api/authorization', { accepted: true, textHash: text.textHash, signerName: 'Lance Test' });
  assert.equal(r.status, 409); assert.equal(r.data.error, 'ack_required');
  assert.equal((await call('/api/benefit-ack', { accepted: false, version: st.benefitWarning.version })).status, 400);
  assert.equal((await call('/api/benefit-ack', { accepted: true, version: st.benefitWarning.version })).status, 200);
  assert.equal((await call('/api/authorization', { accepted: false, textHash: text.textHash, signerName: 'Lance Test' })).status, 400);
  assert.equal((await call('/api/authorization', { accepted: true, textHash: 'deadbeef', signerName: 'Lance Test' })).status, 409);
  r = await call('/api/authorization', { accepted: true, textHash: text.textHash, signerName: 'Lance Test' });
  assert.equal(r.status, 200);
  assert.ok(r.data.acceptedAt && r.data.ip && r.data.userAgent !== undefined, 'timestamp/ip/ua logged');
  st = (await call('/api/state')).data;
  assert.equal(st.schedule.status, 'active');
  assert.ok(st.audit.some((e) => e.type === 'authorization_accepted'));

  // Advance until the first pull exists, then watch it move pending -> posted -> settled.
  let guard = 0;
  while ((await call('/api/state')).data.transfers.length === 0 && guard++ < 40) await call('/api/sandbox/clock/advance', { days: 1 });
  st = (await call('/api/state')).data;
  assert.equal(st.transfers.length, 1);
  assert.equal(st.transfers[0].status, 'pending');
  assert.equal(st.transfers[0].amountCents, 50000);
  const firstId = st.transfers[0].id;
  guard = 0;
  while ((await call('/api/state')).data.transfers.find((x) => x.id === firstId).status !== 'settled' && guard++ < 10) await call('/api/sandbox/clock/advance', { days: 1 });
  st = (await call('/api/state')).data;
  const first = st.transfers.find((x) => x.id === firstId);
  assert.deepEqual(first.history.map((x) => x.status), ['pending', 'posted', 'settled']);
  assert.equal(st.totals.lockedCents, 50000);
  assert.equal(st.locked, true, 'still locked before release date');

  // Cancelling a settled transfer is refused.
  assert.equal((await call('/api/transfers/cancel', { pullId: firstId })).status, 409);

  // Pause: no new pulls, saved money untouched.
  assert.equal((await call('/api/schedule/pause', {})).status, 200);
  const before = (await call('/api/state')).data;
  await call('/api/sandbox/clock/advance', { days: 70 });
  const afterPause = (await call('/api/state')).data;
  assert.equal(afterPause.schedule.status, 'paused');
  assert.equal(afterPause.transfers.length, before.transfers.length, 'pause stops future pulls');
  assert.equal(afterPause.totals.lockedCents, 50000, 'pause never touches saved funds');

  // Resume: skips missed dates (no catch-up), next pull appears on the next scheduled date.
  assert.equal((await call('/api/schedule/resume', {})).status, 200);
  guard = 0;
  while ((await call('/api/state')).data.transfers.length === before.transfers.length && guard++ < 40) await call('/api/sandbox/clock/advance', { days: 1 });
  st = (await call('/api/state')).data;
  assert.equal(st.transfers.length, before.transfers.length + 1, 'exactly one new pull after resume (no catch-up)');
  const pending = st.transfers.find((x) => x.status === 'pending');
  assert.ok(pending);

  // Cancel an individual pending transfer (separate from pause).
  r = await call('/api/transfers/cancel', { pullId: pending.id });
  assert.equal(r.status, 200); assert.equal(r.data.status, 'cancelled');
  st = (await call('/api/state')).data;
  assert.equal(st.schedule.status, 'active', 'cancelling one transfer does not change the schedule');

  // Returned transfer (simulate R01 on a settled one) reduces the locked balance.
  guard = 0;
  while ((await call('/api/state')).data.transfers.filter((x) => x.status !== 'cancelled').length < 2 && guard++ < 40) await call('/api/sandbox/clock/advance', { days: 1 });
  st = (await call('/api/state')).data;
  const second = st.transfers.find((x) => x.status === 'pending');
  await call('/api/sandbox/simulate', { pullId: second.id, event: 'posted' });
  await call('/api/sandbox/simulate', { pullId: second.id, event: 'settled' });
  assert.equal((await call('/api/state')).data.totals.lockedCents, 100000);
  await call('/api/sandbox/simulate', { pullId: second.id, event: 'returned' });
  st = (await call('/api/state')).data;
  assert.equal(st.transfers.find((x) => x.id === second.id).status, 'returned');
  assert.equal(st.totals.lockedCents, 50000);
  assert.equal(st.totals.returnedCents, 50000);

  // Run to completion: pulls stop at the goal; the last pull is capped so the goal is not exceeded.
  guard = 0;
  while ((await call('/api/state')).data.schedule.status === 'active' && guard++ < 20) await call('/api/sandbox/clock/advance', { days: 30 });
  st = (await call('/api/state')).data;
  assert.equal(st.schedule.status, 'completed');
  assert.equal(st.totals.lockedCents + st.totals.inFlightCents, 300000);

  // Real money: benefit ack required in the same step, then still refused.
  r = await call('/api/real-transfers/activate', {});
  assert.equal(r.status, 400); assert.equal(r.data.error, 'ack_required');
  r = await call('/api/real-transfers/activate', { benefitAck: true });
  assert.equal(r.status, 403); assert.equal(r.data.error, 'production_disabled');

  // At rest: no plaintext tokens, no credentials.
  const raw = fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8');
  assert.ok(!raw.includes('mock-access-'), 'access tokens are encrypted at rest');
  assert.match(raw, /"accessTokenEnc": "v1\./);
  assert.ok(!/password|username/i.test(raw));
});

test('revoke stops pulls and requires a new authorization; changing the plan supersedes it', async (t) => {
  const h = await startApp();
  t.after(h.close);
  const { call } = h;
  await call('/api/link/exchange', { publicToken: 'mock-public-mock_goldcoast-00000000' });
  let st = (await call('/api/state')).data;
  const [chk, sav] = st.accounts;
  await call('/api/accounts/roles', { fundingAccountId: chk.id, destinationAccountId: sav.id });
  await call('/api/goal', { name: 'Test', targetCents: 100000, releaseDate: addDays(st.today, 200) });
  await call('/api/schedule', { amountCents: 2500, frequency: 'weekly', anchorDate: addDays(st.today, 1) });
  await call('/api/benefit-ack', { accepted: true, version: st.benefitWarning.version });
  const text = (await call('/api/authorization/text', { signerName: 'Lance Test' })).data;
  await call('/api/authorization', { accepted: true, textHash: text.textHash, signerName: 'Lance Test' });
  await call('/api/sandbox/clock/advance', { days: 8 });
  st = (await call('/api/state')).data;
  const n = st.transfers.length;
  assert.ok(n >= 1);
  assert.equal((await call('/api/authorization/revoke', {})).status, 200);
  await call('/api/sandbox/clock/advance', { days: 21 });
  st = (await call('/api/state')).data;
  assert.equal(st.transfers.length, n, 'no pulls after revoke');
  assert.equal(st.schedule.status, 'revoked');
  assert.equal((await call('/api/schedule/resume', {})).status, 409);
  // New schedule => needs a fresh authorization
  await call('/api/schedule', { amountCents: 3000, frequency: 'weekly', anchorDate: addDays(st.today, 1) });
  st = (await call('/api/state')).data;
  assert.equal(st.schedule.status, 'needs_authorization');
});

test('HTTP hardening: JSON-only POSTs and same-origin check', async (t) => {
  const h = await startApp();
  t.after(h.close);
  const res = await fetch(`${h.base}/api/schedule/pause`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
  const x = await h.call('/api/schedule/pause', {}, { Origin: 'https://evil.example' });
  assert.equal(x.status, 403);
  const page = await fetch(`${h.base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(`${h.base}/../server/config.js`)).status, 404);
});
