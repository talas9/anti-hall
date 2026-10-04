// Reference model for the per-event dispatcher (D58), written independently of the Rust code from the hosts' docs:
// which hooks.json entries a payload matches, running them as the host does (all at once, each under the shell with
// the payload on stdin and its own timeout), and the one-output combination the dispatcher must produce from them.
// Used by run-dispatch.js; see src/dispatch/combine.rs for the rules in prose.
'use strict';
const cp = require('child_process');

// Claude: letters, digits, _ - space , | only => exact name or list; otherwise an unanchored JS regex.
// Codex: always an unanchored regex. "" and "*" match everything.
function matches(host, matcher, subjects) {
  if (matcher === '' || matcher === '*') return true;
  if (host === 'claude' && /^[A-Za-z0-9_\- ,|]*$/.test(matcher)) {
    const names = matcher.split(/[|,]/).map(s => s.trim()).filter(Boolean);
    return subjects.some(s => names.includes(s));
  }
  let re; try { re = new RegExp(matcher); } catch { return false; }
  return subjects.some(s => re.test(s));
}

const MATCHER_FIELD = { PreToolUse: 'tool_name', PostToolUse: 'tool_name', PostToolUseFailure: 'tool_name', PermissionRequest: 'tool_name', SessionStart: 'source', SubagentStart: 'agent_type', SubagentStop: 'agent_type', PreCompact: 'trigger', PostCompact: 'trigger' };
const ALIASES = { codex: { apply_patch: ['Edit', 'Write'] } };

// The id of a hooks.json command within its event (the fallback-map key): script, then its arguments, "#n" for a
// repeat; `seen` counts ids over every entry of the event in order. Same scheme as gen-dispatch.js.
function idOf(command, seen) {
  const m = command.match(/\/hooks\/([^"\s]+)"?\s*(.*)$/);
  const script = m ? m[1] : command, args = m ? m[2].trim() : '';
  const id = script.replace(/\.js$/, '') + (args ? ':' + args.replace(/^-+/, '').replace(/\s+-*/g, ':') : '');
  seen[id] = (seen[id] || 0) + 1;
  return seen[id] > 1 ? id + '#' + seen[id] : id;
}

// The hooks.json entries of `event` this payload matches, in hooks.json order: [{id, command, timeout}].
function select(hooksJson, host, event, payload) {
  const groups = (hooksJson.hooks || {})[event] || [];
  const field = MATCHER_FIELD[event];
  const v = field ? String(payload[field] || '') : null;
  const subjects = v === null ? null : [v, ...(((ALIASES[host] || {})[v]) || [])];
  const out = [], seen = {};
  for (const g of groups) {
    const hit = !subjects || matches(host, g.matcher || '', subjects);
    for (const h of g.hooks) {
      const id = idOf(h.command, seen);
      if (hit) out.push({ id, command: h.command, timeout: h.timeout || 0 });
    }
  }
  return out;
}

// Run one hook command like the host: /bin/sh -c, payload on stdin, killed (group) at its timeout => no output.
function runHook(command, input, env, cwd, timeoutS) {
  return new Promise(res => {
    const p = cp.spawn('/bin/sh', ['-c', command], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let o = '', e = '', done = false;
    p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
    const to = setTimeout(() => { done = true; try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, timeoutS * 1000);
    p.on('close', code => { clearTimeout(to); res(done ? { code: null, out: '', err: '' } : { code, out: o, err: e }); });
    p.stdin.on('error', () => {}); p.stdin.end(input);
  });
}

// ---- the one-output combination -------------------------------------------------------------------------------
const PRECEDENCE = ['deny', 'defer', 'ask', 'allow'];
function parseObject(out) {
  const t = out.trim();
  if (!(t.startsWith('{') && t.endsWith('}'))) return null;
  try { const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
function jsonBlocks(out) {
  const v = parseObject(out);
  return !!v && (v.decision === 'block' || !!(v.hookSpecificOutput && v.hookSpecificOutput.permissionDecision === 'deny'));
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// results: [{code (null = timed out), out, err}] in hooks.json order. Returns {code, out, err} or {conflict: true}.
function combine(results, joiners = { context: '\n\n', message: '\n' }) {
  const ex2 = results.find(r => r.code === 2);
  if (ex2) return { code: 2, out: ex2.out, err: ex2.err };
  const jb = results.find(r => r.code !== null && jsonBlocks(r.out));
  if (jb) return { code: jb.code, out: jb.out, err: jb.err };
  const active = results.filter(r => r.code !== null && (r.code !== 0 || r.out !== '' || r.err !== ''));
  if (active.length === 0) return { code: 0, out: '', err: '' };
  if (active.length === 1) return { code: active[0].code, out: active[0].out, err: active[0].err };
  return mergeObjects(active, joiners, false);
}

// Merge several answers (src/dispatch/combine.rs `merge`); `lenient` keeps the first value of a field two answers set
// differently instead of reporting a conflict (`sequential`).
function mergeObjects(active, joiners, lenient) {
  const top = {}, hso = {}, contexts = [], messages = [];
  let decision = null, err = '';
  const put = (o, k, v) => { if (!(k in o)) { o[k] = v; return true; } return lenient || deepEq(o[k], v); };
  for (const r of active) {
    if (r.code !== 0) return { conflict: true };
    err += r.err;
    if (r.out.trim() === '') continue;
    const v = parseObject(r.out);
    if (!v) return { conflict: true };
    for (const [k, x] of Object.entries(v)) {
      let ok;
      if (k === 'hookSpecificOutput' && x && typeof x === 'object' && !Array.isArray(x)) {
        ok = put(top, k, {});
        for (const [k2, x2] of Object.entries(x)) {
          if (k2 === 'additionalContext' && typeof x2 === 'string') { contexts.push(x2); ok = put(hso, k2, '') && ok; }
          else if (k2 === 'permissionDecision' && typeof x2 === 'string') {
            const rank = PRECEDENCE.indexOf(x2) < 0 ? PRECEDENCE.length : PRECEDENCE.indexOf(x2);
            if (!decision || rank < decision.rank) decision = { rank, value: x2, reason: x.permissionDecisionReason };
            ok = put(hso, k2, '') && ok;
          } else if (k2 === 'permissionDecisionReason') ok = put(hso, k2, '') && ok;
          else ok = put(hso, k2, x2) && ok;
        }
      } else if (k === 'systemMessage' && typeof x === 'string') { messages.push(x); ok = put(top, k, ''); }
      else ok = put(top, k, x);
      if (!ok) return { conflict: true };
    }
  }
  const outH = {};
  for (const k of Object.keys(hso)) {
    if (k === 'additionalContext') outH[k] = contexts.join(joiners.context);
    else if (k === 'permissionDecision') { if (decision) outH[k] = decision.value; }
    else if (k === 'permissionDecisionReason') { if (decision && decision.reason !== undefined) outH[k] = decision.reason; }
    else outH[k] = hso[k];
  }
  const outTop = {};
  for (const k of Object.keys(top)) {
    if (k === 'hookSpecificOutput') outTop[k] = outH;
    else if (k === 'systemMessage') outTop[k] = messages.join(joiners.message);
    else outTop[k] = top[k];
  }
  return { code: 0, out: JSON.stringify(outTop) + '\n', err };
}

// A delivery that cannot be one exact answer (a conflict, or an over-cap join on a guard event): the JSON objects among the
// stdouts of the hooks that exited 0 are merged into ONE line (a field set differently keeps the first value; the host reads
// a whole stdout as one object or as text), plain stdout next to JSON moves to stderr, and with no JSON the plain stdouts
// are delivered one after another; the stderr of every finished hook is kept (src/dispatch/combine.rs `sequential`).
function sequential(results, joiners = { context: '\n\n', message: '\n' }) {
  const live = results.filter(r => r.code !== null);
  let err = live.map(r => r.err).join('');
  const said = live.filter(r => r.code === 0 && r.out !== '');
  const json = said.filter(r => parseObject(r.out)), plain = said.filter(r => !parseObject(r.out));
  const lines = rs => rs.map(r => r.out.endsWith('\n') ? r.out : r.out + '\n').join('');
  if (json.length === 0) return { code: 0, out: lines(plain), err };
  const out = json.length === 1 ? lines(json) : mergeObjects(json, joiners, true).out;
  err += lines(plain);
  return { code: 0, out, err };
}
// Several hooks' contexts joined past the host's inline cap: the dispatcher hands the event back (exit 75).
function overCap(results, combined, cap) {
  const ctx = o => { const v = parseObject(o); const c = v && v.hookSpecificOutput && v.hookSpecificOutput.additionalContext; return typeof c === 'string' ? c : null; };
  const n = results.filter(r => r.code !== null && ctx(r.out) !== null).length;
  const joined = combined && ctx(combined.out);
  return n > 1 && joined !== null && [...joined].length > cap ? [...joined].length : 0;
}

module.exports = { sequential, overCap, matches, select, runHook, combine, parseObject, jsonBlocks, idOf };
