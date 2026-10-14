#!/usr/bin/env bash
# Run every test: engine unit tests, then the browser suites against a running server.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${1:-http://localhost:8787}"
(cd core && cargo test)
python3 e2e/smoke.py "$BASE" ${WITH_PYTHON:+--python}
echo "AI/multiplayer suite needs the mock LLM: node e2e/mock-llm.mjs & and the endpoint http://127.0.0.1:8899/v1 configured"
python3 e2e/ai_multiplayer.py "$BASE" || true
