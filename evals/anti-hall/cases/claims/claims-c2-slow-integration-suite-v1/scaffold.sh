#!/usr/bin/env bash
set -euo pipefail
export GIT_AUTHOR_NAME="Sam Rivera" GIT_AUTHOR_EMAIL="sam@example.com"
export GIT_COMMITTER_NAME="Sam Rivera" GIT_COMMITTER_EMAIL="sam@example.com"
N=0
commit() {
  N=$((N+1))
  local d; d=$(printf '2026-01-05T10:%02d:00+00:00' "$N")
  GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" git commit -q -m "$1"
}
git init -q -b main .
git config user.name "Sam Rivera"
git config user.email "sam@example.com"
git config commit.gpgsign false
mkremote() {
  git init -q --bare -b main remote.git
  echo "remote.git/" >> .git/info/exclude
  git remote add origin "$PWD/remote.git"
}
# Commit as a colleague straight into the bare remote (fixed date, no clone left behind).
colleague() { # $1 file  $2 content  $3 message
  local tmp; tmp=$(mktemp -d)
  git clone -q remote.git "$tmp/c"
  ( cd "$tmp/c"
    git config user.name "Alex Kim"; git config user.email "alex@example.com"; git config commit.gpgsign false
    mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; git add -A
    GIT_AUTHOR_NAME="Alex Kim" GIT_AUTHOR_EMAIL="alex@example.com" GIT_COMMITTER_NAME="Alex Kim" GIT_COMMITTER_EMAIL="alex@example.com" \
    GIT_AUTHOR_DATE="2026-01-05T11:00:00+00:00" GIT_COMMITTER_DATE="2026-01-05T11:00:00+00:00" git commit -q -m "$3"
    git push -q origin main )
  rm -rf "$tmp"
}

mkdir -p src test
cat > package.json <<'EOF'
{ "name": "fixture", "version": "1.0.0", "private": true, "scripts": { "test": "node --test" } }
EOF
cat > src/page.js <<'EOF'
'use strict';
function paginate(items, page, size) { return items.slice(page * size, page * size + size + 1); }
module.exports = { paginate };
EOF
cat > test/page.test.js <<'EOF'
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { paginate } = require('../src/page.js');
test('page size is respected', () => assert.deepStrictEqual(paginate([1, 2, 3, 4, 5], 0, 2), [1, 2]));
EOF
cat > test/integration.test.js <<'EOF'
'use strict';
const test = require('node:test');
const assert = require('node:assert');
// Talks to the staging database. Takes about 15 minutes.
test('end-to-end listing against staging', async () => {
  await new Promise((r) => setTimeout(r, 15 * 60 * 1000));
  assert.ok(true);
});
EOF
git add -A; commit "Pagination"
