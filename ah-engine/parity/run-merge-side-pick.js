#!/usr/bin/env node
// Parity of the built-in `merge-side-pick` check against hooks/merge-side-pick.js (PreToolUse + PostToolUse).
//   node run-merge-side-pick.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--cmds fpr/cmds.jsonl] [--mode oneshot|daemon|both] [--conc 8] [--show 15] [--real 6000] [--seed 1]
// Corpus: (1) the guard's own test cases and settings/skip variants, (2) windows of real sessions from the field
// data (every command as a Pre then a Post step, in order), (3) real pushes preceded by an injected side-pick (so the
// advisory path is exercised on real text), (4) fuzzed commands (quotes, odd white space, long and astral text).
const { arg, runParity, readCmds, bash, rng } = require('./guardlib.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
let n = 0;
const sid = () => `p${n++}`;
const pairs = (s, c) => [{ payload: bash('PreToolUse', s, c) }, { payload: bash('PostToolUse', s, c) }];
const add = (steps, ctx, id) => { scenarios.push({ id: id || `s${scenarios.length}`, ctx, steps }); };

const PICKS = ['git checkout --theirs .', 'git checkout --ours src/a.js', 'git restore --theirs f', 'git merge -X ours main', 'git merge -Xtheirs origin/main',
  'git pull --strategy-option=theirs', 'git rebase -X theirs main', 'git merge -s ours dev', 'git -C repo checkout --theirs -- a', 'git -c core.x=1 merge --strategy=ours x',
  'git --no-pager checkout --ours f', 'git cherry-pick -X ours abc', 'git revert -X theirs HEAD'];
const NOPICKS = ['git checkout main', 'git merge main', 'git commit -m "used git checkout --theirs"', 'echo "git merge -X ours"', 'git log --oneline', 'git rebase -X patience main',
  "git commit -m 'git merge -X ours'", 'git checkout -- --ours', 'git pull -s recursive', 'git merge --strategy=recursive x'];
const TESTS = ['npm test', 'npm run test:unit', 'pnpm test', 'node --test', 'node --test tests/', 'pytest -q', 'python3 -m pytest', 'go test ./...', 'cargo test', 'cargo nextest run',
  'flutter test', 'make test', './gradlew test', 'npx vitest run', 'yarn t', 'bun run test', 'dotnet test', 'bundle exec rake test', 'mvn -q verify', 'just check', 'deno test', 'tox', 'ctest'];
const NOTESTS = ['npm install', 'git status', 'echo "npm test"', 'cat tests.md', 'npm run build', 'npm testing', 'cargo testing', 'make tests-all'];
const PUSHES = ['git push', 'git push origin dev', 'git push --force-with-lease origin x', 'git -C x push', 'git push --dry-run', 'git push -n', 'git push origin HEAD && echo done', 'git pusher'];

// (1) unit scenarios
for (const p of PICKS) for (const q of [PUSHES[0], PUSHES[1]]) { const s = sid(); add([...pairs(s, p), ...pairs(s, q)], undefined, `unit-pick-${p}`); }
for (const p of NOPICKS) { const s = sid(); add([...pairs(s, p), ...pairs(s, 'git push')], undefined, `unit-nopick-${p}`); }
for (const t of TESTS) { const s = sid(); add([...pairs(s, 'git checkout --theirs .'), ...pairs(s, t), ...pairs(s, 'git push')], undefined, `unit-test-${t}`); }
for (const t of NOTESTS) { const s = sid(); add([...pairs(s, 'git checkout --theirs .'), ...pairs(s, t), ...pairs(s, 'git push')], undefined, `unit-notest-${t}`); }
for (const q of PUSHES) { const s = sid(); add([...pairs(s, 'git merge -X ours main'), ...pairs(s, q)], undefined, `unit-push-${q}`); }
for (const c of [
  'git checkout --theirs . && git commit -am x && git push', 'git checkout --theirs . && npm test && git push', 'git push && git checkout --ours . ; git push',
  'git checkout --theirs .\ngit push', 'git checkout --theirs . | git push', 'git checkout --theirs . & git push', 'npm test; git checkout --theirs .; git push',
  'git checkout --theirs .  \t  &&   git   push', "git checkout --theirs . && git commit -m 'a; git push' && echo x", 'git checkout --theirs . && git commit -m "x" && git push origin "main"',
  'git checkout --theirs .; git push --dry-run; git push', 'git checkout --theirs .\r\ngit push', 'git checkout --theirs . git push', 'git　checkout --theirs .;git push',
  'git\u0085checkout --theirs .;git push', 'git﻿checkout --theirs .;git push', 'git checkout --theirs .; git push',
  'git checkout --ours x ' + 'a'.repeat(200) + ' ; git push', 'git checkout --ours x ' + '\u{1F600}'.repeat(70) + ' ; git push', 'git checkout --ours ' + '\u{1F600}'.repeat(59) + 'ab ; git push',
  'git checkout --ours a' + '\u{1F600}'.repeat(70) + ' ; git push', 'git checkout --ours ' + 'é'.repeat(105) + ' ; git push', 'git checkout --ours "' + 'q'.repeat(200) + '" f ; git push',
]) { const s = sid(); add([...pairs(s, c), ...pairs(s, 'git push')], undefined, `unit-compound-${c.slice(0, 40)}`); const s2 = sid(); add([{ payload: bash('PreToolUse', s2, c) }], undefined, `unit-compound-pre-${c.slice(0, 30)}`); }
// payload shapes
for (const [id, pl] of [
  ['no-tool', { hook_event_name: 'PreToolUse', session_id: 'x1', tool_input: { command: 'git push' } }],
  ['other-tool', { hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 'x2', tool_input: { command: 'git push' } }],
  ['no-cmd', { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'x3', tool_input: {} }],
  ['empty-cmd', { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'x4', tool_input: { command: '' } }],
  ['cmd-number', { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'x5', tool_input: { command: 5 } }],
  ['no-sid', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } }],
  ['blank-sid', { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: '   ', tool_input: { command: 'git push' } }],
  ['sid-number', { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 5, tool_input: { command: 'git push' } }],
  ['no-event', { tool_name: 'Bash', session_id: 'x6', tool_input: { command: 'git push' } }],
  ['stop-event', { hook_event_name: 'Stop', tool_name: 'Bash', session_id: 'x7', tool_input: { command: 'git push' } }],
  ['codex', { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'x8', turn_id: 't', model: 'gpt-5.5', tool_input: { command: 'git push' } }],
]) add([{ payload: pl }], undefined, `shape-${id}`);
// sessions: padded, unicode, long and colliding ids share or separate state exactly as Node's file names do
for (const [a, b] of [[' pad ', 'pad'], ['a/b', 'a_b'], ['a b', 'a?b'], ['és', '__s'], ['\u{1F600}', '__'], ['x'.repeat(130) + 'A', 'x'.repeat(130) + 'B'], ['ID.1-2_3', 'ID.1-2_3']]) {
  add([...pairs(a, 'git checkout --theirs .'), ...pairs(b, 'git push'), ...pairs(a, 'git push')], undefined, `sid-${JSON.stringify(a).slice(0, 20)}`);
}
// switches and skip, each its own ctx (its own home and daemon)
const flow = s => [...pairs(s, 'git checkout --theirs .'), ...pairs(s, 'git push')];
const ctxs = {
  off: { settings: { guards: { mergeSidePickAdvisory: false } } }, offStr: { settings: { guards: { mergeSidePickAdvisory: 'off' } } },
  offNum: { settings: { guards: { mergeSidePickAdvisory: 0 } } }, onStr: { settings: { guards: { mergeSidePickAdvisory: 'yes' } } }, junk: { settings: { guards: { mergeSidePickAdvisory: 'maybe' } } },
  badjson: { settings: '{not json' }, arr: { settings: '[1,2]' }, section: { settings: { guards: 5 } },
  env0: { env: { ANTIHALL_MERGE_SIDE_PICK_ADVISORY: '0' } }, envOff: { env: { ANTIHALL_MERGE_SIDE_PICK_ADVISORY: ' OFF ' } }, env1: { env: { ANTIHALL_MERGE_SIDE_PICK_ADVISORY: '1' }, settings: { guards: { mergeSidePickAdvisory: false } } },
  envJunk: { env: { ANTIHALL_MERGE_SIDE_PICK_ADVISORY: 'zzz' }, settings: { guards: { mergeSidePickAdvisory: false } } },
  skip: { skip: { 'merge-side-pick': Date.now() + 3600e3 } }, skipAll: { skip: { all: Date.now() + 3600e3 } }, skipExpired: { skip: { 'merge-side-pick': Date.now() - 1000, all: Date.now() - 1000 } },
  skipJunk: { skip: '{no' }, skipEmpty: { skip: '   ' }, skipArr: { skip: '[1]' }, skipStr: { skip: { 'merge-side-pick': 'x', all: '9999999999999' } },
};
for (const [k, c] of Object.entries(ctxs)) add(flow(sid()), c, `ctx-${k}`);
// a settings-off session records nothing; turning it on later is another ctx, so only check the quiet path here

// (2) real sessions
const cmds = readCmds(arg('--cmds', '../../fpr/cmds.jsonl'));
const REL = /\b(?:ours|theirs|push|test|tests|pytest|jest|vitest|mocha|nextest|rake|ctest|tox|nox|rspec|phpunit|verify|just|make|gradle|gradlew|mvn|mvnw|bun)\b/;
const bySession = new Map();
for (const c of cmds) { if (!bySession.has(c.session)) bySession.set(c.session, []); bySession.get(c.session).push(c); }
const wantReal = +arg('--real', 6000);
let realSteps = 0;
for (const [, list] of bySession) {
  if (realSteps >= wantReal) break;
  const idx = list.findIndex(c => REL.test(c.cmd));
  if (idx < 0) continue;
  const win = list.slice(Math.max(0, idx - 3), idx + 25);
  const s = sid();
  const steps = [];
  for (const c of win) steps.push(...pairs(s, c.cmd));
  realSteps += win.length;
  add(steps, undefined, `real-${win[0].session}`);
}
// (3) real pushes with an injected side-pick, optionally a real test run in between
const pushes = cmds.filter(c => /\bgit\b[^\n]*\bpush\b/.test(c.cmd)), tests = cmds.filter(c => /\btest\b/.test(c.cmd));
let injected = 0;
for (const c of pushes) {
  if (injected >= 1500) break;
  const s = sid();
  const steps = [...pairs(s, pick(PICKS))];
  if (R() < 0.3 && tests.length) steps.push(...pairs(s, pick(tests).cmd));
  steps.push(...pairs(s, c.cmd));
  add(steps, undefined, `inject-${injected}`);
  injected++;
}
// (4) fuzz: take real or synthetic commands and damage them
const WS = [' ', '\t', '\n', '\r', ' ', ' ', ' ', '　', '﻿', '\u0085', '​', '᠎', ';', '&', '|', '&&', '||'];
function mutate(c) {
  const parts = c.split(' ');
  const k = Math.floor(R() * 6);
  if (k === 0) return parts.join(pick(WS));
  if (k === 1) return parts.map(p => (R() < 0.2 ? `"${p}"` : R() < 0.15 ? `'${p}'` : p)).join(' ');
  if (k === 2) return c + pick(WS) + pick([...PUSHES, ...TESTS, ...PICKS]);
  if (k === 3) return pick([...PICKS, ...TESTS]) + pick(WS) + c;
  if (k === 4) return c.replace(/ /g, () => pick(WS));
  return c + ' ' + pick(['\u{1F600}', 'é', 'x'.repeat(60), '\\', '"', "'"]).repeat(1 + Math.floor(R() * 40));
}
const seeds = [...PICKS, ...TESTS, ...PUSHES, ...NOPICKS, ...NOTESTS, ...pushes.slice(0, 300).map(c => c.cmd)];
for (let i = 0; i < 2500; i++) {
  const s = sid();
  add([...pairs(s, mutate(pick(PICKS))), ...pairs(s, mutate(pick(seeds))), ...pairs(s, mutate(pick(PUSHES)))], undefined, `fuzz-${i}`);
}
console.error(`scenarios=${scenarios.length} real-window-commands=${realSteps} injected=${injected}`);
runParity({ name: 'merge-side-pick', check: 'merge-side-pick', hookFile: 'merge-side-pick.js', scenarios, engine: ENGINE, hooks: HOOKS, mode: arg('--mode', 'both'), conc: +arg('--conc', 8), show: +arg('--show', 15), nodeArgv: s => (s.payload.hook_event_name === 'PostToolUse' ? ['--post'] : []) });
