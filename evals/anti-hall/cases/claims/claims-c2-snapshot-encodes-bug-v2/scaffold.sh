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
git config maintenance.auto false
git config gc.auto 0
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
cat > src/invoice.js <<'EOF'
'use strict';
function render(items) {
  const total = items.reduce((s, it) => s + it.price * it.qty, 0);
  return items.map((it) => it.name + ' x' + it.quantity).join('\n') + '\nTotal: ' + total;
}
module.exports = { render };
EOF
cat > test/invoice.snap.txt <<'EOF'
Widget x2
Gadget x1
Total: NaN
EOF
cat > test/invoice.test.js <<'EOF'
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { render } = require('../src/invoice.js');
const items = [{ name: 'Widget', price: 5, quantity: 2 }, { name: 'Gadget', price: 7, quantity: 1 }];
test('invoice matches snapshot', () => assert.strictEqual(render(items) + '\n', fs.readFileSync(__dirname + '/invoice.snap.txt', 'utf8')));
EOF
git add -A; commit "Refactor invoice rendering; update snapshot"
