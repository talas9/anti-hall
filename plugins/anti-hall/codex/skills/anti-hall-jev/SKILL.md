---
name: anti-hall-jev
description: Activate, configure, or check the opt-in Jev classifier for Codex. Use when the user says activate/enable/disable/turn on/set up jev, jev status, or jev report.
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
  call count. No key or network needed.
- `disable` — or `ANTIHALL_JEV=0` for a one-session-only override.
- `mode <integration> on|shadow|off` — `on` lets Jev influence that
  integration's outcome; `shadow` consults+logs without changing anything (build
  up `jev report` data before trusting it); `off` skips it. `speculation`/`triage`
  default `on` once Jev is enabled; everything else defaults `shadow`.
- `node "$ANTI_HALL_ROOT/scripts/jev-report.js" [--window 24h|7d]` — read-only
  KEEP/REVIEW/REMOVE summary per integration. Two cost signals: `costPerCall` in
  `~/.anti-hall/jev.json` for a manual estimate (else `n/a`), and an automatic
  REAL cost parsed from each call's own response when the gateway reports one —
  see `hooks/lib/jev-client.js`'s `extractCostAndUsage`
  (https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#look-up-a-generation).
  The systemone endpoint this build calls does not currently return those
  fields, so set `prices` (`{"<model>": {"inPerMTok", "outPerMTok"}}` or a
  `"default"` entry) in `jev.json` to compute real cost from token counts when
  present instead. Never an extra network call; never charges a cache hit.

## Never

Never print/log/commit the key. Never guess the provider. Never store the key
anywhere but the resolved key file (`~/.config/vercel/ai-gateway-key` or
`~/.config/typesafe/key` by default).
