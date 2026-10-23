#!/usr/bin/env bash
# Package a built binary as ah-engine-v<version>-<triple>.tar.gz (D67) and write its .sha256.
# usage: package.sh <triple> <out-dir>
# The archive is deterministic (sorted entries, mtime 0, uid/gid 0, no gzip name/time) so the archive layout does not depend on mtimes or ownership. The gzip bytes can differ across zlib builds; ah-engine.lock pins the bytes the prepare run produced.
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: package.sh <triple> <out-dir>" >&2; exit 2; }
triple="$1"; out="$2"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/Cargo.toml" | head -1)"
. "$root/scripts/lib-target.sh"
tdir="$(cargo_target_dir "$root")" || { echo "package.sh: cannot resolve the cargo target directory" >&2; exit 1; }
bin="$tdir/$triple/release/ah-engine"
[ -f "$bin" ] || { echo "package.sh: build $triple first ($bin missing)" >&2; exit 1; }

# The Command Center server (ah-web, GH #266) ships in the same archive, next to ah-engine, so `ah-engine web open` finds it.
# AH_WEB_BIN overrides the build path; when no binary is there the archive is the engine alone (the engine then reports the server missing).
webbin="${AH_WEB_BIN:-$root/../ah-web/target/$triple/release/ah-web}"
[ -f "$webbin" ] || webbin=""

# The thin client (ah-hook, crate ah-launcher, GH #151/#164) ships in the same archive. Its own cargo target directory is
# resolved like the engine's; AH_HOOK_BIN overrides the path. A release archive must carry it (package.sh fails without it
# unless AH_HOOK_OPTIONAL=1, for an engine-only local pack).
ltdir="$(cargo_target_dir "$root/../ah-launcher")" || ltdir=""
hook="${AH_HOOK_BIN:-$ltdir/$triple/release/ah-hook}"
if [ ! -f "$hook" ]; then
  [ "${AH_HOOK_OPTIONAL:-0}" = 1 ] || { echo "package.sh: build ah-launcher for $triple first ($hook missing; AH_HOOK_OPTIONAL=1 packs the engine alone)" >&2; exit 1; }
  hook=""
fi

name="ah-engine-v${version}-${triple}"
mkdir -p "$out"
python3 - "$name" "$bin" "$root/../LICENSE" "$root/README.md" "$out/$name.tar.gz" "$webbin" "$hook" <<'PY'
import gzip, sys, tarfile
name, bin_, lic, readme, dest, webbin, hook = sys.argv[1:]
with open(dest, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as gz, \
     tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
    members = [(f"{name}/ah-engine", bin_, 0o755), (f"{name}/LICENSE", lic, 0o644), (f"{name}/README.md", readme, 0o644)]
    if webbin:
        members.append((f"{name}/ah-web", webbin, 0o755))
    if hook:
        members.append((f"{name}/ah-hook", hook, 0o755))
    for arc, src, mode in sorted(members):
        ti = tar.gettarinfo(src, arcname=arc)
        ti.uid = ti.gid = 0; ti.uname = ti.gname = ""; ti.mtime = 0; ti.mode = mode; ti.pax_headers = {}
        with open(src, "rb") as fh:
            tar.addfile(ti, fh)
PY
(cd "$out" && shasum -a 256 "$name.tar.gz" > "$name.tar.gz.sha256")
echo "$out/$name.tar.gz"

# The separate debug symbols of this exact binary (Cargo.toml: split-debuginfo = "packed"; macOS ah-engine.dSYM, Linux
# ah-engine.dwp), packed the same deterministic way into <out>/symbols/ so they never mix with the release assets that
# ah-engine.lock pins. `sample`, `atos` and backtraces of the shipped (stripped) binary read them: see docs/AH-ENGINE.md,
# "CPU and memory profiling".
syms=()
[ -d "$bin.dSYM" ] && syms+=("$bin.dSYM")
[ -f "$bin.dwp" ] && syms+=("$bin.dwp")
if [ ${#syms[@]} -gt 0 ]; then
  mkdir -p "$out/symbols"
  python3 - "$name" "$out/symbols/$name.symbols.tar.gz" "${syms[@]}" <<'PY'
import gzip, os, sys, tarfile
name, dest, *srcs = sys.argv[1:]
files = []
for src in srcs:
    base = os.path.basename(src)
    if os.path.isdir(src):
        for d, _, fs in os.walk(os.path.realpath(src)):
            for f in fs:
                full = os.path.join(d, f)
                files.append((f"{name}/{base}/{os.path.relpath(full, os.path.realpath(src))}", full))
    else:
        files.append((f"{name}/{base}", src))
with open(dest, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as gz, \
     tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
    for arc, src in sorted(files):
        ti = tar.gettarinfo(src, arcname=arc)
        ti.uid = ti.gid = 0; ti.uname = ti.gname = ""; ti.mtime = 0; ti.mode = 0o644; ti.pax_headers = {}
        with open(src, "rb") as fh:
            tar.addfile(ti, fh)
PY
  (cd "$out/symbols" && shasum -a 256 "$name.symbols.tar.gz" > "$name.symbols.tar.gz.sha256")
  echo "$out/symbols/$name.symbols.tar.gz"
fi
