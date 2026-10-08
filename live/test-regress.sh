#!/bin/sh
# Regression tests for live-use bugs not covered by test-hardening.sh: #6 (kit ledger stale after the owner unblocked by hand-editing
# settings.json), #9 (old shadow triggers writing into the live engine's state/telemetry), and go-live hitting a full disk part-way.
# Usage: sh live/test-regress.sh        No cargo, no real claude, no network. Everything runs in a scratch HOME.
# The `claude` CLI is a stateful stub (it edits settings.json enabledPlugins like the real one); the engine is a stub script;
# a full disk is simulated by a `cp`/`mkdir` stub on PATH that fails with ENOSPC after N calls, never by filling a disk.
KITSRC=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
F=$(mktemp -d) || exit 1; fails=0
ok() { printf 'PASS  %s\n' "$*"; }; ko() { printf 'FAIL  %s\n' "$*"; fails=$((fails+1)); }
chk() { if [ "$1" = 0 ]; then ok "$2"; else ko "$2"; fi; }
trap 'rm -rf "$F"' EXIT
command -v node >/dev/null 2>&1 || { echo "need node"; exit 1; }
export HOME=$F/home CLAUDE_CONFIG_DIR=$F/home/.claude TMPDIR=$F/tmp
unset AH_ENGINE_DIR AH_ENGINE_PLUGIN_ROOT CLAUDE_PLUGIN_ROOT
mkdir -p "$HOME/.claude" "$TMPDIR" "$F/fake"
REALCP=$(command -v cp); REALMKDIR=$(command -v mkdir)
# portable sha (GNU sha256sum or BSD shasum): the same fallback chain the kit uses
shaof() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# --- stateful stub claude: the registry lives in $CLI_STATE, "enabled" is read from settings.json enabledPlugins like the real CLI ----
cat >"$F/fake/claude" <<'FAKE'
#!/bin/sh
echo "$*" >>"$FAKE_LOG"
case "${FAKE_MODE:-ok}" in hang) trap '' TERM HUP INT; while :; do sleep 1; done ;; fail) exit 3 ;; esac
exec node -e '
const fs=require("fs"),a=process.argv.slice(1),SET=process.env.CLAUDE_CONFIG_DIR+"/settings.json",ST=process.env.CLI_STATE;
const rd=f=>{try{return JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){return null}};
const st=rd(ST)||{plugins:{},markets:{}}, s=rd(SET)||{};
const save=()=>{fs.writeFileSync(ST,JSON.stringify(st));fs.writeFileSync(SET,JSON.stringify(s,null,2)+"\n")};
const [g,v,x,y]=a; s.enabledPlugins=s.enabledPlugins||{};
if(g==="plugin"&&v==="list"){console.log(JSON.stringify(Object.entries(st.plugins).map(([id,p])=>({id,version:p.version,scope:"user",enabled:s.enabledPlugins[id]===true,installPath:p.installPath}))));}
else if(g==="plugin"&&v==="marketplace"&&x==="list"){console.log("Configured marketplaces:\n");for(const m of Object.keys(st.markets))console.log("  ❯ "+m);}
else if(g==="plugin"&&v==="marketplace"&&x==="add"){const m=rd(y+"/.claude-plugin/marketplace.json");st.markets[m.name]=y;s.extraKnownMarketplaces=s.extraKnownMarketplaces||{};s.extraKnownMarketplaces[m.name]={source:{path:y}};save();}
else if(g==="plugin"&&v==="marketplace"&&x==="remove"){delete st.markets[y];if(s.extraKnownMarketplaces)delete s.extraKnownMarketplaces[y];save();}
else if(g==="plugin"&&v==="install"){const mk=x.split("@")[1],d=st.markets[mk]+"/plugins/anti-hall";st.plugins[x]={version:rd(d+"/.claude-plugin/plugin.json").version,installPath:d};s.enabledPlugins[x]=true;save();}
else if(g==="plugin"&&(v==="enable"||v==="disable")){if(!st.plugins[x])process.exit(1);s.enabledPlugins[x]=v==="enable";save();}
else if(g==="plugin"&&v==="uninstall"){delete st.plugins[x];delete s.enabledPlugins[x];save();}
else if(g==="plugin"&&v==="validate"){}
else process.exit(0);' -- "$@"
FAKE
chmod +x "$F/fake/claude"
export AH_LIVE_CLAUDE=$F/fake/claude FAKE_LOG=$F/fake.log CLI_STATE=$F/cli.json

# --- stub engine (config --json / config validate / stop / status / version) ----------------------------------------------------------
mkengine() { cat >"$1" <<'ENG'
#!/bin/sh
case "$1 $2" in
  "config --json") cat <<'J'
{"settings":{"dispatch.guard_events":{"value":["PreToolUse"]},"dispatch.hooks_claude_PreToolUse":{"value":[{"id":"g1","check":"c1"},{"id":"g2","check":"c2"}]}}}
J
  ;;
  "config validate") exit 0 ;;
  "stop "*|"stop") exit 0 ;;
esac
exit 0
ENG
chmod +x "$1"; }

# --- a kit as install-shadow-remote.sh would leave it (scripts + bundle), a user settings.json, an enabled original plugin ------------------
mkkit() {
  K=$HOME/.anti-hall/ah-engine-live; rm -rf "$HOME/.anti-hall" "$HOME/.claude/settings.json" "$CLI_STATE" "$FAKE_LOG"
  mkdir -p "$K/state" "$K/bundle/plugin/.claude-plugin" "$K/bundle/plugin/hooks" "$K/bundle/plugin/engine/defaults"
  for f in lib.sh go-live.sh rollback.sh status.sh node-shadow.sh node-shadow.skip agreed-checks.txt reload-notice.sh; do cp "$KITSRC/$f" "$K/$f"; done
  mkengine "$K/bundle/ah-engine"
  echo '{"name":"anti-hall","version":"9.9.9"}' >"$K/bundle/plugin/.claude-plugin/plugin.json"
  echo '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/hooks/ah-hook.sh\" PreToolUse"}]}]}}' >"$K/bundle/plugin/hooks/hooks.json"
  : >"$K/bundle/plugin/engine/defaults/index.toml"; : >"$K/bundle/plugin/hooks/ah-fallback.list"
  printf 'PreToolUse/c1\nPreToolUse/c2\n' >"$K/agreed-checks.txt"
  node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({env:{A:"1"},enabledPlugins:{"anti-hall@anti-hall":true},hooks:{SessionStart:[{hooks:[{type:"command",command:"echo user-hook"}]}]}},null,2)+"\n")' "$HOME/.claude/settings.json"
  echo '{"plugins":{"anti-hall@anti-hall":{"version":"1","installPath":""}},"markets":{"anti-hall":"x"}}' >"$CLI_STATE"
  SET0=$(shaof "$HOME/.claude/settings.json")
}
# pstate KEY -> enabled|disabled|absent from the stub CLI
pstate() { sh -c '. "$1/lib.sh"; plugin_state "$2" | cut -f1' x "$K" "$1"; }
live_ok() { [ "$(pstate anti-hall@anti-hall-engine-live)" = enabled ] && [ "$(pstate anti-hall@anti-hall)" = disabled ]; }
orig_ok() { [ "$(pstate anti-hall@anti-hall-engine-live)" = absent ] && [ "$(pstate anti-hall@anti-hall)" = enabled ]; }

echo "== baseline: go-live against the stubs works"
mkkit
sh "$K/go-live.sh" >"$F/gl.out" 2>&1; rc=$?; chk $rc "go-live exit 0"; [ $rc = 0 ] || sed 's/^/   | /' "$F/gl.out"
live_ok; chk $? "live plugin enabled, original disabled"
node -e 'process.exit(require(process.argv[1]).complete===true?0:1)' "$K/state/live.json"; chk $? "ledger complete"

echo "== 6. the owner unblocks by hand-editing settings.json (live off, original on): the ledger is NOT trusted"
unblock() { node -e 'const fs=require("fs"),f=process.argv[1],s=JSON.parse(fs.readFileSync(f,"utf8"));s.enabledPlugins["anti-hall@anti-hall"]=true;s.enabledPlugins["anti-hall@anti-hall-engine-live"]=false;fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$HOME/.claude/settings.json"; }
unblock
sh "$K/status.sh" >"$F/st.out" 2>&1; rc=$?
[ "$rc" -ne 0 ] && grep -q 'DRIFT' "$F/st.out"; chk $? "status.sh names the drift (ledger says live, the host does not) and exits non-zero (rc=$rc)"
grep -q '^MODE: LIVE$' "$F/st.out"; [ $? -ne 0 ]; chk $? "status.sh does not report a plain 'MODE: LIVE' over a drifted machine"
sh "$K/go-live.sh" >"$F/gl2.out" 2>&1; rc=$?
live_ok; chk $? "go-live re-run reconciles: live enabled and original disabled again (rc=$rc)"
sh "$K/status.sh" >"$F/st2.out" 2>&1; chk $? "status.sh clean after the reconcile"
unblock
sh "$K/rollback.sh" >"$F/rb.out" 2>&1; rc=$?; chk $rc "rollback after a manual unblock completes without --force"
orig_ok; chk $? "after rollback: original enabled, live plugin gone"
[ ! -f "$K/state/live.json" ] && [ "$(shaof "$HOME/.claude/settings.json")" = "$SET0" ]; chk $? "ledger moved, settings.json byte-identical to the pre-go-live file"
echo "-- manual unblock that ALSO removed the live plugin by hand (claude plugin uninstall): rollback still finishes"
mkkit; sh "$K/go-live.sh" >/dev/null 2>&1
"$AH_LIVE_CLAUDE" plugin uninstall anti-hall@anti-hall-engine-live; "$AH_LIVE_CLAUDE" plugin enable anti-hall@anti-hall
sh "$K/status.sh" >"$F/st3.out" 2>&1; rc=$?; [ "$rc" -ne 0 ] && grep -q 'DRIFT' "$F/st3.out"; chk $? "status names the drift when the live plugin is gone"
sh "$K/rollback.sh" >"$F/rb2.out" 2>&1; chk $? "rollback exit 0"
orig_ok && [ "$(shaof "$HOME/.claude/settings.json")" = "$SET0" ]; chk $? "original enabled, settings.json byte-identical"

echo "== 12. owner edits made AFTER go-live survive a rollback (the theme was reset to light-ansi on 2026-10-08)"
mkkit
node -e 'const fs=require("fs"),f=process.argv[1],s=JSON.parse(fs.readFileSync(f,"utf8"));s.theme="auto";s.hooks.PreToolUse=[{hooks:[{type:"command",command:"sh $HOME/.anti-hall/ah-engine-shadow/shadow-all.sh PreToolUse"}]}];fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$HOME/.claude/settings.json"
SETA=$(shaof "$HOME/.claude/settings.json")
sh "$K/go-live.sh" >"$F/gl12.out" 2>&1; chk $? "go-live exit 0 (settings.json had a shadow trigger and theme=auto)"
! grep -q 'shadow-all.sh' "$HOME/.claude/settings.json" && grep -q 'ah-node-shadow/node-shadow.sh' "$HOME/.claude/settings.json"; chk $? "go-live removed the shadow trigger and added the witness"
node -e 'const fs=require("fs"),f=process.argv[1],s=JSON.parse(fs.readFileSync(f,"utf8"));s.theme="light-ansi";s.model="opus";s.hooks.Stop=[{hooks:[{type:"command",command:"echo owner-stop"}]}];fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$HOME/.claude/settings.json"
sh "$K/rollback.sh" >"$F/rb12.out" 2>&1; chk $? "rollback exit 0 without --force over the owner edits"
orig_ok; chk $? "original plugin enabled again, live plugin gone"
node -e '
  const s=require(process.argv[1]),bad=[];
  if(s.theme!=="light-ansi")bad.push("theme="+s.theme); if(s.model!=="opus")bad.push("model"); if(!s.hooks.Stop)bad.push("Stop hook");
  if(s.env.A!=="1")bad.push("env");
  if(!JSON.stringify(s.hooks.PreToolUse||[]).includes("shadow-all.sh"))bad.push("shadow trigger not back");
  if(JSON.stringify(s).includes("node-shadow.sh"))bad.push("witness left");
  if("anti-hall@anti-hall-engine-live" in s.enabledPlugins||(s.extraKnownMarketplaces&&"anti-hall-engine-live" in s.extraKnownMarketplaces))bad.push("live keys left");
  if(bad.length){console.error(bad.join("; "));process.exit(1)}' "$HOME/.claude/settings.json"; chk $? "owner theme/model/Stop hook kept; shadow trigger back; witness and live keys gone"
echo "-- no owner edit: still byte-identical to the pre-go-live file"
mkkit
sh "$K/go-live.sh" >/dev/null 2>&1; sh "$K/rollback.sh" >/dev/null 2>&1
[ "$(shaof "$HOME/.claude/settings.json")" = "$SET0" ]; chk $? "settings.json byte-identical when nothing else changed"

echo "== full disk part-way through go-live: abort cleanly, original stays enabled, never half-installed"
# ENOSPC stub: after $limit successful cp/mkdir calls the next $burst calls fail (a disk that fills while go-live runs, then maybe frees up).
# mv is a rename on the same filesystem and needs no space, so it is not stubbed.
mkdir -p "$F/enospc"
for t in cp mkdir; do
  cat >"$F/enospc/$t" <<STUB
#!/bin/sh
n=\$(cat "$F/enospc/count" 2>/dev/null || echo 0); n=\$((n+1)); echo \$n >"$F/enospc/count"
if [ -f "$F/enospc/limit" ] && [ "\$n" -gt "\$(cat "$F/enospc/limit")" ] && [ "\$n" -le "\$((\$(cat "$F/enospc/limit")+\$(cat "$F/enospc/burst")))" ]; then echo "$t: No space left on device" >&2; exit 1; fi
exec $(command -v $t) "\$@"
STUB
  chmod +x "$F/enospc/$t"
done
OLDPATH=$PATH
# the number of cp/mkdir calls a clean go-live makes (so the sweep covers every write point)
mkkit; echo 0 >"$F/enospc/count"; rm -f "$F/enospc/limit"; PATH=$F/enospc:$OLDPATH sh "$K/go-live.sh" >/dev/null 2>&1; TOTAL=$(cat "$F/enospc/count")
[ "$TOTAL" -ge 8 ]; chk $? "a clean go-live makes $TOTAL cp/mkdir calls (sweep range)"
for mode in transient persistent; do
  [ $mode = transient ] && burst=1 || burst=100000
  N=0; while [ "$N" -le "$TOTAL" ]; do
    mkkit; echo 0 >"$F/enospc/count"; echo $N >"$F/enospc/limit"; echo $burst >"$F/enospc/burst"
    PATH=$F/enospc:$OLDPATH sh "$K/go-live.sh" >"$F/full.$mode.$N.out" 2>&1; rc=$?
    rm -f "$F/enospc/limit"
    if [ "$rc" -eq 0 ]; then
      live_ok && node -e 'process.exit(require(process.argv[1]).complete===true?0:1)' "$K/state/live.json"; chk $? "$mode, fail after $N writes: go-live finished (rc=0) and is consistently live"
    else
      # the invariant for ANY full-disk abort: the host sees the original plugin enabled, no live plugin, settings.json valid JSON
      orig_ok && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$HOME/.claude/settings.json"; chk $? "$mode, fail after $N writes: aborted (rc=$rc), original enabled, live plugin gone, settings.json valid"
      if [ $mode = transient ]; then
        [ "$(shaof "$HOME/.claude/settings.json")" = "$SET0" ] && [ ! -e "$HOME/.anti-hall/ah-engine/bin/ah-engine" ] && ! ls "$HOME/.anti-hall/ah-engine/bin" 2>/dev/null | grep -q '\.new$'; chk $? "transient, fail after $N writes: settings.json byte-identical, no engine binary or .new temp left in the live path"
      fi
    fi
    N=$((N+1))
  done
done

echo "== 9. old shadow triggers still firing in sessions started before go-live never write into the live engine's state"
mkkit
SD=$HOME/.anti-hall/ah-engine-shadow2; mkdir -p "$SD/bin" "$SD/state" "$SD/home" "$SD/plugin"
cat >"$SD/bin/ah-engine" <<'OLD'
#!/bin/sh
echo "$AH_ENGINE_DIR" >>"$HOME/old-engine-ran"; exit 0
OLD
chmod +x "$SD/bin/ah-engine"; : >"$SD/.shadow2-installed"; echo '{}' >"$SD/noop-map.json"
sh "$K/go-live.sh" >/dev/null 2>&1
# extract the shadow2.sh trigger exactly as the installer would write it
sed -n "/^cat > \"\$TMPD\/shadow2.sh\" <<'SHEOF'/,/^SHEOF/p" "$KITSRC/../install-shadow-remote.sh" | sed '1d;$d' >"$SD/shadow2.sh"
[ -s "$SD/shadow2.sh" ]; chk $? "extracted the shadow2.sh trigger from the installer"
printf 'LIVE_HOME=%s\nLIVE_BIN=x\nLIVE_STATE=x\nLIVE_ROOT=x\n' "$HOME" >"$SD/live.conf"
rm -f "$HOME/old-engine-ran" "$SD/log-calls.ndjson"
printf '{"session_id":"s1","tool_name":"Bash","tool_input":{"command":"ls"}}' | sh "$SD/shadow2.sh" PreToolUse
[ ! -f "$HOME/old-engine-ran" ] && [ ! -s "$SD/log-calls.ndjson" ]; chk $? "shadow2.sh does nothing once live.conf exists (no old engine run, no log line)"
LIVEST=$HOME/.anti-hall/ah-engine; before=$(ls -A "$LIVEST" 2>/dev/null | sort | tr '\n' ' ')
printf '{"session_id":"s1"}' | sh "$SD/shadow2.sh" PreToolUse
[ "$(ls -A "$LIVEST" 2>/dev/null | sort | tr '\n' ' ')" = "$before" ]; chk $? "live engine state dir untouched by the old trigger"
# the Mac trigger (machine-local shadow-all.sh, no AH_ENGINE_DIR): go-live neutralises it, rollback restores it byte-identical
MD=$HOME/.anti-hall/ah-engine-shadow
mkkit; mkdir -p "$MD"
printf '#!/bin/sh\n"$HOME/.anti-hall/ah-engine-shadow/ah-engine" hook --event "$1" >>"$HOME/.anti-hall/ah-engine-shadow/ran" 2>&1\n' >"$MD/shadow-all.sh"; mkengine "$MD/ah-engine"
SA0=$(shaof "$MD/shadow-all.sh")
sh "$K/go-live.sh" >/dev/null 2>&1
printf '{"session_id":"s1"}' | sh "$MD/shadow-all.sh" PreToolUse >/dev/null 2>&1
[ ! -e "$MD/ran" ] && [ ! -e "$HOME/.anti-hall/ah-engine/telemetry" ]; chk $? "after go-live the old Mac trigger is a no-op (it would otherwise run the OLD binary on the live state dir)"
sh "$K/rollback.sh" >/dev/null 2>&1
[ "$(shaof "$MD/shadow-all.sh")" = "$SA0" ]; chk $? "rollback restores shadow-all.sh byte-identical"

echo; echo "regress: $fails failed"
[ "$fails" -eq 0 ]
