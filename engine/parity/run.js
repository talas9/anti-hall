#!/usr/bin/env node
// Parity harness: run each corpus command through the Node hook AND the engine, diff decision + message.
//   node run.js --engine ../target/release/engine --hooks <repo>/plugins/anti-hall/hooks --corpus corpus.jsonl [--rules ../rules.json] [--limit N] [--show 15]
// Node side: `git-guard.js` for the two git rules; `command-guard.js` for rm -rf (it has no rm -rf rule: example only).
// Everything runs under a temp HOME and a temp engine dir; nothing touches the real home.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ENGINE = path.resolve(arg('--engine', '../target/release/engine'));
const HOOKS = path.resolve(arg('--hooks'));
const RULES = JSON.parse(fs.readFileSync(path.resolve(arg('--rules', path.join(__dirname, '..', 'rules.json'))), 'utf8'));
const LIMIT = +arg('--limit', 1e9), SHOW = +arg('--show', 15);
const MAP = { 'git-force-push': ['git-no-force-push', 'git-guard.js'], 'git-ai-credit': ['git-no-ai-self-credit', 'git-guard.js'], 'rm-rf-root-home': ['rm-rf-root-or-home', 'command-guard.js'] };
const tmp = fs.mkdtempSync(path.join('/tmp', 'ah-par-'));
const home = path.join(tmp, 'h'); fs.mkdirSync(home);
const payload = c => JSON.stringify({ session_id: 'parity', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: c } });
const run = (cmd, args, input, env) => new Promise(res => {
  const p = cp.spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let o = '', e = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
  p.on('close', code => res({ code, out: o, err: e })); p.stdin.on('error', () => {}); p.stdin.end(input);
});
const norm = s => s.replace(/\s+/g, ' ').trim();
const nodeDecision = r => {
  let msg = '';
  try { const j = JSON.parse(r.out); const h = j.hookSpecificOutput || {}; if (h.permissionDecision === 'deny') return { d: 'deny', m: norm(h.permissionDecisionReason || '') }; if (j.decision === 'block') return { d: 'deny', m: norm(j.reason || '') }; msg = norm(h.additionalContext || ''); } catch {}
  if (r.code === 2) return { d: 'deny', m: norm(r.err || r.out) };
  return { d: msg ? 'warn' : 'allow', m: msg };
};
const engDecision = o => {
  if (!o.trim()) return { d: 'allow', m: '' };
  const j = JSON.parse(o), h = j.hookSpecificOutput || {};
  if (h.permissionDecision === 'deny') return { d: 'deny', m: norm(h.permissionDecisionReason) };
  if (j.decision === 'block') return { d: 'deny', m: norm(j.reason) };
  return { d: 'warn', m: norm((h.additionalContext || '').replace(/^anti-hall warning: /, '')) };
};
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }
(async () => {
  const corpus = fs.readFileSync(path.resolve(arg('--corpus')), 'utf8').split('\n').filter(Boolean).map(JSON.parse).slice(0, LIMIT);
  const stats = {}, mism = [];
  for (const rule of Object.keys(MAP)) {
    const [rid, hook] = MAP[rule];
    const dir = path.join(tmp, 'e-' + rule), rf = path.join(tmp, rule + '.json');
    fs.writeFileSync(rf, JSON.stringify({ version: 1, rules: RULES.rules.filter(r => r.id === rid) }));
    const env = { ANTIHALL_ENGINE_DIR: dir, ANTIHALL_ENGINE_RULES: rf, ANTIHALL_ENGINE_SESSION_RPS: '0', ANTIHALL_ENGINE_PROJECT_RPS: '0', ANTIHALL_ENGINE_VERSION: 'parity' };
    await run(ENGINE, ['hook'], payload('echo warm'), env);
    for (let i = 0; i < 100; i++) { const r = await run(ENGINE, ['ctl', 'ping'], '', env); if (r.code === 0) break; await new Promise(r => setTimeout(r, 50)); }
    const items = corpus.filter(c => c.rule === rule);
    const st = stats[rule] = { n: 0, agree_decision: 0, agree_message: 0, node_deny: 0, engine_deny: 0, engine_only: 0, node_only: 0 };
    await pool(items, 8, async c => {
      const p = payload(c.command);
      const [n, e] = await Promise.all([run('node', [path.join(HOOKS, hook)], p, {}), run(ENGINE, ['hook'], p, env)]);
      const nd = nodeDecision(n);
      let ed; try { ed = engDecision(e.out); } catch { ed = { d: 'ERROR', m: e.out.slice(0, 80) }; }
      st.n++;
      if (nd.d === 'deny') st.node_deny++;
      if (ed.d === 'deny') st.engine_deny++;
      const same = nd.d === ed.d;
      if (same) { st.agree_decision++; if (nd.d === 'allow' || nd.m.includes(ed.m) || ed.m.includes(nd.m)) st.agree_message++; }
      else { if (ed.d !== 'allow' && nd.d === 'allow') st.engine_only++; else st.node_only++; if (mism.length < 4000) mism.push({ rule, command: c.command.slice(0, 300), node: nd.d, engine: ed.d, source: c.source }); }
    });
    await run(ENGINE, ['ctl', 'stop'], '', env);
  }
  console.log('rule'.padEnd(18) + 'n'.padStart(6) + 'decision-agree'.padStart(16) + 'msg-agree'.padStart(11) + 'node-deny'.padStart(11) + 'engine-deny'.padStart(13) + 'engine-only'.padStart(13) + 'node-only'.padStart(11));
  let tn = 0, ta = 0;
  for (const [r, s] of Object.entries(stats)) {
    const pc = x => s.n ? (100 * x / s.n).toFixed(1) + '%' : '-';
    console.log(r.padEnd(18) + String(s.n).padStart(6) + pc(s.agree_decision).padStart(16) + pc(s.agree_message).padStart(11) + String(s.node_deny).padStart(11) + String(s.engine_deny).padStart(13) + String(s.engine_only).padStart(13) + String(s.node_only).padStart(11));
    if (r !== 'rm-rf-root-home') { tn += s.n; ta += s.agree_decision; }
  }
  console.log(`\nported-rule agreement (git rules): ${ta}/${tn} = ${tn ? (100 * ta / tn).toFixed(2) : '-'}%`);
  console.log('rm-rf-root-home has no Node counterpart (command-guard.js does not block or warn on it): EXAMPLE rule, not a port; its row is informational.');
  fs.writeFileSync(path.join(__dirname, 'last-mismatches.json'), JSON.stringify(mism, null, 1));
  for (const m of mism.slice(0, SHOW)) console.log(JSON.stringify(m));
  fs.rmSync(tmp, { recursive: true, force: true });
})();
