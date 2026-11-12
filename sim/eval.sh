#!/bin/bash
# Run live LLM trials on a local sandbox. Each entry is model:attacker:injection
# (attacker = injection | hostile, injection = html | api). Results go to sim/out/runs/.
cd "$(dirname "$0")/.."
TRIALS=${TRIALS:-"openai/gpt-5.4-mini:injection:html openai/gpt-5.4-mini:injection:api z-ai/glm-5.3-flash:injection:html z-ai/glm-5.3-flash:injection:api deepseek/deepseek-v3.2:injection:html deepseek/deepseek-v3.2:injection:api openai/gpt-5.4-nano:injection:html openai/gpt-5.4-nano:injection:api openai/gpt-5.4-mini:hostile:html z-ai/glm-5.3-flash:hostile:html deepseek/deepseek-v3.2:hostile:html"}
for t in $TRIALS; do
  IFS=: read -r m att inj <<< "$t"
  echo "=== $m / $att / $inj $(date +%T)"
  docker run --rm --platform linux/arm64 --user node --env-file .env -v "$PWD:/app" -w /app/sim \
    -e MODEL="$m" -e ATTACKER="$att" -e INJECTION="$inj" -e NO_LOG_OVERWRITE=1 -e NEAR_WORKSPACES_NO_LOGS=1 \
    -e NEAR_SANDBOX_BIN_PATH=1 -e NEAR_SANDBOX_BINARY_PATH=/app/.sandbox-bin/Linux-aarch64 -e NODE_OPTIONS=--require=/app/sim/arm64-shim.cjs \
    node:22-trixie-slim node agents.mjs > /tmp/spendtree-run.log 2>&1
  echo "exit=$?"; grep -E "→|\] |lost_to|NEAR AI|Error|FAILED" /tmp/spendtree-run.log | grep -v "^Receipt\|Log \[" | tail -40
  sleep 3
done
echo "=== ALL DONE $(date +%T)"
