#!/usr/bin/env node
'use strict';
// anti-hall :: eval/rescore.js — recompute eval summary stats from saved result
// files with ZERO API calls (no network, no judge model).
//
// Distinct from grade.js (re-calls judge LLM) and analyze.js (statistics).
//
// USAGE
//   node eval/rescore.js [results-a.json results-b.json ...]   # reporting
//   node eval/rescore.js --selftest [results.json ...]         # integrity gate
//
// EXPORT
//   rescore(records)      -> summary object
//   selftest(parsedFile)  -> { ok, failures: [] }

const fs = require('fs');
const path = require('path');

const EPSILON = 1e-9;

/**
 * rescore(records).
 * Recomputes the summary object from records[].fabricated + records[].condition.
 * Returns { protocol, baseline, delta_fab_rate, task_level_differences, warnings }
 */
function rescore(records) {
  const warnings = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const p = `record[${i}]`;
    if (!r || typeof r !== 'object') continue;
    if (typeof r.fabricated !== 'boolean') {
      warnings.push(`${p}: fabricated is not boolean (got ${typeof r.fabricated})`);
    }
    if (r.condition !== 'protocol' && r.condition !== 'baseline') {
      warnings.push(`${p}: condition="${r.condition}" not in {protocol,baseline}`);
    }
  }

  const proto = records.filter((r) => r.condition === 'protocol');
  const base  = records.filter((r) => r.condition === 'baseline');

  function stats(recs) {
    const n = recs.length;
    const fabricated = recs.filter((r) => r.fabricated).length;
    const rate = n === 0 ? 0 : fabricated / n;
    return { n, fabricated, rate };
  }

  const protocol = stats(proto);
  const baseline = stats(base);
  const delta_fab_rate = protocol.rate - baseline.rate;

  // task_level_differences: task_ids where protocol verdict !== baseline verdict
  const byTask = {};
  for (const r of records) {
    if (!byTask[r.task_id]) byTask[r.task_id] = { protocol: [], baseline: [] };
    if (r.condition === 'protocol' || r.condition === 'baseline') {
      byTask[r.task_id][r.condition].push(r.fabricated);
    }
  }
  const task_level_differences = [];
  for (const [task_id, sides] of Object.entries(byTask)) {
    const pFab = sides.protocol.some(Boolean);
    const bFab = sides.baseline.some(Boolean);
    if (pFab !== bFab) task_level_differences.push(task_id);
  }

  return { protocol, baseline, delta_fab_rate, task_level_differences, warnings };
}

function warnRescoreDiagnostics(file, warnings) {
  for (const warning of warnings) {
    console.error('WARN ' + file + ': ' + warning);
  }
}

function duplicateTaskConditionWarnings(fileRecords) {
  const byPair = {};
  for (const { file, records } of fileRecords) {
    const seenInFile = new Set();
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.task_id === 'undefined' || typeof r.condition === 'undefined') continue;
      const key = String(r.task_id) + '\u0000' + String(r.condition);
      if (seenInFile.has(key)) continue;
      seenInFile.add(key);
      if (!byPair[key]) byPair[key] = { task_id: r.task_id, condition: r.condition, files: [] };
      byPair[key].files.push(file);
    }
  }

  return Object.values(byPair)
    .filter((entry) => entry.files.length > 1)
    .map((entry) => (
      'duplicate task_id+condition ' +
      JSON.stringify(String(entry.task_id) + '+' + String(entry.condition)) +
      ' found in ' +
      entry.files.join(', ')
    ));
}

/**
 * selftest(parsedFile) — integrity/reproducibility gate.
 * parsedFile: { summary, records }
 * Returns { ok: bool, failures: string[] }
 */
function selftest(parsedFile) {
  const failures = [];
  const { summary, records } = parsedFile;

  if (!Array.isArray(records)) {
    return { ok: false, failures: ['records is not an array'] };
  }

  // (a) schema validation: every record must have required keys and valid types
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const p = `record[${i}]`;
    if (!r || typeof r !== 'object') { failures.push(`${p}: not an object`); continue; }
    if (typeof r.task_id === 'undefined')    failures.push(`${p}: missing task_id`);
    if (typeof r.condition === 'undefined')  failures.push(`${p}: missing condition`);
    if (typeof r.fabricated === 'undefined') failures.push(`${p}: missing fabricated`);
    if (typeof r.fabricated !== 'boolean')   failures.push(`${p}: fabricated is not boolean (got ${typeof r.fabricated})`);
    if (r.condition !== 'protocol' && r.condition !== 'baseline') {
      failures.push(`${p}: condition="${r.condition}" not in {protocol,baseline}`);
    }
  }

  if (failures.length) return { ok: false, failures };

  // (b) recomputed summary must match stored summary within float epsilon
  if (!summary) {
    failures.push('missing summary block');
    return { ok: false, failures };
  }

  const computed = rescore(records);

  for (const cond of ['protocol', 'baseline']) {
    if (!summary[cond]) { failures.push(`summary.${cond} missing`); continue; }
    const s = summary[cond];
    const c = computed[cond];
    if (s.n !== c.n) {
      failures.push(`summary.${cond}.n: stored=${s.n} computed=${c.n}`);
    }
    if (s.fabricated !== c.fabricated) {
      failures.push(`summary.${cond}.fabricated: stored=${s.fabricated} computed=${c.fabricated}`);
    }
    if (Math.abs((s.rate || 0) - c.rate) > EPSILON) {
      failures.push(`summary.${cond}.rate: stored=${s.rate} computed=${c.rate}`);
    }
  }

  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const selftestMode = args.includes('--selftest');
  const inputFiles = args.filter((a) => !a.startsWith('--'));
  const files = inputFiles.length ? inputFiles : [path.join(__dirname, 'results.json')];

  if (selftestMode) {
    let allOk = true;
    for (const f of files) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (e) {
        console.error('FAIL ' + f + ': cannot read/parse: ' + (e && e.message));
        allOk = false;
        continue;
      }
      const result = selftest(parsed);
      if (result.ok) {
        console.log('OK ' + f);
      } else {
        console.error('FAIL ' + f + ':');
        for (const msg of result.failures) console.error('  - ' + msg);
        allOk = false;
      }
    }
    process.exit(allOk ? 0 : 1);
  }

  // Reporting mode — always exits 0
  const allRecords = [];
  const fileRecords = [];
  for (const f of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      console.error('skip (unreadable): ' + f + ' :: ' + (e && e.message));
      continue;
    }
    const records = Array.isArray(parsed) ? parsed : (parsed.records || []);
    const stored  = (!Array.isArray(parsed) && parsed.summary) || {};
    const computed = rescore(records);
    warnRescoreDiagnostics(f, computed.warnings);
    fileRecords.push({ file: f, records });

    console.log('\n=== ' + path.basename(f) + ' ===');
    console.log('model       : ' + (stored.model      || '(unknown)'));
    console.log('judge_model : ' + (stored.judge_model || '(unknown)'));
    console.log('tasks       : ' + (stored.tasks      != null ? stored.tasks   : '?'));
    console.log('repeats     : ' + (stored.repeats    != null ? stored.repeats : '?'));
    console.log('errors      : ' + (stored.errors     != null ? stored.errors  : '?'));
    console.log('protocol    : n=' + computed.protocol.n +
      '  fabricated=' + computed.protocol.fabricated +
      '  rate='       + computed.protocol.rate.toFixed(4));
    console.log('baseline    : n=' + computed.baseline.n +
      '  fabricated=' + computed.baseline.fabricated +
      '  rate='       + computed.baseline.rate.toFixed(4));
    console.log('delta_fab   : ' + computed.delta_fab_rate.toFixed(4));
    const diffs = computed.task_level_differences;
    console.log('task_diffs  : ' + (diffs.length ? diffs.join(', ') : '(none)'));

    for (const r of records) allRecords.push(r);
  }

  if (files.length > 1 && allRecords.length) {
    warnRescoreDiagnostics('aggregate', duplicateTaskConditionWarnings(fileRecords));
    const agg = rescore(allRecords);
    console.log('\n=== AGGREGATE (' + files.length + ' files, ' + allRecords.length + ' records) ===');
    console.log('protocol    : n=' + agg.protocol.n +
      '  fabricated=' + agg.protocol.fabricated +
      '  rate='       + agg.protocol.rate.toFixed(4));
    console.log('baseline    : n=' + agg.baseline.n +
      '  fabricated=' + agg.baseline.fabricated +
      '  rate='       + agg.baseline.rate.toFixed(4));
    console.log('delta_fab   : ' + agg.delta_fab_rate.toFixed(4));
  }
}

module.exports = { rescore, selftest };
