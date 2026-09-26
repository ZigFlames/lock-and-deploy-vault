# Browser-only PWA demo

Live: **https://zigflames.com/lock-and-deploy-vault/** (installable: "Add to Home Screen" on iPhone, "Install app" on Android/desktop Chrome). Fictional money only. Everything runs and stays in your browser (localStorage); nothing is sent anywhere.

## How it reuses the prototype
`demo/src/browser-server.js` imports the prototype's own server modules and runs them in the page:

| Module | Used as-is in the browser |
|---|---|
| `server/service.js` | Engine, Hard Lock + loosening rules, vault/unlock code, Roll Over & Relock, hardship, approvals, emergency stop |
| `server/rules/index.js` | Goal cap + overdraft buffer (defer/skip) |
| `server/routes.js` | The user API route table (same one `server/app.js` serves over HTTP) |
| `server/bot.js` | Bot API: scopes, forbidden request types, rate limits, activity log |
| `server/providers/mock.js` | Mock bank (two fictional banks, pending → posted → settled) |
| `server/audit.js`, `settings.js`, `notifiers/`, `golive.js`, `schedule.js`, `dates.js`, `authorization.js` | Same |
| `public/js/app.js`, `public/css/styles.css` | Same UI (a `window.LDB_TRANSPORT` hook replaces `fetch`) |

Only three things are browser-specific: a `localStorage` store with the same interface as `server/store.js`, an in-page transport instead of HTTP, and small shims for `node:crypto` (SHA-256, HMAC, scrypt, AES-256-GCM via `@noble/*`, randomness via `crypto.getRandomValues`), `node:fs` (bundles `config/default-settings.json`), `node:path` and `node:url`. The build refuses to bundle the Plaid adapter.

## Build and test
```bash
cd demo && npm install && npm run build      # -> demo/dist (static files)
npm run serve                                 # http://127.0.0.1:4190/
python3 ../test/e2e_static.py https://zigflames.com/lock-and-deploy-vault/   # phone-size checks, local or live
python3 ../test/e2e_blind.py static https://zigflames.com/lock-and-deploy-vault/   # Go Blind checks, local or live
```
Deploy: push the contents of `demo/dist` to the `gh-pages` branch (GitHub Pages, legacy build, `.nojekyll`).

## Differences from the server version
| | Server prototype (`npm start`) | Static demo |
|---|---|---|
| Money | Mock or Plaid **Sandbox** (fake) | Mock only (fictional) |
| Storage | `data/db.json` + `db.lock` file lock | `localStorage` in this browser (per device; "Start over" in More wipes it) |
| Login | App passcode (scrypt), HttpOnly session cookie | None (data never leaves the browser) |
| Go Blind off | App passcode | Separate **Go Blind passcode** (4-12 digits), set the first time you turn Go Blind on. Stored only as a salted PBKDF2-SHA256 hash (310,000 iterations, WebCrypto; `demo/src/blind-passcode.js`) inside this browser's demo state. Same 5 tries / 15-minute lockout. **Demo note:** clearing the site's data resets everything, including the passcode and Go Blind. "Start over" is refused while Go Blind is on |
| Engine | Server timer + `npm run tick` (cron-able), runs while the page is closed | Runs only while the page is open (on load + every 60 s) and on fast-forward |
| AI bot | Real bot over HTTP `/bot/v1` with a key (curl / `bot-cli.js`) | **Simulated bot panel**: buttons that call the same bot API in-page with the bot's own key. With Go Blind on, its responses show `blindMode: true` with amounts removed. "Turn Go Blind on" works; "Try to turn Go Blind off" / "Try to read hidden amounts" are refused (403) |
| Notifications | Console, in-app, optional signed webhook | In-app only |
| Offline | n/a | Service worker precaches everything; works offline after the first visit |
| Production guard | `assertSandboxOnly()`, hard-coded `REAL_MONEY_ENABLED = false`, 6 go-live gates | No network provider bundled; same hard-coded flag and gates |
| Security of the lock | Same Hard Lock rules | Same rules, but anyone with the device can clear site data. It's a demo, not a vault |
