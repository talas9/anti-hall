# v0.108.0 end-to-end scenario suite

Runs the REAL hook/CLI scripts as subprocesses (`spawnSync`) with realistic
stdin/argv payloads and an isolated fixture `HOME` — never the real machine's
`~/.anti-hall`, never the real repo. Assertions are on stdout JSON and files
actually written under the fixture home, not on unit-level function calls.

Run just this suite:

```
taskpolicy -c utility nice -n 19 node --test --test-concurrency=2 tests/e2e/v0108/*.test.js
```

## No gating

Every feature this suite covers is integrated in v0.108.0, so nothing is
skipped. The tests were first written against a draft contract before the
features landed; at integration each was re-checked against the shipped code
and, where the draft guessed wrong (file names, settings keys, the Stop-hook
output shape), rewritten to the real contract. The rows below describe what
is tested now.

## Scenario -> requirement map

### 1. Auto-handover (`auto-handover.test.js`) — 13 live

| Scenario | Requirement |
|---|---|
| below 85% => silent | context% below threshold is silent |
| crossing 85%, known window => mandatory directive once | writes handover unasked, explains hallucination risk, urges /compact or /clear |
| sidechain/subagent transcript => silent | subagent usage never drives main-thread % |
| milestone nag only at +5 | re-nag only at nagStepPct increments |
| drop below threshold re-arms | a later crossing fires fresh |
| 1M window from the statusline (sticky max_tokens) | % computed against 1,000,000 |
| usage > 200k with no window info => inferred 1M | directive labelled "inferred 1M window" |
| unknown window, ceiling off => one soft advisory, never mandatory | no false mandatory fire on an undetected 1M session |
| 175k tokens on a 1M window => directive (ceiling); `maxTokens=0` => off | absolute `autoHandover.maxTokens` ceiling |
| settings off => silent | autoHandover.enabled=false silences the hook |
| ANTIHALL_AUTO_HANDOVER_PCT override | env overrides configured/default pct |
| pause-nag quiet window | Stop nag only past nagQuietMin since the last nag, once |
| Stop-side fire: over threshold, nothing fired yet => the Stop hook delivers it once | long turns that never reach a new prompt |

### 2. Settings (`settings.test.js`) — 25 live

| Scenario | Requirement |
|---|---|
| show / show --all / show --section / show --json | scripts/settings.js CLI surface |
| get (known + unknown key) | CLI get + error handling |
| set (valid / out-of-range / bad enum / bad boolean) | validation rejects bad input, never writes on rejection |
| set preserves other sections | atomic read-modify-write |
| reset (overridden key / never-overridden key) | reset clears an override, no-op otherwise |
| precedence: file > legacy, legacy fallback, legacy > /config until the migration is stamped, /config > legacy after, env wins all, plugin-option env vs settings-file scan | full precedence chain |
| default with nothing set | correct fallback |
| migration forward-migrates jev.json, legacy untouched | `runSettingsMigration` via `companion/lib/migrations.js` |
| migration never copies an undeclared/secret-shaped field | schema-only migration surface |
| migration idempotent, user override survives a repeat run | marker-gated idempotency |
| migration never overwrites an existing settings.json value | precedence honored during migration |

Note: migration is exercised by spawning a subprocess that requires
`companion/lib/migrations.js` directly and calls `runSettingsMigration` /
`migrateSettingsFromLegacy` — the exact function `doctor --repair` and
`/anti-hall:update` call — rather than spawning `doctor.js --repair` itself.
`doctor --repair`'s full pass also installs/verifies real launchd/systemd
companions (supervisor, ingest daemon, statusline) against the actual login
session regardless of a `HOME` env override, since launchd operates on the
user session, not `$HOME`. That surface is unsafe for an automated test and
out of scope for this contract.

### 3. Version alert (`version-alert.test.js`) — 8 live

| Scenario | Requirement |
|---|---|
| fresh cache, remote newer => `/anti-hall:update` | base directive |
| fresh cache, not newer => silent | base silent |
| offline / no cache => silent, fast, no crash | fail-open |
| settings off => silent | ANTIHALL_VERSION_ALERT=off |
| remote newer => names BOTH `/anti-hall:update` and `/reload-plugins` | update then reload |
| plugin-cache mirror newer than running => `/reload-plugins` only | reload-only case |
| once per session | dedupe |
| harness `installed_plugins.json` alone never triggers a reload nudge | only the on-disk mirror counts |

### 4. Repair-on-reload (`repair-on-reload.test.js`) — 5 live

| Scenario | Requirement |
|---|---|
| markers stamped for an older version => one detached repair, fast return | trigger condition, never inline |
| no marker store at all (first session) => repair | first-session bootstrap |
| UserPromptSubmit takes the same path | `/reload-plugins` fallback |
| all migrations stamped for the running version => no lock, no spawn, cheap | no-op path (budgeted over a bare `node` start) |
| `ANTIHALL_REPAIR_ON_RELOAD=off` | escape hatch |

### 5. Jev report (`jev-report.test.js`) — 8 live

| Scenario | Requirement |
|---|---|
| calls/jevAnsweredPct/cacheHits for one id | base aggregation |
| costEstimate null with no costPerCall | base cost field |
| costEstimate = calls * costPerCall | base cost field |
| 1 fresh + 5 cached rows of one hash => changed counted once | changed-decision hash-dedup |
| two different hashes each changed => counted as 2 | dedup keyed correctly |
| budget mode unlimited (default) => no budget status | budget watch off |
| budget mode watch => 24h spend over usdPerDay flagged | budget watch (settings `jev.budget.*`) |
| legacy jev.json `budget` still drives watch | settings legacy fallback |
