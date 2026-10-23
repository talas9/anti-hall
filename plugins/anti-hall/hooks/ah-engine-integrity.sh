#!/bin/sh
# ah-engine-integrity: remember which ah-engine binary ran healthy, and put it back when a different one that never did keeps failing.
# POSIX sh on purpose: a hung or exiting binary cannot repair itself, and the engine has no network or swap code of its own.
#
# usage: ah-engine-integrity.sh <verb>
#   record  the installer (bootstrap, ah-update) just put this binary in place: remember its sha256 as the expected one
#   accept  the operator vouches for the installed binary (a hand-built one): same as record, and it is never rolled back
#           on a checksum mismatch alone; run it after copying a local build into bin/
#   check   promote a binary that has run healthy to bin/ah-engine.good; roll back when the installed binary
#           (1) differs from the expected sha256, (2) has never run healthy, and (3) is failing (a crash-loop roll-back request from
#           the engine, or rollback.fail_n wrapper failures within rollback.fail_window_s)
#   fail    the hook wrapper saw the engine time out, die by signal or answer nothing: count it, then check
#   status  print what is known (expected, good, healthy, last roll-back)
#   lock TOKEN    take the install lock for TOKEN ("<pid> <epoch>" of the caller), waiting up to rollback.lock_wait_s; exit 1 when
#                 another holder kept it that long
#   unlock TOKEN  give the install lock back (only when TOKEN holds it)
#
# The install lock (rollback.install_lock, a directory in the state directory) is ONE lock shared by every writer of bin/: this
# script's check and roll-back, the bootstrap's and ah-update's install and roll-back, and the recording of the expected sha256.
# An installer takes it with `lock`, swaps the binary, runs `record` with AH_ENGINE_INSTALL_LOCK_TOKEN set to its token (record
# then runs under the caller's hold) and gives it back with `unlock`. record and accept wait up to rollback.lock_wait_s for it;
# check and fail (run by the hook wrapper) wait only rollback.lock_hook_wait_s and then skip, so a held lock never holds a session.
# A lock whose holder pid is gone, or that is older than rollback.lock_stale_s, is broken.
#
# A roll-back renames the bad binary to bin/ah-engine.rolledback-<UTC time>-<sha8> (never deleted) and restores bin/ah-engine.good.
# Every name, threshold and path comes from the plugin's engine/defaults/engine.toml ([rollback.*], [files.*]); nothing is fixed here.
# Never fails a session: every verb but `lock` exits 0, and every outcome is written to the integrity log in the state directory.

verb=${1:-}
here=$(CDPATH="" cd -- "$(dirname "$0")" 2>/dev/null && pwd) || exit 0
root=${AH_ENGINE_PLUGIN_ROOT:-"$here/.."}
cfg=$root/engine/defaults/engine.toml
[ -f "$cfg" ] || exit 0
[ -n "${AH_ENGINE_DIR:-}" ] || [ -n "${HOME:-}" ] || exit 0
state=${AH_ENGINE_DIR:-"$HOME/.anti-hall/ah-engine"}

cfg_text() {
  awk -v want="[$1]" '
    $0 == want { in_key = 1; next }
    in_key && /^\[/ { exit }
    in_key && $1 == "value" && $2 == "=" {
      v = $0
      sub(/^[^"]*"/, "", v)
      sub(/".*$/, "", v)
      print v
      exit
    }
  ' "$cfg"
}

# a numeric setting: its env override (when set and numeric) wins, else the file's value
cfg_num() {
  env_name=$(awk -v want="[$1]" '
    $0 == want { in_key = 1; next }
    in_key && /^\[/ { exit }
    in_key && $1 == "env" && $2 == "=" { v = $0; sub(/^[^"]*"/, "", v); sub(/".*$/, "", v); print v; exit }
  ' "$cfg")
  n=
  if [ -n "$env_name" ]; then eval "n=\${$env_name:-}"; fi
  case "$n" in ""|*[!0-9]*) n=$(awk -v want="[$1]" '
    $0 == want { in_key = 1; next }
    in_key && /^\[/ { exit }
    in_key && $1 == "value" && $2 == "=" { v = $3; gsub(/[^0-9].*/, "", v); print v; exit }
  ' "$cfg") ;; esac
  case "$n" in ""|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$n"
}

bin_dir=$(cfg_text rollback.bin_dir)
bin_name=$(cfg_text rollback.bin_name)
good_sfx=$(cfg_text rollback.good_suffix)
exp_sfx=$(cfg_text rollback.expected_suffix)
aside_mid=$(cfg_text rollback.aside_infix)
accepted_sfx=$(cfg_text rollback.accepted_suffix)
sha_sfx=$(cfg_text rollback.sha_suffix)
healthy_f=$(cfg_text files.healthy_binary)
request_f=$(cfg_text files.rollback_request)
last_f=$(cfg_text files.rollback_last)
fails_f=$(cfg_text files.wrapper_fail_log)
log_f=$(cfg_text files.integrity_log)
for v in "$bin_dir" "$bin_name" "$good_sfx" "$exp_sfx" "$aside_mid" "$accepted_sfx" "$sha_sfx" "$healthy_f" "$request_f" "$last_f" "$fails_f" "$log_f"; do
  [ -n "$v" ] || exit 0 # the settings file lacks a key: nothing safe to do
done
lock_name=$(cfg_text rollback.install_lock)
[ -n "$lock_name" ] || exit 0
lock_wait=$(cfg_num rollback.lock_wait_s) || exit 0
hook_wait=$(cfg_num rollback.lock_hook_wait_s) || exit 0
lock_stale=$(cfg_num rollback.lock_stale_s) || exit 0
fail_n=$(cfg_num rollback.fail_n) || exit 0
fail_win=$(cfg_num rollback.fail_window_s) || exit 0
on_mismatch=$(cfg_num rollback.on_mismatch) || exit 0

bin=$state/$bin_dir/$bin_name
good=$bin$good_sfx
good_sha_f=$good$sha_sfx
exp_f=$bin$exp_sfx
accepted_f=$exp_f$accepted_sfx
healthy=$state/$healthy_f
request=$state/$request_f
last=$state/$last_f
fails=$state/$fails_f
log=$state/$log_f
lockdir=$state/$lock_name
owner_f=$lockdir/owner

say() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$log" 2>/dev/null
  return 0
}
if [ -f "$log" ] && [ "$(wc -c <"$log" 2>/dev/null || echo 0)" -gt 65536 ]; then
  tail -n 200 "$log" >"$log.new" 2>/dev/null && mv -f "$log.new" "$log" 2>/dev/null
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" 2>/dev/null | sed 's/^.*= *//'
  fi
}

first_word() { [ -f "$1" ] && sed -n '1{s/[[:space:]].*$//;p;}' "$1" 2>/dev/null; }

mkdir -p "$state/$bin_dir" 2>/dev/null || exit 0

# The install lock is the directory $lockdir; its holder is the token in $lockdir/owner. The owner file is only ever created with
# ln (atomic, fails when it exists) and only ever taken away with a rename (atomic, one taker wins), so whoever moved it away
# holds the only copy and can compare it: a breaker or a giver that finds another token in it links it straight back. The
# directory is never moved while an owner may be live, so no taker can find the path free while another holder is inside.

# own TOKEN: link TOKEN in as the owner of the existing lock directory; 1 when there is an owner already (or no directory)
own() {
  printf '%s\n' "$1" >"$lockdir.tok.$$" 2>/dev/null || { rm -f "$lockdir.tok.$$"; return 1; }
  ln "$lockdir.tok.$$" "$owner_f" 2>/dev/null; lrc=$?
  rm -f "$lockdir.tok.$$" # the second name of the token just written; the owner file keeps it
  return $lrc
}

# lock_stale TOKEN: the install lock's holder is gone (dead pid) or has held it longer than rollback.lock_stale_s; it is then
# broken and TOKEN takes it over (0). The stale owner file is renamed aside (kept, never deleted) and compared again: a token that
# is not the one judged stale belongs to a holder that took the lock a moment ago and is linked straight back (1).
lock_stale() {
  lo=$(cat "$owner_f" 2>/dev/null)
  lnow=$(date +%s 2>/dev/null) || return 1
  if [ -n "$lo" ]; then
    lpid=${lo%% *}; lat=${lo#* }; lat=${lat%% *}
    case "$lpid$lat" in *[!0-9]*) lpid=; lat=0 ;; esac
    if [ -n "$lpid" ] && kill -0 "$lpid" 2>/dev/null && [ $((lnow - lat)) -le "$lock_stale" ]; then return 1; fi
    lbrk=$lockdir.stale.$$.$lnow
    mv "$owner_f" "$lbrk" 2>/dev/null || return 1 # another breaker or the holder got it first: look again
    if [ "$(cat "$lbrk" 2>/dev/null)" != "$lo" ]; then
      if ln "$lbrk" "$owner_f" 2>/dev/null; then rm -f "$lbrk" # put back: the aside name is a second name of the live owner file
      else say "lock: could not put back the owner '$(cat "$lbrk" 2>/dev/null)' (kept as $lbrk)"; fi
      return 1
    fi
  else # no owner yet: being taken right now, unless the taker died between mkdir and writing it
    [ -n "$(find "$lockdir" -maxdepth 0 -mmin +$(((lock_stale + 59) / 60)) 2>/dev/null)" ] || return 1
  fi
  own "$1" || return 1 # another taker linked its owner in first, or the lock was given back: look again
  say "lock: broke a stale install lock (holder '${lo:-none}'${lo:+, kept as $lbrk})"
  return 0
}

# lock_take TOKEN WAIT_S: 0 once TOKEN holds the install lock (also when it already did), 1 when another holder kept it WAIT_S seconds
lock_take() {
  lwaited=0
  while :; do
    if mkdir "$lockdir" 2>/dev/null; then
      own "$1" && return 0
      [ -f "$owner_f" ] && continue # a breaker took the fresh directory over: wait for it like any holder
      rmdir "$lockdir" 2>/dev/null
      return 1
    fi
    [ "$(cat "$owner_f" 2>/dev/null)" = "$1" ] && return 0
    lock_stale "$1" && return 0
    [ "$lwaited" -lt "$2" ] || return 1
    [ "$lwaited" -gt 0 ] || say "lock: waiting up to ${2}s for the install lock (holder '$(cat "$owner_f" 2>/dev/null)')"
    sleep 1
    lwaited=$((lwaited + 1))
  done
}

# lock_give TOKEN: release the install lock when TOKEN holds it; the owner file is renamed away first, so a breaker that took the
# lock over meanwhile gets its own owner file linked straight back instead of losing it
lock_give() {
  [ "$(cat "$owner_f" 2>/dev/null)" = "$1" ] || return 0
  lgv=$lockdir.give.$$
  mv "$owner_f" "$lgv" 2>/dev/null || return 0
  if [ "$(cat "$lgv" 2>/dev/null)" = "$1" ]; then
    rm -f "$lgv"
    rmdir "$lockdir" 2>/dev/null
  else
    if ln "$lgv" "$owner_f" 2>/dev/null; then rm -f "$lgv"
    else say "lock: could not put back the owner '$(cat "$lgv" 2>/dev/null)' (kept as $lgv)"; fi
  fi
  return 0
}

# hold WAIT_S: run the rest of this verb under the install lock; an installer's own hold (AH_ENGINE_INSTALL_LOCK_TOKEN naming the
# current holder) is used as is and left to the installer to release
held_by=
hold() {
  if [ -n "${AH_ENGINE_INSTALL_LOCK_TOKEN:-}" ] && [ "$(cat "$owner_f" 2>/dev/null)" = "$AH_ENGINE_INSTALL_LOCK_TOKEN" ]; then return 0; fi
  my_tok="$$ $(date +%s 2>/dev/null)"
  lock_take "$my_tok" "$1" || return 1
  held_by=$my_tok
  return 0
}
trap '[ -z "$held_by" ] || lock_give "$held_by"' 0
trap 'exit 0' HUP INT TERM

write_atomic() { # write_atomic FILE TEXT
  if printf '%s\n' "$2" >"$1.tmp.$$" 2>/dev/null && mv -f "$1.tmp.$$" "$1" 2>/dev/null; then return 0; fi
  rm -f "$1.tmp.$$"
  return 1
}

# bless the binary now in place as the expected one
record() {
  [ -f "$bin" ] || { say "record: no binary at $bin"; return 0; }
  cur=$(sha256_of "$bin")
  [ -n "$cur" ] || { say "record: cannot hash $bin"; return 0; }
  write_atomic "$exp_f" "$cur" || { say "record: cannot write $exp_f"; return 0; }
  say "record: expected sha256 is now $cur"
}

# a binary that ran healthy becomes the known-good copy
promote() {
  [ -f "$bin" ] || return 0
  cur=$(sha256_of "$bin")
  [ -n "$cur" ] && [ "$(first_word "$healthy")" = "$cur" ] || return 0
  [ "$(first_word "$good_sha_f")" = "$cur" ] && [ "$(sha256_of "$good")" = "$cur" ] && return 0
  if cp -p "$bin" "$good.tmp.$$" 2>/dev/null && [ "$(sha256_of "$good.tmp.$$")" = "$cur" ] && mv -f "$good.tmp.$$" "$good" 2>/dev/null; then
    write_atomic "$good_sha_f" "$cur" && say "promote: $cur ran healthy and is now the known-good binary"
  else
    rm -f "$good.tmp.$$"
    say "promote: cannot copy $bin to $good"
  fi
}

failing() { # the installed binary $1 is failing: a roll-back request for it, or enough wrapper failures
  [ "$(first_word "$request")" = "$1" ] && return 0
  [ -f "$fails" ] || return 1
  now=$(date +%s 2>/dev/null) || return 1
  floor=$((now - fail_win))
  n=$(awk -v floor="$floor" '$1 ~ /^[0-9]+$/ && $1 >= floor { c++ } END { print c + 0 }' "$fails" 2>/dev/null)
  [ "${n:-0}" -ge "$fail_n" ]
}

check() {
  promote
  [ -f "$bin" ] || return 0
  cur=$(sha256_of "$bin")
  [ -n "$cur" ] || return 0
  [ "$on_mismatch" -eq 1 ] || return 0
  want=$(first_word "$exp_f")
  [ -n "$want" ] || return 0 # nothing was ever recorded: there is nothing to compare with
  [ "$cur" != "$want" ] || return 0 # the binary the installer put there
  [ "$(first_word "$healthy")" != "$cur" ] || return 0 # it ran healthy once: whatever is failing, it is not a damaged copy
  [ ! -f "$accepted_f" ] || [ "$(first_word "$accepted_f")" != "$cur" ] || return 0 # the operator vouched for exactly this binary
  failing "$cur" || { say "check: $cur differs from the expected binary and has never run healthy, but it is not failing; left alone"; return 0; }
  [ -f "$good" ] && [ "$(first_word "$good_sha_f")" = "$(sha256_of "$good")" ] && [ -n "$(first_word "$good_sha_f")" ] || { say "check: $cur should be rolled back but there is no verified known-good binary"; return 0; }
  gsha=$(first_word "$good_sha_f")
  [ "$gsha" != "$cur" ] || return 0
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  short=$(printf '%s' "$cur" | cut -c1-8)
  aside=$bin$aside_mid$ts-$short
  mv -f "$bin" "$aside" 2>/dev/null || { say "rollback: cannot move $bin aside"; return 0; }
  if [ "$(sha256_of "$aside")" != "$cur" ]; then # replaced since it was checked: it is not the binary judged damaged
    if [ -e "$bin" ]; then say "rollback: $bin changed while it was checked and again after; the moved copy is kept as $aside"
    else mv -f "$aside" "$bin" 2>/dev/null; say "rollback: $bin changed after it was checked; left in place, nothing rolled back"; fi
    return 0
  fi
  if cp -p "$good" "$bin.new.$$" 2>/dev/null && chmod 755 "$bin.new.$$" && [ "$(sha256_of "$bin.new.$$")" = "$gsha" ] && mv -f "$bin.new.$$" "$bin" 2>/dev/null; then
    write_atomic "$exp_f" "$gsha"
    write_atomic "$last" "$ts rolled back $cur (set aside as $aside) to the known-good $gsha"
    rm -f "$request"
    : >"$fails" 2>/dev/null
    say "rollback: $cur never ran healthy and differs from the expected binary; set aside as $aside, restored known-good $gsha"
  else
    rm -f "$bin.new.$$"
    mv -f "$aside" "$bin" 2>/dev/null
    say "rollback: could not restore $good; the original binary was put back"
  fi
}

case "$verb" in
  lock)
    [ -n "${2:-}" ] || exit 0
    lock_take "$2" "$lock_wait" || { say "lock: '$2' did not get the install lock within ${lock_wait}s (holder '$(cat "$owner_f" 2>/dev/null)')"; exit 1; }
    ;;
  unlock) [ -z "${2:-}" ] || lock_give "$2" ;;
  record)
    hold "$lock_wait" || { say "record: the install lock stayed held for ${lock_wait}s; the expected sha256 was NOT recorded (holder '$(cat "$owner_f" 2>/dev/null)')"; exit 0; }
    record
    ;;
  accept)
    hold "$lock_wait" || { say "accept: the install lock stayed held for ${lock_wait}s; nothing was recorded (holder '$(cat "$owner_f" 2>/dev/null)')"; exit 0; }
    record
    [ -f "$bin" ] && write_atomic "$accepted_f" "$(sha256_of "$bin")" && say "accept: the operator vouched for the installed binary"
    ;;
  fail)
    now=$(date +%s 2>/dev/null) && printf '%s\n' "$now" >>"$fails" 2>/dev/null
    hold "$hook_wait" || { say "fail: counted; the install lock is held, so the check is left to the next run"; exit 0; }
    if [ "$(wc -l <"$fails" 2>/dev/null || echo 0)" -gt 200 ]; then tail -n 50 "$fails" >"$fails.new" 2>/dev/null && mv -f "$fails.new" "$fails" 2>/dev/null; fi
    check
    ;;
  check)
    hold "$hook_wait" || { say "check: the install lock is held; skipped (the next run checks)"; exit 0; }
    check
    ;;
  status)
    printf 'binary    %s\n' "$bin"
    printf 'installed %s\n' "$(sha256_of "$bin")"
    printf 'expected  %s\n' "$(first_word "$exp_f")"
    printf 'healthy   %s\n' "$(first_word "$healthy")"
    printf 'good      %s\n' "$(first_word "$good_sha_f")"
    printf 'last      %s\n' "$(cat "$last" 2>/dev/null)"
    ;;
  *) printf 'usage: ah-engine-integrity.sh record|accept|check|fail|status|lock TOKEN|unlock TOKEN\n' >&2 ;;
esac
exit 0
