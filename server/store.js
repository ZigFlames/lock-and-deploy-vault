// JSON-file store with atomic writes and a cross-process lock.
// Holds only provider tokens (encrypted) and IDs, account names + masks, goal/schedule/authorization records,
// transfers, approvals, hashed bot keys, a hashed unlock code, and the append-only audit chain.
// Never bank usernames, passwords, full account numbers or routing numbers.
//
// Concurrency: every mutation runs inside store.withLock(fn):
//   1. an in-process promise queue (so the timer and HTTP requests never interleave), then
//   2. an exclusive lock file DATA_DIR/db.lock (open 'wx'), so a second server or `npm run tick`
//      process on the same data dir waits instead of racing, then
//   3. db.json is re-read from disk, fn runs, and the state is saved atomically (tmp + rename).
// Stale lock files (a crashed process) are broken after LOCK_STALE_MS.
import fs from 'node:fs';
import path from 'node:path';
import { emptyBlind } from './blind.js';

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 60_000;
export const STATE_VERSION = 2;

export function emptyState() {
  return {
    version: STATE_VERSION,
    items: [],            // { id, provider, institutionName, accessTokenEnc, providerItemId, createdAt }
    accounts: [],         // { id, itemId, providerAccountId, name, mask, subtype, institutionName }
    roles: { fundingAccountId: null, destinationAccountId: null },
    goal: null,           // see Service.newGoal()
    cycles: [],           // closed goal cycles (history of every lock -> unlock -> rollover)
    schedule: null,       // { id, amountCents, frequency, ..., status, cursor, activatedAt }
    periods: {},          // idempotency ledger: `${scheduleId}:${date}` -> { status, attempts, reasons, transferId }
    authorization: null,  // { id, status, text, textHash, acceptedAt, ip, userAgent, snapshot }
    authorizationHistory: [],
    benefitAck: null,     // { version, acceptedAt }
    transfers: [],        // pulls (newest first)
    withdrawals: [],      // simulated withdrawals out of the vault (ledger records only)
    vault: { code: null, revealBlob: null }, // unlock code: salted scrypt hash only (+ one-time reveal blob)
    hardship: null,       // { id, status: cooling_off|cancelled|completed, requestedOn, availableOn, amountCents }
    settings: {},         // overrides of config/default-settings.json
    notifications: [],    // in-app banners
    approvals: [],        // bot-created requests awaiting the user
    botKeys: [],          // { id, name, scopes, secretHash, createdAt, lastUsedAt, revokedAt }
    botActivity: [],      // every bot API call
    userAuth: null,       // { passcodeHash, createdAt }
    sessions: [],         // { idHash, createdAt, expiresAt }
    audit: [],            // append-only, hash-chained (oldest first)
    blind: emptyBlind(),  // Go Blind: { on, stayUntilGoal, stayGoalId, failures, lockedUntil, passcodeHash (demo only) }
    clock: { offsetDays: 0 },
    mock: { transfers: {} },
    plaid: { eventCursor: 0 },
  };
}

/** Upgrade a phase-1 db.json (version 1) in place. */
export function migrate(raw) {
  const s = { ...emptyState(), ...raw };
  if (!raw.version || raw.version < 2) {
    const old = Array.isArray(raw.audit) ? [...raw.audit].reverse() : []; // v1 stored newest first
    s.audit = [];
    s.__legacyAudit = old;
    if (raw.goal && !raw.goal.id) s.goal = { __legacy: true, ...raw.goal };
    s.version = STATE_VERSION;
  }
  for (const k of ['periods', 'vault', 'settings', 'clock', 'mock', 'plaid', 'blind']) if (!s[k] || typeof s[k] !== 'object') s[k] = emptyState()[k];
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.lockFile = path.join(dataDir, 'db.lock');
    fs.mkdirSync(dataDir, { recursive: true });
    this.queue = Promise.resolve();
    this.held = false;
    this.load();
  }
  load() {
    this.state = fs.existsSync(this.file) ? migrate(JSON.parse(fs.readFileSync(this.file, 'utf8'))) : emptyState();
  }
  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  reset() { this.state = emptyState(); this.save(); }

  async acquireFileLock() {
    const start = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx', 0o600);
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        fs.closeSync(fd);
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const age = Date.now() - fs.statSync(this.lockFile).mtimeMs;
          if (age > LOCK_STALE_MS) { fs.rmSync(this.lockFile, { force: true }); continue; }
        } catch { continue; }
        if (Date.now() - start > LOCK_TIMEOUT_MS) throw Object.assign(new Error('Timed out waiting for db.lock'), { status: 503, code: 'busy' });
        await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
      }
    }
  }
  releaseFileLock() { fs.rmSync(this.lockFile, { force: true }); }

  /** Run fn with exclusive access to fresh state; state is saved afterwards (even if fn throws). */
  withLock(fn) {
    const run = async () => {
      await this.acquireFileLock();
      this.held = true;
      try {
        this.load();
        return await fn(this.state);
      } finally {
        try { this.save(); } finally { this.held = false; this.releaseFileLock(); }
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}
