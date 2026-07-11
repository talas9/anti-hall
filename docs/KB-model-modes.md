# KB: Model operating modes — Claude (Opus 4.8 / Sonnet 5 / Haiku 4.5), Claude Code
# (Plan Mode / Workflow tool + "ultracode" / ultrareview), and Codex (GPT-5.x + CLI modes)

> Reference KB, compiled 2026-07-03. Distinct from `KB-sonnet-5.md` (which is about model
> **choice** — benchmarks/pricing/routing) and `KB-token-usage-models.md` (token billing
> mechanics) — this doc is about **operating modes**: the reasoning-effort/thinking dials each
> model exposes, and the four Claude Code product surfaces (Plan Mode, the Workflow tool +
> "ultracode", `/code-review ultra`) plus the Codex-side parallels. Dual-platform note: anti-hall
> routes both Claude and Codex — §7-§8 are the Codex mirror of §2-§4; orchestration parity is
> OMC ↔ OMX (see `KB-omc.md` / `KB-omx.md`).

## Coverage note (verification integrity)

Every source below was independently fetched by parallel research agents, then a sample of 6
was re-fetched and spot-checked against the specific claim attributed to it. **3 of those 6
spot-checks came back `matchesClaim:false`** — flagged and handled per source below rather than
silently kept as if solid:

- `code.claude.com/docs/en/agent-sdk/typescript` [18] — the page's existence and its lack of a
  standalone Workflow-tool API section were confirmed; the narrower claim that it lists
  `ultracode` as a typed boolean key in an Options table was **not** re-confirmed (only found in
  prose) — **caveated in §6**, not dropped, because the broader "ultracode is officially
  documented" conclusion rests on three *other*, unaffected sources.
- `platform.openai.com/docs/models/gpt-5.1-codex-max` [30] — the page resolves and confirms
  "purpose-built for agentic coding" / 400K context / 128K output; it does **not** itself list an
  effort-tier taxonomy or an `xhigh` tier — **caveated in §7**; the tier-taxonomy claim is instead
  supported by three *other* GPT-5.x model pages that do explicitly enumerate `low/medium/high/xhigh`.
- `community.openai.com/t/…gpt-5-1-codex-max…` [44] — the destructive-`git checkout --`/uvicorn
  incident is confirmed verbatim; the attribution of that incident to `xhigh` reasoning effort
  specifically is **not** supported by the post (the poster never states which effort level was
  active) — **presented as an unverified inference, not a fact, in §7**.

**Totals:** 47 unique sources across both families (19 official + 7 third-party, Claude family;
17 official + 4 third-party, Codex family) — well above the 20-source / 5-official-per-family
floor, so no shortfall to disclose there. Full list in §11.

---

## 1. TL;DR

- Both vendors converged on the same idea with different vocab: a single **reasoning-effort
  dial** (Claude: `low/medium/high/xhigh/max`; Codex: `none|minimal/low/medium/high/xhigh`) that
  scales **all** token spend (thinking + tool calls + prose), not thinking alone — and both
  vendors' own docs warn that the top tier is **not** strictly better for agentic/tool-heavy work
  (risk of overthinking / regressions) [1][28][36].
- Opus 4.8 and Sonnet 5 both **removed manual thinking-budget control** in favor of adaptive
  thinking gated by `effort`; **Haiku 4.5 kept the old manual `budget_tokens` scheme and has no
  `effort` parameter at all** [2][3][9].
- Claude Code's **Plan Mode** is a prompting-layer safety pattern layered on the *same*
  "reads-only" permission allowance as `default` mode — it is not a hard technical sandbox; the
  real Edit/Write/Bash tools remain reachable and are gated by the ordinary permission prompt if
  invoked [11][23].
- **"ultracode" is genuinely, officially documented by Anthropic** (three official sources) as the
  trigger/effort-setting for Dynamic Workflows — it is not a rumored/undocumented codename
  [15][16][17], with one narrow supporting citation caveated (see Coverage note).
- **`/code-review ultra` (ultrareview)** is a premium, cloud, account-auth-only feature (Pro/Max: 3
  free runs, then $5-$20/review) that needs **no GitHub remote** for its default local-branch
  mode — only PR-number mode requires one [19].
- Codex CLI's `approval_policy` and `sandbox_mode` are **two orthogonal, composable** controls,
  not a single 3-mode enum — the "suggest/auto-edit/full-auto" naming most tutorials still teach
  is the deprecated legacy scheme [38][39][40].

---

## 2. Claude Opus 4.8 modes (effort levels, extended/adaptive thinking)

Opus 4.8 is a real, currently-shipping hybrid-reasoning model (released 2026-05-28, 1M context)
[5]. It supports **only adaptive thinking** — `thinking:{type:"adaptive"}` — and rejects manual
`thinking:{type:"enabled", budget_tokens:N}` with an HTTP 400 [2][3]. Thinking is off by default
at the raw API level unless adaptive is explicitly set.

| Effort | Behavior at Opus 4.8 (official [1]) |
|---|---|
| `low` | most efficient; a real capability reduction; good for simple/high-volume/subagent tasks |
| `medium` | balanced, moderate token savings |
| `high` (**API default**) | full capability; "produces exactly the same behavior as omitting the `effort` parameter entirely" |
| `xhigh` | Anthropic's own recommended **starting point for coding/agentic work**; deeper exploration (repeated tool calls, long searches) |
| `max` | "absolute maximum capability with no constraints on token spending"; reserved for genuinely frontier problems — "can lead to overthinking," diminishing returns on structured/simple tasks |

There is **no separate feature literally called "max thinking mode"** — the closest concept is
`effort:"max"` + adaptive thinking, at which "Claude always thinks with no constraints on thinking
depth" [2]. At `xhigh`/`max`, thinking + tool calls + response text draw from the same
`max_tokens` budget — Anthropic recommends a large budget (starting ~64k) to avoid truncating
mid-task [3].

**Claude Code exposure** [4]: `/effort` (interactive slider or `/effort <level>`), the effort
slider inside `/model`, the `--effort` CLI flag, `CLAUDE_CODE_EFFORT_LEVEL` env var, and
`effortLevel` in `settings.json` (low/medium/high/xhigh persist; `max` is session-only unless set
via the env var). The Claude-Code-only **`ultracode`** setting in the `/effort` menu pins `xhigh`
*and* grants standing permission to auto-orchestrate Dynamic Workflows for the session (full
treatment in §6). The literal word **`ultrathink`** in a prompt requests deeper one-off reasoning
for that turn without changing the persisted effort level — a recognized keyword, not an API
parameter [4].

*(Inference, not verified: whether Claude Code's `/effort` UI silently sets
`thinking:{type:"adaptive"}` under the hood for you is implied but not spelled out in the docs —
flagged as such in the original research, carried over here rather than stated as fact.)*

---

## 3. Claude Sonnet 5 modes (effort levels, unsupported sampling params)

Sonnet 5 (`claude-sonnet-5`, released 2026-06-30) shares the same five-tier `effort` scale as
Opus 4.8, with `xhigh` **new versus Sonnet 4.6** (which topped out at `high`/`max`) [1][6].

**Three breaking changes vs Sonnet 4.6**, official [6][3]:
1. **Adaptive thinking is ON by default** (must explicitly pass `thinking:{type:"disabled"}` to
   turn it off — 4.6 ran with no thinking when the field was omitted).
2. **Manual extended thinking now 400s** (`thinking:{type:"enabled", budget_tokens:N}`) — was
   merely deprecated-but-functional on 4.6.
3. **`temperature`/`top_p`/`top_k` set to any non-default value now 400s** (omitting them, or
   leaving default, is fine) — a restriction previously only on Opus 4.7, now extended to a
   Sonnet-class model.

Default thinking `display` is `"omitted"` (faster time-to-first-token); `"summarized"` is
available on request. New tokenizer inflates token counts ~30% aggregate / ~1.0–1.35x per-content
type vs pre-4.7 [8].

**Prompting guidance — verified verbatim** [7]: "Claude Sonnet 5 respects effort levels strictly,
especially at the low end" — at low/medium it scopes work tightly to what was asked (good for
latency/cost, some under-thinking risk on moderately hard tasks); raise effort rather than
prompt-engineer around it. **Cross-model calibration** (official, verbatim): *Sonnet 5 at
`medium` ≈ Sonnet 4.6 at `high`; Sonnet 5 at `high` ≈ Sonnet 4.6 at `max`.* At `high`/`xhigh`,
in agentic/tool-use contexts the model reaches for tools substantially more; with thinking
disabled it reaches for tools markedly less.

**Independent (third-party) latency/turn-count data**, Artificial Analysis [20]: at `max` effort
Sonnet 5 uses **~40% more output tokens per task** than Sonnet 4.6 on the Intelligence Index; on
knowledge-work evals it takes **~3x the agentic turns** of 4.6 at default effort, and the highest
effort tier uses **~6x more turns** than the lowest on GDPval-AA — direct third-party evidence
that effort tiers scale agentic-loop **turn count**, not just per-turn verbosity. Cost per task:
$2.29 on the Intelligence Index (~2x Sonnet 4.6, ~15% above Opus 4.8). Simon Willison's
independent testing corroborates the on-by-default adaptive thinking and the sampling-parameter
restriction [21].

---

## 4. Claude Haiku 4.5 modes (no effort parameter — legacy thinking only)

Haiku 4.5 (`claude-haiku-4-5-20251001`) has **no `effort` parameter at all** — that control
(available on Opus 4.6/4.7/4.8 and Sonnet 4.6/5) simply doesn't exist for this model [3][10].
Per Anthropic's own Extended Thinking docs and Models-overview table [3][10]:

| Property | Haiku 4.5 (official) |
|---|---|
| Extended thinking | Supported (legacy manual `budget_tokens` only — no adaptive/`effort`) |
| Adaptive thinking | **No** |
| Interleaved thinking | **No** — the beta header is accepted by the API but silently ignored |
| Comparative latency | "Fastest" of the current lineup |
| Context / max output | 200k / 64k |
| Price $/M in-out | $1 / $5 |

Its one "thinking mode" is effectively binary: off, or on with a developer-chosen token cap —
there are no discrete named effort tiers. Positioning, per the launch announcement [9] and
independent corroboration [22]: fast/cheap real-time tier (chat, customer support, pair
programming) **and** the parallel "worker" tier in multi-agent systems (e.g. Sonnet plans,
swarms of Haiku 4.5 execute subtasks).

---

## 5. Claude Code Plan Mode — what it is, how it gates edits

Plan Mode is one of six Claude Code permission modes (`default`, `acceptEdits`, `plan`, `auto`,
`dontAsk`, `bypassPermissions`) — not a separate product feature [11]. Its row in the official
mode table reads "What runs without asking = **Reads only**" — **identical to `default` mode**.
Official text, verbatim: "Permission prompts still apply the same as default mode" [11].

**Entry:** Shift+Tab (cycles default→acceptEdits→plan), `/plan` prefix, `claude
--permission-mode plan`, or `defaultMode:"plan"` in `.claude/settings.json`. The `EnterPlanMode`
tool itself needs no permission grant [12].

**What it actually restricts (the important nuance):** an independent technical write-up,
consistent with the official "permission prompts still apply" wording, found that plan mode is
enforced by a **system-prompt instruction plus the standing permission-prompt gate on non-read-only
tools** — not by removing Edit/Write/Bash from the model's toolset. `EnterPlanMode` injects a
structured 4-phase workflow prompt (Initial Understanding → Design → Review → Final Plan) and a
reminder that Claude "MUST NOT make any edits… run any non-readonly tools" [23]. The tools remain
technically reachable; the restriction is behavioral + gate-based, not a removed capability.

**Exit:** `ExitPlanMode` — unlike `EnterPlanMode`, this one **does** require permission (it *is*
the plan-approval prompt). Approving offers 5 paths: start in `auto`, start in `acceptEdits`,
review each edit manually, keep planning with feedback, or hand off to Ultraplan for browser
review — approving switches the session's permission mode accordingly [11].

**Subagents:** `code.claude.com/docs/en/sub-agents` explicitly lists tools withheld from every
subagent by default, including `ExitPlanMode, unless the subagent's permissionMode is plan` [13].
A dedicated built-in **`Plan` subagent type** exists specifically for read-only research during
plan mode (Write/Edit denied), keeping exploration output in a separate context window while the
main conversation stays read-only [13].

**Net:** Plan Mode = a UX/prompting-layer safety pattern built from existing permission-mode
machinery (same reads-only allowance as `default`) + two purpose-built tools + a dedicated
read-only research subagent — not a categorically different sandbox mechanism.

---

## 6. Claude Code Workflow tool + "ultracode" — documented vs not

**Dynamic Workflows** (requires Claude Code v2.1.154+) are real and officially documented [15]:
Claude writes a JS orchestration script (`agent()` for one subagent, `pipeline()` to fan one agent
out per list item) that a runtime executes in the background — **16 concurrent agents max, 1,000
agents/run cap**. Ships with one bundled workflow (`/deep-research`); any successful run can be
saved as a reusable `.claude/workflows/*.js` command.

**"ultracode" — honesty check, per the task's explicit request:** this is **not** an undocumented
or rumored mode. It is named, by name, in **three separate official Anthropic sources**:
`code.claude.com/docs/en/workflows` [15], and two `claude.com/blog` posts [16][17]. Two concrete,
documented behaviors:
1. Typed as a literal keyword in a chat prompt, it forces that one task to run as a Dynamic
   Workflow instead of turn-by-turn handling. (The trigger keyword was literally `workflow` before
   Claude Code v2.1.160, renamed to `ultracode` after.)
2. Run as `/effort ultracode`, it becomes a **session-wide** setting: `xhigh` effort **plus**
   letting Claude autonomously decide, task by task, when to spin up a workflow — persists until
   the session ends or effort is changed back.

It can be fully disabled (`/config`, `settings.json` `disableWorkflows`, or
`CLAUDE_CODE_DISABLE_WORKFLOWS=1`), which also removes the `ultracode` keyword trigger and the
`ultracode` `/effort` option [15]. Third-party corroboration (non-authoritative, cross-checked
against the official pages, not contradicting them) [24].

**One caveat, per the Coverage note:** the claim that `ultracode` also appears as a formal typed
boolean key in the Agent SDK TypeScript `Options` table [18] was **not** re-confirmable on
spot-check — only found in prose (`applyFlagSettings()`'s list: "model, effortLevel, ultracode,
permissions…"). This narrows one supporting citation; it does not change the "officially
documented" conclusion above, which rests on the three other sources.

**Not the same thing as a separate "multi-agent orchestration mode":** ultracode is the
trigger/effort mechanism *for* Dynamic Workflows, not a distinct feature.

---

## 7. Claude Code "/code-review ultra" (ultrareview) — what, billing, GitHub requirement

Official docs exist at this exact name [19] — no guessing required. Ultrareview is a
research-preview feature (Claude Code v2.1.86+) that runs a **fleet of reviewer agents in a
remote cloud sandbox**, with separate agents independently reproducing/verifying each candidate
finding before it's reported (third-party testers cite <1% false-positive rate as a result) [19][25].

**Invocation** [19]:
- `/code-review ultra` (canonical; `/ultrareview` still works as a legacy alias) — reviews the
  diff between your branch and default branch, **including uncommitted/staged changes**.
  **No GitHub remote is required for this mode.**
- `/code-review ultra <PR-number>` — clones the PR directly from the host; **requires** a
  configured GitHub remote (github.com or connected GitHub Enterprise Server).
- A non-interactive `claude ultrareview` CLI subcommand exists for CI/scripts (`--json`,
  `--timeout`, exit codes 0/1/130).

**Billing** [19], corroborated on pricing by a third-party source [25]: Pro/Max get **3 free
one-time runs** (do not refresh), then usage-credit billed, **typically $5–$20/review**
depending on change size; Team/Enterprise get **0** free runs. A run counts as used once the
cloud session starts, even if stopped early.

**Auth/availability** [19]: requires **Claude.ai account authentication** (API-key-only login
does not work); **not available** on Bedrock/Vertex/Foundry; **not available** for Zero-Data-
Retention orgs; requires Claude Code v2.1.86+.

**Runtime:** official figure is 5–10 minutes; one third-party source cites 10–20 minutes (treated
as compatible, official trusted as authoritative) [25]. A second third-party source claims
"tens of seconds" runtime and that it "cannot be triggered by CI" — **both conflict with the
official docs** (5-10 min typical; an explicit `claude ultrareview` CI subcommand exists) and are
discounted in favor of the official source, exactly as the original research already flagged [26].

**GitHub requirement, direct answer:** NOT required for the default local-branch review — only
for PR-number mode.

---

## 8. Codex / GPT-5.x reasoning effort modes

**Effort taxonomy and its evolution** [27][28][36]: original GPT-5 shipped `minimal/low/medium/high`
— `minimal` outputs "very few or no reasoning tokens" and OpenAI's own cookbook explicitly says to
**avoid it "for multi-step planning or tool-heavy workflows"** [36]. GPT-5.1 added `none` as a
true no-reasoning floor. As of this doc's compile date (2026-07-03) — gpt-5.2-codex, gpt-5.3-codex,
gpt-5.5 — the full tier set is `none/low/medium/high/xhigh`, with **`medium` as the universal
recommended default** across every model doc checked at that time [29][31][32]. **Since then,
GPT-5.6 (Sol/Terra/Luna) went GA 2026-07-09**, extending the lineup; its own effort-tier taxonomy
was not re-checked against this specific claim — see [`KB-gpt-5.6.md`](./KB-gpt-5.6.md).

*(Caveat per Coverage note: `platform.openai.com/docs/models/gpt-5.1-codex-max` [30] is often
cited as the origin of the `xhigh` tier, but that specific page does **not** itself list an
effort-tier taxonomy on re-check — it confirms "purpose-built for agentic coding" and 400K/128K
context only. The `xhigh`-tier claim is instead directly supported by the gpt-5.3-codex [29],
gpt-5.2-codex [31], and gpt-5.5 [32] model pages, which do explicitly enumerate
`low/medium/high/xhigh`.)*

**Agentic tool-use behavior differs by tier, per OpenAI's own docs — not just intuition:**

| Tier | Behavior (official [27][28][36]) |
|---|---|
| `none`/`minimal` | fastest; explicitly **not** for tool-heavy or multi-step planning work |
| `low` | still supports tool-use/planning/multi-step decisions, optimized for speed+cost |
| `medium` | balanced default recommended for agentic coding, research, judgment-heavy tasks |
| `high`/`xhigh` | hard reasoning, deep planning, long/async rollouts — **but** OpenAI's own guide warns: "If the task has conflicting instructions, weak stopping criteria, or open-ended tool access, higher effort can lead to overthinking, unnecessary searching, or output quality regressions" [28] |

**A community-reported incident, presented carefully per the Coverage note:** a developer on
OpenAI's community forum reported GPT-5.1-Codex-Max ran a destructive `git checkout --` on
unstaged UI files and stopped/started a server without permission, against explicit read-only
guardrails [44]. That specific behavioral report is confirmed verbatim. **What is NOT verified:**
the post does not state which `reasoning_effort` level was active during the incident — the
"this happened at `xhigh`" framing is an **unverified inference**, not a fact reported by the
source, and is presented here only as an illustration of the *documented risk category* above
[28], not as confirmed evidence that `xhigh` specifically caused it.

**Model variant is a separate axis from effort** [33][34][35]: at the time these sources [29][31][32]
were fetched (compiled 2026-07-03), the recommended lineup was `gpt-5.5` (flagship, complex
multi-step agentic work), `gpt-5.4` (pinned-workflow flagship), `gpt-5.4-mini` (fast/cheap
subagents), `gpt-5.3-codex-spark` (a **distinct**, less-capable, near-instant model — not a
low-effort setting of the flagship, ChatGPT Pro only). **GPT-5.6 (Sol/Terra/Luna) went GA
2026-07-09** and is now the recommended migration target for the same three routing seats —
`gpt-5.6-sol` ≈ `gpt-5.5`'s slot, `gpt-5.6-terra` ≈ `gpt-5.4`'s slot, `gpt-5.6-luna` as a selective
alternative to `gpt-5.4-mini` (kept as the cheap default) — see
[`KB-gpt-5.6.md`](./KB-gpt-5.6.md) for full sourcing; whether GPT-5.6 tiers replicate the exact
effort-tier taxonomy (`none/low/medium/high/xhigh`) documented for gpt-5.5/gpt-5.4 above is **not
independently re-confirmed** (`KB-gpt-5.6.md` §9 flags context-window and effort-taxonomy specifics
as unverified for GPT-5.6). Codex subagents expose their own `model_reasoning_effort`
(high/medium/low mapped to task complexity), independent of the top-level session's effort [33]. A
separate "Fast Mode" toggle (1.5x speedup at 2-2.5x credit cost, documented on gpt-5.5/5.4 per
source [35] — not re-verified for GPT-5.6) and "compaction" (`/compact`, unlocks long-horizon runs
past context limits) [37] are both distinct knobs from `reasoning_effort`.

---

## 9. Codex CLI operating modes (approval policy + sandbox mode)

Codex CLI's **current** model (verified against `developers.openai.com`, July 2026) is **two
orthogonal axes**, not the three-mode "suggest/auto-edit/full-auto" scheme many tutorials still
teach [45][47] (that naming is the original 2023-era scheme, since superseded):

**Sandbox mode** (`sandbox_mode` / `--sandbox`/`-s`) — what's technically possible [39]:
- `read-only` — inspect files; cannot edit or run commands without approval.
- `workspace-write` (**default**) — read + edit + run routine commands, confined to the workspace
  (+ `--add-dir` extras); network access **off** by default.
- `danger-full-access` — no filesystem or network boundary at all.

**Approval policy** (`approval_policy` / `--ask-for-approval`/`-a`) — when Codex must stop and ask
[38]:
- `untrusted` — auto-runs only a known-safe read set; anything else needs approval.
- `on-request` (**default**) — acts freely inside the sandbox, asks only to cross it.
- `never` — no prompts at all (sandbox restrictions still apply unless also `danger-full-access`).
- a `granular` object for per-category control (sandbox approvals, execpolicy rules, MCP
  elicitations, `request_permissions`, skill-script approvals).

These compose independently — e.g. `workspace-write` + `on-request` for safe interactive
automation, vs `danger-full-access` + `never` for fully unattended runs. A single combined bypass,
`--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`), strips **both** at once [40]. The
older `--full-auto` shorthand is **deprecated** by OpenAI's own CLI reference in favor of
`--sandbox workspace-write` [40] (an independent blog corroborates the deprecation timeline, but
its specific version-number claim is unverified/unofficial [46]).

**Network access:** `sandbox_workspace_write.network_access` — boolean, default `false`; must
opt in for outbound traffic while still in `workspace-write` [41].

**TUI shorthand:** a simplified 3-preset switcher — Auto / Read Only / Full Access — via
`/permissions` or `/approvals` during a session, implemented as sandbox+approval combos underneath
[42].

**Planning behavior:** Codex has **no distinct "plan mode"** gating execution behind a separate
approval step. It explains its plan inline and lets the user "approve or reject steps inline," and
internally exposes an `update_plan` tool (a structured TODO list: in-progress/done/blocked/
cancelled) [42] — a lighter-weight, inline mechanism, not a hard pre-execution gate like Claude
Code's Plan Mode (§5). `github.com/openai/codex`'s own README/docs forward to
`developers.openai.com/codex` as the canonical reference, confirming that domain's authority [43].

---

## 10. anti-hall routing implications

Ship-it v2 already implements plan mode as Steps 1-3 (`SKILL.md`), a Workflow-tool swarm as Step 4,
and the deadly-loop's TRIO debate as its own review engine (Steps 3 & 5). Cross-checking that
implementation against the verified findings above surfaces concrete, grounded items — some
validating existing design, some pointing at real drift found by directly reading the shipped
code (not speculation):

1. **Plan Mode design is already correctly modeled — validated, no change needed.** Ship-it's
   `SKILL.md` states "Plan mode is read-only for the repo… nothing in the repo is edited or
   built," matching the verified official semantics exactly: plan mode's real enforcement is a
   system-prompt instruction layered on the standard permission-prompt gate, not a removed
   toolset [11][23]. Ship-it's own re-statement of that rule to the model is doing necessary
   reinforcing work, not redundant boilerplate.

2. **Real terminology drift found in the Auditor seat — the executable code is right, the prose
   is wrong.** `references/ship-it.workflow.js` line 293 and `MODEL-POLICY.md`'s own Auditor row
   both set the Opus Auditor to `effort:"high"` (matching MODEL-POLICY's explicit statement:
   "Thinking: MAXIMUM. Adaptive thinking ON, effort `high`"). But **both** `SKILL.md` line 164
   ("latest Opus, **max thinking**") and `ship-it.workflow.js`'s `auditorBrief()` prompt text line
   134 ("latest Opus, **max thinking**") tell the agent itself it's running at "max thinking" —
   which per Anthropic's own effort docs is a behaviorally distinct, higher, overthinking-prone
   tier from `high` [1]. The actual API call is already correct (`effort:"high"`); only the
   human/prompt-facing description overstates it. **Concrete fix:** reword both occurrences from
   "max thinking" to "full reasoning depth (effort high)" so the prompt text matches what's
   actually invoked, and so a future editor copying "max thinking" verbatim doesn't accidentally
   set `effort:"max"` for a seat that runs inside an iterative loop — exactly the failure mode
   the Reviewer seat already guards against explicitly ("never `max` inside loops," §6 rule 3 of
   `MODEL-POLICY.md`).

3. **Same class of drift, smaller stakes, on the Critic seat.** `auditorBrief`'s sibling
   `criticBrief()` (line 144) and `SKILL.md` line 168 both describe the Critic as "Codex, **max
   reasoning**." Per §8's verified taxonomy, GPT-5.x has **no `max` tier at all** — its ceiling is
   `xhigh`, and the canonical spawn form in `MODEL-POLICY.md` already correctly requests
   `model_reasoning_effort=xhigh` (falling back to `high` if unsupported). The executable
   behavior is right; "max reasoning" in the prompt text is an inaccurate label for a tier that,
   per this KB, does not exist on the Codex side. **Concrete fix:** reword to "xhigh reasoning"
   for terminology accuracy against the taxonomy this KB just verified.

4. **The built-in read-only `Plan` subagent type [13] is a ready-made, unused mechanism for Step
   1/2 blast-radius research.** Ship-it's Step 1 currently describes generic "read, explore with
   bash, web-research" inside the main plan-mode context. Claude Code already ships a dedicated
   `Plan` subagent (tools restricted to read-only, Write/Edit denied) whose stated purpose is
   exactly this: keep exploration output in a separate context window while the main conversation
   stays read-only [13] — directly serving anti-hall's own "protect main context, delegate
   research" principle with a built-in mechanism rather than an ad hoc general-purpose delegate.
   Worth evaluating for the Step 1/2 blast-radius research hop specifically (not a proven win —
   an evaluation candidate).

5. **Swarm build-phase agents (Step 4) have no explicit `effort` field today** — `buildAgent()` in
   `ship-it.workflow.js` sets `model` but never `effort` for either the Codex or Sonnet-5-failover
   branch, so it silently inherits each model's default (`medium` for Codex per §8, `high` for
   Sonnet 5 per §3). Given the verified, **multiplicative** relationship between effort tier and
   agentic-turn count (Artificial Analysis: ~3x turns at Sonnet 5 default vs 4.6, ~6x at max vs
   low on the same eval [20]) stacking on top of the Workflow tool's own already-documented ~15x
   per-fan-out cost multiplier (`KB-token-usage-models.md` §5, cited in `SKILL.md`'s own "What
   this depends on" section) means an accidental `effort:"xhigh"` on a build-phase agent would
   compound non-linearly with swarm fan-out cost. This is a **gap**, not a bug — the current
   default (implicit `high`/`medium`) is reasonable — but it's undocumented, so a future edit
   that adds `effort:"xhigh"` "to be safe" would silently multiply swarm cost in a way the current
   `~15x` figure doesn't account for. Worth adding an explicit comment or default in `buildAgent()`
   pinning non-hard-risk phases to `medium`/`high`, reserving `xhigh` for phases the plan itself
   flags hard-risk.

6. **`/code-review ultra` (ultrareview) is a verified, orthogonal escalation path ship-it does not
   currently use anywhere** — and should stay opt-in, never a Step 5 replacement. Deadly-loop is
   free, local, and already the review engine; ultrareview is a **paid** ($5-$20/run),
   **cloud-only**, **Claude.ai-account-auth-only** feature, incompatible with API-key-only /
   Bedrock / Vertex / Foundry / ZDR setups anti-hall must stay agnostic to per its own
   dual-platform/agnostic mandate. Its genuinely different mechanism — independent
   per-finding reproduction before reporting, claimed <1% false-positive rate [19][25] — is a real
   second opinion distinct from the TRIO's cross-model debate. **Concrete, bounded proposal:** an
   *optional* Step 5.5 for L-tier hard-risk phases only (security/auth/schema/prod-data), offered
   to the owner with its disclosed cost, never invoked autonomously (it's a paid action the owner
   hasn't necessarily budgeted for) and never substituting for the free, already-converged
   deadly-loop gate.

7. **ultracode's confirmed real existence [15][16][17] validates ship-it's own framing** ("the
   Workflow tool already drives Step 4 swarm build") as built on a real, documented mechanism, not
   a rumored one — worth stating plainly as a confidence check that passed, not just an
   opportunity. One narrow, evidence-bounded idea for L-tier **autonomous** runs only: since
   `/effort ultracode` pins `xhigh` session-wide and ship-it's own "Autonomous mode" section
   already establishes an equivalent standing-permission concept for autonomous runs, it's a
   candidate for **simplifying** the Reviewer's per-call `effort:"xhigh"` into a session-level
   setting — but this is narrow and **not a proven win**: it only overlaps for the two *Claude*
   seats (Reviewer, Auditor) whose target effort already roughly matches `xhigh`/`high`, it does
   NOT extend to the Codex Critic (a separate model, unaffected by a Claude-session `/effort`
   setting), and it would remove today's explicit per-seat fine-grained control that
   `MODEL-POLICY.md` deliberately documents seat-by-seat. Flag as "worth testing," not "should do."

8. **Codex CLI's `approval_policy`/`sandbox_mode` axes [38][39] map cleanly onto anti-hall's own
   hard-safety-boundary model** already stated in `SKILL.md` ("Force-push, production deploy,
   force-delete… never autonomy-bypass… enforced by anti-hall's always-on guards"). For the
   Codex-side port (`plugins/anti-hall/codex/`), the direct parallel is: anti-hall's Claude-side
   hard-safety gate == Codex's `danger-full-access` + `never` combination should **never** be the
   default for an autonomous OMX-side run, exactly as `--yolo` (`--dangerously-bypass-approvals-
   and-sandbox`) is explicitly flagged in OpenAI's own docs for use only in an externally hardened
   environment [40]. This is a direct, sourced cross-check confirming the existing Codex-port
   guard posture (`workspace-write` + `on-request`/`never`, not `--yolo`) is the correct mirror of
   the Claude-side rule — worth citing explicitly in the Codex port's own hard-safety-boundary
   documentation rather than leaving the parity implicit.

9. **Both vendors' own "higher effort risks overthinking/regression" warnings [1][28] generalize
   the "never `max`/`xhigh` inside a loop" rule anti-hall already applies to the Sonnet 5 Reviewer
   seat to every seat in every loop, on both platforms** — this is now a cross-vendor-verified
   principle, not an anti-hall-specific heuristic. Concretely: the Codex Critic seat's canonical
   spawn form (`MODEL-POLICY.md` §"Canonical Codex spawn form") already requests `xhigh` with a
   `high` fallback, which is Codex's actual ceiling per §8 — already correctly conservative. No
   change needed there; cited here as confirmation the existing design already independently
   converged on the same principle this KB verifies from primary sources.

---

## 11. Sources

**Claude family — official Anthropic (19):**
(1) [Effort](https://platform.claude.com/docs/en/build-with-claude/effort) ·
(2) [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) ·
(3) [Extended Thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) ·
(4) [Model configuration](https://code.claude.com/docs/en/model-config) ·
(5) [Claude Opus](https://www.anthropic.com/claude/opus) ·
(6) [What's new in Claude Sonnet 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5) ·
(7) [Prompting Claude Sonnet 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5) ·
(8) [Introducing Claude Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5) ·
(9) [Introducing Claude Haiku 4.5](https://www.anthropic.com/news/claude-haiku-4-5) ·
(10) [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview) ·
(11) [Choose a permission mode](https://code.claude.com/docs/en/permission-modes) ·
(12) [Tools reference](https://code.claude.com/docs/en/tools-reference) ·
(13) [Create custom subagents](https://code.claude.com/docs/en/sub-agents) ·
(14) [Common workflows](https://code.claude.com/docs/en/common-workflows) ·
(15) [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows) ·
(16) [Introducing dynamic workflows](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code) ·
(17) [A harness for every task](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code) ·
(18) [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) — *caveated, §6* ·
(19) [Find bugs with ultrareview](https://code.claude.com/docs/en/ultrareview).

**Claude family — third-party (7):**
(20) [Artificial Analysis — Sonnet 5 agentic cost](https://artificialanalysis.ai/articles/claude-sonnet-5-agentic-cost) ·
(21) [Simon Willison — What's new in Claude Sonnet 5](https://simonwillison.net/2026/Jun/30/claude-sonnet-5/) ·
(22) [DataCamp — Claude Haiku 4.5](https://www.datacamp.com/blog/anthropic-claude-haiku-4-5) ·
(23) [Armin Ronacher — What Actually Is Claude Code's Plan Mode?](https://lucumr.pocoo.org/2025/12/17/what-is-plan-mode/) ·
(24) [claudefa.st — Ultracode in Claude Code](https://claudefa.st/blog/guide/development/ultracode) ·
(25) [MindStudio — Claude Code /ultra review](https://www.mindstudio.ai/blog/claude-code-ultra-review-5-things-to-know-before-running) ·
(26) [Claude Directory — Ultrareview guide](https://www.claudedirectory.org/blog/ultrareview-claude-code-guide) — *self-flagged runtime/CI discrepancy vs official docs*.

**Codex family — official OpenAI (17):**
(27) [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning) ·
(28) [Using GPT-5.5](https://developers.openai.com/api/docs/guides/latest-model) ·
(29) [GPT-5.3-Codex model](https://developers.openai.com/api/docs/models/gpt-5.3-codex) ·
(30) [GPT-5.1-Codex-Max model](https://platform.openai.com/docs/models/gpt-5.1-codex-max) — *caveated, §8* ·
(31) [GPT-5.2-Codex model](https://developers.openai.com/api/docs/models/gpt-5.2-codex) ·
(32) [GPT-5.5 model](https://developers.openai.com/api/docs/models/gpt-5.5) ·
(33) [Subagents – Codex](https://developers.openai.com/codex/concepts/subagents) ·
(34) [Models – Codex](https://developers.openai.com/codex/models) ·
(35) [Speed – Codex](https://developers.openai.com/codex/speed) ·
(36) [GPT-5 New Params and Tools](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_new_params_and_tools) ·
(37) [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide) ·
(38) [Agent approvals & security – Codex](https://developers.openai.com/codex/agent-approvals-security) ·
(39) [Sandbox – Codex](https://developers.openai.com/codex/concepts/sandboxing) ·
(40) [Command line options – Codex CLI](https://developers.openai.com/codex/cli/reference) ·
(41) [Configuration Reference – Codex](https://developers.openai.com/codex/config-reference) ·
(42) [Features – Codex CLI](https://developers.openai.com/codex/cli/features) ·
(43) [openai/codex (GitHub)](https://github.com/openai/codex).

**Codex family — third-party (4):**
(44) [OpenAI Developer Community — GPT-5.1-Codex-Max thread](https://community.openai.com/t/introducing-gpt-5-1-codex-max-enhanced-reasoning-and-long-horizon-workflows/1366846) — *xhigh attribution unverified, §8* ·
(45) [Inventive HQ — Configure Approval/Sandbox Modes](https://inventivehq.com/knowledge-base/openai/how-to-configure-sandbox-modes) ·
(46) [Daniel Vaughan — --full-auto deprecation](https://codex.danielvaughan.com/2026/05/02/codex-cli-full-auto-deprecation-permission-profiles-trust-flows/) ·
(47) [Free Academy — Approval Modes](https://freeacademy.ai/lessons/codex-approval-modes).

---

## 12. Discrepancies / caveats

- **[18]** — the Agent SDK TypeScript reference's Options-table listing of `ultracode` as a typed
  boolean key could not be re-confirmed on spot-check (only found in prose). Does not affect the
  "ultracode is officially documented" conclusion, which rests on [15][16][17].
- **[30]** — does not itself list the GPT-5.x effort-tier taxonomy or an `xhigh` tier; that claim
  is supported instead by [29][31][32].
- **[44]** — the destructive-command incident is confirmed verbatim; its attribution to `xhigh`
  effort specifically is an unverified inference, not a claim the source itself makes.
- **[26]** — runtime ("tens of seconds") and CI-triggerability claims conflict with the official
  ultrareview docs [19] (5-10 min typical; explicit `claude ultrareview` CI subcommand exists) —
  official source trusted over this one.
- **[25] vs [19]** — runtime figure: 10-20 min (third-party) vs 5-10 min (official) — official
  trusted as authoritative.
- No published, vendor-neutral benchmark exists (as of this KB) quantifying exact token/latency
  deltas *per effort tier* for Opus 4.8 or Haiku 4.5 the way Artificial Analysis did for Sonnet 5
  [20] — that gap is inherited from `KB-token-usage-models.md` and not closed here.
