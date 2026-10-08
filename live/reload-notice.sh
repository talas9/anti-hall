#!/bin/sh
# reload-notice.sh - one-time "anti-hall switched to the engine" notice for sessions that were already running at go-live.
#   reload-notice.sh --install      copy this script to ~/.anti-hall/ah-live-notice/notice.sh and register it as a user-level
#                                   UserPromptSubmit hook in settings.json (idempotent; atomic write)
#   reload-notice.sh --uninstall    remove our settings.json entry and our files (rollback calls this)
#   notice.sh (hook mode, no args)  prints the notice ONCE per session_id, then stays silent; after 24 h it removes itself
# POSIX sh; node is used only to edit settings.json. Hook mode never fails and never blocks: every error path exits 0 silently.
D="$HOME/.anti-hall/ah-live-notice"
CC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CC/settings.json"
MARK='ah-live-notice/notice.sh'
TTL=${AH_NOTICE_TTL_S:-86400}

edit_settings() { # add|remove
  command -v node >/dev/null 2>&1 || return 1
  [ -f "$SETTINGS" ] || return 0
  node -e '
    const fs=require("fs"),[f,mode,mark,cmd]=process.argv.slice(1);
    const s=JSON.parse(fs.readFileSync(f,"utf8")); s.hooks=s.hooks||{};
    const g=(s.hooks.UserPromptSubmit=s.hooks.UserPromptSubmit||[]);
    const ours=x=>x&&Array.isArray(x.hooks)&&x.hooks.some(h=>String(h&&h.command||"").includes(mark));
    s.hooks.UserPromptSubmit=g.filter(x=>!ours(x));
    if(mode==="add") s.hooks.UserPromptSubmit.push({hooks:[{type:"command",command:cmd,timeout:5}]});
    if(!s.hooks.UserPromptSubmit.length) delete s.hooks.UserPromptSubmit;
    if(!Object.keys(s.hooks).length) delete s.hooks;
    fs.writeFileSync(f+".ah-tmp",JSON.stringify(s,null,2)+"\n"); fs.renameSync(f+".ah-tmp",f);' "$SETTINGS" "$1" "$MARK" "sh $D/notice.sh" 2>/dev/null
}

case "${1:-}" in
  --install)
    mkdir -p "$D/seen" || { echo "reload-notice: cannot create $D" >&2; exit 1; }
    src=$(CDPATH= cd -- "$(dirname "$0")" && pwd)/$(basename "$0")
    cp "$src" "$D/notice.sh.new" && mv -f "$D/notice.sh.new" "$D/notice.sh" || { echo "reload-notice: cannot install the script" >&2; exit 1; }
    date +%s >"$D/installed_at" || exit 1
    edit_settings add || { echo "reload-notice: cannot edit $SETTINGS" >&2; exit 1; }
    exit 0 ;;
  --uninstall)
    edit_settings remove || echo "reload-notice: could not edit $SETTINGS (remove the UserPromptSubmit entry naming $MARK by hand)" >&2
    rm -f "$D/notice.sh" "$D/notice.sh.new" "$D/installed_at" 2>/dev/null
    rm -f "$D"/seen/* 2>/dev/null; rmdir "$D/seen" "$D" 2>/dev/null
    exit 0 ;;
esac

# ---- hook mode ------------------------------------------------------------------------------------------------------------------
payload=$(cat 2>/dev/null) || payload=
at=$(cat "$D/installed_at" 2>/dev/null); case "$at" in ''|*[!0-9]*) at=0 ;; esac
now=$(date +%s 2>/dev/null) || exit 0
if [ "$at" -eq 0 ] || [ $((now - at)) -gt "$TTL" ]; then
  # expired (or never installed properly): remove the settings entry and our files; without node it just stays silent
  edit_settings remove && rm -f "$D/notice.sh" "$D/installed_at" "$D"/seen/* 2>/dev/null
  exit 0
fi
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 | tr -c 'A-Za-z0-9_-' '_' | cut -c1-80)
[ -n "$sid" ] || exit 0
[ -e "$D/seen/$sid" ] && exit 0
mkdir -p "$D/seen" 2>/dev/null && : >"$D/seen/$sid" 2>/dev/null || exit 0
printf '%s\n' '{"systemMessage":"anti-hall switched to the engine. Run /reload-plugins (or restart this session) to load it; until then this session keeps the hooks it started with."}'
exit 0
