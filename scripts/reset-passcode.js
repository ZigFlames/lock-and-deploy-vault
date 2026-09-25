// Local recovery for the APP passcode (not your bank!): `npm run reset-passcode`.
// Needs shell access to DATA_DIR. Clears the passcode + sessions and revokes all bot keys, so the next visit
// asks for a new passcode. The goal, lock, transfers and audit log are untouched, and nothing about the
// lock changes: a reset passcode does NOT unlock the vault.
import { buildConfig, loadDotEnv } from '../server/config.js';
import { Store } from '../server/store.js';
import { appendAudit } from '../server/audit.js';

const config = buildConfig({ ...loadDotEnv(), ...process.env });
const store = new Store(config.dataDir);
await store.withLock(async (s) => {
  s.userAuth = null; s.sessions = [];
  let n = 0; for (const k of s.botKeys) if (!k.revokedAt) { k.revokedAt = new Date().toISOString(); k.revokedReason = 'passcode_reset'; n++; }
  appendAudit(s.audit, { actor: 'local-shell', type: 'passcode_reset', detail: { botKeysRevoked: n, lockUnchanged: true }, clockDate: new Date().toLocaleDateString('en-CA') });
  console.log(`Passcode cleared; ${n} bot key(s) revoked. Open the app to set a new passcode. The lock is unchanged.`);
});
