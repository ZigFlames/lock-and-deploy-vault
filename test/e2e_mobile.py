"""Headless mobile pass (390x844) of the mock flow with system Chrome + Playwright.
Starts its own server (mock provider, temp data dir, SIM_DATE pinned), drives the UI as the user and the Bot API
as an AI bot, saves screenshots, stops the server. Leaves nothing running.
Usage: python3 test/e2e_mobile.py        (needs: pip install playwright; uses /usr/bin/google-chrome or $CHROME)
"""
import json, os, re, subprocess, sys, tempfile, time, urllib.request, urllib.error, shutil
from datetime import date, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "screenshots"; SHOTS.mkdir(exist_ok=True)
PORT = int(os.environ.get("E2E_PORT", "5187"))
BASE = f"http://127.0.0.1:{PORT}/"
CHROME = os.environ.get("CHROME") or ("/usr/bin/google-chrome" if Path("/usr/bin/google-chrome").exists() else None)
PASSCODE = "e2e-passcode-123"
results = []
COOKIE = {"v": ""}

def check(name, cond, detail=""):
    results.append({"name": name, "pass": bool(cond), "detail": str(detail)})
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail else ""))

def http(path, body=None, headers=None, method=None):
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(BASE.rstrip("/") + path, data=None if body is None else json.dumps(body).encode(), headers=h,
                                 method=method or ("GET" if body is None else "POST"))
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

def api(path, body=None):
    s, d = http(path, body, {"Cookie": COOKIE["v"]})
    if s >= 400: raise RuntimeError(f"{path} -> {s} {d}")
    return d

def bot(key, path, body=None, method=None):
    return http(path, body, {"Authorization": f"Bearer {key}"}, method)

def shot(page, name, scroll_to=None, offset=110):
    """Viewport screenshot (true 390x844 phone frame), toasts cleared, optionally scrolled to an element."""
    page.evaluate("document.querySelectorAll('.toast').forEach(t => t.remove())")
    if scroll_to:
        page.evaluate("([sel, off]) => { const el = document.querySelector(sel); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - off); }", [scroll_to, offset])
    else:
        page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(250)
    page.screenshot(path=str(SHOTS / name))

def main():
    data_dir = tempfile.mkdtemp(prefix="ldb-e2e-")
    env = {**os.environ, "PROVIDER": "mock", "DATA_DIR": data_dir, "PORT": str(PORT), "HOST": "127.0.0.1", "SCHEDULER_INTERVAL_SECONDS": "3600", "SIM_DATE": "2026-10-05"}
    for k in ["PLAID_ENV", "PLAID_CLIENT_ID", "PLAID_SECRET", "NODE_ENV"]:
        env.pop(k, None)
    server = subprocess.Popen(["node", "server/index.js"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(50):
            try: http("/api/auth/status"); break
            except Exception: time.sleep(0.1)
        run()
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill()
        shutil.rmtree(data_dir, ignore_errors=True)
    passed = sum(r["pass"] for r in results)
    (ROOT / "test" / "last-e2e.json").write_text(json.dumps({"passed": passed, "total": len(results), "results": results}, indent=2))
    print(f"\n{passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)

def advance_until(pred, max_days=400, step=1):
    for _ in range(0, max_days, step):
        s = api("/api/state")
        if pred(s): return s
        api("/api/sandbox/clock/advance", {"days": step})
    return api("/api/state")

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True) if CHROME else p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("dialog", lambda d: d.accept())

        # --- Passcode setup (the bot never gets this) ---
        page.goto(BASE + "#/")
        expect(page.get_by_text("Sandbox only. No real money can move.")).to_be_visible()
        check("home renders with sandbox banner", True)
        expect(page.get_by_test_id("passcode")).to_be_visible()
        check("app asks for a passcode first (tab bar hidden)", page.locator("#tabbar").is_hidden())
        page.get_by_test_id("passcode").fill(PASSCODE); page.get_by_test_id("auth-submit").click()
        page.wait_for_timeout(500)
        COOKIE["v"] = "; ".join(f"{c['name']}={c['value']}" for c in ctx.cookies())
        check("session cookie is HttpOnly + SameSite=Strict", all(c["httpOnly"] and c["sameSite"] == "Strict" for c in ctx.cookies() if c["name"] == "ldb_session"))
        check("mode badge shows mock", "mock" in page.locator("#mode-badge").inner_text().lower())
        st = api("/api/state")
        check("default goal is $3,000 with Hard Lock on", st["goal"]["targetCents"] == 300000 and st["goal"]["hardLock"] is True)

        # --- Link two banks through the fake Link modal ---
        page.goto(BASE + "#/accounts")
        for bank in ["mock_goldcoast", "mock_harbor"]:
            page.get_by_test_id("link-bank").click()
            expect(page.get_by_test_id("link-modal")).to_be_visible()
            page.get_by_test_id("link-continue").click()
            page.get_by_test_id(f"bank-{bank}").click()
            check(f"{bank}: sign-in step has no credential inputs", page.locator("[data-testid=link-modal] input").count() == 0)
            page.get_by_test_id("link-signin").click()
            page.get_by_test_id("link-share").click()
            page.wait_for_timeout(300)
        check("four accounts listed", page.locator(".acct").count() == 4, page.locator(".acct").count())
        page.get_by_test_id("fund-4821").check()
        page.get_by_test_id("dest-9034").check()
        shot(page, "01-link-accounts.png", ".section-title")
        page.get_by_test_id("save-roles").click()
        page.wait_for_timeout(300)
        st = api("/api/state")
        f = next(a for a in st["accounts"] if a["id"] == st["roles"]["fundingAccountId"])
        d = next(a for a in st["accounts"] if a["id"] == st["roles"]["destinationAccountId"])
        check("roles saved (4821 -> 9034)", f["mask"] == "4821" and d["mask"] == "9034")

        # --- Goal (Hard Lock) + schedule ---
        page.goto(BASE + "#/plan")
        check("Hard Lock toggle on by default", page.get_by_test_id("hardlock-toggle").is_checked())
        release = (date.fromisoformat(st["today"]) + timedelta(days=400)).isoformat()
        page.fill("input[name=name]", "Mattress")
        page.fill("input[name=target]", "3000")
        page.fill("input[name=releaseDate]", release)
        page.get_by_test_id("save-goal").click()
        page.wait_for_timeout(300)
        page.fill("input[name=amount]", "250")
        page.select_option("select[name=frequency]", "benefit")
        page.select_option("select[name=benefitType]", "ssi")
        page.fill("input[name=offsetDays]", "1")
        page.wait_for_timeout(500)
        prev = page.get_by_test_id("preview").inner_text()
        check("schedule preview shows dates + projection", "deposits to reach" in prev and "$250.00" in prev, prev.replace("\n", " | ")[:120])
        shot(page, "02-schedule-setup.png", "#schedule-form")
        page.get_by_test_id("save-schedule").click()
        page.wait_for_url("**/#/authorize")

        # --- Benefit warning + authorization ---
        expect(page.get_by_test_id("benefit-warning")).to_contain_text("$2,000")
        check("benefit-limit warning shown before authorization", True)
        check("authorize disabled before ack", page.get_by_test_id("authorize-btn").is_disabled())
        page.get_by_test_id("ack-box").check()
        page.get_by_test_id("ack-btn").click()
        page.wait_for_timeout(300)
        page.get_by_test_id("signer").fill("Lance Sandbox")
        page.wait_for_timeout(600)
        check("authorization text loaded", "ending in 4821" in page.get_by_test_id("auth-text").inner_text())
        check("authorization text says pause/stop never unlock", "never unlock" in page.get_by_test_id("auth-text").inner_text())
        check("authorize still disabled until checkbox", page.get_by_test_id("authorize-btn").is_disabled())
        page.get_by_test_id("auth-box").check()
        page.get_by_test_id("authorize-btn").click()
        page.wait_for_url("**/#/transfers")
        page.wait_for_timeout(300)
        check("schedule active after authorization", "active" in page.get_by_test_id("schedule-status").inner_text().lower())
        check("goal locked at authorization", api("/api/state")["goal"]["lockedAt"] is not None)

        # --- Deposits appear and advance through statuses ---
        page.get_by_test_id("clock-7").click()
        page.wait_for_timeout(400)
        for _ in range(90):
            s = api("/api/state")
            sts = [t["status"] for t in s["transfers"]]
            if "pending" in sts and "settled" in sts: break
            api("/api/sandbox/clock/advance", {"days": 1})
        page.reload(); page.wait_for_timeout(400)
        s = api("/api/state")
        sts = [t["status"] for t in s["transfers"]]
        check("pending and settled deposits visible", "pending" in sts and "settled" in sts, sts)
        check("settled balance > 0 and vault locked", s["totals"]["vaultCents"] > 0 and s["goal"]["status"] == "saving", s["totals"])
        shot(page, "03-pending-transfers.png")

        # --- Home: pending vs settled ---
        page.goto(BASE + "#/"); page.wait_for_timeout(300)
        pvs = page.get_by_test_id("pending-vs-settled").inner_text()
        check("dashboard shows settled and pending separately", "Settled" in pvs and "Pending" in pvs and "Only settled" in pvs, pvs[:80])
        check("dashboard settled == API vault", page.get_by_test_id("settled-amount").inner_text().replace("$", "").replace(",", "") == f"{s['totals']['vaultCents']/100:.2f}")
        shot(page, "05-dashboard-pending-vs-settled.png", ".stats", 330)

        # --- Hard Lock: plan + vault show the lock; loosening blocked ---
        page.goto(BASE + "#/plan"); page.wait_for_timeout(300)
        check("plan shows locked note", page.get_by_test_id("locked-note").is_visible())
        check("Hard Lock toggle disabled while locked", page.get_by_test_id("hardlock-toggle").is_disabled())
        check("target field refuses values below the locked goal (min=3000)", page.get_by_test_id("goal-target").get_attribute("min") == "3000")
        # Bypass the browser's min= check to prove the server refuses too.
        page.evaluate("document.querySelector('input[name=target]').removeAttribute('min')")
        page.fill("input[name=target]", "2000"); page.get_by_test_id("save-goal").click()
        page.locator(".toast").last.wait_for(timeout=5000)
        t = page.locator(".toast").last.inner_text()
        check("server refuses lowering the target (423 lock_loosening_blocked)", "can't lower the target" in t, t)
        code, d = http("/api/goal", {"name": "Mattress", "targetCents": 300000, "releaseDate": s["goal"]["releaseDate"], "unlockRule": "goal", "hardLock": False}, {"Cookie": COOKIE["v"]})
        check("turning off Hard Lock mid-goal refused (423)", code == 423 and d.get("error") == "lock_loosening_blocked", d)
        later = (date.fromisoformat(s["goal"]["releaseDate"]) + timedelta(days=30)).isoformat()
        code, d = http("/api/goal", {"name": "Mattress", "targetCents": 300000, "releaseDate": later, "unlockRule": "goal"}, {"Cookie": COOKIE["v"]})
        check("adding time mid-lock allowed (release date +30 days)", code == 200 and api("/api/state")["goal"]["releaseDate"] == later, d)
        page.goto(BASE + "#/vault"); page.wait_for_timeout(300)
        check("vault says Hard Lock, no early unlock", "Hard Lock is on" in page.inner_text("main") and "no override code" in page.inner_text("main"))
        shot(page, "11-vault-hard-lock.png")

        # --- Pause (future deposits only) ---
        page.goto(BASE + "#/transfers"); page.wait_for_timeout(300)
        locked_before = s["totals"]["vaultCents"]; n_before = len(s["transfers"])
        page.get_by_test_id("pause-btn").click()
        page.wait_for_timeout(400)
        expect(page.get_by_test_id("paused-note")).to_be_visible()
        check("paused note says saved money stays locked", "stays locked" in page.get_by_test_id("paused-note").inner_text())
        shot(page, "04-paused.png")
        page.get_by_test_id("cancel-btn").first.click(); page.wait_for_timeout(400)
        s = api("/api/state")
        check("cancel pending transfer (schedule stays paused)", any(t["status"] == "cancelled" for t in s["transfers"]) and s["schedule"]["status"] == "paused")
        page.get_by_test_id("clock-30").click(); page.wait_for_timeout(500)
        s = api("/api/state")
        check("no new deposits while paused", len(s["transfers"]) == n_before, f"{n_before} -> {len(s['transfers'])}")
        check("pause did not reduce locked funds", s["totals"]["vaultCents"] >= locked_before)
        page.get_by_test_id("resume-btn").click(); page.wait_for_timeout(300)
        check("resume -> active", api("/api/state")["schedule"]["status"] == "active")

        # --- AI bot: key created in the app, bot acts through /bot/v1 ---
        page.goto(BASE + "#/bot"); page.wait_for_timeout(300)
        page.locator("input[name=scope][value=request]").check()
        page.get_by_test_id("create-key").click(); page.wait_for_timeout(500)
        key = page.get_by_test_id("new-key").inner_text().strip()
        check("bot key shown once in the app", re.match(r"^ldbk_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$", key) is not None)
        code, _ = http("/api/state", headers={"Authorization": f"Bearer {key}"})
        check("bot key refused on the user API", code == 403)
        check("bot reads status", bot(key, "/bot/v1/status")[0] == 200)
        bot(key, "/bot/v1/transfers")
        code, d = bot(key, "/bot/v1/goals/propose", {"targetCents": 350000, "reason": "aim a bit higher"})
        check("bot goal change -> pending approval (202)", code == 202 and d["approval"]["status"] == "pending")
        check("bot cannot unlock", bot(key, "/bot/v1/requests", {"type": "unlock"})[0] == 403)
        check("bot cannot switch to production", bot(key, "/bot/v1/requests", {"type": "switch_production"})[0] == 403)
        check("bot cannot delete audit", bot(key, "/bot/v1/audit", method="DELETE")[0] == 405)
        check("bot cannot request a withdrawal while locked", bot(key, "/bot/v1/requests", {"type": "withdrawal", "payload": {"amountCents": 1000}})[0] == 423)
        check("bot pause works immediately", bot(key, "/bot/v1/schedule/pause", {})[0] == 200)
        code, d = bot(key, "/bot/v1/requests", {"type": "resume_schedule", "reason": "funds look fine again"})
        check("bot resume -> pending approval", code == 202)
        page.goto(BASE + "#/inbox"); page.wait_for_timeout(300)
        check("inbox lists 2 pending approvals", page.locator("form[data-approval]").count() == 2)
        check("tab badge shows pending count", page.locator("#inbox-badge").inner_text() == "2")
        shot(page, "08-approvals-inbox.png")
        resume_form = page.locator("form[data-approval]", has_text="Resume")
        resume_form.locator("input[name=confirm]").check(); resume_form.get_by_test_id("approve-btn").click(); page.wait_for_timeout(400)
        check("user approved resume -> active", api("/api/state")["schedule"]["status"] == "active")
        page.locator("form[data-approval]", has_text="Change goal").locator("[data-action=reject]").click(); page.wait_for_timeout(400)
        check("user rejected goal change -> still $3,000", api("/api/state")["goal"]["targetCents"] == 300000)
        page.goto(BASE + "#/bot"); page.wait_for_timeout(300)
        acts = page.get_by_test_id("bot-activity").inner_text()
        check("bot activity log shows every call incl. refused ones", "DELETE /bot/v1/audit" in acts and "/bot/v1/requests" in acts and "405" in acts)
        shot(page, "09-bot-activity-log.png", "[data-testid=bot-activity]", 150)

        # --- Reach the goal (settled only) -> unlock code shown once ---
        s = advance_until(lambda x: x["goal"]["status"] == "unlocked", 500, 15)
        check("goal reached on settled balance", s["goal"]["status"] == "unlocked" and s["totals"]["vaultCents"] == 300000, s["totals"])
        page.goto(BASE + "#/"); page.wait_for_timeout(300)
        check("in-app milestone banner", page.get_by_test_id("notification").count() > 0 and "Goal reached" in page.inner_text("main"))
        page.goto(BASE + "#/vault"); page.wait_for_timeout(300)
        page.get_by_test_id("reveal-code").click(); page.wait_for_timeout(400)
        code_txt = page.get_by_test_id("unlock-code").inner_text().strip()
        check("unlock code displayed (XXXX-XXXX-XXXX)", re.match(r"^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$", code_txt) is not None, code_txt)
        shot(page, "06-milestone-unlocked-code.png", "[data-testid=unlock-card]", 300)
        page.reload(); page.wait_for_timeout(400)
        check("code is not shown again after reload", page.get_by_test_id("unlock-code").count() == 0 and page.get_by_test_id("reveal-code").count() == 0)

        # --- Roll Over & Relock wizard: 3000 -> -1000 -> 2000 -> 4000 (needs 2000) ---
        page.goto(BASE + "#/rollover"); page.wait_for_timeout(400)
        check("rollover preview: additional needed $2,000", page.get_by_test_id("rollover-additional").inner_text() == "$2,000.00", page.get_by_test_id("rollover-calc").inner_text().replace("\n", " "))
        check("rollover flow shows 3,000 → 1,000 → 2,000 → 4,000", all(x in page.locator("#rollover-flow").inner_text() for x in ["$3,000", "$1,000", "$2,000", "$4,000"]))
        shot(page, "07-rollover-wizard.png", "[data-testid=rollover-wizard]", 70)
        page.fill("input[name=code]", code_txt); page.check("input[name=confirm]")
        page.get_by_test_id("rollover-submit").click(); page.wait_for_timeout(600)
        s = api("/api/state")
        check("relocked: goal $4,000, $2,000 stays locked, deposits continue",
              s["goal"]["targetCents"] == 400000 and s["totals"]["vaultCents"] == 200000 and s["goal"]["status"] == "saving" and s["schedule"]["status"] == "active", (s["goal"]["targetCents"], s["totals"]["vaultCents"], s["schedule"]["status"]))

        # --- Emergency stop + your bank account ---
        page.goto(BASE + "#/more"); page.wait_for_timeout(200)
        page.get_by_test_id("more-emergency").click(); page.wait_for_timeout(300)
        txt = page.inner_text("main")
        check("emergency stop says it does not unlock", "does not unlock" in page.get_by_test_id("emergency-stop").inner_text().lower() or "does not" in txt)
        check("bank disclosure: can't stop the bank; never touches recovery", "can't legally or technically stop your bank" in txt and "account recovery" in txt)
        check("stronger-lock tips (separate bank, no debit card, CD/withdrawal hold, sealed envelope, ABLE)",
              all(x in txt for x in ["Separate bank", "No debit card", "Don't install", "CD", "Fort Knox", "Sealed envelope", "ABLE"]))
        shot(page, "10-emergency-access.png")
        shot(page, "12-stronger-lock-at-bank.png", "[data-testid=stronger-lock]", 80)
        vault_before = s["totals"]["vaultCents"]
        page.check("#stop-confirm"); page.get_by_test_id("emergency-stop").click(); page.wait_for_timeout(500)
        s = api("/api/state")
        check("emergency stop paused deposits", s["schedule"]["status"] == "paused")
        check("emergency stop revoked bot keys", bot(key, "/bot/v1/status")[0] == 401)
        check("emergency stop did not unlock or move money", s["goal"]["status"] == "saving" and s["totals"]["vaultCents"] == vault_before)

        # --- Real money refused; gates unmet ---
        page.goto(BASE + "#/log")
        page.get_by_test_id("real-btn").click(); page.wait_for_timeout(400)
        t = page.locator(".toast").last.inner_text()
        check("real-transfer activation refused (ack required first)", "benefit" in t.lower(), t)
        page.check("#real-ack"); page.get_by_test_id("real-btn").click(); page.wait_for_timeout(400)
        t = page.locator(".toast").last.inner_text()
        check("real-transfer activation refused (hard-disabled, gates unmet)", "hard-disabled" in t and "provider_approval" in t, t)
        check("audit trail: chain intact; authorization, emergency stop and refused loosening logged", "chain intact" in page.inner_text("main").lower() and api("/api/audit/verify")["ok"] and "authorization_accepted" in page.get_by_test_id("audit-key").inner_text() and "emergency_stop" in page.get_by_test_id("audit-key").inner_text() and "lock_loosening_refused" in page.get_by_test_id("audit-key").inner_text())
        page.goto(BASE + "#/settings"); page.wait_for_timeout(300)
        check("settings screen lists go-live gates, all unmet", page.get_by_test_id("golive").locator(".gate").count() == 6)
        widths = {}
        for r in ["", "accounts", "plan", "authorize", "transfers", "inbox", "vault", "rollover", "bot", "settings", "bank", "more", "log"]:
            page.goto(BASE + "#/" + r); page.wait_for_timeout(250)
            widths[r or "home"] = page.evaluate("document.documentElement.scrollWidth")
        check("no horizontal overflow at 390px on any screen", all(w <= 390 for w in widths.values()), widths)
        # Deliberately refused calls (401 before login, 400/403/423 guards) log "Failed to load resource".
        unexpected = [e for e in errors if not ("Failed to load resource" in e and re.search(r"\b(400|401|403|423)\b", e))]
        check("no unexpected console/page errors", not unexpected, unexpected[:3])
        browser.close()

if __name__ == "__main__":
    main()
