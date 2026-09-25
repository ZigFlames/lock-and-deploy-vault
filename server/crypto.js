// AES-256-GCM encryption for provider access tokens at rest.
// Key: TOKEN_ENCRYPTION_KEY = 32 random bytes, base64 (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
// If no key is set, a local dev key is generated at DATA_DIR/.dev-token-key (mode 0600). That is fine for
// mock/sandbox tokens but NOT acceptable for anything real: use a key from a secrets manager instead.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function loadKey(configured, dataDir, log = console) {
  if (configured) {
    const buf = Buffer.from(configured, 'base64');
    if (buf.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
    return { key: buf, source: 'env' };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const f = path.join(dataDir, '.dev-token-key');
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    log.warn?.(`[crypto] TOKEN_ENCRYPTION_KEY not set; generated a local dev key at ${f} (sandbox use only).`);
  }
  return { key: Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64'), source: 'dev-file' };
}

export function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(key, blob) {
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
