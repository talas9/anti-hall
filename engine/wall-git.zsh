# Usage: zsh wall-git.zsh <path to hooks/git-guard.js>   (after `cargo build --release`).
# Wall time and peak RSS of the git check through the warm daemon vs the Node git-guard, same payloads.
# Isolated HOME + engine dir; never touches ~/.anti-hall.
zmodload zsh/datetime
E=$PWD/target/release/engine
NODE_HOOK=${1:?path to git-guard.js}
D=/tmp/ah-gbench-$$
export ANTIHALL_ENGINE_DIR=$D/eng HOME=$D/home ANTIHALL_ENGINE_RULES=$D/rules.json ANTIHALL_ENGINE_VERSION=bench
mkdir -p $HOME
echo '{"version":1,"rules":[{"id":"git-guard","events":["PreToolUse"],"tools":["Bash"],"check":"git","action":"deny","options":{"plugin_root":"'${NODE_HOOK:h:h}'"}}]}' > $D/rules.json
P1='{"session_id":"s","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}'
P2='{"session_id":"s","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status && ls -la"}}'
P3='{"session_id":"s","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git add -A && git commit -F - <<'"'"'EOF'"'"'\nfix: tidy the thing\n\nlonger body line one\nline two\nEOF\ngit log --oneline -3"}}'
med() { local s=(${(n)@}); printf "%.1f" $s[$(( (${#s}+1)/2 ))]; }
echo "$P2" | $E hook >/dev/null; for i in {1..50}; do $E ctl ping >/dev/null 2>&1 && break; sleep 0.1; done
for name in P1:block P2:allow P3:commit-heredoc; do
  v=${name%%:*}; label=${name#*:}; IN=${(P)v}
  t=(); for i in {1..30}; do a=$EPOCHREALTIME; echo "$IN" | $E hook >/dev/null 2>&1; t+=($(( (EPOCHREALTIME-a)*1000 ))); done
  n=(); for i in {1..30}; do a=$EPOCHREALTIME; echo "$IN" | node $NODE_HOOK >/dev/null 2>&1; n+=($(( (EPOCHREALTIME-a)*1000 ))); done
  echo "$label: engine client warm wall median $(med $t) ms | node git-guard median $(med $n) ms"
done
rss() { local r=(); for i in {1..10}; do r+=($( { echo "$IN" | /usr/bin/time -l "$@" >/dev/null; } 2>&1 | awk '/maximum resident/{print $1/1048576}')); done; local s=(${(n)r}); printf "%.1f MB" $s[5]; }
IN=$P2
echo "peak RSS (median of 10, allow case): engine client $(rss $E hook)   node $(rss node $NODE_HOOK)"
PID=$($E ctl ping | awk '{print $3}'); echo "daemon RSS before: $(ps -o rss= -p $PID | awk '{printf "%.2f MB",$1/1024}')"
for i in {1..1000}; do echo "$P3" | $E hook >/dev/null 2>&1; done
echo "daemon RSS after 1000 commit-heredoc requests: $(ps -o rss= -p $PID | awk '{printf "%.2f MB",$1/1024}')"
$E ctl stop >/dev/null; rm -rf $D
