#!/usr/bin/env python3
"""The companion cycle as one LangGraph workflow, with the DeepAgents investigator as a node.

    new information → recheck → assess (the four responses) → investigate (only when it earns it) → brief

Gridwright owns the nodes of the situation (tables, sources, records, decisions, watches) and the
deterministic checks; this workflow owns the orchestration: when to look, what to reassess, when
the stance (quiet · observation · question · decision) justifies spending a model on an
investigation, and what a decision-case system receives. The investigate node is the deep agent
from investigate.py, on the same durable thread per document, so the cycle and the investigator
share one memory and one checkpoint store (SQLite under the data directory).

Usage:
    python3 situation_graph.py http://127.0.0.1:8787 <document id> [--changed table:1] [--investigate] [--json]

Complexity earns its place: a quiet cycle costs four HTTP calls and no model.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, TypedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from langgraph.graph import END, StateGraph  # noqa: E402

from gridwright_tools import Gridwright  # noqa: E402


class SituationState(TypedDict, total=False):
    base: str
    doc: str
    changed: list[str]
    investigate: bool
    model_base: str
    model: str
    api_key: str
    db: str
    affected: dict[str, Any]
    check: dict[str, Any]
    understanding: dict[str, Any]
    stance: str
    attention: list[dict[str, Any]]
    investigation: dict[str, Any]
    brief: dict[str, Any]
    cases: list[dict[str, Any]]


def _gw(state: SituationState) -> Gridwright:
    return Gridwright(state["base"], state["doc"], os.environ.get("GRIDWRIGHT_AGENT_TOKEN") or None, os.environ.get("GRIDWRIGHT_TOKEN") or None)


# --- the nodes -----------------------------------------------------------------------------------
def ingest(state: SituationState) -> SituationState:
    """What the change reaches, by the graph's typed edges (derived tables, watches, records, decisions)."""
    g = _gw(state).mcp("read_graph", {"changed": state.get("changed", [])})
    return {"affected": g.get("affected", {"nodes": [], "watches": [], "records": [], "tables": []}) if isinstance(g, dict) else {}}


def recheck(state: SituationState) -> SituationState:
    """Deterministic re-check: watches, the conditions behind decisions, expectations, conflicts between sources. No model."""
    r = _gw(state).rest("POST", f"/api/files/{state['doc']}/companion/check", {})
    return {"check": {"attention": r.get("attention"), "changed": r.get("changed"), "affected": r.get("affected", [])} if isinstance(r, dict) else {}}


def assess(state: SituationState) -> SituationState:
    """The understanding decides the stance: continue quietly, offer an observation, ask a material question, present a decision."""
    gw = _gw(state)
    u = gw.rest("GET", f"/api/files/{state['doc']}/companion/understanding")
    att = gw.mcp("list_attention", {})
    issues = att.get("issues", []) if isinstance(att, dict) else []
    return {"understanding": u if isinstance(u, dict) else {}, "stance": (u.get("stance") if isinstance(u, dict) else "quiet") or "quiet", "attention": issues, "brief": att.get("brief", {}) if isinstance(att, dict) else {}}


def route(state: SituationState) -> str:
    # a model is spent only when the stance asks for a decision or a material question, and only when asked to
    return "investigate" if state.get("investigate") and state.get("stance") in ("decision", "question") else "brief"


def investigate(state: SituationState) -> SituationState:
    """The deep agent, on the document's durable thread: it reads the understanding, computes independently, proposes; nothing is changed."""
    from investigate import run

    u = state.get("understanding", {})
    question = u.get("next") or "Investigate what needs attention and name the uncertainty worth resolving next."
    try:
        r = run(state["doc"], f"{question}\n\nThe stance is “{state.get('stance')}”. Investigate what is behind it and say what would change the decision.", issue=(state.get("attention") or [{}])[0].get("id"), thread=f"doc:{state['doc']}", investigation=None, db_path=state.get("db") or os.environ.get("GRIDWRIGHT_THREADS_DB", os.path.expanduser("~/.gridwright-threads.sqlite")), model_base=state.get("model_base") or os.environ.get("OPENAI_BASE_URL", ""), model_name=state.get("model") or os.environ.get("GRIDWRIGHT_MODEL", ""), api_key=state.get("api_key") or os.environ.get("OPENAI_API_KEY", ""), base=state["base"])
        return {"investigation": {"answer": r.get("answer"), "steps": r.get("steps"), "records": r.get("records"), "proposals": r.get("proposals"), "runs": r.get("runs")}}
    except Exception as e:  # the deterministic evidence stands without the model
        return {"investigation": {"error": f"{type(e).__name__}: {e}"[:500]}}


def brief(state: SituationState) -> SituationState:
    """What a decision-case system receives: one evolving case per open issue or decision to revisit; nothing for quiet updates."""
    u = state.get("understanding", {})
    cases = [{"issue": i["id"], "title": i["summary"], "evidence": i["evidence"], "uncertainty": i["uncertainty"], "next": i["next"], "revision": i["revision"]} for i in state.get("attention", [])]
    for d in u.get("decisions", []):
        if d.get("revisit"):
            cases.append({"decision": d["record"]["id"], "title": f"Revisit: {d['record']['text']}", "evidence": [d["revisit"]["summary"]], "uncertainty": [d["revisit"]["condition"]], "next": "revisit the decision", "revision": 1})
    return {"cases": cases}


def build(checkpointer: Any = None) -> Any:
    g = StateGraph(SituationState)
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
    return g.compile(checkpointer=checkpointer)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        sys.exit(2)
    changed: list[str] = []
    for i, a in enumerate(sys.argv):
        if a == "--changed":
            changed = sys.argv[i + 1].split(",")
    db = os.environ.get("GRIDWRIGHT_THREADS_DB", os.path.expanduser("~/.gridwright-threads.sqlite"))
    state: SituationState = {"base": args[0].rstrip("/"), "doc": args[1], "changed": changed, "investigate": "--investigate" in sys.argv, "db": db}
    # the cycle's own state is durable too: one thread per document, in the same store as the investigator's
    from langgraph.checkpoint.sqlite import SqliteSaver

    os.makedirs(os.path.dirname(db) or ".", exist_ok=True)
    with SqliteSaver.from_conn_string(db) as saver:
        result = build(saver).invoke(state, config={"configurable": {"thread_id": f"cycle:{args[1]}"}})
    if "--json" in sys.argv:
        print(json.dumps({k: result.get(k) for k in ("stance", "affected", "check", "brief", "cases", "investigation")}, indent=1, ensure_ascii=False))
        return
    u = result.get("understanding", {})
    print(f"stance: {result.get('stance')} — {u.get('lead')}")
    print(u.get("statement", ""))
    print("next:", u.get("next"))
    for c in result.get("cases", []):
        print(f"case: {c['title']} (revision {c['revision']}) → {c['next']}")
    inv = result.get("investigation")
    if inv:
        print("investigation:", inv.get("answer") or inv.get("error"))


if __name__ == "__main__":
    main()
