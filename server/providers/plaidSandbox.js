// Plaid SANDBOX adapter: Link + Auth/Transfer + /sandbox/transfer/simulate.
// Activated only when PROVIDER=plaid-sandbox, PLAID_ENV=sandbox, PLAID_CLIENT_ID and PLAID_SECRET are set.
//
// The Plaid host is HARD-CODED to https://sandbox.plaid.com (never read from env) and re-checked before
// every call. A production secret sent to the sandbox host simply fails authentication.
//
// Money model (Plaid Transfer): a debit pulls from the linked funding account into the originator's
// Plaid Ledger; a separate credit pays out from the Ledger to the destination account. So this adapter is
// model 'ledger' and the service creates the credit leg after the debit settles.
// NOTE: Plaid's docs state Transfer "does not support peer to peer transfers or transfers between two
// accounts held by the same person" in production (https://plaid.com/docs/transfer/creating-transfers/).
// This adapter exists to exercise the flow in Sandbox only.
import crypto from 'node:crypto';
import { BankProvider, ProviderError } from './BankProvider.js';
import { PLAID_SANDBOX_URL } from '../config.js';

export class PlaidNotConfiguredError extends Error {
  constructor(missing) {
    super(`Plaid Sandbox is not configured: missing ${missing.join(', ')}. ` +
      'Create a free Plaid account, copy the Sandbox client_id and secret from Dashboard > Developers > Keys into .env ' +
      '(PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV=sandbox), or run with PROVIDER=mock.');
    this.name = 'PlaidNotConfiguredError';
    this.missing = missing;
  }
}

const STATUS_MAP = { pending: 'pending', posted: 'posted', settled: 'settled', funds_available: 'settled', returned: 'returned', failed: 'failed', cancelled: 'cancelled' };
const dollars = (cents) => (cents / 100).toFixed(2);

export async function createPlaidClient({ clientId, secret }) {
  const plaid = await import('plaid').catch(() => { throw new Error('The "plaid" npm package is not installed. Run `npm install`.'); });
  if (plaid.PlaidEnvironments.sandbox !== PLAID_SANDBOX_URL) throw new Error('Unexpected Plaid sandbox URL in client library');
  const configuration = new plaid.Configuration({
    basePath: PLAID_SANDBOX_URL, // hard-coded sandbox host
    baseOptions: { headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret, 'Plaid-Version': '2020-09-14' }, timeout: 20000 },
  });
  const client = new plaid.PlaidApi(configuration);
  client.__basePath = configuration.basePath;
  return client;
}

export class PlaidSandboxProvider extends BankProvider {
  /** @param {{config:any, client?:any}} opts  client is injectable for tests */
  constructor({ config, client, store }) {
    super({ id: 'plaid-sandbox', label: 'Plaid Sandbox' });
    const missing = [];
    if (!config.plaid.clientId) missing.push('PLAID_CLIENT_ID');
    if (!config.plaid.secret) missing.push('PLAID_SECRET');
    if (config.plaid.env !== 'sandbox') missing.push('PLAID_ENV=sandbox');
    if (missing.length) throw new PlaidNotConfiguredError(missing);
    this.config = config;
    this.client = client || null;
    this.store = store;
    this.model = 'ledger';
    this.keyCache = new Map();
  }
  static async create(opts) {
    const p = new PlaidSandboxProvider(opts);
    if (!p.client) p.client = await createPlaidClient(opts.config.plaid);
    return p;
  }
  clientConfig() { return { ...super.clientConfig(), linkScript: 'https://cdn.plaid.com/link/v2/stable/link-initialize.js', sandboxSkipLink: true }; }

  assertSandbox() {
    const base = this.client?.__basePath;
    if (base && base !== PLAID_SANDBOX_URL) throw new ProviderError(`Refusing Plaid call: host ${base} is not the sandbox`, { status: 500, code: 'production_guard' });
  }
  async call(method, body) {
    this.assertSandbox();
    try {
      const res = await this.client[method](body);
      return res.data;
    } catch (err) {
      const d = err?.response?.data;
      if (d?.error_code) throw new ProviderError(`Plaid ${method}: ${d.error_code}: ${d.error_message}`, { status: err.response.status || 502, code: d.error_code, detail: { request_id: d.request_id, error_type: d.error_type } });
      throw new ProviderError(`Plaid ${method} failed: ${err.message}`);
    }
  }

  async createLinkToken({ userId, role }) {
    const body = {
      user: { client_user_id: userId },
      client_name: 'Lock & Deploy (sandbox)',
      products: ['transfer'],
      country_codes: ['US'],
      language: 'en',
      account_filters: { depository: { account_subtypes: ['checking', 'savings'] } },
    };
    if (this.config.plaid.webhookUrl) body.webhook = this.config.plaid.webhookUrl;
    const d = await this.call('linkTokenCreate', body);
    return { linkToken: d.link_token, expiration: d.expiration, role };
  }

  /** Sandbox-only shortcut that skips the Link UI (First Platypus Bank, user_good). */
  async sandboxPublicToken(institutionId = 'ins_109508') {
    const d = await this.call('sandboxPublicTokenCreate', { institution_id: institutionId, initial_products: ['transfer'] });
    return d.public_token;
  }

  async exchangePublicToken({ publicToken, metadata }) {
    const d = await this.call('itemPublicTokenExchange', { public_token: publicToken });
    return { providerItemId: d.item_id, accessToken: d.access_token, institutionName: metadata?.institution?.name || 'Plaid Sandbox bank' };
  }

  async listAccounts({ accessToken }) {
    const d = await this.call('accountsGet', { access_token: accessToken });
    const inst = d.item?.institution_name || d.item?.institution_id || 'Plaid Sandbox bank';
    return d.accounts.filter((a) => a.type === 'depository').map((a) => ({ providerAccountId: a.account_id, name: a.name, mask: a.mask, subtype: a.subtype, institutionName: inst }));
  }

  /** /accounts/balance/get (real-time balance). The Transfer authorization decision is the second line of defence. */
  async getBalance({ accessToken, accountId }) {
    const d = await this.call('accountsBalanceGet', { access_token: accessToken, options: { account_ids: [accountId] } });
    const a = (d.accounts || []).find((x) => x.account_id === accountId);
    if (!a) return null;
    const toC = (v) => (v == null ? null : Math.round(Number(v) * 100));
    return { availableCents: toC(a.balances?.available ?? a.balances?.current), currentCents: toC(a.balances?.current), source: 'plaid:/accounts/balance/get' };
  }

  async createTransferAuthorization({ accessToken, accountId, amountCents, direction, legalName, idempotencyKey }) {
    const d = await this.call('transferAuthorizationCreate', {
      access_token: accessToken,
      account_id: accountId,
      type: direction,               // 'debit' pulls from funding; 'credit' pays out to destination
      network: 'ach',
      amount: dollars(amountCents),
      ach_class: direction === 'debit' ? 'web' : 'ppd',
      user: { legal_name: legalName || this.config.plaid.legalName },
      idempotency_key: idempotencyKey,
      user_present: false,
    });
    const a = d.authorization;
    return { authorizationId: a.id, decision: a.decision, rationale: a.decision_rationale ? `${a.decision_rationale.code}: ${a.decision_rationale.description}` : null };
  }

  async createTransfer({ accessToken, accountId, authorizationId, amountCents, description = 'TRANSFER', metadata }) {
    const d = await this.call('transferCreate', {
      access_token: accessToken,
      account_id: accountId,
      authorization_id: authorizationId,
      amount: dollars(amountCents),
      description: String(description).slice(0, 10), // ACH descriptions are max 10 chars
      metadata,
    });
    return { providerTransferId: d.transfer.id, status: STATUS_MAP[d.transfer.status] || d.transfer.status };
  }

  async getTransfers(ids) {
    const out = [];
    for (const id of ids) {
      const d = await this.call('transferGet', { transfer_id: id });
      const t = d.transfer;
      out.push({ providerTransferId: t.id, status: STATUS_MAP[t.status] || t.status, rawStatus: t.status, cancellable: !!t.cancellable,
        failureReason: t.failure_reason ? { achReturnCode: t.failure_reason.ach_return_code, description: t.failure_reason.description } : null });
    }
    return out;
  }

  async cancelTransfer(id) {
    await this.call('transferCancel', { transfer_id: id });
    return { status: 'cancelled' };
  }

  /** /sandbox/transfer/simulate, plus Ledger "available" so credit legs can be funded in Sandbox. */
  async simulate(id, event, returnCode = 'R01') {
    const body = { transfer_id: id, event_type: event };
    if (event === 'returned' || event === 'failed') body.failure_reason = { ach_return_code: returnCode, description: 'Simulated in sandbox' };
    await this.call('sandboxTransferSimulate', body);
    if (event === 'settled') await this.call('sandboxTransferLedgerSimulateAvailable', {});
    return { status: STATUS_MAP[event] || event };
  }

  /** Pull transfer events since the last cursor (/transfer/event/sync). */
  async tick() {
    const st = this.store.state.plaid;
    const d = await this.call('transferEventSync', { after_id: st.eventCursor || 0, count: 25 });
    const updates = [];
    for (const e of d.transfer_events || []) {
      st.eventCursor = Math.max(st.eventCursor || 0, e.event_id);
      if (STATUS_MAP[e.event_type]) updates.push({ providerTransferId: e.transfer_id, status: STATUS_MAP[e.event_type],
        failureReason: e.failure_reason ? { achReturnCode: e.failure_reason.ach_return_code, description: e.failure_reason.description } : null });
    }
    return updates;
  }

  /** Verify Plaid-Verification JWT (ES256), then sync events. */
  async handleWebhook({ headers, rawBody }) {
    if (this.config.plaid.verifyWebhooks) await verifyPlaidWebhook({ headers, rawBody, getKey: (kid) => this.getVerificationKey(kid) });
    const body = JSON.parse(rawBody || '{}');
    if (body.webhook_type === 'TRANSFER' && body.webhook_code === 'TRANSFER_EVENTS_UPDATE') return { accepted: true, updates: await this.tick() };
    return { accepted: true, updates: [] };
  }
  async getVerificationKey(kid) {
    if (!this.keyCache.has(kid)) {
      const d = await this.call('webhookVerificationKeyGet', { key_id: kid });
      this.keyCache.set(kid, d.key);
    }
    return this.keyCache.get(kid);
  }
}

const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Plaid webhook verification per https://plaid.com/docs/api/webhooks/webhook-verification/ */
export async function verifyPlaidWebhook({ headers, rawBody, getKey, nowSec = Math.floor(Date.now() / 1000) }) {
  const token = headers['plaid-verification'];
  if (!token) throw new ProviderError('Missing Plaid-Verification header', { status: 401, code: 'webhook_unverified' });
  const [h, p, s] = token.split('.');
  const header = JSON.parse(b64url(h).toString('utf8'));
  if (header.alg !== 'ES256') throw new ProviderError('Unexpected webhook JWT alg', { status: 401, code: 'webhook_unverified' });
  const jwk = await getKey(header.kid);
  if (!jwk || (jwk.expired_at && jwk.expired_at < nowSec)) throw new ProviderError('Webhook key missing or expired', { status: 401, code: 'webhook_unverified' });
  const pub = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64url(s));
  if (!ok) throw new ProviderError('Bad webhook signature', { status: 401, code: 'webhook_unverified' });
  const claims = JSON.parse(b64url(p).toString('utf8'));
  if (Math.abs(nowSec - claims.iat) > 300) throw new ProviderError('Webhook too old', { status: 401, code: 'webhook_unverified' });
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const a = Buffer.from(bodyHash), b = Buffer.from(String(claims.request_body_sha256 || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new ProviderError('Webhook body hash mismatch', { status: 401, code: 'webhook_unverified' });
  return claims;
}
