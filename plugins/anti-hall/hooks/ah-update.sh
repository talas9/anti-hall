#!/bin/sh
# ah-update: move the local ah-engine binary to an offline file, the latest stable release or the latest dev pre-release,
# in one command. Thin POSIX sh on purpose: not part of the engine (a broken engine must stay fixable; the engine has no
# network code). Every URL, timeout and channel name comes from engine/ah-update.toml in the plugin (D88).
#
# usage:
#   ah-update.sh --from FILE [--sha256 X] [--yes]   offline: FILE is a release .tar.gz or a bare binary. Expected sha256 =
#                                                   --sha256, else the SHA256SUMS next to FILE, else the plugin's ah-engine.lock;
#                                                   with none of them the sha is printed and --yes is required.
#   ah-update.sh --channel stable                   latest ah-engine-v* release
#   ah-update.sh --channel dev                      latest ah-engine-dev-<sha8> pre-release (also syncs the matching plugin
#                                                   files when the live kit is installed)
#   ah-update.sh --rollback                         restore the previous binary (bin/ah-engine.prev); run twice to toggle
#   ah-update.sh --auto                             honour the engine.autoUpdate setting (off|stable|dev) and the daily limit
# options: --dry-run (verify + smoke test, install nothing)  --extract-to PATH (verify + smoke test, write the binary to PATH and the
#          recorded commit, if any, to PATH.commit, install nothing: used by the live-kit installer)  --no-restart  --no-plugin  --live-select LIST  -v  --config FILE
#          --json (accepted, ignored)
# Online sources are verified against the release's SHA256SUMS and, when `gh` is installed and logged in, the GitHub build
# attestation (`gh attestation verify`); without gh that step is skipped with a note.
# Steps: verify -> smoke test (`<new> version`) -> atomic swap into $HOME/.anti-hall/ah-engine/bin (previous kept as .prev)
#        -> restart the daemon (the engine's own `stop` and `serve`). Nothing is deleted; a failure at any step keeps the old binary.
# Live kit (a machine switched over by ~/.anti-hall/ah-engine-live/go-live.sh): the binary and plugin are installed THROUGH the
# kit (bundle/ + go-live.sh re-apply), so the kit's rollback keeps working; --rollback restores the previous bundle and re-applies.
# Test-only knobs (honoured ONLY with AH_WRAPPER_TEST=1): AH_UPDATE_API_BASE, AH_UPDATE_DOWNLOAD_BASE, AH_UPDATE_GIT_URL,
# AH_UPDATE_TRIPLE, AH_UPDATE_NO_ATTEST=1. AH_LIVE_KIT overrides the kit directory.
# Failures (#143) always say three things: `ah-update: <what failed>`, `  state: <what is installed now: unchanged, or what was
# rolled back>` and `  next: <one exact next step>`. A usage error (exit 2) prints `ah-update: <what is wrong>` and a `  usage:` hint.
# Exit: 0 done / already current / nothing to do, 1 failed (old binary kept), 2 usage, 3 --yes needed.

from_file=; sha_arg=; channel=; do_rollback=0; auto=0; yes=0; dry=0; no_restart=0; no_plugin=0; verbose=0
cfg_file=; live_select=all-agreeing; extract_to=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --from) from_file=${2:-}; shift ;;
    --sha256) sha_arg=${2:-}; shift ;;
    --channel) channel=${2:-}; shift ;;
    --rollback) do_rollback=1 ;;
    --auto) auto=1 ;;
    --yes|-y) yes=1 ;;
    --dry-run) dry=1 ;;
    --extract-to) extract_to=${2:-}; shift ;;
    --no-restart) no_restart=1 ;;
    --no-plugin) no_plugin=1 ;;
    --live-select) live_select=${2:-all-agreeing}; shift ;;
    --config) cfg_file=${2:-}; shift ;;
    -v) verbose=1 ;;
    --json) ;;
    -h|--help) sed -n '2,/^# Exit:/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf "ah-update: unknown argument '%s'\n  usage: %s\n" "$1" "ah-update.sh --from FILE [--sha256 X] [--yes] | --channel stable|dev | --rollback | --auto   (ah-update.sh --help lists every option)" >&2; exit 2 ;;
  esac
  shift
done

test_mode=0
[ "${AH_WRAPPER_TEST:-}" = 1 ] && test_mode=1
# efail WHAT STATE NEXT: a failure before the log exists (stderr only).
efail() { printf 'ah-update: %s\n  state: %s\n  next: %s\n' "$1" "$2" "$3" >&2; exit 1; }
here=$(CDPATH= cd -- "$(dirname "$0")" 2>/dev/null && pwd) || efail "cannot work out which directory the script is in" "nothing changed" "run it by its full path: sh /path/to/plugins/anti-hall/hooks/ah-update.sh <your arguments>"
proot=$(CDPATH= cd -- "$here/.." 2>/dev/null && pwd)
[ -n "$cfg_file" ] || cfg_file=$proot/engine/ah-update.toml
[ -f "$cfg_file" ] || efail "the updater's settings file is missing: $cfg_file" "nothing changed" "reinstall the anti-hall plugin so engine/ah-update.toml is back (claude plugin update anti-hall), or pass --config FILE"
[ -n "${HOME:-}" ] || efail "HOME is not set, so the engine directory cannot be found" "nothing changed" "run it with HOME set: HOME=/home/you sh $0 <your arguments>"

# cfg KEY: the value of a `KEY = value` line (quotes and a trailing comment dropped); empty when absent.
cfg() { sed -n "s/^$1[[:space:]]*=[[:space:]]*\"\{0,1\}\([^\"#]*[^\"# ]\)\"\{0,1\}[[:space:]]*\(#.*\)\{0,1\}\$/\1/p" "$cfg_file" | head -1; }
num() { v=$(cfg "$1"); case "$v" in ""|*[!0-9]*) v=$2 ;; esac; printf '%s' "$v"; }
repo=$(cfg repo); api_base=$(cfg api_base); download_base=$(cfg download_base); git_url=$(cfg git_url)
ch_stable=$(cfg channel_stable); ch_dev=$(cfg channel_dev); pre_stable=$(cfg tag_prefix_stable); pre_dev=$(cfg tag_prefix_dev)
default_channel=$(cfg default_channel); sums_asset=$(cfg sums_asset); commit_asset=$(cfg commit_asset)
per_page=$(num list_per_page 30); t_conn=$(num connect_timeout_s 10); t_dl=$(num download_timeout_s 180); run_s=$(num run_timeout_s 20)
t_git=$(num git_timeout_s 240); t_live=$(num go_live_timeout_s 600); max_bytes=$(num max_download_bytes 134217728)
auto_interval=$(num auto_interval_s 86400)
if [ "$test_mode" -eq 1 ]; then
  api_base=${AH_UPDATE_API_BASE:-$api_base}; download_base=${AH_UPDATE_DOWNLOAD_BASE:-$download_base}; git_url=${AH_UPDATE_GIT_URL:-$git_url}
fi
case "$run_s" in 0) run_s=20 ;; esac
[ -n "$repo" ] && [ -n "$api_base" ] && [ -n "$download_base" ] && [ -n "$ch_stable" ] && [ -n "$ch_dev" ] && [ -n "$pre_stable" ] && [ -n "$pre_dev" ] \
  && [ -n "$sums_asset" ] && [ -n "$commit_asset" ] \
  || efail "$cfg_file is missing required keys (repo, api_base, download_base, channel_stable, channel_dev, tag_prefix_stable, tag_prefix_dev, sums_asset, commit_asset)" "nothing changed" "restore the file from the plugin (claude plugin update anti-hall) and run again" 

dir=$HOME/.anti-hall/ah-engine
bindir=$dir/bin
bin=$bindir/ah-engine
log=$dir/update.log
mkdir -p "$bindir" 2>/dev/null || efail "cannot create $bindir" "nothing changed" "fix the permissions of $dir (mkdir -p $bindir) and run again" 
say() {
  printf '%s\n' "$*" 2>/dev/null
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$log" 2>/dev/null
  return 0
}
vsay() { [ "$verbose" -eq 1 ] && say "$@"; return 0; }
if [ -f "$log" ] && [ "$(wc -c <"$log" 2>/dev/null || echo 0)" -gt 65536 ]; then
  tail -n 200 "$log" >"$log.new" 2>/dev/null && mv -f "$log.new" "$log" 2>/dev/null
fi

tmp=; lockdir=$dir/update.lock; have_lock=0; live=0; kit=${AH_LIVE_KIT:-$HOME/.anti-hall/ah-engine-live}
cleanup() {
  [ -n "$tmp" ] && rm -rf "$tmp"
  [ "$have_lock" -eq 1 ] && rmdir "$lockdir" 2>/dev/null
  return 0
}
# fail WHAT STATE NEXT: every failure says what failed, what is installed now, and the one exact next step.
fail() {
  say "ah-update: $1"
  say "  state: $2"
  say "  next: $3"
  cleanup; trap - 0; exit 1
}
# unchanged: the state line of a failure that touched nothing ("nothing changed - engine 1.2.3 is still active").
unchanged() {
  uv=
  if [ "$live" -eq 1 ] && [ -x "$kit/bundle/ah-engine" ]; then ub=$kit/bundle/ah-engine; else ub=$bin; fi
  if [ -x "$ub" ] && [ -d "$tmp" ]; then
    AH_ENGINE_PLUGIN_ROOT=$proot AH_ENGINE_DIR=$tmp/state blim "$tmp/cur.out" 5 "$ub" version && uv=$(head -1 "$tmp/cur.out")
  fi
  case "$uv" in [0-9]*) printf 'nothing changed - engine %s is still active' "$uv" ;; *) printf 'nothing changed - the installed engine is still active' ;; esac
}
# usage_err WHAT: a usage error (exit 2) with the usage hint, no state line (nothing was attempted).
usage_err() {
  printf 'ah-update: %s\n  usage: ah-update.sh --from FILE [--sha256 X] [--yes] | --channel %s|%s | --rollback | --auto   (ah-update.sh --help lists every option)\n' "$1" "$ch_stable" "$ch_dev" >&2
  exit 2
}
# A closed output pipe (`ah-update.sh | head`) must not kill an update half way and leave the lock behind.
trap '' PIPE
trap 'cleanup; exit 1' HUP INT TERM
trap cleanup 0

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" 2>/dev/null | sed 's/^.*= *//'
  fi
}
is_sha() { case "$1" in ""|*[!0-9a-f]*) return 1 ;; esac; [ "${#1}" -eq 64 ]; }

# blim OUTFILE LIMIT CMD...: run CMD (stdin /dev/null, stdout to OUTFILE) with a hard limit of LIMIT seconds; TERM, then KILL 2 s later.
# Returns 124 on timeout.
blim() {
  bl_out=$1; bl_lim=$2; shift 2
  "$@" </dev/null >"$bl_out" 2>&1 &
  bl_p=$!
  ( n=0; while [ "$n" -lt "$bl_lim" ]; do sleep 1; kill -0 "$bl_p" 2>/dev/null || exit 0; n=$((n + 1)); done
    : >"$bl_out.timedout"; kill -TERM "$bl_p" 2>/dev/null; sleep 2; kill -KILL "$bl_p" 2>/dev/null ) >/dev/null 2>&1 &
  bl_w=$!
  wait "$bl_p" 2>/dev/null; bl_r=$?
  kill "$bl_w" 2>/dev/null; wait "$bl_w" 2>/dev/null
  if [ -f "$bl_out.timedout" ]; then rm -f "$bl_out.timedout"; return 124; fi
  return "$bl_r"
}

# fetch URL OUTFILE: HTTPS download (http only in test mode) with the configured limits.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    if [ "$test_mode" -eq 1 ]; then
      curl -fsSL --connect-timeout "$t_conn" --max-time "$t_dl" -o "$2" "$1" >/dev/null 2>&1
    else
      curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout "$t_conn" --max-time "$t_dl" --max-filesize "$max_bytes" -o "$2" "$1" >/dev/null 2>&1
    fi
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T "$t_dl" -O "$2" "$1" >/dev/null 2>&1
  else
    return 127
  fi
}

# settings: the engine object of $HOME/.anti-hall/settings.json (flattened); empty when absent.
engine_settings() {
  sf=$HOME/.anti-hall/settings.json
  [ -f "$sf" ] || return 0
  tr -d '\n\r' <"$sf" 2>/dev/null | sed -n 's/.*"engine"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p'
}

# ---- lock (the plugin's pinned release; used to verify an offline file and to cross-check stable) ----------------------------
lock=$proot/ah-engine.lock
lock_field() { [ -f "$lock" ] || return 0; tr ',{}' '\n\n\n' <"$lock" 2>/dev/null | sed -n "s/^ *\"$1\" *: *\"\\([^\"]*\\)\" *\$/\\1/p" | head -1; }

# ---- auto mode: setting + daily limit -------------------------------------------------------------------------------------
if [ "$auto" -eq 1 ]; then
  case "${AH_ENGINE_AUTO_UPDATE:-}" in
    ""|*[!0-9A-Za-z]*) setting=$(engine_settings | sed -n 's/.*"auto[_]\{0,1\}[Uu]pdate"[[:space:]]*:[[:space:]]*"\{0,1\}\([A-Za-z]*\)"\{0,1\}.*/\1/p' | head -1) ;;
    *) setting=$AH_ENGINE_AUTO_UPDATE ;;
  esac
  case "$setting" in
    "$ch_stable"|"$ch_dev") channel=$setting ;;
    true|on|yes|1) channel=${default_channel:-$ch_stable} ;;
    *) exit 0 ;;
  esac
  now=$(date +%s 2>/dev/null || echo 0)
  last=$(cat "$dir/update.checked" 2>/dev/null)
  case "$last" in ""|*[!0-9]*) last=0 ;; esac
  if [ "$now" -gt 0 ] && [ $((now - last)) -lt "$auto_interval" ]; then exit 0; fi
  printf '%s\n' "$now" >"$dir/update.checked" 2>/dev/null
  yes=1
fi

# ---- argument sanity ---------------------------------------------------------------------------------------------------------
n=0
[ -n "$from_file" ] && n=$((n + 1)); [ -n "$channel" ] && n=$((n + 1)); [ "$do_rollback" -eq 1 ] && n=$((n + 1))
if [ "$n" -ne 1 ]; then
  if [ "$n" -eq 0 ]; then usage_err "nothing to do: give exactly one of --from, --channel, --rollback or --auto"
  else usage_err "give exactly one of --from, --channel, --rollback or --auto, not several"; fi
fi
if [ -n "$channel" ] && [ "$channel" != "$ch_stable" ] && [ "$channel" != "$ch_dev" ]; then
  usage_err "unknown channel '$channel' (use $ch_stable or $ch_dev)"
fi
if [ -n "$sha_arg" ] && ! is_sha "$sha_arg"; then usage_err "--sha256 must be 64 lowercase hex digits (sha256sum FILE prints one)"; fi
[ -z "$from_file" ] || [ -f "$from_file" ] || usage_err "no such file: $from_file (--from takes a release .tar.gz or a bare ah-engine binary)"

# One update at a time; a lock older than 10 minutes is stale.
if ! mkdir "$lockdir" 2>/dev/null; then
  if [ -n "$(find "$lockdir" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rmdir "$lockdir" 2>/dev/null; mkdir "$lockdir" 2>/dev/null || fail "another update is running ($lockdir)" "$(unchanged); the running update carries on" "wait for it to finish, then run this again; if none is running, remove the lock: rmdir $lockdir"
  else
    fail "another update is running ($lockdir)" "$(unchanged); the running update carries on" "wait for it to finish, then run this again; if none is running, remove the lock: rmdir $lockdir"
  fi
fi
have_lock=1
tmp=$dir/update.tmp.$$
rm -rf "$tmp"; mkdir -p "$tmp" || fail "cannot create the work directory $tmp" "nothing changed" "free some disk space or fix the permissions of $dir, then run again"

# ---- environment -------------------------------------------------------------------------------------------------------------
[ -f "$kit/state/live.json" ] && [ -f "$kit/go-live.sh" ] && live=1
kit_plugin_root() { # the plugin root the daemon should load while the kit is live (the installed live plugin), else this plugin
  if [ "$live" -eq 1 ] && [ -d "$kit/bundle/plugin/engine/defaults" ]; then printf '%s' "$kit/bundle/plugin"; else printf '%s' "$proot"; fi
}

# smoke BINARY EXPECTED_VERSION: `<binary> version` must answer within the limit with a version (and the expected one, if known).
smoke() {
  AH_ENGINE_PLUGIN_ROOT=$proot AH_ENGINE_DIR=$tmp/state blim "$tmp/version.out" "$run_s" "$1" version
  rc=$?
  [ "$rc" -ne 124 ] || { say "smoke test: '$1 version' did not answer within ${run_s}s"; return 1; }
  [ "$rc" -eq 0 ] || { say "smoke test: '$1 version' failed (exit $rc): $(head -c 200 "$tmp/version.out" | tr '\n' ' ')"; return 1; }
  reported=$(head -1 "$tmp/version.out")
  case "$reported" in [0-9]*) ;; *) say "smoke test: '$1 version' printed '$reported', not a version"; return 1 ;; esac
  if [ -n "${2:-}" ]; then case "$reported" in *"$2"*) ;; *) say "smoke test: binary reports '$reported', expected $2"; return 1 ;; esac; fi
  smoke_version=$reported
  return 0
}

# restart_daemon: the engine's own verbs. `stop` tells a running daemon to exit (no daemon is fine), `serve` starts the new one.
restart_daemon() {
  [ "$no_restart" -eq 0 ] || { say "daemon: restart skipped (--no-restart); the next hook call starts the new one"; return 0; }
  edir=${AH_ENGINE_DIR:-$dir}
  pr=$(kit_plugin_root)
  if [ "$auto" -eq 1 ]; then # the job runs under the daemon being replaced: finish the restart detached
    ( sleep 1; AH_ENGINE_PLUGIN_ROOT=$pr AH_ENGINE_DIR=$edir "$bin" stop </dev/null >/dev/null 2>&1; sleep 1
      AH_ENGINE_PLUGIN_ROOT=$pr AH_ENGINE_DIR=$edir nohup "$bin" serve </dev/null >/dev/null 2>&1 & ) >/dev/null 2>&1 &
    say "daemon: restart scheduled"
    return 0
  fi
  AH_ENGINE_PLUGIN_ROOT=$pr AH_ENGINE_DIR=$edir blim "$tmp/stop.out" "$run_s" "$bin" stop || vsay "daemon: stop reported nothing to stop"
  sleep 1
  AH_ENGINE_PLUGIN_ROOT=$pr AH_ENGINE_DIR=$edir nohup "$bin" serve </dev/null >/dev/null 2>&1 &
  i=0
  while [ "$i" -lt 10 ]; do
    if AH_ENGINE_PLUGIN_ROOT=$pr AH_ENGINE_DIR=$edir blim "$tmp/status.out" "$run_s" "$bin" status; then say "daemon: restarted ($bin serve)"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  say "daemon: started but not confirmed by 'status' yet; the next hook call starts it if needed"
  return 0
}

# ---- rollback ----------------------------------------------------------------------------------------------------------------
if [ "$do_rollback" -eq 1 ]; then
  if [ "$live" -eq 1 ]; then
    prev=$(ls -d "$kit"/bundle.pre-update-* 2>/dev/null | LC_ALL=C sort | tail -1)
    [ -n "$prev" ] && [ -x "$prev/ah-engine" ] || fail "nothing to roll back to: there is no $kit/bundle.pre-update-* from an earlier ah-update" "$(unchanged)" "update first (ah-update.sh --channel stable, or dev); --rollback then has an earlier bundle to restore"
    smoke "$prev/ah-engine" || fail "the previous engine ($prev/ah-engine) does not run on this machine (see the smoke test line above)" "$(unchanged)" "install a fresh build instead: ah-update.sh --channel stable"
    [ "$dry" -eq 0 ] || { say "dry run: would restore $prev (engine $smoke_version) and re-apply go-live"; exit 0; }
    ts=$(date +%Y%m%d-%H%M%S)
    mv "$kit/bundle" "$kit/bundle.pre-rollback-$ts" || fail "cannot move the current bundle aside ($kit/bundle)" "$(unchanged)" "check that you can write in $kit, then run ah-update.sh --rollback again"
    mv "$prev" "$kit/bundle" || { mv "$kit/bundle.pre-rollback-$ts" "$kit/bundle"; fail "cannot restore $prev as the live bundle" "rolled back: the bundle that was current is back in place at $kit/bundle" "check that you can write in $kit, then run ah-update.sh --rollback again"; }
    if ! blim "$tmp/golive.out" "$t_live" sh "$kit/go-live.sh" "$live_select"; then
      tail -5 "$tmp/golive.out" >&2
      mv "$kit/bundle" "$kit/bundle.failed-$ts"; mv "$kit/bundle.pre-rollback-$ts" "$kit/bundle"
      fail "the live kit could not re-apply the previous bundle (go-live.sh exited with an error; its last lines are above)" "rolled back: the bundle that was current is back in place at $kit/bundle; the previous one is kept as $kit/bundle.failed-$ts" "read the log (tail -n 30 $log), fix what go-live reports, then run ah-update.sh --rollback again; to re-apply the current bundle by hand: sh $kit/go-live.sh $live_select"
    fi
    say "rolled back: live kit re-applied with the previous bundle (engine $smoke_version); the replaced one is kept as $kit/bundle.pre-rollback-$ts"
    exit 0
  fi
  [ -x "$bin.prev" ] || fail "nothing to roll back to: $bin.prev does not exist" "$(unchanged)" "an update keeps the previous binary as .prev, so run one first (ah-update.sh --channel stable), or install a known build: ah-update.sh --from FILE"
  smoke "$bin.prev" || fail "the previous binary ($bin.prev) does not run on this machine (see the smoke test line above)" "$(unchanged)" "install a fresh build instead: ah-update.sh --channel stable"
  [ "$dry" -eq 0 ] || { say "dry run: would restore $bin.prev (engine $smoke_version)"; exit 0; }
  if [ -f "$bin" ]; then cp -p "$bin" "$bin.swap.$$" || fail "cannot copy $bin aside to swap it with .prev" "$(unchanged)" "free some disk space or fix the permissions of $bindir, then run ah-update.sh --rollback again"; fi
  mv -f "$bin.prev" "$bin" || fail "cannot move $bin.prev into place as $bin" "nothing was replaced: $bin is as it was" "fix the permissions of $bindir, then run ah-update.sh --rollback again"
  [ ! -f "$bin.swap.$$" ] || mv -f "$bin.swap.$$" "$bin.prev"
  say "rolled back: $bin is now engine $smoke_version (the replaced binary is kept as .prev; --rollback again toggles)"
  restart_daemon
  exit 0
fi

# ---- target ------------------------------------------------------------------------------------------------------------------
if [ "$test_mode" -eq 1 ] && [ -n "${AH_UPDATE_TRIPLE:-}" ]; then
  triple=$AH_UPDATE_TRIPLE
else
  triple=$(AH_ENGINE_BOOTSTRAP=1 sh "$here/ah-engine-bootstrap.sh" --print-target 2>/dev/null)
fi
case "$triple" in ""|unsupported) [ -z "$from_file" ] && fail "no ah-engine build is published for this platform" "$(unchanged)" "install a binary you built or obtained for this platform: ah-update.sh --from FILE --sha256 <sha256 of FILE>" ;; esac

# ---- obtain the candidate: $tmp/asset (the file whose sha256 is verified), $tmp/new (the binary) ---------------------------------
expected=; expect_src=; want_version=; commit=; tag=
if [ -n "$from_file" ]; then
  base=$(basename "$from_file")
  cp "$from_file" "$tmp/asset" || fail "cannot read $from_file" "$(unchanged)" "check that the file is readable by this user (ls -l $from_file), then run again"
  got=$(sha256_of "$tmp/asset")
  is_sha "$got" || fail "no sha256 tool is installed (sha256sum, shasum or openssl), so $base cannot be verified" "$(unchanged)" "install coreutils (sha256sum) or openssl, then run again"""
  if [ -n "$sha_arg" ]; then expected=$sha_arg; expect_src="--sha256"
  else
    sums=$(dirname "$from_file")/SHA256SUMS
    if [ -f "$sums" ]; then
      e=$(awk -v n="$base" '$2==n || $2=="*" n {print $1; exit}' "$sums")
      if is_sha "$e"; then expected=$e; expect_src="$sums"; fi
    fi
    if [ -z "$expected" ]; then
      e=$(lock_field "$base")
      if is_sha "$e"; then expected=$e; expect_src="$lock"; fi
    fi
  fi
  if [ -n "$expected" ]; then
    [ "$got" = "$expected" ] || fail "the checksum of $base does not match: expected $expected (from $expect_src), got $got" "$(unchanged); the file was not installed" "get a fresh copy of the file together with its SHA256SUMS from the release page and run again; if it still differs, do not install it"
    say "verified: sha256 of $base matches $expect_src"
  else
    say "no expected sha256 given (no --sha256, no SHA256SUMS next to the file, no lock entry for $base)"
    say "  sha256($base) = $got"
    if [ "$yes" -ne 1 ]; then
      say "ah-update: $base cannot be verified: nothing to compare its checksum with"
      say "  state: $(unchanged); the file was not installed"
      say "  next: check the sha256 above against the source of the file, then re-run with --sha256 $got (or add --yes to accept it as is)"
      cleanup; trap - 0; exit 3
    fi
    say "  accepted with --yes"
  fi
  src_label="file $from_file"
else
  if [ "$channel" = "$ch_dev" ]; then prefix=$pre_dev; else prefix=$pre_stable; fi
  list=$tmp/releases.json
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    fail "neither curl nor wget is installed, so nothing can be downloaded" "$(unchanged)" "install curl (or wget), or fetch the release yourself and use: ah-update.sh --from FILE"""
  fi
  fetch "$api_base/repos/$repo/releases?per_page=$per_page" "$list" \
    || fail "cannot reach $api_base/repos/$repo/releases to look up the latest $channel build (network down, offline, or rate limited)" "$(unchanged)" "check the connection and run again: ah-update.sh --channel $channel"
  tag=$(sed -n "s/^[[:space:]]*\"tag_name\"[[:space:]]*:[[:space:]]*\"\\(${prefix}[0-9A-Za-z._-]*\\)\".*/\\1/p" "$list" | head -1)
  if [ -z "$tag" ]; then
    if [ "$channel" = "$ch_dev" ]; then other=$ch_stable; else other=$ch_dev; fi
    fail "no $channel build is published yet (no release tagged '${prefix}...' among the latest $per_page releases of $repo)" "$(unchanged)" "retry after a build is published (a push to the engine branch publishes one), or use the other channel: ah-update.sh --channel $other"
  fi
  case "$tag" in *[!0-9A-Za-z._-]*) fail "the release tag '$tag' has characters a tag never has" "$(unchanged)" "do not install it; report it at https://github.com/$repo/issues and run again later" ;; esac
  [ "$channel" = "$ch_stable" ] && want_version=${tag#"$pre_stable"}
  asset=$tag-$triple.tar.gz
  say "channel $channel: latest is $tag; fetching $asset"
  fetch "$download_base/$tag/$sums_asset" "$tmp/SUMS" || fail "cannot download the checksum file $sums_asset of $tag (the release may still be uploading, or the network dropped)" "$(unchanged)" "wait a few minutes and run again: ah-update.sh --channel $channel"
  fetch "$download_base/$tag/$asset" "$tmp/asset" || fail "cannot download $asset ($tag may not publish a build for $triple, or the network dropped)" "$(unchanged)" "retry later with ah-update.sh --channel $channel, or install a build you have: ah-update.sh --from FILE"
  expected=$(awk -v n="$asset" '$2==n || $2=="*" n {print $1; exit}' "$tmp/SUMS")
  is_sha "$expected" || fail "the checksum file $sums_asset of $tag has no entry for $asset" "$(unchanged)" "the release is probably still being assembled: wait a few minutes and run again: ah-update.sh --channel $channel"
  got=$(sha256_of "$tmp/asset")
  is_sha "$got" || fail "no sha256 tool is installed (sha256sum, shasum or openssl), so $asset cannot be verified" "$(unchanged)" "install coreutils (sha256sum) or openssl, then run again"
  [ "$got" = "$expected" ] || fail "the checksum of the downloaded $asset does not match: $sums_asset says $expected, got $got" "$(unchanged); the download was discarded" "run the same command again (a cut-off download is the usual cause); if it differs again, do not install it and report it at https://github.com/$repo/issues"
  say "verified: sha256 of $asset matches the release $sums_asset"
  if [ "$channel" = "$ch_stable" ] && [ "$(lock_field version)" = "$want_version" ]; then
    lk=$(lock_field "$asset")
    if is_sha "$lk"; then
      [ "$lk" = "$got" ] || fail "the checksum of $asset differs from this plugin's ah-engine.lock ($lk)" "$(unchanged); the download was discarded" "update the plugin (claude plugin update anti-hall) so its lock matches the release, or use --channel dev; do not install a build that disagrees with the lock"
      say "verified: also matches this plugin's ah-engine.lock"
    fi
  fi
  # build attestation
  if [ "$test_mode" -eq 1 ] && [ "${AH_UPDATE_NO_ATTEST:-}" = 1 ]; then
    say "attestation: skipped (test mode)"
  elif command -v gh >/dev/null 2>&1; then
    if blim "$tmp/attest.out" "$t_dl" gh attestation verify "$tmp/asset" --repo "$repo"; then
      say "verified: GitHub build attestation for $asset (repo $repo)"
    elif ! gh auth status >/dev/null 2>&1; then
      say "attestation: skipped, gh is not logged in (gh auth login enables it)"
    else
      tail -3 "$tmp/attest.out" >&2
      fail "the GitHub build attestation check failed for $asset (repo $repo; the gh output is above)" "$(unchanged); the download was discarded" "do not install this build; run gh attestation verify yourself against the release asset, and report it at https://github.com/$repo/issues if it fails there too"
    fi
  else
    say "attestation: skipped, gh is not installed (install gh to verify the GitHub build attestation)"
  fi
  if [ "$channel" = "$ch_dev" ]; then
    if fetch "$download_base/$tag/$commit_asset" "$tmp/COMMIT"; then
      commit=$(tr -d ' \n\r' <"$tmp/COMMIT")
      case "$commit" in ""|*[!0-9a-f]*) commit= ;; esac
      [ "${#commit}" -eq 40 ] || commit=
    fi
  fi
  src_label="$channel $tag"
fi

# extract the binary: the one member <top>/ah-engine of a release archive, or the file itself when it is not an archive
if tar -tzf "$tmp/asset" >/dev/null 2>&1; then
  member=$(tar -tzf "$tmp/asset" 2>/dev/null | grep -E '^[^/]+/ah-engine$' | head -1)
  [ -n "$member" ] || fail "the downloaded archive has no <dir>/ah-engine member" "$(unchanged)" "this file is not an engine release archive: pass the .tar.gz of an ah-engine release, or the bare binary, to --from"
  tar -xzOf "$tmp/asset" "$member" >"$tmp/new" 2>/dev/null || fail "cannot extract $member from the downloaded archive" "$(unchanged)" "the archive is damaged: download it again and run again"
else
  cp "$tmp/asset" "$tmp/new" || fail "cannot stage the binary in $tmp" "$(unchanged)" "free some disk space or fix the permissions of $dir, then run again"
fi
[ -s "$tmp/new" ] || fail "the engine file is empty" "$(unchanged)" "get the file again (it may have been cut off) and run again"
chmod 755 "$tmp/new"

# ---- smoke test --------------------------------------------------------------------------------------------------------------
smoke "$tmp/new" "$want_version" || fail "the new engine does not run on this machine (see the smoke test line above)" "$(unchanged); $bin was not replaced" "try the other channel (ah-update.sh --channel $ch_stable) or report the platform and the line above at https://github.com/$repo/issues"
say "smoke test: ok (engine $smoke_version)"
newsha=$(sha256_of "$tmp/new")
cursha=; [ -f "$bin" ] && cursha=$(sha256_of "$bin")

if [ -n "$extract_to" ]; then
  cp "$tmp/new" "$extract_to" || fail "cannot write the verified engine to $extract_to" "$(unchanged); nothing was installed" "choose a writable path for --extract-to and run again"
  chmod 755 "$extract_to"
  [ -z "$commit" ] || printf '%s\n' "$commit" >"$extract_to.commit"
  say "extracted: verified engine $smoke_version from $src_label (sha256 $newsha) written to $extract_to${commit:+; commit $commit}; nothing installed"
  exit 0
fi

# dev channel on a live kit: the matching plugin files (the commit recorded in the pre-release)
newplug=
if [ "$channel" = "$ch_dev" ] && [ "$no_plugin" -eq 0 ]; then
  if [ "$live" -eq 1 ]; then
    [ -n "$commit" ] || fail "the pre-release $tag does not record which plugin commit it was built from (no $commit_asset)" "$(unchanged)" "install the engine alone: ah-update.sh --channel $channel --no-plugin"
    command -v git >/dev/null 2>&1 || fail "git is not installed, and the live kit's plugin files are fetched with it" "$(unchanged)" "install git, or install the engine alone: ah-update.sh --channel $channel --no-plugin"
    command -v tar >/dev/null 2>&1 || fail "tar is not installed, and it is needed to unpack the plugin files" "$(unchanged)" "install tar, then run again"
    g=$tmp/git; mkdir -p "$g" "$tmp/src"
    git -C "$g" init -q || fail "git could not set up a scratch repository in $g" "$(unchanged)" "free some disk space or fix the permissions of $dir, then run again"
    blim "$tmp/git.out" "$t_git" env GIT_TERMINAL_PROMPT=0 git -C "$g" fetch -q --depth 1 "$git_url" "$commit" \
      || { tail -3 "$tmp/git.out" >&2; fail "cannot fetch the plugin files of commit $commit from $git_url (the git output is above)" "$(unchanged)" "check the connection and run again, or install the engine alone: ah-update.sh --channel $channel --no-plugin"; }
    git -C "$g" archive FETCH_HEAD plugins/anti-hall | tar -x -C "$tmp/src" 2>/dev/null || fail "cannot unpack plugins/anti-hall of commit $commit" "$(unchanged)" "run again; if it repeats, install the engine alone: ah-update.sh --channel $channel --no-plugin"
    newplug=$tmp/src/plugins/anti-hall
    [ -f "$newplug/engine/defaults/index.toml" ] || fail "the plugin files of commit $commit are incomplete (no engine/defaults/index.toml)" "$(unchanged)" "wait for the next pre-release, or install the engine alone: ah-update.sh --channel $channel --no-plugin"
    say "plugin: $commit (plugins/anti-hall) fetched for the live kit"
  else
    say "plugin: not synced (the live kit is not installed). The dev engine reads its settings from the plugin: install the matching plugin files (install-shadow-remote.sh --live) or the engine may drift from them"
  fi
fi

if [ "$dry" -eq 1 ]; then
  say "dry run: would install engine $smoke_version from $src_label (sha256 $newsha); nothing changed"
  exit 0
fi

# ---- install -----------------------------------------------------------------------------------------------------------------
if [ "$live" -eq 1 ]; then
  if [ "$newsha" = "$(sha256_of "$kit/bundle/ah-engine" 2>/dev/null)" ]; then
    same=0
    if [ -z "$newplug" ]; then same=1
    else # the plugin must match too (the lock is never shipped into the bundle)
      mkdir -p "$tmp/cmp" && cp -R "$newplug" "$tmp/cmp/plugin" && rm -f "$tmp/cmp/plugin/ah-engine.lock"
      diff -rq "$tmp/cmp/plugin" "$kit/bundle/plugin" >/dev/null 2>&1 && same=1
    fi
    if [ "$same" -eq 1 ]; then
      say "already current: the live kit bundle holds this exact engine${newplug:+ and plugin} (sha256 $newsha); nothing to do"
      exit 0
    fi
  fi
  ts=$(date +%Y%m%d-%H%M%S)
  stage=$kit/bundle.new-$ts
  mkdir -p "$stage" || fail "cannot create $stage in the live kit" "$(unchanged)" "check that you can write in $kit, then run again"
  cp "$tmp/new" "$stage/ah-engine" || fail "cannot copy the new engine into $stage" "$(unchanged); the half-built $stage is left in place" "free some disk space, then run again"
  if [ -n "$newplug" ]; then cp -R "$newplug" "$stage/plugin" || fail "cannot copy the new plugin files into $stage" "$(unchanged); the half-built $stage is left in place" "free some disk space, then run again"
  else cp -R "$kit/bundle/plugin" "$stage/plugin" || fail "cannot copy the current plugin files into $stage" "$(unchanged); the half-built $stage is left in place" "free some disk space, then run again"; fi
  # a plugin-shipped lock would make the bootstrap replace the bundled engine (go-live refuses it)
  [ ! -e "$stage/plugin/ah-engine.lock" ] || mv "$stage/plugin/ah-engine.lock" "$stage/ah-engine.lock.not-shipped"
  printf 'source: ah-update %s%s\nengine: %s\n%s  bundle/ah-engine\nupdated: %s\n' "$src_label" "${commit:+ (commit $commit)}" "$smoke_version" "$newsha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$stage/PROVENANCE.txt"
  if [ -f "$bin" ]; then cp -p "$bin" "$bin.prev.tmp" && mv -f "$bin.prev.tmp" "$bin.prev"; fi
  mv "$kit/bundle" "$kit/bundle.pre-update-$ts" || fail "cannot move the current bundle ($kit/bundle) aside" "$(unchanged)" "check that you can write in $kit, then run again"
  mv "$stage" "$kit/bundle" || { mv "$kit/bundle.pre-update-$ts" "$kit/bundle"; fail "cannot put the new bundle ($stage) in place" "rolled back: the bundle that was current is back in place at $kit/bundle" "check that you can write in $kit, then run again"; }
  if ! blim "$tmp/golive.out" "$t_live" sh "$kit/go-live.sh" "$live_select"; then
    tail -8 "$tmp/golive.out" >&2
    mv "$kit/bundle" "$kit/bundle.failed-$ts"; mv "$kit/bundle.pre-update-$ts" "$kit/bundle"
    fail "the live kit could not apply the new bundle (go-live.sh exited with an error; its last lines are above)" "rolled back: the bundle that was current is back in place at $kit/bundle; the new one is kept as $kit/bundle.failed-$ts" "read the log (tail -n 30 $log), fix what go-live reports, then run again; to re-apply the current bundle by hand: sh $kit/go-live.sh $live_select"
  fi
  printf '%s live %s %s\n' "$(date +%s 2>/dev/null)" "$src_label" "$newsha" >"$dir/update.installed" 2>/dev/null
  say "updated through the live kit: engine $smoke_version${commit:+, plugin $commit}; previous bundle kept as $kit/bundle.pre-update-$ts (undo: ah-update.sh --rollback)"
  restart_daemon
  exit 0
fi

if [ -n "$cursha" ] && [ "$cursha" = "$newsha" ]; then
  say "already current: $bin is this exact binary (sha256 $newsha); nothing to do"
  exit 0
fi
cp "$tmp/new" "$bin.new.$$" || fail "cannot copy the new engine next to $bin" "$(unchanged)" "free some disk space or fix the permissions of $bindir, then run again"
chmod 755 "$bin.new.$$"
if [ -f "$bin" ]; then
  cp -p "$bin" "$bin.prev.tmp" && mv -f "$bin.prev.tmp" "$bin.prev" || { rm -f "$bin.new.$$" "$bin.prev.tmp"; fail "cannot keep the current binary as $bin.prev before replacing it" "$(unchanged)" "free some disk space or fix the permissions of $bindir, then run again"; }
fi
mv -f "$bin.new.$$" "$bin" || { rm -f "$bin.new.$$"; fail "cannot move the new engine into place as $bin" "$(unchanged); the previous binary is kept as $bin.prev" "fix the permissions of $bindir, then run again; to put the previous binary back: ah-update.sh --rollback"; }
printf '%s %s %s\n' "$(date +%s 2>/dev/null)" "$src_label" "$newsha" >"$dir/update.installed" 2>/dev/null
say "updated: $bin is engine $smoke_version from $src_label (sha256 $newsha)${cursha:+; previous kept as $bin.prev (undo: ah-update.sh --rollback)}"
restart_daemon
exit 0
