#!/bin/bash
# dhatrun.sh <N> [--churn]: scratch daemon built with --features dhat-heap, N closed-loop replayed calls, clean stop, dhat-heap.json kept.
N=$1; CH=$2
P=$HOME/.anti-hall/work/prof21-22
export BIN=$P/ah-engine-dhat
read H PID SOCK < <($P/start.sh dhat 0)
OUT=$P/out/dhat-$N; mkdir -p $OUT; echo "H=$H PID=$PID" > $OUT/where.txt
python3 $P/drive.py --sock $SOCK --root $H/plugin --home $H/home --sb $H/sb --n $N --rate 0 --ver prof $CH --out $OUT/calls.json | tail -1
mkdir -p $H/stopcwd; (cd $H/stopcwd && env -i HOME=$H/home PATH="$PATH" AH_ENGINE_DIR=$H/st AH_ENGINE_PLUGIN_ROOT=$H/plugin AH_ENGINE_VERSION=prof $BIN stop)
for i in $(seq 1 600); do kill -0 $PID 2>/dev/null || break; sleep 1; done
ls -la $H/dhat-heap.json
echo "done $H"
