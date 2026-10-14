# The companion cycle in LangGraph

Gridwright's tables are the nodes. Its server reads the edges off the workbook and the context
(`derived_from`, `fed_by`, `about`, `watches`, `constrains`, `excludes`, `raises`, `supersedes`),
runs the deterministic checks, keeps one evolving issue per watch and writes the brief. This
workflow orchestrates the cycle around it:

    new information → update context → recheck affected nodes → assess → investigate → brief

`companion_graph.py` is a five-node `StateGraph` that talks to Gridwright only through its MCP
tools (`read_graph`, `list_attention`) and two REST calls (`/companion/check`,
`/companion/interpret/:issue`). It carries no credentials of its own and gains none from the
documents it reads: run it with the identity that should see the document (behind Tailscale,
`tailscale serve` adds the headers).

```bash
pip install langgraph
python3 companion_graph.py http://127.0.0.1:8787 <document id> --changed table:1
python3 companion_graph.py http://127.0.0.1:8787 <document id> --interpret --json   # ask the model to read open issues
```

Each node is a plain function, so the same cycle drops into a larger graph — a CFOrUS case graph
that opens or updates a decision case from `cases`, and leaves quiet updates out of the Kanban.
