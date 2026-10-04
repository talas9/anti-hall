#!/usr/bin/env node
'use strict';
// injection-profile.js — deterministic profile of what anti-hall injects per event.
//
//   node evals/anti-hall/injection-profile.js --before <plugin-dir> --after <plugin-dir>
//        [--json <out>] [--write-goldens <dir>] [--no-determinism]
//
// <plugin-dir> is a plugin root (the directory holding hooks/, skills/, codex/), e.g. a
// `git archive --prefix=anti-hall/ <sha>:plugins/anti-hall` extraction.
//
// For each checkout it runs an EXPLICIT (event, script) allowlist taken from that
// checkout's hooks.json (args included), with synthetic payloads and a fresh temp HOME per
// scenario and an explicit env allowlist (nothing inherited). Outputs are normalised
// (dates, timestamps, epoch-ms, HOME/cwd/root) before any count or storage; char counts
// are taken with the root expanded to a 64-char representative install path. This is a
// SIZE profile on synthetic payloads x a fixed frequency table, not a behaviour measure.
// Token figures are chars/4 (count_tokens calibration not run).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PAYLOAD_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'cost-trim', 'payloads');
const SID = '00000000-0000-0000-0000-000000000000';

// ---- fixed frequency table (field-study aggregates; never recomputed from private data) ----
const FREQ = {
  E: 1.775,            // SessionStart epochs per main session: 1 + 165/213
  spawns: 58.8,        // subagents per main session: 12,532/213
  subagents: 58.8,
  userPrompts: 190,    // task-tracker sends per session (reported only)
  stopBlocks: 3.0,     // Stop nag blocks per session (reported only)
};
const THRESHOLDS = { claudeMain: 0.60, subagent: 0.55, codexHooks: 0.70 };

// 64-char representative install path (the plugin root every output is expanded to).
const REP_ROOT = '/home/user/.claude/plugins/cache/anti-hall/anti-hall/0.100.0'.padEnd(64, 'x');
if (REP_ROOT.length !== 64) throw new Error('REP_ROOT must be 64 chars');

// ---- normalisation ---------------------------------------------------------------------
function pathForms(p) {
  const out = new Set();
  if (!p) return [];
  out.add(p);
  try { out.add(fs.realpathSync.native(p)); } catch (_) { /* absent */ }
  for (const x of [...out]) {
    if (x.startsWith('/private/var/')) out.add(x.slice('/private'.length));
    else if (x.startsWith('/var/')) out.add('/private' + x);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

// normalise(text, {home, cwd, root}) -> text with paths -> <HOME>/<CWD>/<ROOT>, then
// ISO timestamps -> <TS>, ISO dates -> <DATE>, raw epoch-ms -> <EPOCH>, `cap <digits>` -> `cap <N>`.
function normalise(text, ctx) {
  let t = String(text);
  const subs = [];
  for (const [ph, p] of [['<CWD>', ctx.cwd], ['<ROOT>', ctx.root], ['<HOME>', ctx.home]]) {
    for (const f of pathForms(p)) subs.push([f, ph]);
  }
  subs.sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of subs) t = t.split(from).join(to);
  t = t.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>');
  t = t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<DATE>');
  t = t.replace(/\b1[0-9]{12}\b/g, '<EPOCH>');
  // Dispatch cap is min(16, cores-2): machine-dependent, so freeze it as a placeholder.
  t = t.replace(/\bcap \d+\b/g, 'cap <N>');
  return t;
}
function expandRoot(t) { return t.split('<ROOT>').join(REP_ROOT); }
function charsOf(t) { return expandRoot(t).length; }

// ---- hooks.json command resolution -----------------------------------------------------
function tokenize(cmd) {
  const toks = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) toks.push(m[1] !== undefined ? m[1] : m[2]);
  return toks;
}

// findCommand(hooksJson, event, script) -> command string or null.
function findCommand(hooksJson, event, script) {
  const groups = (hooksJson && hooksJson.hooks && hooksJson.hooks[event]) || [];
  for (const g of groups) {
    for (const h of (g.hooks || [])) {
      const c = h && h.command;
      if (typeof c === 'string' && new RegExp('[\\\\/]' + script.replace(/\./g, '\\.') + '(["\\s]|$)').test(c)) return c;
    }
  }
  return null;
}

function loadHooks(dir, flavour) {
  const p = flavour === 'codex' ? path.join(dir, 'codex', 'hooks', 'hooks.json') : path.join(dir, 'hooks', 'hooks.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

// ---- scenario execution ----------------------------------------------------------------
function readPayload(name, ctx) {
  const raw = fs.readFileSync(path.join(PAYLOAD_DIR, name), 'utf8');
  return raw.split('{{HOME}}').join(ctx.home).split('{{CWD}}').join(ctx.cwd);
}

function scenarioEnv(dir, home, extra) {
  // Explicit allowlist: nothing inherited except PATH.
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    CLAUDE_PLUGIN_ROOT: dir,
    PLUGIN_ROOT: dir,
    ANTIHALL_INGEST_DRY_RUN: '1',
    ANTIHALL_TEST_ISOLATION: '1',
  };
  return Object.assign(env, extra || {});
}

function runCommand(command, dir, payloadText, env, cwd) {
  const argv = tokenize(command.split('${CLAUDE_PLUGIN_ROOT}').join(dir).split('${PLUGIN_ROOT}').join(dir));
  const exe = argv[0] === 'node' ? process.execPath : argv[0];
  const r = spawnSync(exe, argv.slice(1), { input: payloadText, env, cwd, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// extractText(stdout) -> the model-reaching text of a hook's stdout.
function extractText(stdout) {
  const s = stdout.trim();
  if (!s) return '';
  try {
    const j = JSON.parse(s);
    const h = j && j.hookSpecificOutput;
    if (h && typeof h.additionalContext === 'string') return h.additionalContext;
    if (j && typeof j.reason === 'string') return j.reason;
    if (j && typeof j.systemMessage === 'string') return j.systemMessage;
    return '';
  } catch (_) { return s; }
}

function writeTranscript(home, lines) {
  const dir = path.join(home, '.claude', 'projects', '-tmp-p');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, SID + '.jsonl');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

// Synthetic transcript: `n` Edit tool_uses, timestamps at fixed offsets from the real now so
// ages never drift. `tasks` adds TaskCreate tool_uses with their harness result lines.
// (Edit paths are a fixed fake project path: isCountedWork() ignores writes under the tmp dir /
// a scratchpad, so a path under the scenario cwd would make the nag depend on where TMPDIR is.)
function buildTranscript(cwd, opts) {
  const now = Date.now();
  const lines = [];
  let k = 0;
  const ts = () => new Date(now - 600000 + (k++) * 1000).toISOString();
  for (let i = 0; i < opts.edits; i++) {
    lines.push({ type: 'assistant', timestamp: ts(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_e' + i, name: 'Edit', input: { file_path: '/home/user/proj/src/f' + i + '.js', old_string: 'a', new_string: 'b' } },
    ] } });
  }
  for (let i = 0; i < (opts.tasks || 0); i++) {
    lines.push({ type: 'assistant', timestamp: ts(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_t' + i, name: 'TaskCreate', input: { subject: 'task ' + (i + 1), description: 'placeholder', metadata: { priority: 'P1' } } },
    ] } });
    lines.push({ type: 'user', timestamp: ts(), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_t' + i, content: 'Task #' + (i + 1) + ' created successfully: task ' + (i + 1) } ] } });
  }
  return lines;
}

// Scenario table. Each step runs one hook command in the scenario's own temp HOME.
// kind: 'claude' hooks.json or 'codex' hooks.json. `needs` = script that must exist in the
// checkout (else the step is skipped, e.g. orch-on-spawn on a before leg).
const DS_PRIMARY = { DEVSWARM_REPO_ID: 'repo-placeholder' };
const DS_CHILD = { DEVSWARM_REPO_ID: 'repo-placeholder', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'builder-placeholder' };

const SCENARIOS = [
  { id: 'core-claude', channel: 'session', steps: [{ event: 'SessionStart', script: 'verify-first-full.js', payload: 'sessionstart-claude.json' }] },
  { id: 'orch-claude', channel: 'session', steps: [{ event: 'SessionStart', script: 'verify-first-orch.js', payload: 'sessionstart-claude.json' }] },
  { id: 'orch-primary', channel: 'session', env: DS_PRIMARY, steps: [{ event: 'SessionStart', script: 'verify-first-orch.js', payload: 'sessionstart-claude.json' }] },
  { id: 'core-codex', channel: 'codex', flavour: 'codex', steps: [{ event: 'SessionStart', script: 'verify-first-full.js', payload: 'sessionstart-codex.json' }] },
  { id: 'orch-codex', channel: 'codex', flavour: 'codex', steps: [{ event: 'SessionStart', script: 'verify-first-orch.js', payload: 'sessionstart-codex.json' }] },
  { id: 'subagent-normal', channel: 'subagent', steps: [{ event: 'SubagentStart', script: 'verify-first-subagent.js', payload: 'subagentstart.json' }] },
  { id: 'subagent-child', channel: 'subagent', env: DS_CHILD, steps: [{ event: 'SubagentStart', script: 'verify-first-subagent.js', payload: 'subagentstart.json' }] },
  { id: 'task-tracker', channel: 'prompt', steps: [
    { event: 'UserPromptSubmit', script: 'task-tracker.js', payload: 'userpromptsubmit.json', label: 'first-prompt' },
    // consumeBefore: the previous prompt's injected text is recorded in the transcript as a
    // delivered UserPromptSubmit attachment (what the harness does), so emit-dedupe sees it
    // consumed and the second prompt gets the SHORT reminder instead of being suppressed.
    { event: 'UserPromptSubmit', script: 'task-tracker.js', payload: 'userpromptsubmit.json', label: 'second-prompt', consumeBefore: true } ] },
  { id: 'tasklist-guard-nag', channel: 'stop', transcript: { edits: 4, tasks: 0 }, steps: [{ event: 'Stop', script: 'tasklist-guard.js', payload: 'stop.json' }] },
  { id: 'task-guard-nag', channel: 'stop', transcript: { edits: 0, tasks: 2 }, steps: [{ event: 'Stop', script: 'task-guard.js', payload: 'stop.json' }] },
  // Claude default (orchFullOn=auto -> session): ORCH_FULL inline at SessionStart, marker none, spawns silent.
  // This is the sequence the size gate uses. Steps for scripts absent in the checkout are skipped.
  { id: 'seq-claude-default', channel: 'sequence', steps: [
    { event: 'SessionStart', script: 'verify-first-orch.js', payload: 'sessionstart-claude.json', label: 'start', hostArg: true },
    { event: 'PreToolUse', script: 'orch-on-spawn.js', payload: 'pretooluse-agent.json', label: 'spawn-1', optional: true },
    { event: 'PreToolUse', script: 'orch-on-spawn.js', payload: 'pretooluse-agent.json', label: 'spawn-2', optional: true } ] },
  // Claude, EXPERIMENTAL orchFullOn=spawn: SessionStart -> first spawn -> second spawn -> compact -> spawn.
  { id: 'seq-claude-spawn', channel: 'sequence', env: { ANTIHALL_ORCH_FULL_ON: 'spawn' }, steps: [
    { event: 'SessionStart', script: 'verify-first-orch.js', payload: 'sessionstart-claude.json', label: 'start', hostArg: true },
    { event: 'PreToolUse', script: 'orch-on-spawn.js', payload: 'pretooluse-agent.json', label: 'spawn-1', optional: true },
    { event: 'PreToolUse', script: 'orch-on-spawn.js', payload: 'pretooluse-agent.json', label: 'spawn-2', optional: true },
    { event: 'SessionStart', script: 'verify-first-orch.js', payload: 'sessionstart-claude-compact.json', label: 'compact', hostArg: true },
    { event: 'PreToolUse', script: 'orch-on-spawn.js', payload: 'pretooluse-agent.json', label: 'spawn-after-compact', optional: true } ] },
  // Unconfident Claude-shaped session (the --host=claude flag stripped): ORCH_FULL at SessionStart, no marker, nothing on spawn.
  { id: 'seq-unconfident', channel: 'sequence', steps: [
    { event: 'SessionStart', script: 'verify-first-orch.js', payload: 'sessionstart-claude.json', label: 'start', stripHost: true },
    { event: 'PreToolUse', script: 'orch-on-spawn.js', payload: 'pretooluse-agent.json', label: 'spawn-1', optional: true } ] },
  // Codex-shaped: ORCH_FULL at SessionStart, no marker, nothing on a spawn (orch-on-spawn is not registered on Codex).
  { id: 'seq-codex', channel: 'sequence', flavour: 'codex', steps: [
    { event: 'SessionStart', script: 'verify-first-orch.js', payload: 'sessionstart-codex.json', label: 'start' } ] },
];

// The orch-full marker's decision in a scenario HOME ('pending' | 'none' | null when absent).
function readMarkerDecision(home) {
  try {
    const d = path.join(home, '.anti-hall', 'orch-full');
    const f = fs.readdirSync(d).find((n) => /^orch-full-[A-Za-z0-9_-]+\.json$/.test(n) && !/-claim2?\.json$/.test(n));
    return f ? JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')).decision : null;
  } catch (_) { return null; }
}

function runScenario(dir, sc, opts) {
  const base = process.env.TMPDIR || os.tmpdir();
  const home = fs.mkdtempSync(path.join(base, 'antihall-profile-home-'));
  const cwd = fs.mkdtempSync(path.join(base, 'antihall-profile-cwd-'));
  const ctx = { home, cwd, root: dir };
  const hooks = loadHooks(dir, sc.flavour || 'claude');
  const outputs = [];
  try {
    if (sc.transcript) {
      const tp = writeTranscript(home, buildTranscript(cwd, sc.transcript));
      void tp;
    } else {
      writeTranscript(home, []);
    }
    const env = scenarioEnv(dir, home, Object.assign({}, sc.env, opts && opts.env, opts && opts.nowMs ? { ANTIHALL_TEST_NOW_MS: String(opts.nowMs) } : {}));
    let prevRaw = '';
    for (const st of sc.steps) {
      const label = st.label || st.script;
      if (st.consumeBefore && prevRaw) {
        fs.appendFileSync(path.join(home, '.claude', 'projects', '-tmp-p', SID + '.jsonl'), JSON.stringify({
          type: 'attachment', timestamp: new Date().toISOString(),
          attachment: { type: 'hook_additional_context', hookEvent: 'UserPromptSubmit', content: [prevRaw] },
        }) + '\n');
      }
      let command = hooks ? findCommand(hooks, st.event, st.script) : null;
      if (!command) { outputs.push({ label, skipped: true, reason: 'no ' + st.event + ' ' + st.script + ' in hooks.json' }); continue; }
      // hostArg steps use the command exactly as registered (Phase 3 registers --host=claude in the
      // Claude hooks.json only); stripHost removes it to model an unconfident session.
      if (st.stripHost) command = command.replace(/\s--host=\S+/g, '');
      const r = runCommand(command, dir, readPayload(st.payload, ctx), env, cwd);
      const raw = extractText(r.stdout);
      prevRaw = raw;
      const text = normalise(raw, ctx);
      outputs.push({ label, status: r.status, text, chars: charsOf(text), command: normalise(command, ctx), marker: readMarkerDecision(home) });
    }
  } finally {
    for (const d of [home, cwd]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
  }
  return { id: sc.id, channel: sc.channel, outputs };
}

// ---- skill listing (counting rule: unquoted description + when_to_use scalars, summed) ----
function unquote(v) {
  v = v.trim();
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    try { return JSON.parse(v); } catch (_) { return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
  }
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'");
  return v;
}
function frontmatterScalars(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^(description|when_to_use):\s*(.*)$/.exec(line);
    if (k) out[k[1]] = unquote(k[2]);
  }
  return out;
}
function listing(skillsDir) {
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch (_) { return { count: 0, chars: 0, rows }; }
  for (const n of names) {
    let txt;
    try { txt = fs.readFileSync(path.join(skillsDir, n, 'SKILL.md'), 'utf8'); } catch (_) { continue; }
    const f = frontmatterScalars(txt);
    const len = (f.description || '').length + (f.when_to_use || '').length;
    rows.push({ skill: n, chars: len });
  }
  return { count: rows.length, chars: rows.reduce((a, r) => a + r.chars, 0), rows };
}

// ---- profile of one checkout -----------------------------------------------------------
function profileCheckout(dir, opts) {
  const scenarios = {};
  for (const sc of SCENARIOS) scenarios[sc.id] = runScenario(dir, sc, opts);
  return {
    dir,
    scenarios,
    listing: { claude: listing(path.join(dir, 'skills')), codex: listing(path.join(dir, 'codex', 'skills')) },
  };
}

function outChars(p, id, label) {
  const sc = p.scenarios[id];
  if (!sc) return 0;
  const o = label ? sc.outputs.find((x) => x.label === label) : null;
  if (label) return o && !o.skipped ? o.chars : 0;
  return sc.outputs.reduce((a, x) => a + (x.skipped ? 0 : x.chars), 0);
}

function sessionChars(p) { return outChars(p, 'core-claude') + outChars(p, 'orch-claude'); }

// metrics(p) -> the numbers the gate uses.
function metrics(p) {
  const seq = p.scenarios['seq-claude-default'];
  const lbl = (l) => { const o = seq && seq.outputs.find((x) => x.label === l); return o && !o.skipped ? o.chars : 0; };
  // Confident-sequence SessionStart = core + the sequence's own orch output (what Claude sends at start).
  const ss = outChars(p, 'core-claude') + lbl('start');
  const listingChars = p.listing.claude.chars;
  const first = lbl('spawn-1');
  const later = lbl('spawn-2');
  const E = FREQ.E;
  const weightedMain = E * (ss + listingChars + first) + (FREQ.spawns - E) * later;
  const sub = outChars(p, 'subagent-normal');
  const child = outChars(p, 'subagent-child');
  return {
    sessionStartChars: ss,
    listingChars,
    firstSpawnChars: first,
    laterSpawnChars: later,
    mainPerEpochWithSpawn: ss + listingChars + first,
    mainPerEpochNoSpawn: ss + listingChars,
    weightedMain,
    subagentNormal: sub,
    subagentChild: child,
    codexHooks: outChars(p, 'core-codex') + outChars(p, 'orch-codex'),
    orchPrimary: outChars(p, 'core-claude') + outChars(p, 'orch-primary'),
    wholeSession: weightedMain + FREQ.subagents * sub,
    taskTrackerFirst: outChars(p, 'task-tracker', 'first-prompt'),
    taskTrackerLater: outChars(p, 'task-tracker', 'second-prompt'),
    taskTrackerWeightedReported: outChars(p, 'task-tracker', 'first-prompt') + (FREQ.userPrompts - 1) * outChars(p, 'task-tracker', 'second-prompt'),
    tasklistNag: outChars(p, 'tasklist-guard-nag'),
    taskGuardNag: outChars(p, 'task-guard-nag'),
    stopNagsReported: FREQ.stopBlocks * (outChars(p, 'tasklist-guard-nag') + outChars(p, 'task-guard-nag')) / 2,
  };
}

// ---- D3 assertions (pure; evaluated only when the checkout ships orch-on-spawn) ----------
function checkD3(p) {
  const res = [];
  const add = (name, ok, detail) => res.push({ name, ok: !!ok, detail: detail || '' });
  const seq = p.scenarios['seq-claude-spawn'];
  const dflt = p.scenarios['seq-claude-default'];
  const get = (l, sc) => (sc || seq) && (sc || seq).outputs.find((x) => x.label === l);
  const spawn1 = get('spawn-1');
  if (!spawn1 || spawn1.skipped) return { applicable: false, results: res };
  const has = (o, re) => !!o && !o.skipped && re.test(o.text);
  const ORCH_FULL_RE = /ORCHESTRATION DISCIPLINE/;
  const silent = (o) => !o || o.skipped || o.text === '';
  // Default (auto -> session): inline ORCH_FULL next to the compact core, no pending marker, spawns silent.
  add('default: ORCH_FULL inline at SessionStart, marker none', has(get('start', dflt), ORCH_FULL_RE) && get('start', dflt).marker === 'none');
  add('default: nothing on a spawn', silent(get('spawn-1', dflt)) && silent(get('spawn-2', dflt)));
  // Experimental spawn mode.
  add('spawn mode: ORCH_COMPACT at SessionStart (not full)', has(get('start'), /ORCHESTRATION \(main thread/) && !has(get('start'), ORCH_FULL_RE));
  add('spawn mode: marker pending after SessionStart', get('start') && get('start').marker === 'pending');
  add('spawn mode: compact names the spawn delivery', has(get('start'), /sent in full on your first spawn/));
  add('spawn mode: ORCH_FULL exactly once on first spawn', has(spawn1, ORCH_FULL_RE));
  add('spawn mode: none on second spawn', silent(get('spawn-2')));
  add('spawn mode: epoch reset on compact, ORCH_FULL once more', has(get('spawn-after-compact'), ORCH_FULL_RE));
  const uc = p.scenarios['seq-unconfident'];
  const ucs = uc && uc.outputs.find((x) => x.label === 'start');
  const ucp = uc && uc.outputs.find((x) => x.label === 'spawn-1');
  add('unconfident: ORCH_FULL at SessionStart, no marker, nothing on spawn', has(ucs, ORCH_FULL_RE) && ucs.marker === null && silent(ucp));
  const cx = p.scenarios['seq-codex'];
  const cxs = cx && cx.outputs.find((x) => x.label === 'start');
  add('codex-shaped sequence: ORCH_FULL at SessionStart, no marker', has(cxs, ORCH_FULL_RE) && cxs.marker === null);
  const oc = p.scenarios['orch-codex'].outputs[0];
  add('codex-shaped: ORCH_FULL at SessionStart', oc && !oc.skipped && ORCH_FULL_RE.test(oc.text));
  const op = p.scenarios['orch-primary'].outputs[0];
  add('devswarm-primary: ORCH_FULL + W at SessionStart', op && !op.skipped && ORCH_FULL_RE.test(op.text) && /DEVSWARM PRIMARY/.test(op.text));
  const NOW = 7615; // today's verify-first-orch additionalContext chars (plan Evidence)
  add('spawn-delivered ORCH_FULL <= today 7,615 chars + header', spawn1.chars <= NOW + 400, 'chars=' + spawn1.chars);
  return { applicable: true, results: res };
}

function pct(x) { return Math.round(x * 100) + '%'; }

// ---- gate -------------------------------------------------------------------------------
function gate(before, after) {
  const mb = metrics(before), ma = metrics(after);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const ratio = (a, b) => (b ? a / b : NaN);
  const rMain = ratio(ma.weightedMain, mb.weightedMain);
  add('claude main (weighted) <= ' + pct(THRESHOLDS.claudeMain), rMain <= THRESHOLDS.claudeMain, (rMain * 100).toFixed(1) + '%');
  const rSub = ratio(ma.subagentNormal, mb.subagentNormal);
  add('subagent normal <= ' + pct(THRESHOLDS.subagent), rSub <= THRESHOLDS.subagent, (rSub * 100).toFixed(1) + '%');
  const rChild = ratio(ma.subagentChild, mb.subagentChild);
  add('subagent child <= ' + pct(THRESHOLDS.subagent), rChild <= THRESHOLDS.subagent, (rChild * 100).toFixed(1) + '%');
  const rCodex = ratio(ma.codexHooks, mb.codexHooks);
  add('codex SessionStart hooks <= ' + pct(THRESHOLDS.codexHooks), rCodex <= THRESHOLDS.codexHooks, (rCodex * 100).toFixed(1) + '%');
  // No channel increases.
  const chans = [];
  for (const sc of SCENARIOS) {
    if (sc.id.startsWith('seq-')) continue;
    for (const st of sc.steps) {
      const l = st.label || st.script;
      chans.push([sc.id + '/' + l, outChars(before, sc.id, st.label || null) , outChars(after, sc.id, st.label || null)]);
    }
  }
  chans.push(['listing/claude', before.listing.claude.chars, after.listing.claude.chars]);
  chans.push(['listing/codex', before.listing.codex.chars, after.listing.codex.chars]);
  const incr = chans.filter(([, b, a]) => a > b).map(([n, b, a]) => n + ' ' + b + '->' + a);
  add('no channel increases', incr.length === 0, incr.join('; ') || 'none');
  const d3 = checkD3(after);
  if (d3.applicable) for (const r of d3.results) add('D3: ' + r.name, r.ok, r.detail);
  return { mb, ma, ratios: { main: rMain, subagentNormal: rSub, subagentChild: rChild, codexHooks: rCodex, wholeSession: ratio(ma.wholeSession, mb.wholeSession) }, checks, d3Applicable: d3.applicable, pass: checks.every((c) => c.ok) };
}

// ---- determinism + self-checks ----------------------------------------------------------
function flatten(p) {
  const out = {};
  for (const [id, sc] of Object.entries(p.scenarios)) for (const o of sc.outputs) out[id + '/' + o.label] = o.skipped ? '<skipped>' : o.status + '\n' + o.text;
  return out;
}
function diffProfiles(a, b) {
  const fa = flatten(a), fb = flatten(b);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  return [...keys].filter((k) => fa[k] !== fb[k]);
}

function selfChecks(p) {
  const c = [];
  const add = (name, ok, detail) => c.push({ name, ok: !!ok, detail: detail || '' });
  const o = (id, i) => (p.scenarios[id].outputs[i || 0]);
  add('every present scenario step exited 0', Object.values(p.scenarios).every((s) => s.outputs.every((x) => x.skipped || x.status === 0)));
  add('normal session scenarios are not Primary', !/DEVSWARM PRIMARY/.test((o('orch-claude') || {}).text || ''));
  add('normal subagent scenario has no child-workspace note', !/DevSwarm child workspace/.test((o('subagent-normal') || {}).text || ''));
  add('primary scenario is Primary', /DEVSWARM PRIMARY/.test((o('orch-primary') || {}).text || ''));
  add('child scenario is a child workspace', /DevSwarm child workspace/.test((o('subagent-child') || {}).text || ''));
  add('Stop scenarios emit a block reason', ['tasklist-guard-nag', 'task-guard-nag'].every((id) => (o(id) || {}).text && o(id).text.length > 0), 'tasklist=' + ((o('tasklist-guard-nag') || {}).chars || 0) + ' task-guard=' + ((o('task-guard-nag') || {}).chars || 0));
  add('no unnormalised absolute temp path in outputs', Object.values(p.scenarios).every((s) => s.outputs.every((x) => x.skipped || !/\/(?:private\/)?var\/folders|antihall-profile-/.test(x.text))));
  return c;
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// profile(before, after, opts) -> full report.
function profile(beforeDir, afterDir, opts) {
  opts = opts || {};
  const before = profileCheckout(beforeDir, opts);
  const after = afterDir === beforeDir ? before : profileCheckout(afterDir, opts);
  const report = { frequency: FREQ, thresholds: THRESHOLDS, repRootChars: REP_ROOT.length, before, after: afterDir === beforeDir ? before : after };
  report.selfChecks = { before: selfChecks(before), after: selfChecks(after) };
  // before-vs-before identical: the same checkout profiled with itself has ratio 1.0 everywhere.
  const selfGate = gate(before, before);
  report.beforeVsBefore = { identicalRatios: Object.values(selfGate.ratios).every((r) => r === 1 || Number.isNaN(r)) };
  if (opts.determinism !== false) {
    sleepSync(2100);
    const again = profileCheckout(beforeDir, opts);
    const diffs = diffProfiles(before, again);
    report.determinism = { identical: diffs.length === 0, differing: diffs };
  }
  report.gate = gate(before, after);
  return report;
}

// ---- goldens ----------------------------------------------------------------------------
function writeGoldens(p, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [id, sc] of Object.entries(p.scenarios)) {
    if (sc.channel === 'sequence') continue; // D3 sequence is asserted, not frozen
    const body = { scenario: id, outputs: sc.outputs.map((o) => (o.skipped ? { label: o.label, skipped: true } : { label: o.label, status: o.status, text: o.text })) };
    fs.writeFileSync(path.join(outDir, id + '.json'), JSON.stringify(body, null, 2) + '\n');
  }
}

// ---- CLI --------------------------------------------------------------------------------
function main(argv) {
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const before = get('--before'), after = get('--after');
  if (!before || !after) { process.stderr.write('usage: injection-profile.js --before <dir> --after <dir> [--json <out>] [--write-goldens <dir>] [--no-determinism]\n'); return 2; }
  const b = path.resolve(before), a = path.resolve(after);
  const report = profile(b, a, { determinism: !argv.includes('--no-determinism') });
  const goldens = get('--write-goldens');
  if (goldens) writeGoldens(report.before, path.resolve(goldens));
  const jout = get('--json');
  if (jout) { fs.mkdirSync(path.dirname(path.resolve(jout)), { recursive: true }); fs.writeFileSync(jout, JSON.stringify(report, null, 2) + '\n'); }
  const g = report.gate;
  const lines = [];
  lines.push('injection profile (chars; 64-char root; tokens ~ chars/4, count_tokens not run)');
  lines.push('  before: SessionStart ' + g.mb.sessionStartChars + ' + listing ' + g.mb.listingChars + '; subagent ' + g.mb.subagentNormal + ' / child ' + g.mb.subagentChild + '; codex hooks ' + g.mb.codexHooks);
  lines.push('  after : SessionStart ' + g.ma.sessionStartChars + ' + listing ' + g.ma.listingChars + '; subagent ' + g.ma.subagentNormal + ' / child ' + g.ma.subagentChild + '; codex hooks ' + g.ma.codexHooks);
  lines.push('  ratios: main ' + (g.ratios.main * 100).toFixed(1) + '%, subagent ' + (g.ratios.subagentNormal * 100).toFixed(1) + '%, child ' + (g.ratios.subagentChild * 100).toFixed(1) + '%, codex ' + (g.ratios.codexHooks * 100).toFixed(1) + '%, whole session ' + (g.ratios.wholeSession * 100).toFixed(1) + '%');
  lines.push('  per context epoch (hooks + skill listing), default settings: before ' + g.mb.mainPerEpochNoSpawn + ' (spawn or not); after ' + g.ma.mainPerEpochNoSpawn + ' (' + pct(g.ma.mainPerEpochNoSpawn / g.mb.mainPerEpochNoSpawn) + '), spawn or not (spawn delivery is opt-in)');
  for (const c of g.checks) lines.push('  [' + (c.ok ? 'PASS' : 'FAIL') + '] ' + c.name + ' (' + c.detail + ')');
  if (!g.d3Applicable) lines.push('  [n/a ] D3 assertions: checkout has no orch-on-spawn');
  for (const side of ['before', 'after']) for (const c of report.selfChecks[side]) lines.push('  [' + (c.ok ? 'PASS' : 'FAIL') + '] self-check(' + side + '): ' + c.name + (c.detail ? ' (' + c.detail + ')' : ''));
  lines.push('  [' + (report.beforeVsBefore.identicalRatios ? 'PASS' : 'FAIL') + '] before-vs-before identical');
  if (report.determinism) lines.push('  [' + (report.determinism.identical ? 'PASS' : 'FAIL') + '] determinism (two runs >=2 s apart)' + (report.determinism.identical ? '' : ': ' + report.determinism.differing.join(', ')));
  process.stdout.write(lines.join('\n') + '\n');
  const selfOk = [...report.selfChecks.before, ...report.selfChecks.after].every((c) => c.ok) && report.beforeVsBefore.identicalRatios && (!report.determinism || report.determinism.identical);
  return selfOk ? (g.pass ? 0 : 1) : 3;
}

module.exports = { normalise, expandRoot, charsOf, REP_ROOT, FREQ, THRESHOLDS, SCENARIOS, tokenize, findCommand, frontmatterScalars, listing, profileCheckout, metrics, checkD3, gate, profile, diffProfiles, selfChecks, writeGoldens, runScenario, extractText };

if (require.main === module) process.exit(main(process.argv.slice(2)));
