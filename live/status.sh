#!/bin/sh
# status.sh [--table]   Read-only. Says whether the machine is live, who decides each check, and whether anything would double-run.
. "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/lib.sh"
need_node
if [ "${1:-}" = "--table" ]; then entry_table "$BUNDLE/ah-engine" | awk -F'\t' 'BEGIN{print "event\tentry\tcheck\tguard"} {print}' | { column -t -s '	' 2>/dev/null || cat; }; exit 0; fi
bad=0
echo "MODE: $([ -f "$LIVE_JSON" ] && echo LIVE || echo SHADOW)"
echo "== state"
if [ -f "$LIVE_JSON" ]; then
  node -e '
    const j=require(process.argv[1]); console.log("LIVE  arg="+j.arg+"  complete="+j.complete+"  since="+(j.finished||j.started)+"  plugin="+(j.plugin_version||"?"));
    console.log("engine decides (guard): "+j.on.length+"   Node decides (guard, config off): "+(j.off||[]).length);' "$LIVE_JSON"
else echo "NOT LIVE (Node hooks decide; engine only shadows if the shadow triggers are installed)"; fi
echo "== wiring (what the host will actually run, from claude plugin list --json)"
cc plugin list --json 2>/dev/null | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{ const fs=require("fs"); let j=[]; try{j=JSON.parse(s)}catch(e){}
    for (const p of j.filter(x=>/^anti-hall@/.test(x.id))) { let t=0,d=0; try{ for (const g of Object.values(JSON.parse(fs.readFileSync(p.installPath+"/hooks/hooks.json","utf8")).hooks)) for (const m of g) for (const x of m.hooks) (/hooks\/ah-hook\.sh/.test(x.command)?t++:d++); }catch(e){}
      if (!p.installPath) { console.log(p.id+" "+p.version+" scope="+p.scope+" "+(p.enabled?"enabled":"disabled")+"  not installed here: "+((p.notes||[]).join("; ")||"(no notes)")); continue; }
      console.log(p.id+" "+p.version+" "+(p.enabled?"ENABLED":"disabled")+"  hooks.json: "+t+" thin triggers, "+d+" direct Node hooks  ("+p.installPath+")"); } })'
sh_n=$(count_shadow)
echo "settings.json shadow triggers: $sh_n"
if [ -f "$LIVE_JSON" ]; then
  [ "$sh_n" = 0 ] || { echo "  WARN: shadow triggers present while live (second engine on the same socket)"; bad=1; }
  [ "$(plugin_state "$LIVE_KEY" | cut -f1)" = enabled ] && [ -z "$(orig_list)" ] || { echo "  WARN: expected $LIVE_KEY enabled and no other anti-hall install enabled"; bad=1; }
fi
echo "== node-shadow (Node as silent witness)"; sh "$NODE_SHADOW" --status 2>&1 | sed 's/^/  /'
echo "== engine binary + daemon"
if [ -x "$LIVE_ENGINE_BIN" ]; then
  echo "binary: $LIVE_ENGINE_BIN sha256=$(sha "$LIVE_ENGINE_BIN" | cut -c1-12) (bundle $(sha "$BUNDLE/ah-engine" | cut -c1-12))"
  echo "  plugin root for engine calls: $(live_root)"
  eng "$LIVE_ENGINE_BIN" status 2>&1 | grep -E '^(running|pid|requests|errors|panics|breaker|crashloop|starts|restarts):' | sed 's/^/  /'
else echo "binary: absent ($LIVE_ENGINE_BIN): ah-hook.sh runs the Node fallback for every event"; fi
echo "== config.toml managed block (entries forced to Node)"
managed_off | tr '\t' '/' | sed 's/^/  off: /'; [ -z "$(managed_off)" ] && echo "  (none)"
echo "== per-check owner (guard events; non-guard entries are engine-first with Node on defer)"
if [ -x "$BUNDLE/ah-engine" ]; then
  offs=$(managed_off | tr '\t' '/')
  entry_table "$BUNDLE/ah-engine" | LIVE_FLAG="$([ -f "$LIVE_JSON" ] && echo 1 || echo 0)" OFFS="$offs" awk -F'\t' '
    BEGIN{live=ENVIRON["LIVE_FLAG"]; n=split(ENVIRON["OFFS"],a,"\n"); for(i=1;i<=n;i++) off[a[i]]=1}
    $3!="" { k=$1 "/" $2
      if(!live) o="node"; else if($4==1) o=(k in off)?"node":"engine(node on defer)"; else o="engine-first(node on defer)";
      printf "  %-18s %-34s %-8s %s\n", $1, $2, ($4==1?"guard":"non-guard"), o }' | sort
fi
exit $bad
