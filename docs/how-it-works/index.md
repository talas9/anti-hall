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

## Binary download and verification

The engine is a prebuilt binary that the plugin fetches itself, so it is worth knowing exactly
what that does. Every point below is read from the code in this repository.

| Question | Answer |
|---|---|
| What is fetched | One archive, `ah-engine-vX.Y.Z-<target>.tar.gz`, for your platform (macOS arm64/x86_64, Linux x86_64/arm64 on glibc or musl; WSL counts as Linux). Only the single `ah-engine` file is extracted from it. |
| From where | `https://github.com/talas9/anti-hall/releases/download/ah-engine-vX.Y.Z/` over HTTPS (TLS 1.2 or newer, 120 s limit, 128 MB cap). Nothing about you or your project is sent. |
| Which version | The one pinned in `plugins/anti-hall/ah-engine.lock`, which ships inside the plugin. The version and the sha256 of every asset come from that file, never from the network. |
| How it is verified | The download is installed only if its sha256 equals the lock's entry. There is no trust on first use. The extracted binary must also run and report the pinned version. |
| If it fails | A download error, a checksum mismatch, a binary that does not run, or an unsupported platform installs nothing. The reason goes to `~/.anti-hall/ah-engine/bootstrap.log`, the session carries on, and the temporary Node.js hooks keep answering. A failed attempt is retried after 6 hours. |
| Install location | `~/.anti-hall/ah-engine/bin/ah-engine`, replaced atomically, previous copy kept as `ah-engine.prev`. |
| Provenance | Each release carries `SHA256SUMS` and a GitHub build-provenance attestation, created by `.github/workflows/ah-engine-release.yml`. Check one with `gh attestation verify <archive> --repo talas9/anti-hall`. |
| Immutability | Tags `v*` and `ah-engine-v*` are covered by a repository ruleset that blocks deletion and updates, and the repository has immutable releases enabled, so a published release's assets and tag cannot be changed. |
| Opt out | The setting `engine.bootstrap` = false, or `AH_ENGINE_BOOTSTRAP=0` (which overrides the setting). The Node.js hooks then do everything. |

**What the binary does on the network.** The engine runs as a per-user background process that
listens only on a private Unix socket. Its only HTTP client (`ureq` with `rustls`) lives in the
opt-in Jev module, which is off by default; with Jev off the engine makes no network
connections. The download above is done by the shell script, not by the engine. The sources
are in `ah-engine/` and the dependency list is `ah-engine/Cargo.toml`.

**Build from source.** There is no switch that makes the bootstrap build or fetch from a
different place. What is supported is a binary you put in place yourself: the bootstrap never
overwrites `~/.anti-hall/ah-engine/bin/ah-engine` when it did not install it (or when it no
longer matches what it installed), and the trigger runs that file. Turn the download off too,
so a pinned release is not fetched when the file is absent.

```bash
git clone --branch ah-engine-vX.Y.Z --depth 1 https://github.com/talas9/anti-hall.git
cd anti-hall/ah-engine
scripts/build.sh                     # cargo build --release --locked; prints the binary's path and sha256
mkdir -p ~/.anti-hall/ah-engine/bin
cp target/<triple>/release/ah-engine ~/.anti-hall/ah-engine/bin/ah-engine   # <triple> as printed by build.sh
export AH_ENGINE_BOOTSTRAP=0         # or set engine.bootstrap = false
```

The `AH_ENGINE_BIN` variable is a test-only override and is ignored in normal use. Full
procedure and offline builds from the vendored source archive:
[RELEASING.md](https://github.com/talas9/anti-hall/blob/main/ah-engine/RELEASING.md).

## Learn more

- [Features](../features/index.md): what the engine does for you.
- [Settings](../settings/index.md): every setting and its default.
- [Engine design and status](../AH-ENGINE.md): architecture, what still runs on Node, and
  measured results.
