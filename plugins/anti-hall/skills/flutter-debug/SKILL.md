---
name: flutter-debug
description: Drive a Flutter app in debug mode and close the fix loop — run with agent-controlled hot reload, drive the UI with semantic taps + agent-visible screenshots, watch runtime errors / logs / VM service, then reproduce → read error → root-cause → fix → hot reload → visually re-verify. Use when the user says "debug my Flutter app", "drive the simulator/emulator", "reproduce this bug in the app", "fix this and verify it in the UI", "hot reload and check", or wants an end-to-end Flutter debug loop. iOS fully; Android run/reload/errors today, taps/screenshots pending FP7.
---

# flutter-debug

Set up and run an agent-driven Flutter debug loop: run the app in debug mode with
agent-controlled hot reload, drive the UI (semantic taps + agent-visible screenshots),
watch runtime errors / logs / VM service, and close the loop — reproduce → read error →
root-cause → fix → hot reload → **visually re-verify**.

The loop protocol itself lives in the **`flutter-debug` agent** (shipped in this plugin's
`agents/`). This skill does the SETUP — preflight, zero-setup MCP registration, app
integration, capability degradation — then **delegates the loop to that agent**. The
coordinator stays non-blocking.

**Trigger phrases:** "debug my Flutter app", "drive the iOS simulator / Android emulator",
"reproduce this bug in the running app", "fix it and verify in the UI", "hot reload and
check the screen", "watch the Flutter runtime errors", "run the app and close the fix loop".

## Honest scope (state this verbatim to the user)

- **iOS:** full loop today (booted simulator).
- **Android:** run / reload / runtime-error reading work today — the Dart MCP DTD tools
  (`hot_reload`/`hot_restart`/`get_runtime_errors`/`widget_inspector`) are device-agnostic
  [2]. **Taps + screenshots on Android are PENDING probe FP7** — not promised yet (the AVD
  exists; the probe is active, not "no tooling"). `flutter_driver_command` (official server)
  carries tap + screenshot + semantic finders IN-SCHEMA (FP1) but its runtime against a
  plain debug app is UNVERIFIED pending **FP1b** — no promise from that path until FP1b passes.
- **No screenshot tool present ⇒ NO visual verification.** The loop reports "error-clear but
  visually unverified", never "verified".
- The official **Dart MCP server is experimental** [1]; tool names may drift — the preflight
  reports what is actually registered and the agent re-checks via `ToolSearch`.
- The official server's lifecycle tools (`launch_app`/`get_app_logs`/…) are **disabled by
  default** [2]; the default path is a manual `flutter run --print-dtd`. `get_app_logs` is
  **double-gated** — available ONLY on the launch_app-enabled path, never on a manual run [2].
- `flutter_mcp_server` (thecentinol) is a **trap**: despite the name it has no hot reload, no
  device control, no VM service [7]. We never use it.

## MCP composition (zero-setup; nothing bundled)

| Tier | Server | Role |
|---|---|---|
| **REQUIRED** | official Dart MCP (`dart mcp-server`) | hot_reload / hot_restart / get_runtime_errors / widget_inspector / call_vm_service_method / analyze_files [2] |
| **PRIMARY (eyes & hands)** | marionette_mcp ≥ 0.4.0 (LeanCode) | semantic tap / enter_text / scroll_to + take_screenshots (base64) + get_logs [5] |
| **SUPPLEMENT + fallback** | joshuayoes/ios-simulator-mcp | coordinate taps + screenshots anywhere on the iOS simulator; no-package fallback for unmodifiable apps [10] (Flutter tap reliability UNVERIFIED — FP2) |
| **EXCLUDED** | mcp_flutter (untested-merge [6]); flutter_mcp_server (no reload/VM service [7]) | — |

We do **NOT** bundle a `.mcp.json` for external servers (running duplicate processes when
the user already registered dart/marionette is the hazard — owner directive; FP10). Instead
each of dart + marionette is registered with an **idempotent scope-aware `claude mcp add`**
(FP9): `claude mcp get <name>` → absent everywhere ⇒ add in the chosen scope → present in ANY
scope ⇒ **SKIP** (user entries win by precedence; we never remove/overwrite). Manual fallback:
`claude mcp add --transport stdio dart -- dart mcp-server` [1] and `dart pub global activate
marionette_mcp` [5].

## Steps

### 1. Scope question — asked ONCE, in MAIN context, BEFORE delegating

The delegated preflight subagent **cannot prompt**, so the scope for any `claude mcp add`
must be chosen here. First run a quick **read-only** pre-check in main context to decide
whether to even ask:

```
claude mcp get dart
claude mcp get marionette
```

- **Both already registered (any scope)** ⇒ there is nothing to add ⇒ **SKIP the question
  entirely** and pass `--scope local` (it won't be used).
- **Either absent** ⇒ ask the user ONCE with `AskUserQuestion`:

  > Register the dart + marionette MCP servers in which scope?
  > - **local** (default) — this project only, no approval prompt
  > - **project** — git-shared `.mcp.json`, first-use approval for collaborators
  > - **user** — all your projects

- **Non-interactive run** (no way to prompt) ⇒ use the default **local** and say so.

Pass the chosen scope to the preflight as `--scope <chosen>`. The preflight **re-checks
authoritatively** before any add (so a race between the pre-check and the add is safe).

### 2. Preflight — delegated to a subagent (read-mostly; two documented auto-fixes)

The preflight is a `node` script (a state change — it may `claude mcp add` and `dart pub
global activate`), so the command-guard blocks it on the main thread. **Delegate it** and
relay its report:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/flutter-debug/scripts/preflight.js" --scope <chosen> --project <flutter-project-dir>
```

It picks the capability **tier** (full-visual / coordinate-visual / error-only / blocked),
performs the FP9 idempotent registration, self-provisions the marionette host CLI if missing,
and prints the degradation table. After a FRESH `claude mcp add`, the new tools may not surface
until a **session restart** (`/reload-plugins` may suffice — post-CLI-add visibility is verified
at owner E2E; stay conservative until then).

### 3. App integration — AUTO-APPLY on first use (git diff is the visibility)

If the target `pubspec.yaml` does not list `marionette_flutter`, auto-apply it (no ask-first
prompt — `git diff` is the trivially-revertable visibility mechanism, shown AFTER writing):

- Add `marionette_flutter` as a **regular dependency** (NOT `dev_dependencies` — it is invoked
  from `main.dart`, which `dev_dependencies` cannot reach).
- Add the **upstream-verbatim** debug-only init in `main.dart` (FP6 MATCH — "Initialize
  Marionette only in debug mode"; "It will not work in release builds"):

  ```dart
  if (kDebugMode) {
    MarionetteBinding.ensureInitialized();
  } else {
    WidgetsFlutterBinding.ensureInitialized();
  }
  ```

- Then **show the applied `git diff`** so the change is visible and one revert undoes it.
- `LogCollector` is optional — without it `get_logs` returns a helpful how-to (non-fatal) [5].

If the app cannot be modified (read-only / unmodifiable), skip integration and use the
**coordinate fallback** (ios-simulator-mcp).

### 4. Spawn the loop — delegate to the `flutter-debug` agent

Spawn the agent (it carries the full loop protocol) with the tier + project context:

```
Agent({
  description: "Flutter debug loop (drive, watch, fix, hot-reload, visually verify)",
  subagent_type: "flutter-debug",   // model: sonnet, from the agent frontmatter
  run_in_background: true,
  prompt: "<project dir, capability tier from preflight, the bug to reproduce, "
        + "and any seed steps. The agent runs preflight-tier → reproduce → read "
        + "error → root-cause → fix → hot reload → visually re-verify.>",
})
```

Do **not** pin a `model:` here — the agent frontmatter sets `sonnet` (the code-authoring
floor; a flagship on a mostly-mechanical drive loop is exactly what model-routing-guard flags).

### 5. Escalation respawn (coordinator-side rule)

If the agent reports **`escalate: opus`** (its trigger: 2 full loop iterations without a proven
root cause, or a fix that needs architecture redesign), the coordinator **respawns the same
agent with `model: "opus"`**, carrying forward the collected evidence:

```
Agent({
  description: "Flutter debug loop — escalated (opus, architecture/root-cause)",
  subagent_type: "flutter-debug",
  model: "opus",
  run_in_background: true,
  prompt: "<carry forward: errors before/after, widget tree, screenshots, what was "
        + "ruled out — continue root-cause + fix from here.>",
})
```

The agent never respawns itself. Diff review goes to the deadly-loop, not this agent.

## Degradation table (verbatim — matches the preflight output)

| Missing | Loop degrades to | Skill says |
|---|---|---|
| Dart MCP | STOP — no reload/error reading; print install step | refuse to claim debug-loop capability |
| dart 3.9–3.11 | loop works; DTD URI may need manual copy [4][3] | WARN + upgrade recommendation |
| marionette (host or app-side) | ios-simulator-mcp fallback: coordinate taps + screenshots [10], FP2 caveat (marionette = PRIMARY per owner directive, overriding KB §5) | semantic taps unavailable — coordinate fallback |
| marionette missing AND FP1b-true | flutter_driver_command path: semantic finders (ByValueKey/ByText/BySemanticsLabel…), widget_inspector first (schema forbids guessing finder values), tap + screenshot with NO app package | using official-server driver path — only ships if FP1b passes |
| both visual MCPs (and FP1b false/unprobed) | error-driven loop only (get_runtime_errors/widget_inspector [2]); NO visual verification | cannot visually verify — evidence is runtime-error state only |
| lifecycle tools (disabled by default [2]) | user runs `flutter run --print-dtd`; agent connects dtd→listDtdUris→connect [2] | get_app_logs unavailable on this path (loop step 3) |
| Android target | run/reload/errors work today [2]; taps/screenshots PENDING FP7 (probe ACTIVE — AVD available; not "no tooling") | Android visual status = FP7 outcome, stated verbatim |

## Limitations & follow-ups

- Android adb-level visual control is gated on **FP7** (active probe); no vetted adb-level
  Android MCP is in the evidence base (KB §3/§6) — a follow-up Android MCP sweep is tracked in
  `docs/KB.md` staleness ledger.
- `mcp_flutter` is excluded until its untested-merge warning lifts in a stable tag (**FP3**
  gate, KB.md staleness ledger).
- Citations: `[n]` → `docs/KB-flutter-claude-debug.md`; FP-ids → `tests/fixtures/step0-probe-record-v0.34.0.md`.
