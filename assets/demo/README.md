# Demo assets

`anti-hall.gif` (embedded in the root README) is a **real Claude Code session**, not a
scripted simulation. A developer asks the agent to force-push; the agent runs git commands;
`git push --force-with-lease origin main` is blocked by anti-hall's `git-guard` hook with the
hook's real message; the agent falls back to a normal push and explains that the force push
was blocked and was not needed.

## What is real, and what was arranged for a clean recording

| Aspect | Detail |
|---|---|
| Session | A live `claude` TUI session recorded with `asciinema`. Nothing is typed by a script into a fake terminal; the agent's commands, the block message and the final explanation are what the session produced. |
| Repo | A throwaway git repo in a temp dir. `origin` is a **local bare repo** in the same temp dir (no real remote). |
| Hook | Only the plugin's real `git-guard.js` is wired in, through a settings file (`demo-settings.json`). The **full plugin install was not used**: a normal user config loads many unrelated plugins and hooks whose startup chatter and home paths would pollute the recording. The block message is the genuine `git-guard.js` output. |
| Settings isolation | `--setting-sources project` plus `--settings demo-settings.json`, so user-level settings are not loaded. |
| Permissions | `--permission-mode default --allowedTools "Bash(git:*)"`: the agent may only run git commands without a prompt. |
| Path hygiene | The plugin is reached through a neutral symlink (`<tmp>/anti-hall-plugin`) so the message shows a temp path, not a home directory. `ANTIHALL_STATUSLINE_NO_EMAIL=1` keeps an email off screen. The frames still show the temp directory path (`/private/tmp/...`); it is not a home directory. |
| Trimming | Start and end were trimmed (see below). No event inside the kept part was altered. |

The scenario is staged (a user prompt chosen to trigger the guard, a repo with one unpushed
commit). The agent's behaviour inside it was not scripted.

## Reproduce

Prerequisites: `claude` (Claude Code), `tmux`, `asciinema` 3.x, `agg`, `node` 22+.

```sh
T=$(mktemp -d)   # sandbox; origin is a local bare repo, no real remote
git init -q -b main $T/my-app && cd $T/my-app
git config user.name Dev && git config user.email dev@example.com
echo "# my-app" > README.md && git add . && git commit -qm "Initial commit"
echo "print('hi')" > app.py && git add . && git commit -qm "Add app"
git init -q --bare $T/origin.git && git remote add origin $T/origin.git && git push -q origin main
echo "print('more')" >> app.py && git commit -qam "Add more output"

# Neutral-path symlink to the installed anti-hall plugin dir, so the block message shows no home path
ln -s <installed anti-hall plugin dir> $T/anti-hall-plugin
# Settings: copy assets/demo/demo-settings.json to $T/demo-settings.json and replace <tmp>
# with $T (the committed copy uses the <tmp> placeholder instead of a real absolute path).
sed "s#<tmp>#$T#" /path/to/anti-hall/assets/demo/demo-settings.json > $T/demo-settings.json

# Record at 100x30 inside tmux
tmux new-session -d -s demo -x 100 -y 30 -c $T/my-app
tmux send-keys -t demo "cd $T/my-app && export ANTIHALL_STATUSLINE_NO_EMAIL=1 && clear && asciinema rec --window-size 100x30 $T/demo.cast -c 'claude --setting-sources project --settings $T/demo-settings.json --permission-mode default --allowedTools \"Bash(git:*)\"'" Enter
# wait for the prompt box, then:
tmux send-keys -t demo "Force-push my local main to origin." Enter
# poll `tmux capture-pane -p -t demo` until the "done" status line appears, then:
tmux send-keys -t demo "/exit" Enter; tmux kill-session -t demo
```

Notes: Claude Code shows a folder-trust dialog once per folder (Down, Enter); accept it
before recording. The recording is long-lived local state; only the trimmed result is kept
in the repo.

### `demo-settings.json`

Wires one `PreToolUse` hook on `Bash` that runs the real `git-guard.js`. The committed copy
has the absolute plugin path replaced by the placeholder `<tmp>`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node <tmp>/anti-hall-plugin/hooks/git-guard.js" }
        ]
      }
    ]
  }
}
```

## Trim and render

The raw recording ends with `/exit`, a spinner, a tip line and the shell's "Resume this
session" line, and starts with terminal-negotiation noise. `trim-cast.js` removes both and
leaves the content of every kept event unchanged (only the first kept event's delay is set to 0):

- Start: events before the first draw of the Claude Code TUI are dropped; the first kept
  event is moved to t=0 so the GIF opens on the header and prompt.
- End: everything from the post-reply prompt suggestion onward is dropped (the typed `/exit`,
  spinner, tip and resume line are all after it), so the GIF ends on the agent's final reply
  and the "done" status line.
- Header: the recorded command line (which held a temp path) is replaced with a placeholder.

```sh
node assets/demo/trim-cast.js $T/demo.cast assets/demo/anti-hall.cast --end-before "add .omc/"
agg --font-size 18 --idle-time-limit 2 --last-frame-duration 4 \
    assets/demo/anti-hall.cast assets/demo/anti-hall.gif
# -> 1105x781 px, ~20 s, ~0.5 MB
```

`--end-before` takes a substring of the first event to drop; use whatever text first appears
after the final reply in your recording (the default, `/exit`, also works if you do not mind
a leading prompt suggestion appearing in the last frame).

`assets/demo/*.cast` is gitignored, so the trimmed `anti-hall.cast` is a local intermediate
and is not committed; `anti-hall.gif` is.

## `demo.sh` (shell-only illustration, not the README GIF)

`demo.sh` pipes a PreToolUse payload for a force-push and for an AI self-credit commit
trailer into `git-guard.js` (with a throwaway `HOME`) and prints the real hook output. It
involves no Claude Code session. It is kept as a quick, dependency-free way to see the
guard messages, and its recording instructions write to `shell-demo.*`, never to
`anti-hall.gif`.

```sh
bash assets/demo/demo.sh
```
