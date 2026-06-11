# Step-0 probe record — v0.34.0 flutter-debug (dated evidence, not assertions)

Plan: `docs/2026-06-10-v0.34.0-flutter-debug-plan.md` (converged GO×3). Each probe:
status, evidence, what gates on it.

## FP6 — marionette upstream integration / production-safety docs
- **Status:** CAPTURED 2026-06-10 (web probe of upstream README + pub.dev).
- **Verdict: MATCH on all decided points — no conflict to surface.**
  - Dependency type: upstream documents `flutter pub add marionette_flutter` →
    regular `dependencies:` (`marionette_flutter: ^0.5.0`). Matches owner decision.
  - Init gating: upstream README verbatim:
    ```dart
    if (kDebugMode) {
      MarionetteBinding.ensureInitialized();
    } else {
      WidgetsFlutterBinding.ensureInitialized();
    }
    ```
    (comment: "Initialize Marionette only in debug mode"). The GUIDED INSTALL
    writes THIS exact if/else form, not a bare gate.
  - Production safety, upstream's own words: "Marionette only works in debug
    (and profile) mode because it relies on the VM Service. It will not work in
    release builds." Shipped skill text may now cite this (FP6-proven).
  - LogCollector: optional — `MarionetteConfiguration(logCollector:
    LoggingLogCollector())` (package `marionette_logging`); without it,
    get_logs returns a helpful how-to message (non-fatal degradation).
  - SILENT upstream: minimum Flutter/Dart versions; explicit iOS-simulator or
    Android-emulator support claims → FP7 remains REQUIRED before any Android
    promise.
- Sources: github.com/leancodepl/marionette_mcp README; pub.dev/packages/
  marionette_flutter (+ /install), accessed 2026-06-10.

## Machine inventory (probe prerequisites, captured 2026-06-10, owner machine)
- dart 3.12.0 / flutter 3.44.0 ✓ (Agentic Hot Reload tier)
- Booted iOS simulator: present (custom-named; iOS 26.5) ✓
- marionette_mcp 0.5.0 via `dart pub global list` ✓ (≥0.4.0 requirement met;
  an earlier 0.2.4 reading came from a stale wrapper-file inspection — the
  pub global list value is authoritative)
- NOT present: dart/simulator MCP registration in Claude Code (gates FP1/FP4/
  FP5; both registered later 2026-06-11); idb/idb-companion (gates the
  ios-simulator-mcp supplement only); ~~Android emulator/adb~~ **(CORRECTED
  2026-06-11 — bare-PATH false-negative; SDK 36 + AVD Pixel_9_Pro_XL exist —
  see FP7, which is ACTIVE, not deferred)**.

## FP1 — flutter_driver_command actual surface
- **Status:** IN-SCHEMA CAPTURED 2026-06-11 (direct stdio JSON-RPC tools/list
  against `dart mcp-server`, no registration needed). The default list = 13
  tools. `flutter_driver_command.command` is a REQUIRED ENUM of 16 values
  including **`tap`** and **`screenshot`** (+ enter_text, scroll,
  scrollIntoView, waitFor/waitForTappable, get_text, get_offset,
  get_diagnostics_tree…). `finderType` enum: ByType, ByValueKey,
  ByTooltipMessage, BySemanticsLabel, ByText, PageBack, Descendant, Ancestor —
  SEMANTIC targeting. Schema explicitly forbids guessing finder values (run
  widget_inspector first).
- **OVERTURNS** the KB §6 "official server is blind" framing AT THE SCHEMA
  LEVEL. **RESIDUAL FP1b:** runtime behavior against a PLAIN debug app is
  UNVERIFIED — classic flutter_driver historically requires
  `enableFlutterDriverExtension()` in-app; whether this tool works via DTD
  without that is unknown. No shipped promise from flutter_driver_command
  until FP1b runs against the live app.

## FP1-marionette — actual tool surface (same stdio probe)
- **Status:** CAPTURED 2026-06-11 — 16 tools: all 7 documented ones present
  PLUS 9 undocumented extras: disconnect, double_tap, long_press, swipe,
  pinch_zoom, press_back_button, scroll_to, list_custom_extensions,
  call_custom_extension, hot_reload. Richer than the KB records.

## FP2 — Flutter widget exposure in iOS accessibility tree (coordinate-tap reliability)
- **Status:** PENDING — only needed for the ios-simulator-mcp supplement path
  (requires idb install); marionette-primary path does not depend on it.

## FP4 — lifecycle-tools enablement + get_app_logs scope
- **Status:** DEFAULT-LIST CONFIRMED 2026-06-11 (same stdio probe):
  launch_app/stop_app/list_devices/get_app_logs ALL ABSENT from the default
  13-tool list — disabled-by-default premise holds; manual `flutter run
  --print-dtd` stays the default documented path. RESIDUAL: the enablement
  mechanism (flag/env to turn the category on) not yet probed.

## FP8 — plugin-bundled MCP servers (zero-setup mechanics, official docs)
**[SUPERSEDED by owner directive 2026-06-11b — anti-hall does NOT bundle
external servers; registration uses the FP9/FP10 CLI flow. Retained as
captured reference only; the launcher-shim design below is DROPPED.]**
- **Status:** CAPTURED 2026-06-11 (code.claude.com/docs plugins +
  plugins-reference):
  - `.mcp.json` at plugin root (or `mcpServers` in plugin.json);
    `${CLAUDE_PLUGIN_ROOT}` interpolates; paths must be RELATIVE (`./…`).
  - Bundled servers start AUTOMATICALLY when the plugin is enabled — the
    zero-setup registration mechanism is official.
  - On plugin UPDATE, MCP servers keep the OLD version's path until
    `/reload-plugins` — restart alone is NOT sufficient. (The update skill
    already ends with /reload-plugins — synergy, but its text must mention
    MCP-path switching too.)
  - Missing-binary failure mode: UNDOCUMENTED → neutralized by design: bundle
    LAUNCHER SHIMS (node scripts that always exist; they self-provision the
    downstream binary — `dart pub global activate marionette_mcp` — or answer
    the MCP handshake with a clean "unavailable" rather than crashing).
  - No install-time hooks exist; the DOCUMENTED self-provisioning pattern is
    SessionStart + `${CLAUDE_PLUGIN_DATA}` lazy install — official support for
    the shim approach.

## FP5 — MCP tools reachable from a SPAWNED agent (vs main context)
- **Status:** GENERIC MECHANISM PROVEN 2026-06-11 — a spawned subagent used
  ToolSearch to surface 10 mcp__ tools and successfully INVOKED one
  (firebase_get_environment returned live data). Spawned agents reach MCP.
  The agent-based architecture is viable; the skill-only fallback is unlikely
  to be needed. RESIDUAL: confirm the dart/marionette servers' tools
  specifically surface in a spawned agent post-registration (one-line
  ToolSearch check at implementation; both servers registered 2026-06-11,
  `claude mcp list` = Connected ×2, user scope).

## FP7 — marionette on Android emulator
- **Status:** UN-DEFERRED 2026-06-11 — the "no Android tooling" inventory line
  was a PATH FALSE-NEGATIVE (owner challenged it; corrected probe confirms):
  SDK complete at `~/Library/Android/sdk` (SDK 36.0.0), AVD **Pixel_9_Pro_XL**
  defined (`~/.android/avd/*.ini`), adb + emulator functional via DIRECT
  paths, `flutter doctor` Android toolchain green. FP7 RUNS in the probe gate
  (boot AVD → marionette connect → tap/screenshot).
- **LESSON (binding for preflight.js + doctor):** never bare-PATH-probe
  Android tooling — resolve `$ANDROID_HOME`/`$ANDROID_SDK_ROOT`/
  `~/Library/Android/sdk` explicitly; `flutter doctor` is the authoritative
  cross-check.

## FP9 — `claude mcp add` scope semantics (official docs, 2026-06-11)
- Scopes: `--scope local` (DEFAULT; ~/.claude.json per-project entry),
  `project` (.mcp.json at project root, git-shared, FIRST-USE APPROVAL
  prompt), `user` (~/.claude.json top-level).
- Precedence on name collision: local > project > user > plugin-provided >
  connectors; highest wins WHOLE entry (no merge).
- `claude mcp add` with an existing name in the SAME scope → hard error
  "Server already exists" (no silent overwrite) — add-if-absent is therefore
  naturally atomic; existence check via `claude mcp get <name>` (output not
  documented machine-parseable — parse defensively, treat unparsable as
  "unknown, don't add").
- Consequence for zero-setup: idempotent add flow = `claude mcp get` →
  absent? `claude mcp add --scope <chosen>` → exists anywhere? SKIP (user's
  own entry wins by precedence anyway — never remove/overwrite).
- **RESIDUAL (R4-F6):** post-CLI-add tool VISIBILITY semantics uncaptured —
  whether /reload-plugins suffices (vs session restart) for a freshly
  `claude mcp add`-ed server is NOT covered by FP8 (that captured
  plugin-bundled UPDATE semantics, a different mechanism). Verify during
  owner E2E; guidance stays conservative ("restart; /reload-plugins may
  suffice") until then.

## FP10 — ecosystem precedents for registering EXTERNAL MCP servers (2026-06-11)
- **OMC mcp-setup** (SKILL.md:95-97,101-123,243-245): uses `claude mcp add`
  CLI exclusively ("CLI automatically handles settings.json updates and
  merging"); NO scope flags used (CLI default = local); update policy =
  remove-then-re-add; no transactional machinery of its own. OMC's bundled
  .mcp.json carries ONLY its own `t` bridge — zero external servers.
- **Counter-precedent:** ecc 2.0.0-rc.1 bundles SIX external servers
  (github/context7/exa/memory/playwright/sequential-thinking) in its
  .mcp.json; episodic-memory bundles its own wrapper. Both patterns exist in
  the wild; plugin-bundled entries sit LOWEST in name-collision precedence
  (FP9), so user entries always win — but bundling externals runs duplicate
  server processes when the user has their own (the owner's stated objection).
- **DECISION (owner directive 2026-06-11b):** anti-hall registers dart +
  marionette via the OMC-style `claude mcp add` path, hardened with FP9's
  idempotent flow (get-check → add-if-absent in user-chosen scope → skip if
  present anywhere) — never bundles externals, never removes/overwrites.
