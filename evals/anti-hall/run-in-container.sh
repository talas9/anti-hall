#!/usr/bin/env bash
# Runs evals/anti-hall/run.js inside a Linux container so Bash-granting studies work.
# Why: on macOS, `claude plugin eval` refuses Bash-granting runs when ~/.docker holds
# symlinks (docs/BENCHMARK-METHOD.md, "Machine limitation"). In the container HOME is a
# fresh /home/node, so there is no such store. bubblewrap needs the /proc unmask below
# (verified 2026-10-04: without it every Bash call in a run failed).
#
#   evals/anti-hall/run-in-container.sh [run.js args...] -- [claude plugin eval flags]
#   e.g. run-in-container.sh --arm with --max-cost-usd 2 --cases b1-changelog-bump-v1 --reps 1 -- --keep-temp
#
# Needs (host): Apple `container` (brew) with `container system start` done, OR docker
# (set CONTAINER_BIN=docker); image `anti-hall-eval` (see --build); and ONE credential in
# the host environment, passed by NAME only (never printed): ANTHROPIC_API_KEY or
# CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`). macOS Keychain logins are not
# visible inside the container, so a key/token is required.
# Env: CONTAINER_BIN (default `container`), EVAL_IMAGE (default anti-hall-eval),
#      EVAL_MEMORY (default 4G), EVAL_CPUS (default 4).
# The container runs with --rm, so its /tmp dies with it: with --keep-temp, run.js copies each
# run's temp dir into <results dir>/kept/ (on the /work mount) and points tracePath there.
# A --cases-dir outside the repo is mounted read-only at the same path; one inside maps to /work.
# Bash sandbox: the runtime masks /proc subpaths (/proc/sys, /proc/keys, ...), and with those masks
# the kernel refuses the fresh /proc mount bwrap makes for its pid namespace ("bwrap: Can't mount
# proc on /newroot/proc"), so every Bash call in a run fails. The container therefore starts as root
# with CAP_SYS_ADMIN, unmounts the masks, and drops to user node with no capabilities before
# run.js starts. EVAL_KEEP_PROC_MASKS=1 skips this (Bash calls then fail inside runs).
set -euo pipefail
BIN="${CONTAINER_BIN:-container}"
IMAGE="${EVAL_IMAGE:-anti-hall-eval}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

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

mounts=()
args=()
prev=""
for a in "$@"; do
  if [ "$prev" = "--cases-dir" ]; then
    a="$(cd "$a" && pwd -P)"  # absolute: inside the repo -> its /work path, else mounted at the same path
    case "$a/" in "$REPO"/*) a="/work/${a#"$REPO"}"; a="${a//\/\///}" ;; *) mounts+=(-v "$a":"$a":ro) ;; esac
  fi
  args+=("$a")
  prev="$a"
done

entry=(node evals/anti-hall/run.js)
priv=()
if [ -z "${EVAL_KEEP_PROC_MASKS:-}" ]; then
  priv=(-u root --cap-add CAP_SYS_ADMIN)
  # shellcheck disable=SC2016  # expanded inside the container
  entry=(bash -c 'grep " /proc/" /proc/self/mountinfo | awk "{print \$5}" | sort -r | while read -r m; do umount "$m"; done
exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --bounding-set=-all node evals/anti-hall/run.js "$@"' run.js)
fi

exec "$BIN" run --rm --init -m "${EVAL_MEMORY:-4G}" -c "${EVAL_CPUS:-4}" ${priv[@]+"${priv[@]}"} \
  -v "$REPO":/work -w /work ${mounts[@]+"${mounts[@]}"} \
  -e HOME=/home/node -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
  ${cred[@]+"${cred[@]}"} \
  "$IMAGE" "${entry[@]}" ${args[@]+"${args[@]}"}
