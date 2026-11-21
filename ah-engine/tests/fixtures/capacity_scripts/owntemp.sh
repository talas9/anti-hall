#!/usr/bin/env bash
# #928: cleanup of paths this script made itself (mktemp, a unique temp dir, a path under one of them) is no risky delete
tmp=${TMPDIR:-/tmp}/own-test.$$
mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
out=$(mktemp -d)
seen=$tmp/seen
echo x >"$seen"
rm -f "$seen"
rm -rf "$out" "$tmp/sub"
