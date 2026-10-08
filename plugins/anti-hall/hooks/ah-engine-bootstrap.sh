#!/bin/sh
# Install the ah-engine binary pinned by ah-engine.lock (the plugin's own copy, one directory up) into
# $HOME/.anti-hall/ah-engine/bin/ah-engine, verified and atomic. POSIX sh only.
#
# - Pinned: the version and the sha256 of every release asset come from the lock shipped in the plugin, never from the network.
#   There is no trust-on-first-use: an asset whose sha256 differs from the lock is refused and nothing is installed.
# - Safe: never fails a session. Every outcome exits 0 and is logged to $HOME/.anti-hall/ah-engine/bootstrap.log. The wrapper
#   (ah-hook.sh) falls back to the Node hooks whenever the engine is absent or cannot answer, so a skipped install is harmless.
# - Idempotent: a marker records "<version> <asset sha256> <binary sha256>" of what this script installed; the same lock does
#   nothing. A binary that was not installed by this script (no marker), or that no longer matches the binary sha256 the marker
#   recorded (replaced by hand, e.g. a local build), is never overwritten.
# - Rate limited: after a failed attempt for a version, the next attempt waits AH_BOOTSTRAP_RETRY_S (default 21600 = 6 h).
# - Atomic: the new binary is staged next to its target and renamed over it; the previous one is kept as bin/ah-engine.prev.
#
# usage: ah-engine-bootstrap.sh [--lock FILE] [--print-target] [-v]
#   --print-target  print the detected release triple (or "unsupported") and exit
#   -v              also print log lines on stderr
# Opt out: AH_ENGINE_BOOTSTRAP=0.
# Test-only knobs (honored ONLY with AH_WRAPPER_TEST=1): AH_ENGINE_RELEASE_BASE (download base URL, http allowed),
# AH_BOOTSTRAP_UNAME_S / _M / _R, AH_BOOTSTRAP_LIBC (gnu|musl), AH_BOOTSTRAP_RETRY_S.

verbose=0
lock=
print_target=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --lock) lock=${2:-}; shift ;;
    --print-target) print_target=1 ;;
    -v) verbose=1 ;;
  esac
  shift
done

test_mode=0
[ "${AH_WRAPPER_TEST:-}" = 1 ] && test_mode=1

[ "${AH_ENGINE_BOOTSTRAP:-1}" = 0 ] && exit 0

here=$(CDPATH= cd -- "$(dirname "$0")" 2>/dev/null && pwd) || exit 0
[ -n "$lock" ] || lock=$here/../ah-engine.lock

repo=talas9/anti-hall
base=https://github.com/$repo/releases/download
retry_s=21600
if [ "$test_mode" -eq 1 ]; then
  base=${AH_ENGINE_RELEASE_BASE:-$base}
  retry_s=${AH_BOOTSTRAP_RETRY_S:-$retry_s}
fi
case "$retry_s" in ""|*[!0-9]*) retry_s=21600 ;; esac

# ---- target detection -------------------------------------------------------
detect_target() {
  os=$(uname -s 2>/dev/null)
  arch=$(uname -m 2>/dev/null)
  rel=$(uname -r 2>/dev/null)
  if [ "$test_mode" -eq 1 ]; then
    os=${AH_BOOTSTRAP_UNAME_S:-$os}
    arch=${AH_BOOTSTRAP_UNAME_M:-$arch}
    rel=${AH_BOOTSTRAP_UNAME_R:-$rel}
  fi
  case "$arch" in
    arm64|aarch64) cpu=aarch64 ;;
    x86_64|amd64) cpu=x86_64 ;;
    *) printf 'unsupported\tcpu %s\n' "$arch"; return ;;
  esac
  case "$os" in
    Darwin)
      # A shell running under Rosetta reports x86_64 on an arm64 machine: take the machine's architecture.
      if [ "$cpu" = x86_64 ] && [ "$test_mode" -eq 0 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then cpu=aarch64; fi
      printf '%s-apple-darwin\tmacos\n' "$cpu"
      ;;
    Linux)
      env_note=linux
      case "$rel" in *[Mm]icrosoft*|*WSL*) env_note=wsl ;; esac
      libc=gnu
      if [ "$test_mode" -eq 1 ] && [ -n "${AH_BOOTSTRAP_LIBC:-}" ]; then
        libc=$AH_BOOTSTRAP_LIBC
      elif ls /lib/ld-musl-* /usr/lib/ld-musl-* >/dev/null 2>&1; then
        libc=musl
      elif (ldd --version 2>&1 | grep -qi musl); then
        libc=musl
      fi
      case "$libc" in gnu|musl) ;; *) libc=gnu ;; esac
      printf '%s-unknown-linux-%s\t%s\n' "$cpu" "$libc" "$env_note"
      ;;
    *) printf 'unsupported\tos %s\n' "$os" ;;
  esac
}

if [ "$print_target" -eq 1 ]; then
  detect_target | cut -f1
  exit 0
fi

# ---- logging ----------------------------------------------------------------
[ -n "${HOME:-}" ] || exit 0
dir=$HOME/.anti-hall/ah-engine
mkdir -p "$dir/bin" 2>/dev/null || exit 0
log=$dir/bootstrap.log
say() {
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\n' "$line" >>"$log" 2>/dev/null
  [ "$verbose" -eq 1 ] && printf '%s\n' "$line" >&2
  return 0
}
# Keep the log bounded.
if [ -f "$log" ] && [ "$(wc -c <"$log" 2>/dev/null || echo 0)" -gt 65536 ]; then
  tail -n 200 "$log" >"$log.new" 2>/dev/null && mv -f "$log.new" "$log" 2>/dev/null
fi

now=$(date +%s 2>/dev/null || echo 0)
tmp=
lockdir=$dir/bootstrap.lock
cleanup() {
  [ -n "$tmp" ] && rm -rf "$tmp"
  rmdir "$lockdir" 2>/dev/null || true
}
trap 'cleanup; exit 0' HUP INT TERM
trap cleanup 0

# ---- read the lock ------------------------------------------------------------
[ -f "$lock" ] || { say "skip: no ah-engine.lock at $lock"; exit 0; }
flat=$(tr ',{}' '\n\n\n' <"$lock" 2>/dev/null)
field() { printf '%s\n' "$flat" | sed -n "s/^ *\"$1\" *: *\"\\([^\"]*\\)\" *\$/\\1/p" | head -1; }
schema=$(printf '%s\n' "$flat" | sed -n 's/^ *"schema" *: *\([0-9][0-9]*\) *$/\1/p' | head -1)
version=$(field version)
[ "$schema" = 1 ] || { say "skip: unsupported lock schema '$schema'"; exit 0; }
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) : ;;
  *) say "skip: bad version in lock"; exit 0 ;;
esac
case "$version" in *[!0-9A-Za-z.-]*) say "skip: bad version in lock"; exit 0 ;; esac

det=$(detect_target)
triple=$(printf '%s' "$det" | cut -f1)
note=$(printf '%s' "$det" | cut -f2)
if [ "$triple" = unsupported ]; then say "skip: unsupported platform ($note)"; exit 0; fi
asset=ah-engine-v$version-$triple.tar.gz
sha=$(field "$asset")
case "$sha" in
  *[!0-9a-f]*|"") say "skip: lock has no valid sha256 for $asset"; exit 0 ;;
esac
[ "${#sha}" -eq 64 ] || { say "skip: lock has no valid sha256 for $asset"; exit 0; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" 2>/dev/null | sed 's/^.*= *//'
  fi
}

# ---- idempotence + rate limit -----------------------------------------------
bin=$dir/bin/ah-engine
marker=$dir/bootstrap.installed
want="$version $sha"
if [ -x "$bin" ]; then
  if [ ! -f "$marker" ]; then say "skip: $bin was not installed by the bootstrap; leaving it alone"; exit 0; fi
  # "<version> <asset sha256> [<binary sha256>]" (a marker written before the binary hash was recorded has two fields)
  # shellcheck disable=SC2046 # the marker's fields are split on purpose
  set -- $(cat "$marker" 2>/dev/null)
  m_bin=${3:-}
  if [ -n "$m_bin" ] && [ "$(sha256_of "$bin")" != "$m_bin" ]; then
    say "skip: $bin is not the binary the bootstrap installed (sha256 differs from the marker; a local build?); leaving it alone"
    exit 0
  fi
  if [ "${1:-} ${2:-}" = "$want" ]; then exit 0; fi
fi
attempt=$dir/bootstrap.attempt
if [ -f "$attempt" ]; then
  # "<epoch> <version> <sha>" of the last failed attempt.
  set -- $(cat "$attempt" 2>/dev/null)
  if [ "${2:-}" = "$version" ] && [ "${3:-}" = "$sha" ] && [ "${1:-0}" -gt 0 ] 2>/dev/null && [ "$now" -gt 0 ] && [ $((now - $1)) -lt "$retry_s" ]; then
    exit 0
  fi
fi

# One bootstrap at a time; a lock older than 10 minutes is stale.
if ! mkdir "$lockdir" 2>/dev/null; then
  if [ -n "$(find "$lockdir" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
    rmdir "$lockdir" 2>/dev/null; mkdir "$lockdir" 2>/dev/null || { lockdir=; exit 0; }
  else
    lockdir=; exit 0
  fi
fi

fail() {
  say "fail: $* (Node hooks stay in use)"
  printf '%s %s %s\n' "$now" "$version" "$sha" >"$attempt" 2>/dev/null
  exit 0
}

# ---- download, verify, install ------------------------------------------------
tmp=$dir/tmp.$$
rm -rf "$tmp"; mkdir -p "$tmp" 2>/dev/null || fail "cannot create $tmp"
url=$base/ah-engine-v$version/$asset
say "start: $asset ($note), pinned sha256 ${sha%${sha#????????}}"

if command -v curl >/dev/null 2>&1; then
  if [ "$test_mode" -eq 1 ]; then
    curl -fsSL --connect-timeout 10 --max-time 120 -o "$tmp/asset" "$url" >/dev/null 2>&1 || fail "download failed ($url)"
  else
    curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 120 --max-filesize 134217728 -o "$tmp/asset" "$url" >/dev/null 2>&1 || fail "download failed ($url)"
  fi
elif command -v wget >/dev/null 2>&1; then
  wget -q -T 60 -O "$tmp/asset" "$url" >/dev/null 2>&1 || fail "download failed ($url)"
else
  fail "neither curl nor wget is available"
fi

got=$(sha256_of "$tmp/asset")
[ -n "$got" ] || fail "no sha256 tool available"
[ "$got" = "$sha" ] || fail "sha256 mismatch for $asset: expected $sha, got ${got:-none}; refusing to install"

# Extract only the one expected member to a fixed path, never the archive's own paths.
tar -xzOf "$tmp/asset" "ah-engine-v$version-$triple/ah-engine" >"$tmp/ah-engine" 2>/dev/null || fail "archive has no ah-engine-v$version-$triple/ah-engine"
[ -s "$tmp/ah-engine" ] || fail "extracted binary is empty"
chmod 755 "$tmp/ah-engine" 2>/dev/null
# The engine reads its settings from the plugin at run time, so the check names this plugin (the one whose lock pinned the
# binary) and a scratch state directory: it must not depend on a host variable or touch the real state.
plugin_root=$(CDPATH= cd -- "$here/.." 2>/dev/null && pwd)
reported=$(AH_ENGINE_PLUGIN_ROOT=$plugin_root AH_ENGINE_DIR=$tmp/state "$tmp/ah-engine" version 2>/dev/null </dev/null | head -1)
case "$reported" in *"$version"*) ;; *) fail "downloaded binary does not run or reports '$reported', not $version" ;; esac

if [ -f "$bin" ]; then
  cp -p "$bin" "$tmp/prev" 2>/dev/null && mv -f "$tmp/prev" "$bin.prev" 2>/dev/null
fi
binsha=$(sha256_of "$tmp/ah-engine")
mv -f "$tmp/ah-engine" "$bin" 2>/dev/null || fail "cannot install $bin"
printf '%s %s\n' "$want" "$binsha" >"$marker"
rm -f "$attempt"
say "ok: installed ah-engine $version ($triple) at $bin"
exit 0
