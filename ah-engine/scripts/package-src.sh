#!/usr/bin/env bash
# Vendored source tarball ah-engine-v<version>-src.tar.gz (D67), buildable offline:
#   tar xzf ah-engine-v<version>-src.tar.gz && cd ah-engine-v<version>-src && cargo build --release --offline --frozen
# usage: package-src.sh <out-dir>
# The tar layout is deterministic; the gzip bytes can differ across zlib builds, so ah-engine.lock pins the prepare run's bytes.
# Contents: the ah-engine/ tree (without target/, scripts, tests), vendor/ from `cargo vendor`, and .cargo/config.toml.
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: package-src.sh <out-dir>" >&2; exit 2; }
out="$1"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/Cargo.toml" | head -1)"
name="ah-engine-v${version}-src"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/$name/.cargo" "$out"
cp -R "$root/src" "$stage/$name/src"
cp "$root/Cargo.toml" "$root/Cargo.lock" "$root/rules.json" "$stage/$name/"
for opt in rust-toolchain.toml defaults README.md; do
  [ -e "$root/$opt" ] && cp -R "$root/$opt" "$stage/$name/$opt"
done
cp "$root/../LICENSE" "$stage/$name/LICENSE"

(cd "$stage/$name" && cargo vendor --locked vendor > .cargo/config.toml)

python3 - "$stage" "$name" "$out/$name.tar.gz" <<'PY'
import gzip, os, sys, tarfile
stage, name, dest = sys.argv[1:]
paths = []
for d, dirs, files in os.walk(os.path.join(stage, name)):
    dirs.sort()
    for n in sorted(dirs + files):
        paths.append(os.path.join(d, n))
paths.sort(key=lambda p: os.path.relpath(p, stage).encode())
with open(dest, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as gz, \
     tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
    for p in paths:
        ti = tar.gettarinfo(p, arcname=os.path.relpath(p, stage))
        ti.uid = ti.gid = 0; ti.uname = ti.gname = ""; ti.mtime = 0; ti.pax_headers = {}
        ti.mode = 0o755 if ti.isdir() or (ti.mode & 0o111) else 0o644
        if ti.isreg():
            with open(p, "rb") as fh:
                tar.addfile(ti, fh)
        else:
            tar.addfile(ti)
PY
(cd "$out" && shasum -a 256 "$name.tar.gz" > "$name.tar.gz.sha256")
echo "$out/$name.tar.gz"
