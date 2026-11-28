#!/usr/bin/env bash
set -u
cd "$(dirname "$0")" || exit 1
runner=cargo
$runner test --workspace
[ -x ./missing.sh ] || exec sh "$PWD/x.sh"
sh test.sh
