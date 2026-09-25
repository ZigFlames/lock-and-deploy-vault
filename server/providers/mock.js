// Offline mock provider. No network, no keys. Two fictional banks, fake tokens, and transfers that move
// through pending -> posted -> settled on business days of the demo clock (or on demand via simulate()).
// Magic amounts mirror Plaid Sandbox: $22.22 fails, $33.33 settles then returns R01.
import crypto from 'node:crypto';
import { BankProvider, ProviderError } from './BankProvider.js';
import { addBusinessDays } from '../dates.js';

export const MOCK_BANKS = [
  { id: 'mock_goldcoast', name: 'Gold Coast Credit Union', accounts: [
    { providerAccountId: 'gc_chk_4821', name: 'Everyday Checking', mask: '4821', subtype: 'checking' },
    { providerAccountId: 'gc_sav_1177', name: 'Rainy Day Savings', mask: '1177', subtype: 'savings' },
  ] },
  { id: 'mock_harbor', name: 'Harbor National Bank', accounts: [
    { providerAccountId: 'hn_sav_9034', name: 'Goal Savings', mask: '9034', subtype: 'savings' },
    { providerAccountId: 'hn_chk_2210', name: 'Basic Checking', mask: '2210', subtype: 'checking' },
  ] },
];

const ORDER = ['pending', 'posted', 'settled'];
const rand = () => crypto.randomBytes(6).toString('hex');

export class MockProvider extends BankProvider {
  constructor({ store, today, fundingBalanceCents = () => 150000 }) {
    super({ id: 'mock', label: 'Mock bank (offline demo)' });
    this.store = store;
    this.today = today; // () => 'YYYY-MM-DD' (demo clock)
    this.fundingBalanceCents = fundingBalanceCents; // configurable (Settings > Sandbox: mock funding balance)
  }
  get db() { return this.store.state.mock; }
  clientConfig() { return { ...super.clientConfig(), banks: MOCK_BANKS.map(({ id, name, accounts }) => ({ id, name, accounts: accounts.map(({ name, mask, subtype }) => ({ name, mask, subtype })) })) }; }

  async createLinkToken({ role }) { return { linkToken: `mock-link-${role || 'any'}-${rand()}`, expiresInSec: 1800 }; }

  async exchangePublicToken({ publicToken }) {
    const m = /^mock-public-(mock_[a-z]+)-[0-9a-f]+$/.exec(publicToken || '');
    const bank = m && MOCK_BANKS.find((b) => b.id === m[1]);
    if (!bank) throw new ProviderError('Invalid mock public token', { status: 400, code: 'invalid_public_token' });
    return { providerItemId: `mock_item_${rand()}`, accessToken: `mock-access-${bank.id}-${rand()}`, institutionName: bank.name };
  }

  async listAccounts({ accessToken }) {
    const bank = MOCK_BANKS.find((b) => accessToken.startsWith(`mock-access-${b.id}-`));
    if (!bank) throw new ProviderError('Unknown mock access token', { status: 400 });
    return bank.accounts.map((a) => ({ ...a, institutionName: bank.name }));
  }

  /** Configured balance minus debits still in flight (a steady account that benefits refill each month). */
  async getBalance() {
    const inFlight = Object.values(this.db.transfers).filter((t) => t.direction === 'debit' && ['pending', 'posted'].includes(t.status)).reduce((n, t) => n + t.amountCents, 0);
    const current = this.fundingBalanceCents();
    return { availableCents: current - inFlight, currentCents: current, source: 'mock' };
  }

  async createTransferAuthorization({ amountCents }) {
    if (amountCents > 500000) return { authorizationId: null, decision: 'declined', rationale: 'Mock limit: $5,000 per transfer' };
    return { authorizationId: `mock_auth_${rand()}`, decision: 'approved', rationale: null };
  }

  async createTransfer({ amountCents, direction, idempotencyKey }) {
    const existing = Object.values(this.db.transfers).find((t) => t.idempotencyKey && t.idempotencyKey === idempotencyKey);
    if (existing) return { providerTransferId: existing.id, status: existing.status };
    const id = `mock_tr_${rand()}`;
    this.db.transfers[id] = { id, amountCents, direction, status: 'pending', createdOn: this.today(), idempotencyKey, failureReason: null, manual: false };
    return { providerTransferId: id, status: 'pending' };
  }

  async getTransfers(ids) {
    return ids.map((id) => this.db.transfers[id]).filter(Boolean).map((t) => ({
      providerTransferId: t.id, status: t.status, failureReason: t.failureReason, cancellable: t.status === 'pending',
    }));
  }

  async cancelTransfer(id) {
    const t = this.db.transfers[id];
    if (!t) throw new ProviderError('No such transfer', { status: 404 });
    if (t.status !== 'pending') throw new ProviderError(`Transfer is ${t.status}; only pending transfers can be cancelled`, { status: 409, code: 'not_cancellable' });
    t.status = 'cancelled';
    return { status: 'cancelled' };
  }

  async simulate(id, event, returnCode = 'R01') {
    const t = this.db.transfers[id];
    if (!t) throw new ProviderError('No such transfer', { status: 404 });
    const allowed = { posted: ['pending'], settled: ['pending', 'posted'], returned: ['posted', 'settled'], failed: ['pending'] };
    if (!allowed[event]) throw new ProviderError(`Unknown event ${event}`, { status: 400 });
    if (!allowed[event].includes(t.status)) throw new ProviderError(`Cannot move ${t.status} -> ${event}`, { status: 409 });
    t.status = event;
    t.manual = true;
    if (event === 'returned') t.failureReason = { achReturnCode: returnCode, description: returnCode === 'R01' ? 'Insufficient funds' : 'Returned' };
    if (event === 'failed') t.failureReason = { description: 'Simulated failure' };
    return { status: t.status };
  }

  /** Advance automatic statuses based on the demo clock. */
  async tick(today) {
    const updates = [];
    const rank = (st) => ORDER.indexOf(st);
    for (const t of Object.values(this.db.transfers)) {
      if (!ORDER.includes(t.status)) continue; // returned / failed / cancelled are terminal
      const before = t.status;
      let target = t.status;
      if (t.amountCents === 2222) {
        if (t.status === 'pending' && today >= addBusinessDays(t.createdOn, 1)) { t.status = 'failed'; t.failureReason = { description: 'Simulated failure ($22.22)' }; }
      } else {
        if (today >= addBusinessDays(t.createdOn, 1)) target = 'posted';
        if (today >= addBusinessDays(t.createdOn, 2)) target = 'settled';
        if (rank(target) > rank(t.status)) t.status = target; // only ever move forward
        if (t.amountCents === 3333 && t.status === 'settled' && today >= addBusinessDays(t.createdOn, 3)) { t.status = 'returned'; t.failureReason = { achReturnCode: 'R01', description: 'Insufficient funds ($33.33)' }; }
      }
      if (t.status !== before) updates.push({ providerTransferId: t.id, status: t.status, failureReason: t.failureReason });
    }
    return updates;
  }
}
