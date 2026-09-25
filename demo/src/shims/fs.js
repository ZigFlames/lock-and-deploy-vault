// The only file the shared server code reads at import time is config/default-settings.json; it is bundled.
import defaults from '../../../config/default-settings.json';
const nope = (what) => () => { throw new Error(`fs.${what} is not available in the browser demo`); };
export function readFileSync(p) {
  if (String(p).endsWith('default-settings.json')) return JSON.stringify(defaults);
  throw new Error(`fs.readFileSync(${p}) is not available in the browser demo`);
}
export const existsSync = () => false;
export const mkdirSync = () => {};
export const writeFileSync = nope('writeFileSync');
export const renameSync = nope('renameSync');
export const openSync = nope('openSync');
export const statSync = nope('statSync');
export default { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, openSync, statSync };
