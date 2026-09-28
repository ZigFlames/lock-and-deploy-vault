# Secrets: where they live and how they are protected

This prototype is sandbox-only, but it is built so that no secret has to live in the browser, in git, or in plain text on disk.

## What secrets exist
| Secret | Where it comes from | How it is stored |
|---|---|---|
| `PLAID_CLIENT_ID` / `PLAID_SECRET` (Sandbox) | Plaid dashboard | Environment / `.env` only (git-ignored). Never sent to the browser. |
| `TOKEN_ENCRYPTION_KEY` | You generate it (32 random bytes, base64) | Environment / `.env`. Encrypts provider access tokens with AES-256-GCM. If empty, a dev key is created at `data/.dev-token-key` (mode 0600), fine for sandbox only. |
| Provider access tokens | Link token exchange | **Encrypted** in `data/db.json` (`v1.<iv>.<tag>.<ciphertext>`). Stripped from every API response. |
| App passcode | You choose it | **scrypt hash** only. Reset with `npm run reset-passcode` (does not unlock the vault). |
| Session cookie | Login | Random token, HttpOnly, SameSite=Strict. Stored server-side as a hash with expiry. |
| Bot keys (`ldbk_<id>.<secret>`) | Created by you in More → Bot | Shown **once**; stored as **SHA-256**. Revocable; revoked by emergency stop and passcode reset. |
| Unlock codes (`XXXX-XXXX-XXXX`) | Generated when the goal is reached | **scrypt hash** for verification. The plaintext is kept encrypted only until it is shown to you once, then deleted. Single use, expiry, attempt limit. |
| `SEALED_LOGIN_KEY` / `SEALED_LOGIN_KEY_FILE` | You generate it (32 random bytes, base64) | Environment / `.env` or a 0600 file. Encrypts sealed logins (AES-256-GCM, `sl1` format). If empty, a dev key is created at `data/.sealed-login-key` (mode 0600, git-ignored). Static demo: a non-extractable WebCrypto key in the browser's IndexedDB. |
| Sealed login values (the Current Savings login) | You generate or enter them in Seal my login | **Encrypted** in `data/db.json` (and drafts, which expire after 2 hours). Never in any API view, log or bot response; shown only after the unlock condition, to the user only. See `docs/SEALED_LOGIN.md`. |
| Sync code (`ldbsync1.<channel>.<key>`, static demo) | Created in More → Assistant sync | In this browser's localStorage; given to the assistant once. The relay only ever stores ciphertext. See `docs/ASSISTANT_SYNC.md`. |
| `NOTIFY_WEBHOOK_SECRET` | You choose it | Environment / `.env`. Signs webhook bodies (HMAC-SHA256, `X-LDB-Signature`). |

Never stored for bank **linking**: bank usernames or passwords, full account or routing numbers. The one exception is a login you choose to seal (Seal my login), which is stored encrypted and never shown before its unlock condition.

## Options for supplying environment secrets (best to worst)
The server reads plain environment variables, so any of these work without code changes:

- **1Password CLI:** keep secrets in a vault and inject at start: `op run --env-file=.env.tpl -- npm start` (the template holds `op://Vault/Item/field` references, not values).
- **OS keychain:** macOS Keychain (`security find-generic-password -w -s ldb-token-key`), Linux Secret Service (`secret-tool lookup service ldb`), or Windows Credential Manager, exported in a small start script.
- **Doppler / Infisical:** `doppler run -- npm start`.
- **Cloud secret managers** (if ever hosted): AWS Secrets Manager or SSM Parameter Store, Google Secret Manager, Azure Key Vault, ideally with a KMS-managed key for token encryption.
- **`.env` file** (default for local sandbox): git-ignored, keep it `chmod 600`. Acceptable for sandbox keys only.

## Same-machine rule for the AI bot
Anything running as your OS user can read `.env` and `data/`. If an AI assistant runs on the same computer, run it as a **separate OS user** without read access to the project's `.env` and `data/` directory, and give it only `LDB_BOT_KEY` and `LDB_URL`. The bot key alone can only read, propose, pause and request; it can't approve, unlock or reach the bank.

## Rotation
- Bot keys: revoke and create a new one in More → Bot.
- Token encryption key: re-link banks after changing it (old ciphertexts can't be decrypted with a new key).
- Plaid secret: rotate in the Plaid dashboard, update the env, restart.
