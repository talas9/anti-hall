#!/usr/bin/env node
// anti-hall :: repo-self-drift (SessionStart)
//
// Probe 3 of anti-hall's drift-probe family (see hooks/devswarm-version.js
// for Probe 1, hooks/claude-cli-version.js for Probe 2). Catches anti-hall's
// OWN knowledge about ITSELF going stale — the cheapest, highest-signal probe
// of the three: deterministic, needs no network, no version parsing.
//
// TWO independent checks, each with its own advisory + dedupe:
//
// 1. REPO COUNT DRIFT — docs/KB.md claims specific counts of shipped `.js`
//    hooks and Claude skills (e.g. "Hooks: **49** `.js` files", "Claude
//    skills: **15**"). Those claims are parsed from KB.md's own prose (never
//    hardcoded here — hardcoding the "claimed" side would defeat the whole
//    point) and compared against the ACTUAL count on disk
//    (plugins/anti-hall/hooks/*.js, plugins/anti-hall/skills/*/). Mismatch
//    on EITHER count => one advisory naming claimed vs actual for the count
//    that differs.
//
// 2. MODEL-KB STALENESS — we deliberately do NOT call a network API to check
//    whether the model lineup named in docs/opus-4-8-features.md etc. is
//    current (model facts are not locally discoverable, and a probe that
//    can't verify its claim is worse than none — see
//    hooks/lib/repo-audit-baseline.js's header for the full rationale).
//    Instead we track the DATE those KBs were last audited
//    (MODEL_KB_AUDIT_DATE) and advise when today exceeds that date by more
//    than STALENESS_THRESHOLD_DAYS — a fact we CAN compute without guessing.
//
// Both checks run synchronously (a handful of fs.readdirSync/readFileSync
// calls) — cheap enough that, unlike Probes 1-2, no detached background
// refresh is needed. Still cached + throttled: results are read from
// ~/.anti-hall/repo-self-drift.json when fresh (<24h) rather than re-scanned
// every session.
//
// FAIL-OPEN AND SILENT: docs/KB.md absent/unreadable, the hooks/skills dirs
// absent, an unparseable claim, any thrown error => that check is skipped
// quietly. Never blocks, never a Stop hook, SessionStart only.
//
// Escape hatches:
//   - ANTIHALL_REPO_SELF_DRIFT=off disables the hook.
//   - skip.json { "repo-self-drift": <future-ms> } (or "all") disables it.

'use strict';

const fs = require('fs');
const path = require('path');
const {
  cacheFilePath,
  readCache,
  isFresh,
  alreadyAdvisedKey,
  persistAdvisedKey,
  atomicWriteJSON,
  emitAdvisory,
} = require('./lib/drift-baseline.js');
const { MODEL_KB_AUDIT_DATE, STALENESS_THRESHOLD_DAYS } = require('./lib/repo-audit-baseline.js');

const CACHE_FILE = cacheFilePath('repo-self-drift.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DAY_MS = 24 * 60 * 60 * 1000;

const HOOKS_CLAIM_RE = /Hooks:\s*\*\*(\d+)\*\*\s*`\.js`\s*files/;
const SKILLS_CLAIM_RE = /Claude\s*\n?>?\s*skills:\s*\*\*(\d+)\*\*/;

// findExisting(candidates) -> first path in `candidates` that exists, or null.
// PURE given fsExists (injectable for tests).
function findExisting(candidates, fsExists) {
  const exists = fsExists || fs.existsSync;
  for (const c of candidates) {
    try { if (exists(c)) return c; } catch (_) { /* keep trying */ }
  }
  return null;
}

// resolveKbPath(hooksDir) -> absolute path to docs/KB.md, or null if not
// found. Tries the INSTALLED plugin package layout first (docs/ is a sibling
// of hooks/ — ships that way in the published plugin cache), then the DEV
// REPO layout (docs/ lives at the repo root, three levels above
// plugins/anti-hall/hooks/) as a fallback.
function resolveKbPath(hooksDir, fsExists) {
  const candidates = [
    path.join(hooksDir, '..', 'docs', 'KB.md'),             // installed package layout
    path.join(hooksDir, '..', '..', '..', 'docs', 'KB.md'), // dev repo layout
  ];
  return findExisting(candidates, fsExists);
}

// countJsFiles(dir) -> integer count of *.js files directly in dir, or null
// if dir is unreadable/absent (fail-open — never guess a count).
function countJsFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).length;
  } catch (_) {
    return null;
  }
}

// countSkillDirs(dir) -> integer count of subdirectories directly in dir, or
// null if dir is unreadable/absent.
function countSkillDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch (_) {
    return null;
  }
}

// parseClaims(kbText) -> { claimedHooks, claimedSkills } — either field is
// null when its regex doesn't match (fail-open: never guess a claimed value).
// PURE.
function parseClaims(kbText) {
  const hm = HOOKS_CLAIM_RE.exec(kbText);
  const sm = SKILLS_CLAIM_RE.exec(kbText);
  return {
    claimedHooks: hm ? parseInt(hm[1], 10) : null,
    claimedSkills: sm ? parseInt(sm[1], 10) : null,
  };
}

// daysBetween(isoDateA, isoDateB) -> integer days (b - a), or null if either
// date is unparseable. PURE.
function daysBetween(isoDateA, isoDateB) {
  const a = new Date(isoDateA + 'T00:00:00Z').getTime();
  const b = new Date(isoDateB + 'T00:00:00Z').getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

// scan(hooksDir, now) -> the full computed result object for this run, or
// throws on total unavailability (caller treats as "skip, nothing to report").
function scan(hooksDir) {
  const result = { checkedAt: Date.now() };

  const kbPath = resolveKbPath(hooksDir);
  const actualHooks = countJsFiles(hooksDir);
  const actualSkills = countSkillDirs(path.join(hooksDir, '..', 'skills'));

  if (kbPath) {
    let kbText = null;
    try { kbText = fs.readFileSync(kbPath, 'utf8'); } catch (_) { kbText = null; }
    if (kbText) {
      const { claimedHooks, claimedSkills } = parseClaims(kbText);
      result.claimedHooks = claimedHooks;
      result.actualHooks = actualHooks;
      result.claimedSkills = claimedSkills;
      result.actualSkills = actualSkills;
    }
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const ageDays = daysBetween(MODEL_KB_AUDIT_DATE, todayIso);
  result.modelKbAuditDate = MODEL_KB_AUDIT_DATE;
  result.modelKbAgeDays = ageDays;

  return result;
}

function main() {
  if ((process.env.ANTIHALL_REPO_SELF_DRIFT || '').toLowerCase() === 'off') return;

  try {
    const sg = require('./skip-guard.js');
    if (sg.isSkipped('repo-self-drift')) return;
  } catch (_) { /* skip-guard missing => no-op */ }

  const now = Date.now();

  let cache = null;
  try {
    cache = readCache(CACHE_FILE);
  } catch (_) {
    cache = null;
  }

  if (!isFresh(cache, now, CACHE_TTL_MS)) {
    // Synchronous re-scan (cheap: a couple of readdirSync + one readFileSync)
    // — unlike Probes 1-2, no detached background child is warranted here.
    try {
      cache = scan(__dirname);
      atomicWriteJSON(CACHE_FILE, cache);
    } catch (_) {
      return; // fail-open: scan blew up, nothing to report this session.
    }
  }

  const lines = [];
  const advisedKeys = { lastAdvised: (cache && cache.lastAdvised) || {} };

  // ── Check 1: repo count drift ──────────────────────────────────────────
  const hasCountData = Number.isFinite(cache.claimedHooks) && Number.isFinite(cache.actualHooks)
    && Number.isFinite(cache.claimedSkills) && Number.isFinite(cache.actualSkills);
  let countsKey = null;
  if (hasCountData) {
    const hooksMismatch = cache.claimedHooks !== cache.actualHooks;
    const skillsMismatch = cache.claimedSkills !== cache.actualSkills;
    if (hooksMismatch || skillsMismatch) {
      countsKey = {
        claimedHooks: cache.claimedHooks, actualHooks: cache.actualHooks,
        claimedSkills: cache.claimedSkills, actualSkills: cache.actualSkills,
      };
      if (!alreadyAdvisedKey({ lastAdvised: advisedKeys.lastAdvised.counts }, countsKey)) {
        const parts = [];
        if (hooksMismatch) parts.push(`hooks: KB.md claims ${cache.claimedHooks}, actual ${cache.actualHooks}`);
        if (skillsMismatch) parts.push(`skills: KB.md claims ${cache.claimedSkills}, actual ${cache.actualSkills}`);
        lines.push(`anti-hall repo self-drift — ${parts.join('; ')} (docs/KB.md)`);
      }
    }
  }

  // ── Check 2: model-KB staleness ─────────────────────────────────────────
  let staleKey = null;
  if (Number.isFinite(cache.modelKbAgeDays) && cache.modelKbAgeDays > STALENESS_THRESHOLD_DAYS) {
    staleKey = { modelKbAuditDate: cache.modelKbAuditDate };
    if (!alreadyAdvisedKey({ lastAdvised: advisedKeys.lastAdvised.staleness }, staleKey)) {
      lines.push(
        `anti-hall model KBs last audited ${cache.modelKbAuditDate} ` +
        `(${cache.modelKbAgeDays}d ago, threshold ${STALENESS_THRESHOLD_DAYS}d) — re-verify model lineup/pricing`
      );
    }
  }

  if (lines.length === 0) return;

  emitAdvisory(lines.join('\n'));

  const nextLastAdvised = Object.assign({}, advisedKeys.lastAdvised);
  if (countsKey) nextLastAdvised.counts = countsKey;
  if (staleKey) nextLastAdvised.staleness = staleKey;
  persistAdvisedKey(CACHE_FILE, cache, nextLastAdvised);
}

if (require.main === module) {
  try {
    main();
  } catch (_) {
    // Fail-open: unexpected throw, etc.
  }
  process.exit(0);
}

module.exports = {
  CACHE_FILE,
  findExisting,
  resolveKbPath,
  countJsFiles,
  countSkillDirs,
  parseClaims,
  daysBetween,
  scan,
};
