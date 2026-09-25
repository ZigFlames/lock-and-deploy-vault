// Service worker for the Lock & Deploy Vault simulation. Precaches the whole app so it works offline.
// Cache name changes on every build, so a new deploy replaces the old files.
const CACHE = 'ldb-vault-81ca4639ab';
const ASSETS = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon.svg",
  "./icons/maskable-512.png",
  "./icons/maskable.svg",
  "./js/app.js?v=81ca4639ab",
  "./js/engine.js?v=81ca4639ab",
  "./js/sw-register.js?v=81ca4639ab",
  "./manifest.webmanifest"
];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ldb-vault-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: false }).then((hit) => hit || caches.match(req, { ignoreSearch: true })).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && new URL(req.url).pathname.startsWith(new URL(self.registration.scope).pathname)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
