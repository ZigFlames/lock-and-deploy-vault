// Configuration + the production guard.
//
// This prototype is SANDBOX ONLY. There is deliberately no setting that turns real money on.
// `assertSandboxOnly()` runs before the server starts listening and throws on anything that
// looks like a production configuration. See README "Production guard".
import fs from 'node:fs';
import path from 'node:path';

export const REAL_MONEY_ENABLED = false; // Hard-coded. Not read from env. Changing it is a code change.
export const PLAID_SANDBOX_URL = 'https://sandbox.plaid.com';
export const SUPPORTED_PROVIDERS = ['mock', 'plaid-sandbox'];

// Env vars that someone might set hoping to "flip to live". Setting any of them refuses startup.
const FORBIDDEN_FLAGS = ['ALLOW_PRODUCTION', 'ENABLE_PRODUCTION', 'ENABLE_REAL_MONEY', 'REAL_MONEY', 'LIVE_MODE', 'PRODUCTION'];

export class ProductionGuardError extends Error {
  constructor(msg) { super(`[production-guard] ${msg}`); this.name = 'ProductionGuardError'; }
}

/** Minimal .env loader (no dependency). Existing process env wins. */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

/** Throws ProductionGuardError if the environment is anything other than mock / sandbox. */
export function assertSandboxOnly(env) {
  const provider = (env.PROVIDER || 'mock').trim();
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new ProductionGuardError(`PROVIDER="${provider}" is not allowed. Only ${SUPPORTED_PROVIDERS.join(', ')} exist in this prototype.`);
  }
  if (env.PLAID_ENV !== undefined && env.PLAID_ENV !== '' && env.PLAID_ENV !== 'sandbox') {
    throw new ProductionGuardError(`PLAID_ENV="${env.PLAID_ENV}" refused. Only "sandbox" is allowed; the Plaid host is hard-coded to ${PLAID_SANDBOX_URL}.`);
  }
  if (provider === 'plaid-sandbox' && env.PLAID_ENV !== 'sandbox') {
    throw new ProductionGuardError('PROVIDER=plaid-sandbox requires PLAID_ENV=sandbox to be set explicitly.');
  }
  for (const [k, v] of Object.entries(env)) {
    if (/^STRIPE_/.test(k) && typeof v === 'string' && /^(sk|rk|pk)_live_/.test(v.trim())) {
      throw new ProductionGuardError(`${k} holds a Stripe LIVE key. Live keys are refused (and Stripe is not used by this prototype).`);
    }
    if (/^PLAID_/.test(k) && typeof v === 'string' && /production\.plaid\.com/i.test(v)) {
      throw new ProductionGuardError(`${k} points at production.plaid.com. Refused.`);
    }
  }
  for (const f of FORBIDDEN_FLAGS) {
    if (env[f] !== undefined && env[f] !== '') {
      throw new ProductionGuardError(`${f} is set. Production is hard-disabled in this prototype; no flag can enable it. Remove ${f}.`);
    }
  }
  if ((env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new ProductionGuardError('NODE_ENV=production refused. This is a sandbox-only prototype.');
  }
  if (REAL_MONEY_ENABLED !== false) {
    throw new ProductionGuardError('REAL_MONEY_ENABLED must be false in this prototype.');
  }
  return provider;
}

export function buildConfig(env = process.env) {
  const provider = assertSandboxOnly(env);
  const host = env.HOST || '127.0.0.1';
  return {
    provider,
    host,
    port: Number(env.PORT || 5180),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    tokenKey: env.TOKEN_ENCRYPTION_KEY || '',
    schedulerIntervalSec: Number(env.SCHEDULER_INTERVAL_SECONDS || 60),
    demoClock: env.DEMO_CLOCK !== '0',
    // Simulated clock: SIM_DATE=YYYY-MM-DD pins the base date (tests / `npm run tick`); the demo clock offset is added on top.
    simDate: /^\d{4}-\d{2}-\d{2}$/.test(env.SIM_DATE || '') ? env.SIM_DATE : null,
    notify: { webhookUrl: env.NOTIFY_WEBHOOK_URL || '', webhookSecret: env.NOTIFY_WEBHOOK_SECRET || '' },
    plaid: {
      clientId: env.PLAID_CLIENT_ID || '',
      secret: env.PLAID_SECRET || '',
      env: env.PLAID_ENV || '',
      webhookUrl: env.PLAID_WEBHOOK_URL || '',
      legalName: env.PLAID_LEGAL_NAME || 'Sandbox Tester',
      verifyWebhooks: env.PLAID_VERIFY_WEBHOOKS !== '0',
    },
    realMoneyEnabled: REAL_MONEY_ENABLED,
    loopbackOnly: ['127.0.0.1', 'localhost', '::1'].includes(host),
  };
}
