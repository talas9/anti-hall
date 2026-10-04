#!/usr/bin/env bash
# Package a built binary as ah-engine-v<version>-<triple>.tar.gz (D67) and write its .sha256.
# usage: package.sh <triple> <out-dir>
# The archive is deterministic (sorted entries, mtime 0, uid/gid 0, no gzip name/time) so equal inputs give equal bytes.
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: package.sh <triple> <out-dir>" >&2; exit 2; }
triple="$1"; out="$2"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/Cargo.toml" | head -1)"
bin="$root/target/$triple/release/ah-engine"
[ -f "$bin" ] || { echo "package.sh: build $triple first ($bin missing)" >&2; exit 1; }

name="ah-engine-v${version}-${triple}"
mkdir -p "$out"
python3 - "$name" "$bin" "$root/../LICENSE" "$root/README.md" "$out/$name.tar.gz" <<'PY'
import gzip, sys, tarfile
name, bin_, lic, readme, dest = sys.argv[1:]
with open(dest, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as gz, \
     tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
    for arc, src, mode in sorted([(f"{name}/ah-engine", bin_, 0o755), (f"{name}/LICENSE", lic, 0o644), (f"{name}/README.md", readme, 0o644)]):
        ti = tar.gettarinfo(src, arcname=arc)
        ti.uid = ti.gid = 0; ti.uname = ti.gname = ""; ti.mtime = 0; ti.mode = mode; ti.pax_headers = {}
        with open(src, "rb") as fh:
            tar.addfile(ti, fh)
PY
(cd "$out" && shasum -a 256 "$name.tar.gz" > "$name.tar.gz.sha256")
echo "$out/$name.tar.gz"
