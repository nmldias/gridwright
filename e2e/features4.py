#!/usr/bin/env python3
"""Server-side Python cells: the host's CPython runs a cell inside a sandbox, with the same `q` API and
output shape as the browser runtime; new Python cells default to the server when it offers one; run
records say which runtime executed and under which sandbox; limits and isolation hold; agents can
file server-side code cells as proposals.

Usage: python3 e2e/features4.py [http://localhost:8787] [--data /path/to/GRIDWRIGHT_DATA]
The server should run with GRIDWRIGHT_PYTHON_TIMEOUT_MS=5000 so the time-limit check is quick.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = ARGS[0] if ARGS else "http://localhost:8787"
DATA = "/tmp/gw-data"
for i, a in enumerate(sys.argv):
    if a == "--data":
        DATA = sys.argv[i + 1]
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)


def rest(method, path, body=None, raw=False):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
            return (r.status, data.decode()) if raw else json.loads(data.decode())
    except urllib.error.HTTPError as e:
        if raw:
            return (e.code, e.read().decode())
        raise


SNAP = {"tables": [{"id": 1, "name": "Orders", "rows": 4, "cols": 2, "values": [["Item", "Amount"], ["a", 10], ["b", 20], ["c", 30.5]]}], "current": {"table": 1, "row": 0, "col": 0}}


def run(code, gpu=False):
    return rest("POST", "/api/python/run", {"code": code, "snapshot": SNAP, "gpu": gpu})


def main():
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    # ------------------------------------------------------------------ the runtime through the API
    health = rest("GET", "/api/health")
    py = health.get("python")
    check("health reports a server-side Python runtime with its sandbox level", bool(py) and py.get("version") and py.get("sandbox") in ("bwrap", "unshare", "none"), str(py))
    if not py:
        print("server-side Python is off on this server — nothing more to test")
        sys.exit(1)
    sandbox = py["sandbox"]
    r = run("df = q.df('A1:B4'); df.Amount.sum()")
    check("a cell runs on the server with pandas and the browser's q API", r["ok"] and r["output"] == [[60.5]] and r["runtime"]["name"] == "python-server" and r["runtime"]["packages"].get("sandbox") == sandbox, json.dumps(r)[:160])
    check("the ranges a run read are reported as its dependencies", r["deps"] == [{"table": 1, "r0": 0, "c0": 0, "r1": 3, "c1": 1}], str(r["deps"]))
    t0 = time.time()
    rs = [run("sum(range(1000))") for _ in range(5)]
    per = (time.time() - t0) / 5 * 1000
    check("warm host: a small cell runs in well under a second", all(x["ok"] for x in rs) and per < 800, f"{per:.0f} ms per run")
    r = run("import socket\nres = 'open'\ntry:\n    socket.create_connection(('1.1.1.1', 53), timeout=2)\nexcept Exception as e:\n    res = 'blocked'\nres")
    if sandbox in ("bwrap", "unshare"):
        check(f"no network inside the sandbox ({sandbox})", r["ok"] and r["output"] == [["blocked"]], str(r.get("output")))
    else:
        print("SKIP network isolation (sandbox: none)")
    secret = os.path.join(DATA, "secret.key")
    # the directory name may survive as an empty mountpoint (when it lives under /tmp); its contents never do
    r = run("import os\nos.path.exists(%r), (os.listdir(%r) if os.path.isdir(%r) else [])" % (secret, DATA, DATA))
    if sandbox == "bwrap":
        check("the data directory (secrets, documents) is hidden from sandboxed code", r["ok"] and r["output"] == [[False], ["[]"]], f"{r.get('output')} for {DATA}")
    else:
        print(f"SKIP data-directory hiding (sandbox: {sandbox})")
    r = run("while True: pass")
    check("a run past the time limit is killed and reported", not r["ok"] and "time limit" in (r.get("error") or ""), (r.get("error") or "")[:80])
    r = run("sum(range(10))")
    check("the host survives a killed run", r["ok"] and r["output"] == [[45]], str(r.get("output")))
    r = run("x = bytearray(8 * 1024 ** 3); 1")
    check("the memory limit holds", not r["ok"] and ("MemoryError" in (r.get("error") or "") or "killed" in (r.get("error") or "")), (r.get("error") or "")[:60])
    r = run("import matplotlib.pyplot as plt\nf, a = plt.subplots()\na.bar(['a', 'b'], [1, 2])\nf")
    check("matplotlib figures come back as pictures", r["ok"] and isinstance(r["output"], dict) and r["output"].get("image", "").startswith("data:image/png"), str(r.get("output"))[:60])
    r = run("q.cells('Nope::A1')")
    check("errors keep the user's frames and the message", not r["ok"] and 'File "<cell>"' in r["error"] and 'table "Nope" not found' in r["error"] and "gridwright_runner" not in r["error"], r["error"][:120])
    r = run("1", gpu=True)
    check("a GPU request on a host without cuDF runs on the CPU and says so", r["ok"] and str(r["runtime"]["packages"].get("gpu", "")).startswith(("cudf", "unavailable")), str(r["runtime"]["packages"].get("gpu")))

    # ------------------------------------------------------------------ in the browser
    with sync_playwright() as p:
        args = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        browser = p.chromium.launch(headless=True, args=args)
        ctx = browser.new_context(viewport={"width": 1500, "height": 950})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.6)

        def apply(op, **opts):
            return page.evaluate("([op, opts]) => window.__gw.book.apply(op, opts)", [op, opts])

        def cell(table, r, c):
            return page.evaluate("([t,r,c]) => { const s = window.__gw.getState(); const cell = s.cells.get(t)?.get(r*65536+c); return cell ? { i: cell.i, v: cell.v, k: cell.k, ss: cell.ss, err: cell.err, out: cell.out, runtime: cell.runtime, gpu: cell.gpu } : null; }", [table, r, c])

        def num(v):
            return v["v"]["n"] if v and v["v"] and "n" in v["v"] else None

        def state():
            return page.evaluate("() => { const s = window.__gw.getState(); return { fileId: s.fileId, panel: s.panel, serverPython: s.serverPython, status: s.status }; }")

        def wait_result(table, r, c, timeout=30):
            for _ in range(int(timeout * 10)):
                v = cell(table, r, c)
                if v and (v.get("ss") or v.get("err") or (v["v"] and v["v"] != {"e": "#RUNNING"})) and v["v"] is not None:
                    return v
                time.sleep(0.1)
            return cell(table, r, c)

        page.evaluate("() => window.__gw.getState().set({ fileName: 'Round four' })")
        page.evaluate("() => document.querySelector('.topbar button[title^=\"Save\"]').click()")
        for _ in range(60):
            if state()["fileId"]:
                break
            time.sleep(0.2)
        fid = state()["fileId"]
        check("the client learnt about the server runtime from /api/health", bool(state()["serverPython"]) and state()["serverPython"]["sandbox"] == sandbox, str(state()["serverPython"]))

        T = 1
        apply({"type": "set_cells", "table": T, "row": 0, "col": 6, "values": [["Item", "Amount"], ["a", "10"], ["b", "20"], ["c", "30.5"]]})
        # press Py on a cell: the new cell runs on the server by default
        page.evaluate("([t,r,c]) => window.__gw.getState().set({ selection: { table: t, r0: r, c0: c, r1: r, c1: c, ar: r, ac: c }, selectedTable: null })", [T, 6, 6])
        page.click(".topbar button[title='Turn the selected cell into a Python cell']")
        time.sleep(0.4)
        made = cell(T, 6, 6)
        check("a new Python cell defaults to the server runtime", made is not None and made["k"] == "python" and made.get("runtime") == "server", str(made)[:120])
        page.wait_for_selector(".code-panel .runtime-select", timeout=5000)
        sel = page.input_value(".code-panel .runtime-select")
        pill = page.text_content(".code-panel .panel-title .pill") or ""
        check("the Code panel shows the runtime choice and the sandbox level", sel == "server" and pill.startswith("server"), f"{sel} / {pill}")
        check("the GPU option is visible and labelled by availability", page.locator(".code-panel label.check").count() == 1 and ("GPU" in (page.text_content(".code-panel label.check") or "")), page.text_content(".code-panel label.check") or "")
        ch = apply({"type": "set_cell", "table": T, "row": 6, "col": 6, "input": "df = q.df('G1:H4')\ndf['Double'] = df['Amount'] * 2\ndf", "kind": "python", "runtime": "server"})
        v = wait_result(T, 6, 6)
        check("the server-run cell spills a DataFrame with its header", v is not None and v.get("ss") == [4, 3] and num(cell(T, 9, 8)) == 61, f"{ch.get('error')} {v} {cell(T, 9, 8)}")
        page.screenshot(path=f"{OUT}/f4-01-server-cell.png")
        # run record
        runs = []
        for _ in range(40):
            h = rest("GET", f"/api/files/{fid}/history?limit=50")
            runs = [e["run"] for e in h["entries"] if e.get("run") and e["run"].get("col") == 6]
            if runs:
                break
            time.sleep(0.25)
        rec = runs[0] if runs else {}
        check("the run record names the server runtime, the sandbox and the packages used", rec.get("runtime", {}).get("name") == "python-server" and rec["runtime"]["packages"].get("sandbox") == sandbox and "pandas" in rec["runtime"]["packages"], json.dumps(rec.get("runtime"))[:160])
        # editing an input re-runs the cell on the server
        apply({"type": "set_cell", "table": T, "row": 1, "col": 7, "input": "100"})
        for _ in range(100):
            if num(cell(T, 7, 8)) == 200:
                break
            time.sleep(0.1)
        check("changing a cell the code read re-runs it on the server", num(cell(T, 7, 8)) == 200, str(cell(T, 7, 8)))
        # errors show in the panel
        apply({"type": "set_cell", "table": T, "row": 6, "col": 6, "input": "1/0", "kind": "python", "runtime": "server"})
        for _ in range(100):
            v = cell(T, 6, 6)
            if v and v.get("err"):
                break
            time.sleep(0.1)
        check("a server-side error is shown on the cell with its traceback", bool(v.get("err")) and "ZeroDivisionError" in v["err"], str(v.get("err"))[:80])
        page.wait_for_selector(".code-panel .code-output pre.err", timeout=5000)
        # switching back to the browser runtime clears the flag (and the GPU flag with it)
        page.select_option(".code-panel .runtime-select", "browser")
        time.sleep(0.3)
        v = cell(T, 6, 6)
        check("switching to the browser runtime clears the server and GPU flags", v is not None and not v.get("runtime") and not v.get("gpu"), str(v)[:100])
        page.select_option(".code-panel .runtime-select", "server")
        time.sleep(0.3)
        page.check(".code-panel label.check input")
        time.sleep(0.3)
        v = cell(T, 6, 6)
        check("the GPU opt-in is stored on the cell", v is not None and v.get("runtime") == "server" and v.get("gpu") is True, str(v)[:100])
        page.screenshot(path=f"{OUT}/f4-02-code-panel.png")

        # ------------------------------------------------------------------ agents: a server-side code cell as a proposal
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "propose_edit", "arguments": {"id": fid, "title": "Totals by item", "actions": [{"action": "code_cell", "table": "Table 1", "ref": "F1", "language": "python", "runtime": "server", "gpu": True, "code": "df = q.df('G1:H4')\ndf.Amount.sum()"}]}}}
        code, text = rest("POST", "/mcp", body, raw=True)
        res = json.loads(text).get("result", {})
        prop = json.loads("".join(c.get("text", "") for c in res.get("content", []))) if not res.get("isError") else {}
        stored = rest("GET", f"/api/files/{fid}/proposals/{prop.get('proposal')}") if prop.get("proposal") else {}
        op = (stored.get("ops") or [{}])[0]
        check("an agent can propose a server-side (GPU-requested) Python cell", op.get("type") == "set_cell" and op.get("runtime") == "server" and op.get("gpu") is True, json.dumps(op)[:160])
        page.evaluate("() => window.__gw.getState().set({ panel: 'review' })")
        page.wait_for_selector(".review-panel .proposal.pending", timeout=8000)
        page.locator(".review-panel .proposal.pending", has_text="Totals by item").locator("button.primary").click()
        v = wait_result(T, 0, 5)
        check("applying it runs the cell on the server", v is not None and v.get("runtime") == "server" and num(v) == 150.5, str(v)[:120])
        page.screenshot(path=f"{OUT}/f4-03-review.png")
        browser.close()
    check("no uncaught errors in the page", not errors, "; ".join(errors[:2])[:160])

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    if passed != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()
