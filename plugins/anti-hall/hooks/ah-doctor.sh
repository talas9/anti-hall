#!/bin/sh
# Shell doctor: `sh hooks/ah-hook.sh --doctor [--check] [--quiet]` (the wrapper hands over to this file).
#
# The fallback of `ah-engine doctor` for the case where the engine binary cannot run at all (missing, corrupt, wrong architecture,
# quarantined, defaults unloadable). POSIX sh plus the tools the wrapper itself needs; it needs neither the engine nor Node, never
# writes anything and never signals a process. It prints the engine doctor's format and, for every check both make, the engine
# doctor's exact finding text (a test compares them). What it checks: the engine binary (kind, mode, header, OS, architecture,
# Rosetta, quarantine, digest vs the bootstrap's marker, version vs the plugin's lock, whether `version` runs), the state directory,
# the daemon's files (socket, lock, run marker, cooldowns), the plugin's defaults and pristine copy, the thin hooks files, HOME,
# PATH, the tools, git and Node. The repairs and everything that needs the engine (live guard tests, migrations) stay with
# `ah-engine doctor`.
# Test-only knobs (honored ONLY with AH_WRAPPER_TEST=1): AH_BOOTSTRAP_UNAME_S / _M / _R (as in the bootstrap), AH_DOCTOR_ROSETTA
# (path of the file that means Rosetta is installed).

root=${AH_ENGINE_PLUGIN_ROOT:-}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --quiet|--check) : ;;
    --plugin-root) root=${2:-}; shift ;;
  esac
  shift
done
test_mode=0
[ "${AH_WRAPPER_TEST:-}" = 1 ] && test_mode=1
dir=$(CDPATH= cd -- "$(dirname "$0")" 2>/dev/null && pwd)
[ -n "$root" ] || root=$(CDPATH= cd -- "$dir/.." 2>/dev/null && pwd)
home=${HOME:-}
pass=0; fail=0; warn=0

# ---- messages (the engine doctor's texts: plugins/anti-hall/engine/defaults/doctor.toml) -------------------------------------
head_() { printf '\n%s\n' "$1"; }
ok() { pass=$((pass + 1)); printf '  ✅ %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  ❌ %s\n' "$1"; }
warnl() { warn=$((warn + 1)); printf '  ⚠️ %s\n' "$1"; }
infol() { printf '  i %s\n' "$1"; }

# first_line FILE... : the first non-empty line of stdin, trimmed, at most 160 characters
first_line() { sed -n 's/^[[:space:]]*//;s/[[:space:]]*$//;/./{p;q;}' | cut -c1-160; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" 2>/dev/null | sed 's/^.*= *//'
  fi
}

# perm_octal FILE : the permission bits as octal digits (644, 755)
perm_octal() {
  ls -ldL "$1" 2>/dev/null | cut -c2-10 | awk '{
    n = ""; for (i = 0; i < 3; i++) { v = 0; s = substr($0, i * 3 + 1, 3)
      if (substr(s, 1, 1) != "-") v += 4; if (substr(s, 2, 1) != "-") v += 2; if (substr(s, 3, 1) !~ /[-S]/) v += 1; n = n v }
    print n }'
}

# blim OUTFILE SECS CMD... : run CMD (stdin /dev/null, stdout+stderr to OUTFILE) for at most SECS seconds. 124 on timeout.
blim() {
  bl_out=$1; bl_secs=$2; shift 2
  "$@" </dev/null >"$bl_out" 2>&1 &
  bl_p=$!
  ( n=0; while [ "$n" -lt "$bl_secs" ]; do sleep 1; kill -0 "$bl_p" 2>/dev/null || exit 0; n=$((n + 1)); done
    : >"$bl_out.timedout"; kill -TERM "$bl_p" 2>/dev/null; sleep 1; kill -KILL "$bl_p" 2>/dev/null ) >/dev/null 2>&1 &
  bl_w=$!
  wait "$bl_p" 2>/dev/null; bl_r=$?
  kill "$bl_w" 2>/dev/null; wait "$bl_w" 2>/dev/null
  if [ -f "$bl_out.timedout" ]; then rm -f "$bl_out.timedout"; return 124; fi
  return "$bl_r"
}

# ---- facts --------------------------------------------------------------------------------------------------------------------
version=unknown
if [ -f "$root/.claude-plugin/plugin.json" ]; then
  v=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$root/.claude-plugin/plugin.json" | head -1)
  [ -n "$v" ] && version=$v
fi

uname_s=$(uname -s 2>/dev/null); uname_m=$(uname -m 2>/dev/null); uname_r=$(uname -r 2>/dev/null)
if [ "$test_mode" -eq 1 ]; then
  uname_s=${AH_BOOTSTRAP_UNAME_S:-$uname_s}; uname_m=${AH_BOOTSTRAP_UNAME_M:-$uname_m}; uname_r=${AH_BOOTSTRAP_UNAME_R:-$uname_r}
fi
case "$uname_s" in Darwin) host_os=macos; node_os=darwin ;; Linux) host_os=linux; node_os=linux ;; *) host_os=$uname_s; node_os=$uname_s ;; esac
case "$uname_m" in arm64|aarch64) host_arch=aarch64; node_arch=arm64 ;; x86_64|amd64) host_arch=x86_64; node_arch=x64 ;; *) host_arch=$uname_m; node_arch=$uname_m ;; esac
if [ "$host_os" = macos ] && [ "$host_arch" = x86_64 ] && [ "$test_mode" -eq 0 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
  host_arch=aarch64; node_arch=arm64   # a process under Rosetta reports x86_64 on an Apple Silicon machine
fi
rosetta=0
rosetta_marker=/Library/Apple/usr/libexec/oah/libRosettaRuntime
[ "$test_mode" -eq 1 ] && rosetta_marker=${AH_DOCTOR_ROSETTA:-$rosetta_marker}
[ "$host_os" = macos ] && [ "$host_arch" = aarch64 ] && [ -e "$rosetta_marker" ] && rosetta=1
eng_dir=${AH_ENGINE_DIR:-$home/.anti-hall/ah-engine}
bootstrap="$root/hooks/ah-engine-bootstrap.sh"

printf 'anti-hall doctor v%s\n' "$version"

# ---- Environment --------------------------------------------------------------------------------------------------------------
head_ Environment
ok "Platform $node_os / $node_arch"
if [ -f "$root/.claude-plugin/plugin.json" ]; then ok "anti-hall plugin version $version"
else warnl "plugin root not found (pass --plugin-root <dir> or set AH_ENGINE_PLUGIN_ROOT): the checks that read the plugin's own files were skipped"; fi
if [ -n "${AH_DOCTOR_DEFAULTS_ERROR:-}" ]; then
  bad "engine defaults cannot be loaded: $AH_DOCTOR_DEFAULTS_ERROR; hooks use the Node fallback - Fix: reinstall the plugin, or restore engine/defaults.pristine/"
fi

# ---- Engine (the daemon's files; no process is contacted or signalled) ------------------------------------------------------
head_ Engine
# the socket path as the engine computes it: inside the state directory when it fits, else a private per-user directory under
# TMPDIR (or /tmp) named by the FNV-1a hash of the state directory
sock=$eng_dir/e.sock
if [ "${#sock}" -gt 100 ]; then
  h=-3750763034362895579
  for b in $(printf '%s' "$eng_dir" | od -An -v -tu1); do h=$(( (h ^ b) * 1099511628211 )); done
  sname=$(printf '%012x' $(( h & 281474976710655 )))
  me_uid=$(id -u 2>/dev/null)
  sock=${TMPDIR:+$TMPDIR/anti-hall-$me_uid/$sname.sock}
  { [ -n "$sock" ] && [ "${#sock}" -le 100 ]; } || sock=/tmp/anti-hall-$me_uid/$sname.sock
fi
lockf=$sock.lock
if [ -e "$sock" ] && [ ! -S "$sock" ]; then
  kind="a regular file"; [ -d "$sock" ] && kind="a directory"
  bad "$sock exists but is not a socket ($kind); the daemon cannot start - Fix: mv $sock $sock.old"
fi
stale_pid() { # FILE
  [ -f "$1" ] || return 0
  sp_pid=$(tr -dc '0-9' <"$1" 2>/dev/null)
  [ -n "$sp_pid" ] && [ "$sp_pid" != 0 ] || return 0
  if ! kill -0 "$sp_pid" 2>/dev/null; then
    infol "$1 names pid $sp_pid, which is gone; the next daemon takes it over"
  else
    sp_cmd=$(ps -p "$sp_pid" -o command= 2>/dev/null | first_line)
    case "$sp_cmd" in
      ""|*ah-engine*serve*) : ;;
      *) warnl "$1 names pid $sp_pid, which is now another program ($sp_cmd), not the engine; a stale file, nothing signals that process - Fix: none needed; do NOT kill pid $sp_pid" ;;
    esac
  fi
}
infol "the shell doctor reads the daemon's files only; it never contacts or signals a process"
stale_pid "$lockf"
stale_pid "$eng_dir/daemon.run"
now_ms=$(( $(date +%s 2>/dev/null || echo 0) * 1000 ))
cooldown() { # FILE -> seconds left, empty when none
  [ -f "$1" ] || return 0
  cd_until=$(tr -dc '0-9' <"$1" 2>/dev/null)
  [ -n "$cd_until" ] || return 0
  # milliseconds do not fit every sh's arithmetic: compare the leading digits (seconds) only
  cd_s=$(printf '%s' "$cd_until" | sed 's/...$//')
  [ -n "$cd_s" ] && [ "$cd_s" -gt "$((now_ms / 1000))" ] 2>/dev/null && printf '%s' "$((cd_s - now_ms / 1000 + 1))"
}
reason=
if [ -f "$eng_dir/failure.json" ]; then reason=$(sed -n 's/.*"reason" *: *"\([^"]*\)".*/\1/p' "$eng_dir/failure.json" 2>/dev/null | head -1); fi
left=$(cooldown "$eng_dir/crashloop.until")
[ -n "$left" ] && bad "daemon crash-looping: restarts halted for ${left}s more ($reason) - Fix: read ah-engine status, fix the cause, then run: ah-engine reset"
left=$(cooldown "$eng_dir/breaker.until")
[ -n "$left" ] && warnl "client circuit breaker open for ${left}s more ($reason); hooks use the Node fallback meanwhile - Fix: after fixing the cause: ah-engine reset"

# ---- Engine install -----------------------------------------------------------------------------------------------------------
head_ "Engine install"
bin=$home/.anti-hall/ah-engine/bin/ah-engine
engine_usable=0
hex_of() { od -An -v -tx1 -N "$2" "$1" 2>/dev/null | tr -d ' \n'; }
if [ ! -e "$bin" ] && [ ! -L "$bin" ]; then
  warnl "engine binary not installed at $bin (hooks use ah-engine on PATH, else the Node hooks) - Fix: sh $bootstrap -v"
elif [ ! -f "$bin" ]; then
  kind="not a file"; [ -d "$bin" ] && kind="a directory"; [ -L "$bin" ] && [ ! -e "$bin" ] && kind="a symlink to nothing"
  bad "$bin is not a regular file ($kind) - Fix: move it aside, then run: sh $bootstrap -v"
else
  size=$(wc -c <"$bin" 2>/dev/null | tr -d ' ')
  hex=$(hex_of "$bin" 200)
  bin_os=; bin_archs=; why=; halted=0
  case "$hex" in
    "") why="empty file" ;;
    2321*) : ;;
    7f454c46*)
      bin_os=linux
      if [ "${#hex}" -lt 40 ]; then why="truncated header"; else
        case $(printf '%s' "$hex" | cut -c37-40) in 3e00) bin_archs=x86_64 ;; b700) bin_archs=aarch64 ;; *) bin_archs=other ;; esac
      fi ;;
    cffaedfe*)
      bin_os=macos
      if [ "${#hex}" -lt 16 ]; then why="truncated header"; else
        case $(printf '%s' "$hex" | cut -c9-16) in 0c000001) bin_archs=aarch64 ;; 07000001) bin_archs=x86_64 ;; *) bin_archs=other ;; esac
      fi ;;
    cafebabe*)
      bin_os=macos
      if [ "${#hex}" -lt 16 ]; then why="truncated header"; else
        n=$(printf '%d' "0x$(printf '%s' "$hex" | cut -c9-16)" 2>/dev/null || echo 0); i=0; bin_archs=
        [ "$n" -gt 8 ] && n=8
        while [ "$i" -lt "$n" ]; do
          off=$((16 + i * 40))
          cpu=$(printf '%s' "$hex" | cut -c$((off + 1))-$((off + 8)))
          [ "${#cpu}" -eq 8 ] || { why="truncated header"; break; }
          case "$cpu" in 0100000c) bin_archs="$bin_archs aarch64" ;; 01000007) bin_archs="$bin_archs x86_64" ;; *) bin_archs="$bin_archs other" ;; esac
          i=$((i + 1))
        done
        bin_archs=${bin_archs# }
      fi ;;
    *) if [ "${size:-0}" -lt 32 ]; then why="truncated header"; else why="unrecognised header"; fi ;;
  esac
  if [ -n "$why" ]; then
    halted=1
    bad "$bin is not a runnable program ($why) - Fix: reinstall: sh $bootstrap -v"
  elif [ -n "$bin_os" ] && [ "$bin_os" != "$host_os" ]; then
    halted=1
    bad "$bin was built for $bin_os but this machine runs $host_os - Fix: reinstall: sh $bootstrap -v"
  else
    engine_usable=1
    case " $bin_archs " in
      "  "|*" $host_arch "*) : ;;
      *)
        shown=$(printf '%s' "$bin_archs" | tr ' ' '/')
        if [ "$host_os" = macos ] && [ "$host_arch" = aarch64 ] && [ "$bin_archs" = x86_64 ] && [ "$rosetta" -eq 1 ]; then
          warnl "$bin is an $shown build running under Rosetta on this $host_arch Mac (slower) - Fix: sh $bootstrap -v installs the native build"
        elif [ "$host_os" = macos ] && [ "$host_arch" = aarch64 ] && [ "$bin_archs" = x86_64 ]; then
          halted=1
          bad "$bin is an $shown build and Rosetta is not installed on this $host_arch Mac; it will not start - Fix: softwareupdate --install-rosetta --agree-to-license, or sh $bootstrap -v for the native build"
          engine_usable=0
        else
          halted=1
          bad "$bin was built for $shown but this $host_os machine is $host_arch; it cannot run - Fix: reinstall: sh $bootstrap -v"
          engine_usable=0
        fi ;;
    esac
    if [ "$engine_usable" -eq 1 ]; then
      if [ "$host_os" = macos ] && command -v xattr >/dev/null 2>&1 && xattr -p com.apple.quarantine "$bin" >/dev/null 2>&1; then
        bad "$bin is quarantined by macOS Gatekeeper (com.apple.quarantine); it will not run - Fix: xattr -d com.apple.quarantine $bin (ah-engine doctor --repair does this for the build the bootstrap verified)"
        engine_usable=0
      fi
      if [ ! -x "$bin" ]; then
        bad "$bin is not executable (mode $(perm_octal "$bin")) - Fix: chmod u+x $bin (ah-engine doctor --repair does this)"
        engine_usable=0
      fi
    fi
  fi
  # the lock and the bootstrap's marker
  pinned=
  lockfile=$root/ah-engine.lock
  if [ -r "$lockfile" ]; then
    flat=$(tr ',{}' '\n\n\n' <"$lockfile" 2>/dev/null)
    pinned=$(printf '%s\n' "$flat" | sed -n 's/^ *"version" *: *"\([^"]*\)" *$/\1/p' | head -1)
    case "$host_os" in macos) want_triple="$host_arch-apple-darwin" ;; *) want_triple="$host_arch-unknown-linux-" ;; esac
    if [ -n "$pinned" ] && ! printf '%s\n' "$flat" | grep -q -- "$want_triple"; then
      warnl "the plugin's ah-engine.lock has no build for $want_triple; the Node hooks stay in use - Fix: none, this platform is not released yet"
    fi
  else
    if [ -e "$lockfile" ]; then lock_why="Permission denied (os error 13)"; else lock_why="No such file or directory (os error 2)"; fi
    warnl "ah-engine.lock is missing or unreadable at $lockfile ($lock_why); the bootstrap cannot verify or update the engine - Fix: reinstall the plugin"
  fi
  marker=$eng_dir/bootstrap.installed
  m_ver=; m_bin=
  if [ "$halted" -eq 1 ]; then
    :
  elif [ -f "$marker" ]; then
    # shellcheck disable=SC2046 # the marker's fields are split on purpose
    set -- $(cat "$marker" 2>/dev/null); m_ver=${1:-}; m_bin=${3:-}
  else
    infol "$bin was not installed by the bootstrap (a local build); the bootstrap leaves it alone"
  fi
  if [ -n "$m_bin" ] && [ "$halted" -eq 0 ]; then
    have=$(sha256_of "$bin")
    if [ -n "$have" ] && [ "$have" != "$m_bin" ]; then
      warnl "$bin differs from the build the bootstrap installed (sha256 $(printf '%s' "$have" | cut -c1-12)... vs $(printf '%s' "$m_bin" | cut -c1-12)...): a local build, or damaged - Fix: to restore the pinned build: mv $bin $bin.local && sh $bootstrap -v"
    fi
  fi
  # does it run
  reported=
  if [ "$engine_usable" -eq 1 ]; then
    tmp=$(mktemp "${TMPDIR:-/tmp}/ah-doctor.XXXXXX" 2>/dev/null) || tmp=
    if [ -n "$tmp" ]; then
      AH_ENGINE_PLUGIN_ROOT=$root blim "$tmp" 5 "$bin" version
      rc=$?
      out=$(first_line <"$tmp")
      rm -f "$tmp"
      if [ "$rc" -eq 0 ]; then reported=$out
      else
        engine_usable=0
        if [ "$rc" -eq 124 ]; then wy="timed out"
        elif [ "$rc" -gt 128 ]; then wy="killed by signal $((rc - 128)) $out"
        else wy="exit $rc $out"; fi
        bad "$bin does not run: $wy - Fix: reinstall: sh $bootstrap -v"
      fi
    fi
  fi
  if [ -n "$reported" ]; then
    if [ -n "$pinned" ] && ! printf '%s' "$reported" | grep -qF -- "$pinned"; then
      warnl "engine $reported is installed but the plugin pins $pinned - Fix: it updates at the next session start, or run: sh $bootstrap -v"
    else
      ok "engine binary $bin ($host_arch-$host_os) runs and reports $reported"
    fi
  elif [ -n "$m_ver" ] && [ -n "$pinned" ] && [ "$m_ver" != "$pinned" ]; then
    warnl "engine $m_ver is installed but the plugin pins $pinned - Fix: it updates at the next session start, or run: sh $bootstrap -v"
  fi
fi

# ---- State directory ---------------------------------------------------------------------------------------------------------
head_ "State directory"
if [ -e "$eng_dir" ] && [ ! -d "$eng_dir" ]; then
  bad "$eng_dir is a file where the state directory (or a parent) should be (Not a directory (os error 20)) - Fix: mv $eng_dir $eng_dir.old, then run: ah-engine doctor --repair"
elif [ -d "$eng_dir" ]; then
  me=$(id -u 2>/dev/null)
  owner=$(ls -ldn "$eng_dir" 2>/dev/null | awk '{print $3}')
  if [ -n "$owner" ] && [ "$owner" != "$me" ]; then
    bad "$eng_dir is owned by uid $owner, not you (uid $me) - Fix: sudo chown -R \"\$(id -un)\" $eng_dir"
  elif [ ! -w "$eng_dir" ]; then
    bad "state directory $eng_dir is not writable (write permission denied or read-only volume) - Fix: chmod u+w $eng_dir, or remount the volume read-write"
  else
    ok "state directory $eng_dir is usable"
  fi
else
  p=$eng_dir; blocker=
  while [ "$p" != / ] && [ -n "$p" ]; do
    p=$(dirname "$p")
    if [ -e "$p" ] && [ ! -d "$p" ]; then blocker=$p; break; fi
    [ -d "$p" ] && break
  done
  if [ -n "$blocker" ]; then
    bad "$blocker is a file where the state directory (or a parent) should be (Not a directory (os error 20)) - Fix: mv $blocker $blocker.old, then run: ah-engine doctor --repair"
  elif [ -d "$p" ] && [ -w "$p" ]; then
    infol "state directory $eng_dir does not exist yet; it is created on first use (ah-engine doctor --repair creates it now)"
  else
    bad "state directory $eng_dir cannot be created ($p is not writable) - Fix: make the parent directory writable for your user"
  fi
fi

# ---- Configuration ------------------------------------------------------------------------------------------------------------
head_ Configuration
if [ ! -f "$root/engine/defaults/index.toml" ]; then
  bad "$root/engine/defaults/index.toml is missing; the engine has no settings and the Node hooks stay in use - Fix: reinstall the plugin"
elif [ ! -f "$root/engine/defaults.pristine/index.toml" ]; then
  warnl "$root/engine/defaults.pristine is missing; a broken edit of the defaults would have no last-resort copy - Fix: update or reinstall the plugin"
else
  ok "the plugin's defaults and their pristine copy are present"
fi

# ---- Hooks wiring (thin form) -------------------------------------------------------------------------------------------------
head_ "Hooks wiring (thin form)"
if [ ! -f "$root/hooks/ah-hook.sh" ]; then
  bad "$root/hooks/ah-hook.sh is missing; every hook command fails (non-blocking) - Fix: reinstall the plugin"
fi
thin_check() { # FILE-REL HOST
  tc_file=$root/$1
  if [ ! -f "$tc_file" ]; then
    [ "$2" = claude ] && bad "$tc_file is missing - Fix: reinstall the plugin"
    return 0
  fi
  tc_total=$(grep -c '"command" *:' "$tc_file" 2>/dev/null)
  tc_thin=$(grep '"command" *:' "$tc_file" 2>/dev/null | grep -c 'ah-hook\.sh\\" [A-Za-z]')
  tc_first=$(grep '"command" *:' "$tc_file" 2>/dev/null | grep -v 'ah-hook\.sh\\" [A-Za-z]' | head -1 | sed 's/^[[:space:]]*"command"[[:space:]]*:[[:space:]]*//' | cut -c1-120)
  if [ "${tc_total:-0}" -gt 0 ] && [ "$tc_total" = "$tc_thin" ]; then ok "$1 is the thin form"
  else bad "$1 is not the thin form: ${tc_total:-0} command(s), $((${tc_total:-0} - ${tc_thin:-0})) not through ah-hook.sh (first: ${tc_first:-none}) - Fix: ah-engine gen-hooks --host $2 > $1"; fi
}
thin_check hooks/hooks.json claude
thin_check codex/hooks/hooks.json codex

# ---- Toolchain and environment -------------------------------------------------------------------------------------------------
head_ "Toolchain and environment"
case "$home" in
  "") bad "HOME is not set; the engine cannot find its state (~/.anti-hall) - Fix: export HOME=<your home directory>" ;;
  /*) [ -d "$home" ] || bad "HOME \"$home\" is not a directory - Fix: export HOME=<your home directory>" ;;
  *) bad "HOME is \"$home\", a relative path; state would land under the current directory - Fix: export HOME=<absolute path>" ;;
esac
path_=${PATH:-}
if [ -z "$path_" ]; then
  bad "PATH is empty; no tool can be found - Fix: export PATH=/usr/bin:/bin:..."
else
  oldifs=$IFS; IFS=:
  for e in $path_; do
    case "$e" in
      "") warnl "PATH has an empty entry, resolved against the current directory - Fix: remove it from PATH" ;;
      /*) : ;;
      *) warnl "PATH has $e entry, resolved against the current directory - Fix: remove it from PATH" ;;
    esac
  done
  IFS=$oldifs
  case ":$path_:" in *:/usr/bin:*|*:/bin:*) : ;; *) warnl "PATH lacks /usr/bin, /bin; the hook wrapper may not find its tools - Fix: add them to PATH" ;; esac
fi
missing=
for t in sh ps tr sed awk od find tar uname id kill mkdir mv date head tail wc cut grep; do
  command -v "$t" >/dev/null 2>&1 || missing="$missing, $t"
done
[ -n "$missing" ] && warnl "required tool(s) missing from PATH: ${missing#, } - Fix: install coreutils/procps, or fix PATH"
case "$uname_r" in *[Mm]icrosoft*|*WSL*) infol "WSL detected ($uname_r)" ;; esac
if ! command -v git >/dev/null 2>&1; then
  warnl "git is not on PATH; git-aware guards and project detection are off - Fix: install git"
else
  gv=$(git --version 2>&1); grc=$?
  [ "$grc" -eq 0 ] || warnl "git is on PATH but does not run (exit $grc $(printf '%s' "$gv" | first_line)) - Fix: xcode-select --install (macOS) or reinstall git"
fi
command -v gh >/dev/null 2>&1 || infol "gh is not on PATH; only the optional PR/CI helpers need it"
if ! command -v node >/dev/null 2>&1; then
  warnl "node is not on PATH; the Node fallback hooks cannot run (if the engine is down, guards fail closed) - Fix: install Node >= 22"
  [ "$engine_usable" -eq 1 ] || bad "neither a working engine nor node is available; every guard fails closed - Fix: reinstall the engine (sh hooks/ah-engine-bootstrap.sh -v) or install Node"
else
  nv=$(node --version 2>&1); nrc=$?
  nmajor=$(printf '%s' "$nv" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\)\..*$/\1/p')
  if [ "$nrc" -ne 0 ] || [ -z "$nmajor" ]; then bad "node does not run: exit $nrc $(printf '%s' "$nv" | first_line) - Fix: reinstall Node"
  elif [ "$nmajor" -ge 22 ]; then ok "Node $nv (>= 22) — hooks can run"
  else bad "Node $nv is < 22 — plugin.json requires Node.js >= 22 on PATH; hooks may silently no-op. Install Node >= 22."; fi
fi

# ---- verdict -------------------------------------------------------------------------------------------------------------------
echo
if [ "$fail" -eq 0 ]; then
  v="✅ anti-hall · doctor: active, $pass checks passed"
  [ "$warn" -gt 0 ] && v="$v, $warn warning(s)"
  printf '%s\n' "$v"
  exit 0
fi
printf '❌ anti-hall · doctor: %s failure(s), %s passed, %s warning(s)\n' "$fail" "$pass" "$warn"
exit 1
