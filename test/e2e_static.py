"""Headless phone-size (390x844) checks for the browser-only PWA demo (demo/dist), local or live.
Usage: python3 test/e2e_static.py https://zigflames.com/lock-and-deploy-vault/ [screenshot.png]
Uses a fresh browser profile, so it starts from empty localStorage. Writes test/last-e2e-static.json.
"""
import json, re, sys, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4191/lock-and-deploy-vault/"
SHOT = sys.argv[2] if len(sys.argv) > 2 else str(Path(__file__).resolve().parent.parent / "screenshots" / "13-static-demo-live.png")
CHROME = "/usr/bin/google-chrome" if Path("/usr/bin/google-chrome").exists() else None
results = []
def check(name, cond, detail=""):
    results.append({"name": name, "pass": bool(cond), "detail": str(detail)[:300]})
    print(("PASS " if cond else "FAIL ") + name + (f"  ({str(detail)[:200]})" if detail and not cond else ""))

JS_API = """async ([p, b]) => { const r = await window.LDB_TRANSPORT(p, b === null ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return [r.status, await r.json()]; }"""

def main():
    for path in ["", "manifest.webmanifest", "sw.js", "js/engine.js", "icons/icon-192.png"]:
        try:
            with urllib.request.urlopen(URL + path, timeout=20) as r: code = r.status; body = r.read()
        except Exception as e: code, body = str(e), b""
        check(f"GET {path or '/'} -> 200", code == 200, code)
        if path == "manifest.webmanifest" and code == 200:
            m = json.loads(body); check("manifest: standalone, icons 192+512+maskable", m.get("display") == "standalone" and {"192x192", "512x512"} <= {i["sizes"] for i in m["icons"]} and any(i.get("purpose") == "maskable" for i in m["icons"]))
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME, headless=True) if CHROME else p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = ctx.new_page(); errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("dialog", lambda d: d.accept())
        api = lambda path, body=None: pg.evaluate(JS_API, [path, body])
        state = lambda: api("/api/state")[1]

        pg.goto(URL); pg.wait_for_timeout(1500)
        check("badge says Simulation · fictional money", "simulation" in pg.locator("#mode-badge").inner_text().lower() and "fictional" in pg.locator("#mode-badge").inner_text().lower())
        sw = pg.evaluate("async () => { if (!('serviceWorker' in navigator)) return 'none'; const r = await Promise.race([navigator.serviceWorker.ready, new Promise((res) => setTimeout(() => res(null), 10000))]); return r && r.active ? r.active.state : 'not-ready'; }")
        check("service worker registered and active", sw in ("activated", "activating"), sw)
        st = state()
        check("fresh state: $3,000 goal, Hard Lock on, simulation flag", st["goal"]["targetCents"] == 300000 and st["goal"]["hardLock"] and st.get("simulation") is True and st["realMoneyEnabled"] is False)

        # Link two fictional banks with the mock Link sheet
        pg.goto(URL + "#/accounts"); pg.wait_for_timeout(400)
        for bank in ["mock_goldcoast", "mock_harbor"]:
            pg.get_by_test_id("link-bank").click(); pg.get_by_test_id("link-continue").click()
            pg.get_by_test_id(f"bank-{bank}").click(); pg.get_by_test_id("link-signin").click(); pg.get_by_test_id("link-share").click(); pg.wait_for_timeout(300)
        pg.get_by_test_id("fund-4821").check(); pg.get_by_test_id("dest-9034").check(); pg.get_by_test_id("save-roles").click(); pg.wait_for_timeout(300)
        check("two fictional banks linked, roles saved", len(state()["accounts"]) == 4 and state()["roles"]["fundingAccountId"])
        # Plan: $250 the day after SSI
        pg.goto(URL + "#/plan"); pg.wait_for_timeout(400)
        pg.fill("input[name=amount]", "250"); pg.select_option("select[name=frequency]", "benefit"); pg.select_option("select[name=benefitType]", "ssi"); pg.fill("input[name=offsetDays]", "1")
        pg.wait_for_timeout(400); pg.get_by_test_id("save-schedule").click(); pg.wait_for_url("**#/authorize")
        expect(pg.get_by_test_id("benefit-warning")).to_contain_text("$2,000")
        check("SSI warning shown before authorization", True)
        pg.get_by_test_id("ack-box").check(); pg.get_by_test_id("ack-btn").click(); pg.wait_for_timeout(300)
        pg.get_by_test_id("signer").fill("Lance Demo"); pg.wait_for_timeout(700)
        pg.get_by_test_id("auth-box").check(); pg.get_by_test_id("authorize-btn").click(); pg.wait_for_url("**#/transfers"); pg.wait_for_timeout(300)
        st = state()
        check("authorized: schedule active, goal locked", st["schedule"]["status"] == "active" and st["goal"]["lockedAt"])

        # Deposits flow; pending vs settled
        for _ in range(60):
            s = state(); sts = {t["status"] for t in s["transfers"]}
            if "settled" in sts and "pending" in sts: break
            api("/api/sandbox/clock/advance", {"days": 1})
        check("pending and settled deposits both visible", "settled" in sts and "pending" in sts, sts)
        check("idempotent: one deposit per period", len({t["idempotencyKey"] for t in s["transfers"]}) == len(s["transfers"]))

        # Hard Lock refuses everything that would unlock
        c1, d1 = api("/api/vault/withdraw", {"amountCents": 1000, "unlockCode": "AAAA-BBBB-CCCC", "confirm": True})
        c2, _ = api("/api/vault/reveal-code", {})
        c3, d3 = api("/api/hardship/request", {"amountCents": 1000, "typed": "I UNDERSTAND THIS BREAKS MY LOCK", "confirm": True})
        c4, d4 = api("/api/goal", {"targetCents": 200000})
        c5, _ = api("/api/goal", {"hardLock": False})
        check("Hard Lock refuses withdraw (423)", c1 == 423 and d1.get("error") == "vault_locked", d1)
        check("Hard Lock refuses code reveal (423)", c2 == 423)
        check("Hard Lock: no hardship path (403 hard_lock)", c3 == 403 and d3.get("error") == "hard_lock", d3)
        check("loosening refused: lower target / Hard Lock off (423)", c4 == 423 and c5 == 423 and d4.get("error") == "lock_loosening_blocked")
        pg.goto(URL + "#/bot"); pg.wait_for_timeout(400)
        pg.get_by_test_id("simbot-try_unlock").click(); pg.wait_for_timeout(500)
        check("simulated bot's unlock attempt refused (403)", "403" in pg.get_by_test_id("sim-bot-out").inner_text(), pg.get_by_test_id("sim-bot-out").inner_text())
        pg.get_by_test_id("simbot-propose_raise").click(); pg.wait_for_timeout(500)
        check("simulated bot proposal -> 202 pending approval", "202" in pg.get_by_test_id("sim-bot-out").inner_text())
        check("bot activity log lists the calls", "/bot/v1/requests" in pg.get_by_test_id("bot-activity").inner_text() and "/bot/v1/goals/propose" in pg.get_by_test_id("bot-activity").inner_text())
        pg.goto(URL + "#/inbox"); pg.wait_for_timeout(400)
        f = pg.locator("form[data-approval]").first
        check("approvals inbox shows the bot proposal", pg.locator("form[data-approval]").count() == 1)
        f.locator("[data-action=reject]").click(); pg.wait_for_timeout(400)
        check("user rejects -> goal still $3,000", state()["goal"]["targetCents"] == 300000)

        # Fast-forward to $3,000 settled -> unlock code
        for _ in range(60):
            s = state()
            if s["goal"]["status"] == "unlocked": break
            api("/api/sandbox/clock/advance", {"days": 15})
        check("fast-forward: goal reached on settled $3,000", s["goal"]["status"] == "unlocked" and s["totals"]["vaultCents"] == 300000, s["totals"])
        pg.goto(URL + "#/vault"); pg.wait_for_timeout(400)
        pg.get_by_test_id("reveal-code").click(); pg.wait_for_timeout(1500)
        code = pg.get_by_test_id("unlock-code").inner_text().strip()
        check("unlock code created and shown once", re.match(r"^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$", code) is not None, code)
        pg.reload(); pg.wait_for_timeout(1500)
        s = state()
        check("state survives reload (unlocked, $3,000)", s["goal"]["status"] == "unlocked" and s["totals"]["vaultCents"] == 300000)
        check("code not shown again after reload", pg.get_by_test_id("unlock-code").count() == 0 and pg.get_by_test_id("reveal-code").count() == 0)

        # Roll Over & Relock 3000 -> -1000 -> 2000 -> 4000
        pg.goto(URL + "#/rollover"); pg.wait_for_timeout(600)
        check("rollover preview: additional needed $2,000", pg.get_by_test_id("rollover-additional").inner_text() == "$2,000.00")
        pg.fill("input[name=code]", code); pg.check("input[name=confirm]"); pg.get_by_test_id("rollover-submit").click(); pg.wait_for_timeout(1500)
        s = state()
        check("rollover relocked: goal $4,000, $2,000 locked, deposits active", s["goal"]["targetCents"] == 400000 and s["totals"]["vaultCents"] == 200000 and s["goal"]["status"] == "saving" and s["schedule"]["status"] == "active", (s["goal"]["targetCents"], s["totals"]["vaultCents"]))

        # Emergency stop never unlocks
        pg.goto(URL + "#/bank"); pg.wait_for_timeout(400)
        txt = pg.inner_text("main")
        check("bank disclosure + stronger-lock tips present", "can't legally or technically stop your bank" in txt and all(x in txt for x in ["Separate bank", "No debit card", "Fort Knox", "Sealed envelope", "ABLE"]))
        pg.check("#stop-confirm"); pg.get_by_test_id("emergency-stop").click(); pg.wait_for_timeout(600)
        s = state()
        check("emergency stop: deposits paused, nothing unlocked, vault unchanged", s["schedule"]["status"] == "paused" and s["goal"]["status"] == "saving" and s["totals"]["vaultCents"] == 200000)
        c, _ = api("/api/demo/bot", {"action": "status"})
        check("emergency stop revoked the bot's key (401)", _.get("httpStatus") == 401, _)
        pg.goto(URL + "#/settings"); pg.wait_for_timeout(400)
        check("settings + 6 unmet go-live gates", pg.get_by_test_id("golive").locator(".gate").count() == 6)
        pg.reload(); pg.wait_for_timeout(1200)
        s = state()
        check("state survives reload (paused, $4,000 goal, $2,000 locked)", s["schedule"]["status"] == "paused" and s["goal"]["targetCents"] == 400000 and s["totals"]["vaultCents"] == 200000)

        # Overflow + offline
        widths = {}
        for r in ["", "accounts", "plan", "transfers", "inbox", "vault", "rollover", "bot", "settings", "bank", "more", "log"]:
            pg.goto(URL + "#/" + r); pg.wait_for_timeout(250); widths[r or "home"] = pg.evaluate("document.documentElement.scrollWidth")
        check("no horizontal overflow at 390px", all(w <= 390 for w in widths.values()), widths)
        pg.goto(URL + "#/"); pg.wait_for_timeout(800)
        for _ in range(10):
            d = pg.locator("[data-action=dismiss]")
            if d.count() == 0: break
            d.first.click(); pg.wait_for_timeout(250)
        pg.evaluate("document.querySelectorAll('.toast').forEach(t => t.remove())")
        pg.screenshot(path=SHOT)
        pg.goto(URL + "#/bot"); pg.wait_for_timeout(400); pg.get_by_test_id("simbot-new_key").click(); pg.wait_for_timeout(400)
        pg.get_by_test_id("simbot-try_unlock").click(); pg.wait_for_timeout(500)
        pg.evaluate("document.querySelectorAll('.toast').forEach(t => t.remove())")
        pg.evaluate("window.scrollTo(0, document.querySelector('[data-testid=sim-bot]').getBoundingClientRect().top + scrollY - 70)"); pg.wait_for_timeout(200)
        pg.screenshot(path=SHOT.replace(".png", "-bot.png"))
        check("fresh key after emergency stop; unlock still refused (403)", "403" in pg.get_by_test_id("sim-bot-out").inner_text())
        ctx.set_offline(True)
        pg.reload(); pg.wait_for_timeout(1500)
        check("works offline (service worker cache)", "Mattress" in pg.inner_text("main") or "MATTRESS" in pg.inner_text("main"), pg.inner_text("main")[:80])
        ctx.set_offline(False)
        unexpected = [e for e in errors if "Failed to load resource" not in e]
        check("no page errors", not unexpected, unexpected[:3])
        b.close()
    passed = sum(r["pass"] for r in results)
    Path(__file__).with_name("last-e2e-static.json").write_text(json.dumps({"url": URL, "passed": passed, "total": len(results), "results": results}, indent=2))
    print(f"\n{passed}/{len(results)} checks passed ({URL})")
    sys.exit(0 if passed == len(results) else 1)

main()
