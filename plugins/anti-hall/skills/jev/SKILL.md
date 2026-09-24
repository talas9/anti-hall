---
name: jev
description: Activate, configure, or check the opt-in Jev classifier (TypeSafe's "System One" decision model, reached via the Vercel AI Gateway or TypeSafe's direct API). Use when the user says "activate jev", "activate jev please", "enable jev", "turn on jev", "set up jev", "jev status", "disable jev", "jev report", or "set jev key".
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
**redacted** local-only snippet for every decision that CHANGES an outcome
(never for an unchanged call): the first ~200 characters of the text Jev
judged, after scrubbing common secret shapes (Bearer tokens, known key
prefixes, `key=`/`token=` assignments, emails, long base64/hex-looking runs).
Stored separately, in `~/.anti-hall/logs/jev-audit.ndjson`, file mode `600`,
keyed by the decision's hash. `label <hash>` prints it if one exists.
Deletion is manual-only, never automatic:

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

| Integration | Hook | What Jev may do when `on` |
|---|---|---|
| `speculation` | speculation-guard.js (Stop) | add a speculation block the regex missed; lets speculation-judge skip its paid call |
| `triage` | jev-triage.js (inbox reads) | label messages (urgent/…); label-only |
| `modelRouting` | model-routing-guard.js | downgrade a mechanical-flagship block to an advisory on a confident non-mechanical classification |
| `claimLedger` | claim-ledger.js (Stop) | relax a flagged claim it judges supported |
| `mergeGateHedge` | merge-gate.js (merge commands) | relax a hedge-based merge block |
| `newRequest` | task-tracker.js | label the prompt new-request/follow-up/correction/question (advisory) |
| `outputVerifyGuard` | output-verify-guard.js (test runners) | advisory label on runner output |

Details and trust rules: `docs/KB-jev-classifier.md` ("All wired integrations").

## Never do this

- Never print, log, echo, or commit the key — not in this chat, not in a file,
  not in a script argument.
- Never guess which provider a key belongs to from its shape — always ask.
- Never store the key anywhere but the resolved key file
  (`~/.config/vercel/ai-gateway-key` or `~/.config/typesafe/key` by default).
