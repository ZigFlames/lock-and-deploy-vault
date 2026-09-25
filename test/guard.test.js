import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSandboxOnly, buildConfig, ProductionGuardError, REAL_MONEY_ENABLED } from '../server/config.js';
import { PlaidSandboxProvider, PlaidNotConfiguredError } from '../server/providers/plaidSandbox.js';

test('REAL_MONEY_ENABLED is hard-coded false', () => assert.equal(REAL_MONEY_ENABLED, false));

test('defaults to mock', () => assert.equal(assertSandboxOnly({}), 'mock'));

const refused = {
  'PLAID_ENV=production': { PROVIDER: 'plaid-sandbox', PLAID_ENV: 'production' },
  'PLAID_ENV=development in mock mode': { PLAID_ENV: 'development' },
  'unknown provider': { PROVIDER: 'plaid' },
  'stripe provider': { PROVIDER: 'stripe-live' },
  'plaid-sandbox without PLAID_ENV': { PROVIDER: 'plaid-sandbox' },
  'Stripe live key present': { STRIPE_SECRET_KEY: 'sk_live_123' },
  'Stripe restricted live key': { STRIPE_API_KEY: 'rk_live_abc' },
  'production host in a PLAID_ var': { PLAID_BASE_URL: 'https://production.plaid.com' },
  'ALLOW_PRODUCTION flag': { ALLOW_PRODUCTION: 'true' },
  'ENABLE_REAL_MONEY flag': { ENABLE_REAL_MONEY: '1' },
  'LIVE_MODE flag': { LIVE_MODE: 'yes' },
  'NODE_ENV=production': { NODE_ENV: 'production' },
};
for (const [name, env] of Object.entries(refused)) {
  test(`refuses: ${name}`, () => assert.throws(() => assertSandboxOnly(env), ProductionGuardError));
}

test('accepts plaid-sandbox with PLAID_ENV=sandbox', () => assert.equal(assertSandboxOnly({ PROVIDER: 'plaid-sandbox', PLAID_ENV: 'sandbox' }), 'plaid-sandbox'));

test('plaid-sandbox without keys fails with a clear message', () => {
  const config = buildConfig({ PROVIDER: 'plaid-sandbox', PLAID_ENV: 'sandbox' });
  assert.throws(() => new PlaidSandboxProvider({ config }), (e) => e instanceof PlaidNotConfiguredError && /PLAID_CLIENT_ID/.test(e.message) && /PLAID_SECRET/.test(e.message));
});
