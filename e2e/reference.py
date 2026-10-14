#!/usr/bin/env python3
"""Reference workbooks: three finance models with fixed data whose expected results were established
independently (the arithmetic below, under the sheet's stated rounding rules). The sheet must
reconcile exactly — and its checks must report exactly the two failures that are there on purpose
(a duplicate VIN, a duplicate statement posting), so that detection is part of the reference.

Usage: python3 e2e/reference.py [http://localhost:8787]
"""
import math
import os
import sys
import time

from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = ARGS[0] if ARGS else "http://localhost:8787"
OUT = os.environ.get("E2E_OUT", "/tmp/gridwright-e2e")
os.makedirs(OUT, exist_ok=True)


def rnd(x, d=0):
    """The engine's ROUND: half away from zero on the IEEE product, like the sheet."""
    f = 10.0**d
    y = x * f
    r = math.floor(y + 0.5) if y >= 0 else math.ceil(y - 0.5)
    return r / f


# ------------------------------------------------------------------ expected: landed cost by VIN
USD_AOA, EUR_USD = 920.0, 1.085
FOB = {"v1": 24500.0, "v2": 24500.0, "v3": 18900.0, "v4": 21000.0, "v5": 21000.0}
share = {k: rnd(FOB[k] / 67900.0, 6) for k in ("v1", "v2", "v3")}
share.update({k: rnd(FOB[k] / 42000.0, 6) for k in ("v4", "v5")})
freight = {"v1": rnd(4200 * share["v1"], 2), "v2": rnd(4200 * share["v2"], 2)}
freight["v3"] = 4200 - (freight["v1"] + freight["v2"])
freight["v4"] = rnd(3100 * share["v4"], 2)
freight["v5"] = 3100 - freight["v4"]
ins = {"v1": rnd(650 * share["v1"], 2), "v2": rnd(650 * share["v2"], 2)}
ins["v3"] = 650 - (ins["v1"] + ins["v2"])
ins["v4"] = rnd(420 * share["v4"], 2)
ins["v5"] = 420 - ins["v4"]
fob_usd = {k: rnd(FOB[k], 2) for k in ("v1", "v2", "v3")}
fob_usd.update({k: rnd(FOB[k] * EUR_USD, 2) for k in ("v4", "v5")})
cif = {k: rnd(fob_usd[k] + freight[k] + ins[k], 2) for k in fob_usd}
cif_aoa = {k: rnd(cif[k] * USD_AOA, 2) for k in cif}
duty = {k: rnd(cif_aoa[k] * 0.2, 2) for k in cif}
landed = {k: rnd(cif_aoa[k] + duty[k] + 350000, 0) for k in cif}
LANDED_TOTAL = sum(landed.values())

# ------------------------------------------------------------------ expected: 13-week cash forecast
PLAN = [9500000, 8200000, 7800000, 10400000, 9100000, 8800000, 12000000, 9300000, 8700000, 9900000, 10100000, 8600000, 11200000]
OTHER = [0, 0, 1500000, 0, 0, 0, 0, 2000000, 0, 0, 0, 0, 0]
SUP = [-6200000, -5900000, -6100000, -7400000, -6000000, -5800000, -8300000, -6400000, -6000000, -6900000, -7100000, -5700000, -7600000]
PAY = [0, 0, -4800000, 0, 0, 0, -4800000, 0, 0, 0, -4800000, 0, 0]
TAX = [0, -2650000, 0, 0, 0, -2650000, 0, 0, 0, -2650000, 0, 0, 0]
CAPEX = [0, 0, 0, -3000000, 0, 0, 0, 0, 0, 0, 0, -3000000, 0]


def forecast(rate, opening=125000000):
    cash, closes = opening, []
    for i in range(13):
        cash += rnd(PLAN[i] * rate, 0) + OTHER[i] + SUP[i] + PAY[i] + TAX[i] + CAPEX[i]
        closes.append(cash)
    return closes


# ------------------------------------------------------------------ expected: bank reconciliation
LEDGER_TOTAL = 4500000 - 2200000 - 850000 + 1275000 + 318500 - 318500 + 640000
STATEMENT_TOTAL = 4500000 - 2200000 - 2200000 - 850000 + 1275000 - 12750 + 3100
EXPLAINED = 12750 - 3100 + 640000 + 2200000 + 0


def main():
    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = browser.new_context(viewport={"width": 1500, "height": 950}).new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".canvas-host canvas", timeout=30000)
        time.sleep(0.5)

        def table(name):
            return page.evaluate("(n) => { const s = window.__gw.getState(); const t = [...s.tables.values()].find((x) => x.name === n); return t ? t.id : null; }", name)

        def val(tname, r, c):
            return page.evaluate("([n,r,c]) => { const s = window.__gw.getState(); const t = [...s.tables.values()].find((x) => x.name === n); const cell = t && s.cells.get(t.id)?.get(r*65536+c); const v = cell ? cell.v : null; return v === null || v === undefined ? null : ('n' in v ? v.n : 's' in v ? v.s : 'b' in v ? v.b : 'e' in v ? v.e : null); }", [tname, r, c])

        def checks():
            return {c["label"]: c["ok"] for c in page.evaluate("() => window.__gw.book.checks()")}

        def apply(op):
            return page.evaluate("(op) => window.__gw.book.apply(op)", op)

        # ---------------------------------------------------------- landed cost by VIN
        page.evaluate("() => window.__gw.applyTemplate('ref-landed-cost')")
        time.sleep(1.2)
        rows = {"v1": 1, "v2": 2, "v3": 3, "v4": 4, "v5": 5}
        got = {k: val("Vehicles", r, 14) for k, r in rows.items()}
        check("landed cost: every priced vehicle equals the independently computed figure (kwanza-rounded)", all(got[k] == landed[k] for k in rows), str({k: (got[k], landed[k]) for k in rows}))
        check("landed cost: freight and insurance allocations absorb the rounding exactly", val("Vehicles", 3, 5) == freight["v3"] and abs(val("Vehicles", 3, 6) - ins["v3"]) < 1e-9 and val("Shipments", 1, 6) == 4200 and val("Shipments", 1, 7) == 650, f"{val('Vehicles', 3, 5)} {val('Vehicles', 3, 6)} {val('Shipments', 1, 6)} {val('Shipments', 1, 7)}")
        check("landed cost: EUR vehicles reach AOA through USD at the customs-date rates", val("Vehicles", 4, 7) == fob_usd["v4"] and val("Vehicles", 4, 10) == cif_aoa["v4"], f"{val('Vehicles', 4, 7)} {val('Vehicles', 4, 10)}")
        check("landed cost: the vehicle without a rate is flagged, not priced", val("Vehicles", 6, 14) == "no rate" and val("Vehicles", 6, 15) == "no rate", f"{val('Vehicles', 6, 14)} / {val('Vehicles', 6, 15)}")
        check("landed cost: the duplicate VIN is flagged on both rows", val("Vehicles", 4, 15) == "duplicate VIN" and val("Vehicles", 5, 15) == "duplicate VIN", f"{val('Vehicles', 4, 15)}")
        check("landed cost: total of priced vehicles", val("Vehicles", 7, 14) == LANDED_TOTAL and val("Checks", 7, 1) == LANDED_TOTAL, f"{val('Vehicles', 7, 14)} vs {LANDED_TOTAL}")
        c = checks()
        expected = {"Freight and insurance fully allocated per shipment": True, "Landed total = CIF + duty + fees within kwanza rounding": True, "Every vehicle has an FX rate on its customs date": False, "VINs are unique": False}
        check("landed cost: the checks report exactly the two deliberate defects", c == expected, str(c))
        page.screenshot(path=f"{OUT}/ref-01-landed-cost.png")

        # ---------------------------------------------------------- bank reconciliation
        page.evaluate("() => window.__gw.applyTemplate('ref-bank-rec')")
        time.sleep(1.2)
        check("bank rec: ledger and statement totals", val("Ledger", 8, 4) == LEDGER_TOTAL and val("Statement", 8, 3) == STATEMENT_TOTAL, f"{val('Ledger', 8, 4)} / {val('Statement', 8, 3)}")
        check("bank rec: the difference equals the explained items exactly and nothing is unexplained", val("Matching", 10, 3) == LEDGER_TOTAL - STATEMENT_TOTAL and val("Explained", 6, 1) == EXPLAINED and val("Explained", 8, 1) == 0, f"diff={val('Matching', 10, 3)} explained={val('Explained', 6, 1)} unexplained={val('Explained', 8, 1)}")
        check("bank rec: a leading-zero identifier matches across sides (text on one, number on the other)", val("Ledger", 3, 1) == "000123" and val("Statement", 4, 1) == "000123" and val("Matching", 3, 4) == "Matched", f"{val('Ledger', 3, 1)!r} {val('Statement', 4, 1)!r} {val('Matching', 3, 4)}")
        statuses = [val("Matching", r, 4) for r in range(1, 10)]
        check("bank rec: statuses — reversal pair nets to matched, transit receipt only in ledger, fee and interest only in statement, duplicate posting different", statuses == ["Matched", "Different", "Matched", "Matched", "Only in ledger", "Only in ledger", "Only in ledger", "Only in statement", "Only in statement"], str(statuses))
        check("bank rec: the duplicate posting is counted", val("Statement", 2, 4) == 2 and val("Statement", 3, 4) == 2 and val("Statement", 1, 4) == 1, f"{val('Statement', 2, 4)}")
        c = checks()
        expected = {"Explained items equal the difference exactly": True, "Cheque 000123 matches across sides": True, "No statement reference is posted twice": False}
        check("bank rec: the checks report exactly the deliberate duplicate", c == expected, str(c))
        page.screenshot(path=f"{OUT}/ref-02-bank-rec.png")

        # ---------------------------------------------------------- 13-week cash forecast
        page.evaluate("() => window.__gw.applyTemplate('ref-cash-13w')")
        time.sleep(1.2)
        exp = forecast(0.9)
        closes = [val("Forecast", 11, c) for c in range(1, 14)]
        check("cash forecast: thirteen closing balances equal the independently computed chain", closes == exp, f"{closes[-1]} vs {exp[-1]}")
        check("cash forecast: week 3 starts on 28 Feb 2028 and contains the leap day", abs(val("Forecast", 1, 3) - 46811) < 1e-9, str(val("Forecast", 1, 3)))  # 2028-02-28 as a serial
        c = checks()
        check("cash forecast: all four checks pass", c == {"Closing W13 = opening W1 + sum of net movements": True, "Each week opens on the previous close": True, "29 February 2028 falls in week 3": True, "Closing cash stays above the minimum in every week": True}, str(c))
        # a scenario change propagates through the whole chain and keeps it consistent
        apply({"type": "set_cell", "table": table("Inputs"), "row": 2, "col": 1, "input": "0.75"})
        time.sleep(0.4)
        exp75 = forecast(0.75)
        closes = [val("Forecast", 11, c) for c in range(1, 14)]
        c = checks()
        check("cash forecast: a 75% collection scenario reproduces the expected closing balances and the chain checks still hold", closes == exp75 and c["Closing W13 = opening W1 + sum of net movements"] and c["Each week opens on the previous close"], f"{closes[-1]} vs {exp75[-1]}")
        page.screenshot(path=f"{OUT}/ref-03-cash-13w.png")
        browser.close()
    check("no uncaught errors in the page", not errors, "; ".join(errors[:2])[:160])

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    if passed != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()
