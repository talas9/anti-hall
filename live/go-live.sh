#!/bin/sh
# go-live.sh [<comma-separated entry ids | all-agreeing | none>] [--dry-run]     (default: all-agreeing)
# Switches this machine from "Node hooks decide, engine shadows" to "engine decides per check, Node as fallback", and adds the
# reverse witness (node-shadow.sh: Node runs silently beside the engine and logs what it would have decided).
# Reversible with rollback.sh (byte-identical restore). Read README.md for the exact effect and the safety properties.
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/lib.sh"
need_node
arg=; dry=0
for a in "$@"; do case "$a" in --dry-run) dry=1 ;; *) arg=$a ;; esac; done
[ -n "$arg" ] || arg=all-agreeing
ENG=$BUNDLE/ah-engine
[ -x "$ENG" ] || die "bundled engine missing: $ENG"
[ -f "$BUNDLE/plugin/hooks/hooks.json" ] || die "bundled plugin missing"
[ -f "$BUNDLE_ROOT/engine/defaults/index.toml" ] || die "bundled plugin has no engine/defaults/index.toml (stage-5 engine reads its defaults from the plugin)"
# a plugin-shipped ah-engine.lock makes ah-hook.sh run ah-engine-bootstrap.sh on SessionStart, which would replace the bundled binary
# with a release download: the kit could then no longer say which engine is live, and rollback would see bin/ah-engine as edited
[ ! -e "$BUNDLE_ROOT/ah-engine.lock" ] || die "bundled plugin ships ah-engine.lock (the bootstrap would replace the bundled engine); rebuild bundle/ without it"
PVER=$(node -p 'require(process.argv[1]).version' "$BUNDLE/plugin/.claude-plugin/plugin.json") || die "cannot read bundled plugin version"

# --- preflight (nothing is changed until all of this passes) -----------------------------------------------------------
# the bundled hooks.json must be the thin-trigger form: every command is the wrapper, so no Node hook is registered directly
node -e '
  const h=require(process.argv[1]).hooks; let n=0, bad=[];
  for (const [ev,g] of Object.entries(h)) for (const m of g) for (const x of m.hooks) { n++; if(!/hooks\/ah-hook\.sh"? /.test(x.command)) bad.push(ev+": "+x.command); }
  if (bad.length||!n) { console.error("bundled hooks.json is not all thin triggers:\n"+bad.join("\n")); process.exit(1); }' "$BUNDLE/plugin/hooks/hooks.json" || die "bundled plugin would double-run Node hooks"
[ -f "$SETTINGS" ] && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$SETTINGS" || die "cannot read/parse $SETTINGS"
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || die "claude CLI not found ($CLAUDE_BIN); set AH_LIVE_CLAUDE"
if [ ! -f "$LIVE_JSON" ]; then
  ORIGS=$(orig_list)    # enabled anti-hall@* installs to switch off (empty is fine: a machine that only ran the shadow)
  [ "$(plugin_state "$LIVE_KEY" | cut -f1)" = absent ] || die "$LIVE_KEY is already installed but the kit is not live; remove it first (claude plugin uninstall $LIVE_KEY)"
fi
TBL=$(mktemp) || die mktemp; ON=$(mktemp); OFF=$(mktemp); trap 'rm -f "$TBL" "$ON" "$OFF" "$CAND"' 0
CAND=
entry_table "$ENG" >"$TBL" || die "engine could not print its dispatch table"
[ -s "$TBL" ] || die "empty dispatch table"

# --- resolve the argument into: guard entries the engine decides (ON) and guard entries left to Node (OFF) ---------------
if [ "$arg" = "all-agreeing" ]; then
  [ -s "$AGREE_FILE" ] || die "all-agreeing needs shadow comparison evidence: $AGREE_FILE is missing or empty"
  case "$AGREE_FILE" in
  *.txt) AGREED=$(grep -v '^#' "$AGREE_FILE" | tr -d ' ' | grep . | tr '\n' ',' | sed 's/,$//') ;;
  *) AGREED=$(node -e '
    const rows=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch(e){return null}}).filter(Boolean);
    // key = "<Event>/<check>" when the row names its event (ev), else "PreToolUse/<check>" (the older comparison replayed PreToolUse only)
    const by={}; for(const r of rows){ const k=(r.ev||"PreToolUse")+"/"+r.check; (by[k]=by[k]||{n:0,bad:0}).n++; if(r.verdict!=="same") by[k].bad++; }
    console.log(Object.keys(by).filter(k=>by[k].n>0&&by[k].bad===0).join(","));' "$AGREE_FILE") ;;
  esac
  [ -n "$AGREED" ] || die "no check has an all-same comparison record in $AGREE_FILE"
  # a check is promoted only on the event it was compared on (Event/check); a check with any non-"same" row is never promoted
  awk -F'\t' -v agreed=",$AGREED," '$4==1 && $3!="" && index(agreed, "," $1 "/" $3 ",") {print $1 "\t" $2}' "$TBL" >"$ON"
elif [ "$arg" = "none" ]; then
  : >"$ON"
else
  : >"$ON"
  oldifs=$IFS; IFS=,; set -- $arg; IFS=$oldifs
  for want in "$@"; do
    want=$(printf '%s' "$want" | tr -d ' ')
    found=$(awk -F'\t' -v w="$want" '{b=$2; sub(/#[0-9]+$/,"",b)} (b==w || $2==w) {print $1 "\t" $2 "\t" $3}' "$TBL")
    [ -n "$found" ] || die "unknown entry id: $want (see: status.sh --table)"
    printf '%s\n' "$found" | awk -F'\t' '$3=="" {exit 3} {print $1 "\t" $2}' >>"$ON"
    [ $? -eq 0 ] || die "$want has no engine check (Node-only hook); nothing to switch"
  done
fi
# OFF = every guard entry with a check that is not in ON
awk -F'\t' 'NR==FNR {on[$1 "\t" $2]=1; next} $4==1 && $3!="" && !(($1 "\t" $2) in on) {print $1 "\t" $2}' "$ON" "$TBL" >"$OFF"
NON=$(awk -F'\t' '$4==0 && $3!=""' "$TBL" | wc -l | tr -d ' ')
note "engine decides (guard entries): $(wc -l <"$ON" | tr -d ' ')   Node keeps deciding (guard entries, config off): $(wc -l <"$OFF" | tr -d ' ')   non-guard entries with a check (always engine-first, Node on defer): $NON"
sed 's/^/  ON  /' "$ON"; sed 's/^/  OFF /' "$OFF"

# --- candidate config.toml (existing content kept; only the managed block is replaced) ------------------------------------
CAND=$(mktemp)
[ -f "$CONFIG_TOML" ] && awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b {skip=1; next} $0==e {skip=0; next} !skip {print}' "$CONFIG_TOML" >"$CAND"
{ [ -s "$CAND" ] && echo; echo "$MARK_BEGIN"; awk -F'\t' '{printf "[entries.\"%s/%s\"]\nmode = \"off\"\n", $1, $2}' "$OFF"; echo "$MARK_END"; } >>"$CAND"
VS=$(mktemp -d); trap 'rm -rf "$VS"; rm -f "$TBL" "$ON" "$OFF" "$CAND"' 0
HOME=$VS AH_ENGINE_DIR=$VS/st AH_ENGINE_PLUGIN_ROOT=$BUNDLE_ROOT "$ENG" config validate "$CAND" >/dev/null 2>&1 || { HOME=$VS AH_ENGINE_DIR=$VS/st AH_ENGINE_PLUGIN_ROOT=$BUNDLE_ROOT "$ENG" config validate "$CAND" >&2; die "the engine rejects the generated config; nothing was changed"; }
if [ "$dry" = 1 ]; then
  note "== plan (dry run; nothing below is applied)"
  if [ -f "$LIVE_JSON" ]; then
    note "already live: only the managed block of $CONFIG_TOML would be rewritten (sha $(sha "$CONFIG_TOML" | cut -c1-12) -> $(sha "$CAND" | cut -c1-12))"
  else
    note "0 back up to $STATE/backup/: $SETTINGS (sha $(sha "$SETTINGS" | cut -c1-12))$([ -f "$CONFIG_TOML" ] && echo ", $CONFIG_TOML")$([ -e "$LIVE_ENGINE_BIN" ] && echo ", $LIVE_ENGINE_BIN"); ledger $LIVE_JSON"
    note "1 engine binary: $LIVE_ENGINE_BIN  $(sha "$LIVE_ENGINE_BIN" | cut -c1-12) -> $(sha "$ENG" | cut -c1-12) (bundle)"
    note "2 $CONFIG_TOML ($([ -f "$CONFIG_TOML" ] && echo "exists, sha $(sha "$CONFIG_TOML" | cut -c1-12); content outside the managed block kept" || echo "created")): managed block with $(wc -l <"$OFF" | tr -d " ") guard entries mode=\"off\""
    note "3 local marketplace $LIVE_MKT at $MKT_DIR (plugins/anti-hall = bundle/plugin $PVER), checked with: $CLAUDE_BIN plugin validate"
    note "4 $CLAUDE_BIN plugin marketplace add $MKT_DIR ; $CLAUDE_BIN plugin install $LIVE_KEY   (CLI writes installed_plugins.json, known_marketplaces.json, the plugin cache, settings.json enabledPlugins/extraKnownMarketplaces)"
    note "5 $CLAUDE_BIN plugin disable --scope user: ${ORIGS:-(no enabled anti-hall install to disable)}" 
    note "6 remove $(count_shadow) shadow triggers ($SHADOW_MARKS) from $SETTINGS; add the node-shadow hook (Node as silent witness) for every plugin event"
    [ -f "$SHADOW2/.shadow2-installed" ] && note "7b stop the shadow2 daemon/updater ($SHADOW2: triggers gone, nothing restarts them); its telemetry sync keeps running from the live engine (live.conf), now including the node-shadow log"
    if [ -f "$ENGINE_DIR/daemon.run" ] && kill -0 "$(cat "$ENGINE_DIR/daemon.run" 2>/dev/null)" 2>/dev/null; then
      note "7 stop the running daemon on $ENGINE_DIR (pid $(cat "$ENGINE_DIR/daemon.run"): $(ps -p "$(cat "$ENGINE_DIR/daemon.run")" -o command= 2>/dev/null | cut -c1-80)); the next hook call cold-starts the bundled build"
    else note "7 no daemon running on $ENGINE_DIR (nothing to stop)"; fi
    note "8 verify via $CLAUDE_BIN plugin list --json: $LIVE_KEY enabled at $PVER, the other anti-hall installs disabled; any failure -> automatic rollback"
  fi
  note "--- candidate managed block:"; awk -v b="$MARK_BEGIN" "\$0==b {on=1} on {print}" "$CAND" | sed "s/^/    /"
  note "dry run: config validated by the bundled engine, nothing changed"; exit 0
fi

# --- apply -------------------------------------------------------------------------------------------------------------------
DIE_CODE=E_STATE_UNWRITABLE
mkdir -p "$STATE" "$ENGINE_DIR" 2>/dev/null && [ -w "$STATE" ] && [ -w "$ENGINE_DIR" ] || die "cannot write $STATE or $ENGINE_DIR (disk full or read-only?); nothing was changed"
DIE_CODE=
if [ -f "$LIVE_JSON" ]; then
  # the ledger is a record of what go-live did, not the state of the machine: the owner may have unblocked by hand-editing settings.json
  # (original back on, live off) or uninstalled the live plugin. Check the host's own view (the CLI) and reconcile before re-applying.
  _ls=$(plugin_state "$LIVE_KEY" | cut -f1); _ol=$(orig_list)
  if [ "$_ls" = absent ]; then die "the ledger says live but $LIVE_KEY is not installed (removed by hand?). Run: sh $KIT/rollback.sh, then go-live again"; fi
  if [ "$_ls" != enabled ] || [ -n "$_ol" ]; then
    note "DRIFT: the ledger says live, but the host has $LIVE_KEY ${_ls}$([ -n "$_ol" ] && echo " and enabled: $(printf '%s' "$_ol" | cut -f1 | tr '\n' ' ')") (edited by hand?). Reconciling to live."
    klog W_DRIFT_RECONCILED "live=$_ls origs_enabled=$(printf '%s' "$_ol" | cut -f1 | tr '\n' ' ')"
    [ "$_ls" = enabled ] || cc plugin enable "$LIVE_KEY" --scope user >/dev/null || die "cannot re-enable $LIVE_KEY (see $STATE/kit.log); nothing else was changed"
    for _k in $(printf '%s\n' "$_ol" | cut -f1); do cc plugin disable "$_k" --scope user >/dev/null || die "cannot disable $_k (see $STATE/kit.log)"; done
  fi
  note "already live: re-applying only the per-check config (settings/plugin/binary were switched on first go-live)"
  node -e '
    const fs=require("fs"),j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const rows=f=>fs.readFileSync(f,"utf8").split("\n").filter(Boolean);
    j.arg=process.argv[4]; j.on=rows(process.argv[2]); j.off=rows(process.argv[3]).map(x=>x.replace("\t","/")); j.reapplied=new Date().toISOString();
    fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\n");' "$LIVE_JSON" "$ON" "$OFF" "$arg"
  cp "$CAND" "$CONFIG_TOML" || die "cannot write $CONFIG_TOML"
  node -e '
    const fs=require("fs"),j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); j.files.config.sha_after=process.argv[3]; fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\n")' "$LIVE_JSON" x "$(sha "$CONFIG_TOML")"
  note "done (re-applied)"; exit 0
fi

BK=$STATE/backup; mkdir -p "$BK" 2>/dev/null || { DIE_CODE=E_STATE_UNWRITABLE; die "cannot create $BK; nothing was changed"; }
# record "before" for every file the kit touches itself, and back up the ones that exist
cp -p "$SETTINGS" "$BK/settings.json" || die "backup failed"
CFG_EXISTED=0; [ -f "$CONFIG_TOML" ] && { CFG_EXISTED=1; cp -p "$CONFIG_TOML" "$BK/config.toml"; }
BIN_EXISTED=0; [ -e "$LIVE_ENGINE_BIN" ] && { BIN_EXISTED=1; cp -p "$LIVE_ENGINE_BIN" "$BK/ah-engine.bin"; }
ORIGS="$ORIGS" node -e '
  const [live,settings,cfg,bin,cfgE,binE,sS,sC,sB,arg,eng,pver]=process.argv.slice(1);
  const f=(path,existed,before)=>({path,existed:existed==="1",sha_before:before,sha_after:null});
  const j={started:new Date().toISOString(),arg,engine_sha:eng,origs:(process.env.ORIGS||"").split("\n").filter(Boolean).map(l=>{const [key,version]=l.split("\t");return {key,version}}),live:{key:"'$LIVE_KEY'",marketplace:"'$LIVE_MKT'",version:pver},
    files:{settings:Object.assign(f(settings,"1",sS),{backup:"backup/settings.json"}),
      config:Object.assign(f(cfg,cfgE,sC),{backup:cfgE==="1"?"backup/config.toml":null}),bin:Object.assign(f(bin,binE,sB),{backup:binE==="1"?"backup/ah-engine.bin":null})},complete:false};
  require("fs").writeFileSync(live,JSON.stringify(j,null,2)+"\n");' "$LIVE_JSON" "$SETTINGS" "$CONFIG_TOML" "$LIVE_ENGINE_BIN" "$CFG_EXISTED" "$BIN_EXISTED" \
  "$(sha "$SETTINGS")" "$(sha "$CONFIG_TOML")" "$(sha "$LIVE_ENGINE_BIN")" "$arg" "$(sha "$ENG")" "$PVER" || die "cannot write $LIVE_JSON"

# The Mac log-only shadow trigger (machine-local shadow-all.sh) is still wired into sessions that started before go-live and runs the OLD engine
# binary against the default state dir, which is the live engine's: it would write into the live telemetry/state. Neutralise it (backup first;
# rollback puts it back byte-identical). Removing the settings.json triggers alone does not reach those running sessions.
OLDSH=$HOME/.anti-hall/ah-engine-shadow/shadow-all.sh
if [ -f "$OLDSH" ]; then
  cp -p "$OLDSH" "$BK/shadow-all.sh" || die "backup of $OLDSH failed; nothing was changed"
  node -e '
    const fs=require("fs"),j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    j.files.shadowall={path:process.argv[2],existed:true,sha_before:process.argv[3],sha_after:null,backup:"backup/shadow-all.sh"};
    fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\n");' "$LIVE_JSON" "$OLDSH" "$(sha "$OLDSH")" || die "cannot write $LIVE_JSON"
fi

apply() {
  # 1 engine binary where ah-hook.sh looks for it
  mkdir -p "$(dirname "$LIVE_ENGINE_BIN")" && cp "$ENG" "$LIVE_ENGINE_BIN.new" && chmod 755 "$LIVE_ENGINE_BIN.new" && mv "$LIVE_ENGINE_BIN.new" "$LIVE_ENGINE_BIN" || return 1
  # 2 per-check config (guard entries not promoted keep Node as their decider)
  cp "$CAND" "$CONFIG_TOML" || return 1
  # 3 a local marketplace built from the bundle (distinct name, so the real "anti-hall" marketplace and its install are untouched)
  if [ -e "$MKT_DIR" ]; then mkdir -p "$STATE/old" && mv "$MKT_DIR" "$STATE/old/marketplace-$(date +%Y%m%d-%H%M%S)" || return 1; fi
  mkdir -p "$MKT_DIR/.claude-plugin" "$MKT_DIR/plugins" && cp -R "$BUNDLE/plugin" "$MKT_DIR/plugins/anti-hall" || return 1
  node -e '
    const m={name:process.argv[2],owner:{name:"ah-engine-live"},description:"Engine-first anti-hall build (local, from ah-engine-live/bundle)",
      plugins:[{name:"anti-hall",source:"./plugins/anti-hall",description:"anti-hall with the thin engine triggers"}]};
    require("fs").writeFileSync(process.argv[1]+"/.claude-plugin/marketplace.json",JSON.stringify(m,null,2)+"\n");' "$MKT_DIR" "$LIVE_MKT" || return 1
  cc plugin validate "$MKT_DIR" >/dev/null 2>&1 || { cc plugin validate "$MKT_DIR" >&2; return 1; }
  # 4-5 the CLI registers the marketplace and installs the plugin from it (the CLI owns installed_plugins.json and the cache)
  cc plugin marketplace add "$MKT_DIR" >/dev/null || return 1
  cc plugin install "$LIVE_KEY" >/dev/null || return 1
  # 6 any other enabled anti-hall install is DISABLED (not uninstalled): its direct Node hooks would run next to the thin triggers
  for _k in $(printf '%s\n' "$ORIGS" | cut -f1); do cc plugin disable "$_k" --scope user >/dev/null || return 1; done
  # 7 the user-level shadow triggers go (they would start a second, old engine on the same socket)
  node -e '
    const fs=require("fs"),f=process.argv[1],marks=process.argv[2].split(" "),s=JSON.parse(fs.readFileSync(f,"utf8")); let removed=0;
    for (const ev of Object.keys(s.hooks||{})) { s.hooks[ev]=s.hooks[ev].map(g=>({...g,hooks:g.hooks.filter(h=>{const r=marks.some(k=>String(h.command||"").includes(k)); if(r) removed++; return !r;})})).filter(g=>g.hooks.length); if(!s.hooks[ev].length) delete s.hooks[ev]; }
    fs.writeFileSync(f+".tmp",JSON.stringify(s,null,2)+"\n"); fs.renameSync(f+".tmp",f); console.log("shadow triggers removed from settings.json: "+removed);' "$SETTINGS" "$SHADOW_MARKS" || return 1
  # 7a the old Mac shadow trigger becomes a no-op (see above)
  if [ -f "$OLDSH" ]; then
    printf '#!/bin/sh\n# neutralised by ah-engine-live go-live (the engine is live; this old log-only trigger would write into its state). rollback.sh restores the original.\nexit 0\n' >"$OLDSH.new" && chmod 755 "$OLDSH.new" && mv "$OLDSH.new" "$OLDSH" || { rm -f "$OLDSH.new"; return 1; }
  fi
  # 7b the reverse witness: Node runs silently beside the engine (hook returns at once, worker logs; see node-shadow.sh)
  lim 60 sh "$NODE_SHADOW" --install --root "$(live_root)" || return 1
  # 7b2 one-time notice for sessions already running ("run /reload-plugins"); removed after 24 h or by rollback. Never worth failing go-live over.
  lim 30 sh "$KIT/reload-notice.sh" --install || { klog W_NOTICE_INSTALL "reload notice not installed"; note "warning: reload notice not installed (sessions already running will not be told to /reload-plugins)"; }
  # 7c the shadow2 install (WSL2/remote): its daemon is stopped; it keeps only the telemetry sync, which reads the live engine from live.conf
  if [ -f "$SHADOW2/.shadow2-installed" ]; then
    [ -x "$SHADOW2/bin/ah-engine" ] && HOME=$SHADOW2/home AH_ENGINE_DIR=$SHADOW2/state AH_ENGINE_PLUGIN_ROOT=$SHADOW2/plugin "$SHADOW2/bin/ah-engine" stop >/dev/null 2>&1
    printf 'LIVE_HOME=%s\nLIVE_BIN=%s\nLIVE_STATE=%s\nLIVE_ROOT=%s\n' "$HOME" "$LIVE_ENGINE_BIN" "$ENGINE_DIR" "$(live_root)" >"$SHADOW2/live.conf" || return 1
  fi
  # 7 the daemon already serving $ENGINE_DIR is stopped: it may be an older build (the shadow binary), and a client of the SAME version
  #   never hands off (daemon.rs: only a newer client makes it exit), so it would keep answering. Not running is fine.
  [ -x "$LIVE_ENGINE_BIN" ] && eng "$LIVE_ENGINE_BIN" stop >/dev/null 2>&1
  # verify through the CLI: the engine build is enabled at the bundle version, the original is disabled
  [ "$(plugin_state "$LIVE_KEY")" = "enabled	$PVER" ] && [ -z "$(orig_list)" ] || { echo "CLI state after install is not as expected" >&2; return 1; }
}
if ! apply; then
  note "go-live failed part-way: rolling back"; sh "$KIT/rollback.sh" --force --quiet; die "go-live failed; rolled back"
fi
node -e '
  const fs=require("fs"),j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),rows=f=>fs.readFileSync(f,"utf8").split("\n").filter(Boolean);
  j.files.settings.sha_after=process.argv[4]; j.files.config.sha_after=process.argv[5]; j.files.bin.sha_after=process.argv[6]; if(j.files.shadowall) j.files.shadowall.sha_after=process.argv[8];
  j.on=rows(process.argv[2]); j.off=rows(process.argv[3]).map(x=>x.replace("\t","/")); j.plugin_version=process.argv[7]; j.complete=true; j.finished=new Date().toISOString();
  fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\n");' "$LIVE_JSON" "$ON" "$OFF" "$(sha "$SETTINGS")" "$(sha "$CONFIG_TOML")" "$(sha "$LIVE_ENGINE_BIN")" "$PVER" "$(sha "$OLDSH")"
note "LIVE: $LIVE_KEY $PVER installed via the claude CLI; other anti-hall installs disabled (${ORIGS:-none}). Takes effect in new sessions (or /reload-plugins); running sessions keep the hooks they started with."
note "check: sh $KIT/status.sh    compare Node vs engine: sh $NODE_SHADOW --compare    undo: sh $KIT/rollback.sh"
