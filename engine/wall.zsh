# Usage: zsh wall.zsh   (after `cargo build --release`). Isolated engine dir; never touches ~/.anti-hall.
zmodload zsh/datetime
E=$PWD/target/release/engine
export ANTIHALL_ENGINE_DIR=/tmp/ah-bench-$$ ANTIHALL_ENGINE_RULES=$PWD/rules.json HOME=/tmp/ah-bench-home-$$
mkdir -p $HOME
IN='{"session_id":"s","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}'
med() { local s=(${(n)@}); printf "%.1f (min %.1f, max %.1f)" $s[$(( (${#s}+1)/2 ))] $s[1] $s[-1]; }
echo "$IN" | $E hook >/dev/null; sleep 0.3
t=(); for i in {1..30}; do a=$EPOCHREALTIME; echo "$IN" | $E hook >/dev/null; t+=($(( (EPOCHREALTIME-a)*1000 ))); done
echo "rust warm wall ms median: $(med $t)"
t=(); for i in {1..30}; do a=$EPOCHREALTIME; echo "$IN" | node base.js >/dev/null; t+=($(( (EPOCHREALTIME-a)*1000 ))); done
echo "node wall ms median: $(med $t)"
# fail-open paths (no daemon can serve): garbage input, spawn disabled, unwritable dir
t=(); for i in {1..30}; do a=$EPOCHREALTIME; echo 'garbage' | ANTIHALL_ENGINE_NOSPAWN=1 ANTIHALL_ENGINE_DIR=/nonexistent/x $E hook >/dev/null; t+=($(( (EPOCHREALTIME-a)*1000 ))); done
echo "fail-open (no daemon, no spawn) ms median: $(med $t)"
t=(); for i in {1..30}; do a=$EPOCHREALTIME; echo "$IN" | ANTIHALL_ENGINE_DIR=/nonexistent/x TMPDIR=/nonexistent $E hook >/dev/null; t+=($(( (EPOCHREALTIME-a)*1000 ))); done
echo "fail-open (daemon cannot start) ms median: $(med $t)"
# peak RSS (bytes -> MB) of client and node, 10 runs median
rss() { local r=(); for i in {1..10}; do r+=($( { echo "$IN" | /usr/bin/time -l "$@" >/dev/null; } 2>&1 | awk '/maximum resident/{print $1/1048576}')); done; local s=(${(n)r}); printf "%.1f MB" $s[5]; }
echo "RSS client: $(rss $E hook)   node: $(rss node base.js)"
P=$($E ctl ping | awk '{print $3}'); echo "daemon RSS idle: $(ps -o rss= -p $P | awk '{printf "%.2f MB",$1/1024}')"
for i in {1..1000}; do echo "$IN" | $E hook >/dev/null; done
echo "daemon RSS after 1000 requests: $(ps -o rss= -p $P | awk '{printf "%.2f MB",$1/1024}')"
$E ctl stop >/dev/null; rm -rf $ANTIHALL_ENGINE_DIR $HOME
