# Claude Code × Flutter Debug-Mode Development (macOS) — Knowledge Base

**Scope:** simulator/emulator control, console watching, fix→hot-reload→verify loops.
**Date:** 2026-06-10. All claims cite numbered sources (section 7). Conflicts and
unverified items flagged inline. Produced by a haiku source-swarm (34 unique
sources found, 15 reachable+extracted) + Fable xhigh synthesis; 13 cited.

## 1) TL;DR capability matrix

| Tool | App control (run / hot-reload) | Input (tap/swipe/type) | Visual feedback (agent-visible screenshots) | Console / VM-service watching | Maturity |
|---|---|---|---|---|---|
| **Dart MCP server** (official, `dart mcp-server`) | hot_reload + hot_restart (DTD); launch_app/stop_app exist but **disabled by default** [2] | Only `flutter_driver_command` ("Run a flutter driver command"); no tap/swipe primitives documented [2] | **None documented** in v1.0.1 tool list [2]; docs mention introspection but no screenshot tool [1] | get_runtime_errors; get_app_logs (disabled by default, only for launch_app-started apps); call_vm_service_method; widget_inspector [2] | Docs say "experimental" (2026-05-05) [1]; repo at v1.0.1, official dart-lang org, 266★ [2] |
| **marionette_mcp** (LeanCode) | hot reload without state loss (no launch tool documented) [5] | tap (key/text match), enter_text, scroll_to [5] | take_screenshots → base64 images of all active views [5] | get_logs (requires in-app LogCollector); connect/disconnect via VM-service extensions; get_interactive_elements [5] | v0.4.0 (2026-03-16), last commit 2026-05-17, 314★, active; requires `marionette_flutter` package in the app [5] |
| **mcp_flutter** (Arenukvern) | hot-reload + hot-restart tools [6] | tap widgets, type into forms, scroll [6] | screenshots + semantic snapshots ("closed feedback loop visual & semantic") [6] | evaluate Dart expressions, recent log inspection, VM info / app discovery via debugPort.wsUri [6] | Experimental: v4.0.0-dev.1 carries an "untested merge" warning [6] |
| **flutter_mcp_server** (thecentinol) | `run` = one-shot Process.run; **no hot reload** [7] | None [7] | None [7] | None — flutter_inspector documented but NOT implemented [7] | v1.0.0 (2025-04-24); CLI wrapper (analyze/format/fix/test) only [7] |
| **facebook/idb** (CLI, not MCP) | App install/launch/uninstall; no Flutter hot reload [9] | tap, multi-tap, swipe, key press [9] | screenshot (PNG), video recording [9] | `idb log` (OS-level), DAP debugserver, accessibility tree — no Dart VM-service [9] | Stable, used at Facebook scale [9] |
| **ios-simulator-mcp** (joshuayoes) | install_app/launch_app by bundle id; no hot reload [10] | ui_tap, ui_swipe, ui_type [10] | screenshot, record_video, ui_view (compressed) [10] | None documented; accessibility tree via ui_describe_all/ui_find_element [10] | v1.6.0 (2026-04-21), 2000★, active; requires Xcode + IDB [10] |
| **idb-mcp** (AskUI) | install/launch/terminate apps [11] | tap/swipe/type/keys/buttons, coordinate rescaling [11] | ios_screenshot → MCP ImageContent [11] | **Explicitly none** — zero references to Flutter/hot reload/VM service in codebase [11] | v0.1.2 (2026-03-18), 8★, MIT [11] |
| **whitesmith/ios-simulator-mcp** | launch/terminate/install; boot_simulator [12] | tap, swipe, type_text, tap_and_type, long_press, shake, press_button [12] | screenshot via `xcrun simctl io` [12] | None; UI hierarchy via `idb ui describe-all` [12] | Small (11★, commit 2026-02-03) [12] |
| **XcodeBuildMCP** (Sentry) | Simulator builds via xcodebuild; not Flutter hot reload [13] | Not documented in README extract [13] | Not documented in extract ("82 tools" page not extracted) [13] | "Log capture, debugging" via per-workspace daemon [13] | v2.6.2 (June 2026), 5.9k★, actively maintained [13] |

**Does any single tool cover all four?** Per documented evidence: **marionette_mcp**
is the only maintained tool covering hot-reload + input + agent-visible screenshots
+ log/VM watching in one server [5] — at the cost of adding a package to your app,
and it does not launch the app for you. **mcp_flutter** claims all four plus app
discovery but is explicitly experimental/untested at v4.0.0-dev.1 [6]. The
**official Dart MCP server** covers everything *except* visual feedback — no
screenshot tool exists in its v1.0.1 tool list [2].

## 2) Official Dart MCP Server deep-dive

- **Install (Claude Code):** `claude mcp add --transport stdio dart -- dart mcp-server` [1].
  **Version conflict:** docs.flutter.dev says Dart 3.9+ [1]; the dart-lang/ai repo README
  says Dart 3.12.0+ [2]. With Dart 3.12 (May 2026), "Agentic Hot Reload" removes the
  need to manually find/copy DTD URIs — zero config once the MCP server is registered [3].
  The MCP server itself first shipped as part of Dart 3.9 (Aug 2025) [4].
- **Connection model:** the `dtd` tool manages live-app connections via the Dart Tooling
  Daemon — `listDtdUris` then `connect`; apps from a DTD instance auto-connect [2].
  Launch Flutter apps with `--print-dtd`; plain Dart apps with `--observe` [2].
- **Key tools (v1.0.1)** [2]:

| Tool | Purpose | Default |
|---|---|---|
| hot_reload / hot_restart | Apply code changes, keep / reset state; needs DTD | Enabled |
| get_runtime_errors | Most recent runtime errors from the live app | Enabled |
| widget_inspector | Interact with Flutter widget inspector | Enabled |
| call_vm_service_method | Invoke any public VM-service RPC | Enabled |
| analyze_files / lsp | Static errors; hover/signature/symbol search | Enabled |
| flutter_driver_command | "Run a flutter driver command" | Enabled |
| pub_dev_search / read_package_uris | Package search and source reading | Enabled |
| launch_app / stop_app / list_devices / get_app_logs | App lifecycle + logs for apps it launched | **Disabled by default** |

- **Documented workflow** (official layout-overflow demo): pull runtime errors from the
  running app → inspect widget tree → apply fix → re-check for remaining errors,
  self-correcting syntax errors it introduces [1]. Test execution and `dart format`-
  consistent formatting are also exposed [1].
- **Screenshots/taps:** the docs name an "application introspection" capability, but no
  screenshot or tap evidence appears in docs or the v1.0.1 tool list — treat
  agent-visible visuals as **absent** [1][2]. Performance tracing exists separately via
  `dart info record-performance` (CLI, not MCP) [3].
- Underlying `dart_mcp` package (Dart Labs, 0.3.3 as of Oct 2025) is experimental;
  HTTP/streamable transports experimental, stdio is the stable path [8].

## 3) Simulator/emulator control options

**iOS (macOS):**
- **facebook/idb** — the foundation layer: `brew tap facebook/fb && brew install idb-companion`, client via pip [9]. list-targets, install/launch, tap/swipe/key, screenshot/video, log, accessibility tree, location, permissions approve/revoke, DAP debugserver; companion/client split allows remote device labs [9]. Stable.
- **joshuayoes/ios-simulator-mcp** — most popular MCP wrapper (2000★): `claude mcp add ios-simulator npx ios-simulator-mcp`; needs macOS, Xcode, simulators, and IDB [10]. ui_tap/ui_swipe/ui_type, accessibility queries (ui_describe_all, ui_find_element, ui_describe_point), screenshot/record_video, install/launch by bundle id, `SIMCTL_CHILD_` env passthrough for debug config [10].
- **askui/idb-mcp** — `pip install idb-mcp`, run `idb-mcp start stdio --target-screen-size 1280 800` (1280×800 recommended for Claude); coordinate rescaling between model viewport and device; explicitly no Flutter/VM-service awareness [11].
- **whitesmith/ios-simulator-mcp** — simctl + idb hybrid; adds long_press, shake, hardware buttons, GPS set/clear [12]. Small project.
- **XcodeBuildMCP** — build-and-run layer (simulator builds, code signing, log capture), not an input/hot-reload tool [13].

**Android:** the only Android-emulator evidence in this source set is **mcp_flutter**,
whose platform support lists iOS Simulator, macOS, Android Emulator, and web (CDP) [6]
— experimental. The official Dart MCP server's `list_devices`/`launch_app`/
`flutter_driver_command` are device-agnostic Flutter tooling [2], so they apply to
emulators, but no adb-level tap/screenshot MCP appears in these sources. **Gap — see
section 6.**

## 4) Console / log / VM-service watching options

| Mechanism | What you get | Caveats |
|---|---|---|
| Dart MCP `get_runtime_errors` | Recent runtime errors from live app via DTD [2] | Needs DTD connection |
| Dart MCP `get_app_logs` | flutter-run process logs [2] | Disabled by default; **only** for apps started by `launch_app` [2] |
| Dart MCP `call_vm_service_method` | Any public VM-service RPC [2] | You drive the protocol yourself |
| marionette `get_logs` | App logs since start [5] | Requires LogCollector configured in-app [5] |
| mcp_flutter debug tools | Dart expression eval (REPL-like), recent logs [6] | Experimental |
| `idb log` | OS-level simulator/device logs [9] | Not Dart-aware |
| XcodeBuildMCP log capture | Build/run logs via daemon [13] | Build-tool oriented |

Fallback that needs no MCP: run `flutter run` yourself in a background terminal and
have the agent read the console output — outside these sources' scope but worth
noting (the official server's launch_app/get_app_logs replicates this inside MCP [2]).

## 5) Recommended composition — the full loop on macOS today

**Stack: official Dart MCP server (code/reload/errors) + joshuayoes ios-simulator-mcp
(eyes & hands on iOS).** Rationale: official server has no screenshots [2];
ios-simulator-mcp has no hot reload or Dart awareness [10]; together they cover all
four columns with the two most mature options. Swap/augment with marionette_mcp if
you prefer widget-key-targeted taps over coordinate taps and accept adding a package
to the app [5].

Setup (one-time):
1. Dart SDK 3.12+ (resolves the 3.9-vs-3.12 doc conflict by satisfying both, and enables zero-config Agentic Hot Reload) [2][3].
2. `claude mcp add --transport stdio dart -- dart mcp-server` [1].
3. `brew tap facebook/fb && brew install idb-companion` [9]; then `claude mcp add ios-simulator npx ios-simulator-mcp` [10].
4. Optional: enable the official server's `flutter_app_lifecycle`/`cli` categories (launch_app, stop_app, list_devices, get_app_logs are disabled by default) [2].
5. Optional marionette: add `marionette_flutter`, call `MarionetteBinding.ensureInitialized()` in main.dart (debug mode), activate `marionette_mcp` globally and configure it in Claude Code [5].

The loop:
1. **Run:** `flutter run --print-dtd` on the booted simulator (or let the agent use launch_app if enabled) [2]. Agent connects via `dtd` → `listDtdUris` → `connect` [2].
2. **Reproduce:** agent drives the UI — `ui_tap`/`ui_swipe`/`ui_type` at coordinates from the accessibility tree (`ui_describe_all`, `ui_find_element`) [10], or marionette `tap`/`enter_text`/`scroll_to` by widget key/text [5].
3. **Read the error:** `get_runtime_errors` for exceptions; `widget_inspector` for layout issues; `analyze_files`/`lsp` for static confirmation [2]; `get_app_logs` or marionette `get_logs` for prints [2][5].
4. **Fix:** edit code (Claude Code native), verify with `analyze_files` [2].
5. **Hot reload:** `hot_reload` (state preserved) or `hot_restart` (const changes / state reset) [2].
6. **Visually re-verify:** `screenshot` / `ui_view` from ios-simulator-mcp [10] or marionette `take_screenshots` (base64) [5]; re-run `get_runtime_errors` to confirm zero remaining errors — the docs' own demo loop does exactly this re-check [1].

## 6) Gaps & honest limitations

- **Official server is blind:** no screenshot/tap primitives documented in v1.0.1 [2]; docs call the whole thing experimental, "likely to evolve quickly" [1]. The `flutter_driver_command` tool's actual command surface (can it tap? screenshot?) is undocumented in extracted material — **UNVERIFIED**.
  **[ADDENDUM 2026-06-11 — live schema probe (tests/fixtures/step0-probe-record-v0.34.0.md FP1):** a direct stdio `tools/list` against `dart mcp-server` shows `flutter_driver_command` carries a 16-value command enum INCLUDING `tap` and `screenshot`, with semantic finders (ByValueKey/ByText/BySemanticsLabel/…) and a schema note forbidding guessed finders (run `widget_inspector` first). So the official server is NOT blind at the schema level. Runtime behavior against a plain debug app remains UNVERIFIED (classic flutter_driver needs `enableFlutterDriverExtension()` in-app — whether the MCP path works without it is probe FP1b). The same probe confirmed the lifecycle tools (launch_app/get_app_logs/…) are absent from the default 13-tool list, and marionette_mcp 0.5.0 actually ships 16 tools — the 7 documented [5] plus swipe, pinch_zoom, double_tap, long_press, press_back_button, disconnect, custom-extension list/call, and hot_reload.]
- **VM-service watching by the official docs page is implied, not stated** — explicit VM tooling (call_vm_service_method, DTD) is documented only in the repo README [2], not in the flutter.dev doc [1].
- **Android is the weak leg:** no adb/maestro/mobile-mcp source was in scope; only experimental mcp_flutter claims Android Emulator support [6]. iOS coverage is far deeper. (A targeted follow-up sweep on Android-side MCPs is warranted before designing Android support.)
- **marionette trade-offs:** requires modifying the app (package + binding init); logs need LogCollector; it does not launch/stop the app [5].
- **mcp_flutter** ships 27 tools and the best all-in-one claim set, but v4.0.0-dev.1 carries an explicit untested-merge warning — don't bet a workflow on it yet [6].
- **Coordinate vs semantic taps:** idb-family tools tap at x,y from accessibility trees [9][10][11][12]; Flutter's accessibility output quality determines reliability — none of these sources quantify it. **UNVERIFIED** how well Flutter widgets surface in `idb ui describe-all`.
- **flutter_mcp_server (thecentinol) is a trap for this use case:** despite the name, it has no hot reload, no device control, no VM service; flutter_inspector is documented but not implemented [7].
- **XcodeBuildMCP's 82-tool surface was not fully extracted** — interaction capabilities beyond build/log are unconfirmed here [13].
- Sources listed but not extracted/cited: dart.dev/tools/mcp-server (mirror of [1]), the Flutter Medium announcement, and punkpeye/flutter-mcp (docs-Q&A server, not device control) — excluded rather than cited without evidence.
- **Version note:** an installed `marionette_mcp` may predate the **v0.4.0** upstream release cited above — verify the installed version (and update if older) before relying on current-docs behavior.

## 7) Sources (all accessed 2026-06-10)

1. https://docs.flutter.dev/ai/mcp-server — Dart and Flutter MCP server (official docs)
2. https://github.com/dart-lang/ai/tree/main/pkgs/dart_mcp_server — dart_mcp_server v1.0.1 (official repo)
3. https://dart.dev/blog/announcing-dart-3-12 — Dart 3.12: Agentic Hot Reload (official blog)
4. https://dart.dev/blog/announcing-dart-3-9 — Dart 3.9: MCP server introduction (official blog)
5. https://github.com/leancodepl/marionette_mcp — marionette_mcp v0.4.0 (LeanCode)
6. https://github.com/Arenukvern/mcp_flutter — mcp_flutter v4.0.0-dev.1
7. https://github.com/Centinol-alt/flutter_mcp_server — flutter_mcp_server v1.0.0
8. https://www.freecodecamp.org/news/how-to-use-the-model-context-protocol-mcp-with-flutter-and-dart/ — dart_mcp package overview
9. https://github.com/facebook/idb — iOS Development Bridge (Meta, official repo)
10. https://github.com/joshuayoes/ios-simulator-mcp — ios-simulator-mcp v1.6.0
11. https://github.com/askui/idb-mcp — idb-mcp v0.1.2 (AskUI)
12. https://github.com/whitesmith/ios-simulator-mcp — Whitesmith iOS simulator MCP
13. https://github.com/getsentry/XcodeBuildMCP — XcodeBuildMCP v2.6.2 (Sentry)
