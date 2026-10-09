---
title: Rust engine
description: ah-engine, the resident Rust program being built to answer anti-hall's hooks faster and with less memory.
---

# Rust engine

!!! info "Status"
    The engine is ready for release and is not part of the current plugin release: the
    plugin installs it itself once a release pins it. Until then every hook runs as a
    Node.js script, as described in the rest of these docs. Details may change before it
    ships.

## What it is

`ah-engine` is a small program written in Rust that stays running in the background, one
per user. Instead of starting a new Node.js process for every hook on every tool call,
each hook asks the engine, which answers from memory.

## Why

Each Bash tool call used to start nine Node hooks before the tool runs and six after. The
engine's design notes measured the nine pre-tool hooks at about 409 MB of memory combined
and 187 ms of CPU, with Node's own start-up being most of each hook's cost. The engine
answers the same questions from one long-lived process of about 5 MB, through a client of
about 2 MB that starts in about 2 ms.

## Live answers and Node fallback

Every hook entry becomes one thin trigger per event. When the engine is installed:

- **The engine answers** the cases it can prove give exactly the same result as the Node
  hook.
- **Node answers everything else.** Any case the engine cannot reproduce exactly is
  handed to the original Node hook, so a guard is never weaker on the engine than on
  Node.
- **If the engine is missing, busy, slow or broken**, the trigger runs the Node hooks
  exactly as before. A request that takes longer than its time budget falls back to Node.

| Situation | Who decides | Result |
|---|---|---|
| Engine installed, case proven identical | Engine | Answer from memory, about 2 ms |
| Engine installed, case not provable | Node hook | Same verdict as before |
| Engine missing, busy, slow or broken | Node hook | Same verdict as before |

!!! tip "Safe to try"
    Because Node is always the fallback, removing the engine never weakens a guard; it
    only makes hooks slower.

The engine binary is downloaded by a small bootstrap script and checked against a sha256
checksum pinned in the plugin. Supported platforms are the same as the plugin: macOS and
Linux, including WSL.

## Settings stay in plugin files

The engine reads its limits, intervals and message texts from plain configuration files
shipped with the plugin, not from values built into the binary. Changing a rule or a
message means editing a file, not rebuilding the engine. When the engine ships, its
user-overridable values are listed in the
[Settings reference](../../plugins/anti-hall/hooks/lib/settings-schema.js).
