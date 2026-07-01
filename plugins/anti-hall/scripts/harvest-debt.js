#!/usr/bin/env node
'use strict';
// anti-hall :: harvest-debt — scan a code tree for deliberate-debt markers.
//
// Marker syntax (comment-syntax-agnostic):
//   // anti-hall: <ceiling>, <when>
//   #  anti-hall: <ceiling>, <when>
//   -- anti-hall: <ceiling>, <when>
//   /* anti-hall: <ceiling>, <when> */
//   <!-- anti-hall: <ceiling>, <when> -->
//
// USAGE
//   node plugins/anti-hall/scripts/harvest-debt.js [--dir <path>] [--stale-days N] [--json]
//
// EXPORT
//   harvestMarkers({ dir, staleDays, now, gitTime }) -> Array<marker>
//   where marker = { file, line, ceiling, when, rotRisk, rotReason }

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_STALE_DAYS = 90;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
const BINARY_CHECK_BYTES = 4096;

// Match any comment leader then optional whitespace then "anti-hall:" then content.
// Leaders: //  #  --  /*  <!--
const MARKER_RE = /(?:\/\/|#|--|\/\*|<!--)\s*anti-hall:\s*(.*?)(?=(?:\/\/|#|--|\/\*|<!--)\s*anti-hall:|$)/g;

function isBinary(buf) {
  const len = Math.min(buf.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function scanFile(filePath) {
  let buf;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return [];
    if (stat.size === 0) return [];
    if (stat.size > MAX_FILE_BYTES) return [];
    buf = fs.readFileSync(filePath);
  } catch (_) {
    return []; // fail-open
  }
  if (isBinary(buf)) return [];

  const lines = buf.toString('utf8').split('\n');
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    MARKER_RE.lastIndex = 0;
    let m;
    while ((m = MARKER_RE.exec(line)) !== null) {
      const raw = m[1].replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
      const commaIdx = raw.indexOf(',');
      let ceiling, when;
      if (commaIdx === -1) {
        ceiling = raw.trim();
        when = null;
      } else {
        ceiling = raw.slice(0, commaIdx).trim();
        when = raw.slice(commaIdx + 1).replace(/\s*(?:\*\/|-->).*$/, '').trim() || null;
      }
      results.push({ lineNum: i + 1, ceiling, when });
    }
  }
  return results;
}

function walkDir(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try { stat = fs.statSync(current); }
    catch (_) { continue; }
    if (stat.isFile()) {
      files.push(current);
      continue;
    }
    if (!stat.isDirectory()) continue;

    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (_) { continue; }
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (e.name.startsWith('.')) continue; // skip dot-dirs/files
      if (e.isDirectory() || e.isFile()) stack.push(path.join(current, e.name));
    }
  }
  return files;
}

function defaultGitTime(file) {
  try {
    const r = spawnSync('git', ['log', '-1', '--format=%ct', '--', file], {
      encoding: 'utf8', timeout: 5000,
    });
    if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
    const epoch = parseInt(r.stdout.trim(), 10);
    return isNaN(epoch) ? null : epoch;
  } catch (_) {
    return null;
  }
}

/**
 * harvestMarkers({ dir, staleDays, now, gitTime })
 *
 * dir       — root to scan (default: cwd)
 * staleDays — staleness threshold in days (default: 90)
 * now       — injectable current time as epoch seconds (default: Date.now()/1000)
 * gitTime   — injectable (absFilePath) => epochSecondsOrNull (default: real git)
 *
 * Returns Array<{ file, line, ceiling, when, rotRisk, rotReason }>
 */
function harvestMarkers({ dir, staleDays, now, gitTime } = {}) {
  const root = path.resolve(dir || process.cwd());
  const days = (staleDays !== undefined && staleDays !== null) ? staleDays : DEFAULT_STALE_DAYS;
  const nowSec = now !== undefined ? now : Math.floor(Date.now() / 1000);
  const getGitTime = gitTime || defaultGitTime;
  const staleThresholdSec = days * 24 * 60 * 60;

  const files = walkDir(root);
  const markers = [];

  for (const absFile of files) {
    const relFile = path.relative(root, absFile);
    const hits = scanFile(absFile);
    if (!hits.length) continue;

    // Fetch git timestamp once per file for all markers in that file
    let fileEpoch = null;
    let gitChecked = false;

    for (const { lineNum, ceiling, when } of hits) {
      let rotRisk = false;
      let rotReason = null;

      if (!when) {
        rotRisk = true;
        rotReason = 'no payback trigger (when is absent)';
      }

      if (!gitChecked) {
        fileEpoch = getGitTime(absFile);
        gitChecked = true;
      }

      if (fileEpoch !== null) {
        const ageSec = nowSec - fileEpoch;
        if (ageSec > staleThresholdSec) {
          const staleMsg = 'file not touched in >' + days + ' days';
          rotRisk = true;
          rotReason = rotReason ? rotReason + '; ' + staleMsg : staleMsg;
        }
      }

      markers.push({ file: relFile, line: lineNum, ceiling, when, rotRisk, rotReason });
    }
  }

  return markers;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  let dir = process.cwd();
  let staleDays = DEFAULT_STALE_DAYS;
  let jsonMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) {
      dir = args[++i];
    } else if (args[i] === '--stale-days' && args[i + 1]) {
      staleDays = Math.max(1, parseInt(args[++i], 10) || DEFAULT_STALE_DAYS);
    } else if (args[i] === '--json') {
      jsonMode = true;
    }
  }

  const markers = harvestMarkers({ dir, staleDays });

  if (jsonMode) {
    const rotRiskCount = markers.filter((m) => m.rotRisk).length;
    const withTrigger = markers.filter((m) => m.when).length;
    process.stdout.write(JSON.stringify({
      markers,
      summary: { total: markers.length, rotRisk: rotRiskCount, withTrigger },
    }, null, 2) + '\n');
  } else {
    if (!markers.length) {
      console.log('No anti-hall debt markers found.');
    } else {
      const W = { file: 40, line: 6, ceil: 20, when: 26 };
      console.log('\nanti-hall debt markers\n');
      console.log(
        'FILE'.padEnd(W.file) + 'LINE'.padEnd(W.line) +
        'CEILING'.padEnd(W.ceil) + 'WHEN'.padEnd(W.when) + 'ROT-RISK'
      );
      console.log('-'.repeat(W.file + W.line + W.ceil + W.when + 30));
      for (const m of markers) {
        const file = m.file.length > W.file - 2
          ? '...' + m.file.slice(-(W.file - 5))
          : m.file;
        const ceil = (m.ceiling || '').slice(0, W.ceil - 2);
        const when = (m.when || '(none)').slice(0, W.when - 2);
        const rot = m.rotRisk ? ('YES: ' + (m.rotReason || '')).slice(0, 40) : '';
        console.log(
          file.padEnd(W.file) + String(m.line).padEnd(W.line) +
          ceil.padEnd(W.ceil) + when.padEnd(W.when) + rot
        );
      }
      const rot = markers.filter((m) => m.rotRisk).length;
      console.log('\nTotal: ' + markers.length + '  Rot-risk: ' + rot + '  With-trigger: ' + markers.filter((m) => m.when).length);
    }
  }
}

module.exports = { harvestMarkers };
