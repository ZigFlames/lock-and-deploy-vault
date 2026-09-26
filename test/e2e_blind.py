"""Go Blind headless phone-size checks (390x844), for the server prototype or the static demo (local or live).
Usage:
  python3 test/e2e_blind.py server                 starts its own server (mock, temp data dir, port 5188) and stops it
  python3 test/e2e_blind.py static <URL>           e.g. https://zigflames.com/lock-and-deploy-vault/
Scans the DOM text of the dashboard, plan (goal), transfers (pending + history), vault, rollover, inbox, settings and the
bot / simulated-bot screens while Go Blind is on: no '$' and no money-looking numbers. Then: the SSI alert shows while blind,
passcode off works (wrong try counted), "stay blind until goal" blocks off until the vault unlocks, and the unlock still shows.
Writes test/last-e2e-blind-<mode>.json and screenshots. Leaves nothing running.
"""
import json, os, re, subprocess, sys, tempfile, time, shutil, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "screenshots"; SHOTS.mkdir(exist_ok=True)
MODE = sys.argv[1] if len(sys.argv) > 1 else "server"
PORT = int(os.environ.get("E2E_BLIND_PORT", "5188"))
URL = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:4191/lock-and-deploy-vault/") if MODE == "static" else f"http://127.0.0.1:{PORT}/"
CHROME = "/usr/bin/google-chrome" if Path("/usr/bin/google-chrome").exists() else None
APP_PASSCODE = "e2e-passcode-123"
BLIND_PIN = "4826"
PREFIX = "" if MODE == "server" else "static-"
MONEY = re.compile(r"\$|\d[\d,]*\.\d{2}|\b\d{1,3}(,\d{3})+\b|\d+\s?%")
KNOWN = re.compile(r"(?<![\d•])(500|1,?000|1,?500|2,?000|3,?000|250)(?![\d])")   # the actual amounts used in this run
results = []

def check(name, cond, detail=""):
    results.append({"name": name, "pass": bool(cond), "detail": str(detail)[:300]})
    print(("PASS " if cond else "FAIL ") + name + (f"  ({str(detail)[:240]})" if detail and not cond else ""))

JS_API = """async ([p, b, h]) => { const t = window.LDB_TRANSPORT || fetch; const r = await t(p, b === null ? { headers: h || {} } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...(h || {}) }, body: JSON.stringify(b) }); return [r.status, await r.json()]; }"""
JS_TEXT = """() => { document.querySelectorAll('.toast').forEach(t => t.remove()); return document.querySelector('#app').innerText; }"""

def run(pg):
    api = lambda path, body=None, h=None: pg.evaluate(JS_API, [path, body, h])
    state = lambda: api("/api/state")[1]
    def go(hash_, wait=500):
        target = URL + hash_
        if pg.url.rstrip("#/") == target.rstrip("#/") or pg.url == target: pg.reload()   # same URL: goto would not re-render
        else: pg.goto(target)
        pg.wait_for_timeout(wait if MODE == "server" else wait + 500)
    def shot(name, sel=None, off=110):
        pg.evaluate("document.querySelectorAll('.toast').forEach(t => t.remove())")
        if sel: pg.evaluate("([s, o]) => { const el = document.querySelector(s); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - o); }", [sel, off])
        else: pg.evaluate("window.scrollTo(0, 0)")
        pg.wait_for_timeout(250); pg.screenshot(path=str(SHOTS / name)); return str(SHOTS / name)

    go("", 1500)
    if MODE == "server":
        c, d = api("/api/auth/setup", {"passcode": APP_PASSCODE})
        check("server: app passcode set (session cookie)", c == 200, d)
    # ---- set up a running schedule (same API the UI uses) ----
    api("/api/link/exchange", {"publicToken": "mock-public-mock_goldcoast-abc12345"})
    api("/api/link/exchange", {"publicToken": "mock-public-mock_harbor-def67890"})
    st = state()
    fund = next(a for a in st["accounts"] if a["mask"] == "4821"); dest = next(a for a in st["accounts"] if a["mask"] == "9034")
    api("/api/accounts/roles", {"fundingAccountId": fund["id"], "destinationAccountId": dest["id"]})
    api("/api/schedule", {"amountCents": 50000, "frequency": "weekly", "anchorDate": st["today"]})
    api("/api/benefit-ack", {"accepted": True, "version": st["benefitWarning"]["version"]})
    txt = api("/api/authorization/text", {"signerName": "Lance Demo"})[1]
    c, d = api("/api/authorization", {"accepted": True, "textHash": txt["textHash"], "signerName": "Lance Demo"})
    check("setup: $500 weekly deposits authorized", c == 200, d)
    for _ in range(40):
        st = state()
        if st["totals"]["vaultCents"] >= 100000 and st["totals"]["pendingCents"] > 0: break
        api("/api/sandbox/clock/advance", {"days": 1})
    check("before blind: settled + pending amounts exist", st["totals"]["vaultCents"] >= 100000 and st["totals"]["pendingCents"] > 0, st["totals"])
    # SSI guard: limit $1,200, warn at 80% -> settled $1,000 is "near"
    c, d = api("/api/settings", {"benefits": {"receivesSSI": True, "resourceLimitCents": 120000, "warnAtPercent": 80}})
    check("settings: I receive SSI, limit + warn % saved", c == 200, d)
    go("#/"); check("before blind: '$' amounts visible on dashboard", "$" in pg.evaluate(JS_TEXT))

    # ---- turn Go Blind on: one tap + confirm (demo: set Go Blind passcode first) ----
    go("#/")
    pg.get_by_test_id("blind-on-open").click(); pg.wait_for_timeout(200)
    if MODE == "static":
        check("demo: Go Blind passcode setup + demo note shown", pg.get_by_test_id("blind-new-passcode").is_visible() and "clearing this site" in pg.get_by_test_id("blind-demo-note").inner_text().lower())
        pg.get_by_test_id("blind-new-passcode").fill("12"); pg.get_by_test_id("blind-new-passcode2").fill("12")
        pg.get_by_test_id("blind-on-confirm").click(); pg.wait_for_timeout(300)
        check("demo: passcode under 4 digits refused", state()["blind"]["on"] is False)
        pg.get_by_test_id("blind-new-passcode").fill(BLIND_PIN); pg.get_by_test_id("blind-new-passcode2").fill(BLIND_PIN)
    pg.get_by_test_id("blind-on-confirm").click(); pg.wait_for_timeout(800)
    st = state()
    check("Go Blind on (redacted), amounts null in state", st["blind"]["on"] and st["blind"]["redacted"] and st["totals"]["vaultCents"] is None, st["blind"])
    if MODE == "static":
        raw = pg.evaluate("() => localStorage.getItem('ldb-vault-demo:state')")
        check("demo: only a salted PBKDF2 hash stored (no plain passcode)", re.search(r'"passcodeHash":"pbkdf2\$310000\$', raw) is not None and f'"{BLIND_PIN}"' not in raw)
        check("demo: hash never sent to the UI", "pbkdf2" not in json.dumps(st))

    # ---- DOM scans ----
    def scan(name, hash_, extra=None):
        go(hash_, 700)
        if extra: extra()
        t = pg.evaluate(JS_TEXT)
        m = MONEY.search(t); k = KNOWN.search(t)
        check(f"blind scan {name}: no $ / money digits in DOM text", not m and not k, (m or k) and t[max(0, (m or k).start() - 60):(m or k).end() + 40])
        return t
    t = scan("dashboard", "#/")
    check("dashboard keeps: lock pill, goal name, deposits status, next deposit date, Hidden text",
          pg.get_by_test_id("lock-pill").is_visible() and st["goal"]["name"].lower() in t.lower() and "active" in pg.get_by_test_id("blind-deposit-status").inner_text().lower()
          and re.search(r"[A-Z][a-z]{2} \d{1,2}", pg.get_by_test_id("next-deposit").inner_text()) and "Hidden · Go Blind on" in t, t[:400])
    check("SSI alert shows while blind (non-numeric)", pg.get_by_test_id("benefits-alert").is_visible() and "SSI resource limit" in pg.get_by_test_id("benefits-alert").inner_text()
          and "ABLE account" in pg.get_by_test_id("benefits-alert").inner_text() and not re.search(r"\d", pg.get_by_test_id("benefits-alert").inner_text()))
    shots = [shot(f"{'14' if MODE == 'server' else '17'}-{PREFIX}blind-dashboard.png")]
    if MODE == "server": shots.append(shot("16-ssi-alert-blind.png", "[data-testid=benefits-alert]", 70))
    check("dashboard: Pause works while blind", True if not pg.get_by_test_id("home-pause").count() else (pg.get_by_test_id("home-pause").click() or pg.wait_for_timeout(500) or state()["schedule"]["status"] == "paused"))
    go("#/"); pg.get_by_test_id("home-resume").click(); pg.wait_for_timeout(500)
    check("dashboard: Resume works while blind", state()["schedule"]["status"] == "active")
    scan("plan / goal", "#/plan")
    t = scan("transfers (pending + history)", "#/transfers")
    check("transfers keep statuses (pending/settled) while blind", "pending" in t.lower() and "settled" in t.lower())
    scan("vault", "#/vault")
    scan("rollover preview", "#/rollover")
    scan("settings", "#/settings")
    scan("more", "#/more")
    scan("emergency stop & bank", "#/bank")
    # bot: propose while blind -> inbox summary has no amounts
    if MODE == "static":
        def sim(action):
            pg.get_by_test_id(f"simbot-{action}").click(); pg.wait_for_timeout(700)
        def botflow():
            sim("status")
        t = scan("sim bot panel (status)", "#/bot", botflow)
        check("sim bot sees statuses, blindMode: true", pg.get_by_test_id("sim-bot-blindmode").is_visible() and "amounts hidden" in pg.get_by_test_id("sim-bot-out").inner_text())
        go("#/bot"); sim("propose_raise"); t = pg.evaluate(JS_TEXT)
        check("sim bot proposal output redacted", not MONEY.search(t), MONEY.search(t))
        go("#/bot"); sim("try_blind_off")
        check("sim bot cannot turn Go Blind off (403)", "403" in pg.get_by_test_id("sim-bot-out").inner_text() and state()["blind"]["on"])
        shots.append(shot("18-static-blind-bot.png", "[data-testid=sim-bot]", 70))
        go("#/bot"); sim("try_reveal_amounts")
        check("sim bot cannot read hidden amounts (403)", "403" in pg.get_by_test_id("sim-bot-out").inner_text())
        c, d = api("/api/demo/wipe", {})
        check("demo: 'start over' refused while blind (use passcode or clear site data)", c == 423, d)
    else:
        key = api("/api/bot-keys", {"name": "Grok", "scopes": ["read", "propose", "pause", "request"]})[1]["key"]
        H = {"Authorization": f"Bearer {key}"}
        c, d = api("/bot/v1/status", None, H)
        check("bot status while blind: blindMode true, amounts null, statuses kept", c == 200 and d.get("blindMode") is True and d["balances"]["settledLockedCents"] is None and d["schedule"]["status"] == "active" and d["goalReached"] is False, d.get("balances"))
        c, d = api("/bot/v1/goals/propose", {"targetCents": 350000, "reason": "Aim $500 higher"}, H)
        j = json.dumps(d); check("bot proposal echo redacted", c in (200, 202) and "$" not in j and not re.search(r'Cents": \d', j) and d.get("blindMode") is True, j[:200])
        c, d = api("/bot/v1/blind/off", {}, H)
        check("bot cannot turn Go Blind off (403)", c == 403 and d.get("error") == "forbidden_for_bot")
        scan("bot page (activity log)", "#/bot")
    scan("inbox (bot proposal while blind)", "#/inbox")
    go("#/log"); t = pg.evaluate(JS_TEXT)
    check("Key events log blind_on (no $ while blind)", "blind_on" in t and "$" not in t)

    # ---- turn off with passcode (one wrong try first) ----
    right = BLIND_PIN if MODE == "static" else APP_PASSCODE
    go("#/"); pg.get_by_test_id("blind-off-open").click(); pg.wait_for_timeout(200)
    pg.get_by_test_id("blind-off-passcode").fill("0000"); pg.get_by_test_id("blind-off-confirm").click(); pg.wait_for_timeout(600)
    msg = pg.get_by_test_id("blind-off-msg").inner_text()
    check("wrong passcode refused, tries left shown", "4 tries left" in msg and state()["blind"]["on"], msg)
    pg.get_by_test_id("blind-off-passcode").fill(right)
    if MODE == "server": shots.append(shot("15-blind-off-passcode.png"))
    else: shots.append(shot("19-static-blind-off-passcode.png"))
    pg.get_by_test_id("blind-off-confirm").click(); pg.wait_for_timeout(900)
    st = state()
    check("passcode off works: amounts visible again", not st["blind"]["on"] and st["totals"]["vaultCents"] >= 100000 and "$" in pg.evaluate(JS_TEXT))
    go("#/log"); t = pg.evaluate(JS_TEXT)
    check("Key events log blind_off_failed + blind_off", "blind_off_failed" in t and "blind_off" in t)

    # ---- stay blind until goal ----
    go("#/"); pg.get_by_test_id("blind-on-open").click(); pg.wait_for_timeout(200)
    pg.get_by_test_id("blind-stay").check(); pg.get_by_test_id("blind-on-confirm").click(); pg.wait_for_timeout(800)
    st = state()
    check("stay blind until goal chosen at turn-on", st["blind"]["on"] and st["blind"]["stayUntilGoal"])
    go("#/")
    check("stay blind: no turn-off button, stay note shown", pg.get_by_test_id("blind-off-open").count() == 0 and pg.get_by_test_id("blind-stay-note").is_visible())
    c, d = api("/api/blind/off", {"passcode": right})
    check("stay blind: right passcode still refused (423)", c == 423 and d.get("error") == "blind_until_goal", d)
    c, d = api("/api/blind/on", {"confirm": True, "stayUntilGoal": False})
    check("stay blind: removing it mid-goal blocked (423)", c == 423, d)
    for _ in range(120):
        st = state()
        if st["goal"]["status"] == "unlocked": break
        api("/api/sandbox/clock/advance", {"days": 1})
    check("goal reached while blind", st["goal"]["status"] == "unlocked")
    go("#/", 800); t = pg.evaluate(JS_TEXT)
    check("unlock still shows: goal-reached banner + unlocked pill", "unlocked" in pg.get_by_test_id("lock-pill").inner_text().lower() and any("goal" in x.lower() for x in pg.get_by_test_id("notification").all_inner_texts()), t[:400])
    check("after unlock amounts show for withdrawal/rollover", "$" in t and st["blind"]["redacted"] is False)
    check("after unlock Go Blind can be turned off", pg.get_by_test_id("blind-off-open").count() == 1)
    go("#/rollover", 700)
    check("rollover wizard available after unlock", pg.get_by_test_id("rollover-wizard").is_visible())
    return shots

def main():
    server = None; data_dir = None
    if MODE == "server":
        data_dir = tempfile.mkdtemp(prefix="ldb-e2e-blind-")
        env = {**os.environ, "PROVIDER": "mock", "DATA_DIR": data_dir, "PORT": str(PORT), "HOST": "127.0.0.1", "SCHEDULER_INTERVAL_SECONDS": "3600", "SIM_DATE": "2026-10-05"}
        for k in ["PLAID_ENV", "PLAID_CLIENT_ID", "PLAID_SECRET", "NODE_ENV"]: env.pop(k, None)
        server = subprocess.Popen(["node", "server/index.js"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try: urllib.request.urlopen(URL + "api/auth/status", timeout=1); break
            except Exception: time.sleep(0.1)
    else:
        with urllib.request.urlopen(URL, timeout=20) as r: check("GET demo -> 200", r.status == 200, r.status)
    shots = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path=CHROME, headless=True) if CHROME else p.chromium.launch(headless=True)
            ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
            pg = ctx.new_page(); errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("dialog", lambda d: d.accept())
            try: shots = run(pg)
            except Exception as e: check("run completed", False, repr(e))
            check("no page errors", not errors, errors[:3])
            b.close()
    finally:
        if server: server.terminate(); server.wait(10)
        if data_dir: shutil.rmtree(data_dir, ignore_errors=True)
    n = sum(r["pass"] for r in results)
    print(f"\n{n}/{len(results)} checks passed ({MODE}: {URL})"); print("screenshots:", *shots, sep="\n  ")
    (ROOT / "test" / f"last-e2e-blind-{MODE}.json").write_text(json.dumps({"url": URL, "passed": n, "total": len(results), "results": results, "screenshots": shots}, indent=2))
    sys.exit(0 if n == len(results) else 1)

main()
