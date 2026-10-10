#!/usr/bin/env python3
"""Crash recovery (0.10.0): process termination at a boundary neither loses nor duplicates
accepted work. This suite starts its own server (own port, own data directory) so that it can
kill it — with the test-only fault injection GRIDWRIGHT_CRASH_AT=<point>, which makes the server
die (SIGKILL, no cleanup) exactly when it reaches that point — and start it again.

Boundaries covered:
  intake:placed              the placement was committed through the log, the process died before
                             the source record and the profile were written → after the restart the
                             table is there (the log is the authority), the profile is not yet applied,
                             and placing it again completes the record from the log without a second
                             table or a second record; a third request is refused as already placed
  concurrent placement       two requests to place the same profile at once → one table, one record
  investigation:dispatched   the investigation record was saved and its process started, then the
                             server died → after the restart it is 'interrupted', nothing it proposed
                             is current, and a new investigation can start at once (needs --mock-llm
                             and the investigation stack; skipped otherwise, and said so)

Usage: python3 e2e/recovery.py [--mock-llm http://127.0.0.1:8899/v1] [--port 8797] [--data /tmp/gw-recovery]
Requires server/dist (scripts/build.sh) and node on PATH.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIX = os.path.join(HERE, "fixtures", "vehicles")
MOCK = None
PORT = 8797
DATA = "/tmp/gw-recovery"
for i, a in enumerate(sys.argv):
    if a == "--mock-llm":
        MOCK = sys.argv[i + 1]
    if a == "--port":
        PORT = int(sys.argv[i + 1])
    if a == "--data":
        DATA = sys.argv[i + 1]
BASE = f"http://127.0.0.1:{PORT}"
SERVER = os.path.join(ROOT, "server", "dist", "index.js")


def rest(method, path, body=None, raw=False, timeout=120):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read().decode()
            return (r.status, text) if raw else json.loads(text)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        if raw:
            return (e.code, text)
        raise


def mcp(name, arguments):
    code, text = rest("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}, raw=True)
    res = json.loads(text).get("result", {})
    content = "".join(c.get("text", "") for c in res.get("content", []))
    try:
        return json.loads(content)
    except Exception:
        return content


class Server:
    def __init__(self):
        self.proc = None

    def start(self, crash_at=None):
        env = {**os.environ, "GRIDWRIGHT_DATA": DATA, "PORT": str(PORT), "HOST": "127.0.0.1", "NODE_ENV": "production"}
        env.pop("GRIDWRIGHT_CRASH_AT", None)
        if crash_at:
            env["GRIDWRIGHT_CRASH_AT"] = crash_at
        self.log = open(os.path.join(DATA, "server.log"), "a")
        self.proc = subprocess.Popen(["node", SERVER], cwd=os.path.join(ROOT, "server"), env=env, stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                rest("GET", "/api/health")
                return
            except Exception:
                if self.proc.poll() is not None:
                    raise RuntimeError(f"server exited with {self.proc.returncode} (see {DATA}/server.log)")
                time.sleep(0.2)
        raise RuntimeError("server did not come up")

    def wait_dead(self, seconds=15):
        for _ in range(int(seconds * 10)):
            if self.proc.poll() is not None:
                return self.proc.returncode
            time.sleep(0.1)
        return None

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.log.close()


def main():
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    shutil.rmtree(DATA, ignore_errors=True)
    os.makedirs(DATA, exist_ok=True)
    srv = Server()
    try:
        # ================================================================ A. intake placement interrupted after the commit
        srv.start(crash_at="intake:placed")
        doc = rest("POST", "/api/files", {"name": "Recovery", "json": '{"name":"Recovery","tables":[],"next_table_id":1}'})
        fid = doc["id"]
        with open(os.path.join(FIX, "inventory-2026-10-06.csv"), "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        prof = rest("POST", f"/api/files/{fid}/intake", {"name": "inventory-2026-10-06.csv", "base64": b64})
        key = prof["key"]
        check("A. the file is profiled and nothing is placed yet", prof["status"] == "profiled" and mcp("read_document", {"id": fid})["tables"] == [], prof["status"])
        died = False
        try:
            rest("POST", f"/api/files/{fid}/intake/{key}/apply", {"decisions": [{"action": "new"}]}, timeout=30)
        except Exception:
            died = True
        code = srv.wait_dead()
        check("   placing it reaches the crash point after the commit: the request never answers and the process is gone", died and code is not None, f"died={died} code={code}")

        srv.start()
        live = mcp("read_document", {"id": fid})
        prof2 = rest("GET", f"/api/files/{fid}/intake/{key}")
        comp = rest("GET", f"/api/files/{fid}/companion")
        sources = [r for r in comp["records"] if r["kind"] == "source" and r.get("intake") == key]
        check("   after the restart the table is there (the log is the authority), the profile is not applied, no source record was written", len(live["tables"]) == 1 and live["tables"][0]["name"] == "inventory" and live["tables"][0]["rows"] == 6 and prof2["status"] == "profiled" and not sources, f"tables={[(t['name'], t['rows']) for t in live['tables']]} status={prof2['status']} sources={len(sources)}")
        log_before = rest("GET", f"/api/files/{fid}/history")
        done = rest("POST", f"/api/files/{fid}/intake/{key}/apply", {"decisions": [{"action": "new"}]})
        live = mcp("read_document", {"id": fid})
        comp = rest("GET", f"/api/files/{fid}/companion")
        sources = [r for r in comp["records"] if r["kind"] == "source" and r.get("intake") == key]
        log_after = rest("GET", f"/api/files/{fid}/history")
        n_before = len(log_before if isinstance(log_before, list) else log_before.get("entries", []))
        n_after = len(log_after if isinstance(log_after, list) else log_after.get("entries", []))
        check("   placing it again completes the work from the log: still one table, one source record, the profile applied and marked recovered, nothing committed twice", len(live["tables"]) == 1 and len(sources) == 1 and done["status"] == "applied" and done["applied"].get("recovered") is True and n_after == n_before, f"tables={len(live['tables'])} sources={len(sources)} recovered={done['applied'].get('recovered')} log {n_before}→{n_after}")
        check("   the applied seqs are the log's own entries for this intake", sorted(done["applied"]["seqs"]) == sorted(e["seq"] for e in (log_after if isinstance(log_after, list) else log_after.get("entries", [])) if (e.get("note") or "").startswith(f"intake {key}:")), str(done["applied"]["seqs"]))
        code, text = rest("POST", f"/api/files/{fid}/intake/{key}/apply", {"decisions": [{"action": "new"}]}, raw=True)
        check("   a third request is refused as already placed", code == 400 and "already placed" in text, f"{code} {text[:80]}")
        reading = rest("GET", f"/api/files/{fid}/reading/{live['tables'][0]['id']}")
        check("   the first reading was made on the recovered placement", reading.get("figures") and any(f["label"].startswith("vehicles") for f in reading["figures"]), str(reading.get("text", ""))[:120])

        # ================================================================ B. two requests to place the same profile at once
        with open(os.path.join(FIX, "invoices-2026-10-15.xml"), "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        prof = rest("POST", f"/api/files/{fid}/intake", {"name": "invoices-2026-10-15.xml", "base64": b64})
        key2 = prof["key"]
        outcomes = []

        def place():
            outcomes.append(rest("POST", f"/api/files/{fid}/intake/{key2}/apply", {"decisions": [{"action": "new"}]}, raw=True))

        ts = [threading.Thread(target=place) for _ in range(2)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        live = mcp("read_document", {"id": fid})
        comp = rest("GET", f"/api/files/{fid}/companion")
        sources2 = [r for r in comp["records"] if r["kind"] == "source" and r.get("intake") == key2]
        codes = sorted(c for c, _ in outcomes)
        check("B. two concurrent requests to place one profile: one table, one source record (the second request is refused or completes the same placement)", len([t for t in live["tables"] if t["name"].startswith("invoices")]) == 1 and len(sources2) == 1 and codes[0] == 200, f"codes={codes} tables={[t['name'] for t in live['tables']]} sources={len(sources2)}")

        # ================================================================ C. an investigation dispatched, then the server dies
        stack = rest("GET", "/api/investigation")
        if MOCK and stack.get("available"):
            rest("PUT", "/api/ai/settings", {"baseUrl": MOCK, "model": "mock"})
            srv.stop()
            srv.start(crash_at="investigation:dispatched")
            died = False
            try:
                rest("POST", f"/api/files/{fid}/companion/investigate", {"question": "Investigate slowly whether the ageing is concentrated in one model"}, timeout=30)
            except Exception:
                died = True
            code = srv.wait_dead()
            check("C. dispatching an investigation reaches the crash point: the record is saved, the process started, the server is gone", died and code is not None, f"died={died} code={code}")
            srv.start()
            comp = rest("GET", f"/api/files/{fid}/companion")
            inv = comp["investigations"][-1] if comp.get("investigations") else None
            check("   after the restart the investigation is interrupted, not running for ever: said in the activity, nothing it proposed is current", inv is not None and inv["status"] == "failed" and str(inv.get("error", "")).startswith("interrupted") and any(e["text"].startswith("Investigation interrupted") for e in comp["events"]), f"{inv and inv['status']} {inv and inv.get('error')}")
            started = rest("POST", f"/api/files/{fid}/companion/investigate", {"question": "Is the ageing concentrated in one model?"})
            for _ in range(120):
                cur = rest("GET", f"/api/files/{fid}/companion/investigations/{started['id']}")
                if cur["status"] != "running":
                    break
                time.sleep(1)
            check("   a new investigation starts at once and completes on the durable thread", cur["status"] == "done" and cur.get("answer", "").startswith("Findings:"), f"{cur['status']} {cur.get('error')}")
        else:
            print(f"SKIP C. investigation dispatch recovery ({'no --mock-llm' if not MOCK else stack.get('reason')})")
    finally:
        srv.stop()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    for name, ok, detail in results:
        if not ok:
            print(f"FAIL {name} — {detail}")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
