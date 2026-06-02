# Demo assets

Two GIFs make anti-hall legible at a glance:

1. **`anti-hall.gif`** — a reproducible, command-driven demo generated from
   [`anti-hall.tape`](./anti-hall.tape) with [VHS](https://github.com/charmbracelet/vhs).
2. A **live Claude Code session** GIF — recorded by hand (storyboard below).

---

## 1. Generate `anti-hall.gif` (VHS)

[VHS](https://github.com/charmbracelet/vhs) renders a terminal script to a GIF, so the
demo is deterministic and re-runnable.

```sh
# install VHS (see https://github.com/charmbracelet/vhs#installation for other OSes)
brew install vhs

# from the repo root:
vhs assets/demo/anti-hall.tape
# -> writes assets/demo/anti-hall.gif
```

The tape runs real hooks from this repo (relative paths from the repo root):

| Step | Command | Shows |
|------|---------|-------|
| 1 | `doctor.js --quiet` | `anti-hall ACTIVE — N checks passed` |
| 2 | force-push piped to `git-guard.js` | `BLOCKED. Force push detected.` `exit=2` |
| 3 | AI-credit trailer piped to `git-guard.js` | `BLOCKED. ... AI/assistant self-credit trailer` `exit=2` |
| 4 | `npm run build` piped to `command-guard.js` | `decision":"block"` delegate-to-subagent, `exit=2` |
| 5 | `statusline-rich.js` | the rich one-line statusline |

> The statusline line reflects your local git/email config — it is read at runtime,
> nothing is hardcoded. Re-run after editing the tape to regenerate.

---

## 2. Storyboard — LIVE Claude Code session GIF (record manually)

Record this with any screen recorder (QuickTime, [Kap](https://getkap.co),
`asciinema` + `agg`, etc.). Target ~20–30s. It shows the guards firing inside a real
session, which the VHS tape can't.

1. **Open a repo that has the plugin installed** (`/plugin install anti-hall`, or this
   repo cloned). Start Claude Code so SessionStart fires.
2. **Show the two-line statusline** at the bottom — the rich line (project ● user │
   branch │ model │ ctx%) plus the phase bar. Let it sit a beat so it's readable.
3. **Ask Claude to force-push**, e.g. "push my branch with --force". Watch **git-guard
   BLOCK** it with the "Force push detected" refusal — the command never runs.
4. **Run `/anti-hall:doctor`** and let the health report scroll: Node found, every hook
   present + syntax-valid, guards firing, statusline installed → `anti-hall ACTIVE`.
5. End on the green ACTIVE line.

Keep typing unhurried; pause ~2s on each guard message so a viewer can read it.

---

## 3. After recording

Once `anti-hall.gif` exists, add it to the **README hero** (top of the root
`README.md`) so the listing leads with a working demo.
