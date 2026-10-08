#!/bin/sh
# Hardening tests for the live kit: no cargo, no real claude, no network. Usage: sh live/test-hardening.sh
# Everything runs in a temp HOME; a fake `claude` stands in for the CLI (modes: ok, hang = ignores TERM and never returns, fail).
# Covers live-use bugs #3 (--force forwarding), #4 (own witness edits), #5 (CLI hang), #6 (ledger stale after interruption), #11 (reload
# notice), plus: unwritable state dir, Ctrl-C mid-rollback then re-run, GNU/BSD sha shims.
KITSRC=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO=$(CDPATH= cd -- "$KITSRC/.." && pwd)
F=$(mktemp -d) || exit 1; fails=0
ok() { printf 'PASS  %s\n' "$*"; }; ko() { printf 'FAIL  %s\n' "$*"; fails=$((fails+1)); }
chk() { if [ "$1" = 0 ]; then ok "$2"; else ko "$2"; fi; }
trap 'rm -rf "$F"' EXIT
command -v node >/dev/null 2>&1 || { echo "need node"; exit 1; }
export HOME=$F/home CLAUDE_CONFIG_DIR=$F/home/.claude TMPDIR=$F/tmp
unset AH_ENGINE_DIR
mkdir -p "$HOME/.claude" "$TMPDIR" "$F/fake"

# --- fake claude -------------------------------------------------------------------------------------------------------------------
cat >"$F/fake/claude" <<'FAKE'
#!/bin/sh
echo "$*" >>"$FAKE_LOG"
case "${FAKE_MODE:-ok}" in
  hang) trap '' TERM HUP INT; while :; do sleep 1; done ;;
  fail) exit 3 ;;
esac
case "$1 $2" in
  "plugin list") echo '[{"id":"anti-hall@anti-hall","version":"1","scope":"user","enabled":true}]' ;;
esac
exit 0
FAKE
chmod +x "$F/fake/claude"
export AH_LIVE_CLAUDE=$F/fake/claude FAKE_LOG=$F/fake.log

# --- a fake installed kit with a ledger, as go-live would leave it -------------------------------------------------------------------
mkkit() {
  K=$HOME/.anti-hall/ah-engine-live; rm -rf "$K" "$HOME/.anti-hall/ah-node-shadow" "$HOME/.anti-hall/ah-live-notice"
  mkdir -p "$K/state/backup"
  for f in lib.sh go-live.sh rollback.sh status.sh node-shadow.sh node-shadow.skip agreed-checks.txt reload-notice.sh; do cp "$KITSRC/$f" "$K/$f"; done
  node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({env:{A:"1"},enabledPlugins:{"anti-hall@anti-hall":true},hooks:{SessionStart:[{hooks:[{type:"command",command:"echo user-hook"}]}]}},null,2)+"\n")' "$HOME/.claude/settings.json"
  cp -p "$HOME/.claude/settings.json" "$K/state/backup/settings.json"
  # go-live's own edits: the CLI flips enabledPlugins, the installer adds the witness + the notice
  node -e '
    const fs=require("fs"),f=process.argv[1],s=JSON.parse(fs.readFileSync(f,"utf8"));
    s.enabledPlugins={"anti-hall@anti-hall":false,"anti-hall@anti-hall-engine-live":true};
    fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$HOME/.claude/settings.json"
  sh "$K/node-shadow.sh" --install --root "$F/fakeroot" >/dev/null 2>&1; sh "$K/reload-notice.sh" --install
  S0=$(shasum -a 256 "$HOME/.claude/settings.json" 2>/dev/null | cut -d' ' -f1 || sha256sum "$HOME/.claude/settings.json" | cut -d' ' -f1)
  B0=$(shasum -a 256 "$K/state/backup/settings.json" | cut -d' ' -f1)
  node -e '
    const [f,sp,bp,sa,sb]=process.argv.slice(1);
    require("fs").writeFileSync(f,JSON.stringify({started:"t",arg:"none",origs:[{key:"anti-hall@anti-hall",version:"1"}],live:{key:"anti-hall@anti-hall-engine-live",marketplace:"anti-hall-engine-live",version:"2"},
      files:{settings:{path:sp,existed:true,sha_before:sb,sha_after:sa,backup:"backup/settings.json"}},on:[],off:[],complete:true},null,2)+"\n")' "$K/state/live.json" "$HOME/.claude/settings.json" "$K/state/backup/settings.json" "$S0" "$B0"
}
shaof() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1 || sha256sum "$1" | cut -d' ' -f1; }

echo "== 5. lim: a child that ignores TERM is killed, with and without a timeout binary"
. "$KITSRC/lib.sh" 2>/dev/null || true
OLDPATH=$PATH; KIT=$KITSRC
t0=$(date +%s); ( trap '' TERM; lim 2 sh -c 'trap "" TERM; while :; do sleep 1; done' ); rc=$?; t1=$(date +%s)
[ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; chk $? "lim returns 124/137 for a TERM-ignoring hang (rc=$rc)"
[ $((t1-t0)) -le 12 ]; chk $? "...within the bound ($((t1-t0))s)"
NT=$F/notimeout; mkdir -p "$NT"; for b in sh sleep kill ps awk node date cat rm mkdir printf; do p=$(command -v $b) && ln -sf "$p" "$NT/$b"; done
t0=$(date +%s); PATH=$NT; ( lim 2 sh -c 'trap "" TERM; while :; do sleep 1; done' ); rc=$?; PATH=$OLDPATH; t1=$(date +%s)
[ $((t1-t0)) -le 12 ]; chk $? "POSIX watchdog fallback (no timeout binary) also bounded ($((t1-t0))s, rc=$rc)"

echo "== 5. rollback with a CLI that hangs and ignores TERM never hangs; falls back to editing settings.json"
mkkit
t0=$(date +%s)
AH_CLI_TIMEOUT=2 FAKE_MODE=hang sh "$K/rollback.sh" >"$F/rb.out" 2>&1; rc=$?
t1=$(date +%s)
[ $((t1-t0)) -le 40 ]; chk $? "rollback returned in $((t1-t0))s (bounded)"
[ ! -f "$K/state/live.json" ]; chk $? "ledger moved away (rollback finished)"
node -e 'const s=require(process.argv[1]);process.exit(s.enabledPlugins["anti-hall@anti-hall"]===true&&!s.enabledPlugins["anti-hall@anti-hall-engine-live"]?0:1)' "$HOME/.claude/settings.json"; chk $? "original plugin enabled, live plugin gone from settings.json"
grep -q E_CLI_TIMEOUT "$K/state/kit.log"; chk $? "kit.log has the reason code E_CLI_TIMEOUT"
[ "$(shaof "$HOME/.claude/settings.json")" = "$(shaof "$K/state/rolled-back-"*/backup/settings.json)" ]; chk $? "settings.json byte-identical to the backup"

echo "== 4. a plain rollback is not refused over the kit's own witness/notice edits (and #3 --force still works over a user edit)"
mkkit
# the witness entries were re-written after go-live (an updated installer), so the settings sha no longer matches the ledger
sh "$K/node-shadow.sh" --install --root "$F/fakeroot2" >/dev/null 2>&1
node -e 'const fs=require("fs"),f=process.argv[1],s=JSON.parse(fs.readFileSync(f,"utf8"));s.hooks.UserPromptSubmit=(s.hooks.UserPromptSubmit||[]);fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$HOME/.claude/settings.json"
FAKE_MODE=ok sh "$K/rollback.sh" >"$F/rb2.out" 2>&1; chk $? "plain rollback succeeded (no 'changed after go-live' refusal)"
grep -q 'refusing' "$F/rb2.out"; [ $? -ne 0 ]; chk $? "no refusal message"
! grep -q 'node-shadow.sh\|notice.sh' "$HOME/.claude/settings.json"; chk $? "witness + notice entries gone"
mkkit
node -e 'const fs=require("fs"),f=process.argv[1],s=JSON.parse(fs.readFileSync(f,"utf8"));s.theme="user-edit";fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$HOME/.claude/settings.json"
FAKE_MODE=ok sh "$K/rollback.sh" >"$F/rb3.out" 2>&1; rc=$?
[ "$rc" -eq 0 ] && ! grep -q 'refusing' "$F/rb3.out"; chk $? "a user edit of settings.json no longer refuses the rollback (rc=$rc)"
node -e 'const s=require(process.argv[1]);process.exit(s.theme==="user-edit"&&s.enabledPlugins["anti-hall@anti-hall"]===true&&!("anti-hall@anti-hall-engine-live" in s.enabledPlugins)?0:1)' "$HOME/.claude/settings.json"; chk $? "...the edit is kept and the kit keys are reverted"

echo "== 3. install-shadow-remote.sh --rollback-live --force forwards --force to the kit"
mkkit   # the previous section now completes its rollback (a settings.json edit no longer refuses it), so the ledger is rebuilt
cat >"$K/rollback.sh" <<'EOF2'
#!/bin/sh
printf '%s\n' "$*" >"$FAKE_RB_ARGS"
exit 0
EOF2
FAKE_RB_ARGS=$F/rb-args sh "$REPO/install-shadow-remote.sh" --rollback-live --force >"$F/inst.out" 2>&1
[ "$(cat "$F/rb-args" 2>/dev/null)" = "--force" ]; chk $? "kit rollback.sh received --force (got: $(cat "$F/rb-args" 2>/dev/null))"
FAKE_RB_ARGS=$F/rb-args2 sh "$REPO/install-shadow-remote.sh" --rollback-live >"$F/inst2.out" 2>&1
[ -z "$(cat "$F/rb-args2" 2>/dev/null)" ]; chk $? "...and nothing without --force"

echo "== 6. Ctrl-C mid-rollback leaves the ledger; the re-run completes"
mkkit
( AH_CLI_TIMEOUT=30 FAKE_MODE=hang sh "$K/rollback.sh" >"$F/rb4.out" 2>&1 ) & rbp=$!
sleep 3; pkill -INT -P $rbp 2>/dev/null; kill -INT $rbp 2>/dev/null; kill -TERM $rbp 2>/dev/null; wait $rbp 2>/dev/null
pkill -f "$F/fake/claude" 2>/dev/null
[ -f "$K/state/live.json" ]; chk $? "ledger still present after the interrupt (state not lost)"
FAKE_MODE=ok sh "$K/rollback.sh" >"$F/rb5.out" 2>&1; chk $? "re-run completes"
[ ! -f "$K/state/live.json" ]; chk $? "ledger moved after the re-run"

echo "== unwritable state dir: rollback refuses before changing anything, with a clear message"
mkkit
chmod 500 "$K/state"
before=$(shaof "$HOME/.claude/settings.json")
FAKE_MODE=ok sh "$K/rollback.sh" >"$F/rb6.out" 2>&1; rc=$?
chmod 700 "$K/state"
[ "$rc" -ne 0 ] && grep -q 'cannot write' "$F/rb6.out"; chk $? "clear message ($(grep -o 'cannot write[^;]*' "$F/rb6.out" | head -1))"

echo "== 11. reload notice: once per session, nothing for another session twice, self-removes after the TTL, rollback removes it"
mkkit
N=$HOME/.anti-hall/ah-live-notice/notice.sh
o1=$(printf '{"session_id":"abc"}' | sh "$N"); o2=$(printf '{"session_id":"abc"}' | sh "$N"); o3=$(printf '{"session_id":"def"}' | sh "$N")
echo "$o1" | grep -q 'reload-plugins'; chk $? "first prompt of session abc prints the notice"
[ -z "$o2" ]; chk $? "second prompt of abc prints nothing"
echo "$o3" | grep -q 'reload-plugins'; chk $? "another session gets it once too"
echo "$o1" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))'; chk $? "output is valid JSON (systemMessage)"
echo 1 >"$HOME/.anti-hall/ah-live-notice/installed_at"
o4=$(printf '{"session_id":"zzz"}' | sh "$N"); [ -z "$o4" ] && ! grep -q 'notice.sh' "$HOME/.claude/settings.json"; chk $? "after the TTL it prints nothing and removes its settings entry"
mkkit
FAKE_MODE=ok sh "$K/rollback.sh" >/dev/null 2>&1; [ ! -d "$HOME/.anti-hall/ah-live-notice" ] && ! grep -q 'notice.sh' "$HOME/.claude/settings.json"; chk $? "rollback removes the notice and its files"

echo "== sha helper works with only openssl/node (no sha256sum, no shasum)"
echo hello >"$F/h.txt"; want=$(shaof "$F/h.txt")
NS=$F/nosha; mkdir -p "$NS"; for b in sh cut sed node cat openssl; do p=$(command -v $b) && ln -sf "$p" "$NS/$b"; done
got=$(PATH=$NS; . "$KITSRC/lib.sh" 2>/dev/null; sha "$F/h.txt"); [ "$got" = "$want" ]; chk $? "sha fallback"

echo "== 7. rollback reverts only the kit's own settings.json keys; owner edits made after go-live survive (theme lost on 2026-10-08)"
mkkit
# the snapshot had an old shadow trigger and a user hook; go-live removed the trigger; then the owner edited settings.json
node -e '
  const fs=require("fs"),[f,b]=process.argv.slice(1),ST="sh $HOME/.anti-hall/ah-engine-shadow2/shadow2.sh PreToolUse";
  const sb=JSON.parse(fs.readFileSync(b,"utf8")); sb.theme="auto"; sb.extraKnownMarketplaces={other:{source:{path:"/x"}}};
  sb.hooks.PreToolUse=[{matcher:"Bash",hooks:[{type:"command",command:"echo user-pre"}]},{hooks:[{type:"command",command:ST}]}];
  fs.writeFileSync(b,JSON.stringify(sb,null,2)+"\n");
  const s=JSON.parse(fs.readFileSync(f,"utf8")); s.theme="auto"; s.extraKnownMarketplaces={other:{source:{path:"/x"}},"anti-hall-engine-live":{source:{path:"/m"}}};
  s.hooks.PreToolUse=[{matcher:"Bash",hooks:[{type:"command",command:"echo user-pre"}]}];
  s.theme="light-ansi"; s.permissions={allow:["Bash(ls:*)"]}; s.hooks.PostToolUse=[{hooks:[{type:"command",command:"echo owner-added-later"}]}]; s.enabledPlugins["third@x"]=true;
  fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n");' "$HOME/.claude/settings.json" "$K/state/backup/settings.json"
FAKE_MODE=ok sh "$K/rollback.sh" >"$F/rb7.out" 2>&1; rc=$?
chk $rc "rollback exit 0 over an owner-edited settings.json"
node -e '
  const s=require(process.argv[1]),c=x=>JSON.stringify(x);
  const bad=[];
  if(s.theme!=="light-ansi")bad.push("theme "+s.theme);
  if(c(s.permissions)!==c({allow:["Bash(ls:*)"]}))bad.push("permissions");
  if(!s.hooks.PostToolUse||s.hooks.PostToolUse[0].hooks[0].command!=="echo owner-added-later")bad.push("owner hook");
  if(s.enabledPlugins["third@x"]!==true)bad.push("third plugin");
  if(s.enabledPlugins["anti-hall@anti-hall"]!==true)bad.push("original not re-enabled");
  if("anti-hall@anti-hall-engine-live" in s.enabledPlugins)bad.push("live plugin key left");
  if("anti-hall-engine-live" in s.extraKnownMarketplaces||!s.extraKnownMarketplaces.other)bad.push("marketplaces "+c(s.extraKnownMarketplaces));
  const pre=s.hooks.PreToolUse.map(g=>g.hooks[0].command);
  if(c(pre)!==c(["echo user-pre","sh $HOME/.anti-hall/ah-engine-shadow2/shadow2.sh PreToolUse"]))bad.push("PreToolUse "+c(pre));
  if(/node-shadow.sh|notice.sh/.test(c(s.hooks)))bad.push("kit hook entries left");
  if(bad.length){console.error(bad.join("; "));process.exit(1)}' "$HOME/.claude/settings.json"; chk $? "owner edits kept; kit keys, shadow trigger and witness/notice entries reverted"
ls "$K/state/rolled-back-"*/settings.json.pre-rollback >/dev/null 2>&1; chk $? "the pre-rollback settings.json is kept under rolled-back-*/"
echo "-- rolling back twice (re-run after an interrupt) changes nothing more"
mkkit
node -e 'const fs=require("fs"),f=process.argv[1],s=JSON.parse(fs.readFileSync(f,"utf8"));s.theme="light-ansi";fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' "$HOME/.claude/settings.json"
FAKE_MODE=ok sh "$K/rollback.sh" >/dev/null 2>&1; A=$(shaof "$HOME/.claude/settings.json"); mkdir -p "$K/state/backup"; cp "$K"/state/rolled-back-*/backup/settings.json "$K/state/backup/settings.json"; cp "$K"/state/rolled-back-*/live.json "$K/state/live.json"
FAKE_MODE=ok sh "$K/rollback.sh" >/dev/null 2>&1; [ "$A" = "$(shaof "$HOME/.claude/settings.json")" ]; chk $? "second rollback leaves settings.json as it is"

echo; echo "hardening: $fails failed"
[ "$fails" -eq 0 ]
