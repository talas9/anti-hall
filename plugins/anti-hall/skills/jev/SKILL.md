---
name: jev
description: Activate, configure, check, or read the tracking loop of the opt-in Jev classifier (TypeSafe's "System One" decision model, reached via the Vercel AI Gateway or TypeSafe's direct API). Use when the user says "activate jev", "activate jev please", "enable jev", "turn on jev", "set up jev", "jev status", "disable jev", "jev report", "set jev key", "how is jev doing", "jev scorecard", "show me the jev report", "label that decision right/wrong", "was jev right", "promote <integration>", "turn <integration> on/off", "jev budget", "jev credit balance", "jev cost", or "what does <integration> do".
---

# Jev

Jev is anti-hall's opt-in classifier backend (see `docs/KB-jev-classifier.md` for the
full design). It is **default OFF** and, once enabled, only ever ADDS or RELAXES a
decision within a trust rule the caller controls — see the KB doc's "Fallback
semantics" section. This skill is the activation/config/status front door;
`scripts/jev-setup.js` does the actual work and never prints the key.

## The credential never travels through the model

The key must reach `set-key` over **STDIN only** — never as a chat message the
model repeats, never as a CLI argument (visible in `ps`/shell history), never
logged. Whichever path below is used, once `set-key` reports
`key saved (N chars)`, **never repeat the key back, log it, or write it anywhere
else.**

## Primary flow: "activate jev" / "enable jev" / "set up jev"

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-setup.js" status` first.
2. **If a key is already present** (`key present: yes`): skip straight to step 5
   (enable) — don't ask for a key again.
3. **If no key is present:** ask which provider the key is for — there is no way
   to guess this from the key's shape, so always ask, never infer:
   - **Vercel AI Gateway** (default, recommended) — the only transport this build
     has live-verified end to end.
   - **TypeSafe direct** — supported by `jev-client.js`'s `typesafe` transport, but
     **not** independently live-verified in this build (TypeSafe's own console has
     closed sign-ups as of this writing — see `docs/KB-jev-classifier.md` §8). Say
     this plainly if they pick it.
4. Ask for the key in plain prose (a secret is not a multiple-choice question, so
   don't offer it as one):

   > Paste your Vercel AI Gateway key (or TypeSafe key, if you picked that
   > provider).

   The **safest** way to hand it over — since it never appears in this chat
   transcript at all — is to run it themselves as an in-session shell command with
   the `!` prefix, which reads it with echo off and pipes it straight to `set-key`:

   ```
   ! read -rs K && printf '%s' "$K" | node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-setup.js" set-key --transport vercel && unset K
   ```

   (swap `--transport vercel` for `--transport typesafe` if that's what they
   picked). Offer this as the more-private *option*, but don't require it — if
   they just paste the key into chat, that's fine too: pipe it to `set-key` via
   stdin exactly as typed, and **never echo it back or repeat it in your own
   reply**:

   ```
   printf '%s' "<the key they pasted>" | node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-setup.js" set-key --transport <vercel|typesafe>
   ```

   Confirm only with the script's own output (`key saved (N chars)`) — never with
   the key itself.
5. Enable: `node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-setup.js" enable [--transport vercel|typesafe]`
   (pass `--transport` again if the user picked typesafe, so it's recorded even on
   a repeat run).
6. Test: `node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-setup.js" test` — this makes
   **one** real classification call with a fixed harmless question and prints
   `ok`/latency/confidence, or a failure reason. It never prints the key.
   - **If it fails with `http-401`/`http-403`** (key rejected): say so plainly,
     ask them to double check they picked the right provider (a Vercel key won't
     work against TypeSafe's direct API and vice versa) and whether the key itself
     is correct, then offer to `set-key` again with a fresh key.
   - Any other failure (`timeout`, `network-error`, ...): report the reason
     verbatim; it's informative and never sensitive.
7. Show `status` again so the user sees the final state (enabled, transport, key
   present, integration modes, last-24h call count).
   - Tip: if the owner knows their per-call rate, set `costPerCall` in
     `~/.anti-hall/jev.json` now so `jev report` can estimate spend — see Costs below.

## "jev status"

Just run `status` and report enabled/transport/key-present/integration
modes/24h call count. Also shows the Vercel AI Gateway credit balance (`GET
/v1/credits`, verified at
https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#check-credit-balance)
when the transport is `vercel` and a key is present — served from a 15-minute
cache, so `status` itself only sometimes makes one real request. TypeSafe's
own direct API documents no equivalent endpoint (checked
https://docs.typesafe.ai/api), so nothing is shown for the `typesafe`
transport — never invented.

## "disable jev"

`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-setup.js" disable`. Mention the
per-session alternative: `ANTIHALL_JEV=0` force-disables for one session without
touching `jev.json`.

## Costs

Jev is billed per call by the gateway/provider (Vercel AI Gateway passthrough
pricing, or TypeSafe's own pricing for the direct transport). Two cost signals:

- **Estimated** (manual): if the owner knows their per-call cost, they can set
  `costPerCall` in `~/.anti-hall/jev.json` so `jev report` (below) can estimate
  spend; otherwise it reports cost as `n/a`.
- **Real** (automatic, when available): every Jev call already parses its own
  response for a gateway-reported cost or token usage (see
  `hooks/lib/jev-client.js`'s `extractCostAndUsage` — verified against Vercel AI
  Gateway's docs at
  https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#look-up-a-generation).
  The TypeSafe "systemone" endpoint this build calls does **not** currently return
  those fields, so real cost is `n/a` out of the box. If the owner knows a
  per-token rate instead, set `jev.prices` in `~/.anti-hall/settings.json`
  (`{"jev": {"prices": {"typesafe-ai/jev": {"inPerMTok": 0.5, "outPerMTok": 1.5}}}}`,
  or a `"default"` entry; file-only — there is no CLI `set` for it; a `prices` key in
  the legacy `jev.json` is still read) and `jev report` computes real cost from actual token counts when the
  response includes them. Real cost NEVER costs an extra network call and NEVER
  charges a cache hit. `jev report --window 24h|7d` shows real cost totals,
  $/call, and $/changed-decision per integration (default: both windows).

## Budget watch (opt-in, observability only)

Set the `jev.budget.*` settings to watch real spend against a cap (via
`/anti-hall:settings`, e.g. `set jev.budget.mode watch`, `set jev.budget.usdPerDay 5`):
`jev.budget.mode` (`unlimited`/`watch`), `jev.budget.usdPerDay`,
`jev.budget.usdPerWeek`, `jev.budget.minCreditUsd`. A legacy `jev.json`
`{"budget": {"mode": "watch", "usdPerDay": 5, ...}}` still works and is migrated into
`settings.json` once.

`mode` defaults to `"unlimited"` (no watching, no warnings). In `"watch"` mode,
`usdPerDay` is required and `usdPerWeek`/`minCreditUsd` are optional. When the
day's real spend exceeds `usdPerDay`, the assist layer logs ONE warning per
calendar day to `jev-assist.ndjson` (`type:"budget-warning"`) — there is no
existing Jev user-facing notice path in this build, so the warning surfaces
only through `jev report` (below), never injected into a hook's own output.
`minCreditUsd` triggers the SAME once-per-day cadence, but for the Vercel
credit balance (vercel transport only) instead of spend — checked at report
time, never in the hook path (see "jev status" above). **Jev is never
auto-disabled by a budget, in any mode** — a human decides whether to act on
it.

## "how is Jev doing" / "jev scorecard" / "show me the jev report"

This is the full tracking loop, end to end — run it whenever the user asks how
Jev is doing:

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-report.js"` (add `--window 24h|7d`
   to narrow the cost window; default shows both).
2. For EACH integration row, read its **suggestion** column and explain what it
   means and what to do next:
   - **KEEP** — changed-decision rate ≥5% AND good-outcome rate ≥80%, with a real
     outcome signal AND a labelled sample (tp+fp, human+auto) of at least 20
     (`MIN_LABELED_FOR_VERDICT`). Tell the user it's earning its keep; no action
     needed (already `on`, or a good candidate to promote from `shadow` to `on`
     — see "Per-integration modes" below).
   - **REMOVE** — ≥200 calls, a labelled sample of at least 20, AND either <60%
     good-outcome rate or >20% failure rate. Tell the user Jev is not adding
     value here; offer to set its mode to `off`. A <1% changed-decision rate is
     LOW YIELD ONLY (v0.108.1 fix) — it shows up as a note on the verdict, never
     as a REMOVE reason by itself.
   - **REVIEW (not enough data: N < 50 calls)** — too early to judge; explain
     more calls are needed (or the owner can `label` some decisions manually to
     seed outcome signal faster — see "labeling" below).
   - **REVIEW (needs labels: n/20)** — v0.108.1 fix: KEEP and REMOVE are BOTH
     withheld below a labelled sample of 20, regardless of how the raw
     changed/good-outcome/failure rates look. Tell the user to run `jev report
     label <hash> tp|fp` on a few more decisions (see "labeling" below) to seed
     the sample, or wait for more `recordOutcome` signal to accrue.
   - **REVIEW (label-only, no outcome signal yet)** — a `choice`/string-label
     classifier (no boolean baseline, e.g. `newRequest`, `supervisorBlockerLabel`)
     never uses changed-decision rate at all; explain it needs human labels
     before any KEEP/REMOVE verdict is even possible. Its `changed%` column
     shows `n/a (N distinct)` instead of `0.0%` (v0.108.3 fix — a bare 0 read
     as "Jev never did anything" when there's simply no boolean outcome to
     diff), and a `label-only integrations` note below the table (and in the
     headline) spells out the real distinct-decision count split fresh vs
     cache, e.g. `label-only: no boolean outcome to compare; 25 distinct
     decisions (25 fresh)`. This verdict only holds while `labeledSample` is
     still 0. Once the owner runs `jev report label <hash> tp|fp` on a
     would-change choice decision (the decision's own `wouldChange`/`changed`
     was truthy on a fresh call — not just any labelled hash), that tp/fp
     joins the SAME precision/labelled-sample pipeline a boolean integration
     uses (v0.108.3 fix — these used to be read and silently dropped, so a
     `choice` integration could never reach KEEP/REMOVE no matter how many
     labels it got). `changed%`/`changedUnique` still stay 0 (a choice answer
     has no added/relaxed/changed semantics), but `labelWouldChangeUnique`
     (JSON output) tracks the would-change label-candidate count, and once
     `labeledSample` reaches 20 the row falls through to the normal
     REVIEW-needs-labels/REMOVE/KEEP checks — KEEP for a choice integration is
     gated on its own would-change rate in place of changed-decision rate.
   - **REVIEW (p95 latency exceeds budget)** — the classifier is slow relative
     to its own hook's timeout budget; flag it, but this is a performance note,
     not a correctness one.
   - Any other REVIEW — summarize why (usually: some data exists but doesn't
     yet clearly meet KEEP or REMOVE).
3. Mention the **headline** one-liner for each integration (see below) if the
   user wants a quick summary instead of the full table.
4. If real cost or credit balance data is present, surface it (see Costs /
   Budget watch below) — especially a LOW CREDIT warning, which the user should
   see immediately.

### "label that decision right/wrong"

`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-report.js" label <hash> tp|fp` — see
"jev report" below for the full mechanics. Mention that
`~/.anti-hall/jev.json`'s `"audit": {"snippets": true}` must be turned on
BEFORE the decision was made for `label <hash>` (no verdict) to show the actual
judged text; without it, `label` still works (records tp/fp), it just can't
show the snippet for context.

### "turn <integration> on/off" / "promote <integration>"

See "Per-integration modes" below — `jev-setup.js mode <id> on|shadow|off`.
Before promoting `shadow` -> `on`, check that integration's row in `jev report`
for a KEEP suggestion first; promoting on thin data just adds a live behavior
change with no evidence behind it yet.

### Splitting the report by project or session

`--by project|session` runs the SAME report once per distinct value instead of
one combined table:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-report.js" --by project
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-report.js" --by session
```

`--project <name>` filters to one project BEFORE reporting (combine with
`--json` for machine-readable output). `project` is a cwd-basename, never an
absolute path or repo URL (kept agnostic, same convention as everywhere else in
this codebase); `sessionId` is the Claude session id when the calling hook had
one to thread through (not every integration is session-scoped — e.g.
`devswarm-supervisor.js`'s background sweep never has one). Every integration
that DOES have a session (`speculation`, `claimLedger`, `newRequest`,
`mergeGateHedge`, `outputVerifyGuard`, `modelRouting`, `codexNudgeSubstantial`,
`tasklistTrivial`) now threads `sessionId` through on every call (v0.108.5 fix
— live `speculation` add-block rows used to log `sessionId: null` on every
row, making them unjoinable back to the transcript that produced them), plus
an optional `turnRef` (the transcript's last-line ISO timestamp, or a
line-count fallback) pointing at which turn the decision was about. A row
from BEFORE this feature existed, or from an integration that genuinely has
no session, groups under `unknown` — not an error, not dropped.
`recordOutcome()`'s `type:'outcome'` rows (e.g. `triage`'s answer-latency
join, `speculation`'s evidence-added/user-override outcomes) now carry
`project` the same way (v0.108.3 fix — they used to have none at all); an
outcome row logged before that fix still groups under `unknown` and cannot be
repaired retroactively (no source cwd to recover it from).

### Excluding a known-accidental run (v0.108.1) / reproducible windows (v0.108.5)

`--since <iso>` / `--until <iso>` bound the report to rows with `ts` inside that
window; `--exclude-window <iso>..<iso>` (repeatable) drops rows inside one
closed interval instead. All three apply BEFORE `--project`/`--by`/`--weekly`,
to both `jev-assist.ndjson` and `jev-triage.ndjson` (both live files AND their
one rotated `.1` backup — a window spanning a rotation still sees every row).
Use this when the user wants a bad/accidental run out of the numbers without
editing the log file directly:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-report.js" \
  --exclude-window 2026-09-24T19:56:00Z..2026-09-24T22:23:00Z
```

Every report (default and `--by project|session`) now prints a `window: …`
line — the effective `since`/`until`/`exclude-window` bounds plus rows counted
vs excluded — right before the table, and the same data as a `window` object
in `--json` output. This is what makes two runs actually comparable: paste
both `window:` lines alongside the two agreement/changed-rate numbers so the
reader can confirm both analyses covered the same rows, not just "the same
flags happened to be typed."

### Weekly scorecard (automatic + on-demand)

`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-report.js" --weekly [--json]` — a
compact, ALWAYS-7-day summary: one line per integration with its current
`[mode]`, KEEP/REVIEW/REMOVE suggestion, a short reason, and call count. Same
thresholds as the full report, just condensed.

Separately, a SessionStart hook (`hooks/jev-weekly-scorecard.js`) checks this
automatically, AT MOST once every 7 days (a latch at
`~/.anti-hall/state/jev-weekly-notice.json` enforces the cadence — the check
runs at most once per week regardless of outcome, so a quiet week doesn't
trigger a re-check sooner), and — only in the interactive Primary/ordinary
session, never a DevSwarm child workspace's automated session — injects ONE
line when an integration has earned a KEEP or REMOVE verdict that its
`jev.json` mode has not caught up to yet:

```
Jev scorecard: modelRouting ready to switch ON — run /anti-hall:jev
```

This NEVER changes any mode itself — it is a pointer back to this skill (which
you'd then walk through as described in "how is Jev doing" above). Opt out
entirely with `"weeklyNotice": false` in `~/.anti-hall/jev.json` (default
`true` — opt-out, not opt-in). It is also silent whenever Jev itself is not
`enabled` at all.

### Two DIFFERENT "latency" numbers — do not conflate them

The per-integration table's `p50ms`/`p95ms` columns are the **Jev classifier
call's own latency** (from `jev-assist.ndjson` decision rows' `ms` field — how
long the actual `POST /v1/systemone` request took). The separate
**"triage answer-time"** section underneath the table is a completely
different thing: **agent reply turnaround** — how long it took a Primary/child
to reply to a message jev-triage.js labelled, from `jev-triage.ndjson`'s
`{type:"answered", latencyMs}` rows (`hooks/lib/jev-triage.js`'s
`recordAnswered`). A real classifier call is typically hundreds of
milliseconds; a reply-turnaround figure is typically minutes. If a p95 in
seconds/minutes shows up anywhere next to something claiming to be "Jev
latency", that is the wrong number attached to the wrong label — call it out.

## "jev report"

`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-report.js" [--window 24h|7d]` — a
read-only per-integration summary (call volume, agreement %, decisions changed,
good-outcome rate, latency, estimated cost, real cost) with a KEEP/REVIEW/REMOVE
suggestion per integration. Never mutates state.

Each changed decision's content hash `h` doubles as its stable id. Label one as
a confirmed true/false positive:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-report.js" label <hash> tp|fp
```

This is the ONLY write path `jev-report.js` has — it appends to a separate,
append-only `~/.anti-hall/logs/jev-labels.ndjson`, never touching
`jev-assist.ndjson`. A human label always wins over an AUTO label for the same
hash. AUTO labels are derived, at report time, from the SAME mechanical outcome
signal `recordOutcome()` already logs (e.g. the next main-thread turn citing a
file/tool after a Jev-added speculation block) — never re-parsing transcripts,
never treated as ground truth, and always reported separately from human
labels (`N TP (H human, A auto)`). Run `label <hash>` with no verdict to
inspect a hash read-only (current label + stored snippet, if any) without
writing anything.

### Audit snippets (opt-in, OFF by default)

Set `jev.audit.snippets` to true (`/anti-hall:settings`, or env
`ANTIHALL_JEV_AUDIT_SNIPPETS=1`; a legacy `jev.json` `{"audit": {"snippets": true}}`
still works) to store a small,
**redacted** local-only snippet for every decision that CHANGES an outcome, OR
that WOULD have changed the outcome had the integration's mode been `on`
(shadow mode is the default for every integration under evaluation, so this
covers the decisions you actually need to label — never for a call with no
change either way): the first ~200 characters of the text Jev judged, after
scrubbing common secret shapes (Bearer tokens, known key prefixes,
`key=`/`token=` assignments, emails, long base64/hex-looking runs). A
would-have-changed (shadow) row carries `shadow: true` so you can tell it
apart from an actual change. Stored separately, in
`~/.anti-hall/logs/jev-audit.ndjson`, file mode `600`, keyed by the decision's
hash. `label <hash>` prints it if one exists. Deletion is manual-only, never
automatic:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-report.js" prune-audit --days N
```

This is off by default precisely because it stores a piece of the actual
judged text (redacted, but still real content) — only turn it on if you want
that tradeoff for debugging/auditing precision labels.

The report also prints a one-line **headline** per integration combining
changed decisions, TP breakdown, cost efficiency ($/TP), latency, and the
KEEP/REVIEW/REMOVE suggestion, e.g.:

```
speculation: 6 changed/24h · 5 TP (3 human, 2 auto) · $0.02/TP · p50=120ms · KEEP
```

## Per-integration modes

`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-setup.js" mode <integration> on|shadow|off`
— `on` lets Jev actually influence that integration's outcome (bounded by its own
trust rule), `shadow` consults and logs Jev but never changes the result (useful to
gather `jev report` data before trusting it), `off` skips it entirely. `speculation`
and `triage` default to `on` once Jev is enabled (pre-existing behavior); every
other integration defaults to `shadow` until promoted.

**v0.108.4:** each of the integrations below (13 then; `postHandoverGate` added in v0.109.0) is also its own row/setting in the
`jevIntegrations` settings-schema section (`jevIntegrations.<id>`, e.g.
`jevIntegrations.modelRouting`) — its own table in `/anti-hall:settings`
(`node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" show --section jevIntegrations`)
and its own row in Claude Code's native `/config` panel, titled
"Jev integration · <name>". `jev-setup.js mode` writes the canonical
`jevIntegrations.<id>` settings.json key (as well as `~/.anti-hall/jev.json` for
back-compat); a pre-existing `jev.json integrations.<id>` value, or a pre-0.108.4
settings.json `jev["integrations.<id>"]` value, keeps working and forward-migrates
into the new key automatically (see `companion/lib/migrations.js`
`migrateJevIntegrationsSection`) — nothing is ever deleted.

### All integrations

| id | judges | trust | default mode | Claude | Codex |
|---|---|---|---|---|---|
| `speculation` | is this claim unsupported speculation | `add-block` | `on` (legacy) | yes | yes |
| `triage` | mesh message urgency/kind label (own client, not this table's trust model) | n/a | `on` (legacy) | yes | yes |
| `modelRouting` | is this agent-spawn task actually mechanical | `relax-block` | `shadow` | yes | no — Codex has no `PreToolUse` Agent/Task-tool call to classify; subagent spawn is a separate `SubagentStart`/`SubagentStop` event with no pre-spawn `tool_input` |
| `claimLedger` | is a flagged claim genuinely unsupported by evidence | `relax-block` | `shadow` | yes | yes |
| `mergeGateHedge` | does this text hedge on merge-readiness | `relax-block` | `shadow` | yes | yes |
| `newRequest` | classify a prompt: new-request/follow-up/correction/question | `advisory` | `shadow` | yes | yes |
| `outputVerifyGuard` | does this test-runner output actually indicate a pass | `advisory` | `shadow` | yes | no — reads a `PostToolUse` Bash `tool_response` whose exact shape on Codex's shell tool is unverified (no captured payload); not wired until proven, to avoid a hook whose trigger never actually fires as intended |
| `gitGuardSelfCredit` | does this commit/PR message contain paraphrased AI self-credit | `add-block` **(never relaxes)** | `shadow` | yes | yes |
| `parentGateQuestion` | is this unread child message really a question awaiting reply | `add-block` (cache-only, zero network) | `shadow` | yes | yes |
| `tasklistTrivial` | is this session a genuinely non-trivial, multi-part effort | `relax-block` | `shadow` | yes | yes |
| `supervisorBlockerLabel` | is a stale child waiting-on-parent or genuinely wedged | `advisory` (cache-only, zero network) | `shadow` | yes | no — `companion/devswarm-supervisor.js` identity-binds to `claude --resume` processes specifically |
| `codexNudgeSubstantial` | are these file edits genuinely substantial (not just formatting) | `relax-block` | `shadow` | yes | no — nudges a Claude session to seek an independent Codex review; self-referential/meaningless inside a Codex session |
| `findingDedup` | do two deadly-loop TRIO findings describe the same underlying issue | `advisory` | `on` — 65/65 correct at confidence ≥0.85 on a 30-day, 3-project offline benchmark (see CHANGELOG 0.108.4) | yes | yes |
| `postHandoverGate` | does this new request fit in the remaining post-handover context budget | `advisory` | `shadow` (log-only; never changes the gate directive) | yes | yes |

`gitGuardSelfCredit`/`modelRouting`/`claimLedger`/`mergeGateHedge`/`tasklistTrivial`/
`codexNudgeSubstantial`/`findingDedup`/`postHandoverGate` use a real classifier call (`ask`/`askSync`/`askDetached`);
`parentGateQuestion`/`supervisorBlockerLabel` never make a network call at all —
both reuse an ALREADY-cached `hooks/lib/jev-triage.js` label populated by a
different surface that classified the same message earlier, so promoting either
to `on` is a config change only, no extra cost. `supervisorBlockerLabel`'s
sweep runs every ~90s but only asks/logs once per DISTINCT input (childId +
triage kind + ts) per workspace — a per-workspace state file under
`~/.anti-hall/devswarm/blocker-label-ask/` skips the repeat ask/log while the
input is unchanged, re-asking only when it changes or after
`devswarm.supervisorBlockerLabelReaskSec` (default 6h) elapses (v0.108.5 fix
— one static input used to produce 382 `jev-assist.ndjson` rows in 24h). `mergeGateHedge` uses `askDetached` (fire-and-forget): promoting it to `on` only
changes what gets LOGGED for now. `tasklistTrivial`/`codexNudgeSubstantial` log
fire-and-forget in shadow, but in `on` they ask synchronously (1.5 s cap,
fail-open to the nudge) and a confident "trivial" verdict skips the nudge.
`findingDedup` is called from `scripts/finding-dedup.js` (a standalone CLI, not a
hook), one async `ask()` call per candidate finding pair, concurrency 4, capped at
200 pairs per run — see the `deadly-loop`/`deadly-loop-multi` skills' Phase B3/step-5
wiring. See `docs/KB-jev-classifier.md` §10 for the full table
with hook/event/API details.

## Never do this

- Never print, log, echo, or commit the key — not in this chat, not in a file,
  not in a script argument.
- Never guess which provider a key belongs to from its shape — always ask.
- Never store the key anywhere but the resolved key file
  (`~/.config/vercel/ai-gateway-key` or `~/.config/typesafe/key` by default).
