// Seal my login, browser demo: AES-256-GCM via WebCrypto, same "sl1.<iv>.<ciphertext||tag>" format and AAD as the
// server (server/sealed.js nodeSealCipher), so the two are interchangeable.
//
// The key is a NON-EXTRACTABLE CryptoKey kept in this browser's IndexedDB. JavaScript can't export its raw bytes,
// but honest limit: code running on this page (for example someone with DevTools on this device) can still ASK the
// browser to decrypt with it. A browser-only app has to keep its key on the device; see docs/SEALED_LOGIN.md.
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function createWebCryptoSealCipher(getKey, kind = 'aes-256-gcm (webcrypto, device key)') {
  const subtle = globalThis.crypto.subtle;
  return {
    kind,
    async encrypt(plaintext, aad) {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await getKey(), enc.encode(String(plaintext))));
      return `sl1.${b64(iv)}.${b64(ct)}`;
    },
    async decrypt(blob, aad) {
      const [v, iv, data] = String(blob).split('.');
      if (v !== 'sl1' || !iv || !data) throw new Error('Unknown sealed-login ciphertext');
      return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(aad) }, await getKey(), unb64(data)));
    },
  };
}

/** Device key: generated once, non-extractable, stored in IndexedDB (falls back to an in-memory key if IndexedDB is unavailable). */
export function indexedDbKeyLoader({ dbName = 'ldb-vault-demo-keys', store = 'keys', id = 'sealed-login-v1' } = {}) {
  let cached = null;
  const open = () => new Promise((res, rej) => { const r = indexedDB.open(dbName, 1); r.onupgradeneeded = () => r.result.createObjectStore(store); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = (db, mode, fn) => new Promise((res, rej) => { const t = db.transaction(store, mode); const q = fn(t.objectStore(store)); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); });
  return async () => {
    if (cached) return cached;
    cached = (async () => {
      const gen = () => globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      if (typeof indexedDB === 'undefined') return gen();
      const db = await open();
      let key = await tx(db, 'readonly', (s) => s.get(id));
      if (!key) { key = await gen(); await tx(db, 'readwrite', (s) => s.put(key, id)); }
      return key;
    })();
    return cached;
  };
}
