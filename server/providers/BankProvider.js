// Provider adapter interface. Every bank-link / money-movement call goes through one of these.
// Amounts are integer cents. Dates are 'YYYY-MM-DD'. Statuses are normalised to:
//   pending | posted | settled | returned | failed | cancelled
//
// Scheduling (pause/resume) is owned by the app's scheduler (server/service.js), not the provider:
// benefit-day + business-day rules don't map onto provider recurring products, and keeping it in the app
// means "pause" can never touch money that already moved. Providers still expose pauseSchedule/resumeSchedule
// so a future provider with native recurring transfers can mirror the state.
export class BankProvider {
  constructor({ id, label }) {
    this.id = id;
    this.label = label;
    this.sandbox = true;     // every provider in this prototype must be sandbox
    this.model = 'direct';   // 'direct' = debit lands in destination; 'ledger' = debit to ledger, then credit leg
  }
  /** Public, non-secret info for the browser (e.g. which Link UI to open). */
  clientConfig() { return { id: this.id, label: this.label, sandbox: this.sandbox, model: this.model }; }
  async createLinkToken(_args) { throw notImpl('createLinkToken'); }
  async exchangePublicToken(_args) { throw notImpl('exchangePublicToken'); } // -> { providerItemId, accessToken, institutionName }
  async listAccounts(_args) { throw notImpl('listAccounts'); }               // -> [{ providerAccountId, name, mask, subtype }]
  async createTransferAuthorization(_args) { throw notImpl('createTransferAuthorization'); } // -> { authorizationId, decision, rationale }
  async createTransfer(_args) { throw notImpl('createTransfer'); }           // -> { providerTransferId, status }
  async getTransfers(_ids) { throw notImpl('getTransfers'); }                // -> [{ providerTransferId, status, failureReason, cancellable }]
  async cancelTransfer(_id) { throw notImpl('cancelTransfer'); }             // -> { status }
  /** Available balance for overdraft protection. Return null if the provider can't tell. */
  async getBalance(_args) { return null; }                                   // -> { availableCents, currentCents, source } | null
  async pauseSchedule() { return { handledBy: 'app' }; }
  async resumeSchedule() { return { handledBy: 'app' }; }
  async simulate(_id, _event) { throw notImpl('simulate'); }                 // sandbox-only status advance
  async tick(_today) { return []; }                                          // periodic sync; returns status updates
  async handleWebhook(_req) { return { accepted: false, updates: [] }; }
}

export function notImpl(m) { const e = new Error(`${m} is not implemented by this provider`); e.status = 501; return e; }
export class ProviderError extends Error {
  constructor(message, { status = 502, code = 'provider_error', detail } = {}) { super(message); this.status = status; this.code = code; this.detail = detail; }
}
