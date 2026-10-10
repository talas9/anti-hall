---
title: Statusline
description: The retired anti-hall Claude Code statusline and cleanup path for old installs.
---

# Statusline

The anti-hall statusline installer is retired. New setup, update, doctor, and
`install-statusline` flows no longer write `statusLine` into Claude settings.

## Remove it

If an older install already has an anti-hall `statusLine`, keep using it as-is or
remove it with `uninstall-statusline`. The cleanup command restores the previous
statusLine when anti-hall saved one, otherwise removes the anti-hall entry.

## Codex

Codex/OMX does not support anti-hall's old command-backed Claude statusline. Use
the built-in Codex/OMX HUD/status surfaces instead.
