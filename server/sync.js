// Assistant sync for the STATIC demo (GitHub Pages has no server, so the phone's data lives only in that browser).
//
// Design (simplest secure option that works with a static site):
//  * The app makes a random SYNC CODE once: "ldbsync1.<channel>.<key>" (channel = 128-bit random id, key = 256-bit AES key).
//    The user gives this code to the assistant once (like a password). The key never goes to any server.
//  * "Sync now" in the app: it encrypts a read-only SNAPSHOT (status, schedule, approvals + decisions, monthly moves; no
//    secrets, amounts hidden while Go Blind is on) with AES-256-GCM and PUTs the ciphertext to a tiny RELAY at
//    /sync/v1/<channel>/app. It then GETs /sync/v1/<channel>/bot, decrypts the assistant's messages and applies only the
//    safe ones (propose / complete a monthly move, propose a faster deposit, pause). Proposals become normal pending
//    approvals: nothing runs until the user taps Approve.
//  * The relay stores opaque ciphertext only (it can see sizes and timing, not content). AES-GCM with the channel+slot as
//    associated data means a relay (or anyone who guesses the channel) can't forge or swap messages, only delete them.
//  * No relay hosted? "Download encrypted snapshot" saves the same ciphertext as a file the assistant can decrypt.
//  * The server version doesn't need any of this: the assistant reads /bot/v1/* (e.g. GET /bot/v1/snapshot) with a bot key.
// The relay is part of the server prototype (SYNC_RELAY=on). It is not hosted anywhere by this project.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';

export const SYNC_PREFIX = 'ldbsync1';
export const SLOTS = ['app', 'bot'];
export const SYNC_MAX_BYTES = 256 * 1024;
const CHANNEL_RE = /^[A-Za-z0-9_-]{22}$/;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
export const syncAad = (channel, slot) => `ldb-sync:v1:${channel}:${slot}`;

export function newSyncCode() { return `${SYNC_PREFIX}.${b64u(randomBytes(16))}.${b64u(randomBytes(32))}`; }
export function parseSyncCode(code) {
  const [p, channel, k] = String(code || '').trim().split('.');
  if (p !== SYNC_PREFIX || !CHANNEL_RE.test(channel || '') || !/^[A-Za-z0-9_-]{43}$/.test(k || '')) throw new AppError(400, 'bad_sync_code', 'That is not a valid sync code (it starts with ldbsync1.).');
  return { channel, key: fromB64u(k) };
}
/** Envelope: { v, alg, channel, slot, seq, at, iv, ct } — ct = AES-256-GCM(ciphertext || tag), AAD = syncAad(channel, slot). */
export function sealSync(obj, { channel, key }, slot, seq = Date.now()) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(syncAad(channel, slot)));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, alg: 'A256GCM', channel, slot, seq, at: new Date().toISOString(), iv: b64u(iv), ct: b64u(ct) };
}
export function openSync(env, { channel, key }, slot) {
  if (!env || env.v !== 1 || env.slot !== slot || env.channel !== channel) throw new AppError(400, 'bad_envelope', 'Not a sync envelope for this channel/slot.');
  const buf = fromB64u(env.ct), iv = fromB64u(env.iv);
  const d = createDecipheriv('aes-256-gcm', key, iv); d.setAAD(Buffer.from(syncAad(channel, slot))); d.setAuthTag(buf.subarray(buf.length - 16));
  try { return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8')); }
  catch { throw new AppError(400, 'decrypt_failed', 'Could not decrypt: wrong sync code or the data was changed.'); }
}

export { applyInbox, INBOX_TYPES } from './sync-inbox.js';

// ---------- the relay (server prototype only; stores ciphertext) ----------
export function createSyncRelay({ dataDir, allowedOrigins = [], maxBytes = SYNC_MAX_BYTES }) {
  const dir = path.join(dataDir, 'sync'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hits = new Map();
  const cors = (req) => {
    const o = req.headers.origin; const h = { 'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (o && (allowedOrigins.includes('*') || allowedOrigins.includes(o))) Object.assign(h, { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
    // Chrome's Private Network Access: an https page talking to a relay on this computer (127.0.0.1) needs this opt-in.
    if (h['Access-Control-Allow-Origin'] && req.headers['access-control-request-private-network'] === 'true') h['Access-Control-Allow-Private-Network'] = 'true';
    return h;
  };
  const send = (res, status, body, h) => { res.writeHead(status, { ...h, 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  return async function handle(req, res, url) {
    const m = /^\/sync\/v1\/([A-Za-z0-9_-]{22})\/(app|bot)$/.exec(url.pathname);
    const h = cors(req);
    if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
    if (!m) return send(res, 404, { error: 'not_found' }, h);
    const ip = req.socket.remoteAddress || '?', now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < 60_000); list.push(now); hits.set(ip, list);
    if (list.length > 120) return send(res, 429, { error: 'rate_limited' }, h);
    const file = path.join(dir, `${m[1]}.${m[2]}.json`);
    if (req.method === 'GET') { if (!fs.existsSync(file)) return send(res, 404, { error: 'empty' }, h); res.writeHead(200, { ...h, 'Content-Type': 'application/json' }); return res.end(fs.readFileSync(file)); }
    if (req.method !== 'PUT') return send(res, 405, { error: 'method_not_allowed' }, h);
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > maxBytes) return send(res, 413, { error: 'too_large' }, h); chunks.push(c); }
    let env; try { env = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'bad_json' }, h); }
    if (!env || env.v !== 1 || env.alg !== 'A256GCM' || env.channel !== m[1] || env.slot !== m[2] || typeof env.iv !== 'string' || typeof env.ct !== 'string') return send(res, 400, { error: 'bad_envelope' }, h);
    const clean = { v: 1, alg: 'A256GCM', channel: env.channel, slot: env.slot, seq: Number(env.seq) || 0, at: new Date().toISOString(), iv: env.iv.slice(0, 32), ct: env.ct };
    fs.writeFileSync(file, JSON.stringify(clean), { mode: 0o600 });
    return send(res, 200, { ok: true, storedAt: clean.at }, h);
  };
}
