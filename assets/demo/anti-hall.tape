# anti-hall demo tape — record with: vhs assets/demo/anti-hall.tape
# Produces: assets/demo/anti-hall.gif
# Run from the repo root. All commands use relative paths and real hooks.

Output assets/demo/anti-hall.gif

Set Shell zsh
Set FontSize 18
Set Width 1280
Set Height 760
Set Padding 20
Set TypingSpeed 35ms

# 1. Health check — confirm the plugin is live
Type "node plugins/anti-hall/hooks/doctor.js --quiet"
Enter
Sleep 2s

# 2. git-guard blocks a force-push
Type `echo '{"tool_name":"Bash","tool_input":{"command":"git push --force"}}' | node plugins/anti-hall/hooks/git-guard.js; echo "exit=$? (2=blocked)"`
Enter
Sleep 3s

# 3. git-guard blocks an AI-credit trailer
Type `echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m msg --trailer \"Co-Authored-By: Claude\""}}' | node plugins/anti-hall/hooks/git-guard.js; echo "exit=$? (2=blocked)"`
Enter
Sleep 3s

# 4. command-guard pushes a heavy command off the coordinator
Type `echo '{"tool_name":"Bash","tool_input":{"command":"npm run build"}}' | CLAUDE_CODE_ENTRYPOINT=cli node plugins/anti-hall/hooks/command-guard.js; echo "exit=$? (2=delegate)"`
Enter
Sleep 3s

# 5. Render the rich statusline
Type `printf '{"context_window":{"used_percentage":42}}' | node plugins/anti-hall/statusline/statusline-rich.js`
Enter
Sleep 3s
