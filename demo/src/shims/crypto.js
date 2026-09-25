// Browser stand-in for the parts of node:crypto the server code uses. Same algorithms and output formats:
// SHA-256, HMAC-SHA256, scrypt (N=16384,r=8,p=1), AES-256-GCM, CSPRNG bytes (crypto.getRandomValues).
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { scrypt } from '@noble/hashes/scrypt';
import { gcm } from '@noble/ciphers/aes';

const bytes = (v, enc = 'utf8') => (typeof v === 'string' ? Buffer.from(v, enc) : Buffer.from(v));

export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) globalThis.crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return Buffer.from(out);
}
export const randomUUID = () => globalThis.crypto.randomUUID();

class Hash {
  constructor(make) { this.h = make(); }
  update(v, enc) { this.h.update(bytes(v, enc)); return this; }
  digest(enc) { const b = Buffer.from(this.h.digest()); return enc ? b.toString(enc) : b; }
}
export function createHash(alg) {
  if (alg !== 'sha256') throw new Error(`hash ${alg} not available in the browser demo`);
  return new Hash(() => sha256.create());
}
export function createHmac(alg, key) {
  if (alg !== 'sha256') throw new Error(`hmac ${alg} not available in the browser demo`);
  return new Hash(() => hmac.create(sha256, bytes(key)));
}
export function scryptSync(password, salt, keylen, opts = {}) {
  return Buffer.from(scrypt(bytes(password), bytes(salt), { N: opts.N || 16384, r: opts.r || 8, p: opts.p || 1, dkLen: keylen }));
}
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
export function createCipheriv(alg, key, iv) {
  if (alg !== 'aes-256-gcm') throw new Error(`${alg} not available`);
  const parts = []; let tag = null;
  return {
    update(v, enc) { parts.push(bytes(v, enc)); return Buffer.alloc(0); },
    final() { const out = gcm(bytes(key), bytes(iv)).encrypt(Buffer.concat(parts)); tag = Buffer.from(out.slice(-16)); return Buffer.from(out.slice(0, -16)); },
    getAuthTag() { return tag; },
  };
}
export function createDecipheriv(alg, key, iv) {
  if (alg !== 'aes-256-gcm') throw new Error(`${alg} not available`);
  const parts = []; let tag = null;
  return {
    setAuthTag(t) { tag = bytes(t); },
    update(v, enc) { parts.push(bytes(v, enc)); return Buffer.alloc(0); },
    final() { return Buffer.from(gcm(bytes(key), bytes(iv)).decrypt(Buffer.concat([...parts, tag]))); },
  };
}
export default { randomBytes, randomUUID, createHash, createHmac, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv };
