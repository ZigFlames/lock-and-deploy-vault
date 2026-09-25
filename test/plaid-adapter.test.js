// Verifies the plaid-sandbox adapter WITHOUT network or keys: a stub stands in for the official PlaidApi
// client and records every call, so we can check endpoints + parameters and run the whole service flow
// (debit -> simulate posted/settled -> credit leg to savings) through the real adapter code.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp } from './helpers.js';
import { addDays } from '../server/dates.js';
import { verifyPlaidWebhook, createPlaidClient } from '../server/providers/plaidSandbox.js';

function stubPlaid(basePath = 'https://sandbox.plaid.com') {
  const calls = [];
  const transfers = {};
  let n = 0; const events = []; let evId = 0;
  const ok = (data) => Promise.resolve({ data });
  const accounts = [
    { account_id: 'acc_chk', name: 'Plaid Checking', mask: '0000', type: 'depository', subtype: 'checking' },
    { account_id: 'acc_sav', name: 'Plaid Saving', mask: '1111', type: 'depository', subtype: 'savings' },
    { account_id: 'acc_cc', name: 'Plaid Credit Card', mask: '3333', type: 'credit', subtype: 'credit card' },
  ];
  const c = {
    __basePath: basePath,
    calls,
    linkTokenCreate: (b) => { calls.push(['linkTokenCreate', b]); return ok({ link_token: 'link-sandbox-xyz', expiration: 'x' }); },
    sandboxPublicTokenCreate: (b) => { calls.push(['sandboxPublicTokenCreate', b]); return ok({ public_token: 'public-sandbox-abc' }); },
    itemPublicTokenExchange: (b) => { calls.push(['itemPublicTokenExchange', b]); return ok({ access_token: 'access-sandbox-SECRET123', item_id: 'item_1' }); },
    accountsGet: (b) => { calls.push(['accountsGet', b]); return ok({ accounts, item: { institution_name: 'First Platypus Bank' } }); },
    accountsBalanceGet: (b) => { calls.push(['accountsBalanceGet', b]); return ok({ accounts: accounts.filter((a) => b.options.account_ids.includes(a.account_id)).map((a) => ({ ...a, balances: { available: c.__available ?? 1000, current: 1100 } })) }); },
    transferAuthorizationCreate: (b) => { calls.push(['transferAuthorizationCreate', b]); return ok({ authorization: { id: `auth_${++n}`, decision: 'approved', decision_rationale: null } }); },
    transferCreate: (b) => { calls.push(['transferCreate', b]); const id = `tr_${++n}`; transfers[id] = { id, status: 'pending', cancellable: true }; return ok({ transfer: transfers[id] }); },
    transferGet: (b) => { calls.push(['transferGet', b]); return ok({ transfer: { ...transfers[b.transfer_id], failure_reason: null } }); },
    transferCancel: (b) => { calls.push(['transferCancel', b]); transfers[b.transfer_id].status = 'cancelled'; return ok({}); },
    sandboxTransferSimulate: (b) => { calls.push(['sandboxTransferSimulate', b]); transfers[b.transfer_id].status = b.event_type; events.push({ event_id: ++evId, event_type: b.event_type, transfer_id: b.transfer_id, failure_reason: b.failure_reason || null }); return ok({}); },
    sandboxTransferLedgerSimulateAvailable: (b) => { calls.push(['sandboxTransferLedgerSimulateAvailable', b]); return ok({}); },
    transferEventSync: (b) => { calls.push(['transferEventSync', b]); return ok({ transfer_events: events.filter((e) => e.event_id > b.after_id) }); },
    webhookVerificationKeyGet: (b) => { calls.push(['webhookVerificationKeyGet', b]); return ok({ key: c.__jwk }); },
  };
  return c;
}
const env = { PROVIDER: 'plaid-sandbox', PLAID_ENV: 'sandbox', PLAID_CLIENT_ID: 'dummy-client-id-for-tests', PLAID_SECRET: 'dummy-secret-for-tests' };

// The official client test needs the optional `plaid` npm package. Without it, report SKIPPED (not failed).
const hasPlaid = await import('plaid').then(() => true, () => false);

test('official plaid client builds against the hard-coded sandbox host', { skip: hasPlaid ? false : 'plaid package not installed (npm install to run)' }, async () => {
  const client = await createPlaidClient({ clientId: 'x', secret: 'y' });
  assert.equal(client.__basePath, 'https://sandbox.plaid.com');
  assert.equal(typeof client.transferAuthorizationCreate, 'function');
  assert.equal(typeof client.sandboxTransferSimulate, 'function');
});

test('plaid-sandbox adapter: link, auth, transfer, simulate, credit leg, cancel', async (t) => {
  const stub = stubPlaid();
  const h = await startApp(env, { plaidClient: stub });
  t.after(h.close);
  const { call } = h;
  let st = (await call('/api/state')).data;
  assert.equal(st.provider.id, 'plaid-sandbox');
  assert.equal(st.provider.model, 'ledger');

  const lt = await call('/api/link/token', { role: 'any' });
  assert.equal(lt.data.linkToken, 'link-sandbox-xyz');
  const ltBody = stub.calls.find((c) => c[0] === 'linkTokenCreate')[1];
  assert.deepEqual(ltBody.products, ['transfer']);
  assert.deepEqual(ltBody.country_codes, ['US']);

  const { data: { publicToken } } = await call('/api/link/sandbox-public-token', {});
  assert.equal((await call('/api/link/exchange', { publicToken })).status, 200);
  st = (await call('/api/state')).data;
  assert.equal(st.accounts.length, 2, 'only depository accounts');
  const [chk, sav] = st.accounts;
  await call('/api/accounts/roles', { fundingAccountId: chk.id, destinationAccountId: sav.id });
  await call('/api/goal', { name: 'Mattress', targetCents: 300000, releaseDate: addDays(st.today, 300) });
  await call('/api/schedule', { amountCents: 1111, frequency: 'weekly', anchorDate: st.today });
  await call('/api/benefit-ack', { accepted: true, version: st.benefitWarning.version });
  const text = (await call('/api/authorization/text', { signerName: 'Lance Test' })).data;
  assert.equal((await call('/api/authorization', { accepted: true, textHash: text.textHash, signerName: 'Lance Test' })).status, 200);
  await call('/api/scheduler/run', {});
  st = (await call('/api/state')).data;
  assert.equal(st.transfers.length, 1);
  const pull = st.transfers[0];

  const bal = stub.calls.find((c) => c[0] === 'accountsBalanceGet')[1];
  assert.deepEqual(bal.options.account_ids, ['acc_chk'], 'balance checked on the funding account before the pull');
  const auth = stub.calls.find((c) => c[0] === 'transferAuthorizationCreate')[1];
  assert.equal(auth.access_token, 'access-sandbox-SECRET123');
  assert.equal(auth.account_id, 'acc_chk');
  assert.equal(auth.type, 'debit');
  assert.equal(auth.network, 'ach');
  assert.equal(auth.ach_class, 'web');
  assert.equal(auth.amount, '11.11');
  assert.equal(auth.user.legal_name, 'Lance Test');
  assert.ok(auth.idempotency_key);
  const tc = stub.calls.find((c) => c[0] === 'transferCreate')[1];
  assert.equal(tc.authorization_id, 'auth_1');
  assert.ok(tc.description.length <= 10);

  // Simulate posted -> settled; settled triggers ledger-available + the credit leg to the savings account.
  await call('/api/sandbox/simulate', { pullId: pull.id, event: 'posted' });
  await call('/api/sandbox/simulate', { pullId: pull.id, event: 'settled' });
  assert.ok(stub.calls.some((c) => c[0] === 'sandboxTransferSimulate' && c[1].event_type === 'settled'));
  assert.ok(stub.calls.some((c) => c[0] === 'sandboxTransferLedgerSimulateAvailable'));
  const creditAuth = stub.calls.filter((c) => c[0] === 'transferAuthorizationCreate')[1][1];
  assert.equal(creditAuth.type, 'credit');
  assert.equal(creditAuth.account_id, 'acc_sav');
  assert.equal(creditAuth.ach_class, 'ppd');
  st = (await call('/api/state')).data;
  assert.equal(st.transfers[0].status, 'settled');
  assert.equal(st.transfers[0].credit.status, 'pending');
  assert.equal(st.totals.lockedCents, 1111);

  // event sync is idempotent
  await call('/api/scheduler/run', {});
  assert.ok(stub.calls.some((c) => c[0] === 'transferEventSync'));

  // Cancel pending via /transfer/cancel
  await call('/api/sandbox/clock/advance', { days: 7 });
  st = (await call('/api/state')).data;
  const p2 = st.transfers.find((x) => x.status === 'pending');
  assert.ok(p2);
  assert.equal((await call('/api/transfers/cancel', { pullId: p2.id })).status, 200);
  assert.ok(stub.calls.some((c) => c[0] === 'transferCancel'));

  // Access token encrypted at rest
  const fs = await import('node:fs');
  const raw = fs.readFileSync(`${h.dataDir}/db.json`, 'utf8');
  assert.ok(!raw.includes('access-sandbox-SECRET123'));
});

test('adapter refuses to call a non-sandbox Plaid host', async (t) => {
  const stub = stubPlaid('https://production.plaid.com');
  const h = await startApp(env, { plaidClient: stub });
  t.after(h.close);
  const r = await h.call('/api/link/token', { role: 'any' });
  assert.equal(r.status, 500);
  assert.equal(r.data.error, 'production_guard');
  assert.equal(stub.calls.length, 0);
});

test('Plaid webhook JWT verification (ES256 + body hash + age)', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', expired_at: null };
  const body = JSON.stringify({ webhook_type: 'TRANSFER', webhook_code: 'TRANSFER_EVENTS_UPDATE' });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'ES256', kid: 'k1', typ: 'JWT' });
  const p = b64({ iat: now, request_body_sha256: crypto.createHash('sha256').update(body).digest('hex') });
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const token = `${h}.${p}.${sig}`;
  const getKey = async () => jwk;
  await verifyPlaidWebhook({ headers: { 'plaid-verification': token }, rawBody: body, getKey });
  await assert.rejects(verifyPlaidWebhook({ headers: { 'plaid-verification': token }, rawBody: body + ' ', getKey }), /hash mismatch/);
  await assert.rejects(verifyPlaidWebhook({ headers: {}, rawBody: body, getKey }), /Missing/);
  await assert.rejects(verifyPlaidWebhook({ headers: { 'plaid-verification': token }, rawBody: body, getKey, nowSec: now + 600 }), /too old/);
  const forged = `${h}.${p}.${Buffer.alloc(64).toString('base64url')}`;
  await assert.rejects(verifyPlaidWebhook({ headers: { 'plaid-verification': forged }, rawBody: body, getKey }), /signature/);
});

test('plaid-sandbox: low available balance (accountsBalanceGet) defers the pull instead of overdrawing', async (t) => {
  const stub = stubPlaid();
  stub.__available = 50; // $50 available, $11.11 pull, $100 default buffer -> defer
  const h = await startApp(env, { plaidClient: stub });
  t.after(h.close);
  const { call } = h;
  const { data: { publicToken } } = await call('/api/link/sandbox-public-token', {});
  await call('/api/link/exchange', { publicToken });
  let st = (await call('/api/state')).data;
  const [chk, sav] = st.accounts;
  await call('/api/accounts/roles', { fundingAccountId: chk.id, destinationAccountId: sav.id });
  await call('/api/schedule', { amountCents: 1111, frequency: 'weekly', anchorDate: st.today });
  await call('/api/benefit-ack', { accepted: true, version: st.benefitWarning.version });
  const text = (await call('/api/authorization/text', { signerName: 'Lance Test' })).data;
  await call('/api/authorization', { accepted: true, textHash: text.textHash, signerName: 'Lance Test' });
  await call('/api/scheduler/run', {});
  st = (await call('/api/state')).data;
  assert.equal(st.transfers.length, 0);
  assert.ok(!stub.calls.some((c) => c[0] === 'transferCreate'), 'no transfer created');
  assert.equal(st.schedule.periods[0].status, 'deferred');
  assert.match(st.schedule.periods[0].reasons[0].reason, /safety buffer/);
});
