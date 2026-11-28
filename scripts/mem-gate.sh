#!/bin/sh
# The D memory gate (acceptance gate A): a scratch daemon, APFS clones of the largest real transcript, 4 concurrent
# UserPromptSubmit/Stop streams with lines appended during the run, peak heap of the big transcripts minus a 5 MB control.
# Never touches the live engine, the live HOME or the source transcript. Prints "GATE PASS" or "GATE FAIL: ..." and exits non-zero on a fail.
#
#   scripts/mem-gate.sh                 # full run (mem_gate.run_secs per phase, 600 s each by default)
#   AH_MEM_GATE_SECS=60 scripts/mem-gate.sh   # a short run
#   AH_MEM_GATE_SRC=/path/to/big.jsonl ...    # a specific source transcript (default: the largest under ~/.claude/projects)
#   AH_MEM_GATE_DIR=/path ...                 # work directory (default ~/.anti-hall/work/mem-gate/run-<pid>)
# Bars: the mem_gate.* keys of plugins/anti-hall/engine/defaults/diagnostics.toml.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here/ah-engine"
exec cargo test --release --test mem_gate -- --ignored --nocapture --test-threads=1
