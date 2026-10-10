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
    *) echo "ah-update: unknown argument '$1' (see --help)" >&2; exit 2 ;;
  esac
  shift
done

test_mode=0
[ "${AH_WRAPPER_TEST:-}" = 1 ] && test_mode=1
here=$(CDPATH= cd -- "$(dirname "$0")" 2>/dev/null && pwd) || { echo "ah-update: cannot resolve the script directory" >&2; exit 1; }
proot=$(CDPATH= cd -- "$here/.." 2>/dev/null && pwd)
[ -n "$cfg_file" ] || cfg_file=$proot/engine/ah-update.toml
[ -f "$cfg_file" ] || { echo "ah-update: settings file missing: $cfg_file" >&2; exit 1; }
[ -n "${HOME:-}" ] || { echo "ah-update: HOME is not set" >&2; exit 1; }

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
  && [ -n "$sums_asset" ] && [ -n "$commit_asset" ] || { echo "ah-update: $cfg_file is missing required keys" >&2; exit 1; }

dir=$HOME/.anti-hall/ah-engine
bindir=$dir/bin
bin=$bindir/ah-engine
log=$dir/update.log
mkdir -p "$bindir" 2>/dev/null || { echo "ah-update: cannot create $bindir" >&2; exit 1; }
say() {
  printf '%s\n' "$*" 2>/dev/null
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$log" 2>/dev/null
  return 0
}
vsay() { [ "$verbose" -eq 1 ] && say "$@"; return 0; }
if [ -f "$log" ] && [ "$(wc -c <"$log" 2>/dev/null || echo 0)" -gt 65536 ]; then
  tail -n 200 "$log" >"$log.new" 2>/dev/null && mv -f "$log.new" "$log" 2>/dev/null
fi

tmp=; lockdir=$dir/update.lock; have_lock=0
cleanup() {
  [ -n "$tmp" ] && rm -rf "$tmp"
  [ "$have_lock" -eq 1 ] && rmdir "$lockdir" 2>/dev/null
  return 0
}
die() { say "ah-update: $*"; cleanup; trap - 0; exit 1; }
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
  echo "usage: ah-update.sh --from FILE [--sha256 X] [--yes] | --channel $ch_stable|$ch_dev | --rollback | --auto   (see --help)" >&2
  exit 2
fi
if [ -n "$channel" ] && [ "$channel" != "$ch_stable" ] && [ "$channel" != "$ch_dev" ]; then
  echo "ah-update: unknown channel '$channel' (use $ch_stable or $ch_dev)" >&2; exit 2
fi
if [ -n "$sha_arg" ] && ! is_sha "$sha_arg"; then echo "ah-update: --sha256 must be 64 lowercase hex digits" >&2; exit 2; fi
[ -z "$from_file" ] || [ -f "$from_file" ] || { echo "ah-update: no such file: $from_file" >&2; exit 2; }

# One update at a time; a lock older than 10 minutes is stale.
if ! mkdir "$lockdir" 2>/dev/null; then
  if [ -n "$(find "$lockdir" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rmdir "$lockdir" 2>/dev/null; mkdir "$lockdir" 2>/dev/null || die "another update is running ($lockdir)"
  else
    die "another update is running ($lockdir)"
  fi
fi
have_lock=1
tmp=$dir/update.tmp.$$
rm -rf "$tmp"; mkdir -p "$tmp" || die "cannot create $tmp"

# ---- environment -------------------------------------------------------------------------------------------------------------
kit=${AH_LIVE_KIT:-$HOME/.anti-hall/ah-engine-live}
live=0
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
    [ -n "$prev" ] && [ -x "$prev/ah-engine" ] || die "nothing to roll back to: no $kit/bundle.pre-update-* from a previous ah-update"
    smoke "$prev/ah-engine" || die "the previous engine does not run here; nothing changed"
    [ "$dry" -eq 0 ] || { say "dry run: would restore $prev (engine $smoke_version) and re-apply go-live"; exit 0; }
    ts=$(date +%Y%m%d-%H%M%S)
    mv "$kit/bundle" "$kit/bundle.pre-rollback-$ts" || die "cannot move the current bundle aside"
    mv "$prev" "$kit/bundle" || { mv "$kit/bundle.pre-rollback-$ts" "$kit/bundle"; die "cannot restore $prev"; }
    if ! blim "$tmp/golive.out" "$t_live" sh "$kit/go-live.sh" "$live_select"; then
      tail -5 "$tmp/golive.out" >&2
      mv "$kit/bundle" "$kit/bundle.failed-$ts"; mv "$kit/bundle.pre-rollback-$ts" "$kit/bundle"
      die "go-live re-apply failed; the current bundle is back in place"
    fi
    say "rolled back: live kit re-applied with the previous bundle (engine $smoke_version); the replaced one is kept as $kit/bundle.pre-rollback-$ts"
    exit 0
  fi
  [ -x "$bin.prev" ] || die "nothing to roll back to: $bin.prev does not exist"
  smoke "$bin.prev" || die "the previous binary does not run here; nothing changed"
  [ "$dry" -eq 0 ] || { say "dry run: would restore $bin.prev (engine $smoke_version)"; exit 0; }
  if [ -f "$bin" ]; then cp -p "$bin" "$bin.swap.$$" || die "cannot copy $bin"; fi
  mv -f "$bin.prev" "$bin" || die "cannot restore $bin.prev"
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
case "$triple" in ""|unsupported) [ -z "$from_file" ] && die "unsupported platform; nothing to download" ;; esac

# ---- obtain the candidate: $tmp/asset (the file whose sha256 is verified), $tmp/new (the binary) ---------------------------------
expected=; expect_src=; want_version=; commit=; tag=
if [ -n "$from_file" ]; then
  base=$(basename "$from_file")
  cp "$from_file" "$tmp/asset" || die "cannot read $from_file"
  got=$(sha256_of "$tmp/asset")
  is_sha "$got" || die "no sha256 tool available (sha256sum, shasum or openssl)"
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
    [ "$got" = "$expected" ] || die "sha256 mismatch for $base: expected $expected (from $expect_src), got $got; refusing to install"
    say "verified: sha256 of $base matches $expect_src"
  else
    say "no expected sha256 given (no --sha256, no SHA256SUMS next to the file, no lock entry for $base)"
    say "  sha256($base) = $got"
    if [ "$yes" -ne 1 ]; then
      say "  re-run with --sha256 $got (after checking it against the source of the file) or add --yes to accept it"
      cleanup; trap - 0; exit 3
    fi
    say "  accepted with --yes"
  fi
  src_label="file $from_file"
else
  if [ "$channel" = "$ch_dev" ]; then prefix=$pre_dev; else prefix=$pre_stable; fi
  list=$tmp/releases.json
  fetch "$api_base/repos/$repo/releases?per_page=$per_page" "$list" || die "cannot list releases at $api_base/repos/$repo/releases"
  tag=$(sed -n "s/^[[:space:]]*\"tag_name\"[[:space:]]*:[[:space:]]*\"\\(${prefix}[0-9A-Za-z._-]*\\)\".*/\\1/p" "$list" | head -1)
  [ -n "$tag" ] || die "no release with tag prefix '$prefix' (channel $channel) among the latest $per_page"
  case "$tag" in *[!0-9A-Za-z._-]*) die "bad release tag '$tag'" ;; esac
  [ "$channel" = "$ch_stable" ] && want_version=${tag#"$pre_stable"}
  asset=$tag-$triple.tar.gz
  say "channel $channel: latest is $tag; fetching $asset"
  fetch "$download_base/$tag/$sums_asset" "$tmp/SUMS" || die "cannot download $sums_asset of $tag"
  fetch "$download_base/$tag/$asset" "$tmp/asset" || die "cannot download $asset (does $tag publish $triple?)"
  expected=$(awk -v n="$asset" '$2==n || $2=="*" n {print $1; exit}' "$tmp/SUMS")
  is_sha "$expected" || die "$sums_asset of $tag has no entry for $asset"
  got=$(sha256_of "$tmp/asset")
  is_sha "$got" || die "no sha256 tool available (sha256sum, shasum or openssl)"
  [ "$got" = "$expected" ] || die "sha256 mismatch for $asset: $sums_asset says $expected, got $got; refusing to install"
  say "verified: sha256 of $asset matches the release $sums_asset"
  if [ "$channel" = "$ch_stable" ] && [ "$(lock_field version)" = "$want_version" ]; then
    lk=$(lock_field "$asset")
    if is_sha "$lk"; then
      [ "$lk" = "$got" ] || die "sha256 of $asset differs from this plugin's ah-engine.lock ($lk); refusing to install"
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
      die "build attestation check FAILED for $asset; refusing to install"
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
  [ -n "$member" ] || die "the archive has no <dir>/ah-engine member"
  tar -xzOf "$tmp/asset" "$member" >"$tmp/new" 2>/dev/null || die "cannot extract $member"
else
  cp "$tmp/asset" "$tmp/new" || die "cannot stage the binary"
fi
[ -s "$tmp/new" ] || die "the binary is empty"
chmod 755 "$tmp/new"

# ---- smoke test --------------------------------------------------------------------------------------------------------------
smoke "$tmp/new" "$want_version" || die "the new binary failed its smoke test; $bin is unchanged"
say "smoke test: ok (engine $smoke_version)"
newsha=$(sha256_of "$tmp/new")
cursha=; [ -f "$bin" ] && cursha=$(sha256_of "$bin")

if [ -n "$extract_to" ]; then
  cp "$tmp/new" "$extract_to" || die "cannot write $extract_to"
  chmod 755 "$extract_to"
  [ -z "$commit" ] || printf '%s\n' "$commit" >"$extract_to.commit"
  say "extracted: verified engine $smoke_version from $src_label (sha256 $newsha) written to $extract_to${commit:+; commit $commit}; nothing installed"
  exit 0
fi

# dev channel on a live kit: the matching plugin files (the commit recorded in the pre-release)
newplug=
if [ "$channel" = "$ch_dev" ] && [ "$no_plugin" -eq 0 ]; then
  if [ "$live" -eq 1 ]; then
    [ -n "$commit" ] || die "the pre-release $tag records no commit ($commit_asset); cannot sync the plugin (use --no-plugin to install the engine only)"
    command -v git >/dev/null 2>&1 || die "git is required to sync the plugin files (or use --no-plugin)"
    command -v tar >/dev/null 2>&1 || die "tar is required"
    g=$tmp/git; mkdir -p "$g" "$tmp/src"
    git -C "$g" init -q || die "git init failed"
    blim "$tmp/git.out" "$t_git" env GIT_TERMINAL_PROMPT=0 git -C "$g" fetch -q --depth 1 "$git_url" "$commit" \
      || { tail -3 "$tmp/git.out" >&2; die "cannot fetch plugin commit $commit from $git_url"; }
    git -C "$g" archive FETCH_HEAD plugins/anti-hall | tar -x -C "$tmp/src" 2>/dev/null || die "cannot extract plugins/anti-hall at $commit"
    newplug=$tmp/src/plugins/anti-hall
    [ -f "$newplug/engine/defaults/index.toml" ] || die "plugin at $commit has no engine/defaults/index.toml"
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
  mkdir -p "$stage" || die "cannot create $stage"
  cp "$tmp/new" "$stage/ah-engine" || die "cannot stage the engine"
  if [ -n "$newplug" ]; then cp -R "$newplug" "$stage/plugin" || die "cannot stage the plugin"
  else cp -R "$kit/bundle/plugin" "$stage/plugin" || die "cannot stage the current plugin"; fi
  # a plugin-shipped lock would make the bootstrap replace the bundled engine (go-live refuses it)
  [ ! -e "$stage/plugin/ah-engine.lock" ] || mv "$stage/plugin/ah-engine.lock" "$stage/ah-engine.lock.not-shipped"
  printf 'source: ah-update %s%s\nengine: %s\n%s  bundle/ah-engine\nupdated: %s\n' "$src_label" "${commit:+ (commit $commit)}" "$smoke_version" "$newsha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$stage/PROVENANCE.txt"
  if [ -f "$bin" ]; then cp -p "$bin" "$bin.prev.tmp" && mv -f "$bin.prev.tmp" "$bin.prev"; fi
  mv "$kit/bundle" "$kit/bundle.pre-update-$ts" || die "cannot move the current bundle aside"
  mv "$stage" "$kit/bundle" || { mv "$kit/bundle.pre-update-$ts" "$kit/bundle"; die "cannot install the new bundle"; }
  if ! blim "$tmp/golive.out" "$t_live" sh "$kit/go-live.sh" "$live_select"; then
    tail -8 "$tmp/golive.out" >&2
    mv "$kit/bundle" "$kit/bundle.failed-$ts"; mv "$kit/bundle.pre-update-$ts" "$kit/bundle"
    die "go-live re-apply failed (the kit rolls itself back); the previous bundle is back in place, the new one is kept as $kit/bundle.failed-$ts"
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
cp "$tmp/new" "$bin.new.$$" || die "cannot stage $bin.new.$$"
chmod 755 "$bin.new.$$"
if [ -f "$bin" ]; then
  cp -p "$bin" "$bin.prev.tmp" && mv -f "$bin.prev.tmp" "$bin.prev" || { rm -f "$bin.new.$$" "$bin.prev.tmp"; die "cannot keep the previous binary as .prev; nothing changed"; }
fi
mv -f "$bin.new.$$" "$bin" || { rm -f "$bin.new.$$"; die "cannot install $bin"; }
printf '%s %s %s\n' "$(date +%s 2>/dev/null)" "$src_label" "$newsha" >"$dir/update.installed" 2>/dev/null
say "updated: $bin is engine $smoke_version from $src_label (sha256 $newsha)${cursha:+; previous kept as $bin.prev (undo: ah-update.sh --rollback)}"
restart_daemon
exit 0
