#!/bin/sh
# rollback.sh                 full rollback: every file go-live touched goes back byte-identical; Node decides everything again.
# rollback.sh --check <ids>   per-check revert: those GUARD entries go back to Node as their decider; the rest stays live.
# Flags: --force (restore even if a file changed after go-live), --quiet.
# settings.json is NOT restored as a snapshot: only the keys/entries the kit changed are reverted, later owner edits stay.
# Nothing is deleted: files go-live created are moved to state/rolled-back-<time>/.
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/lib.sh"
need_node
force=0; quiet=0; checks=
while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;; --quiet) quiet=1 ;;
    --check) shift; checks=${1:-}; [ -n "$checks" ] || usage "--check needs a comma-separated list of entry ids" ;;
    *) usage "unknown argument: $1" ;;
  esac; shift
done
say() { [ "$quiet" = 1 ] || note "$@"; }
# Ctrl-C / TERM mid-rollback: every step is idempotent and the ledger (state/live.json) is only moved away at the very end, so a re-run resumes.
trap 'klog E_INTERRUPTED "rollback interrupted"; printf "ah-engine-live: rollback interrupted; nothing is lost. Re-run: sh %s/rollback.sh%s\n" "$KIT" "$([ "$force" = 1 ] && echo " --force")" >&2; rm -f "$_CLI_DEAD"; exit 130' INT TERM HUP
trap 'rm -f "$_CLI_DEAD"' 0
[ -f "$LIVE_JSON" ] || die "not live (no $LIVE_JSON), so there is nothing to roll back. Nothing was changed. Next step: none needed; run go-live.sh to go live"

if [ -n "$checks" ]; then
  node -e '
    const j=require(process.argv[1]); const want=process.argv[2].split(",").map(s=>s.trim()).filter(Boolean);
    const base=id=>id.replace(/#\d+$/,"");
    const onIds=[...new Set(j.on.map(r=>r.split("\t")[1]))];
    const hit=want.filter(w=>onIds.some(i=>i===w||base(i)===w));
    const miss=want.filter(w=>!hit.includes(w));
    if (miss.length) { console.error("not an engine-decided guard entry right now: "+miss.join(", ")+"\n(non-guard entries have no per-entry Node switch: the engine answers them only when it can match Node exactly, else Node runs; use a full rollback to undo those)"); process.exit(1); }
    const left=onIds.filter(i=>!want.some(w=>i===w||base(i)===w));
    console.log(left.length?left.join(","):"none");' "$LIVE_JSON" "$checks" >"$STATE/.left" || { rm -f "$STATE/.left"; exit 1; }
  left=$(cat "$STATE/.left"); rm -f "$STATE/.left"
  exec sh "$KIT/go-live.sh" "$left"
fi

# --- our own settings.json edits first: the Node witness hook and the reload notice were added by this kit's installer, so they are removed
# (bounded, failures logged) before the changed-after-go-live check and can never make a plain rollback refuse.
lim 30 sh "$NODE_SHADOW" --uninstall >/dev/null 2>&1 || klog E_WITNESS_UNINSTALL "node-shadow.sh --uninstall failed (rc=$?)"
lim 30 sh "$KIT/reload-notice.sh" --uninstall >/dev/null 2>&1 || klog E_NOTICE_UNINSTALL "reload-notice.sh --uninstall failed (rc=$?)"

# --- pre-check: refuse before touching anything if a kit-written file changed after go-live (unless --force) ---------------
conf=$(node -e '
  const fs=require("fs"),crypto=require("crypto"),j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const sha=f=>fs.existsSync(f)?crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"):"absent";
  // settings.json is never a conflict: rollback reverts only the keys/entries this kit changed (restore_settings) and keeps every other edit.
  for (const [k,v] of Object.entries(j.files)) { const cur=sha(v.path);
    if (cur!==v.sha_before && v.sha_after!==null && cur!==v.sha_after) {
      if (k==="settings") continue;
      console.log(k+": "+v.path+" changed after go-live"); } }' "$LIVE_JSON")
if [ -n "$conf" ] && [ "$force" != 1 ]; then printf '%s\n' "$conf" >&2; die "restoring would overwrite later edits you made, so nothing was restored; live mode is still on. Next step: re-run with --force to restore anyway (your edits are kept in the backup dir listed below)"; fi
TS=$(date +%Y%m%d-%H%M%S); RB=$STATE/rolled-back-$TS
DIE_CODE=E_STATE_UNWRITABLE mkdir -p "$RB" 2>/dev/null && [ -w "$RB" ] || { DIE_CODE=E_STATE_UNWRITABLE; die "cannot write under $STATE (disk full or read-only?); nothing was changed. Free space / fix permissions, then re-run"; }
restore() { # key  (files the kit wrote itself: byte-identical from backup, or moved aside if go-live created them)
  node -e '
    const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")),v=j.files[process.argv[2]];
    console.log([v.path,v.existed?1:0,v.sha_before,v.backup||""].join("\t"));' "$LIVE_JSON" "$1" | { IFS='	' read -r path existed before backup
    cur=$(sha "$path")
    [ "$cur" = "$before" ] && return 0
    if [ "$existed" = 1 ]; then
      [ "$cur" != absent ] && cp -p "$path" "$RB/$(basename "$path").edited"      # keep whatever was there (only matters with --force)
      cp -p "$STATE/$backup" "$path"
    else
      [ "$cur" = absent ] || { mkdir -p "$RB/$1" && mv "$path" "$RB/$1/"; }
    fi; }
}
# settings.json is user-owned and may have been edited since go-live (theme, permissions, other hooks): never put the whole snapshot back.
# Revert ONLY what this kit changed: enabledPlugins for the live + original anti-hall plugins, extraKnownMarketplaces[live marketplace], and the
# hooks entries (the old shadow triggers go-live removed come back; the witness + notice entries are removed). Everything else stays as it is now.
# When nothing but those kit keys differs from the snapshot (no owner edit), the snapshot is copied back byte-identical.
restore_settings() {
  node -e '
    const fs=require("fs"),[f,bak,liveK,liveM,origs,marks,rb]=process.argv.slice(1);
    const rd=p=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){return null}};
    const b=rd(bak); if(!b){console.error("settings snapshot unreadable: settings.json left as it is");process.exit(3)}
    const cur=rd(f);
    const canon=v=>Array.isArray(v)?v.map(canon):(v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v);
    const put=(txt)=>{fs.writeFileSync(f+".ah-tmp",txt);fs.renameSync(f+".ah-tmp",f)};
    if(!cur){fs.copyFileSync(bak,f);process.exit(0)}   // current file is not valid JSON: nothing to preserve
    try{fs.copyFileSync(f,rb+"/settings.json.pre-rollback")}catch(e){}
    const shadow=marks.split(" ").filter(Boolean), kit=shadow.concat(["ah-node-shadow/node-shadow.sh","ah-live-notice/notice.sh"]);
    const has=(h,ms)=>ms.some(m=>String(h&&h.command||"").includes(m));
    // enabledPlugins: the live plugin and the originals go back to their snapshot value (or are removed if the snapshot had none)
    const keys=[liveK].concat(origs.split("\n").map(l=>l.split("\t")[0]).filter(Boolean));
    for(const k of keys){ const bv=b.enabledPlugins&&Object.prototype.hasOwnProperty.call(b.enabledPlugins,k)?b.enabledPlugins[k]:undefined;
      if(bv!==undefined){cur.enabledPlugins=cur.enabledPlugins||{};cur.enabledPlugins[k]=bv} else if(cur.enabledPlugins)delete cur.enabledPlugins[k]; }
    if(cur.enabledPlugins&&!Object.keys(cur.enabledPlugins).length&&!(b.enabledPlugins))delete cur.enabledPlugins;
    // extraKnownMarketplaces: only the live marketplace entry
    if(b.extraKnownMarketplaces&&b.extraKnownMarketplaces[liveM]!==undefined){cur.extraKnownMarketplaces=cur.extraKnownMarketplaces||{};cur.extraKnownMarketplaces[liveM]=b.extraKnownMarketplaces[liveM]}
    else if(cur.extraKnownMarketplaces){delete cur.extraKnownMarketplaces[liveM]; if(!Object.keys(cur.extraKnownMarketplaces).length&&!b.extraKnownMarketplaces)delete cur.extraKnownMarketplaces}
    // hooks: drop the witness + notice entries, put back the shadow triggers from the snapshot that are missing now
    if(cur.hooks){ for(const ev of Object.keys(cur.hooks)){ const had=cur.hooks[ev].length;
        cur.hooks[ev]=cur.hooks[ev].map(g=>{const n=(g.hooks||[]).filter(h=>!has(h,kit));return n.length===(g.hooks||[]).length?g:{...g,hooks:n}}).filter(g=>!(g.hooks&&g.hooks.length===0));
        if(!cur.hooks[ev].length&&!(b.hooks&&b.hooks[ev]))delete cur.hooks[ev]; } }
    for(const ev of Object.keys(b.hooks||{})) (b.hooks[ev]||[]).forEach((g,gi)=>{
      const mh=(g.hooks||[]).filter(h=>has(h,shadow)); if(!mh.length)return;
      cur.hooks=cur.hooks||{}; const arr=cur.hooks[ev]=cur.hooks[ev]||[];
      const present=new Set(arr.flatMap(x=>(x.hooks||[]).map(h=>h.command)));
      const miss=mh.filter(h=>!present.has(h.command)); if(!miss.length)return;
      const rest=(g.hooks||[]).filter(h=>!has(h,shadow)).map(h=>h.command);
      const host=rest.length?arr.find(x=>x.matcher===g.matcher&&rest.every(c=>(x.hooks||[]).some(h=>h.command===c))):null;
      if(host){ for(const h of miss){ const idx=(g.hooks||[]).indexOf(h); host.hooks.splice(Math.min(idx,host.hooks.length),0,h) } }
      else arr.splice(Math.min(gi,arr.length),0,{...g,hooks:miss}); });
    if(cur.hooks&&!Object.keys(cur.hooks).length&&!b.hooks)delete cur.hooks;
    if(JSON.stringify(canon(cur))===JSON.stringify(canon(b)))fs.copyFileSync(bak,f);   // no owner edit: byte-identical snapshot
    else put(JSON.stringify(cur,null,2)+"\n");' "$SETTINGS" "$STATE/$(node -p 'require(process.argv[1]).files.settings.backup' "$LIVE_JSON")" "$LIVE_K" "$LIVE_MKT" "$ORIG_LIST" "$SHADOW_MARKS" "$RB"
}
# 1 stop the daemon, 2 plugin switch back through the CLI (idempotent: each step checks the CLI's own state), 3 files the kit wrote
[ -x "$LIVE_ENGINE_BIN" ] && eng "$LIVE_ENGINE_BIN" stop >/dev/null 2>&1   # stage 5: eng names the plugin root (the binary holds no defaults)
LIVE_K=$(node -p 'require(process.argv[1]).live.key' "$LIVE_JSON"); ORIG_LIST=$(node -e 'for(const o of (require(process.argv[1]).origs||[])) console.log(o.key+"\t"+o.version)' "$LIVE_JSON")
rc_cli=0
[ "$(plugin_state "$LIVE_K" | cut -f1)" = absent ] || cc plugin uninstall "$LIVE_K" --scope user --keep-data >/dev/null || rc_cli=1
mkt_present "$LIVE_MKT" && { cc plugin marketplace remove "$LIVE_MKT" >/dev/null || rc_cli=1; }
printf '%s\n' "$ORIG_LIST" | while IFS='	' read -r _k _v; do [ -n "$_k" ] || continue; [ "$(plugin_state "$_k" | cut -f1)" = enabled ] || cc plugin enable "$_k" --scope user >/dev/null || exit 1; done || rc_cli=1
if [ "$rc_cli" -ne 0 ]; then
  # The claude CLI failed or timed out (see $STATE/kit.log). Same effect without it: edit enabledPlugins in settings.json directly (the CLI only
  # writes the file Claude Code reads): live plugin gone, the previously enabled anti-hall installs enabled again. A copy is kept first.
  note "claude CLI unavailable or timed out: switching the plugins back by editing $SETTINGS directly (copy: $RB/settings.pre-fallback.json)"
  cp -p "$SETTINGS" "$RB/settings.pre-fallback.json" 2>/dev/null
  node -e '
    const fs=require("fs"),[f,live,mkt,origs]=process.argv.slice(1); const s=JSON.parse(fs.readFileSync(f,"utf8"));
    if (s.enabledPlugins) delete s.enabledPlugins[live];
    if (s.extraKnownMarketplaces) delete s.extraKnownMarketplaces[mkt];
    for (const l of origs.split("\n").filter(Boolean)) { s.enabledPlugins=s.enabledPlugins||{}; s.enabledPlugins[l.split("\t")[0]]=true; }
    fs.writeFileSync(f+".ah-tmp",JSON.stringify(s,null,2)+"\n"); fs.renameSync(f+".ah-tmp",f);' "$SETTINGS" "$LIVE_K" "$LIVE_MKT" "$ORIG_LIST" \
    && { klog W_SETTINGS_FALLBACK "enabledPlugins edited directly"; rc_cli=0; fb=1; } || klog E_SETTINGS_FALLBACK "direct enabledPlugins edit failed"
fi
restore_settings || { klog E_SETTINGS_RESTORE "restore_settings failed (rc=$?)"; rc_cli=1; echo "WARNING: settings.json was not reverted (see $STATE/kit.log); no edit of yours was touched" >&2; }   # kit keys only; owner edits kept
restore config; restore bin
node -e 'process.exit(require(process.argv[1]).files.shadowall?0:1)' "$LIVE_JSON" && restore shadowall   # the old Mac shadow trigger go-live neutralised
[ -d "$MKT_DIR" ] && { mkdir -p "$RB" && mv "$MKT_DIR" "$RB/marketplace"; }
[ "${fb:-0}" = 1 ] || while IFS='	' read -r _k _v; do [ -n "$_k" ] || continue; [ "$(plugin_state "$_k")" = "enabled	$_v" ] || { echo "WARNING: $_k is not enabled at $_v after rollback (check: claude plugin list)" >&2; rc_cli=1; }; done <<EOF2
$ORIG_LIST
EOF2
rm -f "$SHADOW2/live.conf"
mv "$LIVE_JSON" "$RB/live.json"; [ -d "$STATE/backup" ] && mv "$STATE/backup" "$RB/backup"
say "rolled back: $LIVE_K uninstalled, previously enabled anti-hall installs re-enabled (${ORIG_LIST:-none}), settings.json restored (shadow triggers back if they were there). Node hooks decide everything again (new sessions / /reload-plugins). Kept under $RB."
exit $rc_cli
