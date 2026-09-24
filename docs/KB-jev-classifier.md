# KB-jev-classifier.md — Jev (TypeSafe System One) as an opt-in classifier backend

> Status: opt-in, **default OFF**. Currently wired into `speculation-guard.js` only (Tier 2
> Stop hook), with the existing regex check as the fallback.
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

**Planned, not yet built:** DevSwarm mesh message triage (urgent / needs-reply / FYI) —
the same "typed decision on a rubric" shape Jev is suited for. Not implemented as of
this doc.

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
