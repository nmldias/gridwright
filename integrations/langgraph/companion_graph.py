#!/usr/bin/env python3
"""The companion cycle as a LangGraph workflow over Gridwright's graph of tables.

    new information → update context → recheck affected nodes → assess → investigate → brief

Gridwright owns the nodes (its tables, their sources, the context records, the watches) and the
deterministic checks; this workflow owns the orchestration — when to look, what to reassess, when
an attention-level issue deserves the model's reading, and what to hand to a decision-case system
such as CFOrUS. It talks to Gridwright only through its MCP tools and REST, with the identity the
request carries: more information here never means more authority there.

Usage:
    python3 companion_graph.py http://127.0.0.1:8787 <document id> [--changed table:1] [--interpret] [--json]

State flows through five nodes; each is a plain function, so the same cycle can run inside a
larger LangGraph (a CFOrUS case graph) or on a schedule.
"""
import json
import sys
import urllib.request
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph


class CompanionState(TypedDict, total=False):
    base: str
    doc: str
    changed: list[str]          # node ids that changed, e.g. ["table:1"]
    interpret: bool             # ask the model to read new attention-level issues
    graph: dict[str, Any]       # tables as nodes, typed edges, affected set
    affected: dict[str, Any]
    check: dict[str, Any]       # result of the deterministic re-check
    attention: list[dict[str, Any]]
    brief: dict[str, Any]
    level: str                  # quiet | watch | attention
    interpretations: list[dict[str, Any]]
    cases: list[dict[str, Any]] # what a decision-case system should open or update


def _post(base: str, path: str, body: Any) -> Any:
    req = urllib.request.Request(base + path, method="POST", data=json.dumps(body).encode(), headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def mcp(base: str, name: str, arguments: dict[str, Any]) -> Any:
    res = _post(base, "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}})["result"]
    text = "".join(c.get("text", "") for c in res.get("content", []))
    if res.get("isError"):
        raise RuntimeError(text)
    return json.loads(text)


# --- the nodes -----------------------------------------------------------------------------------
def ingest(state: CompanionState) -> CompanionState:
    """Read the graph: tables as nodes, edges read off the workbook, and what the change reaches."""
    g = mcp(state["base"], "read_graph", {"id": state["doc"], "changed": state.get("changed", [])})
    return {"graph": {"nodes": g["nodes"], "edges": g["edges"]}, "affected": g.get("affected", {"nodes": [], "watches": [], "records": [], "tables": []})}


def recheck(state: CompanionState) -> CompanionState:
    """Deterministic re-check of the watches (cheap; Gridwright evaluates formulas, no model)."""
    r = _post(state["base"], f"/api/files/{state['doc']}/companion/check", {})
    return {"check": {"attention": r["attention"], "changed": r["changed"], "affected": r.get("affected", [])}}


def assess(state: CompanionState) -> CompanionState:
    """The attention gate: most updates stay under monitoring; only sustained, fresh breaches become attention."""
    att = mcp(state["base"], "list_attention", {"id": state["doc"]})
    issues = att["issues"]
    brief = att["brief"]
    level = "attention" if issues else ("watch" if brief["health"].get("stale") or brief["health"].get("error") or brief["health"].get("proposed") else "quiet")
    return {"attention": issues, "brief": brief, "level": level}


def route(state: CompanionState) -> str:
    return "investigate" if state.get("level") == "attention" and state.get("interpret") else "brief"


def investigate(state: CompanionState) -> CompanionState:
    """Selective reasoning: the model reads only the issues that need attention, and its words are stored as its own."""
    out = []
    for issue in state.get("attention", []):
        try:
            r = _post(state["base"], f"/api/files/{state['doc']}/companion/interpret/{issue['id']}", {})
            out.append({"issue": issue["id"], "interpretation": r.get("interpretation")})
        except Exception as e:  # the deterministic evidence stands without the model
            out.append({"issue": issue["id"], "error": str(e)})
    return {"interpretations": out}


def brief(state: CompanionState) -> CompanionState:
    """What a decision-case system receives: one evolving case per open issue, nothing for quiet updates."""
    cases = [{"issue": i["id"], "title": i["summary"], "evidence": i["evidence"], "uncertainty": i["uncertainty"], "next": i["next"], "revision": i["revision"]} for i in state.get("attention", [])]
    return {"cases": cases}


def build() -> Any:
    g = StateGraph(CompanionState)
    g.add_node("ingest", ingest)
    g.add_node("recheck", recheck)
    g.add_node("assess", assess)
    g.add_node("investigate", investigate)
    g.add_node("brief", brief)
    g.set_entry_point("ingest")
    g.add_edge("ingest", "recheck")
    g.add_edge("recheck", "assess")
    g.add_conditional_edges("assess", route, {"investigate": "investigate", "brief": "brief"})
    g.add_edge("investigate", "brief")
    g.add_edge("brief", END)
    return g.compile()


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        sys.exit(2)
    changed = []
    for i, a in enumerate(sys.argv):
        if a == "--changed":
            changed = sys.argv[i + 1].split(",")
    result = build().invoke({"base": args[0].rstrip("/"), "doc": args[1], "changed": changed, "interpret": "--interpret" in sys.argv})
    if "--json" in sys.argv:
        print(json.dumps({k: result.get(k) for k in ("level", "affected", "check", "brief", "cases", "interpretations")}, indent=1))
        return
    b = result["brief"]
    print(f"level: {result['level']}")
    if changed:
        a = result["affected"]
        print(f"changed {', '.join(changed)} → reassess {len(a['watches'])} watch(es), {len(a['records'])} record(s), {len(a['tables'])} derived table(s)")
    print("what has changed:", *("  - " + t for t in b["changed"]), sep="\n")
    print("why it matters:", *("  - " + t for t in b["matters"]), sep="\n")
    print("what to do next:", *("  - " + t for t in b["next"]), sep="\n")
    for c in result["cases"]:
        print(f"case: {c['title']} (revision {c['revision']}) → {c['next']}")


if __name__ == "__main__":
    main()
