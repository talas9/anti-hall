#!/bin/sh
# engine-deploy.sh: put a new ah-engine binary live together with its plugin defaults, in the one safe order.
#
#   sh scripts/engine-deploy.sh --check    <new-binary> <new-defaults>              read-only pre-check
#   sh scripts/engine-deploy.sh --deploy   <new-binary> <new-defaults> [--yes] [--allow-drop] [--scope tree|defaults]
#   sh scripts/engine-deploy.sh --rollback [--from <backup-dir>] [--yes]
#
# <new-defaults> is the new plugin's defaults: a plugin root, its engine/ directory, or the defaults directory itself (the
# directory that holds index.toml; defaults.pristine is taken from its sibling when there is one, else the same files).
#
# Why: a binary that needs a defaults key the live plugin tree lacks logs "defaults file unusable, built-in values used" and the
# guards fail open. So the keys go in BEFORE the binary, in EVERY plugin root a hook can run from, and the pre-check proves it.
#
# --check   (read-only, no --yes needed) for each live plugin root: copies the root to scratch, applies the new defaults to the copy
#           the way --deploy would, and asks THE NEW BINARY'S OWN validation (`config validate`, which loads the defaults and
#           refuses a plugin missing a key the engine reads) to accept it. Also validates the root as it is now (informational:
#           a failure there is exactly what swapping the binary first would cause) and prints a key diff: keys added, keys
#           the sync would drop (a problem unless --allow-drop: launcher-only keys live there), and changed values.
#           Exits non-zero on any problem.
# --deploy  dry run by default (runs --check and prints the plan); with --yes: check, set the maintenance hold, stop the
#           engine, sync into every root (each replaced file is copied to the backup first, never deleted), swap the binary
#           (the old one stays as bin/ah-engine.prev), record it with the integrity script, stop AGAIN (kills any daemon a hook
#           started from the old binary in the window), re-sync, release the hold, start the new binary, then verify: sha
#           matches, the RUNNING daemon is a new process whose executable is the new binary, force-push probe blocked through
#           the plugin root Claude runs, `status --json` running with no new defaults fallback since the start, defaults.error not
#           rewritten, roots identical. A failed step prints the exact --rollback command; nothing is rolled back on its own.
#           Maintenance hold: the launcher's own "daemon down" marker (files.daemon_down_marker in the state dir) is set to a time
#           in the future, so hooks pass through and start nothing while the engine is stopped and the binary is swapped. It
#           carries a TTL (AH_DEPLOY_HOLD_TTL_S, refreshed at every step) so a crashed deploy can never leave the guards off.
# --rollback  dry run by default; with --yes restores the .prev binary and every backed-up defaults file of the chosen deploy
#           (default: the latest). Files the deploy added are moved aside, not deleted; the files being replaced are kept too.
#
# --scope tree      (default when <new-defaults> is a plugin root) sync the WHOLE plugin tree (hooks, engine/logic, skills, monitors,
#                   scripts, ...) so a train deploy has hooks and logic in step with the binary; engine/defaults go first.
# --scope defaults  (the default when <new-defaults> is only a defaults dir) sync engine/defaults + engine/defaults.pristine only.
#                   Also syncs the Node backup tree (plugins/anti-hall-node) to the sibling path nodeback.node_dir resolves to from each
#                   root, with the same backup/manifest/verify rules, so the Node shadow and fallback switch are not no-ops.
# Nothing is ever removed with rm: replaced files are kept in the backup directory; the sync only adds and replaces. POSIX sh, no Node.
#
# Environment (all optional; defaults are $HOME-relative):
#   AH_DEPLOY_HOME            base for every default below (default $HOME)
#   AH_DEPLOY_ENGINE_DIR      engine state dir (default $AH_DEPLOY_HOME/.anti-hall/ah-engine); binary = bin/ah-engine in it
#   AH_DEPLOY_ROOTS           colon-separated plugin roots to sync (default: the two roots below)
#   AH_DEPLOY_MKT_ROOT        the engine-live marketplace plugin tree
#                             (default $AH_DEPLOY_HOME/.anti-hall/ah-engine-live/state/marketplace/plugins/anti-hall)
#   AH_DEPLOY_INSTALLED_JSON  installed_plugins.json (default $AH_DEPLOY_HOME/.claude/plugins/installed_plugins.json)
#   AH_DEPLOY_PLUGIN_KEY      its entry whose installPath is the cache root Claude runs hooks from (default anti-hall@anti-hall-engine-live)
#   AH_DEPLOY_BACKUP_ROOT     where backups go (default $AH_DEPLOY_ENGINE_DIR/deploys)
#   AH_DEPLOY_PROBE_N         force-push probe repetitions, all must be blocked (default 3)
#   AH_DEPLOY_CALL_TIMEOUT    seconds allowed per engine call, when timeout(1) exists (default 30)
#   AH_DEPLOY_HOLD_TTL_S      maintenance hold lifetime in seconds, refreshed at every step; 0 = no hold (default 120)
#   AH_DEPLOY_STOP_WAIT_S     seconds to wait for a stopped daemon to exit (default 10)
#   AH_DEPLOY_WINDOW_CMD      a command run inside the stop->swap window and again after the swap (a test seam: it plays the
#                             hook that arrives mid-deploy); it gets AH_DEPLOY_WINDOW=stop|swap and AH_DEPLOY_PID

set -u
LC_ALL=C; export LC_ALL

H=${AH_DEPLOY_HOME:-${HOME:-}}
[ -n "$H" ] || { echo "engine-deploy: no HOME" >&2; exit 2; }
ENGINE_DIR=${AH_DEPLOY_ENGINE_DIR:-$H/.anti-hall/ah-engine}
BIN=$ENGINE_DIR/bin/ah-engine
BK_ROOT=${AH_DEPLOY_BACKUP_ROOT:-$ENGINE_DIR/deploys}
MKT_ROOT=${AH_DEPLOY_MKT_ROOT:-$H/.anti-hall/ah-engine-live/state/marketplace/plugins/anti-hall}
INSTALLED=${AH_DEPLOY_INSTALLED_JSON:-$H/.claude/plugins/installed_plugins.json}
PLUGIN_KEY=${AH_DEPLOY_PLUGIN_KEY:-anti-hall@anti-hall-engine-live}
PROBE_N=${AH_DEPLOY_PROBE_N:-3}
CALL_T=${AH_DEPLOY_CALL_TIMEOUT:-30}
HOLD_TTL=${AH_DEPLOY_HOLD_TTL_S:-120}
STOP_WAIT=${AH_DEPLOY_STOP_WAIT_S:-10}
WINDOW_CMD=${AH_DEPLOY_WINDOW_CMD:-}
SCOPE=
NL='
'

die() { printf 'engine-deploy: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
PROBLEMS=0
problem() { PROBLEMS=$((PROBLEMS + 1)); printf 'PROBLEM: %s\n' "$*"; }

sha() {
  [ -f "$1" ] || { echo absent; return 0; }
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

TB=; command -v timeout >/dev/null 2>&1 && TB=timeout
[ -z "$TB" ] && command -v gtimeout >/dev/null 2>&1 && TB=gtimeout
# lim CMD...: stdin from /dev/null, a time limit when timeout(1) is available
lim() { if [ -n "$TB" ]; then "$TB" -k 5 "$CALL_T" "$@" </dev/null; else "$@" </dev/null; fi; }

SCRATCH=
# the scratch dir is never removed with rm: it is moved to the Trash when there is one, else left for the OS temp reaper
cleanup() { [ -n "$SCRATCH" ] && [ -d "$SCRATCH" ] && [ -d "$H/.Trash" ] && mv "$SCRATCH" "$H/.Trash/engine-deploy.$$" 2>/dev/null; return 0; }
trap cleanup EXIT
mkscratch() { [ -n "$SCRATCH" ] || SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/engine-deploy.XXXXXX") || die "cannot make a scratch dir"; }

# --- plugin roots -----------------------------------------------------------------------------------------------------
installed_path() {
  [ -f "$1" ] || return 0
  awk -v k="\"$2\"" 'index($0, k) && /: *\[/ {on = 1; next}
    on && /"installPath"/ {gsub(/.*"installPath": *"/, ""); gsub(/".*/, ""); print; exit}' "$1"
}
ROOTS=; PROBE_ROOT=
resolve_roots() {
  if [ -n "${AH_DEPLOY_ROOTS:-}" ]; then
    ROOTS=$(printf '%s' "$AH_DEPLOY_ROOTS" | tr ':' '\n' | grep .)
  else
    c=$(installed_path "$INSTALLED" "$PLUGIN_KEY")
    [ -n "$c" ] || die "no installPath for $PLUGIN_KEY in $INSTALLED (set AH_DEPLOY_ROOTS to name the plugin roots)"
    ROOTS=$MKT_ROOT$NL$c
  fi
  for r in $ROOTS; do
    [ -f "$r/engine/defaults/index.toml" ] || die "plugin root $r has no engine/defaults/index.toml"
  done
  # a hook runs from the cache root Claude installed: that one answers the force-push probe (the last root listed)
  PROBE_ROOT=$(printf '%s\n' "$ROOTS" | tail -n 1)
}

# --- new defaults -----------------------------------------------------------------------------------------------------
SRC_DEF=; SRC_PRI=; SRC_TREE=; SRC_NODE=; NODE_REL=
resolve_src() {
  d=$1
  [ -d "$d" ] || die "new defaults not found: $d"
  if [ -f "$d/engine/defaults/index.toml" ]; then SRC_TREE=$d; d=$d/engine; fi
  if [ -f "$d/defaults/index.toml" ]; then
    SRC_DEF=$d/defaults
    SRC_PRI=$d/defaults.pristine; [ -f "$SRC_PRI/index.toml" ] || SRC_PRI=$SRC_DEF
  elif [ -f "$d/index.toml" ]; then
    SRC_DEF=$d
    SRC_PRI=$d
    sib=$(dirname "$d")/defaults.pristine
    [ "$(basename "$d")" = defaults ] && [ -f "$sib/index.toml" ] && SRC_PRI=$sib
  else die "no index.toml under $1 (give a plugin root, its engine/ dir, or the defaults dir)"; fi
  case $SCOPE in
    '') if [ -n "$SRC_TREE" ]; then SCOPE=tree; else SCOPE=defaults; fi ;;
    tree) [ -n "$SRC_TREE" ] || die "--scope tree needs <new-defaults> to be a plugin root (a dir with engine/defaults/index.toml)" ;;
    defaults) ;;
    *) die "--scope takes tree or defaults" ;;
  esac
  # the Node backup tree: a sibling of the plugin root, at nodeback.node_dir (read from the NEW defaults, nothing hardcoded)
  SRC_NODE=; NODE_REL=
  if [ "$SCOPE" = tree ]; then
    NODE_REL=$(def_value "$SRC_DEF/nodeback.toml" nodeback.node_dir)
    if [ -n "$NODE_REL" ] && [ -d "$SRC_TREE/$NODE_REL" ]; then SRC_NODE=$SRC_TREE/$NODE_REL; fi
  fi
}

# tree_files SRC: the plugin-tree files the sync handles, relative paths, one per line. engine/defaults* are synced by their own
# step (the key diff and --allow-drop rules); VCS and dependency dirs, backups and editor droppings are never copied.
tree_files() {
  ( cd "$1" && find . \( -name .git -o -name node_modules \) -prune -o -type f -print ) | sed 's|^\./||' | LC_ALL=C sort |
    grep -v -e '^engine/defaults/' -e '^engine/defaults\.pristine/' -e '\.bak' -e '\.deploy\.' -e '/\.DS_Store$' -e '^\.DS_Store$'
}

# put_file SRC DIR NAME: put SRC at DIR/NAME through a sibling temp file (same volume, so the rename is atomic). With PEND set the
# rename is deferred: the temp is only staged and listed in PEND (commit_pending renames them all in one fast pass).
PEND=
put_file() {
  cp -p "$1" "$2/.$3.deploy.$$" || return 1
  if [ -n "$PEND" ]; then printf '%s\t%s\n' "$2/.$3.deploy.$$" "$2/$3" >>"$PEND"
  else mv "$2/.$3.deploy.$$" "$2/$3" || return 1; fi
}

# commit_pending: rename every staged temp into place, in the order staged (defaults first, then the tree); nothing is copied here
commit_pending() {
  [ -n "$PEND" ] && [ -s "$PEND" ] || return 0
  while IFS="$(printf '\t')" read -r _t _d; do mv "$_t" "$_d" || return 1; done <"$PEND"
}

# apply_tree SRC DST BACKUP MANIFEST: copy each tree file SRC/rel to DST/rel. A replaced file goes to BACKUP/rel first; the new one is
# renamed into place. Nothing is removed. Prints the number of files changed to $SCRATCH/tree.n
apply_tree() {
  _n=0
  tree_files "$1" >"$SCRATCH/tree.list" || return 1
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    f=$1/$rel; t=$2/$rel; d=$(dirname "$t"); b=${rel##*/}
    had=0; bk=-
    if [ -e "$t" ]; then
      cmp -s "$f" "$t" && continue
      mkdir -p "$(dirname "$3/$rel")" || return 1
      cp -p "$t" "$3/$rel" || return 1
      had=1; bk=$3/$rel
    fi
    mkdir -p "$d" || return 1
    [ -n "${4:-}" ] && printf 'F\t%s\t%s\t%s\t%s\n' "$d" "$b" "$had" "$bk" >>"$4"
    put_file "$f" "$d" "$b" || return 1
    _n=$((_n + 1))
  done <"$SCRATCH/tree.list"
  echo "$_n" >"$SCRATCH/tree.n"
}

# tree_mismatch SRC DST: the number of tree files of SRC that are absent from or differ in DST
tree_mismatch() {
  _m=0
  tree_files "$1" | while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    cmp -s "$1/$rel" "$2/$rel" || echo x
  done | wc -l | tr -d ' '
}

# keys_of FILE: one "table-header<TAB>first value line" per table
keys_of() {
  awk '/^\[/ {h = $0; hv[h] = ""; next}
       h != "" && hv[h] == "" && /^value[ \t]*=/ {sub(/^value[ \t]*=[ \t]*/, ""); hv[h] = $0}
       END {for (k in hv) print k "\t" hv[k]}' "$1" | sort -t "$(printf '\t')" -k1,1
}

# list_keys LABEL FILE: one line: the count and the first 3 keys of FILE
list_keys() {
  [ -s "$2" ] || return 0
  n=$(wc -l <"$2" | tr -d ' ')
  note "    $1 ($n): $(head -n 3 "$2" | tr '\n' ' ')$([ "$n" -gt 3 ] && echo '...')"
  return 0
}

# diff_dir SRC DST LABEL: print the key diff of every file in SRC against DST; sets DROPPED/ADDED counters
ADDED=0; DROPPED=0; FILES_CHANGED=0
diff_dir() {
  for f in "$1"/*; do
    [ -f "$f" ] || continue
    b=${f##*/}
    case $b in *.bak*) continue ;; esac
    if [ ! -f "$2/$b" ]; then
      keys_of "$f" | cut -f1 >"$SCRATCH/add.k"
      list_keys "+ $3/$b  new file, keys" "$SCRATCH/add.k"; ADDED=$((ADDED + $(wc -l <"$SCRATCH/add.k" | tr -d ' ')))
      FILES_CHANGED=$((FILES_CHANGED + 1)); continue
    fi
    cmp -s "$f" "$2/$b" && continue
    FILES_CHANGED=$((FILES_CHANGED + 1))
    keys_of "$f" >"$SCRATCH/new.kv"; keys_of "$2/$b" >"$SCRATCH/old.kv"
    cut -f1 "$SCRATCH/new.kv" >"$SCRATCH/new.k"; cut -f1 "$SCRATCH/old.kv" >"$SCRATCH/old.k"
    comm -23 "$SCRATCH/new.k" "$SCRATCH/old.k" >"$SCRATCH/add.k"
    list_keys "+ $3/$b  keys added" "$SCRATCH/add.k"; ADDED=$((ADDED + $(wc -l <"$SCRATCH/add.k" | tr -d ' ')))
    comm -13 "$SCRATCH/new.k" "$SCRATCH/old.k" >"$SCRATCH/drop.k"
    while IFS= read -r k; do note "    - $3/$b  key DROPPED by the sync: $k"; DROPPED=$((DROPPED + 1)); done <"$SCRATCH/drop.k"
    join -t "$(printf '\t')" "$SCRATCH/old.kv" "$SCRATCH/new.kv" 2>/dev/null | awk -F'\t' -v f="$3/$b" '$2 != $3 {n++; if (n <= 6) printf "    ~ %s  value changes: %s  %.30s -> %.30s\n", f, $1, $2, $3} END {if (n > 6) printf "    ~ %s  ... and %d more value changes\n", f, n - 6}'
  done
}

# apply_dir SRC DST BACKUP MANIFEST: copy each SRC file into DST. A replaced file is copied to BACKUP first, the new one is
# renamed into place (no moment without the file). Manifest rows: F dst file had backup
apply_dir() {
  mkdir -p "$2" || return 1
  for f in "$1"/*; do
    [ -f "$f" ] || continue
    b=${f##*/}
    case $b in *.bak*) continue ;; esac
    had=0; bk=-
    if [ -e "$2/$b" ]; then
      cmp -s "$f" "$2/$b" && continue
      mkdir -p "$3" || return 1
      cp -p "$2/$b" "$3/$b" || return 1
      had=1; bk=$3/$b
    fi
    [ -n "${4:-}" ] && printf 'F\t%s\t%s\t%s\t%s\n' "$2" "$b" "$had" "$bk" >>"$4"
    put_file "$f" "$2" "$b" || return 1
  done
}

# engine_env_run BIN ROOT ARGS...: the binary against a scratch HOME and state dir (never the live daemon or cache)
eng_scratch() {
  _b=$1; _r=$2; shift 2
  ( HOME=$SCRATCH/home AH_ENGINE_DIR=$SCRATCH/home/st AH_ENGINE_PLUGIN_ROOT=$_r; export HOME AH_ENGINE_DIR AH_ENGINE_PLUGIN_ROOT; lim "$_b" "$@" 2>&1 )
}

# old_misses ROOT SIM: the keys ROOT's defaults carry (what the running binary reads) that SIM's defaults lack, as "file key"
old_misses() {
  for d in defaults defaults.pristine; do
    for f in "$1/engine/$d"/*; do
      [ -f "$f" ] || continue
      b=${f##*/}
      case $b in *.bak*) continue ;; esac
      keys_of "$f" | cut -f1 >"$SCRATCH/om.old"
      if [ -f "$2/engine/$d/$b" ]; then keys_of "$2/engine/$d/$b" | cut -f1 >"$SCRATCH/om.new"; else : >"$SCRATCH/om.new"; fi
      comm -23 "$SCRATCH/om.old" "$SCRATCH/om.new" | sed "s|^|$d/$b |"
    done
  done
}

# --- check ------------------------------------------------------------------------------------------------------------
ALLOW_DROP=0
OLD_MISS=0
do_check() {
  NEW=$1
  [ -f "$NEW" ] && [ -x "$NEW" ] || die "new binary missing or not executable: $NEW"
  resolve_src "$2"; resolve_roots
  mkscratch; mkdir -p "$SCRATCH/home"; : >"$SCRATCH/empty.toml"
  newsha=$(sha "$NEW"); livesha=$(sha "$BIN")
  note "== engine-deploy check"
  note "new binary : $NEW  sha $(printf '%s' "$newsha" | cut -c1-12)"
  note "live binary: $BIN  sha $(printf '%s' "$livesha" | cut -c1-12)$([ "$newsha" = "$livesha" ] && echo '  (IDENTICAL to the new one)')"
  v=$(eng_scratch "$NEW" "$SCRATCH/none" version --json) || true
  note "new binary version: $(printf '%s' "$v" | head -c 120)"
  note "new defaults: $SRC_DEF  (pristine: $SRC_PRI); scope: $SCOPE$([ "$SCOPE" = tree ] && echo " ($SRC_TREE)")"
  i=0
  for r in $ROOTS; do
    i=$((i + 1))
    note "-- root $i: $r"
    out=$(eng_scratch "$NEW" "$r" config validate "$SCRATCH/empty.toml"); rc=$?
    if [ $rc -eq 0 ]; then note "  new binary on this root AS IS: loads (no key is missing)"
    else note "  new binary on this root AS IS: REFUSES (rc $rc: $(printf '%s' "$out" | head -n 1 | cut -c1-200)) -- swapping the binary before the keys would cause exactly this"; fi
    ADDED=0; DROPPED=0; FILES_CHANGED=0
    diff_dir "$SRC_DEF" "$r/engine/defaults" "defaults"
    diff_dir "$SRC_PRI" "$r/engine/defaults.pristine" "defaults.pristine"
    note "  summary: $FILES_CHANGED file(s) change, $ADDED key(s) added, $DROPPED key(s) dropped"
    if [ "$DROPPED" -gt 0 ]; then
      if [ "$ALLOW_DROP" = 1 ]; then note "  dropped keys allowed (--allow-drop)"
      else problem "root $r: the sync would drop $DROPPED key(s) the new defaults lack (launcher-only keys?); merge them into the new defaults, or pass --allow-drop"; fi
    fi
    # the root after the sync, in scratch: this is what the new binary will read
    sim=$SCRATCH/sim$i
    mkdir -p "$sim" && cp -R "$r/." "$sim/" || { problem "cannot copy $r to scratch"; continue; }
    apply_dir "$SRC_DEF" "$sim/engine/defaults" "$SCRATCH/simbk$i/d" "" && apply_dir "$SRC_PRI" "$sim/engine/defaults.pristine" "$SCRATCH/simbk$i/p" "" || { problem "cannot apply the new defaults to the scratch copy of $r"; continue; }
    if [ "$SCOPE" = tree ]; then
      apply_tree "$SRC_TREE" "$sim" "$SCRATCH/simbk$i/t" "" || { problem "cannot apply the new plugin tree to the scratch copy of $r"; continue; }
      note "  plugin tree: $(cat "$SCRATCH/tree.n") file(s) change (hooks, logic, skills, monitors, scripts ...)"
      if [ -n "$SRC_NODE" ]; then
        nm=$(tree_mismatch "$SRC_NODE" "$r/$NODE_REL")
        note "  node backup tree ($r/$NODE_REL): $nm file(s) change"
      else note "  node backup tree: none in the new source (shadow and fallback stay no-ops)"; fi
    fi
    out=$(eng_scratch "$NEW" "$sim" config validate "$SCRATCH/empty.toml"); rc=$?
    if [ $rc -eq 0 ]; then
      j=$(eng_scratch "$NEW" "$sim" config --json)
      le=$(printf '%s' "$j" | grep -o '"last_error":[^,}]*' | head -n 1)
      case $le in ''|'"last_error":null') note "  new binary on this root AFTER the sync: loads, no config error" ;;
        *) problem "root $r after the sync: config reports $le" ;; esac
    else problem "root $r after the sync: the new binary REFUSES it (rc $rc: $(printf '%s' "$out" | head -n 1 | cut -c1-240))"; fi
    # the window: until the binary is swapped (and for any old daemon or hook that still runs), the OLD binary reads the NEW defaults
    if [ -x "$BIN" ] && [ "$newsha" != "$livesha" ]; then
      out=$(eng_scratch "$BIN" "$sim" config validate "$SCRATCH/empty.toml"); rc=$?
      old_misses "$r" "$sim" >"$SCRATCH/om.list"
      if [ $rc -eq 0 ] && [ ! -s "$SCRATCH/om.list" ]; then note "  old (live) binary on this root AFTER the sync: loads, misses no key (no defaults_fallback in the window)"
      else
        n=$(wc -l <"$SCRATCH/om.list" | tr -d ' '); OLD_MISS=$((OLD_MISS + n))
        note "  WINDOW: the old (live) binary on this root AFTER the sync: rc $rc$([ $rc -ne 0 ] && echo ", refuses: $(printf '%s' "$out" | head -n 1 | cut -c1-200)"); it will log defaults_fallback missing_key for $n key(s) while it runs on the new defaults:"
        sed 's/^/      /' "$SCRATCH/om.list"
      fi
    fi
  done
  [ "$OLD_MISS" -gt 0 ] && note "WINDOW SUMMARY: $OLD_MISS key(s) the old binary will miss between the sync and the swap; the maintenance hold keeps hooks and the daemon off for that time, so this is expected only if the hold covers it (informational, not a failure)"
  if [ "$PROBLEMS" -gt 0 ]; then note "CHECK FAILED: $PROBLEMS problem(s); nothing was changed"; return 1; fi
  note "CHECK OK: the new binary accepts every root once the new defaults are in (nothing was changed)"
  return 0
}

# --- deploy -----------------------------------------------------------------------------------------------------------
DLOG=
step() { hold_refresh; printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$DLOG"; }

# --- maintenance hold ---------------------------------------------------------------------------------------------------
# The launcher's own "daemon down" marker (state dir, name from the files.daemon_down_marker default) holds a time in ms since
# the epoch; while it is in the future every hook passes through and starts nothing. The deploy sets it to now + TTL, refreshes it at
# every step, and on exit puts back what was there before (or 0 = expired). Nothing is deleted. The TTL is what makes a deploy that
# dies leave the guards off for at most HOLD_TTL seconds.
HOLD_FILES=; HOLD_ON=0
def_value() { # FILE KEY: the first value of table [KEY] in a defaults file (quotes stripped)
  awk -v t="[$2]" '$0 == t {on = 1; next} /^\[/ {on = 0} on && /^value[ \t]*=/ {sub(/^value[ \t]*=[ \t]*/, ""); gsub(/"/, ""); print; exit}' "$1" 2>/dev/null
}
now_s() { date +%s; }
hold_names() { # the marker names the hooks of every root read now, plus the new defaults' name
  for f in "$SRC_DEF/engine.toml" $(for r in $ROOTS; do echo "$r/engine/defaults/engine.toml"; done); do
    n=$(def_value "$f" files.daemon_down_marker); [ -n "$n" ] && echo "$n"
  done | sort -u
}
hold_write() { # NAME MS
  printf '%s' "$2" >"$ENGINE_DIR/.$1.hold.$$" && mv "$ENGINE_DIR/.$1.hold.$$" "$ENGINE_DIR/$1"
}
hold_set() {
  [ "$HOLD_TTL" -gt 0 ] 2>/dev/null || { step "maintenance hold disabled (AH_DEPLOY_HOLD_TTL_S=$HOLD_TTL)"; return 0; }
  HOLD_FILES=$(hold_names)
  [ -n "$HOLD_FILES" ] || fail_deploy "cannot read files.daemon_down_marker from any engine.toml: no maintenance hold is possible (set AH_DEPLOY_HOLD_TTL_S=0 to deploy without one)"
  mkdir -p "$ENGINE_DIR" "$BK/hold" || fail_deploy "cannot create the state dir"
  for n in $HOLD_FILES; do
    [ -f "$ENGINE_DIR/$n" ] && cp -p "$ENGINE_DIR/$n" "$BK/hold/$n"
    hold_write "$n" $(( ($(now_s) + HOLD_TTL) * 1000 )) || fail_deploy "cannot write the maintenance hold $ENGINE_DIR/$n"
  done
  HOLD_ON=1
  step "maintenance hold set for ${HOLD_TTL}s (refreshed each step): $HOLD_FILES"
}
hold_refresh() {
  [ "$HOLD_ON" = 1 ] || return 0
  for n in $HOLD_FILES; do hold_write "$n" $(( ($(now_s) + HOLD_TTL) * 1000 )) 2>/dev/null; done
  return 0
}
hold_release() {
  [ "$HOLD_ON" = 1 ] || return 0
  HOLD_ON=0
  for n in $HOLD_FILES; do
    if [ -f "$BK/hold/$n" ]; then cp -p "$BK/hold/$n" "$ENGINE_DIR/.$n.hold.$$" && mv "$ENGINE_DIR/.$n.hold.$$" "$ENGINE_DIR/$n"
    else hold_write "$n" 0; fi
  done
  return 0
}
trap 'hold_release; cleanup' EXIT
trap 'exit 130' INT TERM

# --- daemon helpers -----------------------------------------------------------------------------------------------------
RUN_MARKER=daemon.run
daemon_pid() { # the pid in the run marker, if any
  p=$(sed -n '1{s/[^0-9].*$//;p;}' "$ENGINE_DIR/$RUN_MARKER" 2>/dev/null)
  case $p in ''|*[!0-9]*) return 0 ;; esac
  printf '%s' "$p"
}
SEEN=
note_pid() { p=$(daemon_pid); [ -n "$p" ] && SEEN="$SEEN $p"; return 0; }
engine_stop() { ( HOME=$H AH_ENGINE_DIR=$ENGINE_DIR AH_ENGINE_PLUGIN_ROOT=$(printf '%s\n' "$ROOTS" | head -n 1); export HOME AH_ENGINE_DIR AH_ENGINE_PLUGIN_ROOT; lim "$BIN" stop >/dev/null 2>&1 ); }
# wait_gone: every pid seen so far has exited (stop may take a moment)
wait_gone() {
  w=0
  while [ "$w" -lt "$STOP_WAIT" ]; do
    alive=; for p in $SEEN; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
    [ -z "$alive" ] && return 0
    sleep 1; w=$((w + 1))
  done
  step "daemon pid(s) still alive after ${STOP_WAIT}s:$alive"; return 1
}
# exe_sha PID: sha of the executable the process runs; prints "<sha> <how>" ; empty when it cannot be established
exe_sha() {
  [ -e "/proc/$1/exe" ] && { printf '%s proc\n' "$(sha "/proc/$1/exe")"; return 0; }
  c=$(ps -p "$1" -o comm= 2>/dev/null | head -n 1)
  [ -n "$c" ] || return 0
  if [ "$c" = "$BIN" ] || [ "${c##*/}" = "${BIN##*/}" ]; then printf '%s ps-comm\n' "$(sha "$BIN")"; return 0; fi
  # an interpreter running the engine as a script: the binary is named in its arguments
  case " $(ps -p "$1" -o args= 2>/dev/null) " in *" $BIN "*) printf '%s ps-args\n' "$(sha "$BIN")" ;; esac
}
window_cmd() { # WHICH: run the mid-deploy hook seam, if set
  [ -n "$WINDOW_CMD" ] || return 0
  step "window: running AH_DEPLOY_WINDOW_CMD ($1)"
  ( HOME=$H AH_ENGINE_DIR=$ENGINE_DIR AH_DEPLOY_WINDOW=$1 AH_DEPLOY_PID=$$; export HOME AH_ENGINE_DIR AH_DEPLOY_WINDOW AH_DEPLOY_PID; sh -c "$WINDOW_CMD" >/dev/null 2>&1 ) || true
}
fail_deploy() {
  step "FAILED: $*"
  printf '\nengine-deploy: %s\nThe deploy stopped part way. To restore the previous state run:\n  sh %s --rollback --from %s --yes\n' "$*" "$0" "$BK" >&2
  exit 1
}

num_in_section() { # JSON SECTION KEY: top-level number KEY inside the object SECTION
  printf '%s' "$1" | awk -v sec="\"$2\":" -v key="\"$3\":" '{
    p = index($0, sec); if (!p) next
    s = substr($0, p + length(sec)); d = 0
    for (i = 1; i <= length(s); i++) { c = substr(s, i, 1)
      if (c == "{") d++
      else if (c == "}") { d--; if (d <= 0) break }
      else if (d == 1 && substr(s, i, length(key)) == key) { t = substr(s, i + length(key)); sub(/[^0-9].*/, "", t); print t; exit } } }'
}

tree_mismatch_scope() { # ROOT: files of the new source (per scope) missing or different in ROOT
  a=0
  for d in defaults defaults.pristine; do
    src=$SRC_DEF; [ "$d" = defaults.pristine ] && src=$SRC_PRI
    for f in "$src"/*; do
      [ -f "$f" ] || continue
      case ${f##*/} in *.bak*) continue ;; esac
      cmp -s "$f" "$1/engine/$d/${f##*/}" || a=$((a + 1))
    done
  done
  if [ "$SCOPE" = tree ]; then a=$((a + $(tree_mismatch "$SRC_TREE" "$1"))); fi
  if [ -n "$SRC_NODE" ]; then a=$((a + $(tree_mismatch "$SRC_NODE" "$1/$NODE_REL"))); fi
  echo "$a"
}

verify_live() { # returns 0 when every check passes; prints each
  ok=0
  ns=$(sha "$BIN")
  if [ "$ns" = "$NEWSHA" ]; then step "verify: binary sha matches the new one"; else step "verify FAILED: binary sha $ns != $NEWSHA"; ok=1; fi
  exp=$ENGINE_DIR/bin/ah-engine.expected
  if [ -f "$exp" ]; then
    if [ "$(tr -d ' \n' <"$exp")" = "$NEWSHA" ]; then step "verify: integrity record is the new sha"; else step "verify FAILED: $exp does not hold the new sha"; ok=1; fi
  else step "verify: no $exp (integrity script absent?)"; fi
  # roots identical (the two trees must serve the same defaults); backup files (*.bak*) are not part of the comparison
  first=; for r in $ROOTS; do
    if [ -z "$first" ]; then first=$r; continue; fi
    for d in defaults defaults.pristine; do
      if diff -rq -x '*.bak*' -x '.*.deploy.*' "$first/engine/$d" "$r/engine/$d" >/dev/null 2>&1; then :; else step "verify FAILED: engine/$d differs between $first and $r"; ok=1; fi
    done
  done
  for r in $ROOTS; do
    mm=$(tree_mismatch_scope "$r")
    if [ "$mm" != 0 ]; then step "verify FAILED: $mm synced file(s) of $r differ from the new $SCOPE source"; ok=1; fi
  done
  [ "$ok" -eq 0 ] && step "verify: plugin roots serve identical defaults and match the new $SCOPE source (after the final re-sync)"
  # the RUNNING daemon: a process that did not exist before the final stop, running the new binary
  dp=$(daemon_pid)
  if [ -z "$dp" ] || ! kill -0 "$dp" 2>/dev/null; then step "verify FAILED: no live daemon pid in $ENGINE_DIR/$RUN_MARKER"; ok=1
  else
    case " $SEEN " in *" $dp "*) step "verify FAILED: daemon pid $dp is one that ran before the final stop (an old-binary daemon survived)"; ok=1 ;; esac
    es=$(exe_sha "$dp")
    if [ -z "$es" ]; then step "verify FAILED: cannot read the executable of daemon pid $dp"; ok=1
    elif [ "${es%% *}" = "$NEWSHA" ]; then step "verify: running daemon pid $dp executes the new binary (sha match, via ${es#* })"
    else step "verify FAILED: running daemon pid $dp executes sha ${es%% *}, not the new $NEWSHA"; ok=1; fi
  fi
  # force-push probe through the root Claude runs (a first call may start the daemon; it is retried as a warm-up)
  pl='{"session_id":"deploy-probe","cwd":"'"$SCRATCH"'","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main","description":"Push"},"tool_use_id":"toolu_deploy_probe"}'
  mkdir -p "$SCRATCH"
  # lim reads stdin from /dev/null, so the probe feeds the payload through a file
  printf '%s' "$pl" >"$SCRATCH/probe.json"
  probe() { ( HOME=$H AH_ENGINE_DIR=$ENGINE_DIR CLAUDE_PLUGIN_ROOT=$PROBE_ROOT; export HOME AH_ENGINE_DIR CLAUDE_PLUGIN_ROOT
      if [ -n "$TB" ]; then "$TB" -k 5 "$CALL_T" sh "$PROBE_ROOT/hooks/ah-hook.sh" PreToolUse <"$SCRATCH/probe.json" >/dev/null 2>&1
      else sh "$PROBE_ROOT/hooks/ah-hook.sh" PreToolUse <"$SCRATCH/probe.json" >/dev/null 2>&1; fi ); }
  probe; warm=$?
  blocked=0; n=0
  while [ "$n" -lt "$PROBE_N" ]; do probe && rcp=0 || rcp=$?; [ "$rcp" -eq 2 ] && blocked=$((blocked + 1)); n=$((n + 1)); done
  if [ "$blocked" -eq "$PROBE_N" ]; then step "verify: force-push probe blocked $blocked/$PROBE_N (warm-up rc $warm) via $PROBE_ROOT"
  else step "verify FAILED: force-push probe blocked $blocked/$PROBE_N via $PROBE_ROOT (a guard is failing open)"; ok=1; fi
  # daemon status
  st=$( HOME=$H AH_ENGINE_DIR=$ENGINE_DIR AH_ENGINE_PLUGIN_ROOT=$first; export HOME AH_ENGINE_DIR AH_ENGINE_PLUGIN_ROOT; lim "$BIN" status --json 2>/dev/null )
  case $st in *'"running":true'*) step "verify: status --json running" ;; *) step "verify FAILED: status --json does not say running"; ok=1 ;; esac
  dt=$(num_in_section "$st" defaults total)
  # a delta, not an absolute: the counter is read against the value of the freshly started daemon, so history from before the
  # deploy can neither fail nor pass the check; only a fallback that happened since the start counts
  if [ -z "${dt:-}" ] || [ -z "${DT_START:-}" ]; then step "verify FAILED: defaults.total unreadable (start ${DT_START:-unreadable}, now ${dt:-unreadable})"; ok=1
  elif [ $((dt - DT_START)) -eq 0 ]; then step "verify: defaults.total delta 0 since the new daemon started (total $dt; no built-in-value fallback)"
  else step "verify FAILED: defaults.total grew by $((dt - DT_START)) since the new daemon started (total $dt): the engine fell back to built-in values"; ok=1; fi
  # every generated launcher in ~/.anti-hall/bin must still reach its real script: run it with a harmless flag and fail on a
  # missing target (MODULE_NOT_FOUND, "could not resolve", "failed to run"). A launcher that starts and runs to the time limit is fine.
  for lf in "$H/.anti-hall/bin"/*.js; do
    [ -f "$lf" ] || continue
    grep -q 'AUTO-GENERATED by anti-hall' "$lf" 2>/dev/null || continue
    lo=$SCRATCH/launcher.out; : >"$lo"
    ( HOME=$H; export HOME; lim node "$lf" --help >"$lo" 2>&1 ); lrc=$?
    if grep -q -e 'MODULE_NOT_FOUND' -e 'Cannot find module' -e 'could not resolve an anti-hall install' -e 'stable launcher: failed to run' "$lo"; then
      step "verify FAILED: launcher $lf cannot reach its script: $(head -c 200 "$lo" | tr '\n' ' ')"; ok=1
    else step "verify: launcher $lf reaches its script (rc $lrc)"; fi
  done
  de=$ENGINE_DIR/defaults.error
  if [ "$(sha "$de")" = "$DE_BEFORE" ]; then step "verify: defaults.error not rewritten"
  else step "verify FAILED: $de was written during the deploy: $(head -c 200 "$de" 2>/dev/null)"; ok=1; fi
  return $ok
}

do_deploy() {
  YES=$3
  do_check "$1" "$2" || exit 1
  NEWSHA=$(sha "$NEW")
  resolve_roots
  note ""
  note "== plan"
  note "0 maintenance hold: hooks start no engine for up to ${HOLD_TTL}s (refreshed each step, released at the end; 0 = off)"
  note "1 stop the engine ($BIN stop)"
  i=0; for r in $ROOTS; do i=$((i + 1)); note "2.$i sync engine/defaults + engine/defaults.pristine$([ "$SCOPE" = tree ] && echo " + the whole plugin tree$([ -n "$SRC_NODE" ] && echo " + the Node backup tree at $r/$NODE_REL")") of $r (replaced files copied to the backup first, nothing deleted)"; done
  note "3 binary: $BIN -> keep as $BIN.prev; install $NEW"
  note "4 integrity record (accept) with the first root's hooks/ah-engine-integrity.sh"
  note "5 stop AGAIN, re-sync every root, release the hold, start the new binary"
  note "6 verify: sha, integrity record, roots identical after the re-sync, running daemon = new process on the new sha, force-push probe x$PROBE_N via $PROBE_ROOT, status running, no defaults fallback since the start, defaults.error unchanged"
  if [ "$YES" != 1 ]; then note ""; note "dry run: nothing was changed. Add --yes to deploy."; exit 0; fi
  [ "$NEWSHA" = "$(sha "$BIN")" ] && note "(the new binary is identical to the live one: only the defaults change)"

  ts=$(date -u +%Y%m%dT%H%M%SZ)
  BK=$BK_ROOT/$ts
  mkdir -p "$BK" || die "cannot create the backup dir $BK"
  DLOG=$BK/deploy.log; MAN=$BK/manifest.tsv; : >"$MAN"
  printf '%s\n' "$ts" >"$BK_ROOT/latest" 2>/dev/null
  DE_BEFORE=$(sha "$ENGINE_DIR/defaults.error")
  step "deploy start: new sha $NEWSHA, backup $BK, scope $SCOPE"
  mkscratch
  note_pid

  hold_set

  step "stop the engine"
  engine_stop || step "stop returned non-zero (engine not running?); continuing"
  wait_gone || step "continuing: the second stop after the swap will try again"
  window_cmd stop

  # sync_all PASS BACKUP-SUBDIR MANIFEST: defaults, pristine, then (scope tree) the rest of the plugin tree, into every root
  sync_all() {
    i=0
    for r in $ROOTS; do
      i=$((i + 1))
      step "$1 into root $i: $r"
      apply_dir "$SRC_DEF" "$r/engine/defaults" "$BK/$2root$i/defaults" "$3" || fail_deploy "could not sync $r/engine/defaults"
      apply_dir "$SRC_PRI" "$r/engine/defaults.pristine" "$BK/$2root$i/defaults.pristine" "$3" || fail_deploy "could not sync $r/engine/defaults.pristine"
      if [ "$SCOPE" = tree ]; then
        apply_tree "$SRC_TREE" "$r" "$BK/$2root$i/tree" "$3" || fail_deploy "could not sync the plugin tree into $r"
        step "  plugin tree: $(cat "$SCRATCH/tree.n") file(s) changed in root $i"
        if [ -n "$SRC_NODE" ]; then
          apply_tree "$SRC_NODE" "$r/$NODE_REL" "$BK/$2root$i/node" "$3" || fail_deploy "could not sync the Node backup tree into $r/$NODE_REL"
          step "  node backup tree: $(cat "$SCRATCH/tree.n") file(s) changed at $r/$NODE_REL"
        fi
      fi
    done
  }
  # STAGE everything first (the live files are untouched, so an old binary run directly still reads the old defaults), then COMMIT
  # with renames only, defaults and binary together: the window in which the old binary could see half-new defaults is milliseconds
  PEND=$SCRATCH/pending.tsv; : >"$PEND"
  sync_all "stage defaults" "" "$MAN"
  step "stage the binary"
  mkdir -p "$ENGINE_DIR/bin" || fail_deploy "cannot create $ENGINE_DIR/bin"
  had=0
  if [ -e "$BIN" ]; then
    had=1
    if [ -e "$BIN.prev" ]; then cp -p "$BIN.prev" "$BK/ah-engine.prev.before" || fail_deploy "cannot back up the old .prev"; fi
    cp -p "$BIN" "$BIN.prev.new.$$" || fail_deploy "cannot keep the old binary as .prev"
  fi
  printf 'B\t%s\t%s\n' "$BIN" "$had" >>"$MAN"
  cp -p "$NEW" "$BIN.new.$$" && chmod +x "$BIN.new.$$" || fail_deploy "cannot stage the new binary at $BIN"

  step "commit: rename the staged files and the binary into place"
  commit_pending || fail_deploy "a staged file could not be renamed into place"
  PEND=
  [ "$had" = 1 ] && { mv "$BIN.prev.new.$$" "$BIN.prev" || fail_deploy "cannot keep the old binary as .prev"; }
  mv "$BIN.new.$$" "$BIN" || fail_deploy "cannot install the new binary at $BIN"
  step "swap done"

  integ=$(printf '%s\n' "$ROOTS" | head -n 1)/hooks/ah-engine-integrity.sh
  if [ -f "$integ" ]; then
    ( HOME=$H AH_ENGINE_DIR=$ENGINE_DIR AH_ENGINE_PLUGIN_ROOT=$(printf '%s\n' "$ROOTS" | head -n 1); export HOME AH_ENGINE_DIR AH_ENGINE_PLUGIN_ROOT; lim sh "$integ" accept >/dev/null 2>&1 )
    step "integrity record accepted ($integ)"
  else step "no $integ: integrity record not updated"; fi
  window_cmd swap

  # A hook that got through in the window may have started the OLD binary, and it read the NEW defaults. Stop whatever runs now,
  # put the defaults (and tree) back in order (a re-sync copies only what differs; what it replaces goes to resync/), start the new binary.
  step "stop the engine again (kills any daemon started from the old binary in the window)"
  note_pid
  engine_stop || step "second stop returned non-zero; continuing"
  wait_gone || fail_deploy "a daemon from before the swap is still running after the second stop (pid(s) $SEEN)"
  sync_all "re-sync defaults" "resync/" ""
  hold_release
  step "maintenance hold released"
  step "start the new binary (warm-up hook call through $PROBE_ROOT)"
  ( HOME=$H AH_ENGINE_DIR=$ENGINE_DIR CLAUDE_PLUGIN_ROOT=$PROBE_ROOT; export HOME AH_ENGINE_DIR CLAUDE_PLUGIN_ROOT
    printf '%s' '{"session_id":"deploy-warm","cwd":"'"$SCRATCH"'","hook_event_name":"SessionStart"}' >"$SCRATCH/warm.json"
    if [ -n "$TB" ]; then "$TB" -k 5 "$CALL_T" sh "$PROBE_ROOT/hooks/ah-hook.sh" SessionStart <"$SCRATCH/warm.json" >/dev/null 2>&1
    else sh "$PROBE_ROOT/hooks/ah-hook.sh" SessionStart <"$SCRATCH/warm.json" >/dev/null 2>&1; fi ) || true
  w=0; while [ "$w" -lt "$CALL_T" ] && { dp=$(daemon_pid); [ -z "$dp" ] || ! kill -0 "$dp" 2>/dev/null; }; do sleep 1; w=$((w + 1)); done
  DT_START=$(num_in_section "$( HOME=$H AH_ENGINE_DIR=$ENGINE_DIR AH_ENGINE_PLUGIN_ROOT=$(printf '%s\n' "$ROOTS" | head -n 1); export HOME AH_ENGINE_DIR AH_ENGINE_PLUGIN_ROOT; lim "$BIN" status --json 2>/dev/null )" defaults total)

  if verify_live; then step "DEPLOY OK: new binary and defaults live; undo with: sh $0 --rollback --yes"; exit 0; fi
  fail_deploy "verification failed (see the lines above)"
}

# --- rollback ---------------------------------------------------------------------------------------------------------
do_rollback() {
  from=$1; YES=$2
  [ -n "$from" ] || { [ -f "$BK_ROOT/latest" ] && from=$BK_ROOT/$(cat "$BK_ROOT/latest"); }
  [ -n "$from" ] && [ -f "$from/manifest.tsv" ] || die "no deploy backup to roll back (looked in $BK_ROOT); use --from <backup-dir>"
  note "== rollback of $from"
  nf=$(grep -c '^F' "$from/manifest.tsv"); note "restore $nf defaults file(s) from the backup (files the deploy added are moved aside, not deleted)"
  if [ -e "$BIN.prev" ]; then note "restore the binary: $BIN.prev -> $BIN"; else note "no $BIN.prev: the binary stays as it is"; fi
  if [ "$YES" != 1 ]; then note "dry run: nothing was changed. Add --yes to roll back."; exit 0; fi
  RB=$from/rollback-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$RB/replaced" "$RB/added" || die "cannot create $RB"
  DLOG=$RB/rollback.log
  step "rollback start"
  rr=
  while IFS="$(printf '\t')" read -r kind a b c d; do
    [ "$kind" = F ] && rr=${rr:-$a}
  done <"$from/manifest.tsv"
  ( HOME=$H AH_ENGINE_DIR=$ENGINE_DIR; export HOME AH_ENGINE_DIR; [ -n "$rr" ] && AH_ENGINE_PLUGIN_ROOT=$(dirname "$(dirname "$rr")") && export AH_ENGINE_PLUGIN_ROOT; lim "$BIN" stop >/dev/null 2>&1 ) || step "stop returned non-zero; continuing"
  k=0
  while IFS="$(printf '\t')" read -r kind dst file had bk; do
    [ "$kind" = F ] || continue
    k=$((k + 1))
    mkdir -p "$RB/replaced/$k" "$RB/added/$k"
    if [ -e "$dst/$file" ]; then
      if [ "$had" = 1 ]; then cp -p "$dst/$file" "$RB/replaced/$k/$file" || die "cannot keep $dst/$file"
      else mv "$dst/$file" "$RB/added/$k/$file" || die "cannot move $dst/$file aside"; fi
    fi
    if [ "$had" = 1 ]; then
      cp -p "$bk" "$dst/.$file.rollback.$$" && mv "$dst/.$file.rollback.$$" "$dst/$file" || die "cannot restore $dst/$file from $bk"
    fi
  done <"$from/manifest.tsv"
  step "defaults restored ($k file(s))"
  if [ -e "$BIN.prev" ]; then
    cp -p "$BIN" "$RB/replaced/ah-engine" 2>/dev/null
    cp -p "$BIN.prev" "$BIN.rb.$$" && mv "$BIN.rb.$$" "$BIN" || die "cannot restore the binary from $BIN.prev"
    step "binary restored from $BIN.prev (sha $(sha "$BIN" | cut -c1-12))"
    r1=${rr:+$(dirname "$(dirname "$rr")")}
    if [ -n "$r1" ] && [ -f "$r1/hooks/ah-engine-integrity.sh" ]; then
      ( HOME=$H AH_ENGINE_DIR=$ENGINE_DIR AH_ENGINE_PLUGIN_ROOT=$r1; export HOME AH_ENGINE_DIR AH_ENGINE_PLUGIN_ROOT; lim sh "$r1/hooks/ah-engine-integrity.sh" accept >/dev/null 2>&1 )
      step "integrity record accepted for the restored binary"
    fi
  fi
  step "ROLLBACK OK: the next hook call starts the restored engine"
  exit 0
}

# --- main -------------------------------------------------------------------------------------------------------------
usage() {
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
mode=; YES=0; FROM=; pos1=; pos2=
while [ $# -gt 0 ]; do
  case $1 in
    --check|--deploy|--rollback) [ -z "$mode" ] || usage; mode=$1 ;;
    --yes) YES=1 ;;
    --allow-drop) ALLOW_DROP=1 ;;
    --scope) shift; SCOPE=${1:-}; [ -n "$SCOPE" ] || usage ;;
    --from) shift; FROM=${1:-}; [ -n "$FROM" ] || usage ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) if [ -z "$pos1" ]; then pos1=$1; elif [ -z "$pos2" ]; then pos2=$1; else usage; fi ;;
  esac
  shift
done
case $mode in
  --check) [ -n "$pos2" ] || usage; do_check "$pos1" "$pos2"; exit $? ;;
  --deploy) [ -n "$pos2" ] || usage; do_deploy "$pos1" "$pos2" "$YES" ;;
  --rollback) do_rollback "$FROM" "$YES" ;;
  *) usage ;;
esac
