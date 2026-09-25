// Hashing helpers for secrets we must verify but never store: unlock codes, the user passcode, bot keys,
// session ids. Slow salted scrypt for human-chosen/short secrets; SHA-256 for 256-bit random secrets.
import crypto from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
export function newUnlockCode() {
  // 12 chars from a 31-char alphabet (~59 bits), rejection-sampled from crypto.randomBytes.
  let out = '';
  while (out.length < 12) {
    for (const b of crypto.randomBytes(16)) { if (b < 248 && out.length < 12) out += CODE_ALPHABET[b % 31]; }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}
export const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function scryptHash(secret) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(secret), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function scryptVerify(secret, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(String(secret), Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hash, 'base64');
  return want.length === h.length && crypto.timingSafeEqual(want, h);
}
export const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
