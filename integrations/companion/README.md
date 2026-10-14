# The companion's investigation stack

One coherent stack over Gridwright: **LangChain** supplies the chat model (any OpenAI-compatible
endpoint — the one Gridwright is configured with) and the typed tools; **DeepAgents** is the agent
harness (planning, working files kept in its state, subagents when wanted); **LangGraph** runs the
cycle and keeps the state durable (one thread per document, checkpointed in SQLite under
Gridwright's data directory). Generated code never runs in the agent's process: `run_python` sends
it to Gridwright's cell sandbox (bubblewrap: own mount, PID and network namespaces, data
directory hidden), against the live document, and the run is kept as evidence with its code hash
and sandbox.

```
situation_graph.py     ingest → recheck → assess (quiet · observation · question · decision) → investigate → brief
investigate.py         the deep agent: read_context first, an independent calculation path, proposals only
gridwright_tools.py    read_context · read_table · evaluate · run_python · remember · propose_watch · propose_edit · list_attention · read_graph · read_history
```

## Install

Into the interpreter the server starts investigations with — `GRIDWRIGHT_AGENT_PYTHON`, else the
installer's venv in the data directory, else `python3`:

```bash
pip install -r integrations/companion/requirements.txt
curl -fsS http://127.0.0.1:8787/api/investigation      # {"available": true, "versions": {...}} once the server has probed it
```

## From Gridwright

*Ask → an open issue → Investigate* (or `POST /api/files/:id/companion/investigate {question}`)
starts `investigate.py` as a separate process with a short-lived **agent token** that carries
exactly the requesting person's identity and permissions, valid on the loopback interface only.
What it files comes back *proposed*; what it edits comes back as a *proposal* in Review; it cannot
confirm, approve, decide or delete (403). The result — findings in its own words, the steps it
took, the sandboxed runs, the records it proposed — lands on the investigation record in the
panel. A later change to the objective, a constraint or an exclusion marks the investigation
*provisional* until re-run.

## From the command line

```bash
export OPENAI_BASE_URL=http://100.78.161.2:8888/v1 GRIDWRIGHT_MODEL=<model id> OPENAI_API_KEY=none
python3 investigate.py <document id> --question "Is the ageing concentrated in one model?" --base http://127.0.0.1:8787
python3 situation_graph.py http://127.0.0.1:8787 <document id> --changed table:1               # four HTTP calls, no model
python3 situation_graph.py http://127.0.0.1:8787 <document id> --investigate --json            # the model only when the stance is question or decision
```

The cycle's `cases` output is what a decision-case system (CFOrUS) opens or updates: one evolving
case per open issue or decision to revisit, nothing for quiet updates.
