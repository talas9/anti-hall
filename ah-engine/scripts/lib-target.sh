# Sourced by build.sh, package.sh and gen-engine-skills.sh (POSIX sh). Resolves where cargo really puts artifacts.
# A hand-built "$root/target/..." path ignores CARGO_TARGET_DIR, [build] target-dir and --target-dir, and then names the
# previous build's binary (seen 2026-10-23: a stale binary was reported as freshly built).

# cargo_target_dir <crate-dir>: prints cargo's own target_directory, or fails.
cargo_target_dir() {
  _meta=$(cd "$1" && cargo metadata --format-version 1 --no-deps --locked 2>/dev/null) || return 1
  _dir=$(printf '%s' "$_meta" | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')
  case "$_dir" in ''|*\\*) return 1 ;; esac
  printf '%s\n' "$_dir"
}

# require_fresh <artifact> <marker>: fails unless the artifact is newer than the marker file (touched just before the build).
require_fresh() {
  if [ ! -f "$1" ]; then echo "missing artifact $1" >&2; return 1; fi
  if [ ! "$1" -nt "$2" ]; then
    echo "stale artifact $1: it is older than the start of this build, so cargo wrote the binary elsewhere or rebuilt nothing." >&2
    echo "Check CARGO_TARGET_DIR / --target-dir; if nothing changed, touch a source file to force a rebuild." >&2
    return 1
  fi
}
