zmodload zsh/datetime
E=./target/release/engine
IN='{"session_id":"s","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}'
echo "$IN" | $E hook >/dev/null; sleep 0.3
for who in rust node; do
 t=()
 for i in {1..30}; do
  a=$EPOCHREALTIME
  if [[ $who == rust ]]; then echo "$IN" | $E hook >/dev/null; else echo "$IN" | node base.js >/dev/null; fi
  t+=($(( (EPOCHREALTIME-a)*1000 )))
 done
 s=(${(n)t}); printf "%s wall ms median %.1f (min %.1f)\n" $who $s[15] $s[1]
done
