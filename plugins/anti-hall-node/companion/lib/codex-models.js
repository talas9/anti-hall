'use strict';
// anti-hall :: codex-models — resolves a Codex model ROLE (frontier/workhorse/
// cheap) to a live model slug by reading the CLI's own model cache, instead of
// a hardcoded name baked into a workflow/skill file.
//
// WHY: anti-hall used to pin literal slugs (gpt-5.6-sol, gpt-5.4-mini, ...) in
// workflow scripts and SKILL.md policy docs. OpenAI silently retired/renamed
// generations (gpt-5.4 / gpt-5.4-mini return zero matches as of 2026-09-23,
// while ~/.codex/config.toml's own configured model, gpt-5.6-sol, still
// works) and every pinned reference went dead at once — including the "cheap
// seat" that ~15 files / 400+ occurrences depended on. A pinned name is a
// liability with no upside: it breaks again on the next OpenAI rename.
//
// This resolves by ROLE against the cache's own description text and
// `priority` ordering (lower priority = newer/preferred), never a hardcoded
// slug map — so a future generation (gpt-7-*, ...) is picked up automatically
// with no code change, as long as its description text still says
// "frontier" / "workhorse" / "fast and affordable|efficient".
//
// FAIL-OPEN CONTRACT (load-bearing): any failure — missing cache file,
// unparseable JSON, no models array, no visible match for the role — returns
// null. Callers MUST treat null as "omit -m entirely, let the CLI use its own
// configured default model". Never throw. Never fall back to a hardcoded
// slug — that is exactly the failure mode this module removes.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROLE_PATTERNS = {
  frontier: /\bfrontier\b/i,
  workhorse: /\bworkhorse\b/i,
  cheap: /\bfast and (?:affordable|efficient)\b/i,
};

// Aliases so callers can use either the role name or a task-shape synonym.
const ROLE_ALIASES = {
  frontier: 'frontier',
  critic: 'frontier',
  workhorse: 'workhorse',
  implement: 'workhorse',
  cheap: 'cheap',
  fast: 'cheap',
};

function defaultCachePath() {
  return path.join(os.homedir(), '.codex', 'models_cache.json');
}

/**
 * Resolve a role ('frontier' | 'critic' | 'workhorse' | 'implement' | 'cheap'
 * | 'fast') to a live model slug, or null if it cannot be resolved safely.
 *
 * @param {string} role
 * @param {{cachePath?: string}} [opts] - cachePath override, for tests.
 * @returns {string|null}
 */
function resolveCodexModel(role, opts) {
  try {
    const canonicalRole = ROLE_ALIASES[String(role || '').toLowerCase()];
    if (!canonicalRole) return null;
    const pattern = ROLE_PATTERNS[canonicalRole];
    if (!pattern) return null;

    const cachePath = (opts && opts.cachePath) || defaultCachePath();
    if (!fs.existsSync(cachePath)) return null;

    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    const models = Array.isArray(parsed && parsed.models) ? parsed.models : null;
    if (!models || models.length === 0) return null;

    const candidates = models.filter((m) => {
      if (!m || typeof m.slug !== 'string') return false;
      if (m.visibility !== 'list') return false; // never select a hidden/experimental model
      const desc = typeof m.description === 'string' ? m.description : '';
      return pattern.test(desc);
    });
    if (candidates.length === 0) return null;

    // Lower `priority` = newer/preferred generation. Missing priority sorts last.
    candidates.sort((a, b) => {
      const pa = typeof a.priority === 'number' ? a.priority : Infinity;
      const pb = typeof b.priority === 'number' ? b.priority : Infinity;
      return pa - pb;
    });

    // Never hand back a model flagged as retiring (an `upgrade.retirement_at`
    // on the cache entry) when a live, non-retiring alternative exists in the
    // same category. Only fall back to a retiring entry if it's the sole
    // candidate — better a soon-to-retire model than a hard failure.
    const isRetiring = (m) => !!(m && m.upgrade && m.upgrade.retirement_at);
    const live = candidates.filter((m) => !isRetiring(m));
    const pool = live.length > 0 ? live : candidates;

    return pool[0].slug || null;
  } catch {
    return null; // fail-open: never let a resolver error break the caller
  }
}

module.exports = { resolveCodexModel, defaultCachePath };
