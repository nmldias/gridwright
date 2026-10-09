#!/usr/bin/env bash
# Build everything for a non-Docker install: wasm engine → client bundle → server.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v cargo >/dev/null || { echo "install Rust: https://rustup.rs"; exit 1; }
command -v wasm-pack >/dev/null || curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
rustup target add wasm32-unknown-unknown >/dev/null
echo "==> engine (Rust → wasm)"
(cd core && wasm-pack build --release --target web --out-dir ../client/src/engine/pkg --out-name gridwright_core)
echo "==> engine for the server (headless evaluation, MCP)"
(cd core && wasm-pack build --release --target nodejs --out-dir ../server/engine --out-name gridwright_core)
echo "==> client"
(cd client && npm ci --no-audit --no-fund && npm run build)
echo "==> server"
(cd server && npm ci --no-audit --no-fund && npm run build)
echo "done — start with: cd server && npm start   (http://localhost:8787)"
