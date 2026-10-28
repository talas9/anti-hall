#!/bin/sh
# install.sh - the plugin's ONE shell file. It exists because the thin client (ah-hook) and the engine are binaries that cannot
# ship inside the plugin (per-platform, larger than the directory's per-file limit); until they are installed nothing else can run.
# Every value and text comes from the plugin's engine/defaults/*.toml; POSIX sh only; never fails a session.
#
# usage:
#   install.sh <Event> [--host codex]   hook mode (hooks.json runs this only while bin/ah-hook is missing): stdout stays empty,
#                                       exit 0, at most ONE notice line per session on stderr (msg.install_notice). It downloads
#                                       nothing unless the user opted in (setting engine.bootstrap = true, or AH_ENGINE_BOOTSTRAP=1);
#                                       then the SessionStart event starts the download in the background.
#   install.sh --download [--lock FILE] [-v]
#                                       the explicit install (the setup skill runs it): fetches ah-hook and ah-engine from the
#                                       release archive that ah-engine.lock pins, checks the sha256 pinned there (never trust on first
#                                       use), installs both atomically into ~/.anti-hall/ah-engine/bin. When ah-hook is already
#                                       installed this hands over to `ah-hook install`, the one implementation of install and update.
# Test-only knobs (honoured ONLY with AH_WRAPPER_TEST=1): AH_ENGINE_RELEASE_BASE (http and file allowed), AH_BOOTSTRAP_UNAME_S / _M /
# _R, AH_BOOTSTRAP_LIBC (gnu|musl).

# Hook mode must never lose the hook: the command line names the installed thin client in AH_CLIENT, so when anything below this
# point cannot be worked out (unreadable defaults, no HOME, a broken tool) the call is still handed to that client, stdin intact.
# Without AH_CLIENT (or while the client is not installed) a failure ends quietly with exit 0, as before.
bail() {
  case "${1:-}" in --download) exit 0 ;; esac
  if [ -n "${AH_CLIENT:-}" ] && [ -x "$AH_CLIENT" ]; then exec "$AH_CLIENT" "$@"; fi
  exit 0
}

here=$(CDPATH= cd -- "$(dirname "$0")" 2>/dev/null && pwd) || bail "$@"
root=${AH_ENGINE_PLUGIN_ROOT:-"$here/.."}
cfg=$root/engine/defaults/engine.toml
msgs=$root/engine/defaults/messages.toml
[ -f "$cfg" ] && [ -r "$cfg" ] && [ -f "$msgs" ] && [ -r "$msgs" ] || bail "$@"
[ -n "${HOME:-}" ] || bail "$@"

# the value of [KEY] in FILE: a string without its quotes, or the first token of a number
toml_value() { # toml_value FILE KEY
  awk -v want="[$2]" '
    $0 == want { in_key = 1; next }
    in_key && /^\[/ { exit }
    in_key && $1 == "value" && $2 == "=" { v = $0; sub(/^[^=]*= */, "", v); sub(/^"/, "", v); sub(/"[[:space:]]*$/, "", v); print v; exit }
  ' "$1"
}
c() { toml_value "$cfg" "$1"; }
m() { toml_value "$msgs" "$1"; }

base=$HOME/$(c paths.base_dir)
state=$base/$(c paths.state_dir)
bindir=$state/bin
engine_name=$(c install.member_engine)
hook_name=$(c install.member_hook)
[ -n "$engine_name" ] && [ -n "$hook_name" ] && [ -n "$(c paths.base_dir)" ] || bail "$@"
test_mode=0
[ "${AH_WRAPPER_TEST:-}" = 1 ] && test_mode=1

mode=hook
case "${1:-}" in --download) mode=download; shift ;; esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" 2>/dev/null | sed 's/^.*= *//'
  fi
}

# #368: the installed engine (the installer's marker) is older than the release ah-engine.lock pins: ONE line on stderr (the same text
# the thin client prints), once per host process, and the thin client is told so it stays quiet. Nothing is downloaded; any problem
# (no lock, no marker, unreadable or odd version text) says nothing. Versions compare by their numbers, with the old plugin-numbering
# floor (launcher.legacy_scheme_floor) counting as older, exactly as the thin client compares them.
stale_notice() {
  want=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/$(c launcher.engine_lock_file)" 2>/dev/null | head -n 1)
  have=$(awk '{ print $1; exit }' "$state/$(c install.file_marker)" 2>/dev/null)
  case "$want$have" in ""|*[!0-9A-Za-z.+-]*) return 0 ;; esac
  [ -n "$want" ] && [ -n "$have" ] || return 0
  older=$(awk -v a="$have" -v b="$want" -v f="$(c launcher.legacy_scheme_floor)" '
    function parse(v, arr,   n, i, k, p) {
      sub(/[ \t].*/, "", v); sub(/^v/, "", v); sub(/[+-].*/, "", v)
      n = split(v, p, "."); k = 0
      for (i = 1; i <= n; i++) { if (p[i] !~ /^[0-9]+$/) break; arr[++k] = p[i] + 0 }
      return k
    }
    function cmp(x, nx, y, ny,   i, n, u, w) {
      n = nx > ny ? nx : ny
      for (i = 1; i <= n; i++) { u = (i <= nx) ? x[i] : 0; w = (i <= ny) ? y[i] : 0; if (u < w) return -1; if (u > w) return 1 }
      return 0
    }
    BEGIN {
      nx = parse(a, X); ny = parse(b, Y); nf = parse(f, F)
      if (!nx || !ny) exit
      lx = nf && cmp(X, nx, F, nf) >= 0; ly = nf && cmp(Y, ny, F, nf) >= 0
      if (lx != ly) { if (lx) print 1; exit }
      if (cmp(X, nx, Y, ny) < 0) print 1
    }' 2>/dev/null)
  [ "$older" = 1 ] || return 0
  knob=$(c launcher.knob_stale_noticed)
  case "$knob" in ""|*[!A-Za-z0-9_]*) ;; *) eval "export $knob=1" ;; esac
  seen=$state/$(c install.file_stale_notice)
  [ "$(cat "$seen" 2>/dev/null)" != "$PPID" ] || return 0
  printf '%s\n' "$PPID" >"$seen" 2>/dev/null
  printf '%s\n' "$(m msg.launcher_stale_engine | sed "s|{have}|$have|g; s|{want}|$want|g")" >&2
}

# ---- hook mode ------------------------------------------------------------------------------------------------------------------
if [ "$mode" = hook ]; then
  event=${1:-}
  # installed: this call is the thin client's. SessionStart comes here FIRST (hooks_form.installer_first_events), so an install whose
  # client predates the stale-engine notice still hears it; the notice never stops the hook from running.
  if [ -x "$bindir/$hook_name" ]; then
    if [ "$event" = SessionStart ] && [ "$(c launcher.stale_notice_on)" != 0 ]; then stale_notice; fi
    exec "$bindir/$hook_name" "$@"
  fi
  payload=$(dd bs=4096 count=1 2>/dev/null)
  sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$sid" ] || sid=-
  # opt-in: the environment variable (0 off, 1 on) first, then the setting; absent = off
  want=0
  case "${AH_ENGINE_BOOTSTRAP:-}" in
    0) want=0 ;;
    1) want=1 ;;
    *)
      sf=$base/$(c install.settings_file)
      if [ -f "$sf" ] && tr -d '\n\r' <"$sf" 2>/dev/null \
        | grep -Eq "\"$(c install.setting_section)\"[[:space:]]*:[[:space:]]*\\{[^}]*\"$(c install.setting_key)\"[[:space:]]*:[[:space:]]*(true|\"(true|on|yes|1)\"|1)[[:space:]]*[,}]"; then want=1; fi
      ;;
  esac
  if [ "$want" = 1 ] && [ "$event" = SessionStart ] && [ -f "$root/$(c launcher.engine_lock_file)" ]; then
    ( sh "$here/install.sh" --download >/dev/null 2>&1 </dev/null & ) 2>/dev/null
  fi
  # one notice per session
  mkdir -p "$state" 2>/dev/null || exit 0
  seen=$state/$(c install.file_notice)
  if [ "$(cat "$seen" 2>/dev/null)" != "$sid" ]; then
    printf '%s\n' "$sid" >"$seen" 2>/dev/null
    printf '%s\n' "$(m msg.install_notice)" >&2
  fi
  exit 0
fi

# ---- download mode --------------------------------------------------------------------------------------------------------------
verbose=0
lock=$root/$(c launcher.engine_lock_file)
while [ "$#" -gt 0 ]; do
  case "$1" in
    --lock) lock=${2:-}; shift ;;
    -v) verbose=1 ;;
  esac
  shift
done
mkdir -p "$bindir" 2>/dev/null || exit 0
log=$state/$(c install.file_log)
say() { # say EVENT [k=v ...]: one record in the install log (and on stdout with -v)
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) event=$*"
  printf '%s\n' "$line" >>"$log" 2>/dev/null
  [ "$verbose" -eq 1 ] && printf '%s\n' "$line"
  return 0
}
subst() { # subst TEXT name value ...: replace {name} placeholders
  s=$1; shift
  while [ "$#" -ge 2 ]; do s=$(printf '%s' "$s" | sed "s|{$1}|$2|g"); shift 2; done
  printf '%s' "$s"
}
fail() {
  say "fail why=$1"
  printf '%s\n' "$(subst "$(m msg.install_failed)" why "$1")" >&2
  exit 0
}

# the thin client owns install and update once it is installed
if [ -x "$bindir/$hook_name" ]; then
  if [ "$verbose" -eq 1 ]; then exec "$bindir/$hook_name" --plugin-root "$root" install --lock "$lock" -v; fi
  exec "$bindir/$hook_name" --plugin-root "$root" install --lock "$lock"
fi

[ -f "$lock" ] || fail no_lock
flat=$(tr ',{}' '\n\n\n' <"$lock" 2>/dev/null)
field() { printf '%s\n' "$flat" | sed -n "s/^ *\"$1\" *: *\"\\([^\"]*\\)\" *\$/\\1/p" | head -n 1; }
schema=$(printf '%s\n' "$flat" | sed -n 's/^ *"schema" *: *\([0-9][0-9]*\) *$/\1/p' | head -n 1)
[ "$schema" = "$(c install.lock_schema)" ] || fail bad_lock_schema
version=$(field version)
case "$version" in [0-9]*.[0-9]*.[0-9]*) ;; *) fail bad_lock_version ;; esac
case "$version" in *[!0-9A-Za-z.-]*) fail bad_lock_version ;; esac

# the release triple of this machine
os=$(uname -s 2>/dev/null); arch=$(uname -m 2>/dev/null); rel=$(uname -r 2>/dev/null)
if [ "$test_mode" -eq 1 ]; then os=${AH_BOOTSTRAP_UNAME_S:-$os}; arch=${AH_BOOTSTRAP_UNAME_M:-$arch}; rel=${AH_BOOTSTRAP_UNAME_R:-$rel}; fi
case "$arch" in
  arm64|aarch64) cpu=$(c install.cpu_arm_name) ;;
  x86_64|amd64) cpu=$(c install.cpu_x86_name) ;;
  *) fail "unsupported_platform"  ;;
esac
case "$os" in
  "$(c install.os_macos)")
    if [ "$cpu" = "$(c install.cpu_x86_name)" ] && [ "$test_mode" -eq 0 ] && [ "$(sysctl -n "$(c install.rosetta_sysctl)" 2>/dev/null)" = 1 ]; then cpu=$(c install.cpu_arm_name); fi
    triple=$(subst "$(c install.triple_macos)" cpu "$cpu") ;;
  "$(c install.os_linux)")
    libc=$(c install.libc_default)
    if [ "$test_mode" -eq 1 ] && [ -n "${AH_BOOTSTRAP_LIBC:-}" ]; then libc=$AH_BOOTSTRAP_LIBC
    elif ls /lib/ld-musl-* /usr/lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi "$(c install.musl_word)"); then libc=$(c install.libc_musl); fi
    triple=$(subst "$(c install.triple_linux)" cpu "$cpu" libc "$libc") ;;
  *) fail unsupported_platform ;;
esac
asset=$(subst "$(c install.asset_name)" version "$version" triple "$triple")
sha=$(field "$asset")
case "$sha" in *[!0-9a-f]*|"") fail lock_has_no_sha ;; esac
[ "${#sha}" -eq 64 ] || fail lock_has_no_sha

# nothing this did not install is overwritten
marker=$state/$(c install.file_marker)
if [ -e "$bindir/$engine_name" ] && [ ! -f "$marker" ]; then say "skip why=unmanaged path=$bindir/$engine_name"; exit 0; fi

rbase=$(c install.release_base)
[ "$test_mode" -eq 1 ] && rbase=${AH_ENGINE_RELEASE_BASE:-$rbase}
url=$rbase/$(subst "$(c install.release_dir)" version "$version")/$asset
tmp=$state/$(c install.tmp_prefix)$$
rm -rf "$tmp"; mkdir -p "$tmp" 2>/dev/null || fail cannot_create_scratch
trap 'rm -rf "$tmp"' 0
say "start asset=$asset sha256=$(printf '%s' "$sha" | cut -c1-8)"
connect=$(c install.connect_timeout_s); maxtime=$(c install.max_time_s); maxsize=$(c install.max_filesize)
if command -v curl >/dev/null 2>&1; then
  if [ "$test_mode" -eq 1 ]; then curl -fsSL --connect-timeout "$connect" --max-time "$maxtime" -o "$tmp/asset" "$url" >/dev/null 2>&1 || fail download_failed
  else curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout "$connect" --max-time "$maxtime" --max-filesize "$maxsize" -o "$tmp/asset" "$url" >/dev/null 2>&1 || fail download_failed; fi
else
  fail no_downloader
fi
got=$(sha256_of "$tmp/asset")
[ -n "$got" ] || fail no_sha256_tool
[ "$got" = "$sha" ] || fail sha256_mismatch

# extract the two members by name to fixed paths, never the archive's own paths
mdir=$(subst "$(c install.member_dir)" version "$version" triple "$triple")
tar -xzOf "$tmp/asset" "$mdir/$engine_name" >"$tmp/$engine_name" 2>/dev/null || fail archive_has_no_engine
[ -s "$tmp/$engine_name" ] || fail archive_has_no_engine
chmod 755 "$tmp/$engine_name"
have_hook=0
if tar -xzOf "$tmp/asset" "$mdir/$hook_name" >"$tmp/$hook_name" 2>/dev/null && [ -s "$tmp/$hook_name" ]; then have_hook=1; chmod 755 "$tmp/$hook_name"; fi

esha=$(sha256_of "$tmp/$engine_name"); hsha=
if [ ! -e "$bindir/$engine_name" ]; then mv -f "$tmp/$engine_name" "$bindir/$engine_name" 2>/dev/null || fail cannot_install; else esha=$(sha256_of "$bindir/$engine_name"); fi
if [ "$have_hook" -eq 1 ]; then mv -f "$tmp/$hook_name" "$bindir/$hook_name" 2>/dev/null && hsha=$(sha256_of "$bindir/$hook_name"); else say "hook_not_in_archive"; fi
printf '%s %s %s %s\n' "$version" "$sha" "$esha" "$hsha" >"$marker"
# remember this engine as the expected one (the thin client owns the integrity record); best effort
[ ! -x "$bindir/$hook_name" ] || AH_ENGINE_DIR=$state "$bindir/$hook_name" --plugin-root "$root" integrity record </dev/null >/dev/null 2>&1
say "installed version=$version triple=$triple path=$bindir"
printf '%s\n' "$(subst "$(m msg.install_done)" version "$version" triple "$triple" path "$bindir")"
exit 0
