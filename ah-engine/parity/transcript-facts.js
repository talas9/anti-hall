#!/usr/bin/env node
// The Node side of the transcript-index parity check (X1): prints, for one transcript file, the facts the engine's
// index derives, computed by the real Node readers over the WHOLE file:
//   node transcript-facts.js <transcript.jsonl> --hooks <repo>/plugins/anti-hall/hooks
// Authorities (each fact names its reader):
//   last assistant (dedup + legacy)  hooks/speculation-guard.js collectTextFromEntryDedup/Legacy (sliced from the
//                                    source, so a change there is a change here; the guard exports nothing) driven by
//                                    the same role loop as extractLastAssistantTextWith
//   last prompt                      hooks/lib/inference-check.js lastUserPrompt (null when this checkout predates it)
//   terminal agents                  hooks/lib/agent-scan.js scanTranscript over the notification lines
//   finished keys                    companion/lib/devswarm-idle.js notificationTexts + finishedTaskKeys
//   tool uses                        hooks/lib/task-state.js collectTU
'use strict';
const fs = require('fs'), path = require('path');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const file = process.argv[2];
const HOOKS = path.resolve(arg('--hooks', path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks')));
const PLUGIN = path.resolve(HOOKS, '..');

// Slice top-level functions out of a hook script (which has side effects on require) and build them in isolation.
function sliceFns(src, names) {
  const out = [];
  for (const n of names) {
    const start = src.search(new RegExp('^function ' + n + '\\(', 'm'));
    if (start < 0) throw new Error('function ' + n + ' not found');
    let i = src.indexOf('{', src.indexOf(')', start)), depth = 0;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    out.push(src.slice(start, i + 1));
  }
  return new Function(out.join('\n') + '\nreturn { ' + names.join(', ') + ' };')();
}
const spec = sliceFns(fs.readFileSync(path.join(HOOKS, 'speculation-guard.js'), 'utf8'), ['collectTextFromEntryLegacy', 'collectTextFromEntryDedup']);
const idle = require(path.join(PLUGIN, 'companion', 'lib', 'devswarm-idle.js'));
const scan = require(path.join(HOOKS, 'lib', 'agent-scan.js'));
const taskState = require(path.join(HOOKS, 'lib', 'task-state.js'));
let lastUserPrompt = null;
try { lastUserPrompt = require(path.join(HOOKS, 'lib', 'inference-check.js')).lastUserPrompt; } catch (_) { /* older checkout */ }

const lines = fs.readFileSync(file, 'utf8').split('\n');
const kinds = {}; let records = 0, lastDedup = null, lastLegacy = null;
const finished = [], tools = [], notifLines = [];
for (const raw of lines) {
  const t = raw.trim();
  if (!t) continue;
  records++;
  let e; try { e = JSON.parse(t); } catch (_) { e = undefined; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) { kinds.malformed = (kinds.malformed || 0) + 1; continue; }
  const k = typeof e.type === 'string' ? e.type : 'other';
  kinds[k] = (kinds[k] || 0) + 1;
  const role = e.role || (e.message && e.message.role);
  if (role === 'assistant') {
    const a = spec.collectTextFromEntryDedup(e), b = spec.collectTextFromEntryLegacy(e);
    if (a) lastDedup = a;
    if (b) lastLegacy = b;
  }
  for (const tu of taskState.collectTU(e)) tools.push([typeof tu.id === 'string' ? tu.id : null, tu.name]);
  for (const text of idle.notificationTexts(e)) for (const key of idle.finishedTaskKeys(text)) finished.push(key);
  if (t.indexOf('<task-notification>') !== -1) notifLines.push(raw);
}
const sc = scan.scanTranscript(file, notifLines, { nowMs: 0 });
const terminal = sc ? [...sc.terminal].sort() : [];
process.stdout.write(JSON.stringify({
  records, kinds,
  last_assistant: lastDedup, last_assistant_legacy: lastLegacy,
  last_prompt: lastUserPrompt ? (lastUserPrompt(lines) || null) : undefined,
  terminal, finished_keys: finished, tool_uses: tools,
}) + '\n');
