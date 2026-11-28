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

# JSON helpers (SessionStart notices). Claude Code never shows the stderr of a hook that exits 0, so the notice is also printed as
# JSON on stdout (systemMessage for the user, additionalContext for the model). The template is plugin text; the script only
# fills {text}.
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r\t' '   '; }
json_notice() { # json_notice TEXT: the whole notice object
  TPL=$(m msg.install_notice_json_template | sed 's/\\"/"/g') NOTICE=$(json_escape "$1") awk 'BEGIN {
    t = ENVIRON["TPL"]; n = ENVIRON["NOTICE"]; o = ""
    while ((i = index(t, "{text}")) > 0) { o = o substr(t, 1, i - 1) n; t = substr(t, i + 6) }
    print o t }'
}
json_merge() { # json_merge TEXT OUT: the client's own SessionStart output with the notice added (never a second JSON object).
  # Exit 0 only when the notice is in the printed output; 1 when it could not be added (plain text, no JSON object, a systemMessage
  # that is not a string), so the caller marks it shown only when it was. An existing systemMessage / additionalContext string gets
  # the notice appended; a missing one is added.
  _o=$(printf '%s' "$2" | tr '\n\r\t' '   ' | sed 's/^ *//; s/ *$//')
  case "$_o" in
    "") json_notice "$1"; return 0 ;;
    "{"*"}")
      if [ "$(printf '%s' "$_o" | tr -d ' ')" = '{}' ]; then json_notice "$1"; return 0; fi
      _r=$(printf '%s\n' "$_o" | NOTICE=$(json_escape "$1") awk '
        function app(s, key, add,   p, rest, off, i, c) {
          p = index(s, "\"" key "\"")
          if (!p) return ""
          rest = substr(s, p + length(key) + 2)
          if (!match(rest, /^ *: *"/)) return ""
          off = p + length(key) + 2 + RLENGTH
          for (i = off; i <= length(s); i++) { c = substr(s, i, 1); if (c == "\\") { i++; continue } if (c == "\"") break }
          if (i > length(s)) return ""
          return substr(s, 1, i - 1) (i > off ? " " : "") add substr(s, i)
        }
        function head(s) { match(s, /^\{ */); return RLENGTH }
        {
          n = ENVIRON["NOTICE"]; r = $0
          if (index(r, "\"systemMessage\"")) { r = app(r, "systemMessage", n); if (r == "") exit 3 }
          else { h = head(r); r = substr(r, 1, h) "\"systemMessage\":\"" n "\"," substr(r, h + 1) }
          if (index(r, "\"additionalContext\"")) { x = app(r, "additionalContext", n); if (x != "") r = x }
          else if (!index(r, "\"hookSpecificOutput\"")) {
            h = head(r); r = substr(r, 1, h) "\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"" n "\"}," substr(r, h + 1)
          } else {
            # a hookSpecificOutput object without additionalContext: add the key at its start; any other shape cannot take it
            p = index(r, "\"hookSpecificOutput\""); rest = substr(r, p + 20)
            if (!match(rest, /^ *: *\{ */)) exit 3
            at = p + 20 + RLENGTH - 1
            r = substr(r, 1, at) "\"additionalContext\":\"" n "\"," substr(r, at + 1)
          }
          print r
        }') || { printf '%s\n' "$2"; return 1; }
      printf '%s\n' "$_r"; return 0 ;;
    *) printf '%s\n' "$2"; return 1 ;;
  esac
}

# #368: the installed engine (the installer's marker) is older than the release ah-engine.lock pins, or it could not load this
# plugin's defaults (its defaults.error is newer than both the plugin's defaults and the engine binary: it is rewritten at every
# failure and never removed, so an older one belongs to a defaults set that is gone): ONE line on stderr (the same text the thin
# client prints), once per host process, and the thin client is told so it stays quiet. The same text is left in notice_text for the
# JSON notice (once per host process; empty when off or already shown). Nothing is downloaded; any problem (no lock, no marker,
# unreadable or odd version text) says nothing. Versions compare by their numbers, with the old plugin-numbering floor
# (launcher.legacy_scheme_floor) counting as older, exactly as the thin client compares them.
notice_text=
notice_kind=
stale_notice() {
  notice_text=
  want=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/$(c launcher.engine_lock_file)" 2>/dev/null | head -n 1)
  have=$(awk '{ print $1; exit }' "$state/$(c install.file_marker)" 2>/dev/null)
  case "$want$have" in *[!0-9A-Za-z.+-]*) return 0 ;; esac
  dfail=0
  derr=$state/$(c install.file_defaults_error)
  if [ -f "$derr" ] && [ -n "$(find "$derr" -newer "$cfg" 2>/dev/null)" ] \
    && { [ ! -e "$bindir/$engine_name" ] || [ -n "$(find "$derr" -newer "$bindir/$engine_name" 2>/dev/null)" ]; }; then dfail=1; fi
  # defaults.error is never removed: only an engine that fails to load the defaults NOW makes the "guards are NOT running" notice true
  if [ "$dfail" = 1 ] && [ -x "$bindir/$engine_name" ]; then
    # the two sleep durations are computed and the signal trap is installed BEFORE the probe forks: a signal after the fork finds the
    # trap already in place (an empty $pp / $wd in it is harmless: the kills are silenced)
    t1=$(awk -v v="$(c install.defaults_probe_ms)" 'BEGIN { printf "%.3f", v / 1000 }')
    t2=$(awk -v v="$(c install.defaults_probe_grace_ms)" 'BEGIN { printf "%.3f", v / 1000 }')
    pp=; wd=
    # a signal to the hook stops the watchdog AND the probe (a TERM-ignoring or hung probe must not outlive the hook)
    trap 'kill "$wd" 2>/dev/null; kill -KILL "$pp" 2>/dev/null; exit 0' HUP INT TERM
    env "$(c env.plugin_root)=$root" "$bindir/$engine_name" "$(c install.defaults_probe_verb)" >/dev/null 2>&1 </dev/null &
    pp=$!
    # watchdog: TERM after defaults_probe_ms, KILL after a further defaults_probe_grace_ms (an engine that ignores TERM must not hold
    # SessionStart); the whole probe is bounded by the two settings (under 1 s together by default: every hook fails open in under 1 s).
    # The watchdog subshell owns its sleep helpers and traps TERM to kill the live one. A trap only runs between commands, so `$!`
    # already names a helper that was forked (a TERM before the trap is installed arrives before any helper exists). `$!` keeps naming
    # a helper after it is reaped, so `d` records the pid of the last REAPED helper, set right after its `wait` returns (never at
    # the fork): the trap kills `$!` unless it is the probe's pid (the subshell starts with it in `$!`) or `d`. A live helper is
    # therefore always killed and a reaped pid never is. The helper is sent KILL, not TERM: the parent's TERM can arrive just after the
    # helper forked but before it execs `sleep`, while it still carries this shell's inherited TERM trap, and the signal is swallowed
    # (the sleep then outlives the hook); KILL cannot be trapped (the one exception: a TERM between a `wait` returning and `d=$!` signals a
    # just-reaped pid, a no-op unless that pid was already reused).
    d=
    ( trap '[ "$!" = "$pp" ] || [ "$!" = "$d" ] || kill -KILL "$!" 2>/dev/null; exit 0' TERM
      sleep "$t1" & wait "$!"; d=$!; kill "$pp"; sleep "$t2" & wait "$!"; d=$!; kill -KILL "$pp" ) >/dev/null 2>&1 </dev/null &
    wd=$!
    wait "$pp" 2>/dev/null; prc=$?
    kill "$wd" 2>/dev/null
    wait "$wd" 2>/dev/null
    trap - HUP INT TERM
    # exit 0 = loads fine; 143 / 137 = our own TERM / KILL (not proof of failure); anything else = it cannot load them now
    if [ "$prc" -eq 0 ] || [ "$prc" -eq 143 ] || [ "$prc" -eq 137 ]; then dfail=0; fi
  fi
  older=
  if [ -n "$want" ] && [ -n "$have" ]; then
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
  fi
  [ "$older" = 1 ] || [ "$dfail" = 1 ] || return 0
  knob=$(c launcher.knob_stale_noticed)
  case "$knob" in ""|*[!A-Za-z0-9_]*) ;; *) eval "export $knob=1" ;; esac
  if [ "$dfail" = 1 ] && [ ! -e "$bindir/$engine_name" ]; then key=msg.install_engine_missing
  elif [ "$dfail" = 1 ]; then key=msg.install_defaults_failed
  else key=msg.launcher_stale_engine; fi
  [ -n "$have" ] || have=unknown
  [ -n "$want" ] || want=unknown
  text=$(m "$key" | sed "s|{have}|$have|g; s|{want}|$want|g")
  seen=$state/$(c install.file_stale_notice)
  if [ "$(cat "$seen" 2>/dev/null)" != "$PPID" ]; then
    printf '%s\n' "$PPID" >"$seen" 2>/dev/null
    printf '%s\n' "$text" >&2
  fi
  # marked as shown by the caller, only once the notice is really in the output
  jseen=$state/$(c install.file_json_notice)
  if [ "${host:-claude}" = claude ] && [ "$(c install.sessionstart_json_notice)" = 1 ] && [ "$(cat "$jseen" 2>/dev/null)" != "$PPID" ]; then
    notice_text=$text
    notice_kind=stale_engine
    if [ "$dfail" = 1 ]; then notice_kind=defaults_failed; [ -e "$bindir/$engine_name" ] || notice_kind=engine_missing; fi
  fi
}
# one record per JSON notice for the counters (hook mode has no -v and no `say`)
say_notice() { mkdir -p "$state" 2>/dev/null; printf '%s event=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$state/$(c install.file_notice_log)" 2>/dev/null; return 0; }

# ---- hook mode ------------------------------------------------------------------------------------------------------------------
if [ "$mode" = hook ]; then
  event=${1:-}
  # the JSON notice is for Claude Code only: Codex's SessionStart output schema is not verified to take systemMessage (the notice
  # stays on stderr there, stdout stays empty). Claude's hooks.json passes no --host; Codex's passes `--host codex`.
  host=claude; prev=
  for a in "$@"; do [ "$prev" = --host ] && host=$a; prev=$a; done
  # installed: this call is the thin client's. SessionStart comes here FIRST (hooks_form.installer_first_events), so an install whose
  # client predates the stale-engine notice still hears it; the notice never stops the hook from running.
  if [ -x "$bindir/$hook_name" ]; then
    notice_text=
    if [ "$event" = SessionStart ] && [ "$(c launcher.stale_notice_on)" != 0 ]; then stale_notice; fi
    if [ -n "$notice_text" ]; then
      # the client still runs (its SessionStart work is kept); its stdout is captured so the notice joins it as ONE JSON object
      out=$("$bindir/$hook_name" "$@"); rc=$?
      if [ "$rc" -eq 0 ]; then
        merged=$(json_merge "$notice_text" "$out") && {
          printf '%s\n' "$PPID" >"$state/$(c install.file_json_notice)" 2>/dev/null
          say_notice "notice_json kind=$notice_kind"
        }
        printf '%s\n' "$merged"
      else printf '%s\n' "$out"; fi
      exit "$rc"
    fi
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
  # an engine without its client (the 0.300 bootstrap installed only the engine) is a different state from "nothing installed"
  if [ -e "$bindir/$engine_name" ]; then
    text=$(m msg.install_notice_no_client | sed "s|{installer}|$here/install.sh|g")
  else
    text=$(m msg.install_notice)
  fi
  seen=$state/$(c install.file_notice)
  if [ "$(cat "$seen" 2>/dev/null)" != "$sid" ]; then
    printf '%s\n' "$sid" >"$seen" 2>/dev/null
    printf '%s\n' "$text" >&2
  fi
  # stderr of an exit-0 hook is not shown: SessionStart also gets the notice as JSON, once per session (every other event: stdout stays empty)
  jseen=$state/$(c install.file_json_notice)
  if [ "$event" = SessionStart ] && [ "$host" = claude ] && [ "$(c install.sessionstart_json_notice)" = 1 ] && [ "$(cat "$jseen" 2>/dev/null)" != "$sid" ]; then
    printf '%s\n' "$sid" >"$jseen" 2>/dev/null
    say_notice "notice_json kind=not_installed"
    json_notice "$text"
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
chmod 700 "$state" 2>/dev/null
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
kept=0
if [ ! -e "$bindir/$engine_name" ]; then mv -f "$tmp/$engine_name" "$bindir/$engine_name" 2>/dev/null || fail cannot_install; else esha=$(sha256_of "$bindir/$engine_name"); kept=1; fi
if [ "$have_hook" -eq 1 ]; then mv -f "$tmp/$hook_name" "$bindir/$hook_name" 2>/dev/null && hsha=$(sha256_of "$bindir/$hook_name"); else say "hook_not_in_archive"; fi
if [ "$kept" -eq 1 ]; then
  # an engine this installer put there earlier stays in place (the one implementation of the managed swap is `ah-hook install`):
  # the marker keeps describing the engine that IS installed (a 2-field 0.300 marker `<ver> <engine sha>` becomes
  # `<ver> - <engine sha> <hook sha>`), never the archive's version, and the client just installed does the swap.
  set -- $(cat "$marker" 2>/dev/null)
  if [ -n "${3:-}" ]; then oldver=$1; oldasset=$2; oldesha=$3; else oldver=${1:-}; oldasset=-; oldesha=${2:-}; fi
  if [ "$have_hook" -eq 1 ] && [ -x "$bindir/$hook_name" ] && [ -n "$oldver" ]; then
    printf '%s %s %s %s\n' "$oldver" "$oldasset" "$oldesha" "$hsha" >"$marker"
    say "engine_kept version=$oldver handover=ah-hook"
    rm -rf "$tmp" # exec skips the EXIT trap
    if [ "$verbose" -eq 1 ]; then exec "$bindir/$hook_name" --plugin-root "$root" install --lock "$lock" -v; fi
    exec "$bindir/$hook_name" --plugin-root "$root" install --lock "$lock"
  fi
  say "skip why=engine_kept_no_client"
  exit 0
fi
printf '%s %s %s %s\n' "$version" "$sha" "$esha" "$hsha" >"$marker"
# remember this engine as the expected one (the thin client owns the integrity record); best effort
[ ! -x "$bindir/$hook_name" ] || AH_ENGINE_DIR=$state "$bindir/$hook_name" --plugin-root "$root" integrity record </dev/null >/dev/null 2>&1
say "installed version=$version triple=$triple path=$bindir"
printf '%s\n' "$(subst "$(m msg.install_done)" version "$version" triple "$triple" path "$bindir")"
exit 0
