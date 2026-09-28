// Seal my login: generator, AES-GCM (Node + WebCrypto compatible), API flow, tighten-only unlock, refusals, bot limits,
// lost-card checklist, key loading. Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startApp, setupActive, TEST_PASSCODE } from './helpers.js';
import { generatePassword, passwordOptions, generateAnswer, nodeSealCipher, aadFor, SEAL_PHRASE, RESEAL_PHRASE, DEFAULT_LABEL, LOST_CARD_STEPS } from '../server/sealed.js';
import { createWebCryptoSealCipher } from '../demo/src/sealed-cipher.js';
import { loadSealKey } from '../server/crypto.js';

const SIM = { SIM_DATE: '2026-10-05' };
const ALL = ['read', 'propose', 'pause', 'request'];
const quiet = { warn() {}, log() {}, error() {} };
const localDate = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const FAKE = { username: 'fake.saver@example.com', recoveryEmail: 'fake.recovery@example.com', phone: '+1 555 010 0199', notes: 'fake notes', questions: [{ question: 'First pet?', generate: true }] };

async function sealOne(h, { unlockRule = 'date', unlockDate = localDate(3), body = {} } = {}) {
  const d = await h.call('/api/sealed-logins/draft', { ...FAKE, ...body });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const r = await h.call('/api/sealed-logins/seal', { draftId: d.data.draft.id, typed: SEAL_PHRASE, enteredAtBank: true, confirmedLogin: true, unlockRule, unlockDate: unlockRule === 'goal' ? undefined : unlockDate });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { values: d.data.draft.values, id: r.data.sealed.id, sealed: r.data.sealed };
}

test('password generator: length, classes, exact symbol count, no look-alikes, options validated', () => {
  for (let i = 0; i < 200; i++) {
    const p = generatePassword();
    assert.equal(p.length, 20); assert.match(p, /^[A-Za-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[a-z]/);
    assert.ok((p.match(/\d/g) || []).length >= 2); assert.equal((p.match(/[!@#$%&*\-_+=?]/g) || []).length, 2);
    assert.ok(!/[IlO01]/.test(p), `no look-alikes (I, l, O, 0, 1): ${p}`);
  }
  const q = generatePassword({ length: 32, symbolCount: 0, avoidAmbiguous: false });
  assert.equal(q.length, 32); assert.match(q, /^[A-Za-z0-9]+$/);
  assert.throws(() => passwordOptions({ length: 6 })); assert.throws(() => passwordOptions({ length: 500 }));
  assert.equal(passwordOptions({ symbolCount: 3, symbols: '' }).symbolCount, 0, 'no symbol set -> no symbols');
  const a = generateAnswer(); assert.equal(a.split(' ').length, 4);
  assert.equal(new Set(Array.from({ length: 50 }, () => generatePassword())).size, 50, 'random');
});

test('sealed-login cipher: Node round trip; AAD, tamper and wrong key fail; WebCrypto demo cipher is compatible', async () => {
  const key = crypto.randomBytes(32);
  const n = nodeSealCipher(key);
  const blob = await n.encrypt('{"password":"x"}', aadFor('sl_1'));
  assert.match(blob, /^sl1\./);
  assert.equal(await n.decrypt(blob, aadFor('sl_1')), '{"password":"x"}');
  await assert.rejects(n.decrypt(blob, aadFor('sl_2')));
  const parts = blob.split('.'); const buf = Buffer.from(parts[2], 'base64'); buf[0] ^= 1;
  await assert.rejects(n.decrypt(`sl1.${parts[1]}.${buf.toString('base64')}`, aadFor('sl_1')));
  await assert.rejects(nodeSealCipher(crypto.randomBytes(32)).decrypt(blob, aadFor('sl_1')));
  const wkey = await crypto.webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const w = createWebCryptoSealCipher(async () => wkey);
  assert.equal(await w.decrypt(blob, aadFor('sl_1')), '{"password":"x"}', 'browser reads Node ciphertext');
  assert.equal(await n.decrypt(await w.encrypt('hello', aadFor('sl_9')), aadFor('sl_9')), 'hello', 'Node reads browser ciphertext');
});

test('seal flow: phrase + checklist required; secrets never in state, audit, bot or the data file; reveal/delete/reset refused', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  const d = await h.call('/api/sealed-logins/draft', FAKE);
  assert.equal(d.status, 200); const pw = d.data.draft.values.password;
  assert.equal(d.data.draft.label, DEFAULT_LABEL); assert.equal(DEFAULT_LABEL, 'Current Savings');
  assert.equal(d.data.draft.values.questions[0].answer.split(' ').length, 4);
  const base = { draftId: d.data.draft.id, unlockRule: 'date', unlockDate: localDate(3) };
  assert.equal((await h.call('/api/sealed-logins/seal', { ...base, typed: 'seal it', enteredAtBank: true, confirmedLogin: true })).status, 400, 'wrong phrase');
  assert.equal((await h.call('/api/sealed-logins/seal', { ...base, typed: SEAL_PHRASE, enteredAtBank: true })).status, 400, 'checklist');
  assert.equal((await h.call('/api/sealed-logins/seal', { ...base, unlockDate: localDate(0), typed: SEAL_PHRASE, enteredAtBank: true, confirmedLogin: true })).status, 400, 'date must be in the future');
  const r = await h.call('/api/sealed-logins/seal', { ...base, typed: SEAL_PHRASE, enteredAtBank: true, confirmedLogin: true });
  assert.equal(r.status, 200); const id = r.data.sealed.id;
  const secrets = [pw, FAKE.username, FAKE.recoveryEmail, FAKE.phone, d.data.draft.values.questions[0].answer];
  const key = (await h.call('/api/bot-keys', { name: 'Grok', scopes: ALL })).data.key; const bot = h.bot(key);
  const dump = JSON.stringify((await h.call('/api/state')).data) + JSON.stringify((await bot('/bot/v1/status')).data) + JSON.stringify((await bot('/bot/v1/sealed-logins')).data) + JSON.stringify((await bot('/bot/v1/snapshot')).data);
  await h.app.store.save?.();
  const disk = fs.readdirSync(h.dataDir).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(h.dataDir, f), 'utf8')).join('');
  for (const s of secrets) { assert.ok(!dump.includes(s), `secret leaked in API: ${s}`); assert.ok(!disk.includes(s), `secret on disk in plain text: ${s}`); }
  // refusals
  let x = await h.call('/api/sealed-logins/reveal', { id, passcode: TEST_PASSCODE });
  assert.equal(x.status, 423); assert.ok(!JSON.stringify(x.data).includes(pw));
  assert.equal((await h.call('/api/blind/on', { confirm: true })).status, 200);
  assert.equal((await h.call('/api/sealed-logins/reveal', { id, passcode: TEST_PASSCODE })).status, 423, 'Go Blind + passcode does not help');
  assert.equal((await h.call('/api/sealed-logins/delete', { id, confirm: true })).status, 423);
  assert.equal((await h.call('/api/sandbox/reset', { confirm: true })).status, 423);
  // bot
  x = await bot('/bot/v1/sealed-logins'); assert.deepEqual(Object.keys(x.data.sealedLogins[0]).sort(), ['label', 'sealedAt', 'status']);
  assert.equal((await bot('/bot/v1/sealed-logins/reveal', { id })).status, 403);
  assert.equal((await bot('/bot/v1/sealed-logins', { label: 'x' })).status, 403);
  assert.equal((await bot('/bot/v1/sealed-logins/delete', { id })).status, 403);
  assert.equal((await bot('/bot/v1/sealed-logins/unlock', { id, unlockDate: localDate(1) })).status, 403);
  assert.equal((await bot('/bot/v1/requests', { type: 'reveal_password' })).status, 403);
  assert.equal((await bot('/bot/v1/sealed-logins', undefined, 'DELETE')).status, 405);
  const types = (await h.call('/api/state')).data.audit.map((a) => a.type);
  for (const tp of ['sealed_login_sealed', 'sealed_login_reveal_refused', 'sealed_login_delete_refused', 'bot_forbidden_request']) assert.ok(types.includes(tp), tp);
  const auditDump = JSON.stringify(h.app.service.s.audit) + JSON.stringify(h.app.service.s.botActivity);
  for (const s of secrets) assert.ok(!auditDump.includes(s), 'audit/bot activity never contain secrets');
});

test('entered password mode + tighten-only unlock + reveal after the date (wall clock)', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  const { id } = await sealOne(h, { body: { passwordMode: 'enter', password: 'My-Own-Fake-Pass-42' } });
  assert.equal((await h.call('/api/sealed-logins/unlock', { id, unlockRule: 'date', unlockDate: localDate(2) })).status, 423, 'earlier refused');
  assert.equal((await h.call('/api/sealed-logins/unlock', { id, unlockRule: 'goal' })).status, 423, 'date -> goal refused');
  const later = await h.call('/api/sealed-logins/unlock', { id, unlockRule: 'date', unlockDate: localDate(4) });
  assert.equal(later.status, 200); assert.equal(later.data.sealed.unlockDate, localDate(4));
  assert.equal((await h.call('/api/sealed-logins/label', { id, label: 'Current Savings (old)' })).data.sealed.label, 'Current Savings (old)');
  const real = Date.now; h.app.service.nowMs = () => real() + 5 * 86400000;
  const r = await h.call('/api/sealed-logins/reveal', { id });
  assert.equal(r.status, 200); assert.equal(r.data.values.password, 'My-Own-Fake-Pass-42');
  assert.equal((await h.call('/api/sealed-logins/delete', { id })).status, 400, 'confirm needed');
  assert.equal((await h.call('/api/sealed-logins/delete', { id, confirm: true })).status, 200);
});

test('goal-bound seal: demo clock/simulate refused, goal cannot be lowered, opens when the goal is reached', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  await setupActive(h.call, { amountCents: 50000 });
  const st = (await h.call('/api/state')).data;
  const { id, values } = await sealOne(h, { unlockRule: 'goal' });
  assert.equal((await h.call('/api/sandbox/clock/advance', { days: 1 })).status, 423);
  assert.equal((await h.call('/api/goal', { targetCents: st.goal.targetCents - 10000 })).status, 423, 'lowering refused');
  for (let i = 0; i < 200 && h.app.service.s.goal.status === 'saving'; i++) await h.app.locked('system', () => h.app.service.advanceClock(1));
  assert.equal(h.app.service.s.goal.status, 'unlocked');
  const r = await h.call('/api/sealed-logins/reveal', { id });
  assert.equal(r.status, 200); assert.equal(r.data.values.password, values.password);
});

test('reseal: new password, old never returned, same password refused; date-only seal allows the demo clock', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  const { id, values } = await sealOne(h);
  assert.equal((await h.call('/api/sandbox/clock/advance', { days: 1 })).status, 200, 'date-only seal: demo clock ok');
  assert.equal((await h.call('/api/sealed-logins/reseal/draft', { id, passwordMode: 'enter', password: values.password })).status, 400, 'same password refused');
  const d = await h.call('/api/sealed-logins/reseal/draft', { id });
  assert.equal(d.status, 200); const pw2 = d.data.draft.values.password;
  assert.notEqual(pw2, values.password); assert.ok(!JSON.stringify(d.data).includes(values.password), 'old password never returned');
  assert.equal((await h.call('/api/sealed-logins/reseal', { draftId: d.data.draft.id, typed: SEAL_PHRASE, changedAtBank: true, confirmedLogin: true })).status, 400, 'reseal phrase');
  const r = await h.call('/api/sealed-logins/reseal', { draftId: d.data.draft.id, typed: RESEAL_PHRASE, changedAtBank: true, confirmedLogin: true });
  assert.equal(r.status, 200); assert.equal(r.data.sealed.resealCount, 1);
  const real = Date.now; h.app.service.nowMs = () => real() + 5 * 86400000;
  const o = await h.call('/api/sealed-logins/reveal', { id });
  assert.equal(o.data.values.password, pw2); assert.equal(o.data.values.username, FAKE.username, 'kept fields merged');
});

test('drafts expire after 2 hours; lost-card checklist persists and is logged', async (t) => {
  const h = await startApp(SIM); t.after(h.close);
  const d = await h.call('/api/sealed-logins/draft', FAKE);
  const real = Date.now; h.app.service.nowMs = () => real() + 3 * 3600_000;
  assert.equal((await h.call('/api/sealed-logins/seal', { draftId: d.data.draft.id, typed: SEAL_PHRASE, enteredAtBank: true, confirmedLogin: true, unlockRule: 'date', unlockDate: localDate(3) })).status, 409);
  h.app.service.nowMs = real;
  assert.equal((await h.call('/api/lost-card', { item: 'nope', done: true })).status, 400);
  for (const s of LOST_CARD_STEPS) assert.equal((await h.call('/api/lost-card', { item: s.id, done: true })).status, 200);
  const st = (await h.call('/api/state')).data;
  assert.equal(st.lostCard.allDone, true); assert.ok(st.lostCard.steps.every((x) => /Current/.test(x.label)), 'lost-card steps are for the Current card');
  assert.ok(st.audit.some((a) => a.type === 'lost_card_step'));
});

test('loadSealKey: env, file, generated dev key (0600), bad length', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldb-key-'));
  const k = crypto.randomBytes(32).toString('base64');
  assert.equal(loadSealKey({ configured: k, dataDir: dir }, quiet).source, 'env');
  const f = path.join(dir, 'k.txt'); fs.writeFileSync(f, k);
  assert.equal(loadSealKey({ file: f, dataDir: dir }, quiet).source, 'file');
  const g = loadSealKey({ dataDir: dir }, quiet); assert.equal(g.key.length, 32);
  assert.equal(fs.statSync(path.join(dir, '.sealed-login-key')).mode & 0o777, 0o600);
  assert.throws(() => loadSealKey({ configured: Buffer.alloc(16).toString('base64'), dataDir: dir }, quiet));
  fs.rmSync(dir, { recursive: true, force: true });
});
