#!/usr/bin/env bash
# anti-hall demo — run from the repo root via asciinema:
#   asciinema rec -c "bash assets/demo/demo.sh" assets/demo/anti-hall.cast
#   agg assets/demo/anti-hall.cast assets/demo/anti-hall.gif
# Pure read-only: pipes crafted hook payloads to the real guards and shows the
# exit codes (2 = blocked). No git/network side effects.

set -u
H="plugins/anti-hall/hooks"
pause() { sleep "${1:-1.6}"; }
say()   { printf '\n\033[1;35m▊ %s\033[0m\n' "$1"; }
run()   { printf '\033[2m$ %s\033[0m\n' "$1"; eval "$1"; }

clear
printf '\033[1;35m🛡️  anti-hall\033[0m — verify-first guards for Claude Code\n'
pause 1.2

say "1. Is it live?  (doctor)"
run "node $H/doctor.js --quiet"
pause

say "2. git-guard blocks a force-push"
run "echo '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git push --force\"}}' | node $H/git-guard.js >/dev/null 2>&1; echo \"exit=\$?  (2 = BLOCKED)\""
pause

say "3. git-guard blocks an AI self-credit trailer"
run "echo '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m x --trailer \\\"Co-Authored-By: Claude <noreply@anthropic.com>\\\"\"}}' | node $H/git-guard.js >/dev/null 2>&1; echo \"exit=\$?  (2 = BLOCKED)\""
pause

say "4. command-guard pushes heavy work off the coordinator"
run "echo '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm run build\"}}' | CLAUDE_CODE_ENTRYPOINT=cli node $H/command-guard.js >/dev/null 2>&1; echo \"exit=\$?  (2 = delegate to a subagent)\""
pause

say "5. live two-line statusline"
# NO_EMAIL keeps the account-email chip out of the public demo GIF (privacy).
run "printf '{\"context_window\":{\"used_percentage\":42}}' | ANTIHALL_STATUSLINE_NO_EMAIL=1 node plugins/anti-hall/statusline/statusline-rich.js; echo"
pause

printf '\n\033[1;32m✓ always-on. pure Node, zero deps. /plugin marketplace add talas9/anti-hall\033[0m\n'
pause 2
