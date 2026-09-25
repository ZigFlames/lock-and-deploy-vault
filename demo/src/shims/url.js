export const fileURLToPath = (u) => String(u || '/demo/server/x.js').replace(/^file:\/\//, '');
export default { fileURLToPath };
