# KB-jev-classifier.md — Jev (TypeSafe System One) as an opt-in classifier backend

> Status: opt-in, **default OFF**. Wired into `speculation-guard.js` (Tier 2 Stop hook,
> regex fallback), `speculation-judge.js`, `model-routing-guard.js`, `claim-ledger.js`,
> `merge-gate.js`, `task-tracker.js`, `output-verify-guard.js` and message triage — see
> "All wired integrations" below for each one's trust rule and default mode.
> Everything below is either **[measured]** (cite the source run/file) or **[design]**
> (documented intent, not yet independently verified against a live call in every
> environment). No number in this doc is invented.

---

## 1. What Jev is (and is not)

**Jev** is TypeSafe's "System One" model: a small, fast **typed decision** primitive,
not a chat/reasoning model. It answers exactly two question shapes, both scored with a
confidence:

- **Choice** — pick one label from a fixed set (e.g. "which category").
- **Noul** — a yes/no decision returned as a probability-like value in `[0,1]`
  (`>= 0.5` is "true"); anti-hall's `jev-client.js` derives `confidence = |noul-0.5|*2`.

Both primitives take a `state` (the text being judged) and per-question `criteria` text
that anchors what "true"/"false" or each choice label means — the SAME rubric text a
chat-model judge would get as its system prompt, sent as structured criteria instead of
free-form instructions.

**What Jev is NOT for:** it cannot hold a conversation, answer an open-ended question,
write or explain code, or do anything outside "given this rubric and this text, which
option / true-or-false, with what confidence." It never replaces the working agent (the
Claude/Codex session doing the actual task) — it only ever stands in for a narrow,
single-turn classification call that a chat model would otherwise make.

## 2. Where anti-hall uses it

**Today:** `plugins/anti-hall/hooks/speculation-guard.js` (Stop hook, Tier 2, always
registered). When Jev is enabled it is asked FIRST with a Noul question (`JEV_QUESTION` in
the hook source; `true` = speculative). Only a confident `true` blocks on Jev's word; every
other outcome runs the regex hedge-word check exactly as before. `speculation-judge.js`
(Tier 3, Haiku via `ANTHROPIC_API_KEY`) no longer consults Jev.

**Also:** `plugins/anti-hall/hooks/lib/jev-triage.js` + `jev-triage-worker.js` — DevSwarm
mesh message triage. See §9 below.

**Why the other ~48 hooks stay plain code.** Every other hook in this plugin
(`command-guard`, `git-guard`, `edit-guard`, `speculation-guard`, `task-guard`, the
DevSwarm mesh hooks, etc.) makes its decision with a deterministic parse/regex/state
check. Those hooks run on **every PreToolUse/PostToolUse/Stop event** in a session —
they must be instant (sub-millisecond), free, and work fully offline (no API key, no
network dependency, no vendor outage risk). A classifier call — Jev, Haiku, or any
model — is reserved for the narrow set of judgments that are genuinely semantic and
can't be reduced to a pattern match (e.g. "does this prose assert an unverified fact,"
"is this message urgent"). Adding a network round-trip to the other 48 would trade a
free, instant, offline guard for a paid, slower, fallible one with no accuracy benefit.

## 3. Default OFF — exact enable steps

Jev is consulted only when it is enabled (no other gate — `speculation-guard.js` is always
registered):

`~/.anti-hall/jev.json` (all fields optional; shown with every default):

```json
{
  "enabled": false,
  "transport": "vercel",
  "keyFile": "~/.config/vercel/ai-gateway-key",
  "timeoutMs": 1500,
  "confidenceThreshold": 0.85
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Must be `true` (or `ANTIHALL_JEV=1`) for Jev to ever be called. |
| `transport` | `"vercel"` | `"vercel"` (Vercel AI Gateway passthrough) or `"typesafe"` (TypeSafe's direct API). |
| `keyFile` | `~/.config/vercel/ai-gateway-key` (vercel) / `~/.config/typesafe/key` (typesafe) | Fallback credential file, read only if the matching env var is unset. `~` expands to `$HOME`. |
| `timeoutMs` | `1500` | Hard per-call timeout; any slower response is treated as a failure and falls back. |
| `confidenceThreshold` | `0.85` | Minimum Jev confidence for a "speculative" answer to block without the regex. |

Env vars (checked before `keyFile`):

- `ANTIHALL_JEV=1` — force-enable, even with no `jev.json` at all.
- `ANTIHALL_JEV=0` — force-disable, **overrides** `jev.json`'s `enabled:true`. Always wins.
- `AI_GATEWAY_API_KEY` — credential for `transport:"vercel"`.
- `TYPESAFE_API_KEY` — credential for `transport:"typesafe"`.

**Transports:**

- **Vercel AI Gateway** (default): `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone`,
  model id `typesafe-ai/jev`. Vercel's own docs describe this as a dedicated
  TypeSafe-compatible surface that preserves the native request/response shape
  (Choice/Noul in, same field names out), not the generic OpenAI-style chat surface.
- **Direct TypeSafe API**: `POST https://api.typesafe.ai/v1/systemone`, model id
  `jev-latest`. TypeSafe's own console has closed sign-ups as of this writing (see §8);
  the Gateway path is the practically reachable one.

**To disable:** delete/omit `~/.anti-hall/jev.json` (or set `"enabled": false`), or set
`ANTIHALL_JEV=0`. With Jev disabled, `speculation-guard.js` makes the same decisions as the regex-only
hook — no network call, no log write.

### 3a. Enabling Jev (the easy way)

The steps above can be done by hand, but the `jev` skill (`/anti-hall:jev`; Codex
mirror `anti-hall-jev`) is the supported front door: say "activate jev" (or
"enable jev" / "jev status" / "disable jev" / "jev report"). It asks which
provider your key is for (Vercel AI Gateway, the default and only
live-verified transport, vs TypeSafe direct — supported but not independently
verified), takes the key over stdin only (never as a chat message it repeats
back, never as a CLI argument), writes it to the resolved key file with mode
0600, enables Jev, runs one real test call, and reports status. It never
prints, logs, or stores the key anywhere but that key file. Under the hood it
drives `plugins/anti-hall/scripts/jev-setup.js` (`status`/`enable`/`disable`/
`set-key`/`test`/`mode <integration> on|shadow|off`).

## 4. Fallback semantics (asymmetric trust)

Order inside `speculation-guard.js`:

1. **Loop-safety first** — if this exact message was already blocked, or the session hit
   its block cap (3), allow without calling Jev.
2. **Jev disabled** (the default) → regex check only.
3. **Jev enabled** → one call with `timeoutMs`.
   - Answer `true` (speculative) **and** `confidence >= confidenceThreshold` → **block**.
   - Anything else — a confident `false`, low confidence, or any failure (`no-key`,
     `timeout`, `http-<status>`, `parse-error`, `bad-response`) → the regex check decides.

Jev can add blocks the regex misses (unhedged, unsupported "Fixed." / "All done"); it
can never remove a regex block. It is not trusted to allow on its own because a labelled
probe (below) did not reach 7/8 confident-correct across both classes.

**Why the question was rewritten (measured 2026-09-24, live gateway).** The earlier
question reused the Tier-3 rubric, whose `true` criterion required *no hedge word*, so a
hedged guess ("The crash is probably caused by the cache; it should work now, I think
the tests pass.") was, by that rubric, correctly answered `false` — a confident allow.
It was a rubric mismatch, not inverted polarity. Raw `noul` on 10 labelled messages
(5 speculative, 5 grounded):

| Question | Correct | Confident (≥0.85) and correct | Speculative noul | Grounded noul |
|---|---|---|---|---|
| old (Tier-3 rubric) | 7/10 | 1/10 | 0.10–0.87 | 0.05–0.57 |
| current `JEV_QUESTION` | 10/10 | 8/10 | 0.94–0.98 | 0.06–0.20 |

On 6 further neutral replies (a question, a plan, general knowledge, a code snippet, a
hypothetical, small talk) the current question scored noul 0.03–0.38: all correct, none
a confident block. Small sample, one run — directional, not a benchmark.

## 5. Data and privacy

When Jev is enabled and consulted, the text of the **judged assistant reply** (capped at
8000 characters) is sent as the `state` field to
whichever transport is configured — Vercel AI Gateway (`ai-gateway.vercel.sh`) or
TypeSafe's own API (`api.typesafe.ai`), i.e. to Vercel and/or TypeSafe as third parties.
No other transcript content, no tool output, no file contents, and no credentials are
sent beyond that one message's text.

The API key (`AI_GATEWAY_API_KEY` / `TYPESAFE_API_KEY` / the resolved `keyFile`
contents) is read fresh on every call and is **never** logged, written to
`jev-judge.ndjson`, echoed into a block/allow reason string, or included in any error
message this module returns. This is enforced by construction (the key never enters any
string this codebase constructs for output) and covered by an automated test that scans
every log line, stdout, and stderr for the literal key value.

## 6. Observability

Every decision reached while Jev is **enabled** appends one line to
`~/.anti-hall/logs/jev-judge.ndjson` (best-effort; a logging failure never affects the
hook's decision). The file is rotated (truncated) once it exceeds ~1 MB. Shape:

```json
{"ts":"2026-09-24T12:00:00.000Z","backend":"jev","reason":"confident","ms":382,"confidence":0.94,"verdict":"block"}
{"ts":"2026-09-24T12:05:00.000Z","backend":"jev→regex","reason":"low-confidence","ms":401,"confidence":0.4,"verdict":"allow"}
```

- `backend`: `jev` (a confident Jev block), `jev→regex` (Jev was asked, the regex
  decided), or `none` (loop-safety allowed without calling Jev).
- `reason`: `confident` | `confident-allow-untrusted` | `low-confidence` | `loop-safe` |
  a Jev failure reason (`no-key`, `timeout`, `http-<status>`, `parse-error`,
  `bad-response`, …).
- `ms`: Jev's own call latency, when a call was made.
- `confidence`: Jev's confidence, when available.
- `verdict`: the final `block`/`allow` outcome the hook emitted.

No reply text and no credential ever appears in this file. A one-liner to compute the
share of decisions Jev made alone (confident blocks) vs. handed to the regex:

```bash
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.env.HOME + "/.anti-hall/logs/jev-judge.ndjson", "utf8")
  .trim().split("\n").filter(Boolean).map(JSON.parse);
const jev = lines.filter(l => l.backend === "jev").length;
console.log(`${jev}/${lines.length} decisions used Jev alone (${(100*jev/lines.length).toFixed(1)}%)`);
'
```

(This measures how often Jev blocked without the regex, not label-level
agreement between the two backends — the hook only calls one or the other per decision,
never both, so there is no per-decision pair to compare live. Agreement/accuracy
numbers below come from the offline benchmark instead.)

## 7. Evidence (offline benchmark, 2026-09-24)

**Setup [measured]:** 7 models compared through the **same Vercel AI Gateway**, same
shared rubric text, `temperature: 0`, on a **synthetic airline-crew-app support-ticket
classification** task (category + urgency): an easy set (300 tickets, 1 run), a hard set
(200 tickets, 1 run), and a genuinely-hard "logic" set (120 tickets, 3 runs). Source:
`scratchpad/jev-bench/REPORT-full.md` (local, not shipped in this repo).

| Set | Model | Accuracy (95% CI) | Urgent precision | Urgent recall | p50 latency | Cost / 1k |
|---|---|---|---|---|---|---|
| easy-300 | **Jev** | 94.6% [91.5–96.7] | **67.6%** | 90.4% | **379 ms** | **$0.024** |
| easy-300 | Claude Haiku 4.5 | 94.3% [91.1–96.4] | 85.1% | 89.2% | 816 ms | $0.337 |
| easy-300 | Claude Sonnet 5 | 96.0% [93.1–97.7] | 81.6% | 96.4% | 1355 ms | $0.907 |
| easy-300 | GPT-5 mini | 96.0% [93.1–97.7] | 73.3% | 89.2% | 2003 ms | $0.330 |
| easy-300 | Gemini 3 Flash | 96.0% [93.1–97.7] | 73.5% | 90.4% | 2561 ms | $0.975 |
| easy-300 | Qwen 3.8 Flash | 95.3% [92.3–97.2] | 77.7% | 88.0% | 3439 ms | $0.107 |
| easy-300 | DeepSeek v4 Flash | 98.3% [96.0–99.3] | 75.0% | 86.8% | 1306 ms | $0.073 |
| hard-200 | **Jev** | 94.5% [90.4–96.9] | 78.3% | 98.6% | **375 ms** | **$0.025** |
| hard-200 | Claude Haiku 4.5 | 93.5% [89.2–96.2] | 94.8% | 100.0% | 789 ms | $0.359 |
| logic (mean of 3) | **Jev** | 95.6% | 90.7%* | ~98.9%* | **385 ms** | **$0.033** |
| logic (mean of 3) | Claude Haiku 4.5 | 87.5% | 97.7% | 71.2% | 805 ms | $0.561 |

\* logic-set urgent precision/recall taken from run 1 of 3 (90.6% / 98.3%); see the
source report for all 3 runs.

**Calibration [measured]** (category-confidence bucket, Jev, run 1 of each set —
fraction of Jev's own high/low-confidence calls that were actually correct):

| Set | ≥0.9 confidence | 0.7–0.9 | 0.5–0.7 | <0.5 |
|---|---|---|---|---|
| easy | 274/280 (98%) | 7/13 (54%) | 2/4 (50%) | 0/2 (0%) |
| hard | 178/184 (97%) | 9/13 (69%) | 1/1 (100%) | 1/2 (50%) |
| logic | 103/103 (100%) | 5/5 (100%) | 5/6 (83%) | 2/6 (33%) |

This is the empirical basis for the default `confidenceThreshold: 0.85` — above roughly
0.9 confidence Jev's calls were correct 97–100% of the time across all three sets; below
that the hit rate drops sharply, which is exactly the regime the fallback path
exists to cover.

**Honest caveats [measured/design]:**

- This is **synthetic data, one domain** (a synthetic airline-crew-app support-ticket
  set), not anti-hall's own speculation task. It is directional evidence for
  Jev's general accuracy/latency/cost profile, not a direct measurement of
  speculation accuracy — the only speculation-task data is the small probe in §4; no equivalent benchmark exists yet for that exact task.
- **Jev over-flags "urgent"**: 67.6% precision on the easy set (vs. 85.1% for Haiku
  4.5) — i.e. Jev calls things urgent that a stricter rubric-follower would not, at
  roughly 2x Haiku's false-positive rate on that label, even though its overall category
  accuracy is comparable or better. `speculation-guard`'s own use of Jev is a
  block/allow Noul, not this urgent/category task, so this specific bias does not
  transfer directly — it is reported here as a general characteristic of the model.
- **No 429s up to concurrency 8** in the throughput probe run on 2026-09-24 (25
  requests per concurrency level, ramp 1→2→4→8): Jev returned 0 rate-limit errors at
  concurrency 8 (16.7 req/s observed), vs. Haiku 4.5's 0 errors at the same levels
  (7.6 req/s observed). This is a point-in-time observation from one run, not a
  documented rate-limit guarantee.
- Cost figures are input-token cost only (`$0.042` per 1M input tokens for Jev per the
  bench script's stated rate), measured against the Vercel AI Gateway's billing at the
  time of the run; gateway pricing can change.

## 8. Limits and risks

- **Vendor age / maturity.** TypeSafe is a young vendor; Jev is not a widely
  established, long-track-record model the way Haiku/Sonnet/GPT/Gemini are.
- **Direct sign-ups closed** at the time of writing — the practical path to a credential
  is the Vercel AI Gateway passthrough, not TypeSafe's own console.
- **Experimental integration.** This is a first opt-in integration; it has not been
  run in production over time, only benchmarked offline (§7) and covered by unit/
  integration tests against a local mock server (never a live call in CI or in this
  repo's test suite).
- **Rate limits can change.** The benchmark's "no 429s at concurrency 8" observation
  (§7) reflects one measurement window on one date; TypeSafe/Vercel's actual limits are
  not publicly documented and may tighten or loosen without notice. `jev-client.js`'s
  hard `timeoutMs` (default 1500 ms) and full fail-open behavior (§4) mean a rate-limit
  regression degrades to "falls back to the regex," not to a hung or broken hook.


## 9. Mesh message triage (DevSwarm)

**Status: opt-in, default OFF** (rides the same `~/.anti-hall/jev.json` switch as §3,
plus a per-feature key). Attaches an **advisory-only** label — `urgency`
(`urgent`/`normal`) and `kind` (`question-needs-answer`/`blocker`/`status-report`/
`done-report`/`fyi`) — to a mesh message wherever anti-hall renders one for the agent:

- `plugins/anti-hall/scripts/devswarm.js` (`cmdInboxMessagesInner`, the shared engine
  behind `inbox messages`, `inbox read-primary`, and `inbox peek-primary`): each
  message row gains an additive `triage: {urgency?, kind?}` field. A row triage
  couldn't confidently classify simply omits the field — byte-identical to before this
  feature existed.
- `plugins/anti-hall/hooks/devswarm-parent-inbox.js` (`buildBroadcastSegment`, the
  `DEVSWARM BROADCAST` roster/FYI feed injected every Primary turn): a classified row's
  rendered line gains a bracketed `[kind]` tag, and an urgency-labeled row can gain the
  SAME `[URGENT]` tag the feed already renders for `isHighUrgency(r.urgency)` — never a
  second one.

**Hard contract — advisory ONLY, never enforced:** a label never suppresses, hides,
reorders, delays, or acks a message, and never changes a Stop-gate block decision or
any unread count. This is structural, not a convention to remember: the triage step
runs strictly AFTER every gate/count/cursor computation and only ever adds a field or a
cosmetic text prefix to an already-decided render.

**Gating:** `~/.anti-hall/jev.json`'s existing `enabled` flag, plus a new `"triage"` key
(default `true` once `enabled` is `true`; `"triage": false` turns triage off while
leaving every other Jev consumer, e.g. speculation-judge, untouched). Two more optional
fields, both triage-specific: `"triageUrgentThreshold"` (default `0.9`) and
`"triageBudgetMs"` (default `2000`, the hard TOTAL wall-clock budget for one render
call across every message it triages that turn).

```json
{
  "enabled": false,
  "triage": true,
  "triageUrgentThreshold": 0.9,
  "triageBudgetMs": 2000
}
```

**Fallback order, per message:**

1. **Jev, batched.** Both questions (`kind`: a Choice; `urgency`: a Noul) are sent in
   ONE HTTP round-trip via `jev-client.js`'s new `jevDecideMulti` (Jev's `questions`
   field already accepted multiple keys sharing one `state`; `jevDecide` just never
   used more than one). `kind` is accepted at the ordinary `confidenceThreshold`
   (default `0.85`, same field jev-client.js already reads).
2. **Urgency uses a STRICTER threshold** (`triageUrgentThreshold`, default `0.9`, NOT
   `confidenceThreshold`) before a row is called `urgent` — only "not urgent" uses the
   ordinary threshold. This is a direct response to §7/§8's measured Jev weakness:
   **67.6% urgent-label precision on the easy benchmark set** (roughly 2x Haiku 4.5's
   false-positive rate on that specific label, even though Jev's overall category
   accuracy there was comparable or better). A stricter bar for the one label Jev is
   measurably over-eager on is cheaper and simpler than a second model call just to
   cross-check urgency.
3. **Haiku fallback**, ONLY for whichever field(s) Jev left unresolved (disabled, any
   failure, or below its threshold) — reusing the SAME `ANTHROPIC_API_KEY` path
   `speculation-judge.js` already established; no key -> that field stays unlabeled.
4. **Neither available -> no label at all.** A message with no label renders EXACTLY
   as it did before this feature existed.

**Budget / never-block:** both `scripts/devswarm.js` (a long-established, fully
synchronous ~16k-line CLI) and `devswarm-parent-inbox.js` (a synchronous
UserPromptSubmit hook) call triage SYNCHRONOUSLY. Since `jevDecideMulti`/the Haiku
fallback are `fetch`-based (async), the actual network I/O runs in a separate
subprocess, `jev-triage-worker.js`, spawned via Node's `execFileSync` with an explicit
`timeout` (`triageBudgetMs` + a small fixed backstop) — that timeout IS the "never
block a hook" guarantee: if the worker hangs, it is killed and the caller gets back
whatever it already had (cache hits only), never throwing. This was deliberately kept
out of `jev-client.js`/`jevDecide` itself (still purely async, unchanged) rather than
making either 16k-line/hook call chain async, which would have been a far larger and
riskier diff for an advisory feature.

**Cache:** `~/.anti-hall/cache/jev-triage.json`, keyed by a content hash of each
message's text (a message is classified once, not every render). Bounded to 500
entries, oldest evicted first. A "no label" verdict is cached too, so a message that
neither backend could classify isn't re-sent every turn.

**Logging:** `~/.anti-hall/logs/jev-triage.ndjson`, rotated at ~1 MB, one line per
NEWLY-classified message (a cache hit logs nothing):

```json
{"ts":"2026-09-24T12:00:00.000Z","hash":"048f5682a65d4ed27e795af8279ba374","urgency":"urgent","kind":"question-needs-answer","backend":"jev","ms":18}
```

Only the content hash, the resolved labels, which backend produced them, and latency —
**never** the message body and **never** a credential (same hygiene contract as
`jev-judge.ndjson`, §5/§6).

**Safety note (home isolation):** `triageMessagesSync` requires an EXPLICIT `home`
from its caller and returns immediately (zero fs/network/subprocess) if one isn't
supplied — it never silently falls back to `os.homedir()`. Every real call site
already passes one explicitly (`ctx.home` in the CLI, `os.homedir()` computed once in
the hook's `main()`); the guard exists so a test exercising an unrelated code path that
happens to reach `buildBroadcastSegment`/`cmdInboxMessagesInner` can never accidentally
read (or worse, act on) a real developer machine's `~/.anti-hall/jev.json`.

**Codex parity:** DevSwarm mesh coordination (`scripts/devswarm.js`,
`devswarm-parent-inbox.js`, and the rest of the `v0.57 mesh`) is Claude-side only — it
has no Codex-port mirror to wire (confirmed: `plugins/anti-hall/codex/` has no
`devswarm*`/`jev*` implementation files, only a reference skill doc). No Codex work is
needed for this feature.

## 10. Integrations, metrics, and `jev report`

**`hooks/lib/jev-assist.js`** is the shared layer every NEW Jev integration should go
through instead of calling `jev-client.js` directly: one per-integration on/shadow/off
mode, one of three trust rules bounding how far Jev may move a caller's own baseline
verdict, one content-hash cache, and one metrics line per decision. `jev-client.js`
itself (§1-§8 above) and `jev-triage.js` (§9) are unchanged — jev-assist wraps the
former, it does not replace it.

**Per-integration modes** live under a new `integrations` map in `~/.anti-hall/jev.json`:

```json
{
  "enabled": true,
  "integrations": {
    "speculation": "on",
    "triage": "on",
    "modelRouting": "shadow"
  },
  "confidenceThreshold": 0.85,
  "costPerCall": 0.0004
}
```

Each value is `"on"` (Jev may change the outcome per its trust rule), `"shadow"` (Jev is
still called and logged, but the outcome is always the baseline — use this to observe a
new integration before trusting it), or `"off"`. An **existing** `{"enabled":true}`
config with no `integrations` map keeps its CURRENT behavior with zero migration:
`speculation` and `triage` (the two pre-existing integrations, §3-§9) default to `"on"`;
every OTHER integration (e.g. `modelRouting`) defaults to `"shadow"` until an owner
explicitly promotes it. The legacy `{"triage": false}` switch (§9) still works when
`integrations.triage` is absent. `ANTIHALL_JEV=0` still force-disables everything;
`ANTIHALL_JEV_<ID>=0` (e.g. `ANTIHALL_JEV_MODEL_ROUTING=0`) force-disables one
integration only.

**Trust rules** — the only three shapes any integration needs:

| Trust | Effect | Used by |
|---|---|---|
| `add-block` | Jev may only turn a non-blocking baseline INTO a block; never relaxes an existing block. | speculation-guard |
| `relax-block` | Jev may only turn an already-blocking baseline into a non-block; consulted ONLY when the baseline would block. | model-routing-guard |
| `advisory` | No boolean to protect; final is Jev's answer when confident, else the baseline. | future label-only integrations |

Any Jev failure (disabled, no key, timeout, bad response), low confidence, or
`mode !== "on"` always resolves to the baseline — jev-assist never overrides a caller on
its own authority.

**Three APIs:** `ask(...)` (async, for callers that can `await`, e.g.
speculation-guard's Stop hook), `askSync(...)` (fully synchronous — the network call
runs in a subprocess, `jev-assist-worker.js`, spawned via `execFileSync` with its own
hard timeout, the same pattern §9's `jev-triage-worker.js` uses — for callers like
model-routing-guard's PreToolUse `main()` that cannot await), and `askDetached(...)`
(fire-and-forget — spawns `jev-assist-detached-worker.js` DETACHED, `stdio: 'ignore'`,
`unref()`'d, and returns immediately without waiting on the network call or even the
child starting). `askDetached` is MANDATORY for any integration on the user's critical
path (`UserPromptSubmit`, `PostToolUse`) — those hooks have a real latency budget and
must never wait on Jev, even in shadow mode. `askSync`/`ask` remain fine for `Stop`
hooks (their own turn is already ending) and for rare, already-gated paths (e.g. a
merge command). Limit: `askDetached` cannot accept a `judge` function (it can't cross
the stdin JSON boundary) — a caller needing custom answer normalization uses
`ask`/`askSync` instead.

**Wired integrations (2026-09):**

- **`speculation`** (speculation-guard.js, `add-block`): unchanged decision contract —
  Jev can only ADD a block the regex would have missed; the regex/acknowledgment check
  still runs independently and is what blocks when Jev doesn't. `jev-judge.ndjson`
  (§6) is kept for one release for compatibility and now also carries the regex's own
  verdict (`regexVerdict`) alongside Jev's, so a `jev-judge.ndjson` line shows both
  signals even when they disagree.
- **`speculation`** (speculation-judge.js): when `integrations.speculation` is `"on"`
  (fully trusted, not `"shadow"`/`"off"`), the paid Haiku semantic judge SKIPS its own
  API call for that turn — speculation-guard's Jev path already covers the same
  "unverified assertion" gap for free, so paying for both is pure waste. `"shadow"`/
  `"off"` still run Haiku as before.
- **`modelRouting`** (model-routing-guard.js, `relax-block`, **default mode: shadow**):
  consulted ONLY on the two paths that are about to BLOCK a mechanical-looking flagship
  or omitted-model spawn (Rows 1-2, §comments in the hook). Jev classifies the spawn's
  shape as one of `mechanical`/`authoring`/`research`/`plan-review`; a confident
  non-`mechanical` answer downgrades the block to an advisory. In the default `shadow`
  mode the block always proceeds unchanged but the would-have-relaxed verdict is still
  logged, so `jev report` can show whether promoting it to `"on"` is worth it before an
  owner does so. `command-guard`, `git-guard`, and `edit-guard` are NEVER wired to Jev —
  those stay pure, unconditional guards.
**All wired integrations:**

| id | hook / event | trust | API used | default mode | outcome signal |
|---|---|---|---|---|---|
| `speculation` | speculation-guard.js (`Stop`) | `add-block` | `ask` | `on` (legacy) | none wired |
| `triage` | jev-triage.js (`UserPromptSubmit`/CLI reads) | n/a (label-only, §9) | own client, not jev-assist | `on` (legacy) | `recordAnswered` — time-to-answer (below) |
| `modelRouting` | model-routing-guard.js (`PreToolUse`) | `relax-block` | `askSync` | `shadow` | none wired |
| `claimLedger` | claim-ledger.js (`Stop`, per flagged claim) | `relax-block` | `askDetached` (critical path — up to 40 flags per Stop, each with its own network round trip, would risk the Stop hook's own deadline) | `shadow` | none wired |
| `mergeGateHedge` | merge-gate.js (`PreToolUse`, merge commands only) | `relax-block` | `askDetached` (critical-path — a Bash tool call is gating the user's turn) | `shadow` | none wired |
| `newRequest` | task-tracker.js (`UserPromptSubmit`) | `advisory` (label-only: `new-request`/`follow-up`/`correction`/`question`) | `askDetached` (critical path) | `shadow`, baseline always `null` | none wired |
| `outputVerifyGuard` | output-verify-guard.js (`PostToolUse`, test-runner commands only) | `advisory` | `askDetached` (critical path) | `shadow` | none wired |
| `gitGuardSelfCredit` | git-guard.js (`PreToolUse`, commit messages / gh pr-issue-release bodies only) | `add-block` **only** (never relax) | `askSync`, 1.5s cap, hash-cached | `shadow` | none wired |
| `parentGateQuestion` | devswarm-parent-gate.js (`Stop`) | `add-block` | none — cache-only decision via `jev-assist.js`'s `finalize()`/`prepare()`, reusing `hooks/lib/jev-triage.js`'s own already-populated cache (zero network) | `shadow` | none wired |
| `tasklistTrivial` | tasklist-guard.js (`Stop`) | `relax-block` | `consultRelax`: `askDetached` in shadow; `askSync` (1.5 s cap, fail-open to the nudge) in `on`, where a confident "trivial" skips the nudge | `shadow` | none wired |
| `supervisorBlockerLabel` | devswarm-supervisor.js (periodic sweep, Claude-only) | `advisory` | none — cache-only decision via `jev-assist.js`'s `finalize()`/`prepare()`, reusing `hooks/lib/jev-triage.js`'s own pending-inbound cache (zero network) | `shadow` | none wired |
| `codexNudgeSubstantial` | codex-nudge.js (`Stop`, Claude-only, no Codex mirror) | `relax-block` | `consultRelax`: `askDetached` in shadow; `askSync` (1.5 s cap, fail-open to the nudge) in `on`, where a confident "trivial" skips the nudge | `shadow` | none wired |

`claimLedger`/`mergeGateHedge`/`newRequest`/`outputVerifyGuard`/`tasklistTrivial`/
`codexNudgeSubstantial` were shipped shadow-only in this release specifically so
`jev report` can show agreement/label distribution before any owner promotes one to
`"on"`. Promoting `mergeGateHedge`/`tasklistTrivial`/`codexNudgeSubstantial` to `"on"`
would need switching them from `askDetached` back to `askSync` (a fire-and-forget call
can never feed its answer back into a decision the caller already returned from).
`parentGateQuestion` and `supervisorBlockerLabel` never make a Jev network call at
all — both reuse an ALREADY-cached `hooks/lib/jev-triage.js` label (populated by a
different surface that rendered the same message earlier) via `jev-assist.js`'s
`finalize()`/`prepare()` exports, so promoting either to `"on"` is a config change
only, no code change.

**Triage answer-time (`recordAnswered`, `hooks/lib/jev-triage.js`):** when a
DevSwarm Primary/child reads a labeled inbound message (`noteLabeledInbound`, called
from `scripts/devswarm.js`'s `cmdInboxMessagesInner`) and later sends that sender a
reply (`recordAnswered`, called from `cmdSend`), the time-to-answer is appended to
`jev-triage.ndjson` as `{"type":"answered","urgency","kind","latencyMs"}`, plus a
joinable `{"type":"outcome","id":"triage",...}` row in `jev-assist.ndjson`. Best-effort
and fail-open: a tracking failure never delays or blocks a send. `jev report` shows
urgent-vs-non-urgent p50/p95 answer time from this data (§ below).

**Cache:** `~/.anti-hall/cache/jev-assist.json`, keyed by
`sha256(integrationId + questionVersion + (cacheKey ?? state))`, bounded to 500 entries
(oldest evicted first), atomic tmp+rename write — same shape as §9's triage cache.

**Metrics log:** `~/.anti-hall/logs/jev-assist.ndjson`, rotated at 1 MB (keeps one `.1`
backup). One line per `ask()`/`askSync()` call:

```json
{"ts":"2026-09-24T12:00:00.000Z","id":"speculation","h":"7ec9db0d18c23962","base":false,"jev":true,"conf":0.9,"ms":26,"backend":"jev","final":true,"changed":"added","cached":false,"mode":"on","project":"anti-hall"}
```

`backend` is `jev` (a fresh call), `cache` (a cache hit), or `baseline-only` (disabled,
off, not-applicable, or a jevDecide failure — see `reason`). `changed` is
`"added"`/`"relaxed"`/`"changed"`/`null`. Never a message body, never a credential —
same hygiene contract as `jev-judge.ndjson`/`jev-triage.ndjson`. `project` is always
populated (`path.basename(process.cwd())` — a bare directory name, never an absolute
path or repo URL, matching this codebase's "keep shipped files agnostic" convention);
`sessionId` is written only when the calling hook has a session id to thread through
(not every integration is session-scoped — `devswarm-supervisor.js`'s background sweep
never has one). Both are read via `hooks/lib/jev-assist.js`'s `finalize()`/`ask()`/
`askSync()`/`askDetached()` — a caller never has to compute `project` itself.
`jev-report.js --by project|session` groups the WHOLE report by either field; `--project
<name>` filters to one project first. A row missing the field (any row logged before
this feature existed, or from a session-less integration) groups under `unknown`.

**Two DISTINCT "latency" quantities — never conflate them in a report or a doc.** The
per-integration table's `p50ms`/`p95ms` (this section, above) come from THIS log's own
`ms` field — the real `POST /v1/systemone` call latency (typically hundreds of ms). The
SEPARATE "triage answer-time" section below reports `jev-triage.ndjson`'s
`{type:"answered", latencyMs}` rows — AGENT REPLY TURNAROUND (how long a Primary/child
took to reply to a labelled message), typically minutes, and not a Jev call at all. A
verified real-world example: classifier calls were 352-1313ms across 122 rows while the
triage answer-time p95 was ~960s (16 min) in the same window — reporting either figure
under the other's label is a real, previously-seen bug class, not a hypothetical one.

`recordOutcome({id, h, outcome})` appends a second line shape —
`{"ts":...,"type":"outcome","id":"speculation","h":"7ec9db0d18c23962","outcome":"evidence-added"}`
— so a later-observed result can be joined back to the decision that produced it, by
hash, when a caller chooses to wire outcome capture. Wired for `triage` (via
`recordAnswered`'s time-to-answer, above); not yet wired for any other integration in
this release — the log format supports it for when it is.

**`jev report`** (`scripts/jev-report.js`, read-only):

```
node plugins/anti-hall/scripts/jev-report.js [--days 7] [--json] [--window 24h|7d]
  [--by project|session] [--project <name>] [--weekly]
```

`--weekly` prints a compact, ALWAYS-7-day summary (one line per integration:
mode/suggestion/reason/calls) instead of the full table — `buildWeeklyScorecard()`
in `scripts/jev-report.js`. `hooks/jev-weekly-scorecard.js` (SessionStart, shared
with the Codex port) reads the SAME data automatically, at most once every 7 days
(latch: `~/.anti-hall/state/jev-weekly-notice.json`, consumed on every check
regardless of outcome), and — only in the interactive Primary session, never a
DevSwarm child workspace (`hooks/lib/devswarm-role.js`'s `isChildWorkspace`) —
injects one line pointing at `/anti-hall:jev` when an integration has earned a
KEEP/REMOVE verdict its `jev.json` mode hasn't caught up to yet. It NEVER changes
a mode itself. `jev.json`'s `"weeklyNotice": false` opts out (default `true`);
Jev not being `enabled` at all is also silent.

Per integration: calls, jev-answered %, cache hits, agreement % (Jev vs baseline, only
where both exist) OR, for a label-only `choice` integration (no boolean baseline, e.g.
`newRequest`), the top label's share plus the full distribution via `--json`, decisions
changed (by direction), outcome rates (joined by hash), latency p50/p95, an ESTIMATED
cost (`calls × jev.json "costPerCall"`, an owner-supplied constant — shows `n/a` if
unset; this is a rough estimate, not a bill), and a KEEP/REVIEW/REMOVE suggestion.
Thresholds (documented in the script's header, tune by editing them there): below 50
calls always `REVIEW (not enough data)`. **v0.108.1 fix:** KEEP and REMOVE now BOTH
require a labelled sample of at least `MIN_LABELED_FOR_VERDICT` (20, tp+fp, human+auto
combined) — below that, `REVIEW (needs labels: n/20)`, no matter how the raw rates look
(this closed a real gap where a 3-changed/304-fresh integration hit REMOVE off
changed-rate alone, with zero labelled outcomes behind it). Once labelled: `REMOVE` at
≥200 calls when good-outcome-rate <60% or failure-rate >20% — changed-rate <1% is now a
**low-yield note only**, appended to whatever verdict the other numbers already produced,
and can never trigger REMOVE by itself; `KEEP` when changed-rate ≥5% AND good-outcome-rate
≥80% — **and only when an outcome signal actually exists**: a `null` good-outcome-rate (no
`recordOutcome` ever observed for this integration) can NEVER earn `KEEP`, no matter how
high the changed-decision rate is; a label-only integration (no boolean baseline, e.g.
`newRequest`) never uses changed-rate at all and reports `REVIEW (label-only, no outcome
signal yet)` — this guard runs BEFORE the labelled-sample/REMOVE/KEEP checks, not after.
`REVIEW` otherwise (including p95 latency over the integration's configured budget). A
separate section (not per-integration, since it's latency keyed by urgency, not a decision
row) reports `triage`'s urgent-vs-non-urgent time-to-answer p50/p95 from `recordAnswered`'s
data.

**v0.108.1 shadow-mode yield fix.** A shadow-mode row's `changed` field is always `null`
by construction (`jev-assist.js`'s `finalize()` only applies/reports a change when
`mode==='on'`) — reading only `row.changed` meant a shadow integration's changed-decision
rate was always 0, which could hit REMOVE at ≥200 calls no matter how good Jev's shadow
answers actually were. `finalize()` now also logs `row.wouldChange` — the same trust-rule
outcome computed WITHOUT the mode gate — and `jev-report.js` reads it for shadow/off rows
(an `on` row's `wouldChange` would just duplicate `changed`, so it is omitted there).

**`--since <iso>` / `--until <iso>` / `--exclude-window <iso>..<iso>`** (repeatable) filter
rows by `ts` before anything else (`--project`/`--by`/`--weekly` included), across both
`jev-assist.ndjson` and `jev-triage.ndjson`. Use this to drop a known-accidental run from a
report without editing the log file — e.g. excluding the 2026-09-24T19:56Z..22:23Z
accidental unreleased-supervisor `supervisorBlockerLabel` run:
`--exclude-window 2026-09-24T19:56:00Z..2026-09-24T22:23:00Z`.

**Codex parity:** speculation-guard.js, speculation-judge.js, and model-routing-guard.js
are all shared files under `plugins/anti-hall/hooks/` (§ codex/README.md) — the Codex
port gets this integration for free with no separate implementation. `jev-assist.js`/
`jev-assist-worker.js`/`jev-report.js` live under the same shared `hooks/lib/` and
`scripts/` directories.

## 11. Real cost, precision, budget watch, credit balance, audit snippets (v0.108.0)

- **Real cost per call.** `jev-client.js` `extractCostAndUsage` reads a gateway-reported
  cost or token usage from each response; `jev-assist.js` `computeCostUsd` logs
  `costUsd` + `costSource`: `gateway` (reported), `price-table` (tokens × the owner's
  `jev.prices` setting — `{model: {inPerMTok, outPerMTok}}` or a `default` entry; the
  legacy `jev.json` `prices` is still read), `default-price` (tokens × the BUILT-IN
  `jev.priceUsdPerMInput`/`jev.priceUsdPerMOutput` rate — **v0.108.4**, default
  `0.042`/`0`, verified against typesafe.ai, vercel.com/ai-gateway/models/jev and
  openrouter.ai/typesafe — used whenever `jev.prices` has no matching entry, so a row
  gets a real cost out of the box instead of staying permanently null pending manual
  configuration), `cache` ($0 for a cache hit), or null (only when the response carried
  neither a gateway cost nor real token counts at all — never invented, never an extra
  network call).
- **Report.** `jev-report.js [--window 24h|7d] [--json]` adds cost windows ($/call,
  $/changed decision), precision from labels (`jev-report.js label <hash> tp|fp`; human
  labels win over AUTO labels derived from recorded outcomes), yield, cost efficiency,
  overhead and a one-line headline per integration. Changed decisions are counted once
  per content hash (a fresh call plus its cache hits = one decision). **v0.108.4:**
  `--by project|session` now ALSO prints a real-cost summary (total + per-integration,
  from the SAME `costUsd`/`realCostTotal` figures the top-level cost windows use) scoped
  to that one project/session group — `groupRowsBy` + `buildReport` already gave each
  group its own independent sum; `printRealCostSummary` is the render for it. The
  Vercel AI Gateway credit balance is still read the same way (15-min cache, report-time
  only, unaffected by this).
- **Budget watch** (opt-in; settings `jev.budget.mode` `unlimited`/`watch`,
  `jev.budget.usdPerDay`, `jev.budget.usdPerWeek`, `jev.budget.minCreditUsd`; legacy
  `jev.json` `budget` still read). Over `usdPerDay` the assist layer logs one
  `budget-warning` row per day; `jev-report` shows `budgetStatus` (24h/7d spent vs
  budget). **Jev is never auto-disabled.**
- **Credit balance** (vercel transport + key): `GET https://ai-gateway.vercel.sh/v1/credits`,
  report/status time only, 15-minute cache (`~/.anti-hall/cache/jev-credits.json`);
  below `minCreditUsd` in watch mode → one warning per day.
- **Audit snippets** (opt-in, `jev.audit.snippets`, env `ANTIHALL_JEV_AUDIT_SNIPPETS`):
  a redacted ~200-char snippet for decisions that changed an outcome, in
  `~/.anti-hall/logs/jev-audit.ndjson` (mode 600); `jev-report.js prune-audit --days N`
  trims it (manual only).
