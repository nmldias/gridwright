# syntax=docker/dockerfile:1.6
# Gridwright — multi-stage build. All base images are multi-arch (linux/amd64, linux/arm64),
# so `docker build` on an arm64 host (DGX Spark, Graviton, Apple Silicon) produces a native image.

# ---------------------------------------------------------------------------
# 1. Rust engine → WebAssembly
# ---------------------------------------------------------------------------
FROM rust:1-bookworm AS wasm
ARG BINARYEN_VERSION=version_123
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
# wasm-opt for this CPU (falls back to the distro package if GitHub is unreachable);
# wasm-pack prefers a wasm-opt found on PATH over downloading its own.
RUN set -eux; arch="$(uname -m)"; case "$arch" in aarch64|arm64) bn=aarch64-linux ;; x86_64) bn=x86_64-linux ;; *) bn="" ;; esac; \
    if [ -n "$bn" ] && curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/binaryen-${BINARYEN_VERSION}-${bn}.tar.gz" -o /tmp/b.tgz; then \
      tar -xzf /tmp/b.tgz -C /tmp && cp /tmp/binaryen-${BINARYEN_VERSION}/bin/wasm-opt /usr/local/bin/ && rm -rf /tmp/b.tgz /tmp/binaryen-*; \
    else apt-get update && apt-get install -y --no-install-recommends binaryen && rm -rf /var/lib/apt/lists/*; fi; \
    wasm-opt --version
RUN rustup target add wasm32-unknown-unknown \
 && curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
WORKDIR /src/core
COPY core/Cargo.toml core/Cargo.lock ./
COPY core/src ./src
RUN wasm-pack build --release --target web --out-dir /out --out-name gridwright_core \
 && wasm-pack build --release --target nodejs --out-dir /out-node --out-name gridwright_core

# ---------------------------------------------------------------------------
# 2. Client (Vite + React + PixiJS)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS client
WORKDIR /src/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
COPY --from=wasm /out ./src/engine/pkg
RUN npx tsc --noEmit && npx vite build

# ---------------------------------------------------------------------------
# 3. Server (Node + TypeScript)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS server
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/ ./
COPY --from=wasm /out-node ./engine
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

# ---------------------------------------------------------------------------
# 4. Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim
# GRIDWRIGHT_PYTHON_SANDBOX=auto: bubblewrap when the container may create user namespaces (run with
# --security-opt seccomp=unconfined --security-opt apparmor=unconfined on a host that allows them),
# a user namespace alone when it may, else a plain process with the container as the only boundary —
# /api/python and /api/health report which, and every run record carries it
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 GRIDWRIGHT_DATA=/data CLIENT_DIR=/app/client GRIDWRIGHT_PYTHON_SANDBOX=auto GRIDWRIGHT_AGENT_PYTHON=/opt/companion/bin/python
# python3 + pandas for server-side Python cells; bubblewrap for the sandbox when the runtime allows it;
# the companion's investigation stack (LangChain, DeepAgents, LangGraph) in its own venv at the tested versions
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-pandas python3-matplotlib bubblewrap && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY integrations/companion ./integrations/companion
RUN python3 -m venv --system-site-packages /opt/companion && /opt/companion/bin/pip install --no-cache-dir -q -r integrations/companion/requirements.lock.txt \
 && /opt/companion/bin/python integrations/companion/investigate.py --probe
COPY --from=server /src/server/dist ./server/dist
COPY --from=server /src/server/engine ./server/engine
COPY --from=server /src/server/runner ./server/runner
COPY --from=server /src/server/node_modules ./server/node_modules
COPY --from=server /src/server/package.json ./server/package.json
COPY --from=client /src/client/dist ./client
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
