---
title: Install
description: Install anti-hall for Claude Code or Codex, and check that it works.
---

# Install

## Before you start

- **Node.js 22 or newer** on your `PATH` (no longer needed from v1.0). Check with
  `node --version`. Today it backs the temporary compatibility fallback and a few helper
  scripts; if the shell Claude Code uses cannot find `node`, the hooks that fall back to
  it are skipped without an error.
- **macOS or Linux.** WSL on Windows works (it runs the Linux build). Native Windows is
  not supported yet.

The plugin fetches the Rust engine binary itself, checked against a pinned sha256, and needs `curl` or `wget` plus `tar` for that. If the download fails, the temporary Node.js fallback answers until the engine is installed. There are no npm packages to install.

## Claude Code

Inside Claude Code:

```text
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

The hooks apply to every project once the plugin is enabled. The statusline is a
separate, optional step: [Statusline](../features/statusline.md).

!!! tip "Try it without installing"
    From a clone of the repository, `claude --plugin-dir /path/to/anti-hall` loads the
    plugin into a single session.

## Codex

The Codex port lives in the repository, so clone it first. The installer points Codex at
the hook files inside your clone.

=== "For every project (global)"

    ```bash
    git clone https://github.com/talas9/anti-hall.git
    node anti-hall/plugins/anti-hall/codex/install-codex.js --global
    ```

    Writes `~/.codex/hooks.json`.

=== "For one project"

    Run the installer from inside the project:

    ```bash
    cd /path/to/your/project
    node /path/to/anti-hall/plugins/anti-hall/codex/install-codex.js
    ```

    Writes `.codex/hooks.json` in the current directory.

Add `--dry-run` to see what would change. The installer merges into an existing
`hooks.json`, keeps a `.bak-<timestamp>` copy of any file it changes, and turns on
`[features] hooks = true` in the matching `config.toml`.

The Codex skills are named `anti-hall-<name>` (for example `anti-hall-doctor`). The Codex
port is a separate mirror, not a copy: the hook list and skills differ where Codex works
differently. Details: [the Codex port README](../../plugins/anti-hall/codex/README.md).

## Keep session notes out of git

anti-hall writes per-project notes (progress, history, handovers, reports) under
`.anti-hall/` in your repository. It never edits your tracked files. Add this line to your
project's `.gitignore` so a `git add .` cannot commit them:

```gitignore
.anti-hall/
```

Or ask for `/anti-hall:doctor --repair`, which adds it to the repository's untracked
`.git/info/exclude` instead.

## Check that it works

- In Claude Code, ask **"is anti-hall working"**. That runs the `doctor` skill, which
  runs live self-tests on every guard.
- Or run `/anti-hall:settings` to see the active settings.
- From a clone: `node plugins/anti-hall/hooks/doctor.js --check`.

## Optional: Jev

Jev is an optional classifier that gives some guards (such as the speculation check) a
model's second opinion on top of pattern matching. It can only add blocks, never remove
one. It is **off by default**, needs your own Vercel AI Gateway or TypeSafe API key, sends
the text a guard judges to the provider you pick, and uses that provider's credits.

To turn it on, say **"activate jev"** (runs the `jev` skill). Details:
[Jev classifier](../KB-jev-classifier.md).

## Next

- [What you'll notice in your first session](../index.md#what-youll-notice-in-your-first-session)
- [Update](update.md) and [Uninstall](uninstall.md)
