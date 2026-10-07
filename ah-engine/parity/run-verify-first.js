#!/usr/bin/env node
// Parity of the built-in `verify-first-subagent`, `verify-first-full` and `fable-availability` checks against the real Node hooks.
//   node run-verify-first.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks [--only <check>]
// Every scenario gets its own isolated HOME (settings, skip file, host settings, ~/.claude.json) and runs BOTH sides as processes:
// `node <hook>.js` and `ah-engine check <name>` (the oneshot path; the plugin root reaches it through AH_ENGINE_PLUGIN_ROOT).
// Compared: exit code, stdout BYTES (not trimmed), stderr, and the state file the hook leaves behind (fable-availability;
// `checkedAt` must be a plausible clock reading on both sides and is then masked). A side the engine answers with AHFALLBACK
// is a deferral (Node decides, D11), counted apart; a deferral that Node would have answered without needing it is listed.
const fs = require('fs'), os = require('os'), path = require('path');
const { arg, run, pool } = require('./guardlib.js');
const ENGINE = path.resolve(arg('--engine', '../target/release/ah-engine')), HOOKS = path.resolve(arg('--hooks'));
const ONLY = arg('--only', '');
const PLUGIN_ROOT = path.resolve(HOOKS, '..');
const TMP = fs.mkdtempSync(path.join('/tmp', 'ah-par-vf-'));
const J = JSON.stringify;
const scen = [];
let homeN = 0;
const add = (check, id, ctx, stdin) => scen.push({ check, id, ctx: ctx || {}, stdin: stdin === undefined ? '{}' : stdin });

// ---------------------------------------------------------------------------------------------------- payloads
const ev = (name, extra) => J(Object.assign({ hook_event_name: name, session_id: 's1', cwd: '/tmp' }, extra || {}));
const HUGE = 'x'.repeat(1 << 20);
const PAYLOADS = (event) => [
  ['empty-object', '{}'], ['event', ev(event)], ['event-startup', ev(event, { source: 'startup' })], ['event-resume', ev(event, { source: 'resume' })],
  ['event-clear', ev(event, { source: 'clear' })], ['event-compact', ev(event, { source: 'compact' })], ['other-event', ev('Stop')], ['event-number', J({ hook_event_name: 5 })],
  ['codex-turn', ev(event, { turn_id: 'abc', model: 'gpt-5' })], ['codex-turn-empty', ev(event, { turn_id: '' })], ['codex-turn-number', ev(event, { turn_id: 7 })],
  ['codex-rollout', ev(event, { transcript_path: '/Users/u/.codex/sessions/2026/10/06/rollout-2026-10-06T10-00-00-abc.jsonl' })],
  ['codex-rollout-bare', ev(event, { transcript_path: 'rollout-x.jsonl' })], ['codex-rollout-bak', ev(event, { transcript_path: '/a/rollout-x.jsonl.bak' })],
  ['codex-rollout-nested', ev(event, { transcript_path: '/a/rollout-x/y.jsonl' })], ['codex-dir', ev(event, { transcript_path: '/home/u/.codex/x' })],
  ['codex-dir-win', ev(event, { transcript_path: 'C:\\Users\\u\\.codex\\x' })], ['codex-dir-end', ev(event, { transcript_path: '/home/u/.codex' })],
  ['claude-transcript', ev(event, { transcript_path: '/Users/u/.claude/projects/p/s.jsonl' })], ['transcript-number', ev(event, { transcript_path: 5 })],
  ['unicode', ev(event, { prompt: 'héllo \u{1F600} \u2028 日本語', transcript_path: '/tmp/\u{1F600}/rollout-é.jsonl' })], ['huge', ev(event, { prompt: HUGE })],
  ['deep', '{"a":' + '['.repeat(100) + ']'.repeat(100) + '}'], ['array', '[1,2,3]'], ['null', 'null'], ['number', '42'], ['string', '"SessionStart"'], ['true', 'true'],
  ['empty-stdin', ''], ['whitespace', ' \n\t '], ['bad-json', '{'], ['bad-trailing', '{"a":1,}'], ['bom', '\ufeff{}'], ['lone-surrogate', '{"a":"\\ud800","turn_id":"x"}'],
  ['duplicate-keys', '{"turn_id":"","turn_id":"x"}'], ['agent-fields', ev(event, { agent_id: 'a', agent_type: 'Explore' })],
];

// ---------------------------------------------------------------------------------------------------- verify-first-full
const PO = (name, v) => ({ env: { ['CLAUDE_PLUGIN_OPTION_' + name]: v } });
const STORED = (opts, nested) => ({ claude: { pluginConfigs: { 'anti-hall': nested ? { options: opts } : opts } } });
const FULL_CTX = {
  default: {}, level_full: { env: { ANTIHALL_PROTOCOL_LEVEL: 'full' } }, level_full_sp: { env: { ANTIHALL_PROTOCOL_LEVEL: '  FuLL ' } }, level_compact: { env: { ANTIHALL_PROTOCOL_LEVEL: 'compact' } },
  level_junk: { env: { ANTIHALL_PROTOCOL_LEVEL: 'zz' } }, level_empty: { env: { ANTIHALL_PROTOCOL_LEVEL: '' } }, level_file_full: { settings: { context: { protocolLevel: 'full' } } },
  level_file_junk: { settings: { context: { protocolLevel: 7 } } }, level_file_upper: { settings: { context: { protocolLevel: 'FULL' } } }, level_env_beats_file: { settings: { context: { protocolLevel: 'full' } }, env: { ANTIHALL_PROTOCOL_LEVEL: 'compact' } },
  level_junk_env_file_full: { settings: { context: { protocolLevel: 'full' } }, env: { ANTIHALL_PROTOCOL_LEVEL: 'zz' } }, level_file_not_object: { settings: { context: 'full' } }, level_file_array: { settings: '[1]' }, level_file_corrupt: { settings: '{not json' },
  session_off_file: { settings: { context: { verifyFirstSession: false } } }, session_off_str: { settings: { context: { verifyFirstSession: 'off' } } }, session_off_zero: { settings: { context: { verifyFirstSession: 0 } } },
  session_junk_file: { settings: { context: { verifyFirstSession: 'maybe' } } }, session_off_opt: PO('CONTEXT_VERIFY_FIRST_SESSION', 'false'), session_default_opt: PO('CONTEXT_VERIFY_FIRST_SESSION', 'true'),
  session_off_stored: STORED({ context_verify_first_session: false }), session_off_stored_nested: STORED({ context_verify_first_session: 'no' }, true),
  session_on_file_beats_opt: Object.assign({ settings: { context: { verifyFirstSession: true } } }, PO('CONTEXT_VERIFY_FIRST_SESSION', 'false')),
  orch_off_file: { settings: { context: { verifyFirstOrchestration: false } } }, orch_off_opt: PO('CONTEXT_VERIFY_FIRST_ORCHESTRATION', '0'), orch_off_stored: STORED({ context_verify_first_orchestration: 'false' }),
  orch_off_full: { settings: { context: { verifyFirstOrchestration: false, protocolLevel: 'full' } } }, orch_default_opt: PO('CONTEXT_VERIFY_FIRST_ORCHESTRATION', 'true'),
  judge1: { env: { ANTIHALL_JUDGE_CHILD: '1' } }, judge_true: { env: { ANTIHALL_JUDGE_CHILD: 'true' } }, judge_sp: { env: { ANTIHALL_JUDGE_CHILD: ' 1' } },
  skip_all: { skip: { all: 99999999999999 } }, child_branch: { env: { DEVSWARM_SOURCE_BRANCH: 'feat/x' } }, home_unset_settings: {},
};
const fullPayloads = PAYLOADS('SessionStart');
for (const [cid, ctx] of Object.entries(FULL_CTX)) {
  const keep = cid === 'default' || cid.startsWith('level_full') || cid === 'orch_off_file' || cid === 'judge1' || cid === 'level_file_full' ? fullPayloads : fullPayloads.filter(([id]) => ['event', 'event-compact', 'codex-turn', 'codex-rollout', 'unicode', 'empty-object'].includes(id));
  for (const [pid, p] of keep) add('verify-first-full', `${cid}/${pid}`, ctx, p);
}

// ---------------------------------------------------------------------------------------------------- verify-first-subagent
const NOW = Date.now();
const SUB_CTX = {
  default: {}, level_full: { env: { ANTIHALL_PROTOCOL_LEVEL: 'full' } }, level_file_full: { settings: { context: { protocolLevel: 'full' } } }, level_junk: { env: { ANTIHALL_PROTOCOL_LEVEL: 'x' } },
  child: { env: { DEVSWARM_SOURCE_BRANCH: 'feat/a' } }, child_full: { env: { DEVSWARM_SOURCE_BRANCH: 'b', ANTIHALL_PROTOCOL_LEVEL: 'full' } }, child_blank: { env: { DEVSWARM_SOURCE_BRANCH: '   ' } },
  child_tab_bom: { env: { DEVSWARM_SOURCE_BRANCH: '\t\ufeff' } }, child_empty: { env: { DEVSWARM_SOURCE_BRANCH: '' } }, child_unicode: { env: { DEVSWARM_SOURCE_BRANCH: 'fé\u{1F600}' } },
  off_file: { settings: { context: { verifyFirstSubagent: false } } }, off_str: { settings: { context: { verifyFirstSubagent: 'off' } } }, off_no: { settings: { context: { verifyFirstSubagent: 'No' } } },
  off_zero: { settings: { context: { verifyFirstSubagent: 0 } } }, on_junk: { settings: { context: { verifyFirstSubagent: 'maybe' } } }, off_opt: PO('CONTEXT_VERIFY_FIRST_SUBAGENT', 'false'),
  default_opt: PO('CONTEXT_VERIFY_FIRST_SUBAGENT', 'true'), off_stored: STORED({ context_verify_first_subagent: false }), off_stored_nested: STORED({ context_verify_first_subagent: 'off' }, true),
  off_stored_bad: { claude: '{broken' }, off_file_corrupt: { settings: '{broken' },
  skip_named: { skip: { 'verify-first-subagent': NOW + 3.6e6 } }, skip_all: { skip: { all: NOW + 3.6e6 } }, skip_expired: { skip: { 'verify-first-subagent': 1000 } }, skip_other: { skip: { 'verify-first-full': NOW + 3.6e6 } },
  skip_str: { skip: { 'verify-first-subagent': String(NOW + 3.6e6) } }, skip_bad: { skip: '{x' }, skip_array: { skip: '[1]' }, skip_empty: { skip: '' }, skip_all_expired_named_live: { skip: { all: 5, 'verify-first-subagent': NOW + 3.6e6 } },
  judge1: { env: { ANTIHALL_JUDGE_CHILD: '1' } }, off_and_child: { settings: { context: { verifyFirstSubagent: false } }, env: { DEVSWARM_SOURCE_BRANCH: 'x' } },
};
const subPayloads = PAYLOADS('SubagentStart');
for (const [cid, ctx] of Object.entries(SUB_CTX)) {
  const keep = cid === 'default' || cid === 'child' ? subPayloads : subPayloads.filter(([id]) => ['event', 'empty-object', 'agent-fields', 'unicode', 'empty-stdin'].includes(id));
  for (const [pid, p] of keep) add('verify-first-subagent', `${cid}/${pid}`, ctx, p);
}

// ---------------------------------------------------------------------------------------------------- fable-availability
const acc = (e) => J({ modelAccessCache: e });
const opt = (e) => J({ additionalModelOptionsCache: e });
const CJ = {
  missing: null, empty: '', ws: ' \n', corrupt: '{"modelAccessCache":[', bom: '\ufeff{"modelAccessCache":[{"apiName":"fable","entitled":true}]}', trailing_comma: '{"a":1,}',
  null: 'null', array: '[{"apiName":"fable","entitled":true}]', number: '5', string: '"fable"', bool: 'true', obj_empty: '{}',
  entitled: acc([{ apiName: 'claude-fable-5', entitled: true }]), entitled_upper: acc([{ apiName: 'CLAUDE-FABLE-5', entitled: true }]), entitled_mixed: acc([{ apiName: 'Fable', entitled: true }]),
  not_entitled: acc([{ apiName: 'fable', entitled: false }]), entitled_missing: acc([{ apiName: 'fable' }]), entitled_one: acc([{ apiName: 'fable', entitled: 1 }]), entitled_str: acc([{ apiName: 'fable', entitled: 'true' }]),
  entitled_null: acc([{ apiName: 'fable', entitled: null }]), access_not_array: J({ modelAccessCache: { apiName: 'fable', entitled: true } }), access_string: J({ modelAccessCache: 'fable' }), access_null: J({ modelAccessCache: null }),
  access_empty: acc([]), access_mixed_entries: acc([null, 0, '', 'fable', 7, [1], { apiName: 5 }, { apiName: null }, { apiName: 'x' }, { apiName: 'fable-2', entitled: true }]),
  access_first_wins: acc([{ apiName: 'fable', entitled: false }, { apiName: 'fable-2', entitled: true }]), access_other_models: acc([{ apiName: 'claude-opus', entitled: true }, { apiName: 'sonnet', entitled: true }]),
  access_name_field_other: acc([{ name: 'fable', entitled: true }]), access_nested: J({ a: { modelAccessCache: [{ apiName: 'fable', entitled: true }] } }),
  options_enabled: opt([{ value: 'fable', label: 'x' }]), options_label: opt([{ label: 'Try Fable now' }]), options_model: opt([{ model: 'FABLE-1' }]), options_disabled: opt([{ value: 'fable', disabled: true }]),
  options_disabled_str: opt([{ value: 'fable', disabled: 'true' }]), options_disabled_false: opt([{ value: 'fable', disabled: false }]), options_not_array: J({ additionalModelOptionsCache: { value: 'fable' } }),
  options_mixed: opt([null, 3, 'fable', { value: 5 }, { value: 'sonnet' }, { model: 'fable' }]), options_other_field: opt([{ id: 'fable' }]),
  access_no_options_yes: J({ modelAccessCache: [{ apiName: 'fable', entitled: false }], additionalModelOptionsCache: [{ value: 'fable' }] }),
  access_nofable_options_yes: J({ modelAccessCache: [{ apiName: 'opus', entitled: true }], additionalModelOptionsCache: [{ value: 'fable-x', disabled: true }] }),
  unicode: J({ modelAccessCache: [{ apiName: 'F\u00c4BLE' }, { apiName: '\u{1F600}fable\u{1F600}', entitled: true }], note: '日本語 \u2028' }),
  turkish_dotted: acc([{ apiName: 'FABLE\u0130', entitled: true }]), kelvin: acc([{ apiName: '\u212Aable', entitled: true }]), fullwidth: acc([{ apiName: '\uFF26\uFF21\uFF22\uFF2C\uFF25', entitled: true }]),
  lone_surrogate_other: '{"history":"cut \\ud83d here","modelAccessCache":[{"apiName":"fable","entitled":true}]}', lone_surrogate_low: '{"h":"\\udc00","modelAccessCache":[{"apiName":"fable","entitled":false}]}',
  lone_surrogate_name: '{"modelAccessCache":[{"apiName":"fable\\ud800","entitled":true}]}', pair_ok: '{"x":"\\ud83d\\ude00","modelAccessCache":[{"apiName":"fable","entitled":true}]}',
  escaped_backslash_u: '{"x":"\\\\ud800","modelAccessCache":[{"apiName":"fable","entitled":true}]}', escaped_name: '{"modelAccessCache":[{"apiName":"\\u0066able","entitled":true}]}',
  dup_keys: '{"modelAccessCache":[{"apiName":"x"}],"modelAccessCache":[{"apiName":"fable","entitled":true}]}', big_unrelated: J({ junk: 'x'.repeat(5 << 20), modelAccessCache: [{ apiName: 'fable', entitled: true }] }),
  deep_ok: '{"a":' + '['.repeat(120) + ']'.repeat(120) + ',"modelAccessCache":[{"apiName":"fable","entitled":true}]}', deep_over_serde: '{"a":' + '['.repeat(400) + ']'.repeat(400) + ',"modelAccessCache":[{"apiName":"fable","entitled":true}]}',
  invalid_utf8: Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from('","modelAccessCache":[{"apiName":"fable","entitled":true}]}')]),
  crlf_pretty: '{\r\n  "modelAccessCache": [\r\n    { "apiName": "fable", "entitled": true }\r\n  ]\r\n}\r\n',
};
for (const [id, body] of Object.entries(CJ)) add('fable-availability', `claudejson/${id}`, { claudeJson: body }, ev('SessionStart', { source: 'startup' }));
const FA = { claudeJson: acc([{ apiName: 'fable', entitled: true }]) };
add('fable-availability', 'ctx/judge1', Object.assign({}, FA, { env: { ANTIHALL_JUDGE_CHILD: '1' } }));
add('fable-availability', 'ctx/judge_true', Object.assign({}, FA, { env: { ANTIHALL_JUDGE_CHILD: 'true' } }));
add('fable-availability', 'ctx/dot_is_file', Object.assign({}, FA, { dotAntiHallFile: true }));
add('fable-availability', 'ctx/state_preexisting', Object.assign({}, FA, { files: { '.anti-hall/fable-availability.json': '{"old":true}' } }));
add('fable-availability', 'ctx/state_is_dir', Object.assign({}, FA, { stateIsDir: true }));
add('fable-availability', 'ctx/no_dot_dir', Object.assign({}, FA, { noDotDir: true }));
add('fable-availability', 'ctx/settings_off_irrelevant', Object.assign({}, FA, { settings: { context: { verifyFirstSession: false } } }));
add('fable-availability', 'ctx/skip_irrelevant', Object.assign({}, FA, { skip: { all: 99999999999999 } }));
for (const [pid, p] of PAYLOADS('SessionStart')) add('fable-availability', `payload/${pid}`, FA, p);

// ---------------------------------------------------------------------------------------------------- runner
function mkHome(ctx) {
  const home = path.join(TMP, 'h' + homeN++);
  fs.mkdirSync(home, { recursive: true });
  const w = (rel, body) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof body === 'string' || Buffer.isBuffer(body) ? body : J(body)); };
  if (!ctx.noDotDir) fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  if (ctx.dotAntiHallFile) { fs.rmSync(path.join(home, '.anti-hall'), { recursive: true }); fs.writeFileSync(path.join(home, '.anti-hall'), 'x'); }
  if (ctx.stateIsDir) fs.mkdirSync(path.join(home, '.anti-hall', 'fable-availability.json'), { recursive: true });
  if (ctx.settings !== undefined) w('.anti-hall/settings.json', ctx.settings);
  if (ctx.skip !== undefined) w('.anti-hall/skip.json', ctx.skip);
  if (ctx.claude !== undefined) w('.claude/settings.json', ctx.claude);
  if (ctx.claudeJson !== undefined && ctx.claudeJson !== null) w('.claude.json', ctx.claudeJson);
  for (const [rel, body] of Object.entries(ctx.files || {})) w(rel, body);
  return home;
}
function state(home, t0, t1) {
  const f = path.join(home, '.anti-hall', 'fable-availability.json');
  try {
    if (!fs.statSync(f).isFile()) return 'not-a-file';
    const raw = fs.readFileSync(f, 'utf8');
    try {
      const o = JSON.parse(raw);
      if (typeof o.checkedAt === 'number') { if (o.checkedAt < t0 - 5 || o.checkedAt > t1 + 5) return 'bad-checkedAt:' + raw; return raw.replace(/"checkedAt":\d+/, '"checkedAt":T'); }
    } catch (_) { /* fall through */ }
    return raw;
  } catch (_) { return 'absent'; }
}
const hookFile = { 'verify-first-full': 'verify-first-full.js', 'verify-first-subagent': 'verify-first-subagent.js', 'fable-availability': 'fable-availability.js' };
const stats = {}; const mism = []; const defers = [];
async function one(s) {
  const st = stats[s.check] = stats[s.check] || { n: 0, same: 0, deferred: 0, unneeded: 0, mismatch: 0, nodeOut: 0, nodeSilent: 0 };
  const baseEnv = (home) => Object.assign({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, ANTIHALL_TEST_ISOLATION: '1', ANTIHALL_INGEST_DRY_RUN: '1' }, s.ctx.env || {});
  const nHome = mkHome(s.ctx), eHome = mkHome(s.ctx);
  const t0 = Date.now();
  const n = await run(process.execPath, [path.join(HOOKS, hookFile[s.check])], s.stdin, baseEnv(nHome), '/tmp');
  const nSt = state(nHome, t0, Date.now());
  const t1 = Date.now();
  const e = await run(ENGINE, ['check', s.check], s.stdin, Object.assign(baseEnv(eHome), { AH_ENGINE_PLUGIN_ROOT: PLUGIN_ROOT }), '/tmp');
  st.n++;
  if (n.out) st.nodeOut++; else st.nodeSilent++;
  if (String(e.out).trim() === 'AHFALLBACK') {
    st.deferred++;
    const quiet = !n.out && n.code === 0; // Node needed no output: a deferral here is only a missed offload
    if (quiet) st.unneeded++;
    defers.push(s.id);
    // a deferral must leave the state to Node: the engine wrote nothing
    const eSt = state(eHome, t1, Date.now());
    if (s.check === 'fable-availability' && eSt !== 'absent' && !(s.ctx.files || s.ctx.stateIsDir || s.ctx.dotAntiHallFile)) { st.mismatch++; mism.push({ id: s.id, why: 'deferred but wrote state', eSt }); }
    return;
  }
  const eSt = state(eHome, t1, Date.now());
  const same = n.code === e.code && n.out === e.out && n.err === e.err && (s.check !== 'fable-availability' || nSt === eSt);
  if (same) st.same++; else { st.mismatch++; mism.push({ id: s.id, check: s.check, node: { code: n.code, out: n.out.slice(0, 160), err: n.err.slice(0, 160), state: nSt }, engine: { code: e.code, out: e.out.slice(0, 160), err: e.err.slice(0, 160), state: eSt } }); }
}
(async () => {
  const list = scen.filter(s => !ONLY || s.check === ONLY);
  await pool(list, +arg('--conc', 6), one);
  let bad = 0;
  for (const [c, st] of Object.entries(stats)) { console.log(`${c}: scenarios=${st.n} same=${st.same} deferred=${st.deferred} (Node silent anyway: ${st.unneeded}) MISMATCH=${st.mismatch} node-printed=${st.nodeOut} node-silent=${st.nodeSilent}`); bad += st.mismatch; }
  const byGroup = {}; for (const d of defers) { const k = d.split('/')[1] || d; byGroup[k] = (byGroup[k] || 0) + 1; }
  console.log('deferred by payload/config: ' + J(byGroup));
  for (const m of mism.slice(0, 25)) console.log(J(m));
  fs.writeFileSync(path.join(os.tmpdir(), 'ah-parity-verify-first-mismatches.json'), J(mism, null, 1));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exitCode = bad ? 1 : 0;
})();
