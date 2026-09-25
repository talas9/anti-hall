---
name: anti-hall-jev
description: Activate, configure, check, or read the tracking loop of the opt-in Jev classifier for Codex. Use when the user says activate/enable/disable/turn on/set up jev, jev status, jev report, how is jev doing, jev scorecard, label that decision, promote an integration, jev budget, or jev credit balance.
---

# anti-hall jev for Codex

## Resolve the plugin root

Codex does not expand `${PLUGIN_ROOT}` inside a skill's own instructions — resolve
it from the path Codex shows you for this SKILL.md (see
`docs/KB-codex-platform-hooks-plugins.md`):

```bash
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
```

All commands below run as `node "$ANTI_HALL_ROOT/scripts/jev-setup.js" <verb>`.

## The credential never travels through the model

`set-key` reads the key from **STDIN only**. Never pass it as a CLI argument, never
have the model repeat it in a reply, never log it. Once `set-key` prints
`key saved (N chars)`, that's the only confirmation you ever give — never the key
itself.

## Primary flow: activate / enable / set up jev

1. `node "$ANTI_HALL_ROOT/scripts/jev-setup.js" status`.
2. Key already present (`key present: yes`) → skip to step 5.
3. No key: ask which provider it's for — **Vercel AI Gateway** (default,
   recommended, the only live-verified transport) or **TypeSafe direct**
   (supported, NOT live-verified — TypeSafe's console has closed sign-ups). Never
   guess the provider from the key's shape.
4. Ask in prose: "Paste your Vercel AI Gateway key (or TypeSafe key)." The
   safest option — never appears in the transcript — is having the user run it
   themselves with echo off:

   ```bash
   read -rs K && printf '%s' "$K" | node "$ANTI_HALL_ROOT/scripts/jev-setup.js" set-key --transport vercel && unset K
   ```

   (`--transport typesafe` if that's the pick). If they paste the key in chat
   instead, pipe it to `set-key` via stdin and never repeat it back:

   ```bash
   printf '%s' "<pasted key>" | node "$ANTI_HALL_ROOT/scripts/jev-setup.js" set-key --transport <vercel|typesafe>
   ```
5. `node "$ANTI_HALL_ROOT/scripts/jev-setup.js" enable [--transport vercel|typesafe]`.
6. `node "$ANTI_HALL_ROOT/scripts/jev-setup.js" test` — one real classification
   call; prints ok/latency/confidence or a failure reason, never the key. On
   `http-401`/`http-403`, tell the user the key was rejected and ask them to
   confirm BOTH the key and the provider choice, then re-run `set-key`.
7. `status` again to show the final state.
   - Tip: if the owner knows their per-call rate, set `costPerCall` in
     `~/.anti-hall/jev.json` now so `jev-report.js` can estimate spend.

## Other verbs

- `status` — enabled/transport/key-present(yes/no only)/integration modes/24h
  call count. No key or network needed for those fields. Also shows the
  Vercel AI Gateway credit balance (`GET /v1/credits`, verified at
  https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#check-credit-balance)
  when transport is `vercel` + a key is present, served from a 15-min cache.
  TypeSafe's own API documents no equivalent (checked
  https://docs.typesafe.ai/api) -- nothing shown for `typesafe`, never
  invented.
- `disable` — or `ANTIHALL_JEV=0` for a one-session-only override.
- `mode <integration> on|shadow|off` — `on` lets Jev influence that
  integration's outcome; `shadow` consults+logs without changing anything (build
  up `jev report` data before trusting it); `off` skips it. `speculation`/`triage`
  default `on` once Jev is enabled; everything else defaults `shadow`. Before
  promoting `shadow` -> `on`, check that integration's `jev report` row for a
  KEEP suggestion first — see the scorecard walkthrough below.
- **All integrations**: `speculation`/`triage` (legacy, default `on`);
  `modelRouting`, `claimLedger`, `mergeGateHedge`, `newRequest`,
  `outputVerifyGuard`, `gitGuardSelfCredit` (add-block, never relaxes),
  `parentGateQuestion` (cache-only, zero network), `tasklistTrivial`,
  `supervisorBlockerLabel` (cache-only, zero network), `codexNudgeSubstantial` —
  all default `shadow` (settings `jevIntegrations.<id>`, e.g. `jevIntegrations.modelRouting`
  — v0.108.4 gives every one of the 12 its own settings-schema row; a pre-existing
  `jev.json integrations.<id>` or pre-0.108.4 `jev.integrations.<id>` value keeps
  working and forward-migrates automatically, nothing deleted). In `on`,
  `tasklistTrivial`/`codexNudgeSubstantial` ask synchronously (1.5 s cap, fail-open)
  and a confident "trivial" verdict skips the nudge. Full per-id trust/hook/API table:
  `docs/KB-jev-classifier.md` §10. Claude Code exposes each as its own `/config` row
  ("Jev integration · <name>"); Codex has no `/config` equivalent — use
  `settings.js show --section jevIntegrations` or the `anti-hall-settings` skill.
  **Claude/Codex parity**: `speculation`, `triage`, `claimLedger`, `mergeGateHedge`,
  `newRequest`, `gitGuardSelfCredit`, `parentGateQuestion`, `tasklistTrivial` run on
  BOTH platforms (their backing hooks are registered in this port's own
  `hooks/hooks.json`). `modelRouting` (no `PreToolUse` Agent/Task-tool call exists
  here — subagent spawn is a separate `SubagentStart`/`SubagentStop` event with no
  pre-spawn payload to classify), `outputVerifyGuard` (the shell tool's
  `PostToolUse` `tool_response` shape is unverified on this platform, so it is not
  wired until proven), `supervisorBlockerLabel` (the liveness supervisor
  identity-binds to `claude --resume` processes), and `codexNudgeSubstantial`
  (self-referential inside a Codex session) are Claude-only.
- "how is jev doing" / "jev scorecard": run `jev-report.js`, then for each row
  explain KEEP (promote-worthy) / REMOVE (offer to set mode off) / REVIEW (not
  enough data, needs more labels, label-only, or p95 latency over budget).
  Mention the headline one-liner per integration for a quick summary.
  **v0.108.1 fix:** KEEP and REMOVE now BOTH require a labelled sample (tp+fp,
  human+auto) of at least 20 — below that it's `REVIEW (needs labels: n/20)`
  regardless of the raw rates; a <1% changed-decision rate is a low-yield NOTE
  only, never a REMOVE trigger by itself; a shadow-mode row's yield is now
  computed from `wouldChange` (what Jev would have done) instead of `changed`
  (which is always null in shadow by construction — see `docs/KB-jev-classifier.md`).
  **v0.108.3 fix:** a label-only (`choice`/string) integration's `changed%`
  column used to print a bare `0.0%`, indistinguishable from "Jev never
  changed anything here". It now shows `n/a (N distinct)`, a `label-only
  integrations` note below the table (and the headline) states `label-only:
  no boolean outcome to compare; N distinct decisions (M fresh)`, and the
  distinct-decision count dedupes cache retries of the same content hash —
  KEEP/REMOVE/REVIEW gating itself is unchanged.
  **v0.108.3 fix (tp/fp accounting):** owner-delegated `jev report label <hash>
  tp|fp` labels on a would-change choice decision (`wouldChange`/`changed`
  truthy, fresh, hashed) used to be read but silently dropped — a choice
  integration's would-change rows never joined `changedHashByFresh`, so the
  tp/fp loop (which only iterated that map) never saw them, and
  `bucket.labeled > 0 && known === 0` short-circuited to `REVIEW (label-only,
  no outcome signal yet)` forever regardless of how many labels it had. Fixed:
  those hashes now join the SAME precision/labelled-sample pipeline a boolean
  integration's changed decisions use (`humanTP`/`humanFP`/`autoTP`/`autoFP`/
  `labeledSample`), reported additively via JSON as `labelWouldChangeUnique`.
  `changed%`/`changedUnique` still stay 0 — a choice answer has no
  added/relaxed/changed semantics — and the `known === 0` short-circuit into
  label-only REVIEW now applies only when `labeledSample` is also 0. Once a
  choice integration reaches 20 labelled decisions and 50+ calls it can reach
  REMOVE (bad-outcome/failure-rate gates, unchanged) or KEEP (gated on its own
  would-change rate in place of changed-decision rate, since that stays 0).
- `jev-report.js --since <iso> --until <iso>` / `--exclude-window <iso>..<iso>`
  (repeatable) exclude rows by `ts` before anything else — use this to drop a
  known-accidental run from the numbers, e.g.
  `--exclude-window 2026-09-24T19:56:00Z..2026-09-24T22:23:00Z`.
- `jev-report.js --weekly [--json]` — compact ALWAYS-7-day summary, one line
  per integration (`[mode]`, suggestion, short reason, calls). A SessionStart
  hook (`hooks/jev-weekly-scorecard.js`, shared with the Claude port) checks
  this automatically at most once every 7 days (latch:
  `~/.anti-hall/state/jev-weekly-notice.json`) and, ONLY in the interactive
  Primary session (never a DevSwarm child workspace), injects one line when an
  integration has earned KEEP/REMOVE but its `jev.json` mode hasn't caught up:
  `Jev scorecard: <id> ready to switch ON/OFF — run /anti-hall:jev`. Never
  changes any mode itself. Opt out with `jev.json` `"weeklyNotice": false`
  (default `true`); silent whenever Jev is not `enabled` at all.
- **Two different "latency" numbers** — never conflate them. The table's
  `p50ms`/`p95ms` are the Jev classifier CALL's own latency (`jev-assist.ndjson`
  decision rows' `ms` field, typically hundreds of ms). The separate "triage
  answer-time" section is agent REPLY TURNAROUND (`jev-triage.ndjson`'s
  `{type:"answered", latencyMs}` rows from `recordAnswered` — typically minutes)
  — a completely different quantity from a different log.
- `--by project|session` splits the report into one table per distinct
  project/session value instead of one combined table; `--project <name>`
  filters to one project first. `project` is a cwd basename (agnostic, no
  absolute paths); `sessionId` is present only when the calling hook had one to
  thread through. A row missing either (including every row logged before this
  feature existed) groups under `unknown`. **v0.108.3 fix:** `recordOutcome()`'s
  `type:'outcome'` rows (`triage`'s answer-latency join, `speculation`'s
  evidence-added/user-override outcomes) now carry `project` too, via the same
  cwd-basename fallback as decision rows — they used to have none at all. A
  pre-fix outcome row still groups under `unknown` and cannot be repaired
  retroactively (no source cwd to recover it from).
- `node "$ANTI_HALL_ROOT/scripts/jev-report.js" [--window 24h|7d]` — read-only
  KEEP/REVIEW/REMOVE summary per integration. Two cost signals: `costPerCall` in
  `~/.anti-hall/jev.json` for a manual estimate (else `n/a`), and an automatic
  REAL cost parsed from each call's own response when the gateway reports one —
  see `hooks/lib/jev-client.js`'s `extractCostAndUsage`
  (https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#look-up-a-generation).
  The systemone endpoint this build calls does not currently return those
  fields, so set the `jev.prices` setting (`{"<model>": {"inPerMTok", "outPerMTok"}}` or a
  `"default"` entry; file-only, edit `~/.anti-hall/settings.json`; a legacy `jev.json`
  `prices` is still read) to compute real cost from token counts when present instead. Never an extra network call; never charges a cache hit.
- Budget watch (opt-in): settings `jev.budget.mode` (`unlimited`/`watch`), `jev.budget.usdPerDay`,
  `jev.budget.usdPerWeek`, `jev.budget.minCreditUsd` via the `anti-hall-settings` skill; a legacy
  `jev.json` `"budget": {"mode": "watch", "usdPerDay": 5,
  "usdPerWeek": 25, "minCreditUsd": 10}` is still read. Default mode `"unlimited"` (no
  watching). Over `usdPerDay`, the assist layer logs ONE
  `type:"budget-warning"` row per calendar day to `jev-assist.ndjson` -- no
  existing user-facing Jev notice path exists in this build, so it surfaces
  only via `jev-report.js`. `minCreditUsd` triggers the SAME once-per-day
  cadence for the Vercel credit balance instead of spend, checked at report
  time only. Jev is NEVER auto-disabled by a budget.
- `node "$ANTI_HALL_ROOT/scripts/jev-report.js" label <hash> [tp|fp]` -- the
  ONLY write path this script has (verdict omitted = read-only inspect);
  appends to a separate, append-only `~/.anti-hall/logs/jev-labels.ndjson`
  (the hash `h` is already the decision's stable id), never touching
  `jev-assist.ndjson`. A human label wins over an AUTO label for the same
  hash; AUTO labels come from the SAME mechanical `recordOutcome()` signal
  already logged (never re-parsed transcripts, never ground truth, always
  reported separately as "N TP (H human, A auto)"). The report also prints a
  one-line headline per integration, e.g. `speculation: 6 changed/24h · 5 TP
  (3 human, 2 auto) · $0.02/TP · p50=120ms · KEEP`.
- Audit snippets (opt-in, OFF by default): setting `jev.audit.snippets` (env
  `ANTIHALL_JEV_AUDIT_SNIPPETS`; legacy `jev.json` `"audit": {"snippets": true}` still read) stores a REDACTED ~200-char snippet (secrets scrubbed: Bearer
  tokens, known key prefixes, key=/token= assignments, emails, long
  base64/hex runs) for every decision that CHANGES an outcome, OR that WOULD
  have changed it in shadow mode (the default for every integration under
  evaluation -- a would-have-changed row carries `shadow: true`), in a
  separate `~/.anti-hall/logs/jev-audit.ndjson`, mode 600, keyed by hash. `label
  <hash>` prints it if one exists. Deletion is manual-only:
  `jev-report.js prune-audit --days N` -- never automatic.

## Never

Never print/log/commit the key. Never guess the provider. Never store the key
anywhere but the resolved key file (`~/.config/vercel/ai-gateway-key` or
`~/.config/typesafe/key` by default).
