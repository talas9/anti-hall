#!/bin/bash
# start.sh <tag> [js_stats_every] -> creates a scratch HOME + plugin copy + sandboxes, starts a scratch daemon, prints "HOME PID SOCK".
# Everything lives under a fresh mktemp dir; the real HOME, ~/.anti-hall/ah-engine-live and the live daemon are never touched.
set -e
TAG=$1; JS=${2:-0}
P=$HOME/.anti-hall/work/prof21-22; W=$HOME/.anti-hall/work/wt-prof
BIN=${BIN:-$W/ah-engine/target/release/ah-engine}
H=$(mktemp -d "${TMPDIR:-/tmp}/ahp.XXXX")
mkdir -p $H/home/.claude $H/home/.anti-hall $H/sb
cp -R $W/plugins/anti-hall $H/plugin
sed -i '' "s|^value = \"\"\$|value = \"stages.ndjson\"|" $H/plugin/engine/defaults/profile.toml   # stage_log is the only empty-string value in the file
sed -i '' "s|^value = 0\$|value = $JS|" $H/plugin/engine/defaults/profile.toml
for i in 0 1 2 3 4 5 6 7 8 9 10 11; do cp -R $HOME/.anti-hall/work/replay/sandbox-pristine $H/sb/sb$i; done
cd $H
cd "$H"; export HOME=$H/home
# the hook client starts the daemon with the allocator tuning of daemon.malloc_conf; a bare `serve` would not have it
if [ -z "$NOCONF" ]; then CONF="_RJEM_MALLOC_CONF=narenas:1,dirty_decay_ms:0,muzzy_decay_ms:0 MALLOC_CONF=narenas:1,dirty_decay_ms:0,muzzy_decay_ms:0"; else CONF=""; fi
env -i HOME=$H/home PATH="$PATH" LANG=en_US.UTF-8 AH_ENGINE_DIR=$H/st AH_ENGINE_PLUGIN_ROOT=$H/plugin CLAUDE_PLUGIN_ROOT=$H/plugin \
  AH_ENGINE_VERSION=prof ANTIHALL_INGEST_DRY_RUN=1 AH_ENGINE_RSS_CAP_KB=${RSS_CAP:-0} $CONF ${EXTRA_ENV:-} "$BIN" serve > $H/serve.log 2>&1 &
PID=$!
echo $PID > $H/pid
for i in $(seq 1 100); do [ -S $H/st/*.sock ] 2>/dev/null && break; ls $H/st 2>/dev/null | grep -q sock && break; sleep 0.1; done
echo "$H $PID $(ls -d $H/st/*sock* 2>/dev/null | head -1)"
