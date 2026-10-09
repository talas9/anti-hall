#!/usr/bin/env node
'use strict';
// B3 seed builder (docs/BENCHMARK-METHOD.md Amendment 3 §B3). A seed = a scripted
// 40-60 turn conversation (no plugin) + ONE real compaction + frozen artefacts with
// sha256 in a manifest. Pure Node; all model/process work goes through an injected
// runner, so `--dry-run` and the unit tests spend nothing.
//
//   node evals/anti-hall/seeds/make-seed.js --spec seed.json --out dir --dry-run
//
// spec: { id, turns: ["user turn", ...], quiz: {facts:[...]}, workspace: <dir with the scaffolded repo>,
//         date?: "YYYY-MM-DD" }
// Steps: play turns (runConversation) -> snapshot workspace -> forceCompaction (P5 ladder)
//        -> re-check workspace consistency -> write frozen history + manifest.
// Plugin artefacts for the with arm (placed by placeSeedFiles, never by the model at run time):
//        HANDOVER.md from one resumed turn "/anti-hall:handover" on the UNCOMPACTED seed (plugin loaded),
//        PRECOMPACT-1.md from running hooks/precompact-snapshot.js offline on the pre-compaction transcript.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { runConversation } = require('../lib/multiturn.js');
const { forceCompaction } = require('../lib/compaction.js');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (f) => sha256(fs.readFileSync(f));

function workspaceSnapshot(dir, env) {
  const git = (args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env }); return r.status === 0 ? r.stdout : ''; };
  const ls = fs.readdirSync(dir).filter((n) => n !== '.git').sort();
  return { status: git(['status', '--porcelain']), head: git(['log', '-1', '--format=%H %s']).trim(), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), ls };
}

function workspaceConsistent(a, b) {
  const diffs = [];
  for (const k of ['status', 'head', 'branch']) if (a[k] !== b[k]) diffs.push(k);
  if (JSON.stringify(a.ls) !== JSON.stringify(b.ls)) diffs.push('ls');
  return { ok: diffs.length === 0, diffs };
}

// Offline PRECOMPACT snapshot: deterministic, no model. HOME is always isolated by the caller.
function runPrecompactSnapshot({ pluginDir, home, cwd, sessionId, transcriptPath }) {
  const hook = path.join(pluginDir, 'hooks', 'precompact-snapshot.js');
  const r = spawnSync(process.execPath, [hook], {
    cwd, encoding: 'utf8', timeout: 20000,
    input: JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, cwd, hook_event_name: 'PreCompact', trigger: 'manual' }),
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ANTIHALL_INGEST_DRY_RUN: '1', TMPDIR: process.env.TMPDIR || '/tmp' },
  });
  return r.status;
}

// Scaffold step (P6): artefacts under <cwd>/.anti-hall/handovers/<date>/<sid>/ with mtime touched to now.
function placeSeedFiles({ cwd, date, sessionId, files }) {
  const dir = path.join(cwd, '.anti-hall', 'handovers', date, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const placed = [];
  for (const [name, content] of Object.entries(files)) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, content);
    fs.utimesSync(f, now, now);
    placed.push(f);
  }
  return placed;
}

function buildSeed({ spec, outDir, runner, workspace, home, model = 'claude-sonnet-5', cap, transcriptPathFor, dryRun = false }) {
  if (dryRun) {
    return { dryRun: true, id: spec.id, turns: spec.turns.length, steps: ['play turns (no plugin)', 'snapshot workspace', 'forceCompaction: slash -> autocompact -> tmux', 'workspace consistency check', 'freeze history + sha256 manifest'] };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const convo = runConversation({ runner, prompt: spec.turns[0], followUps: spec.turns.slice(1), model, cwd: workspace, cap, perStepUsd: 1 });
  if (!convo.complete) throw new Error(`seed ${spec.id}: script did not complete (${convo.stopped})`);
  const transcriptPath = transcriptPathFor(convo.sessionId);
  const pre = workspaceSnapshot(workspace);
  const preTranscript = path.join(outDir, `${spec.id}.pre-compact.jsonl`);
  fs.copyFileSync(transcriptPath, preTranscript);
  const comp = forceCompaction({ runner, sessionId: convo.sessionId, cwd: workspace, transcriptPath, model });
  const post = workspaceSnapshot(workspace);
  const consistency = workspaceConsistent(pre, post);
  const frozen = path.join(outDir, `${spec.id}.compacted.jsonl`);
  fs.copyFileSync(transcriptPath, frozen);
  const manifest = {
    id: spec.id, sessionId: convo.sessionId, turns: spec.turns.length, compactionMethod: comp.method, tried: comp.tried,
    workspaceConsistent: consistency, costUsd: convo.totalCostUsd,
    sha256: { preCompact: sha256File(preTranscript), compacted: sha256File(frozen), quiz: sha256(JSON.stringify(spec.quiz)) },
  };
  fs.writeFileSync(path.join(outDir, `${spec.id}.seed.json`), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spec') opt.spec = argv[++i]; else if (a === '--out') opt.out = argv[++i];
    else if (a === '--dry-run') opt.dry = true; else throw new Error(`unknown option ${a}`);
  }
  if (!opt.spec || !opt.out) throw new Error('--spec and --out are required');
  if (!opt.dry) throw new Error('live seed building spends money and needs owner budget approval (run it from a reviewed driver, not this CLI); use --dry-run');
  const spec = JSON.parse(fs.readFileSync(opt.spec, 'utf8'));
  process.stdout.write(JSON.stringify(buildSeed({ spec, outDir: opt.out, dryRun: true }), null, 2) + '\n');
}

if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.error(`make-seed.js: ${e.message}`); process.exit(1); } }
module.exports = { buildSeed, workspaceSnapshot, workspaceConsistent, runPrecompactSnapshot, placeSeedFiles, sha256 };
