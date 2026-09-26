// Go Blind passcode for the static demo (there is no server, so no app passcode).
// Stored ONLY as a salted PBKDF2-SHA256 hash ("pbkdf2$<iterations>$<salt b64>$<hash b64>") inside the
// demo's localStorage state. Uses WebCrypto (globalThis.crypto.subtle) so it runs in browsers and Node 20.
// Demo only: clearing site data removes the state and with it the passcode (and Go Blind).
export const PBKDF2_ITERATIONS = 310000;
const enc = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function validBlindPasscode(p) { return /^\d{4,12}$/.test(String(p ?? '')); }

async function derive(passcode, salt, iterations) {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', enc.encode(String(passcode)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashBlindPasscode(passcode, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (!validBlindPasscode(passcode)) throw new Error('Go Blind passcode must be 4 to 12 digits.');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(await derive(passcode, salt, iterations))}`;
}

export async function verifyBlindPasscode(passcode, stored) {
  if (typeof stored !== 'string' || passcode == null) return false;
  const [kind, it, salt, hash] = stored.split('$');
  const iterations = Number(it);
  if (kind !== 'pbkdf2' || !Number.isInteger(iterations) || iterations < 1000 || !salt || !hash) return false;
  const got = await derive(passcode, unb64(salt), iterations), want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];   // constant-time compare
  return diff === 0;
}
