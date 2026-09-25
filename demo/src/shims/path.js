const join = (...p) => p.filter(Boolean).join('/').replace(/\/+/g, '/');
export const resolve = (...p) => join(...p);
export const dirname = (p) => String(p).replace(/\/[^/]*$/, '') || '/';
export const normalize = (p) => p;
export const extname = (p) => (/\.[^./]*$/.exec(p) || [''])[0];
export { join };
export default { join, resolve, dirname, normalize, extname };
