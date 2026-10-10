#!/bin/bash
# memrun.sh <label> [--churn] : N = 0/1k/5k/20k closed-loop replayed hook calls against a scratch daemon; at each checkpoint record
# RSS, status memory (live heap, jemalloc stats, QuickJS usage, structure sizes), vmmap --summary, footprint, heap and leaks (macOS).
LABEL=$1; CH=$2
P=$HOME/.anti-hall/work/prof21-22
export BIN=$P/ah-engine-prof
read H PID SOCK < <($P/start.sh $LABEL 20)
OUT=$P/out/mem-$LABEL; mkdir -p $OUT
echo "H=$H PID=$PID" > $OUT/where.txt
st() { env -i HOME=$H/home PATH="$PATH" AH_ENGINE_DIR=$H/st AH_ENGINE_PLUGIN_ROOT=$H/plugin AH_ENGINE_VERSION=prof $BIN status --json; }
cp_() {  # checkpoint at call count $1
  n=$1
  ps -o rss=,vsz= -p $PID > $OUT/ps-$n.txt
  st > $OUT/status-$n.json 2>&1
  vmmap --summary $PID > $OUT/vmmap-$n.txt 2>&1
  footprint $PID > $OUT/footprint-$n.txt 2>&1
  if [ "$n" = 0 ] || [ "$n" = 20000 ]; then heap $PID > $OUT/heap-$n.txt 2>&1; timeout 300 leaks $PID > $OUT/leaks-$n.txt 2>&1; fi
  echo "checkpoint $n rss_kb=$(cat $OUT/ps-$n.txt | awk '{print $1}')"
}
D() { python3 $P/drive.py --sock $SOCK --root $H/plugin --home $H/home --sb $H/sb --n $1 --offset $2 --rate 0 --ver prof $CH --out $OUT/calls-$2.json | tail -1; }
cp_ 0
D 1000 0; cp_ 1000
D 4000 1000; cp_ 5000
D 15000 5000; cp_ 20000
ls -la $H/st | head -30 > $OUT/stdir.txt
echo "done $PID $H"
