#!/bin/sh
# Shared helpers for go-live.sh / rollback.sh / status.sh (ported from the Mac kit; POSIX sh, macOS + Linux/WSL2). Everything is rooted at $HOME so the kit can be exercised in a fake HOME.
# Sourced, never executed.
KIT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
STATE=$KIT/state
BUNDLE=$KIT/bundle
LIVE_ENGINE_BIN=$HOME/.anti-hall/ah-engine/bin/ah-engine          # the only place ah-hook.sh looks (besides PATH)
ENGINE_DIR=${AH_ENGINE_DIR:-$HOME/.anti-hall/ah-engine}           # daemon state dir; config.toml lives here
CONFIG_TOML=$ENGINE_DIR/config.toml
CC_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}                        # the CLI honors CLAUDE_CONFIG_DIR (verified); the kit follows it
SETTINGS=$CC_DIR/settings.json                                    # user-owned: backed up and restored byte-identical by rollback
CLAUDE_BIN=${AH_LIVE_CLAUDE:-claude}                              # the plugin registry/cache are written ONLY by this CLI, never by the kit
# every enabled user-scope anti-hall@<marketplace> plugin other than the live one is disabled on go-live and re-enabled on rollback (none is fine)
LIVE_MKT=anti-hall-engine-live                                    # local marketplace built from the bundle (a name distinct from the real "anti-hall")
LIVE_KEY=anti-hall@$LIVE_MKT
MKT_DIR=$STATE/marketplace
SHADOW_MARKS='ah-engine-shadow/shadow-all.sh ah-engine-shadow2/shadow2.sh'   # the user-level log-only engine shadow triggers go-live removes (old Mac one, WSL2/remote installer one)
SHADOW2=$HOME/.anti-hall/ah-engine-shadow2                        # the remote shadow installer's dir: its daemon is stopped, its telemetry sync keeps running from the live engine (live.conf)
NODE_SHADOW=$KIT/node-shadow.sh
LIVE_JSON=$STATE/live.json
MARK_BEGIN='# >>> ah-engine-live (managed by go-live.sh; do not edit between the markers)'
MARK_END='# <<< ah-engine-live'
AGREE_FILE=${AH_LIVE_AGREE_FILE:-$KIT/agreed-checks.txt}           # one Event/check per line (shipped), or an ndjson comparison log
# Stage 5: the binary carries no settings/tables; it reads them from <plugin root>/engine/defaults (found via AH_ENGINE_PLUGIN_ROOT,
# which ah-hook.sh exports from its own location). Every engine call the kit makes itself names the root explicitly.
BUNDLE_ROOT=$BUNDLE/plugin

die() { printf 'ah-engine-live: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
sha() { if [ -f "$1" ]; then if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; else echo absent; fi; }
need_node() { command -v node >/dev/null 2>&1 || die "node not found on PATH"; }

# Entry table straight from the engine binary (so it can never disagree with what the dispatcher uses).
# Output rows: Event<TAB>id<TAB>check<TAB>guard(1|0) for the claude host.
entry_table() {
  # scratch HOME + state dir: the table comes from THIS binary reading THIS bundle's engine/defaults, and a running daemon of
  # another build must not answer for it. $2 = plugin root (default: the bundled plugin).
  _s=$(mktemp -d) || return 1
  HOME=$_s AH_ENGINE_DIR=$_s/st AH_ENGINE_PLUGIN_ROOT=${2:-$BUNDLE_ROOT} "$1" config --json | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const c=JSON.parse(s).settings, guards=c["dispatch.guard_events"].value;
      for (const k of Object.keys(c)) { const m=k.match(/^dispatch\.hooks_claude_(\w+)$/); if(!m) continue;
        for (const e of c[k].value) console.log([m[1],e.id,e.check||"",guards.includes(m[1])?1:0].join("\t")); }
    });'
  _rc=$?; rm -rf "$_s"; return $_rc
}

# Current owner of each entry according to the managed block in config.toml: prints "Event<TAB>id" rows that are OFF.
managed_off() {
  [ -f "$CONFIG_TOML" ] || return 0
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0==b {on=1; next} $0==e {on=0}
    on && /^\[entries\."/ { s=$0; sub(/^\[entries\."/,"",s); sub(/"\]$/,"",s); n=index(s,"/"); print substr(s,1,n-1) "\t" substr(s,n+1) }' "$CONFIG_TOML"
}

# --- the supported mechanism: the claude CLI (marketplace add / plugin install|enable|disable|uninstall) ------------------------------
cc() { "$CLAUDE_BIN" "$@"; }
# orig_list -> "<key><TAB><version>" for each enabled user-scope anti-hall@* plugin except the live one
orig_list() {
  cc plugin list --json 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{ let j=[]; try{j=JSON.parse(s)}catch(e){}
      for (const p of j) if (/^anti-hall@/.test(p.id)&&p.id!==process.argv[1]&&p.scope==="user"&&p.enabled) console.log(p.id+"\t"+p.version); })' "$LIVE_KEY"
}
# plugin_state <key> -> "<enabled|disabled|absent><TAB><version>" for the user-scope install, from `claude plugin list --json`
plugin_state() {
  cc plugin list --json 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{ let j; try{j=JSON.parse(s)}catch(e){console.log("error\t?");return}
      const p=j.find(x=>x.id===process.argv[1]&&x.scope==="user"); console.log(p?((p.enabled?"enabled":"disabled")+"\t"+p.version):"absent\t-"); })' "$1"
}
mkt_present() { cc plugin marketplace list 2>/dev/null | grep -q "^  ❯ $1\$"; }

# live_root: the plugin root a daemon on the real state dir should load (the installed live plugin while live, else the bundle).
live_root() {
  _r=$(cc plugin list --json 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{ let j=[]; try{j=JSON.parse(s)}catch(e){}
      const p=j.find(x=>x.id===process.argv[1]&&x.scope==="user"); console.log(p&&p.installPath||""); })' "$LIVE_KEY")
  if [ -n "$_r" ] && [ -f "$_r/engine/defaults/index.toml" ]; then printf %s "$_r"; else printf %s "$BUNDLE_ROOT"; fi
}
# eng <bin> <args...>: run an engine command against the real state dir with an explicit plugin root
eng() { _b=$1; shift; HOME=$HOME AH_ENGINE_DIR=$ENGINE_DIR AH_ENGINE_PLUGIN_ROOT=$(live_root) "$_b" "$@"; }
# count_shadow: how many shadow trigger entries (any SHADOW_MARKS) settings.json holds
count_shadow() {
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let n=0;const ms=process.argv[2].split(" ");for(const g of Object.values(s.hooks||{}))for(const m of g)for(const h of m.hooks)if(ms.some(k=>String(h.command).includes(k)))n++;console.log(n)' "$SETTINGS" "$SHADOW_MARKS"
}
