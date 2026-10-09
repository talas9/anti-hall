#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
n=${1:-${WRAPPER_STRESS_N:-20}}

case "$n" in
  ''|*[!0-9]*)
    printf 'usage: sh tests/wrapper-stress.sh [runs]\n' >&2
    exit 2
    ;;
esac

cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || printf 1)
case "$cores" in
  ''|*[!0-9]*) cores=1 ;;
esac
burners=$((cores * 2))
burner_pids=

cleanup() {
  trap - EXIT HUP INT TERM
  for pid in $burner_pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  i=0
  while [ "$i" -lt 5 ]; do
    alive=0
    for pid in $burner_pids; do
      kill -0 "$pid" 2>/dev/null && alive=1
    done
    [ "$alive" -eq 0 ] && break
    sleep 1
    i=$((i + 1))
  done
  for pid in $burner_pids; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  burner_pids=
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' HUP TERM

i=0
while [ "$i" -lt "$burners" ]; do
  (while :; do :; done) &
  burner_pids="$burner_pids $!"
  i=$((i + 1))
done

failures=0
run=1
while [ "$run" -le "$n" ]; do
  if (cd "$repo" && sh tests/wrapper.sh); then
    :
  else
    failures=$((failures + 1))
    printf 'wrapper stress: run %s failed\n' "$run" >&2
  fi
  run=$((run + 1))
done

printf 'wrapper stress: %s runs, %s failures, %s burners\n' "$n" "$failures" "$burners"
[ "$failures" -eq 0 ]
