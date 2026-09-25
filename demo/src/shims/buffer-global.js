// Injected into every bundled module: a Buffer global (npm "buffer") with base64url support.
import { Buffer as B } from 'buffer';
let hasB64url = false;
try { hasB64url = B.from('?>', 'utf8').toString('base64url') === 'Pz4'; } catch { hasB64url = false; }
if (!hasB64url) {
  const orig = B.prototype.toString;
  B.prototype.toString = function (enc, ...rest) {
    if (enc === 'base64url') return orig.call(this, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return orig.call(this, enc, ...rest);
  };
  const from = B.from;
  B.from = function (v, enc, ...rest) {
    if (enc === 'base64url' && typeof v === 'string') { v = v.replace(/-/g, '+').replace(/_/g, '/'); enc = 'base64'; }
    return from.call(B, v, enc, ...rest);
  };
}
export const Buffer = B;
export const process = { pid: 1, env: {}, cwd: () => '/' };
