#!/bin/bash
# Build the contract and run SpendTree on a local NEAR sandbox, all inside Docker.
#   ./run-demo.sh              scripted 6-step attack scenario (no keys)   -> ui/index.html
#   ./run-demo.sh ai-replay    worst-case adversary vs per-agent caps (no keys) -> ui/index.html?run=ai
#   ./run-demo.sh limits       edge cases on the sandbox: depth cap, refund racing a revoke (no keys)
#   ./run-demo.sh unit         contract unit tests (deterministic refund-after-revoke walk, depth cap)
#   ./run-demo.sh ai-live      live LLM agents on NEAR AI Cloud (needs NEARAI_API_KEY in .env)
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" = "unit" ]; then
  # near-sdk's unit-testing deps need a newer cargo than the 1.81 wasm toolchain, so test a copy.
  exec docker run --rm --user "$(id -u)" -v "$PWD/contract:/src:ro" -e CARGO_TARGET_DIR=/tmp/tgt rust:1.90-slim sh -c \
    'mkdir /tmp/t && cp /src/Cargo.toml /src/Cargo.lock /tmp/t/ && cp -r /src/src /tmp/t/ && cd /tmp/t && sed -i "/^rust-version/d" Cargo.toml && printf "\n[dev-dependencies]\nnear-sdk = { version = \"=5.5.0\", features = [\"unit-testing\"] }\n" >> Cargo.toml && cargo test'
fi
ARCH=$(uname -m)
mkdir -p .cargo-cache
docker build -q -t spendtree-contract -f docker/contract.Dockerfile docker >/dev/null
docker run --rm --user "$(id -u)" -v "$PWD/contract:/work" -v "$PWD/.cargo-cache:/cargo" -e CARGO_HOME=/cargo \
  spendtree-contract cargo build --target wasm32-unknown-unknown --release --locked

if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  # Apple Silicon: near-sandbox npm has no Linux arm64 build; use NEAR's official Linux-aarch64 sandbox.
  PLATFORM=linux/arm64
  if [ ! -x .sandbox-bin/Linux-aarch64/near-sandbox ]; then
    mkdir -p .sandbox-bin
    docker run --rm --user node -v "$PWD/.sandbox-bin:/out" -w /out node:22-trixie-slim sh -c \
      'node -e "fetch(\"https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-aarch64/2.6.5/near-sandbox.tar.gz\").then(r=>r.arrayBuffer()).then(b=>require(\"fs\").writeFileSync(\"s.tgz\",Buffer.from(b)))" && tar xzf s.tgz && rm s.tgz'
  fi
  NPM_FLAGS=--ignore-scripts  # near-sandbox's installer rejects Linux arm64; we use the binary fetched above
  EXTRA=(-e NEAR_SANDBOX_BIN_PATH=1 -e NEAR_SANDBOX_BINARY_PATH=/app/.sandbox-bin/Linux-aarch64 -e NODE_OPTIONS=--require=/app/sim/arm64-shim.cjs)
else
  PLATFORM=linux/amd64; EXTRA=(); NPM_FLAGS=
fi

[ -d sim/node_modules ] || docker run --rm --platform "$PLATFORM" --user node -v "$PWD/sim:/work" -w /work node:22-trixie-slim npm ci --no-fund --no-audit $NPM_FLAGS
MODE=${1:-scripted}
case "$MODE" in
  scripted)  CMD=(node scenario.mjs); NET=(--network none) ;;
  ai-replay) CMD=(node agents.mjs --replay); NET=(--network none) ;;
  limits)    CMD=(node limits.mjs); NET=(--network none) ;;
  ai-live)   CMD=(node agents.mjs); NET=(--env-file .env) ;;
  *) echo "unknown mode $MODE"; exit 1 ;;
esac
docker run --rm --platform "$PLATFORM" "${NET[@]}" --user node -v "$PWD:/app" -w /app/sim \
  -e NEAR_WORKSPACES_NO_LOGS=1 -e MODEL -e INJECTION ${EXTRA[@]+"${EXTRA[@]}"} node:22-trixie-slim "${CMD[@]}" 2>&1 | grep -v '^Retrying\|^Receipt\|Log \['
