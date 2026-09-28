# Seal my login · unlock date · lost card · guided setup

General information for a personal prototype, not financial or legal advice. Fake data only in the demo.

## What it's for

You keep your locked savings at a **separate bank** (in this plan: **Current**, current.com). The login for it is created (or entered) **once**. You type it in at the bank, test it once, and then the app **seals** it. After that nobody can see it in this app until the unlock condition is met: not you, not a passcode, not Go Blind's passcode, not the AI assistant.

Three-bank plan this prototype is built around:

1. **Varo**: your SSI lands here. This is spending money.
2. **Step**: a bridge only. Money passes through; its balance should stay at **zero**.
3. **Current**: sealed, locked savings (default label **"Current Savings"**). You never open it. Your assistant handles it on current.com (desktop web).

## The flow (More → Guided setup, or `#/setup`)

1. **Seal my login.**
   - **Label**: defaults to "Current Savings".
   - **Username/email**, with an optional recovery email, burner phone, notes and security questions. Each question can have an answer you type or a random 4-word answer.
   - **Password**: either
     - **generate** one: crypto-random, 20 characters by default. You can set the length (12 to 64), the symbol set and count, and whether to skip look-alike characters (I l O 0 1). It always has upper case, lower case and at least 2 digits, and starts with a letter;
     - or **enter** your existing password.
2. **Shown once.** Every value appears with a **Copy** button. The clipboard is cleared after 60 seconds and again after sealing. Before you can continue you tick a checklist:
   - "I entered these at the bank exactly as shown."
   - "I logged out and back in once and it worked."
   - "I did not save it in a browser, phone or password manager."
   If the bank rejects the password, go back and make a new one.
3. **Unlock date** (default), **goal**, or **date and goal** (whichever comes later). A live countdown shows how long is left.
4. Type **`SEAL MY LOGIN`** to seal it.

Then the lost-card checklist, then a dashboard with sample data ($100/month on the day after SSI, a $3,000 "Mattress" goal, SSI guard on) that you can authorize and switch to Go Blind.

## Rules after sealing

- **Tighten only.** The date can move **later**, never earlier. A goal can be **added** (date → date and goal), never removed. Anything else returns 423 `lock_loosening_blocked` and is logged. While a seal waits for a goal, that goal can't be lowered, and the demo clock and simulate buttons are refused.
- **Open** is refused while the login is sealed (423 `sealed_until_unlock`). That holds with the app passcode, with Go Blind's passcode, and for every attempt. Each refusal is logged.
- **Delete** is refused while sealed. **Sandbox reset** and the demo's **Start over** are refused while any login is sealed and locked.
- **Reseal**, for when the bank forced a password change: you get a new password (the old one is never shown), tick "I changed it at the bank" and "logged in with it", and type **`RESEAL MY LOGIN`**. Fields you don't replace are kept. The label can be renamed at any time.
- **AI assistant/bot:** it sees only **label, sealedAt and status** (`GET /bot/v1/sealed-logins`). Reveal, create, delete, reseal and unlock changes always return 403 and are logged. That includes after the login unlocks: only you can open it, in the app.
- **Logs** never contain the secret values, only labels, dates and rule changes.

## Encryption

- AES-256-GCM. The format is `sl1.<iv>.<ciphertext+tag>`, with associated data `ldb-sealed-login:v1:<id>`, so a blob can't be swapped between logins. The same format is used on both sides:
  - **Server:** Node crypto, with the key from `SEALED_LOGIN_KEY` (base64, 32 bytes) or `SEALED_LOGIN_KEY_FILE`. If neither is set, a dev key is created at `DATA_DIR/.sealed-login-key` (mode 0600, git-ignored).
  - **Static demo:** WebCrypto. A **non-extractable** AES-GCM key is kept in this browser's IndexedDB (`ldb-vault-demo-keys`).
- Drafts (before sealing) are stored encrypted too, and expire after 2 hours.

## Honest limits

- **The bank can always reset the login** after checking your identity (and so can Current support). The real lock is the bank's own rules plus a trusted person, not this app.
- **Demo:** the key lives on the same device. It is non-extractable, but a technical person with the unlocked device can still use it from DevTools (`window.LDB_DEMO` is exposed for testing). **Changing the phone's clock could fool the demo's unlock date.** The server version uses the server's clock.
- **Clearing the site's data** in the browser erases the sealed login **without revealing it**. That is the only way to "start over" in the demo while something is sealed.
- **Server:** anyone who can read both the key and the data file can decrypt. Keep the key out of git and backups you share, and run the AI assistant as a separate OS user.
- Sealing does not change how SSA counts your money. Money in a regular savings account still counts toward the **$2,000** SSI resource limit for an individual. Money in an **ABLE** account is excluded up to **$100,000**.
- Everything in the simulation is fictional money.

## Recommended real-world setup

- A **separate bank** for the locked savings (Current), with no debit card and no app on your phone.
- A **new email** used only for that bank.
- A **burner phone number** for its text codes: a cheap prepaid SIM, kept by a **trusted person**. Banks may reject Google Voice numbers, and Google can reclaim an inactive Voice number.
- The trusted person (or your assistant, for the monthly move) is the one who logs in. You don't.

## Lost-card checklist (Current card)

Your ticks are saved and logged.

1. **Report the Current card lost or stolen** in the Current app's card settings, or through Current support. Use the phone number or contact options shown in the Current app or on current.com (this project doesn't list a number). Decline a replacement for now.
2. **Remove it from Apple Wallet.** On iPhone: Wallet → the card → ⋯ → Card Details → Remove Card. Or Settings → Wallet & Apple Pay → the card → Remove Card. Also check an Apple Watch.
3. **Cut up the physical card** through the chip and the number.
4. **Delete the Current app** after sealing: press and hold the icon → Remove App → Delete App.
5. **Request a new card only after the unlock date.**

## API (user side, needs your session)

`GET /api/sealed-logins` · `GET|POST /api/sealed-logins/draft` · `POST /api/sealed-logins/draft/discard` · `POST /api/sealed-logins/seal` · `POST /api/sealed-logins/reseal/draft` · `POST /api/sealed-logins/reseal` · `POST /api/sealed-logins/label` · `POST /api/sealed-logins/unlock` · `POST /api/sealed-logins/reveal` · `POST /api/sealed-logins/delete` · `POST /api/lost-card`.

Bot side: see `docs/bot-api.openapi.json` (`/bot/v1/sealed-logins*`).
