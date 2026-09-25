// Append-only, hash-chained audit log. Each entry's hash covers the previous hash, so deleting, editing or
// reordering any entry breaks verification (shown in the app). There is no API to delete or edit entries.
import { sha256 } from './crypto.js';

const body = (e) => JSON.stringify([e.seq, e.at, e.clockDate, e.actor, e.type, e.detail, e.prev]);
export function appendAudit(list, { actor = 'system', type, detail = {}, clockDate }) {
  const prev = list.length ? list[list.length - 1].hash : 'genesis';
  const e = { seq: list.length + 1, at: new Date().toISOString(), clockDate, actor, type, detail, prev };
  e.hash = sha256(body(e));
  list.push(e);
  return e;
}
export function verifyAudit(list) {
  let prev = 'genesis';
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.seq !== i + 1 || e.prev !== prev || e.hash !== sha256(body(e))) return { ok: false, brokenAt: i + 1 };
    prev = e.hash;
  }
  return { ok: true, entries: list.length };
}
