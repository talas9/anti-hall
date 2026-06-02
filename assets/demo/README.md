# Demo assets

Record anti-hall in action with this kit. Two recording paths:

1. **Reliable: `asciinema` + `agg`** — deterministic, re-runnable GIF from a shell script
2. **Alternative: VHS** — if asciinema works for you; VHS headless-Chrome/ttyd pipeline can error on some macOS setups
3. **Most compelling: Live Claude Code session** — manually recorded, shows guards + statusline in a real session

---

## 1. Generate `anti-hall.gif` (asciinema + agg) — RECOMMENDED

The most reliable path: [asciinema](https://asciinema.org/) records terminal playback as
a `.cast` file; [`agg`](https://github.com/asciinema/agg) renders it to a GIF.

```sh
# Install asciinema and agg (if not already present)
brew install asciinema agg

# From the repo root, record the demo script:
asciinema rec -c "bash assets/demo/demo.sh" assets/demo/anti-hall.cast

# Then render the .cast to a GIF:
agg assets/demo/anti-hall.cast assets/demo/anti-hall.gif
# -> writes assets/demo/anti-hall.gif
```

The script runs real hooks from this repo (relative paths from the repo root):

| Step | Command | Shows |
|------|---------|-------|
| 1 | `doctor.js --quiet` | `anti-hall ACTIVE — N checks passed` |
| 2 | force-push piped to `git-guard.js` | `BLOCKED. Force push detected.` `exit=2` |
| 3 | AI-credit trailer piped to `git-guard.js` | `BLOCKED. ... AI/assistant self-credit trailer` `exit=2` |
| 4 | `npm run build` piped to `command-guard.js` | `decision":"block"` delegate-to-subagent, `exit=2` |
| 5 | `statusline-rich.js` | the rich one-line statusline (line 1 only; full two-line in live sessions) |

> The statusline reflects your local git/email config — it is read at runtime, nothing is hardcoded.

---

## 2. Alternative: Generate `anti-hall.gif` (VHS)

[VHS](https://github.com/charmbracelet/vhs) renders a terminal script to a GIF directly.
Use this if asciinema doesn't work for you; note that VHS requires headless Chrome + ttyd,
which can fail with `ERR_CONNECTION_REFUSED` on some macOS setups.

```sh
# Install VHS (see https://github.com/charmbracelet/vhs#installation for other OSes)
brew install vhs

# From the repo root:
vhs assets/demo/anti-hall.tape
# -> writes assets/demo/anti-hall.gif
```

If VHS fails with ttyd errors, fall back to the asciinema + agg path above.

---

## 3. Storyboard — LIVE Claude Code session (record manually) — MOST COMPELLING

Record this with any screen recorder (QuickTime, [Kap](https://getkap.co), etc.).
Target ~20–30s. It shows the guards firing inside a real session, which automated scripts can't.

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

## 4. Embed the GIF in the README

Once a good `anti-hall.gif` is recorded, add it to the **README hero** (top of the root
`README.md`):

```html
<img src="assets/demo/anti-hall.gif" alt="anti-hall demo" width="720">
```

Not embedded yet (by choice); include when a good GIF is ready.
