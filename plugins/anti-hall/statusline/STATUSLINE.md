# anti-hall Statusline

The command-backed Claude Code statusline installer is retired. New setup,
update, doctor, migration, and `install-statusline` flows do not write
`settings.statusLine` or upgrade an existing one.

This directory remains for two reasons:

- legacy renderers used by older installations that still point at them;
- `uninstall-statusline.js`, which cleans up older anti-hall `statusLine`
  settings.

## Retired installer

`install-statusline.js` is now a no-op. It exits successfully and prints that no
`statusLine` setting was written. Do not use it to set up Claude settings.

## Cleanup / uninstall

If an older install still has an anti-hall `statusLine`, run:

```sh
node statusline/uninstall-statusline.js [--user|--project] [--purge-base]
```

The uninstaller tries these cleanup strategies in order:

1. If `~/.anti-hall/base-statusline.json` exists, restore that command as the
   `statusLine.command` and remove the base config file unless `--purge-base`
   says otherwise.
2. Else if `<settings>.bak-antihall` exists, restore the prior settings file.
3. Else remove only the old anti-hall `statusLine` entry.

It is idempotent and leaves unrelated/custom `statusLine` commands alone.
Restart Claude Code after cleanup because Claude reads `statusLine` at startup.

## Legacy renderer files

These scripts are retained for old installs and for cleanup compatibility:

| Script | Legacy purpose |
|---|---|
| `statusline.js` | Dispatcher: renders line 1 plus optional line 2 when an old Claude `statusLine` still invokes it. |
| `statusline-rich.js` | Rich line-1 renderer. |
| `statusline-monorepo.js` | Monorepo line-1 renderer fallback. |
| `statusline-simple.js` | Minimal line-1 renderer fallback. |
| `phase-bar.js` | Phase/activity/context line renderer. |
| `phase.js` | Phase-state writer used by orchestration integrations. |
| `install-statusline.js` | Retired no-op; writes no settings. |
| `uninstall-statusline.js` | Cleanup for older anti-hall `statusLine` installs. |
