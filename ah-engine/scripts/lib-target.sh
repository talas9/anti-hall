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

# artifact_from_messages <json-file> <bin-name>: prints the executable path of the last compiler-artifact line for that bin target
# (cargo --message-format=json); fails if there is none. Fresh (cached) builds emit the line too.
artifact_from_messages() {
  _exe=$(grep -F '"reason":"compiler-artifact"' "$1" | grep -F "\"kind\":[\"bin\"]" | grep -F "\"name\":\"$2\"" \
    | sed -n 's/.*"executable":"\([^"]*\)".*/\1/p' | tail -n 1)
  case "$_exe" in ''|*\\*) return 1 ;; esac
  printf '%s\n' "$_exe"
}
