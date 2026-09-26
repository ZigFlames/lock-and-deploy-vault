// Static demo Go Blind passcode: PBKDF2-SHA256 via WebCrypto, salted, never stored in plain text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashBlindPasscode, verifyBlindPasscode, validBlindPasscode, PBKDF2_ITERATIONS } from '../demo/src/blind-passcode.js';

test('demo Go Blind passcode: 4-12 digits only', () => {
  for (const ok of ['1234', '000000', '123456789012']) assert.ok(validBlindPasscode(ok), ok);
  for (const bad of ['123', 'abcd', '12 34', '1234567890123', '', null, undefined]) assert.ok(!validBlindPasscode(bad), String(bad));
});

test('demo Go Blind passcode: salted PBKDF2 hash, verifies right / rejects wrong, rejects junk', async () => {
  assert.ok(PBKDF2_ITERATIONS >= 300000);
  const h1 = await hashBlindPasscode('4826'), h2 = await hashBlindPasscode('4826');
  assert.match(h1, /^pbkdf2\$310000\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
  assert.notEqual(h1, h2, 'random salt -> different hashes for the same passcode');
  assert.ok(!h1.includes('4826'), 'no plain text');
  assert.equal(await verifyBlindPasscode('4826', h1), true);
  assert.equal(await verifyBlindPasscode('4826', h2), true);
  assert.equal(await verifyBlindPasscode('4827', h1), false);
  assert.equal(await verifyBlindPasscode('', h1), false);
  assert.equal(await verifyBlindPasscode('4826', null), false);
  assert.equal(await verifyBlindPasscode('4826', 'plain$4826'), false);
  assert.equal(await verifyBlindPasscode('4826', h1.replace('310000', '10')), false, 'too few iterations refused');
  await assert.rejects(hashBlindPasscode('12'), /4 to 12 digits/);
});

test('demo Go Blind passcode plugs into the engine: lockout after 5 wrong tries, right one works after 15 min', async () => {
  const { Service } = await import('../server/service.js');
  const { emptyState } = await import('../server/store.js');
  const state = emptyState();
  const store = { state, save() {}, withLock: (fn) => fn(state) };
  const svc = new Service({ store, key: Buffer.alloc(32, 1), config: { provider: 'mock', demoClock: true, notify: {} } });
  const { MockProvider } = await import('../server/providers/mock.js');
  svc.provider = new MockProvider({ store, today: () => svc.today(), fundingBalanceCents: () => 100000 });
  let now = Date.now(); svc.nowMs = () => now;
  svc.blindAuth = { kind: 'blind_passcode', needsSetup: () => !state.blind.passcodeHash,
    setup: async (p) => { state.blind.passcodeHash = await hashBlindPasscode(p, { iterations: 2000 }); },
    verify: async (p) => verifyBlindPasscode(p, state.blind.passcodeHash) };
  svc.bootstrap();
  await assert.rejects(svc.blindOn({ confirm: true }), (e) => e.code === 'weak_passcode', 'first enable needs a passcode');
  await assert.rejects(svc.blindOn({ confirm: true, passcode: '12' }), (e) => e.code === 'weak_passcode');
  await assert.rejects(svc.blindOn({ confirm: true }, { by: 'bot' }), (e) => e.code === 'blind_passcode_needed');
  const v = await svc.blindOn({ confirm: true, passcode: '4826' });
  assert.equal(v.on, true); assert.equal(v.passcodeKind, 'blind_passcode');
  assert.match(state.blind.passcodeHash, /^pbkdf2\$/);
  assert.ok(!JSON.stringify(svc.view()).includes('pbkdf2'), 'hash never in the UI view');
  for (let i = 0; i < 4; i++) await assert.rejects(svc.blindOff({ passcode: '0000' }), (e) => e.status === 401);
  await assert.rejects(svc.blindOff({ passcode: '0000' }), (e) => e.status === 429);
  await assert.rejects(svc.blindOff({ passcode: '4826' }), (e) => e.status === 429);
  now += 15 * 60_000 + 1;
  assert.equal((await svc.blindOff({ passcode: '4826' })).on, false);
  assert.ok(state.audit.some((a) => a.type === 'blind_passcode_set') && state.audit.some((a) => a.type === 'blind_off_lockout'));
});
