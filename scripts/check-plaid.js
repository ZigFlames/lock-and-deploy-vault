// Plaid Sandbox readiness check.  `npm run check:plaid`
// Without keys: explains exactly what is missing and exits 2 (no network calls).
// With sandbox keys in .env: runs a short live SANDBOX smoke test (no Link UI needed):
//   /sandbox/public_token/create -> /item/public_token/exchange -> /accounts/get ->
//   /transfer/authorization/create ($11.11 debit) -> /transfer/create -> /sandbox/transfer/simulate (posted) -> /transfer/get
import { buildConfig, loadDotEnv, ProductionGuardError } from '../server/config.js';
import { PlaidSandboxProvider, PlaidNotConfiguredError } from '../server/providers/plaidSandbox.js';
import { emptyState } from '../server/store.js';

const env = { ...loadDotEnv(), ...process.env, PROVIDER: 'plaid-sandbox', PLAID_ENV: process.env.PLAID_ENV || loadDotEnv().PLAID_ENV || 'sandbox' };
try {
  const config = buildConfig(env);
  const provider = await PlaidSandboxProvider.create({ config, store: { state: emptyState(), save() {} } });
  console.log('Plaid client built against', provider.client.__basePath);
  const pub = await provider.sandboxPublicToken();
  const ex = await provider.exchangePublicToken({ publicToken: pub });
  const accts = await provider.listAccounts({ accessToken: ex.accessToken });
  console.log('Linked sandbox item', ex.providerItemId, 'accounts:', accts.map((a) => `${a.name} ••${a.mask}`).join(', '));
  const chk = accts.find((a) => a.subtype === 'checking') || accts[0];
  const auth = await provider.createTransferAuthorization({ accessToken: ex.accessToken, accountId: chk.providerAccountId, amountCents: 1111, direction: 'debit', legalName: config.plaid.legalName, idempotencyKey: `check-${Date.now()}` });
  console.log('Authorization:', auth.decision, auth.rationale || '');
  if (auth.decision !== 'approved') process.exit(1);
  const tr = await provider.createTransfer({ accessToken: ex.accessToken, accountId: chk.providerAccountId, authorizationId: auth.authorizationId, amountCents: 1111 });
  console.log('Transfer created:', tr.providerTransferId, tr.status);
  await provider.simulate(tr.providerTransferId, 'posted');
  const [got] = await provider.getTransfers([tr.providerTransferId]);
  console.log('After /sandbox/transfer/simulate posted:', got.status);
  console.log('\nPlaid Sandbox OK. Set PROVIDER=plaid-sandbox in .env and run `npm start`.');
} catch (err) {
  if (err instanceof PlaidNotConfiguredError || err instanceof ProductionGuardError) {
    console.error(`\nPlaid Sandbox not ready.\n${err.message}\n`);
    process.exit(2);
  }
  console.error('\nPlaid Sandbox smoke test failed:', err.message, err.detail ? JSON.stringify(err.detail) : '');
  if (err.code === 'INVALID_API_KEYS') console.error('Check that PLAID_SECRET is the *Sandbox* secret.');
  if (/PRODUCT_NOT_ENABLED|not enabled/i.test(err.message)) console.error('Transfer may need enabling for your team in Sandbox; contact Plaid support (see docs: plaid.com/docs/transfer/sandbox/).');
  process.exit(1);
}
