#!/bin/sh
# Runs the launcher where the suite runs `sh ah-hook.sh ...` (ah-engine/tests/wrapper.sh with AH_WRAPPER_UNDER_TEST=<this file>).
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec "${AH_LAUNCHER_BIN:-$here/../target/release/ah-hook}" "$@" --plugin-root "$here/../../plugins/anti-hall"
