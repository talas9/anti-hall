#!/usr/bin/env node
// Parity of the built-in `scan-throttle` check against hooks/scan-throttle.js (PreToolUse on Bash; advisory only).
//   node run-scan-throttle.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--cmds fpr/cmds.jsonl] [--mode oneshot|daemon|both] [--real 6000] [--seed 1]
// The guard matches nothing unless ANTI_HALL_THROTTLE_PATTERNS is set, so every pattern set is its own ctx (its own
// environment and daemon). Corpus: (1) hand-written command shapes (assignments, subshells, groups, heredocs, quotes,
// already-prefixed forms) under several pattern sets, (2) real commands from the field data under pattern sets taken
// from words real commands use (so every advisory form fires on real text), (3) patterns the engine does not match
// itself (it must defer, never guess) and malformed ones, (4) switch and PATH variants, (5) fuzzed commands.
const { arg, runParity, readCmds, rng } = require('./guardlib.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
const bash = (command, extra) => Object.assign({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's', cwd: '/tmp', tool_input: { command } }, extra || {});
const add = (payload, ctx, id) => scenarios.push({ id: id || `s${scenarios.length}`, ctx, steps: [{ payload }] });
const PAT = v => ({ env: { ANTI_HALL_THROTTLE_PATTERNS: v } });
const ctxOf = new Map();
const ctx = v => { if (!ctxOf.has(v)) ctxOf.set(v, PAT(v)); return ctxOf.get(v); };

// ---- (1) hand-written ----------------------------------------------------------------------------------------
const SHAPES = [
  'reindex-repo --full', 'SCANENV=1 reindex-repo --full', 'A=1 B="x y" C=\'z\' reindex-repo', 'FOO=1 cd app && reindex-repo --full', '( reindex-repo --full )', '{ reindex-repo; }', 'cd x && reindex-repo --full',
  'echo hi | reindex-repo', 'reindex-repo --full; echo done', 'reindex-repo & wait', 'taskpolicy -c utility nice -n 19 reindex-repo --full', 'nice -n 19 reindex-repo', 'ionice -c 3 nice -n 19 reindex-repo',
  '  nice -n 19 reindex-repo', 'X=1 nice -n 19 reindex-repo', 'echo "reindex-repo"', "echo 'reindex-repo --full'", 'cat <<EOF\nreindex-repo --full\nEOF', 'cat <<EOF && reindex-repo --full\nbody\nEOF',
  'bash <<EOF\nreindex-repo\nEOF', 'echo $(reindex-repo --full)', 'echo `reindex-repo`', 'x=$(reindex-repo)', 'A=1\nreindex-repo', 'A=1 \t reindex-repo --full', 'A=1', 'A=1 ', 'A="unclosed reindex-repo',
  'reindex-repo', '', '   ', '\n', 'reindex-repo --full', ' reindex-repo', 'A=1 reindex-repo', 'A=1　reindex-repo', 'echo $((1<<2)); reindex-repo', 'cat <<-EOF\n\treindex-repo\n\tEOF\nreindex-repo',
  'git reindex-repo', 'reindex-repo-extra', 'REINDEX-REPO', 'cd x; cd y; reindex-repo', 'x && y || reindex-repo', 'a;;b reindex-repo', 'a "b;c" reindex-repo', 'a \'b|c\' reindex-repo', 'a \\; reindex-repo',
  'cmd "esc \\" reindex-repo"', 'cmd <<<"reindex-repo"', 'cat << EOF\nx\nEOF\nreindex-repo --full', "cat <<'EOF'\nreindex-repo\nEOF", 'echo \u{1F600} reindex-repo', 'reindex-repo \u{1F600}', 'A=é reindex-repo',
];
const PATTERN_SETS = ['reindex-repo', 'reindex-repo,graphify update', ' reindex-repo , ', 'reindex[- ]repo', '^reindex', 'repo$', 'reindex.*full', 'a|reindex-repo', '(?:reindex)-repo', '\\breindex-repo\\b', '(reindex-repo)+', 'reindex-repo?', 'reind\\w+-\\w+', '\\s*reindex', '[a-z]+-repo', 'EOF', 'x'];
for (const ps of PATTERN_SETS) for (const c of SHAPES) add(bash(c), ctx(ps), `shape-${ps}-${c.slice(0, 30)}`);
// payload shapes
for (const [id, p] of [['no-tool', { hook_event_name: 'PreToolUse', session_id: 's', tool_input: { command: 'reindex-repo' } }], ['edit', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { command: 'reindex-repo' } }],
  ['no-input', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }], ['null-input', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: null }], ['num-cmd', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 7 } }],
  ['array-cmd', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: ['reindex-repo'] } }]]) add(p, ctx('reindex-repo'), `payload-${id}`);

// ---- (3) patterns the engine must defer on, or both sides reject --------------------------------------------
const ODD = ['(?=reindex)', '(?<=a)repo', 'reindex{1,2}', 're(?<n>i)ndex', '(a)\\1', '\\u0072eindex', '\\p{L}+', 'é', '\u{1F600}+', 'reindex(', 'reindex)', '[', 'reindex[', 'a**', '*a', '+a', '^*', '$*', '\\b*', '[]', '[^]', '[a-]', '[-a]', '[z-a]', '[\\w-.]', '[a&&b]', '[a--b]',
  '\\', '\\x72eindex', '\\0', 'reindex}', 'reindex]', '(?i)reindex', '(?:', '(|reindex)', '()', 'reindex|', '|reindex', '\\d+', '\\W', '\\D', 'a{', 'a{,2}', '(?:reindex)*?', 'repo??', 'repo???', '.', '.*', '', ',', ' ,\t', '\\n', 'x\\ty'];
for (const ps of ODD) for (const c of ['reindex-repo --full', 'echo x', 'A=1 reindex-repo', 'cd a && reindex-repo', 'a1 b', 'repo']) add(bash(c), ctx(ps), `odd-${ps}-${c.slice(0, 20)}`);

// ---- (4) switches and PATH -------------------------------------------------------------------------------
const base = 'reindex-repo --full';
const sw = {
  off: { env: { ANTIHALL_SCAN_THROTTLE: '0', ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } }, offAlias: { env: { ANTI_HALL_SCAN_THROTTLE: '0', ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } },
  offBoth: { env: { ANTIHALL_SCAN_THROTTLE: '1', ANTI_HALL_SCAN_THROTTLE: '0', ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } }, canonJunk: { env: { ANTIHALL_SCAN_THROTTLE: 'zz', ANTI_HALL_SCAN_THROTTLE: 'off', ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } },
  settingsOff: { settings: { guards: { scanThrottle: false } }, env: { ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } }, settingsOffStr: { settings: { guards: { scanThrottle: 'no' } }, env: { ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } },
  envBeatsSettings: { settings: { guards: { scanThrottle: false } }, env: { ANTIHALL_SCAN_THROTTLE: 'on', ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } },
  optOff: { env: { CLAUDE_PLUGIN_OPTION_GUARDS_SCAN_THROTTLE: 'false', ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } }, optDefault: { env: { CLAUDE_PLUGIN_OPTION_GUARDS_SCAN_THROTTLE: 'true', ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } },
  optStored: { claude: { pluginConfigs: { 'anti-hall': { options: { guards_scan_throttle: false } } } }, env: { ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } },
  noPath: { env: { PATH: '/nonexistent', ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } }, emptyPath: { env: { PATH: '', ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } }, shortPath: { env: { PATH: '/usr/bin:/bin', ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } },
  sbinOnly: { env: { PATH: '/usr/sbin:/sbin', ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } }, dirsWithEmpty: { env: { PATH: '::/nonexistent::/usr/bin:/usr/sbin:', ANTI_HALL_THROTTLE_PATTERNS: 'reindex-repo' } },
  unset: {},
};
for (const [k, c] of Object.entries(sw)) for (const cmd of [base, 'cd x && ' + base, 'echo nothing']) add(bash(cmd), c, `sw-${k}-${cmd.slice(0, 14)}`);

// ---- (2) real commands -------------------------------------------------------------------------------------
const cmds = readCmds(arg('--cmds', '../../fpr/cmds.jsonl'));
const WORDS = ['git', 'npm', 'node', 'cargo', 'ls', 'cat', 'grep', 'python3', 'cd', 'echo', 'gh', 'flutter', 'firebase', 'curl', 'sed', 'rm', 'find'];
const REAL_SETS = WORDS.slice(0, 12).map(w => w).concat(['^cd ', 'git (status|diff|log)', '--full|--all', '^[A-Z_]+=', 'node.*test', '\\bgrep\\b']);
const want = +arg('--real', 6000);
const bag = cmds.filter(c => c.cmd.trim());
for (let i = 0; i < want; i++) { const c = pick(bag); add(bash(c.cmd, { session_id: c.session }), ctx(pick(REAL_SETS)), `real-${i}`); }
// ---- (5) fuzz --------------------------------------------------------------------------------------------
const FZ = [' ', ' ', '　', '﻿', '\u0085', ' ', '\t', '\n', '\r\n', ';', '&&', '||', '|', '&', '(', ')', '{', '}', '`', '$(', '"', "'", '<<EOF\nx\nEOF\n', '<<-X\n\tx\n\tX\n', '<<<', '$((1<<2))', '\\', 'A=1 ', 'A="b c" ', "A='d' ", 'nice -n 19 ', 'taskpolicy -c utility nice -n 19 '];
for (let i = 0; i < 4000; i++) {
  const n = 2 + Math.floor(R() * 7);
  let c = '';
  for (let k = 0; k < n; k++) c += pick([...FZ, 'reindex-repo', 'graphify update', 'x', 'cd app', 'echo hi', '--full', pick(bag).cmd.slice(0, 40)]) + pick(['', ' ', ' ', '']);
  add(bash(c), ctx(pick(['reindex-repo', 'graphify update', 'x', 'reindex-repo,x', 'echo|cd', '^A=', '--full']) ), `fuzz-${i}`);
}
console.error(`scenarios=${scenarios.length} ctxs=${ctxOf.size + Object.keys(sw).length}`);
runParity({ name: 'scan-throttle', check: 'scan-throttle', hookFile: 'scan-throttle.js', scenarios, engine: ENGINE, hooks: HOOKS, mode: arg('--mode', 'both'), conc: +arg('--conc', 8), show: +arg('--show', 15), events: ['PreToolUse'], tools: ['*'] });
