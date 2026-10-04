#!/usr/bin/env bash
# Runs evals/anti-hall/run.js inside a Linux container so Bash-granting studies work.
# Why: on macOS, `claude plugin eval` refuses Bash-granting runs when ~/.docker holds
# symlinks (docs/BENCHMARK-METHOD.md, "Machine limitation"). In the container HOME is a
# fresh /home/node, so there is no such store, and bubblewrap works (verified).
#
#   evals/anti-hall/run-in-container.sh [run.js args...] -- [claude plugin eval flags]
#   e.g. run-in-container.sh --arm anti-hall --max-cost-usd 2 --cases b1-changelog-bump-v1 -- --runs 1
#
# Needs (host): Apple `container` (brew) with `container system start` done, OR docker
# (set CONTAINER_BIN=docker); image `anti-hall-eval` (see --build); and ONE credential in
# the host environment, passed by NAME only (never printed): ANTHROPIC_API_KEY or
# CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`). macOS Keychain logins are not
# visible inside the container, so a key/token is required.
# Env: CONTAINER_BIN (default `container`), EVAL_IMAGE (default anti-hall-eval),
#      EVAL_MEMORY (default 4G), EVAL_CPUS (default 4).
set -euo pipefail
BIN="${CONTAINER_BIN:-container}"
IMAGE="${EVAL_IMAGE:-anti-hall-eval}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ "${1:-}" = "--build" ]; then
  d="$(mktemp -d)"
  cat > "$d/Dockerfile" <<'DF'
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates bubblewrap socat ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@2.1.288
WORKDIR /work
USER node
DF
  "$BIN" build -t "$IMAGE" "$d"; rm -rf "$d"; exit 0
fi

cred=()
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then cred+=(-e ANTHROPIC_API_KEY); fi
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then cred+=(-e CLAUDE_CODE_OAUTH_TOKEN); fi
if [ ${#cred[@]} -eq 0 ] && [ -z "${EVAL_NO_CRED_CHECK:-}" ]; then
  echo "run-in-container: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the host env (value is passed by name, never printed)." >&2
  exit 3
fi

exec "$BIN" run --rm --init -m "${EVAL_MEMORY:-4G}" -c "${EVAL_CPUS:-4}" \
  -v "$REPO":/work -w /work \
  -e HOME=/home/node -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  ${cred[@]+"${cred[@]}"} \
  "$IMAGE" node evals/anti-hall/run.js "$@"
