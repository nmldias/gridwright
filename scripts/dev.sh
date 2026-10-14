#!/usr/bin/env bash
# Development: server with reload on :8787, Vite dev server on :5173 (proxies /api and /ws).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d client/src/engine/pkg ] || (cd core && wasm-pack build --release --target web --out-dir ../client/src/engine/pkg --out-name gridwright_core)
(cd server && npm run dev) &
(cd client && npm run dev)
