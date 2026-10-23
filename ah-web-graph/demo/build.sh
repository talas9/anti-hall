#!/bin/sh
# Build the demo: Lite and Full WASM bundles, wasm-bindgen glue, CSS, config + sample data into demo/dist.
# Dev-only helper. Run it under the cargo lock of your slot, e.g.
#   CARGO_TARGET_DIR=~/.anti-hall/work/target-defer lockf ~/.anti-hall/work/cargo-heavy.lock nice -n 10 sh demo/build.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
crate=$(dirname "$here")
root=$(dirname "$crate")
dist="$here/dist"
target=${CARGO_TARGET_DIR:-$crate/target}
wbg=${WASM_BINDGEN:-wasm-bindgen}
mkdir -p "$dist/lite" "$dist/full"
cd "$crate"
cargo build --release --target wasm32-unknown-unknown -j4 --lib
$wbg --target web --no-typescript --out-dir "$dist/lite" "$target/wasm32-unknown-unknown/release/ah_web_graph.wasm"
cargo build --release --target wasm32-unknown-unknown -j4 --lib --features full
$wbg --target web --no-typescript --out-dir "$dist/full" "$target/wasm32-unknown-unknown/release/ah_web_graph.wasm"
cp "$root/plugins/anti-hall/web/static/graph.css" "$here/index.html" "$here/boot.js" "$dist/"
python3 "$here/gen.py" "$root/plugins/anti-hall/engine/defaults/web_graph.toml" "$dist"
for t in lite full; do
  raw=$(wc -c < "$dist/$t/ah_web_graph_bg.wasm"); gz=$(gzip -9 -c "$dist/$t/ah_web_graph_bg.wasm" | wc -c)
  jsraw=$(wc -c < "$dist/$t/ah_web_graph.js"); jsgz=$(gzip -9 -c "$dist/$t/ah_web_graph.js" | wc -c)
  echo "$t: wasm $raw B raw, $gz B gzip; glue $jsraw B raw, $jsgz B gzip"
done
