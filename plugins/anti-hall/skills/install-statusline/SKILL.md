---
name: install-statusline
description: Retired anti-hall statusline installer. Use only to explain removal or point to cleanup.
---

# Install Statusline

The anti-hall statusline has been retired. Do not add or restore a Claude
`statusLine` entry for anti-hall.

`install-statusline` is kept as a no-op for old invocations: it prints that no
settings were written and exits 0. This prevents setup, repair, update, or habit
from re-adding a command-backed statusline.

## Uninstall

For cleanup of older installs, run:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/ah-run.sh" uninstall-statusline
```

That command remains supported and restores/removes the old `statusLine`
according to the saved backup/base files.
