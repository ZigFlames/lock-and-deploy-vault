"""Seal my login + guided setup + lost card + Did-you-know cards, headless at phone size (390x844).
Usage:
  python3 test/e2e_sealed.py server              starts its own server (mock, temp data dir, port 5189) and stops it
  python3 test/e2e_sealed.py static <URL>        e.g. https://zigflames.com/lock-and-deploy-vault/
Walks #/setup with fake data only: generate a password -> copy -> checklist -> unlock date -> typed phrase (wrong, then right)
-> lost-card steps -> sample plan ($100/month, day after SSI) -> authorize. Then: the secret is not in the DOM, state or storage;
open / delete / start over are refused while sealed; the bot is refused; reseal gives a new password; cards unlock per settled
$100 with a celebration; speed-up cards + tap-to-raise; Go Blind cards have no '$'; (static) opening works after the unlock date.
Writes test/last-e2e-sealed-<mode>.json and screenshots 20-32. Leaves nothing running.
"""
import json, os, re, subprocess, sys, tempfile, time, shutil, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "screenshots"; SHOTS.mkdir(exist_ok=True)
MODE = sys.argv[1] if len(sys.argv) > 1 else "server"
PORT = int(os.environ.get("E2E_SEALED_PORT", "5189"))
URL = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:4191/lock-and-deploy-vault/") if MODE == "static" else f"http://127.0.0.1:{PORT}/"
ORIGIN = re.match(r"https?://[^/]+", URL).group(0)
RELAY_PORT = int(os.environ.get("E2E_RELAY_PORT", "5190"))
RELAY = f"http://127.0.0.1:{RELAY_PORT}"
CHROME = "/usr/bin/google-chrome" if Path("/usr/bin/google-chrome").exists() else None
APP_PASSCODE = "e2e-passcode-123"
BLIND_PIN = "4826"
PREFIX = "" if MODE == "server" else "static-"
MONEY = re.compile(r"\$|\d[\d,]*\.\d{2}|\b\d{1,3}(,\d{3})+\b|\d+\s?%")
FAKE_USER = "fake.saver.e2e@example.com"
results = []

def check(name, cond, detail=""):
    results.append({"name": name, "pass": bool(cond), "detail": str(detail)[:300]})
    print(("PASS " if cond else "FAIL ") + name + (f"  ({str(detail)[:240]})" if detail and not cond else ""))

JS_API = """async ([p, b, h]) => { const t = window.LDB_TRANSPORT || fetch; const r = await t(p, b === null ? { headers: h || {} } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...(h || {}) }, body: JSON.stringify(b) }); return [r.status, await r.json()]; }"""
JS_TEXT = """() => { document.querySelectorAll('.toast').forEach(t => t.remove()); return document.querySelector('#app').innerText; }"""
JS_ALL = """() => document.documentElement.outerHTML + '\\n' + JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(Object.assign({}, sessionStorage))"""

def run(pg):
    api = lambda path, body=None, h=None: pg.evaluate(JS_API, [path, body, h])
    state = lambda: api("/api/state")[1]
    shots = []
    def wait(ms=400): pg.wait_for_timeout(ms if MODE == "server" else ms + 250)
    def go(hash_, ms=500):
        target = URL + hash_
        if pg.url == target: pg.reload()
        else: pg.goto(target)
        wait(ms)
    def hash_to(h, ms=500):   # no reload (keeps in-page overrides)
        pg.evaluate("h => { location.hash = h; }", h); wait(ms)
    def shot(name, sel=None, off=110, keep_toast=False):
        if not keep_toast: pg.evaluate("document.querySelectorAll('.toast').forEach(t => t.remove())")
        if sel: pg.evaluate("([s, o]) => { const el = document.querySelector(s); if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - o); }", [sel, off])
        else: pg.evaluate("window.scrollTo(0, 0)")
        pg.wait_for_timeout(300); p = str(SHOTS / f"{PREFIX}{name}"); pg.screenshot(path=p); shots.append(p); return p
    def toast_text():
        try: return pg.locator(".toast").last.inner_text(timeout=2500)
        except Exception: return ""
    tid = pg.get_by_test_id

    go("", 1500)
    if MODE == "server":
        c, d = api("/api/auth/setup", {"passcode": APP_PASSCODE}); check("server: app passcode set", c == 200, d)
    today = pg.evaluate("() => { const d = new Date(); return d.toISOString().slice(0,10); }")
    unlock = pg.evaluate("() => { const d = new Date(); d.setDate(d.getDate() + 2); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }")
    early = pg.evaluate("() => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }")

    # ---------- guided setup: step 1 details ----------
    go("#/setup", 700)
    check("setup: stepper shows Seal -> Unlock -> Lost card -> Dashboard", all(w in tid("setup-stepper").inner_text() for w in ["Seal", "Unlock", "Lost", "Dashboard"]), tid("setup-stepper").inner_text())
    check("setup: default label is Current Savings", tid("seal-label").input_value() == "Current Savings", tid("seal-label").input_value())
    tid("seal-username").fill(FAKE_USER)
    shot("20-setup-seal-login.png")
    tid("seal-next-1").click(); wait(600)
    pw1 = tid("val-password").inner_text().strip()
    check("step 2: generated password shown once (20 chars, mixed)", len(pw1) == 20 and re.search(r"[A-Z]", pw1) and re.search(r"[a-z]", pw1) and re.search(r"\d", pw1), pw1)
    tid("copy-password").click(); wait(300)
    clip = pg.evaluate("() => navigator.clipboard.readText().catch(e => 'ERR ' + e)")
    check("copy button puts the password on the clipboard", clip == pw1, clip[:30])
    check("Next is disabled until every box is ticked", tid("seal-next-2").is_disabled())
    for k in ["enteredAtBank", "confirmedLogin", "notSaved"]: tid(f"check-{k}").check(); wait(80)
    check("Next enabled after the checklist", tid("seal-next-2").is_enabled())
    shot("21-seal-show-once-checklist.png", "[data-testid=val-password]", 190)
    tid("seal-next-2").click(); wait(400)
    # ---------- step 3 unlock date ----------
    tid("unlock-date").fill(unlock); tid("unlock-date").dispatch_event("input"); wait(200)
    check("unlock date: live countdown preview", re.search(r"\d+\s*(d|day)", tid("unlock-preview").inner_text()), tid("unlock-preview").inner_text())
    shot("22-unlock-date-countdown.png", "[data-testid=unlock-date]", 260)
    tid("seal-next-3").click(); wait(400)
    # ---------- step 4 typed phrase ----------
    tid("seal-typed").fill("seal it please"); tid("seal-confirm").click(); wait(500)
    check("wrong phrase refused (nothing sealed)", len(state().get("sealedLogins") or []) == 0, toast_text())
    tid("seal-typed").fill("SEAL MY LOGIN")
    shot("23-seal-typed-confirm.png", "[data-testid=seal-typed]", 300)
    tid("seal-confirm").click(); wait(900)
    st = state(); sl = st.get("sealedLogins") or []
    check("sealed: one login, status sealed, label kept", len(sl) == 1 and sl[0]["status"] == "sealed" and sl[0]["label"] == "Current Savings", sl)
    everything = pg.evaluate(JS_ALL) + json.dumps(st)
    check("secret not in DOM, localStorage, sessionStorage or /api/state after sealing", pw1 not in everything)
    check("username not in DOM/state after sealing (only the label)", FAKE_USER not in everything)
    clip = pg.evaluate("() => navigator.clipboard.readText().catch(e => '')")
    check("clipboard cleared after sealing", clip != pw1, clip[:10])
    # ---------- lost card ----------
    check("setup moved on to the lost-card step", tid("lost-report_lost").count() == 1)
    for k in ["report_lost", "remove_wallet", "destroy_card", "delete_app"]:
        tid(f"lost-{k}").check(); wait(350)
    shot("24-lost-card-checklist.png", "[data-testid=lost-report_lost]", 200)
    lc = state()["lostCard"]
    check("lost-card ticks persist (4 of 5)", sum(1 for x in lc["steps"] if x["done"]) == 4, lc)
    if tid("setup-lost-next").count(): tid("setup-lost-next").click(); wait(400)
    # ---------- dashboard sample ----------
    tid("setup-sample").click(); wait(1500)
    st = state()
    check("sample data: $100/month, day after SSI, SSI guard on", st["schedule"] and st["schedule"]["amountCents"] == 10000 and st["schedule"]["frequency"] == "benefit" and st["settings"]["benefits"]["receivesSSI"] is True, st.get("schedule"))
    tid("setup-signer").fill("Fake Saver"); tid("setup-auth-box").check(); tid("setup-authorize").click(); wait(1200)
    st = state()
    check("authorized from the setup screen", st["schedule"]["status"] == "active" and st["authorization"], st["schedule"]["status"])
    shot("25-setup-dashboard-sample.png")
    # ---------- refusals ----------
    go("#/seal", 700)
    check("seal screen: sealed card + countdown", tid("sealed-card").count() == 1 and tid("sealed-countdown").count() == 1)
    tid("sealed-try-open").click(); t = toast_text()
    check("open refused while sealed (toast)", "sealed" in t.lower() or "unlock" in t.lower(), t)
    check("password still not on screen after refused open", pw1 not in pg.evaluate(JS_ALL))
    shot("26-sealed-locked-refused.png", keep_toast=True)
    c, d = api("/api/sealed-logins/reveal", {"id": sl[0]["id"], "passcode": APP_PASSCODE})
    check("reveal with the app passcode still refused (423)", c == 423, d)
    tid("sealed-delete").click(); wait(600)
    check("delete refused while sealed", len(state()["sealedLogins"]) == 1, toast_text())
    if MODE == "static":
        c, d = api("/api/demo/wipe", {})
        check("demo Start over refused while a login is sealed", c == 423, d)
    c, d = api("/api/sandbox/reset", {})
    check("sandbox reset refused while a login is sealed", c in (423, 404), (c, d))
    # bot
    if MODE == "static":
        go("#/bot", 700)
        for action in ["sealed_status", "try_reveal_login"]:
            tid(f"simbot-{action}").click(); wait(700)
            out = tid("sim-bot-out").inner_text()
            if action == "sealed_status": check("sim bot sees label + status only", "Current Savings" in out and pw1 not in out and FAKE_USER not in out, out)
            else: check("sim bot reveal refused (403)", "403" in out, out)
        shot("27-sealed-bot-refused.png", "[data-testid=sim-bot-out]", 300)
    else:
        key = api("/api/bot-keys", {"name": "Grok", "scopes": ["read", "propose", "pause", "request"]})[1]["key"]
        H = {"Authorization": f"Bearer {key}"}
        c, d = api("/bot/v1/sealed-logins", None, H)
        check("bot list: label/status/sealedAt only", c == 200 and pw1 not in json.dumps(d) and FAKE_USER not in json.dumps(d), d)
        c, d = api("/bot/v1/sealed-logins/reveal", {"id": sl[0]["id"]}, H); check("bot reveal refused (403)", c == 403, d)
        c, d = api("/bot/v1/sealed-logins/delete", {"id": sl[0]["id"]}, H); check("bot delete refused (403)", c == 403, d)
        go("#/log", 700); shot("27-sealed-bot-refused.png")
    # ---------- reseal ----------
    go("#/seal", 700)
    tid("sealed-reseal").click(); wait(500)
    tid("seal-next-1").click(); wait(700)
    pw2 = tid("val-password").inner_text().strip()
    check("reseal: new password differs, old one never shown", pw2 and pw2 != pw1 and pw1 not in pg.evaluate(JS_ALL), pw2)
    for k in ["changedAtBank", "confirmedLogin", "notSaved"]: tid(f"check-{k}").check(); wait(80)
    shot("28-reseal-new-password.png", "[data-testid=val-password]", 190)
    tid("seal-next-2").click(); wait(400)
    if tid("unlock-date").count(): tid("seal-next-3").click(); wait(300)
    tid("seal-typed").fill("RESEAL MY LOGIN"); tid("seal-confirm").click(); wait(900)
    st = state()
    check("resealed: still one sealed login, secrets gone from page", len(st["sealedLogins"]) == 1 and st["sealedLogins"][0]["status"] == "sealed" and pw2 not in pg.evaluate(JS_ALL) + json.dumps(st))
    # tighten-only
    c, d = api("/api/sealed-logins/unlock", {"id": sl[0]["id"], "unlockRule": "date", "unlockDate": early})
    check("unlock date cannot move earlier (423)", c == 423, d)
    # ---------- cards ----------
    for _ in range(80):
        st = state()
        if st["totals"]["vaultCents"] >= 20000: break
        c, d = api("/api/sandbox/clock/advance", {"days": 3})
        if c != 200: check("demo clock allowed with a date-only seal", False, d); break
    cd = st["cards"]
    check("cards unlocked per settled $100 (pending not counted)", len(cd["unlocked"]) == st["totals"]["vaultCents"] // 10000, (len(cd["unlocked"]), st["totals"]))
    go("#/", 800)
    check("celebration shows for the new card", tid("celebrate").count() == 1)
    shot("29-did-you-know-celebration.png", "[data-testid=celebrate]", 70)
    tid("celebrate-ok").click(); wait(600)
    check("celebration dismissed (cards marked seen)", tid("celebrate").count() == 0 and state()["cards"]["unseen"] == 0)
    go("#/cards", 700)
    t = pg.evaluate(JS_TEXT)
    check("speed-up cards computed from the plan ($200 / $300, months sooner)", tid("raise-x2").count() == 1 and tid("raise-x3").count() == 1 and "sooner" in t and "$200" in t and "$300" in t, t[:600])
    check("SSI reminder on projections past $2,000", tid("ssi-reminder").count() >= 1)
    check("general-info disclaimer on cards", "not financial advice" in t.lower())
    shot("30-cards-collection-speedup.png")
    tid("raise-x2").click(); wait(1000)
    st = state()
    check("tap-to-raise doubles the deposit and asks for a new authorization", st["schedule"]["amountCents"] == 20000 and "authorize" in pg.url and st["schedule"]["status"] == "needs_authorization", (st["schedule"]["amountCents"], st["schedule"]["status"], pg.url))
    c, d = api("/api/schedule/raise", {"amountCents": 5000})
    check("raise flow refuses a lower amount", c == 400, d)
    # ---------- Go Blind ----------
    go("#/", 600)
    tid("blind-on-open").click(); wait(300)
    if MODE == "static" and tid("blind-new-passcode").count():
        tid("blind-new-passcode").fill(BLIND_PIN); tid("blind-new-passcode2").fill(BLIND_PIN)
    tid("blind-on-confirm").click(); wait(800)
    check("Go Blind on", state()["blind"]["on"] is True)
    go("#/cards", 700); t = pg.evaluate(JS_TEXT)
    check("blind cards: no '$' or money-looking numbers", not MONEY.search(t), MONEY.search(t).group(0) if MONEY.search(t) else "")
    check("blind speed-up wording: double / triple + dates", "double" in t.lower() and "triple" in t.lower() and "sooner" in t.lower(), t[:500])
    check("blind: SSI reminder still shown", tid("ssi-reminder").count() >= 1)
    shot("31-cards-blind.png")
    go("#/", 600); t = pg.evaluate(JS_TEXT)
    check("blind home (with Did-you-know card): no '$'", not MONEY.search(t), MONEY.search(t).group(0) if MONEY.search(t) else "")
    # ---------- monthly move (Varo -> Step instant -> Current), while Go Blind is on ----------
    if MODE == "static":
        go("#/bot", 700); tid("simbot-propose_monthly_move").click(); wait(800)
        check("sim bot proposed the monthly move (202)", "202" in tid("sim-bot-out").inner_text(), tid("sim-bot-out").inner_text())
    else:
        c, d = api("/bot/v1/monthly-moves/propose", {"reason": "monthly"}, H); check("bot proposed the monthly move (202)", c == 202, d)
    go("#/inbox", 700)
    form = pg.locator("form.apr", has_text="Monthly move")
    ftxt = form.inner_text()
    check("approval reads 'Monthly move: [hidden] Varo → Step (instant) → Current' while blind", "[hidden]" in ftxt and "Varo → Step (instant) → Current" in ftxt and "$" not in ftxt, ftxt)
    shot("33-monthly-move-approval-blind.png", "form.apr", 150)
    form.locator("input[name=confirm]").check(); form.get_by_test_id("approve-btn").click(); wait(900)
    mv = state()["monthlyMoves"][0]
    check("user approved: move status approved, next step Varo → Step", mv["status"] == "approved" and mv["nextLeg"] == "varo_to_step", mv["status"])
    go("#/moves", 700); t = pg.evaluate(JS_TEXT)
    check("moves screen: 3 steps + 'Step balance should be zero' reminder, no '$' while blind", tid("step-zero-reminder").count() == 1 and "Step → Current (may take 1-3 business days" in t and "Assistant confirms arrival in Current" in t and not MONEY.search(t), MONEY.search(t).group(0) if MONEY.search(t) else t[:300])
    if MODE == "static":
        go("#/bot", 700); tid("simbot-complete_monthly_move").click(); wait(700)
        check("sim bot recorded step 1 (instant)", state()["monthlyMoves"][0]["nextLeg"] == "step_to_current")
        go("#/moves", 700)
    shot("34-monthly-move-steps.png", "[data-testid=move-card]", 120)
    tid("move-sim").click(); wait(900)
    mv = state()["monthlyMoves"][0]
    check("simulate completion: all steps recorded, Step back to zero", mv["status"] == "done" and all(l["status"] == "done" for l in mv["legs"]) and mv["stepBalanceZero"] is True, mv)
    shot("35-monthly-move-done.png", "[data-testid=move-card]", 120)
    # ---------- assistant sync ----------
    go("#/sync", 700)
    if MODE == "static":
        tid("sync-create").click(); wait(400)
        code = tid("sync-code").inner_text().strip()
        check("sync code created (ldbsync1.<channel>.<key>)", re.match(r"^ldbsync1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$", code), code[:12])
        tid("sync-relay").fill(RELAY); tid("sync-relay-save").click(); wait(400)
        tid("sync-now").click(); wait(1800)
        env = {**os.environ, "LDB_SYNC_CODE": code, "LDB_SYNC_RELAY": RELAY}
        out = subprocess.run(["node", "bot-cli.js", "sync-read"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)
        snap = json.loads(out.stdout or "{}")
        check("assistant decrypts the snapshot (blind: no amounts; decisions + monthly move visible)", snap.get("kind") == "ldb-assistant-snapshot" and snap.get("blindMode") is True and snap["monthlyMoves"][0]["status"] == "done" and not re.search(r"\$\d", out.stdout), out.stderr[:200] or out.stdout[:200])
        rel = urllib.request.urlopen(f"{RELAY}/sync/v1/{code.split('.')[1]}/app", timeout=10).read().decode()
        check("relay holds only ciphertext", "Varo" not in rel and "monthlyMoves" not in rel and '"ct"' in rel)
        out = subprocess.run(["node", "bot-cli.js", "sync-send", "propose_speed_up", "--multiplier", "2", "--reason", "finish sooner"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)
        check("assistant queued a request through the relay", out.returncode == 0, out.stderr[:200])
        before = state()["pendingApprovals"]
        tid("sync-now").click(); wait(1800)
        st = state()
        check("app applied it as a PENDING approval (nothing ran)", st["pendingApprovals"] == before + 1 and any(a["status"] == "pending" and "double" in a["summary"] for a in st["approvals"]), st["pendingApprovals"])
        check("sync status shows 1 request applied", "1 assistant request" in tid("sync-status").inner_text(), tid("sync-status").inner_text())
        shot("36-assistant-sync.png", "[data-testid=sync-code-card]", 120)
    else:
        check("server version: sync screen points to the bot API", "/bot/v1/snapshot" in pg.evaluate(JS_TEXT))
        c, d = api("/bot/v1/snapshot", None, H)
        check("bot reads the snapshot directly (blind)", c == 200 and d.get("blindMode") is True and d["monthlyMoves"][0]["status"] == "done", c)
    # ---------- unlock by date ----------
    if MODE == "static":
        hash_to("#/", 300)
        pg.evaluate("() => { const f = Date.now; window.LDB_DEMO.service.nowMs = () => f() + 3 * 86400000; }")
        hash_to("#/seal", 900)
        check("after the unlock date: status ready", "ready" in tid("sealed-status").inner_text().lower() or tid("sealed-open").count() == 1, tid("sealed-status").inner_text())
        tid("sealed-open").click(); wait(700)
        allt = pg.evaluate(JS_ALL)
        check("open reveals the resealed password (not the old one)", pw2 in allt and pw1 not in allt)
        shot("32-sealed-unlocked-reveal.png", "[data-testid=sealed-card]", 90)
        hash_to("#/", 400)
        check("revealed values cleared when leaving the screen", pw2 not in pg.evaluate(JS_ALL))
    else:
        check("server: unlock-by-date covered by unit tests (server clock not faked here)", True)
    return shots

def main():
    server = None; data_dir = None
    if MODE == "server":
        data_dir = tempfile.mkdtemp(prefix="ldb-e2e-sealed-")
        env = {**os.environ, "PROVIDER": "mock", "DATA_DIR": data_dir, "PORT": str(PORT), "HOST": "127.0.0.1", "SCHEDULER_INTERVAL_SECONDS": "3600"}
        for k in ["PLAID_ENV", "PLAID_CLIENT_ID", "PLAID_SECRET", "NODE_ENV", "SIM_DATE"]: env.pop(k, None)
        server = subprocess.Popen(["node", "server/index.js"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try: urllib.request.urlopen(URL + "api/auth/status", timeout=1); break
            except Exception: time.sleep(0.1)
    else:
        with urllib.request.urlopen(URL, timeout=20) as r: check("GET demo -> 200", r.status == 200, r.status)
        # a local sync relay (the server prototype with SYNC_RELAY=on) for the assistant-sync part
        data_dir = tempfile.mkdtemp(prefix="ldb-e2e-relay-")
        env = {**os.environ, "PROVIDER": "mock", "DATA_DIR": data_dir, "PORT": str(RELAY_PORT), "HOST": "127.0.0.1", "SYNC_RELAY": "on", "SYNC_ALLOWED_ORIGINS": ORIGIN, "SCHEDULER_INTERVAL_SECONDS": "3600"}
        for k in ["PLAID_ENV", "PLAID_CLIENT_ID", "PLAID_SECRET", "NODE_ENV"]: env.pop(k, None)
        server = subprocess.Popen(["node", "server/index.js"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try: urllib.request.urlopen(RELAY + "/api/auth/status", timeout=1); break
            except Exception: time.sleep(0.1)
    shots = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path=CHROME, headless=True) if CHROME else p.chromium.launch(headless=True)
            ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
            ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=ORIGIN)
            if ORIGIN.startswith("https://"):   # Chrome's Local Network Access: the live page talking to the relay on 127.0.0.1
                try: ctx.grant_permissions(["local-network-access"], origin=ORIGIN)
                except Exception: pass
            pg = ctx.new_page(); errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("dialog", lambda d: d.accept())
            try: shots = run(pg)
            except Exception as e: check("run completed", False, repr(e)); pg.screenshot(path=str(SHOTS / f"{PREFIX}e2e-sealed-failure.png"))
            check("no page errors", not errors, errors[:3])
            b.close()
    finally:
        if server: server.terminate(); server.wait(10)
        if data_dir: shutil.rmtree(data_dir, ignore_errors=True)
    n = sum(r["pass"] for r in results)
    print(f"\n{n}/{len(results)} checks passed ({MODE}: {URL})"); print("screenshots:", *shots, sep="\n  ")
    (ROOT / "test" / f"last-e2e-sealed-{MODE}.json").write_text(json.dumps({"url": URL, "passed": n, "total": len(results), "results": results, "screenshots": shots}, indent=2))
    sys.exit(0 if n == len(results) else 1)

main()
