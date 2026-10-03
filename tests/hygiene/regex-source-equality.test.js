'use strict';
// regex-source-equality: long regex literals in the hooks were rebuilt from joined parts
// (so no single token is huge). Each rebuilt RegExp must keep exactly the original
// `.source` and `.flags`; the originals are copied below as multi-line concatenations.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLUGIN = path.resolve(__dirname, '..', '..', 'plugins', 'anti-hall');

const CASES = [
  ['hooks/model-routing-guard.js', 'DEPLOY_STRONG_RE',
    '\\b(deploy\\w*|redeploy\\w*|migrat\\w*|rollbacks?|roll\\s+back|token\\s+rotation|' +
    'rotat\\w*\\s+(?:the\\s+|a\\s+)?(?:api\\s+)?(?:tokens?|keys?|secrets?|credentials?)|' +
    'wrangler|terraform|kubectl\\s+apply|helm\\s+(?:install|upgrade)|firebase\\s+deploy|' +
    'db\\s+migrate)\\b',
    'i'],
  ['hooks/model-routing-guard.js', 'PLANNING_INTENT_RE',
    '\\b(architect(?:ure)?|brainstorm|design\\s+(?:a|the|an)\\b|plan\\s+(?:a|the|an|' +
    'out)\\b|deep\\s+review|code\\s+review|design\\s+review|security\\s+review|' +
    'review\\s+the\\s+(?:code|design|architecture|plan)|review\\s+(?:this|the|' +
    'a)\\s+(?:pr|pull\\s+request|diff|patch|change(?:s|set)?)|audit\\s+(?:the|this)\\b|' +
    'critique|debate|merge\\s+order|workflow\\s+analysis|root[- ]cause\\s+analysis|' +
    '(?:find|identify|determine|diagnose|trace)\\s+(?:the\\s+)?root[- ]cause|' +
    'root[- ]cause\\s+(?:why|how|the|this)|regression\\s+analysis|security\\s+audit)\\b',
    'i'],
  ['hooks/model-routing-guard.js', 'MECHANICAL_SHAPE_RE',
    '\\b(run\\s+exactly|run\\s+only|run\\s+(?:this|these|' +
    'the\\s+following)\\s+(?:exact\\s+)?commands?|exactly\\s+(?:this|these)\\s+commands?|' +
    'verbatim|append\\s*only|do\\s+nothing\\s+else|nothing\\s+else|' +
    'return\\s+(?:only\\s+)?(?:at\\s+most\\s+|no\\s+more\\s+than\\s+|under\\s+|' +
    'up\\s+to\\s+)?\\d+\\s+lines?)\\b|return\\s+(?:only\\s+)?(?:≤|<=)\\s*\\d+\\s+lines?\\b',
    'i'],
  ['hooks/model-routing-guard.js', 'REASONING_RE',
    '\\b(analy[sz]\\w*|synthesi[sz]\\w*|summari[sz]\\w*|reconcil\\w*|evaluat\\w*|' +
    'interpret\\w*|distill\\w*|compare|comparison)\\b|\\bread\\w*\\b[^.\\n]{0,60}\\b(?:pdf|' +
    'pdfs|pages?|papers?|documents?|specs?|transcripts?|articles?|books?|manuals?|' +
    'whitepapers?)\\b|\\b\\d+[- ]page\\b|\\bpage[- ]by[- ]page\\b',
    'i'],
  ['hooks/command-guard.js', 'NODE_EVAL_UNSAFE_RE',
    '\\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|' +
    'rmdir(?:Sync)?|mkdir(?:Sync)?|rename(?:Sync)?|truncate(?:Sync)?|chmod(?:Sync)?|' +
    'chown(?:Sync)?|symlink(?:Sync)?|copyFile(?:Sync)?|spawn(?:Sync)?|exec(?:Sync)?|' +
    'execFile(?:Sync)?|fork)\\s*\\(|child_process',
    ''],
  ['hooks/claim-ledger.js', 'RE_COUNT',
    '(?<![\\w.-])(\\d{1,6}(?:[.,]\\d+)?)\\s*(ms|s|sec|seconds|minutes|min|hours|days?|' +
    'weeks?|workspaces?|rows?|files?|lines?|tests?|bytes?|KB|MB|chars?|items?|' +
    'entries|messages?|hooks?|agents?|commits?|matches|unread|live)\\b',
    'gi'],
  ['hooks/command-guard.js', 'GIT_READONLY_RE',
    '\\bgit\\s+(?:status|log|diff|show|branch(?:\\s+--list)?|rev-parse|config\\s+--get|' +
    'config\\s+--list|worktree\\s+list|remote\\s+-v|shortlog|stash\\s+list|tag\\s+-l|' +
    'describe|ls-remote|ls-tree|merge-base|reflog\\s+show)\\b',
    'i'],
];

function evalConst(file, name) {
  const text = fs.readFileSync(path.join(PLUGIN, file), 'utf8');
  const start = text.indexOf('const ' + name + ' =');
  assert.ok(start >= 0, name + ' not found in ' + file);
  const end = text.indexOf('\n);', start);
  assert.ok(end > start, name + ' statement end not found');
  return vm.runInNewContext('(' + text.slice(start + ('const ' + name + ' =').length, end + 2).trim() + ')');
}

for (const [file, name, source, flags] of CASES) {
  test(name + ' keeps its original source and flags', () => {
    const re = evalConst(file, name);
    assert.ok(re instanceof RegExp || Object.prototype.toString.call(re) === '[object RegExp]');
    assert.strictEqual(re.source, new RegExp(source).source);
    assert.strictEqual(re.source, source);
    assert.strictEqual(re.flags, flags);
  });
}

test('no line of a rewritten regex declaration holds a token over 120 characters', () => {
  for (const [file] of CASES) {
    const text = fs.readFileSync(path.join(PLUGIN, file), 'utf8');
    for (const [, name] of CASES.filter((c) => c[0] === file)) {
      const i = text.indexOf('const ' + name + ' =');
      const block = text.slice(i, text.indexOf('\n);', i));
      for (const tok of block.split(/\s+/)) assert.ok(tok.length <= 120, name + ' has a ' + tok.length + '-char token');
    }
  }
});
