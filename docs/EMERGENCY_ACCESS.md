# Emergency access, the Hard Lock, and your bank

Short version: **inside the app there is no emergency way out.** The vault opens only when the **settled** balance reaches the goal. Outside the app, your bank always lets the account owner reach their own money. This page states both facts plainly and shows how to make the lock stronger at the bank.

## 1. Inside the app: Hard Lock (on by default)

| Question | Answer |
|---|---|
| Is there an emergency withdrawal or early-unlock button? | **No.** No override code, no admin bypass, no "unlock" endpoint (tests check that `/api/vault/unlock`, `/api/vault/override`, `/api/admin/unlock`, `/api/emergency/unlock`, `/api/emergency/withdraw` and `/api/lock/disable` don't exist). |
| Can the AI bot unlock it or ask for an unlock? | **No.** `unlock`, `early_unlock`, `bypass_lock`, `hardship_release`, `disable_hard_lock`, `lower_goal` and similar request types return 403 and are logged. |
| What unlocks the vault? | Only settled deposits reaching the goal (plus the release date, if you chose the stricter rule). Pending money never counts. A return after unlock relocks it. |
| Can I weaken the lock while saving? | **No.** Lowering the target, turning off Hard Lock, adding a hardship release, shortening its cooling-off, moving the date earlier or dropping the date rule all return `423 lock_loosening_blocked` and are audited. Raising the goal or adding time is allowed. |
| Does resetting the app passcode unlock anything? | **No.** `npm run reset-passcode` clears the app passcode and sessions and revokes bot keys. The goal, lock and ledger are untouched. |
| Can I change settings to loosen it? | Settings are defaults for **new** goals only. They never touch a locked goal. |

### Optional hardship release (off by default, not available with Hard Lock)
Only for a goal created with Hard Lock **off**, and only chosen while the goal is a draft, before you authorize deposits. It can't be added later.
1. Request it with an amount, typing `I UNDERSTAND THIS BREAKS MY LOCK` and ticking a confirmation.
2. Wait the **cooling-off period** (default 30 days, minimum 7, set when the goal was created; it can be lengthened but never shortened while locked).
3. Cancel at any time during the wait. Everything stays locked.
4. After the wait, confirm again with the typed phrase. The released amount is recorded (simulated in this prototype). The rest stays locked.
Every step is in the audit log: `hardship_requested`, `hardship_cancelled`, `hardship_released`, `hardship_refused`.

### Go Blind (hide all amounts)
Go Blind hides every dollar amount from you and from the bot, so you're not tempted to check. The lock is unchanged; only what you see changes. What stays visible, and every Emergency stop, Pause/Resume and Inbox control, keeps working. Turning it off needs your passcode (5 tries, then a 15-minute lockout). If you chose **stay blind until goal**, it can't be turned off at all until the vault unlocks, and the goal-reached banner still appears. Sandbox reset and "Start over" are refused while it's on. The **benefits guard** (I receive SSI) still warns you, without numbers, when settled savings get close to the SSI resource limit. Details: README → Go Blind.

## 2. Emergency stop: pause, never unlock

**More → Emergency stop & your bank → "Emergency stop (does not unlock)"**. User only; the bot can't press or disable it.

It does exactly this:
- **Pauses all future deposits** (in-flight transfers finish; cancel a pending one separately if you need to).
- **Revokes every bot key** and cancels pending bot approval requests.
- Logs `emergency_stop` with `lockUnchanged: true`.

It does **not** unlock the vault, release money, lower the goal or change the lock. Use it if something looks wrong with the schedule, your balance, or the bot. Resume deposits from **Transfers** when ready, and create a new bot key if you want the bot back.

## 3. Your bank account: the facts (disclosure)

- Lock & Deploy is a savings **discipline** tool. It does not hold your money and does not control your bank account. Your money stays at your bank.
- The app **can't legally or technically stop your bank** from giving you, the account owner, your own money (online banking, a branch, or the bank's phone line).
- The app and the bot **never see your bank password** and **never touch your bank's login, password reset or account recovery.** If you have a bank password problem, use your bank's normal recovery process.
- That is why the in-app Hard Lock works best together with a lock you also build **at the bank**.

## 4. Make the lock stronger at the bank

These are real commitment devices, enforced by the bank or by distance rather than by this app:

1. **Separate bank.** Keep the savings account at a different bank from your everyday checking, so it isn't one tap away.
2. **No debit card** on the savings account (ask the bank not to issue one, or cut it up).
3. **Don't install that bank's app** on your phone. Fewer ways in means fewer impulse withdrawals.
4. **Bank-enforced penalties or delays:**
   - a **CD** (certificate of deposit) with a term ending near your goal date, which has an early-withdrawal penalty; or
   - a **withdrawal-hold savings account** such as Fort Knox-style savings (Austin Capital Bank: withdrawals go only to one linked account after a waiting period you have to schedule; $10/month, waived at $1,000+).
5. **Sealed envelope (optional):** give the savings bank's login to a trusted person in a sealed envelope, and don't keep a copy yourself. This is your choice and your arrangement; the app never stores or asks for bank logins.
6. **If you get SSI:** an **ABLE account** can hold savings without counting toward the $2,000 SSI resource limit (the first $100,000 is excluded). A $3,000 balance in a regular savings account or CD **does** count. Check with SSA or a benefits counselor.
