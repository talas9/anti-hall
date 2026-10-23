#!/bin/sh
# Tests for engine-deploy.sh. Everything runs against a scratch HOME (fake ~/.claude, ~/.anti-hall, stub engine binaries): the
# real home, the real plugin roots and the live engine are never read or written. Run: sh scripts/engine-deploy.test.sh
set -u
HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
SCRIPT=$HERE/engine-deploy.sh
T=$(mktemp -d "${TMPDIR:-/tmp}/engine-deploy-test.XXXXXX") || exit 1
PASS=0; FAIL=0
ok() { # name, then a command whose success is the assertion
  n=$1; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); printf 'ok   %s\n' "$n"; else FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$n"; fi
}
has() { grep -q -- "$1" "$2"; }
hasnt() { ! grep -q -- "$1" "$2"; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# a stub engine: validates a plugin root the way the real binary does (refuses one lacking a key it reads); REQUIRES lists them
mk_engine() { # path, required keys
  cat >"$1" <<EOF
#!/bin/sh
# REQUIRES: $2
req=\$(sed -n 's/^# REQUIRES: //p' "\$0")
D=\${AH_ENGINE_DIR:-}
has_key() { grep -qs "^\\[\$2\\]" "\$1"/engine/defaults/*.toml "\$1"/engine/defaults.pristine/*.toml; }
missing() { for k in \$req; do has_key "\$1" "\$k" || { echo "\$k"; return 1; }; done; return 0; }
case \$1 in
  version) echo '{"version":"stub"}' ;;
  config) if [ "\$2" = validate ]; then m=\$(missing "\$AH_ENGINE_PLUGIN_ROOT") || { echo "ah-engine: defaults unavailable: missing_key key=\$m"; exit 70; }; echo ok
          else echo '{"last_error":null}'; fi ;;
  stop) if [ -e "\$D/daemon.run" ]; then kill "\$(cat "\$D/daemon.run")" 2>/dev/null; mv "\$D/daemon.run" "\$D/daemon.run.stopped"; fi; exit 0 ;;
  daemon) while [ -e "\$D/daemon.run" ]; do sleep 1; done ;;
  hook) alive=0; [ -s "\$D/daemon.run" ] && kill -0 "\$(cat "\$D/daemon.run")" 2>/dev/null && alive=1
        if [ \$alive -eq 0 ]; then sh "\$0" daemon </dev/null >/dev/null 2>&1 & echo \$! >"\$D/daemon.run"; fi
        if missing "\$CLAUDE_PLUGIN_ROOT" >/dev/null; then exit 2; fi
        echo fallback >>"\$D/defaults.events"; exit 0 ;;
  status) if [ -s "\$D/daemon.run" ] && kill -0 "\$(cat "\$D/daemon.run")" 2>/dev/null; then n=0; [ -f "\$D/defaults.events" ] && n=\$(wc -l <"\$D/defaults.events" | tr -d ' '); echo "{\"defaults\":{\"by_reason\":{},\"last\":null,\"total\":\${n:-0}},\"running\":true}"
          else echo '{"running":false}'; fi ;;
esac
EOF
  chmod +x "$1"
}
mk_root() { # dir: a plugin root with defaults, pristine, hook wrapper stub
  mkdir -p "$1/engine/defaults" "$1/engine/defaults.pristine" "$1/hooks"
  for d in defaults defaults.pristine; do
    printf '[index]\nvalue = 1\n' >"$1/engine/$d/index.toml"
    printf '[a.old]\nvalue = 1\n' >"$1/engine/$d/a.toml"
  done
  printf '[files.daemon_down_marker]\nvalue = "daemon.down.until"\n' | tee "$1/engine/defaults/engine.toml" >"$1/engine/defaults.pristine/engine.toml"
  cat >"$1/hooks/ah-hook.sh" <<'EOF'
#!/bin/sh
D=${AH_ENGINE_DIR:-$HOME/.anti-hall/ah-engine}
u=$(cat "$D/daemon.down.until" 2>/dev/null)
if [ -n "$u" ] && [ "$u" -gt $(( $(date +%s) * 1000 )) ] 2>/dev/null; then echo passthrough >>"$D/hold.passthrough"; exit 0; fi
exec "$HOME/.anti-hall/ah-engine/bin/ah-engine" hook "$@"
EOF
}
mk_new_defaults() { # dir, with-wire(1|0)
  mkdir -p "$1"
  printf '[index]\nvalue = 1\n' >"$1/index.toml"
  printf '[a.old]\nvalue = 2\n' >"$1/a.toml"
  printf '[files.daemon_down_marker]\nvalue = "daemon.down.until"\n' >"$1/engine.toml"
  [ "$2" = 1 ] && printf '[wire.ack]\nvalue = 1\n' >"$1/wire.toml"
  return 0
}
setup() { # fresh fake machine under $T/$1
  W=$T/$1; H=$W/home
  E=$H/.anti-hall/ah-engine
  MKT=$H/.anti-hall/ah-engine-live/state/marketplace/plugins/anti-hall
  CACHE=$H/.claude/plugins/cache/live/anti-hall/1
  mkdir -p "$E/bin" "$H/.claude/plugins"
  mk_engine "$E/bin/ah-engine" "a.old"
  cat >"$E/bin/ah-hook" <<'EOF'
#!/bin/sh
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
[ "$1 $2" = "integrity accept" ] && sha "$AH_ENGINE_DIR/bin/ah-engine" >"$AH_ENGINE_DIR/bin/ah-engine.expected"
exit 0
EOF
  chmod +x "$E/bin/ah-hook"
  mk_root "$MKT"; mk_root "$CACHE"
  printf '{\n "plugins": {\n  "anti-hall@other": [{"installPath": "%s/wrong"}],\n  "anti-hall@anti-hall-engine-live": [\n   {\n    "scope": "user",\n    "installPath": "%s",\n    "version": "1"\n   }\n  ]\n }\n}\n' "$H" "$CACHE" >"$H/.claude/plugins/installed_plugins.json"
  mkdir -p "$W/new"
  mk_engine "$W/new/ah-engine" "a.old wire.ack"
  mk_new_defaults "$W/new/defaults" 1
  OLDSHA=$(sha "$E/bin/ah-engine"); NEWSHA=$(sha "$W/new/ah-engine")
}
run() { # args...: the script against the scratch home only
  HOME=$H AH_DEPLOY_HOME=$H AH_DEPLOY_PROBE_N=2 AH_DEPLOY_CALL_TIMEOUT=3 AH_DEPLOY_STOP_WAIT_S=3 sh "$SCRIPT" "$@"
}
tree_sum() { find "$H" -type f -exec cksum {} + 2>/dev/null | sort | cksum; }

# --- 1. good path -----------------------------------------------------------------------------------------------------
setup good
run --check "$W/new/ah-engine" "$W/new/defaults" >"$W/check.out" 2>&1; rc=$?
ok "good: --check exits 0" test $rc -eq 0
ok "good: --check says OK" has "CHECK OK" "$W/check.out"
ok "good: --check shows the new binary refuses a root as-is (swap-first would break)" has "REFUSES" "$W/check.out"
ok "good: --check lists the added key" has "wire.ack" "$W/check.out"
ok "good: --check lists the changed value" has "value changes: \[a.old\]" "$W/check.out"
ok "good: --check found both roots" test "$(grep -c '^-- root' "$W/check.out")" -eq 2
ok "good: --check reads the installPath of the right key" has "$CACHE" "$W/check.out"
before=$(tree_sum)
ok "good: --check changed nothing" test "$before" = "$(tree_sum)"
run --deploy "$W/new/ah-engine" "$W/new/defaults" >"$W/dry.out" 2>&1; rc=$?
ok "good: --deploy without --yes exits 0" test $rc -eq 0
ok "good: --deploy without --yes is a dry run" has "dry run" "$W/dry.out"
ok "good: dry run changed nothing" test "$before" = "$(tree_sum)"
run --deploy "$W/new/ah-engine" "$W/new/defaults" --yes >"$W/deploy.out" 2>&1; rc=$?
ok "good: --deploy --yes exits 0" test $rc -eq 0
ok "good: --deploy reports OK" has "DEPLOY OK" "$W/deploy.out"
ok "good: live binary is the new one" test "$(sha "$E/bin/ah-engine")" = "$NEWSHA"
ok "good: old binary kept as .prev" test "$(sha "$E/bin/ah-engine.prev")" = "$OLDSHA"
ok "good: integrity record is the new sha" test "$(tr -d ' \n' <"$E/bin/ah-engine.expected")" = "$NEWSHA"
for r in "$MKT" "$CACHE"; do
  ok "good: defaults of $(basename "$r" | cut -c1-9)... have the new key" has "wire.ack" "$r/engine/defaults/wire.toml"
  ok "good: pristine has the new key too" has "wire.ack" "$r/engine/defaults.pristine/wire.toml"
  ok "good: the new a.toml is in" has "value = 2" "$r/engine/defaults/a.toml"
done
BK=$E/deploys/$(cat "$E/deploys/latest")
ok "good: replaced file kept in the backup" has "value = 1" "$BK/root1/defaults/a.toml"
ok "good: hold released at the end" test "$(cat "$E/daemon.down.until")" -le "$(( $(date +%s) * 1000 ))"
ok "good: keys were synced before the binary was swapped" test "$(grep -n ' stage defaults into root 2' "$BK/deploy.log" | head -n 1 | cut -d: -f1)" -lt "$(grep -n 'commit: rename' "$BK/deploy.log" | cut -d: -f1)"
ok "good: the engine was stopped before the sync" test "$(grep -n ' stop the engine$' "$BK/deploy.log" | head -n 1 | cut -d: -f1)" -lt "$(grep -n ' stage defaults into root 1' "$BK/deploy.log" | head -n 1 | cut -d: -f1)"
ok "good: probe verified" has "force-push probe blocked 2/2" "$BK/deploy.log"
ok "good: defaults.total delta 0 verified" has "defaults.total delta 0" "$BK/deploy.log"
ok "good: running daemon verified as the new binary" has "executes the new binary" "$BK/deploy.log"
ok "good: staging (all roots + binary) precedes the one commit pass, which precedes the swap-done line" test "$(grep -n 'stage the binary' "$BK/deploy.log" | cut -d: -f1)" -lt "$(grep -n 'commit: rename' "$BK/deploy.log" | cut -d: -f1)" -a "$(grep -n 'commit: rename' "$BK/deploy.log" | cut -d: -f1)" -lt "$(grep -n 'swap done' "$BK/deploy.log" | cut -d: -f1)"
ok "good: no staged temp file is left behind" test -z "$(find "$MKT" "$CACHE" "$E/bin" -name '*.deploy.*' -o -name '*.new.*' 2>/dev/null)"
ok "good: stopped twice" test "$(grep -c "stop the engine" "$BK/deploy.log")" -eq 2
ok "good: no defaults.error written" test ! -e "$E/defaults.error"

# --- 4. rollback (on the good deploy) -------------------------------------------------------------------------------
after=$(tree_sum)
run --rollback >"$W/rbdry.out" 2>&1; rc=$?
ok "rollback: without --yes exits 0 and changes nothing" test $rc -eq 0 -a "$after" = "$(tree_sum)"
run --rollback --yes >"$W/rb.out" 2>&1; rc=$?
ok "rollback: --yes exits 0" test $rc -eq 0
ok "rollback: reports OK" has "ROLLBACK OK" "$W/rb.out"
ok "rollback: binary is the old one again" test "$(sha "$E/bin/ah-engine")" = "$OLDSHA"
ok "rollback: integrity record is the old sha" test "$(tr -d ' \n' <"$E/bin/ah-engine.expected")" = "$OLDSHA"
for r in "$MKT" "$CACHE"; do
  ok "rollback: a.toml is back to the old value" has "value = 1" "$r/engine/defaults/a.toml"
  ok "rollback: the file the deploy added is gone from the root" test ! -e "$r/engine/defaults/wire.toml"
done
ok "rollback: the added file was moved aside, not deleted" test -n "$(find "$BK"/rollback-* -name wire.toml 2>/dev/null)"

# --- 2. missing key ---------------------------------------------------------------------------------------------------
setup missing
mv "$W/new/defaults/wire.toml" "$W/new/wire.toml.moved"       # the new binary needs wire.ack, the new defaults do not have it
run --check "$W/new/ah-engine" "$W/new/defaults" >"$W/check.out" 2>&1; rc=$?
ok "missing key: --check exits non-zero" test $rc -ne 0
ok "missing key: --check names the key" has "wire.ack" "$W/check.out"
ok "missing key: --check says FAILED" has "CHECK FAILED" "$W/check.out"
before=$(tree_sum)
run --deploy "$W/new/ah-engine" "$W/new/defaults" --yes >"$W/deploy.out" 2>&1; rc=$?
ok "missing key: --deploy --yes refuses" test $rc -ne 0
ok "missing key: nothing changed" test "$before" = "$(tree_sum)"
ok "missing key: no backup dir was created" test ! -e "$E/deploys"

# --- 3. extra key (live-only, e.g. launcher keys) -------------------------------------------------------------------
setup extra
for r in "$MKT" "$CACHE"; do for d in defaults defaults.pristine; do printf '[launcher.only]\nvalue = 5\n' >>"$r/engine/$d/a.toml"; done; done
run --check "$W/new/ah-engine" "$W/new/defaults" >"$W/check.out" 2>&1; rc=$?
ok "extra key: --check exits non-zero" test $rc -ne 0
ok "extra key: --check names the key the sync would drop" has "DROPPED by the sync: \[launcher.only\]" "$W/check.out"
run --check "$W/new/ah-engine" "$W/new/defaults" --allow-drop >"$W/check2.out" 2>&1; rc=$?
ok "extra key: --allow-drop accepts it" test $rc -eq 0
before=$(tree_sum)
run --deploy "$W/new/ah-engine" "$W/new/defaults" --yes >"$W/deploy.out" 2>&1; rc=$?
ok "extra key: --deploy --yes without --allow-drop refuses and changes nothing" test $rc -ne 0 -a "$before" = "$(tree_sum)"

# --- 5. a guard failing open in the cache root is caught -------------------------------------------------------------
setup failopen
printf '#!/bin/sh\nexit 0\n' >"$CACHE/hooks/ah-hook.sh"       # the root Claude runs lets the force-push through
run --deploy "$W/new/ah-engine" "$W/new/defaults" --yes >"$W/deploy.out" 2>&1; rc=$?
ok "fail-open: the deploy reports failure" test $rc -ne 0
ok "fail-open: the probe failure is named" has "force-push probe blocked 0/2" "$W/deploy.out"
ok "fail-open: the exact rollback command is printed" has "engine-deploy.sh --rollback --from" "$W/deploy.out"

# --- 6. a hook arriving mid-deploy (the 2026-10-22 race) ---------------------------------------------------------------
win() { # a hook through the cache root, then log whether it started a daemon
  printf 'sh "%s/hooks/ah-hook.sh" PreToolUse </dev/null >/dev/null 2>&1; if [ -s "$AH_ENGINE_DIR/daemon.run" ]; then echo "started-$AH_DEPLOY_WINDOW-$(cat "$AH_ENGINE_DIR/daemon.run")" >>"%s/window.log"; else echo "held-$AH_DEPLOY_WINDOW" >>"%s/window.log"; fi' "$CACHE" "$W" "$W"
}
setup race
WCMD=$(win)
AH_DEPLOY_WINDOW_CMD=$WCMD run --deploy "$W/new/ah-engine" "$W/new/defaults" --yes >"$W/deploy.out" 2>&1; rc=$?
BK=$E/deploys/$(cat "$E/deploys/latest")
ok "race+hold: deploy OK" test $rc -eq 0
ok "race+hold: the hook in the stop window started nothing" has "held-stop" "$W/window.log"
ok "race+hold: the hook after the swap started nothing" has "held-swap" "$W/window.log"
ok "race+hold: no hook started an engine inside the window" hasnt "started" "$W/window.log"
ok "race+hold: the hook passed through (hold seen by the launcher)" test "$(wc -l <"$E/hold.passthrough" | tr -d ' ')" -ge 2
ok "race+hold: the daemon at the end runs the new binary" has "executes the new binary" "$BK/deploy.log"
ok "race+hold: hold released" test "$(cat "$E/daemon.down.until")" -le "$(( $(date +%s) * 1000 ))"
ok "race+hold: a hook now starts the engine again" sh -c "HOME='$H' AH_ENGINE_DIR='$E' sh '$CACHE/hooks/ah-hook.sh' PreToolUse </dev/null >/dev/null 2>&1; kill -0 \$(cat '$E/daemon.run')"
run --rollback --yes >/dev/null 2>&1

# control: no hold (TTL 0): the old binary IS started in the window; the second stop must still leave only the new daemon
setup nohold
WCMD=$(win)
AH_DEPLOY_HOLD_TTL_S=0 AH_DEPLOY_WINDOW_CMD=$WCMD run --deploy "$W/new/ah-engine" "$W/new/defaults" --yes >"$W/deploy.out" 2>&1; rc=$?
BK=$E/deploys/$(cat "$E/deploys/latest")
oldpid=$(sed -n 's/^started-stop-//p' "$W/window.log" | head -n 1)
ok "race, no hold: the old binary was started in the window (test is meaningful)" test -n "$oldpid"
ok "race, no hold: deploy still OK" test $rc -eq 0
ok "race, no hold: the old daemon is dead" sh -c "! kill -0 $oldpid"
ok "race, no hold: the daemon now is another pid" test "$(cat "$E/daemon.run")" != "$oldpid"
ok "race, no hold: the running daemon is verified as the new binary" has "executes the new binary" "$BK/deploy.log"
ok "race, no hold: the second stop is logged" has "stop the engine again" "$BK/deploy.log"
run --rollback --yes >/dev/null 2>&1

# a deploy that crashes leaves the hold, and it expires by itself
setup crash
AH_DEPLOY_HOLD_TTL_S=2 AH_DEPLOY_WINDOW_CMD='kill -9 $AH_DEPLOY_PID' run --deploy "$W/new/ah-engine" "$W/new/defaults" --yes >"$W/deploy.out" 2>&1; rc=$?
ok "crash: the deploy died" test $rc -ne 0
ok "crash: the hold is still up right after (guards pass through)" test "$(cat "$E/daemon.down.until")" -gt "$(( $(date +%s) * 1000 ))"
ok "crash: the hold is at most TTL ahead" test "$(cat "$E/daemon.down.until")" -le "$(( ($(date +%s) + 3) * 1000 ))"
sleep 3
ok "crash: the hold expired on its own" test "$(cat "$E/daemon.down.until")" -le "$(( $(date +%s) * 1000 ))"
ok "crash: a hook starts the engine after the expiry" sh -c "HOME='$H' AH_ENGINE_DIR='$E' sh '$CACHE/hooks/ah-hook.sh' PreToolUse </dev/null >/dev/null 2>&1; kill -0 \$(cat '$E/daemon.run')"

# the hold lapses mid-deploy (TTL shorter than one step): the hook gets through, the deploy still ends clean
setup lapse
WCMD="sleep 3; $(win)"
AH_DEPLOY_HOLD_TTL_S=1 AH_DEPLOY_WINDOW_CMD=$WCMD run --deploy "$W/new/ah-engine" "$W/new/defaults" --yes >"$W/deploy.out" 2>&1; rc=$?
ok "lapse: the expired hold lets the hook start the old binary" has "started-stop" "$W/window.log"
ok "lapse: the deploy still ends with the new daemon" test $rc -eq 0
run --rollback --yes >/dev/null 2>&1

# a root rewritten after the swap (an old daemon rewriting a defaults file) is repaired by the re-sync
setup resync
AH_DEPLOY_WINDOW_CMD='[ "$AH_DEPLOY_WINDOW" = swap ] && printf "[a.old]\nvalue = 9\n" >"'"$CACHE"'/engine/defaults/a.toml"' run --deploy "$W/new/ah-engine" "$W/new/defaults" --yes >"$W/deploy.out" 2>&1; rc=$?
BK=$E/deploys/$(cat "$E/deploys/latest")
ok "resync: deploy OK" test $rc -eq 0
ok "resync: the rewritten file is back to the new value" has "value = 2" "$CACHE/engine/defaults/a.toml"
ok "resync: the rewritten file was kept in resync/" has "value = 9" "$BK/resync/root2/defaults/a.toml"
ok "resync: roots identical" diff -rq -x '*.bak*' "$MKT/engine/defaults" "$CACHE/engine/defaults"

# stale history in the counters neither fails nor passes the check
setup stale
for n in 1 2 3 4 5; do echo fallback >>"$E/defaults.events"; done
run --deploy "$W/new/ah-engine" "$W/new/defaults" --yes >"$W/deploy.out" 2>&1; rc=$?
BK=$E/deploys/$(cat "$E/deploys/latest")
ok "stale counter: deploy OK despite 5 old fallbacks" test $rc -eq 0
ok "stale counter: judged as a delta" has "defaults.total delta 0" "$BK/deploy.log"
run --rollback --yes >/dev/null 2>&1

# --- 7. whole plugin tree -----------------------------------------------------------------------------------------------
setup tree
NR=$W/newroot
mk_root "$NR"; mk_new_defaults "$NR/engine/defaults" 1; mk_new_defaults "$NR/engine/defaults.pristine" 1
printf '# v2\n' >>"$NR/hooks/ah-hook.sh"
mkdir -p "$NR/engine/logic" "$NR/skills/s"; echo 'logic v2' >"$NR/engine/logic/x.js"; echo skill >"$NR/skills/s/SKILL.md"
echo keep >"$CACHE/hooks/local-only.sh"
run --check "$W/new/ah-engine" "$NR" >"$W/check.out" 2>&1
ok "tree: --check names the scope" has "scope: tree" "$W/check.out"
ok "tree: --check counts the tree files" has "plugin tree: .* file(s) change" "$W/check.out"
before=$(tree_sum)
run --deploy "$W/new/ah-engine" "$NR" >"$W/dry.out" 2>&1
ok "tree: dry run changes nothing" test "$before" = "$(tree_sum)"
run --deploy "$W/new/ah-engine" "$NR" --yes >"$W/deploy.out" 2>&1; rc=$?
BK=$E/deploys/$(cat "$E/deploys/latest")
ok "tree: deploy OK" test $rc -eq 0
for r in "$MKT" "$CACHE"; do
  ok "tree: hooks synced into $(basename "$r" | cut -c1-9)" has "# v2" "$r/hooks/ah-hook.sh"
  ok "tree: engine/logic synced" has "logic v2" "$r/engine/logic/x.js"
  ok "tree: skills synced" test -f "$r/skills/s/SKILL.md"
done
ok "tree: a file only the live root has is kept (no deletes)" test -f "$CACHE/hooks/local-only.sh"
ok "tree: the replaced wrapper is in the backup" hasnt "# v2" "$BK/root1/tree/hooks/ah-hook.sh"
run --rollback --yes >"$W/rb.out" 2>&1
ok "tree: rollback restores the wrapper" hasnt "# v2" "$CACHE/hooks/ah-hook.sh"
ok "tree: rollback moves the added file aside" test ! -e "$CACHE/engine/logic/x.js"
run --check "$W/new/ah-engine" "$NR" --scope defaults >"$W/check.out" 2>&1
ok "tree: --scope defaults is honoured" has "scope: defaults" "$W/check.out"
run --check "$W/new/ah-engine" "$W/new/defaults" --scope tree >"$W/check.out" 2>&1; rc=$?
ok "tree: --scope tree on a bare defaults dir refuses" test $rc -ne 0

# --- 8. Node backup tree (sibling of each root, at nodeback.node_dir) ------------------------------------------------------
setup node
NR=$W/newroot/plugins/anti-hall; NN=$W/newroot/plugins/anti-hall-node
mk_root "$NR"; mk_new_defaults "$NR/engine/defaults" 1; mk_new_defaults "$NR/engine/defaults.pristine" 1
printf '[nodeback.node_dir]\nvalue = "../anti-hall-node"\n' | tee "$NR/engine/defaults/nodeback.toml" >"$NR/engine/defaults.pristine/nodeback.toml"
mkdir -p "$NN/hooks"; echo 'node hook v2' >"$NN/hooks/g.js"
mkdir -p "$MKT/../anti-hall-node/hooks"; echo 'node hook v1' >"$MKT/../anti-hall-node/hooks/g.js"
run --check "$W/new/ah-engine" "$NR" >"$W/check.out" 2>&1
ok "node: --check reports the node backup tree" has "node backup tree" "$W/check.out"
before=$(tree_sum)
run --deploy "$W/new/ah-engine" "$NR" >"$W/dry.out" 2>&1
ok "node: dry run changes nothing" test "$before" = "$(tree_sum)"
ok "node: the plan names the node tree" has "Node backup tree" "$W/dry.out"
run --deploy "$W/new/ah-engine" "$NR" --yes >"$W/deploy.out" 2>&1; rc=$?
BK=$E/deploys/$(cat "$E/deploys/latest")
ok "node: deploy OK" test $rc -eq 0
ok "node: marketplace sibling updated" has "node hook v2" "$MKT/../anti-hall-node/hooks/g.js"
ok "node: cache-root sibling created" has "node hook v2" "$CACHE/../anti-hall-node/hooks/g.js"
ok "node: the replaced node file is in the backup" has "node hook v1" "$BK/root1/node/hooks/g.js"
run --rollback --yes >"$W/rb.out" 2>&1
ok "node: rollback restores the replaced node file" has "node hook v1" "$MKT/../anti-hall-node/hooks/g.js"
ok "node: rollback moves the added node file aside" test ! -e "$CACHE/../anti-hall-node/hooks/g.js"

# --- 9. launcher verify: a generated launcher whose script is gone fails the deploy -------------------------------------------
setup launcher
mkdir -p "$H/.anti-hall/bin"
printf '// AUTO-GENERATED by anti-hall (test)\nconsole.log("ok");\n' >"$H/.anti-hall/bin/devswarm.js"
run --deploy "$W/new/ah-engine" "$W/new/defaults" --yes >"$W/deploy.out" 2>&1; rc=$?
BK=$E/deploys/$(cat "$E/deploys/latest")
ok "launcher: a working launcher passes the deploy" test $rc -eq 0
ok "launcher: the verify step ran it" has "launcher .*devswarm.js reaches its script" "$BK/deploy.log"
run --rollback --yes >/dev/null 2>&1
setup launcherbad
mkdir -p "$H/.anti-hall/bin"
printf '// AUTO-GENERATED by anti-hall (test)\nrequire("/nonexistent-anti-hall-node/scripts/devswarm.js");\n' >"$H/.anti-hall/bin/devswarm.js"
run --deploy "$W/new/ah-engine" "$W/new/defaults" --yes >"$W/deploy.out" 2>&1; rc=$?
ok "launcher: a launcher with a missing target fails the deploy" test $rc -ne 0
ok "launcher: the failure names the launcher" has "verify FAILED: launcher .*devswarm.js cannot reach its script" "$W/deploy.out"

# --- window: the OLD binary reading the NEW defaults ------------------------------------------------------------------------
setup window
run --check "$W/new/ah-engine" "$W/new/defaults" >"$W/check.out" 2>&1
ok "window: an additive release misses no key in the window" has "old (live) binary on this root AFTER the sync: loads, misses no key" "$W/check.out"
printf '[a.renamed]\nvalue = 2\n' >"$W/new/defaults/a.toml"
mk_engine "$W/new/ah-engine" "a.renamed wire.ack"
run --check "$W/new/ah-engine" "$W/new/defaults" --allow-drop >"$W/check.out" 2>&1; rc=$?
ok "window: a renamed key is reported, not failed (informational)" test $rc -eq 0
ok "window: names the old binary's missed key" has "defaults/a.toml \[a.old\]" "$W/check.out"
ok "window: says it WILL log defaults_fallback" has "WINDOW: the old (live) binary" "$W/check.out"
ok "window: the old binary's own refusal is quoted" has "refuses: ah-engine: defaults unavailable: missing_key" "$W/check.out"
ok "window: summary line counts the keys per root" has "WINDOW SUMMARY: 4 key(s)" "$W/check.out"
before=$(tree_sum)
ok "window: --check changed nothing" test "$before" = "$(tree_sum)"

for f in $(find "$T" -name daemon.run 2>/dev/null); do kill "$(cat "$f")" 2>/dev/null; done
printf '\n%s passed, %s failed (scratch: %s)\n' "$PASS" "$FAIL" "$T"
[ "$FAIL" -eq 0 ]
