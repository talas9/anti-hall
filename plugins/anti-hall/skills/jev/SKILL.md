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
modes/24h call count. Never needs a key or a network call.

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
  per-token rate instead, set `prices` in `jev.json`
  (`{"typesafe-ai/jev": {"inPerMTok": 0.5, "outPerMTok": 1.5}}`, or a `"default"`
  entry) and `jev report` computes real cost from actual token counts when the
  response includes them. Real cost NEVER costs an extra network call and NEVER
  charges a cache hit. `jev report --window 24h|7d` shows real cost totals,
  $/call, and $/changed-decision per integration (default: both windows).

## "jev report"

`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-report.js" [--window 24h|7d]` — a
read-only per-integration summary (call volume, agreement %, decisions changed,
good-outcome rate, latency, estimated cost, real cost) with a KEEP/REVIEW/REMOVE
suggestion per integration. Never mutates state.

## Per-integration modes

`node "${CLAUDE_PLUGIN_ROOT}/scripts/jev-setup.js" mode <integration> on|shadow|off`
— `on` lets Jev actually influence that integration's outcome (bounded by its own
trust rule), `shadow` consults and logs Jev but never changes the result (useful to
gather `jev report` data before trusting it), `off` skips it entirely. `speculation`
and `triage` default to `on` once Jev is enabled (pre-existing behavior); every
other integration (e.g. `modelRouting`) defaults to `shadow` until promoted.

## Never do this

- Never print, log, echo, or commit the key — not in this chat, not in a file,
  not in a script argument.
- Never guess which provider a key belongs to from its shape — always ask.
- Never store the key anywhere but the resolved key file
  (`~/.config/vercel/ai-gateway-key` or `~/.config/typesafe/key` by default).
