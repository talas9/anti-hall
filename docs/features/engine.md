---
title: Rust engine
description: ah-engine, the resident Rust program being built to answer anti-hall's hooks faster and with less memory.
---

# Rust engine

!!! warning "Not in a release yet"
    The engine is being built on a separate integration branch and is not part of the
    current release. Today every hook runs as a Node.js script, as described in the rest
    of these docs. This page explains what is coming; details may change before it ships.

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

The engine binary is downloaded by a small bootstrap script and checked against a sha256
checksum pinned in the plugin. Supported platforms are the same as the plugin: macOS and
Linux, including WSL.

## Settings stay in plugin files

The engine reads its limits, intervals and message texts from plain configuration files
shipped with the plugin, not from values built into the binary. Changing a rule or a
message means editing a file, not rebuilding the engine. When the engine ships, its
user-overridable values are listed in the
[Settings reference](../../plugins/anti-hall/hooks/lib/settings-schema.js).
