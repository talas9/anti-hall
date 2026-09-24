# v0.108.0 end-to-end scenario suite

Runs the REAL hook/CLI scripts as subprocesses (`spawnSync`) with realistic
stdin/argv payloads and an isolated fixture `HOME` — never the real machine's
`~/.anti-hall`, never the real repo. Assertions are on stdout JSON and files
actually written under the fixture home, not on unit-level function calls.

Run just this suite:

```
taskpolicy -c utility nice -n 19 node --test --test-concurrency=2 tests/e2e/v0108/*.test.js
```

## Feature-presence gating

Some v0.108.0 contracts are not yet integrated into this working tree
(auto-handover, the version-alert two-message contract, repair-on-reload,
jev-report changed-dedup/budget-mode). Those tests are written now, against
the agreed contract below, and gated with `node:test`'s `{ skip: '...' }`
driven by a concrete on-disk check — never an unconditional skip:

- **New hook file expected** (`auto-handover.js`, `auto-handover-pause-nag.js`,
  `repair-on-reload.js`): gated on `fs.existsSync(hooks/<name>.js)` —
  `lib.js`'s `hookExists()`.
- **Behavior change to an EXISTING file** (version-alert.js's second
  message, jev-report.js's hash-dedup / budget mode): there is no new
  filename to check existence of, so the gate instead greps that file's own
  source for a marker string (`sourceHasMarker()`), or checks this repo's
  own "every landed change gets an `## Unreleased` CHANGELOG bullet before
  it is versioned" convention (`unreleasedMentions()`). Both are mechanical
  file-content checks, never a behavioral pre-run — they cannot produce a
  false pass, only flip a real test on once the described code actually
  lands.

Every gated test's `skip` message states exactly which marker is missing.

## Scenario -> requirement map

### 1. Auto-handover (`auto-handover.test.js`) — fully gated, 0/9 live

| Scenario | Requirement |
|---|---|
| below 85% => silent | context% below threshold is silent |
| crossing 85% => directive once | writes handover unasked, explains hallucination risk, urges /compact or /clear, fires once |
| sidechain/subagent transcript => silent | subagent usage never drives main-thread % |
| milestone nag only at +5 | re-nag only at nagStepPct increments |
| drop below threshold re-arms | a later crossing fires fresh |
| 1M-window model | 85% computed against 1,000,000, not 200,000 |
| settings off => silent | autoHandover.enabled=false silences the hook |
| ANTIHALL_AUTO_HANDOVER_PCT override | env overrides configured/default pct |
| pause-nag once per 15 min | auto-handover-pause-nag.js (Stop) cooldown |

Gate: `hookExists('auto-handover.js') && hookExists('auto-handover-pause-nag.js')`.

### 2. Settings (`settings.test.js`) — fully live, 24/24

| Scenario | Requirement |
|---|---|
| show / show --all / show --section / show --json | scripts/settings.js CLI surface |
| get (known + unknown key) | CLI get + error handling |
| set (valid / out-of-range / bad enum / bad boolean) | validation rejects bad input, never writes on rejection |
| set preserves other sections | atomic read-modify-write |
| reset (overridden key / never-overridden key) | reset clears an override, no-op otherwise |
| precedence: file > legacy, legacy fallback, /config vs file, env wins all, plugin-option env vs settings-file scan | full precedence chain |
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

### 3. Version alert (`version-alert.test.js`) — 4 live, 4 gated

| Scenario | Requirement | Status |
|---|---|---|
| fresh cache, remote newer => `/anti-hall:update` | base directive | live |
| fresh cache, not newer => silent | base silent | live |
| offline / no cache => silent, fast, no crash | fail-open | live |
| settings off => silent | ANTIHALL_VERSION_ALERT=off | live |
| remote newer => names BOTH `/anti-hall:update` and `/reload-plugins` | two-message contract | gated |
| cache newer than running => `/reload-plugins` only | two-message contract | gated |
| once per session | dedupe | gated |
| stale installed_plugins.json ignored | freshness check | gated |

Gate: `sourceHasMarker('hooks/version-alert.js', 'reload-plugins')`.

### 4. Repair-on-reload (`repair-on-reload.test.js`) — fully gated, 0/3 live

| Scenario | Requirement |
|---|---|
| new version since last repair => one detached repair | trigger condition |
| same version => no-op, <50ms | no-op perf budget |
| no marker yet => repair + record version | first-session bootstrap |

Gate: `hookExists('repair-on-reload.js')`.

### 5. Jev report (`jev-report.test.js`) — 4 live, 4 gated

| Scenario | Requirement | Status |
|---|---|---|
| calls/jevAnsweredPct/cacheHits for one id | base aggregation | live |
| costEstimate null with no costPerCall | base cost field | live |
| costEstimate = calls * costPerCall | base cost field | live |
| documents today's 6x over-count for 1 fresh + 5 cached rows of one hash | pins the pre-fix gap | live |
| 1 fresh + 5 cached rows of one hash => changed counted once | changed-decision hash-dedup | gated |
| two different hashes each changed => counted as 2 | dedup keyed correctly | gated |
| budget mode unlimited => no warning | budget mode | gated |
| budget mode watch => flags over-budget | budget mode | gated |

Gates: `unreleasedMentions('dedupe') && unreleasedMentions('jev report')` (or
`'changed-decision dedup'`) for hash-dedup; `unreleasedMentions('budget
mode')` (or `'unlimited'` + `'watch'`) for budget mode.
