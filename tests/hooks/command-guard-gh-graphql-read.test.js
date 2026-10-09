'use strict';
require('../helpers/isolate-home.js');
// F4: a read-only `gh api graphql` call is not a mutation (conservative read
// set, Decision 9); everything outside the closed read set still blocks.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };

function run(command, opts) {
  const h = makeHome();
  try {
    return testHook(HOOK, bashPayload(command, opts), { home: h.home, env: COORD });
  } finally {
    h.cleanup();
  }
}

test('allows a plain viewer query', () => {
  assert.strictEqual(run("gh api graphql -f query='query { viewer { login } }'").status, 0);
});

test('allows the real row-152 repository query with --jq', () => {
  const cmd = `gh api graphql -f query='{repository(owner:"talas9",name:"anti-hall"){usesCustomOpenGraphImage openGraphImageUrl}}' --jq '.data.repository'`;
  assert.strictEqual(run(cmd).status, 0);
});

test('allows the /graphql endpoint spelling', () => {
  assert.strictEqual(run("gh api /graphql -f query='query{viewer{login}}' --jq .data").status, 0);
});

test('allows the `query Q { ... }` operation-name form', () => {
  assert.strictEqual(run("gh api graphql -f query='query Q { viewer { login } }'").status, 0);
});

test('allows an empty query= value', () => {
  assert.strictEqual(run("gh api graphql -f query=").status, 0);
});

const BLOCKED = [
  `gh api graphql -f query='mutation { addStar(input:{starrableId:"x"}) { clientMutationId } }'`,
  'gh api graphql -F query=@q.graphql',
  'gh api graphql -F query=x',
  'gh api graphql -f query="$(cat m.graphql)"',
  'gh api graphql -f query=`cat m`',
  'gh api graphql -f query=$Q',
  `gh api graphql -f query='query($o:String!){repository(owner:$o,name:"r"){id}}' -f o=talas9`,
  `gh api graphql -fquery='query{viewer{login}}'`,
  `gh api graphql --raw-field=query='query{viewer{login}}'`,
  `gh api graphql -X POST -f query='query{viewer{login}}'`,
  'gh api graphql --input b.json',
  `gh api graphql -f query='query{viewer{login}}' -f query='query{viewer{id}}'`,
  `gh api graphql -f query='query{viewer{login}}' --unknown-flag`,
  'gh api graphql -f',
  'gh api repos/o/r -X DELETE -f name=x',
];

for (const cmd of BLOCKED) {
  test(`blocks outside the read set: ${cmd}`, () => {
    assert.strictEqual(run(cmd).status, 2);
  });
}

test('subagent mutation stays exit 0', () => {
  const cmd = `gh api graphql -f query='mutation { addStar(input:{starrableId:"x"}) { clientMutationId } }'`;
  assert.strictEqual(run(cmd, { agentId: 'a1' }).status, 0);
});
