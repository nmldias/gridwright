#!/usr/bin/env python3
"""Reference figures for the synthetic vehicle fixtures, computed independently of Gridwright with
Decimal arithmetic (no rounding until display). Run it to regenerate expected.json."""
import csv, json, os
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))


def num(s: str) -> Decimal | None:
    s = s.strip().replace("Kz", "").replace(" ", "")
    if not s:
        return None
    if "," in s and "." in s and s.rfind(",") > s.rfind("."):
        s = s.replace(".", "").replace(",", ".")
    elif "," in s and s.count(",") == 1 and len(s.split(",")[1]) != 3:
        s = s.replace(",", ".")
    else:
        s = s.replace(",", "")
    return Decimal(s)


def figures(path: str, delimiter: str) -> dict:
    rows = list(csv.DictReader(open(os.path.join(HERE, path), encoding="utf-8"), delimiter=delimiter))
    rows = [r for r in rows if r["VIN"] and not r["VIN"].lower().startswith("total")]
    cost = {r["VIN"]: num(r["Landed cost (Kz)"]) for r in rows}
    over90_available = [r for r in rows if int(r["Days in stock"]) > 90 and r["Reserved"].strip().lower() == "no"]
    over90_reserved = [r for r in rows if int(r["Days in stock"]) > 90 and r["Reserved"].strip().lower() == "yes"]
    total = sum((c for c in cost.values() if c is not None), Decimal(0))
    tied_over90 = sum((cost[r["VIN"]] for r in over90_available if cost[r["VIN"]] is not None), Decimal(0))
    return {
        "vehicles": len(rows),
        "total_landed_cost": str(total),
        "blank_landed_cost": sum(1 for c in cost.values() if c is None),
        "over90_available": len(over90_available),
        "over90_reserved": len(over90_reserved),
        "landed_cost_over90_available": str(tied_over90),
        "reserved": sum(1 for r in rows if r["Reserved"].strip().lower() == "yes"),
        "vins": [r["VIN"] for r in rows],
    }


EXPECTED = {
    "inventory-2026-10-06.csv": figures("inventory-2026-10-06.csv", ";"),
    "inventory-2026-10-13.csv": figures("inventory-2026-10-13.csv", ","),
    "inventory-2026-10-13-corrected.csv": figures("inventory-2026-10-13-corrected.csv", ","),
    "inventory-2026-09-29.csv": figures("inventory-2026-09-29.csv", ","),
    "inventory-2026-10-20-partial.csv": figures("inventory-2026-10-20-partial.csv", ","),
}
if __name__ == "__main__":
    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(EXPECTED, f, indent=1)
    for k, v in EXPECTED.items():
        print(k, {x: y for x, y in v.items() if x != "vins"})
