// Monthly move (Varo -> Step instant -> Current, approve, record steps) and the encrypted assistant sync (static demo).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, setupActive } from './helpers.js';
import { newSyncCode, parseSyncCode, sealSync, openSync } from '../server/sync.js';

const SIM = { SIM_DATE: '2026-10-05' };
const ALL = ['read', 'propose', 'pause', 'request'];

test('monthly move: bot asks -> user approves -> bot records 3 steps in order; blind hides the amount; emergency stop cancels', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  await setupActive(h.call, { amountCents: 10000 });
  const key = (await h.call('/api/bot-keys', { name: 'Grok', scopes: ALL })).data.key; const bot = h.bot(key);
  const p = await bot('/bot/v1/monthly-moves/propose', { reason: 'monthly' });
  assert.equal(p.status, 202, JSON.stringify(p.data));
  assert.match(p.data.approval.summary, /^Monthly move: \$100\.00 Varo → Step \(instant\) → Current on 2026-10-08/);
  assert.deepEqual(p.data.move.legs.map((l) => l.id), ['varo_to_step', 'step_to_current', 'arrival_confirmed']);
  assert.match(p.data.move.legs[1].label, /1-3 business days.*leaves Step right away/);
  assert.match(p.data.move.stepZeroReminder, /zero/);
  assert.equal((await bot('/bot/v1/monthly-moves/propose', {})).status, 409, 'one per month');
  const id = p.data.move.id;
  assert.equal((await bot('/bot/v1/monthly-moves/complete', { id, confirmation: 'ABC123' })).status, 409, 'not approved yet');
  // blind: the user and the bot see [hidden]
  assert.equal((await h.call('/api/blind/on', { confirm: true })).status, 200);
  let st = (await h.call('/api/state')).data;
  const apr = st.approvals.find((a) => a.id === p.data.approval.id);
  assert.match(apr.summary, /Move|Monthly move: \[hidden\] Varo → Step/); assert.ok(!/\$\d/.test(apr.summary));
  assert.equal(st.monthlyMoves[0].amountCents, null);
  assert.ok(!/\$\d/.test(JSON.stringify((await bot('/bot/v1/monthly-moves')).data)));
  assert.equal((await h.call('/api/approvals/approve', { id: apr.id, confirm: true })).status, 200);
  let m = (await bot('/bot/v1/monthly-moves')).data.monthlyMoves[0];
  assert.equal(m.status, 'approved'); assert.equal(m.nextLeg, 'varo_to_step');
  assert.equal((await bot('/bot/v1/monthly-moves/complete', { id, leg: 'step_to_current', confirmation: 'X12345' })).status, 409, 'order enforced');
  assert.equal((await bot('/bot/v1/monthly-moves/complete', { id, confirmation: 'x' })).status, 400, 'confirmation required');
  assert.equal((await bot('/bot/v1/monthly-moves/complete', { id, confirmation: 'VARO-INSTANT-1' })).data.move.status, 'in_progress');
  const w = await bot('/bot/v1/monthly-moves/complete', { id, confirmation: 'STEP-ACH-2', stepBalanceCents: 500 });
  assert.equal(w.status, 200); assert.match(w.data.warning, /zero/); assert.equal(w.data.move.stepBalanceZero, false);
  const done = await bot('/bot/v1/monthly-moves/complete', { id, confirmation: 'CURRENT-ARRIVED-3' });
  assert.equal(done.data.move.status, 'done'); assert.ok(done.data.move.legs.every((l) => l.status === 'done'));
  assert.equal((await bot('/bot/v1/monthly-moves/complete', { id, confirmation: 'again' })).status, 409);
  st = (await h.call('/api/state')).data;
  for (const tp of ['monthly_move_approved', 'monthly_move_step_done', 'monthly_move_done']) assert.ok(st.audit.some((a) => a.type === tp), tp);
  const snap = (await bot('/bot/v1/snapshot')).data;
  assert.equal(snap.kind, 'ldb-assistant-snapshot'); assert.equal(snap.blindMode, true);
  assert.ok(snap.decisions.some((d) => d.type === 'approval_approved')); assert.equal(snap.monthlyMoves[0].status, 'done');
  // next month: rejected / emergency stop
  const p2 = await bot('/bot/v1/monthly-moves/propose', { date: '2026-11-03' });
  assert.equal(p2.status, 202);
  assert.equal((await h.call('/api/emergency/stop', { confirm: true })).status, 200);
  assert.equal(h.app.service.s.monthlyMoves.find((x) => x.id === p2.data.move.id).status, 'cancelled');
});

test('prototype "Simulate completion" records all three steps with fake confirmations; money never moves', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  await setupActive(h.call, { amountCents: 10000 });
  const key = (await h.call('/api/bot-keys', { name: 'Grok', scopes: ALL })).data.key; const bot = h.bot(key);
  const p = await bot('/bot/v1/monthly-moves/propose', {});
  const before = JSON.stringify(h.app.service.s.transfers);
  assert.equal((await h.call('/api/monthly-moves/complete', { id: p.data.move.id })).status, 409, 'needs approval first');
  await h.call('/api/approvals/approve', { id: p.data.approval.id, confirm: true });
  const r = await h.call('/api/monthly-moves/complete', { id: p.data.move.id });
  assert.equal(r.status, 200); assert.equal(r.data.move.status, 'done');
  assert.deepEqual(r.data.move.legs.map((l) => l.confirmation.split('-')[1]), ['INSTANT', 'ACH', 'ARRIVED']);
  assert.equal(r.data.move.stepBalanceZero, true);
  assert.equal(JSON.stringify(h.app.service.s.transfers), before, 'no transfers created');
});

test('sync crypto: code format, round trip, AAD binds channel+slot, tamper/wrong code fail', () => {
  const code = newSyncCode(); assert.match(code, /^ldbsync1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  const c = parseSyncCode(code);
  const env = sealSync({ hello: 'world' }, c, 'app');
  assert.deepEqual(openSync(env, c, 'app'), { hello: 'world' });
  assert.ok(!JSON.stringify(env).includes('world'));
  assert.throws(() => openSync(env, c, 'bot'));
  assert.throws(() => openSync({ ...env, slot: 'bot' }, c, 'bot'), 'slot swap fails (AAD)');
  assert.throws(() => openSync(env, parseSyncCode(newSyncCode()), 'app'));
  const bad = Buffer.from(env.ct, 'base64url'); bad[0] ^= 1;
  assert.throws(() => openSync({ ...env, ct: bad.toString('base64url') }, c, 'app'));
  assert.throws(() => parseSyncCode('nope'));
});

test('browser (WebCrypto) sync envelopes open in Node and vice versa', async () => {
  const code = newSyncCode(); const c = parseSyncCode(code);
  const k = await crypto.webcrypto.subtle.importKey('raw', c.key, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const aad = new TextEncoder().encode(`ldb-sync:v1:${c.channel}:app`);
  const iv = crypto.randomBytes(12);
  const ct = Buffer.from(await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, k, new TextEncoder().encode('{"a":1}')));
  assert.deepEqual(openSync({ v: 1, alg: 'A256GCM', channel: c.channel, slot: 'app', iv: iv.toString('base64url'), ct: ct.toString('base64url') }, c, 'app'), { a: 1 });
  const env = sealSync({ b: 2 }, c, 'app');
  const pt = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(env.iv, 'base64url'), additionalData: aad }, k, Buffer.from(env.ct, 'base64url'));
  assert.equal(new TextDecoder().decode(pt), '{"b":2}');
});

test('relay (SYNC_RELAY=on): stores ciphertext only, CORS for allowed origins, validates envelopes; inbox applies only safe types', async (t) => {
  const h = await startApp({ ...SIM, SYNC_RELAY: 'on', SYNC_ALLOWED_ORIGINS: 'https://zigflames.com' }); t.after(h.close);
  await setupActive(h.call, { amountCents: 10000 });
  const c = parseSyncCode(newSyncCode());
  const url = (slot) => `${h.base}/sync/v1/${c.channel}/${slot}`;
  assert.equal((await fetch(url('app'))).status, 404);
  const pre = await fetch(url('app'), { method: 'OPTIONS', headers: { Origin: 'https://zigflames.com' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), 'https://zigflames.com');
  const evil = await fetch(url('app'), { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const snap = (await h.call('/api/sync/snapshot', {})).data.snapshot;
  assert.equal(snap.kind, 'ldb-assistant-snapshot');
  const put = await fetch(url('app'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sealSync(snap, c, 'app')) });
  assert.equal(put.status, 200);
  const got = await (await fetch(url('app'))).json();
  assert.ok(!JSON.stringify(got).includes('Varo') && !JSON.stringify(got).includes('schedule'), 'relay holds ciphertext only');
  assert.equal(openSync(got, c, 'app').kind, 'ldb-assistant-snapshot');
  assert.equal((await fetch(url('app'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"v":1}' })).status, 400);
  assert.equal((await fetch(`${h.base}/sync/v1/short/app`)).status, 404);
  assert.equal((await fetch(url('app'), { method: 'PUT', body: 'x'.repeat(300 * 1024) })).status, 413);
  // assistant -> app messages (the app decrypts and posts them to /api/sync/inbox)
  const msgs = { messages: [
    { id: 'm1', type: 'propose_monthly_move', reason: 'monthly' },
    { id: 'm2', type: 'reveal_password' },
    { id: 'm3', type: 'propose_speed_up', multiplier: 2 },
    { id: 'm1', type: 'propose_monthly_move' },
  ] };
  const r = (await h.call('/api/sync/inbox', msgs)).data.results;
  assert.deepEqual(r.map((x) => x.status), ['applied', 'refused', 'applied', 'skipped']);
  let st = (await h.call('/api/state')).data;
  assert.equal(st.approvals.filter((a) => a.status === 'pending').length, 2, 'proposals wait for the user');
  assert.ok(st.audit.some((a) => a.type === 'sync_message_refused'));
  const mv = st.monthlyMoves[0];
  await h.call('/api/approvals/approve', { id: mv.approvalId, confirm: true });
  const r2 = (await h.call('/api/sync/inbox', { messages: [{ id: 'm4', type: 'complete_monthly_move', moveId: mv.id, confirmation: 'VARO-1' }] })).data.results;
  assert.equal(r2[0].status, 'applied'); assert.equal(r2[0].move, 'in_progress');
  st = (await h.call('/api/state')).data;
  assert.ok(st.sync.lastPushAt && st.sync.lastPullAt);
});

test('relay is off by default', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  assert.equal((await fetch(`${h.base}/sync/v1/${'a'.repeat(22)}/app`)).status, 404);
});
