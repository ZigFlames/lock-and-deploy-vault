# How the AI assistant reads the app · Monthly move

Prototype with fake data. No real money moves. General information, not financial advice.

## The recommendation, in plain words

- **For real use: run the server version.** Your assistant (for example Grok on a Linux box) reads the app over HTTP with a bot key you create in the app (More → Bot):
  - One call gives it everything: `GET /bot/v1/snapshot`. That covers status, schedule, settled vs pending, recent approvals, **your decisions** (approved/rejected, pauses, raises), monthly moves and sealed-login status (label only).
  - It can **ask** for things (a monthly move, a faster deposit) and **pause**. Only you can approve.
  - Nothing new has to be hosted besides the prototype server itself. Keep it on `127.0.0.1` or behind your own private network. Don't expose it to the internet.
- **For the phone demo on GitHub Pages (no server):** your data lives only in that browser. So the demo uses an **encrypted sync** through a tiny relay:
  1. In the app, **More → Assistant sync → Create sync code**. You give the code to your assistant **once**, like a password. It looks like `ldbsync1.<channel>.<key>`. The key part never goes to any server.
  2. **Sync now** encrypts a read-only snapshot on the phone (AES-256-GCM) and uploads only the scrambled data to the relay (`PUT /sync/v1/<channel>/app`). The snapshot has the same content as `/bot/v1/snapshot`: never passwords, and amounts hidden while Go Blind is on.
  3. The assistant downloads it and decrypts it with the code: `node bot-cli.js sync-read`.
  4. The assistant can leave requests the same way: `node bot-cli.js sync-send propose_monthly_move`. They are stored encrypted in `/sync/v1/<channel>/bot`. On the next **Sync now** the app decrypts them and turns them into **normal pending approvals** in your Inbox. Only these types are accepted: propose/complete a monthly move, propose a faster deposit, pause. Everything else is refused and logged, and each message is applied only once.
  - **No relay?** Use **Download encrypted snapshot** and hand the file to the assistant (`node bot-cli.js sync-decrypt --file ...`).

### Why this is the simplest secure option

- It works with a static site. The relay is a dumb mailbox that stores ciphertext. It can see sizes and timing, not content.
- AES-GCM with the channel and slot as associated data means the relay, or anyone who guesses a channel id, can't read, forge or swap messages. The worst they can do is delete one.
- Assistant requests never run by themselves. They become approvals you tap.

### Honest limits

- **Anyone with the sync code can read the snapshots.** It is saved in this browser's localStorage so you can sync again. Tap "Forget code" to remove it, and create a new code if it leaks.
- The relay is part of the server prototype (`SYNC_RELAY=on`). **This project does not host one for you.** To use sync from the live GitHub Pages demo:
  - **On the same computer as the browser (for testing):** start the relay with `SYNC_RELAY=on PORT=5190 SYNC_ALLOWED_ORIGINS=https://zigflames.com npm start`, then enter `http://127.0.0.1:5190` as the relay. The demo's CSP allows `http://127.0.0.1:*` and `http://localhost:*`.
  - **Hosted, so the phone can reach it:** run the same server on any HTTPS host you control with `SYNC_RELAY=on` and `SYNC_ALLOWED_ORIGINS=https://zigflames.com`. Then rebuild the demo with `LDB_SYNC_RELAY_ORIGINS=https://your-relay.example npm run build` (that adds the origin to the page's CSP) and redeploy. Free tiers exist on several platforms, but none was set up here: no accounts were created and nothing was paid for.
- The demo relay has a per-IP rate limit and a 256 KB size cap. It has no accounts. The unguessable 128-bit channel id plus encryption is the protection.

## Monthly move: Varo → Step → Current

|  | Bank | Role |
|---|---|---|
| 1 | **Varo** | SSI lands here. Spending money. |
| 2 | **Step** | Bridge only. Balance kept at **zero**. |
| 3 | **Current** | Sealed, locked savings. Handled by the assistant on current.com (desktop web). You never open it. |

**Each month:**

1. The assistant asks: `POST /bot/v1/monthly-moves/propose` (or `sync-send propose_monthly_move`). This creates a pending approval like *"Monthly move: $100.00 Varo → Step (instant) → Current on 2026-10-02"*.
   - While Go Blind is on you see *"Monthly move: [hidden] Varo → Step (instant) → Current …"*.
   - Defaults: the amount is your current deposit amount, and the date is 3 days out. There is one request per month.
2. **You tap Approve** in the Inbox, or Reject. Nothing happens without that.
3. The assistant reads your decision (`GET /bot/v1/monthly-moves`, the snapshot, or `sync-read`) and then does **three steps itself, outside this app**. After each step it records the bank's confirmation (`POST /bot/v1/monthly-moves/complete`). Steps must be done in order:
   1. **Varo → Step (instant).** Step pulls from the Varo debit card. Instant only: if the instant option isn't offered that day, the assistant stops and tells you. It does not fall back to a slower method. Check the Step app for any fee first.
   2. **Step → Current.** This may take 1-3 business days to arrive, but it leaves Step right away. The assistant can report Step's balance afterwards (`stepBalanceCents`). Anything but zero triggers a warning.
   3. **Assistant confirms arrival in Current** on current.com.
4. The app shows each step with its confirmation, and a standing reminder: **Step balance should be $0** (worded as "zero" while Go Blind is on).

**In the prototype:**
- "Simulate completion" fills in all remaining steps with fake confirmations (`SIM-INSTANT-…`, `SIM-ACH-…`, `SIM-ARRIVED-…`).
- The simulated bot (More → Bot) can propose a move, read it, and record the next step.
- **This app never moves money for a monthly move.** It records the request, your decision and the confirmations.

### Commands

```bash
# server version (bot key from More > Bot)
export LDB_BOT_KEY=ldbk_... LDB_URL=http://127.0.0.1:5180
node bot-cli.js snapshot
node bot-cli.js propose-move --reason "monthly savings"
node bot-cli.js monthly-moves
node bot-cli.js complete-move --id mv_... --confirmation "VARO-123"                      # step 1
node bot-cli.js complete-move --id mv_... --confirmation "STEP-456" --step-balance 0     # step 2
node bot-cli.js complete-move --id mv_... --confirmation "CURRENT-789"                   # step 3

# static demo (sync code from More > Assistant sync; relay address)
export LDB_SYNC_CODE=ldbsync1.... LDB_SYNC_RELAY=http://127.0.0.1:5190
node bot-cli.js sync-read
node bot-cli.js sync-send propose_monthly_move --reason "monthly savings"
node bot-cli.js sync-send complete_monthly_move --move-id mv_... --confirmation "VARO-123"
```

API reference: `docs/bot-api.openapi.json` (`/bot/v1/snapshot`, `/bot/v1/monthly-moves*`). User side: `GET /api/monthly-moves`, `POST /api/monthly-moves/complete` (simulate), `POST /api/sync/snapshot`, `POST /api/sync/inbox`.
