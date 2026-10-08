#!/bin/sh
# rollback.sh                 full rollback: every file go-live touched goes back byte-identical; Node decides everything again.
# rollback.sh --check <ids>   per-check revert: those GUARD entries go back to Node as their decider; the rest stays live.
# Flags: --force (restore even if a file changed after go-live), --quiet.
# Nothing is deleted: files go-live created are moved to state/rolled-back-<time>/.
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/lib.sh"
need_node
force=0; quiet=0; checks=
while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;; --quiet) quiet=1 ;;
    --check) shift; checks=${1:-}; [ -n "$checks" ] || die "--check needs a comma-separated list of entry ids" ;;
    *) die "unknown argument: $1" ;;
  esac; shift
done
say() { [ "$quiet" = 1 ] || note "$@"; }
[ -f "$LIVE_JSON" ] || die "not live (no $LIVE_JSON): nothing to roll back"

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

# --- pre-check: refuse before touching anything if a kit-written file changed after go-live (unless --force) ---------------
conf=$(node -e '
  const fs=require("fs"),crypto=require("crypto"),j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const sha=f=>fs.existsSync(f)?crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"):"absent";
  for (const [k,v] of Object.entries(j.files)) { const cur=sha(v.path);
    if (cur!==v.sha_before && v.sha_after!==null && cur!==v.sha_after) console.log(k+": "+v.path+" changed after go-live"); }' "$LIVE_JSON")
if [ -n "$conf" ] && [ "$force" != 1 ]; then printf '%s\n' "$conf" >&2; die "refusing: restoring would overwrite later edits. Re-run with --force to restore anyway (your edits are kept in the backup dir listed below)"; fi
TS=$(date +%Y%m%d-%H%M%S); RB=$STATE/rolled-back-$TS; mkdir -p "$RB"
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
# 1 stop the daemon, 2 plugin switch back through the CLI (idempotent: each step checks the CLI's own state), 3 files the kit wrote
[ -x "$LIVE_ENGINE_BIN" ] && eng "$LIVE_ENGINE_BIN" stop >/dev/null 2>&1   # stage 5: eng names the plugin root (the binary holds no defaults)
LIVE_K=$(node -p 'require(process.argv[1]).live.key' "$LIVE_JSON"); ORIG_LIST=$(node -e 'for(const o of (require(process.argv[1]).origs||[])) console.log(o.key+"\t"+o.version)' "$LIVE_JSON")
rc_cli=0
[ "$(plugin_state "$LIVE_K" | cut -f1)" = absent ] || cc plugin uninstall "$LIVE_K" --scope user --keep-data >/dev/null || rc_cli=1
mkt_present "$LIVE_MKT" && { cc plugin marketplace remove "$LIVE_MKT" >/dev/null || rc_cli=1; }
printf '%s\n' "$ORIG_LIST" | while IFS='	' read -r _k _v; do [ -n "$_k" ] || continue; [ "$(plugin_state "$_k" | cut -f1)" = enabled ] || cc plugin enable "$_k" --scope user >/dev/null || exit 1; done || rc_cli=1
restore settings          # byte-identical user settings (undoes the CLI's enabledPlugins/extraKnownMarketplaces edits and puts the shadow triggers back)
restore config; restore bin
[ -d "$MKT_DIR" ] && { mkdir -p "$RB" && mv "$MKT_DIR" "$RB/marketplace"; }
while IFS='	' read -r _k _v; do [ -n "$_k" ] || continue; [ "$(plugin_state "$_k")" = "enabled	$_v" ] || { echo "WARNING: $_k is not enabled at $_v after rollback (check: claude plugin list)" >&2; rc_cli=1; }; done <<EOF2
$ORIG_LIST
EOF2
rm -f "$SHADOW2/live.conf"
mv "$LIVE_JSON" "$RB/live.json"; [ -d "$STATE/backup" ] && mv "$STATE/backup" "$RB/backup"
say "rolled back: $LIVE_K uninstalled, previously enabled anti-hall installs re-enabled (${ORIG_LIST:-none}), settings.json restored (shadow triggers back if they were there). Node hooks decide everything again (new sessions / /reload-plugins). Kept under $RB."
exit $rc_cli
