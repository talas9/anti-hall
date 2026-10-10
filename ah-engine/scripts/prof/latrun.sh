#!/bin/bash
# latrun.sh <label> "<rate:n> <rate:n> ..." : scratch daemon, one warm-up pass (2113 replayed calls, closed loop), then OPEN-LOOP runs at fixed
# rates (calls scheduled at t0+i/rate whether or not earlier ones answered). Per run: client times (from the scheduled instant and from the
# send), the daemon's per-stage slice of its stage log, load average before and after.
LABEL=$1; RUNS=$2
P=$HOME/.anti-hall/work/prof21-22
export BIN=${BIN:-$P/ah-engine-prof2}
read H PID SOCK < <($P/start.sh $LABEL 0)
OUT=$P/out/lat-$LABEL; mkdir -p $OUT; echo "H=$H PID=$PID" > $OUT/where.txt
D() { python3 $P/drive.py --sock $SOCK --root $H/plugin --home $H/home --sb $H/sb --n $1 --offset $2 --rate $3 --ver prof ${4:+--out $4}; }
D 2113 0 0 > $OUT/warmup.json
off=2113
for spec in $RUNS; do
  r=${spec%%:*}; n=${spec##*:}
  l0=$(wc -l < $H/st/stages.ndjson); la0=$(uptime | sed 's/.*averages: //')
  D $n $off $r $OUT/calls-$r.json > $OUT/summary-$r.json
  la1=$(uptime | sed 's/.*averages: //'); l1=$(wc -l < $H/st/stages.ndjson)
  sed -n "$((l0+1)),${l1}p" $H/st/stages.ndjson > $OUT/stages-$r.ndjson
  echo "$r/s n=$n load_before=[$la0] load_after=[$la1]" >> $OUT/load.txt
  off=$((off+n)); sleep 3
done
env -i HOME=$H/home PATH="$PATH" AH_ENGINE_DIR=$H/st AH_ENGINE_PLUGIN_ROOT=$H/plugin AH_ENGINE_VERSION=prof $BIN status --json > $OUT/status-end.json
echo "done $PID $H"
