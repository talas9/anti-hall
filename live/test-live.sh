#!/bin/sh
# Sandbox test of install-shadow-remote.sh --live / --status / --rollback-live. Usage: sh live/test-live.sh [none|orig]
#   none: the machine ran only the shadow (WSL2-like)   orig: an anti-hall plugin was also installed and enabled
# Everything runs in a temp HOME with CLAUDE_CONFIG_DIR set; the real ~/.claude and ~/.anti-hall are never written (sha-checked at the end).
# Env: AH_LIVE_CLAUDE (real claude binary), AH_TEST_BIN (ah-engine at the live build), AH_TEST_PROTO (git repo holding origin/engine-proto).
REAL=$HOME; WHICH=${1:-none}
REAL_CLAUDE=${AH_LIVE_CLAUDE:-$REAL/.local/bin/claude}
BIN=${AH_TEST_BIN:-$REAL/.anti-hall/ah-engine-live/bundle/ah-engine}
PROTO=${AH_TEST_PROTO:-$REAL/.anti-hall/work/repo}
SRC=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)        # the repo checkout under test (installer + live/)
[ -x "$REAL_CLAUDE" ] && [ -x "$BIN" ] || { echo "need claude ($REAL_CLAUDE) and an engine binary ($BIN)"; exit 1; }
realsha() { shasum -a 256 "$REAL/.claude/settings.json" "$REAL/.claude/plugins/installed_plugins.json" "$REAL/.claude/plugins/known_marketplaces.json" "$REAL/.anti-hall/ah-engine/config.toml" 2>/dev/null; ls -la "$REAL/.anti-hall" 2>/dev/null | wc -l; }
REAL_BEFORE=$(realsha)
REAL_NODE=$(command -v node)
F=$(mktemp -d) || exit 1; fails=0
ok() { printf 'PASS  %s\n' "$*"; }; ko() { printf 'FAIL  %s\n' "$*"; fails=$((fails+1)); }
chk() { if [ "$1" = 0 ]; then ok "$2"; else ko "$2"; fi; }
echo "fake HOME: $F  (scenario: $WHICH)"
export HOME=$F CLAUDE_CONFIG_DIR=$F/.claude AH_LIVE_CLAUDE=$REAL_CLAUDE
unset AH_ENGINE_DIR CLAUDE_PLUGIN_ROOT AH_ENGINE_PLUGIN_ROOT AH_LIVE_AGREE_FILE
mkdir -p "$F/.claude" "$F/proj" "$F/shim"
( cd "$F/proj" && git init -q . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init )
# fixture repo (local, no network): engine-proto, used both as the shadow starting point (its plugin matches the prebuilt binary) and as the live source
git init -q "$F/proto" && git -C "$F/proto" fetch -q --depth 1 "file://$PROTO" refs/remotes/origin/engine-proto:refs/heads/engine-proto || { echo "cannot fetch origin/engine-proto from $PROTO"; exit 1; }
node -e 'require("fs").writeFileSync(process.argv[1]+"/.claude/settings.json",JSON.stringify({env:{A:"1"},permissions:{allow:["Bash(ls:*)"]},hooks:{SessionStart:[{hooks:[{type:"command",command:"echo unrelated-user-hook"}]}]},theme:"light"},null,2)+"\n")' "$F"
if [ "$WHICH" = orig ]; then
  INST_DIR=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).plugins["anti-hall@anti-hall"].find(e=>e.scope==="user").installPath)' "$REAL/.claude/plugins/installed_plugins.json")
  mkdir -p "$F/orig/.claude-plugin" "$F/orig/plugins"; cp -R "$INST_DIR" "$F/orig/plugins/anti-hall"
  node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({name:"anti-hall",owner:{name:"t"},plugins:[{name:"anti-hall",source:"./plugins/anti-hall",description:"orig"}]}))' "$F/orig/.claude-plugin/marketplace.json"
  $REAL_CLAUDE plugin marketplace add "$F/orig" >/dev/null && $REAL_CLAUDE plugin install anti-hall@anti-hall >/dev/null || { echo "cannot seed the original plugin"; exit 1; }
fi
IS="$SRC/install-shadow-remote.sh"
echo "== 0. shadow install (the starting state)"
sh "$IS" --bin "$BIN" --repo "file://$F/proto" --branch engine-proto --no-sync >"$F/inst.out" 2>&1; chk $? "shadow install exit 0 ($(tail -1 "$F/inst.out" | cut -c1-80))"
sh "$IS" --status 2>&1 | grep -q '^MODE: SHADOW'; chk $? "--status says MODE: SHADOW"
snap() { printf 'settings %s\n' "$(shasum -a 256 "$F/.claude/settings.json" | cut -d' ' -f1)"; for f in .anti-hall/ah-engine/config.toml .anti-hall/ah-engine/bin/ah-engine; do printf '%s %s\n' "$f" "$(shasum -a 256 "$F/$f" 2>/dev/null | cut -d' ' -f1)"; done
  $REAL_CLAUDE plugin list --json | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8")).forEach(p=>console.log(p.id,p.version,p.enabled?"enabled":"disabled"))'; $REAL_CLAUDE plugin marketplace list | grep -c "anti-hall-engine-live" | sed "s/^/live-marketplace-entries /"; }
SNAP0=$(snap); echo "$SNAP0" | sed 's/^/   | /'
grep -q 'shadow2.sh' "$F/.claude/settings.json"; chk $? "baseline: shadow triggers in settings.json"
# a plain `claude` needs a node shim for nothing here; the hook runner stand-in reads settings + plugin list
echo "== 1. --live"
sh "$IS" --live --bin "$BIN" --live-repo "file://$F/proto" >"$F/live.out" 2>&1; rc=$?; chk $rc "--live exit 0"; [ $rc = 0 ] || sed 's/^/   | /' "$F/live.out"
tail -3 "$F/live.out" | cut -c1-200 | sed 's/^/   | /'
sh "$IS" --status >"$F/status.out" 2>&1; chk $? "--status exit 0"; grep -q '^MODE: LIVE' "$F/status.out"; chk $? "--status says MODE: LIVE"
! grep -q 'shadow2.sh' "$F/.claude/settings.json"; chk $? "shadow triggers removed from settings.json"
grep -q 'ah-node-shadow/node-shadow.sh' "$F/.claude/settings.json"; chk $? "node-shadow hook registered in settings.json"
grep -q 'unrelated-user-hook' "$F/.claude/settings.json"; chk $? "unrelated user hook kept"
$REAL_CLAUDE plugin list --json | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const l=j.find(p=>p.id==="anti-hall@anti-hall-engine-live");process.exit(l&&l.enabled&&!j.some(p=>p.id!=="anti-hall@anti-hall-engine-live"&&/^anti-hall@/.test(p.id)&&p.enabled)?0:1)'; chk $? "CLI: live plugin enabled, no other anti-hall install enabled"
[ -f "$F/.anti-hall/ah-engine-shadow2/live.conf" ]; chk $? "shadow2 live.conf written (sync reads the live engine)"
grep -c . "$F/.anti-hall/ah-engine-live/state/live.json" >/dev/null; node -e 'const j=require(process.argv[1]);console.log("   on="+j.on.length+" off="+j.off.length+" "+JSON.stringify(j.off));process.exit(j.on.length===30&&j.off.length===4?0:1)' "$F/.anti-hall/ah-engine-live/state/live.json"; chk $? "agreement list: 30 guard entries ON, 4 stay Node"
echo "== 2. behaviour"
cp "$SRC/live/mini-host.js" "$F/mini-host.js"
pl() { printf '{"session_id":"s1","cwd":"%s","hook_event_name":"%s","tool_name":"%s","tool_input":%s}' "$F/proj" "$1" "$2" "$3"; }
pl PreToolUse Bash '{"command":"git push --force origin main"}' >"$F/p-block.json"; pl PreToolUse Bash '{"command":"git status"}' >"$F/p-allow.json"
host() { node "$F/mini-host.js" "$1" "$2"; }
host PreToolUse "$F/p-allow.json" >/dev/null; host PreToolUse "$F/p-allow.json" >/dev/null
R=$(host PreToolUse "$F/p-block.json"); printf '%s' "$R" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("   hooks="+r.hooks.map(h=>h.src+":"+h.rc).join(" "));process.exit(r.blocked?0:1)'; chk $? "live: force-push blocked"
printf '%s' "$R" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));const s=r.hooks.filter(h=>/node-shadow/.test(h.cmd));process.exit(s.length===1&&s[0].rc===0&&!s[0].out&&!s[0].err?0:1)'; chk $? "node-shadow hook returned empty, exit 0, never decided"
i=0; while [ $i -lt 30 ] && ! grep -q '"id":"git-guard"' "$F/.anti-hall/ah-node-shadow/node-shadow.ndjson" 2>/dev/null; do sleep 1; i=$((i+1)); done
grep -q '"id":"git-guard".*"dec":"block"' "$F/.anti-hall/ah-node-shadow/node-shadow.ndjson"; chk $? "background worker logged Node git-guard decision=block ($(wc -l <"$F/.anti-hall/ah-node-shadow/node-shadow.ndjson" | tr -d ' ') lines)"
sleep 3; head -3 "$F/.anti-hall/ah-node-shadow/node-shadow.ndjson" | sed 's/^/   | /'
[ ! -e "$F/.anti-hall/ah-node-shadow/q/"* ] 2>/dev/null; ls "$F/.anti-hall/ah-node-shadow/q" | wc -l | tr -d ' ' | sed 's/^/   queued payloads left: /'
sh "$F/.anti-hall/ah-node-shadow/node-shadow.sh" --compare >"$F/cmp.out" 2>&1; chk $? "--compare runs"; sed 's/^/   | /' "$F/cmp.out" | head -14
echo "== 2b. telemetry sync includes the node-shadow log"
git init -q --bare "$F/telemetry.git"; printf 'sync.enabled=true\nsync.repo=file://%s\nsync.interval_s=3600\n' "$F/telemetry.git" > "$F/.anti-hall/ah-engine-shadow2/config"
sh "$IS" --sync-now >"$F/sync.out" 2>&1; chk $? "--sync-now exit 0 ($(grep -m1 pushed "$F/sync.out" | cut -c1-90))"
git -C "$F/telemetry.git" ls-tree -r --name-only HEAD 2>/dev/null | sed 's/^/   | /'
git -C "$F/telemetry.git" ls-tree -r --name-only HEAD 2>/dev/null | grep -q 'node-shadow.ndjson'; chk $? "pushed folder holds node-shadow.ndjson"
git -C "$F/telemetry.git" ls-tree -r --name-only HEAD 2>/dev/null | grep -q 'telemetry-summary.json'; chk $? "pushed folder holds the engine telemetry export"
echo "== 3. --rollback-live"
sh "$IS" --rollback-live >"$F/rb.out" 2>&1; chk $? "--rollback-live exit 0"; [ -s "$F/rb.out" ] && tail -2 "$F/rb.out" | cut -c1-160 | sed 's/^/   | /'
SNAP1=$(snap); [ "$SNAP1" = "$SNAP0" ]; chk $? "settings.json byte-identical; config.toml and bin/ah-engine absent as before; CLI shows the original state; live marketplace gone"
[ "$SNAP1" = "$SNAP0" ] || { echo "--- before"; echo "$SNAP0"; echo "--- after"; echo "$SNAP1"; }
sh "$IS" --status 2>&1 | grep -q '^MODE: SHADOW'; chk $? "--status says MODE: SHADOW again"
[ ! -f "$F/.anti-hall/ah-engine-shadow2/live.conf" ]; chk $? "live.conf removed"
sh "$IS" --rollback-live >/dev/null 2>&1; [ $? -ne 0 ]; chk $? "second rollback refused (not live)"
echo "== 4. the real home was never written"
[ "$(realsha)" = "$REAL_BEFORE" ]; chk $? "real ~/.claude settings/plugins and ~/.anti-hall config unchanged"
echo; [ "$fails" = 0 ] && echo "ALL PASS" || echo "$fails FAILED"; echo "fake HOME kept at $F"
exit "$fails"
