---
title: How it works
description: anti-hall is a Rust engine at its core. One resident program answers every hook through a thin trigger, running the plugin's own rules, logic and settings.
---

# How it works

anti-hall is built around a **Rust engine**, `ah-engine`. It is the core of the plugin,
not an add-on: every hook the assistant's harness fires is answered by it. The guards,
tasks, handovers and the other [features](../features/index.md) are what the engine does;
this page is how it does it.

!!! info "Status"
    The plugin fetches the engine binary itself. Node.js is a **temporary compatibility
    fallback** during the migration to the engine: it only answers when the engine cannot,
    and it is **removed entirely in v1.0**, after which the Rust engine is the only
    runtime.

## The core: one engine, one thin trigger

`ah-engine` is a small program that stays running in the background, one per user. Each
hook event in the plugin's `hooks.json` is one thin trigger, `hooks/ah-hook.sh <Event>`,
that hands the event to the engine. The engine decides which checks apply to that event
and answers from memory.

```text
Claude Code / Codex
   │  hook event, JSON payload
   ▼
thin trigger    hooks/ah-hook.sh <Event>      (one per event)
   ▼
engine client ──socket──▶ ah-engine (one resident process per user)
                              │ reads at run time, from the plugin:
                              ▼
                    engine/logic/*.js     the rules' logic
                    engine/defaults/*.toml   settings and message texts
```

This replaced one Node.js process per hook per tool call. The engine's design notes
measured the nine pre-tool hooks of a Bash call at about 409 MB of memory combined and
187 ms of CPU, most of it Node's own start-up. The engine answers from one long-lived
process of about 5 MB, through a client of about 2 MB.

## The plugin owns the rules

The engine is a runtime; the rules are the plugin's own files, read when the engine
starts, when the plugin updates and when a file changes. Nothing is compiled into the
binary.

| What | Where in the plugin | Format |
|---|---|---|
| Logic of each check | `engine/logic/<check>.js`, with shared helpers in `engine/logic/lib/` | JavaScript, run inside the engine in a sandboxed interpreter |
| Settings, limits, intervals, message texts | `engine/defaults/*.toml` | TOML |
| Which checks answer which event | `engine/defaults/dispatch.toml` | TOML |

Changing a rule or a message means editing a plugin file, not rebuilding the engine. Your
own overrides live in `~/.anti-hall/settings.json`; see [Settings](../settings/index.md).

## The temporary Node fallback

While checks are still being moved into the engine, the trigger keeps a compatibility
fallback so a guard is never weaker than before:

| Situation | Who decides |
|---|---|
| Engine installed, check handled by the engine | Engine, from memory |
| Check not yet moved into the engine, or the engine cannot decide it exactly | The original Node.js hook, for that one event |
| Engine missing, busy, slow or broken | The original Node.js hooks, with a one-line note |

This is a migration aid, not a mode you choose. It goes away in v1.0, together with the
Node.js prerequisite.

The engine binary is downloaded by a small bootstrap script and checked against a sha256
checksum pinned in the plugin. Supported platforms are the same as the plugin: macOS and
Linux, including WSL.

## Learn more

- [Features](../features/index.md): what the engine does for you.
- [Settings](../settings/index.md): every setting and its default.
- [Engine design and status](../AH-ENGINE.md): architecture, what still runs on Node, and
  measured results.
