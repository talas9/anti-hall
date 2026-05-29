# anti-hall

A Claude Code plugin that fights the four most common failure modes:

1. **Eagerness** — answering/acting before investigating.
2. **Hallucination** — stating unverified facts (file contents, API behavior, values) as truth.
3. **Solution-before-diagnosis** — proposing fixes before proving the root cause.
4. **Fake completion** — claiming work is done/fixed/passing without running the check.

## How it works

A `UserPromptSubmit` hook injects a compact **verify-first protocol** into the model's
context at the start of *every* turn. This beats putting the same rules in `CLAUDE.md`,
because instruction compliance decays with file length — rules buried near the bottom of a
long config barely fire. Injecting the rules fresh each turn keeps them at the highest-
attention position.

No blocking `Stop` hook is used: those require semantic judgment that string matching can't
do, produce false positives, and add latency on every turn.

No external dependencies (no `jq`) — runs unchanged on any machine.

## What it injects

> VERIFY-FIRST PROTOCOL (this turn): evidence before claims · uncertainty is allowed ·
> cause before fix · no fake completion · no narrative padding · label non-obvious claims
> as [verified] / [inference] / [assumption].

See `hooks/verify-first.sh` for the full text. Edit that one file to tune the wording.

## Files

```
anti-hall/
├── .claude-plugin/plugin.json   # manifest
└── hooks/
    ├── hooks.json               # registers the UserPromptSubmit hook
    └── verify-first.sh          # emits the additionalContext (edit to customize)
```

## Test locally before installing

```bash
# 1. The hook emits valid JSON with additionalContext:
echo '{"prompt":"x"}' | ./hooks/verify-first.sh

# 2. Load the plugin in a throwaway session:
claude --plugin-dir /path/to/anti-hall
```

## Install (any machine, any repo)

```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

It applies globally once enabled — no per-repo `CLAUDE.md` edits needed.
