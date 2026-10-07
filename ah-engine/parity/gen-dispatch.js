#!/usr/bin/env node
// Regenerates the table part of plugins/anti-hall/engine/defaults/dispatch.toml (the per-event dispatch table, D58) from the plugin's two
// hooks.json files, in place. Everything above the MARKER line (the hand-written settings) is kept as it is.
//   node gen-dispatch.js [--repo <checkout>] [--out <file>]
// The table lists, per host and event, every hook entry in hooks.json order (matcher groups in order, handlers in
// order within a group), with the exact command string and timeout, plus the built-in check that answers it in the
// engine ("" = always the Node hook). tests/dispatch_table.rs fails when hooks.json changes and this file does not.
// RETIRED (D87): plugins/anti-hall/engine/defaults/dispatch.toml is now the hand-maintained table of record and hooks.json is generated FROM it
// (`ah-engine gen-hooks`, `ah-gen-fallback-list`); running this would overwrite the table from a thin hooks.json. It stays in
// the tree only until the owner deletes it.
console.error('gen-dispatch.js is retired (D87): edit plugins/anti-hall/engine/defaults/dispatch.toml and run ah-gen-fallback-list --repo ..');
process.exit(1);
const fs = require('fs'), path = require('path');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const REPO = path.resolve(arg('--repo', path.join(__dirname, '..', '..')));
const HOSTS = [
  ['claude', 'plugins/anti-hall/hooks/hooks.json'],
  ['codex', 'plugins/anti-hall/codex/hooks/hooks.json'],
];
// Hook entries a built-in check answers: event + script + args (the PostToolUse `--audit` pass is not ported).
const CHECKS = [
  ['git-guard', 'git'],
  ['command-guard', 'command'],
  ['merge-side-pick', 'merge-side-pick'],
  ['model-routing-guard', 'model-routing'],
  ['ship-it-guard', 'ship-it-guard'],
  ['scan-throttle', 'scan-throttle'],
  ['coordinator-work-guard', 'coordinator-work-guard'],
  ['compact-declaration-guard', 'compact-declaration-guard'],
].map(([script, check]) => ({ event: 'PreToolUse', script: script + '.js', args: '', check }));

const q = s => JSON.stringify(s); // TOML basic strings accept JSON string escapes for this content
function entries(hooks, event) {
  const out = [], seen = {};
  for (const g of hooks[event]) {
    for (const h of g.hooks) {
      const m = h.command.match(/\/hooks\/([^"\s]+)"?\s*(.*)$/);
      const script = m ? m[1] : h.command, args = m ? m[2].trim() : '';
      let id = script.replace(/\.js$/, '') + (args ? ':' + args.replace(/^-+/, '').replace(/\s+-*/g, ':') : '');
      seen[id] = (seen[id] || 0) + 1;
      if (seen[id] > 1) id += '#' + seen[id];
      const c = CHECKS.find(x => x.event === event && x.script === script && x.args === args);
      out.push({ id, matcher: g.matcher || '', command: h.command, timeout: h.timeout || 0, check: c ? c.check : '' });
    }
  }
  return out;
}

const OUT = path.resolve(arg('--out', path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'engine', 'defaults', 'dispatch.toml')));
const MARKER = '# ---- GENERATED TABLE BELOW';
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
const head = prev.includes(MARKER) ? prev.slice(0, prev.indexOf(MARKER)) : '';
let toml = head + MARKER + ` (parity/gen-dispatch.js from the plugin's hooks.json files; do not edit by hand) ----
# tests/dispatch_table.rs fails when hooks.json changes and this part does not: run node parity/gen-dispatch.js.
#
# One key per host and event: dispatch.hooks_<host>_<Event>. Each value lists the hook entries in hooks.json order
# (matcher groups in order, then handlers in order), which is the order the dispatcher combines their results in:
#   id       stable name of the entry within its event (script, then its arguments; "#n" for a repeat)
#   matcher  the hooks.json matcher ("" = every occurrence)
#   command  the exact hooks.json command: the Node hook the dispatcher runs when no built-in check answers
#   timeout  the hooks.json timeout in seconds (the host discards a hook that runs longer)
#   check    the built-in check that answers this entry in the engine ("" = always the Node hook)
`;
for (const [host, rel] of HOSTS) {
  const hooks = JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')).hooks;
  toml += `\n# ---- ${host}: ${rel} ----\n`;
  for (const event of Object.keys(hooks)) {
    toml += `\n[dispatch.hooks_${host}_${event}]\ndoc = ${q(`The ${host} ${event} hook entries, in ${rel} order.`)}\nvalue = [\n`;
    for (const e of entries(hooks, event)) {
      toml += `  { id = ${q(e.id)}, matcher = ${q(e.matcher)}, command = ${q(e.command)}, timeout = ${e.timeout}, check = ${q(e.check)} },\n`;
    }
    toml += ']\n';
  }
}
fs.writeFileSync(OUT, toml);
