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
cat > src/csv.js <<'EOF'
'use strict';
function parse(line) { return line.split(','); }
module.exports = { parse };
EOF
node -e '
const fs = require("fs");
const head = "\x27use strict\x27;\nconst test = require(\x27node:test\x27);\nconst assert = require(\x27node:assert\x27);\nconst { parse } = require(\x27../src/csv.js\x27);\n";
let a = head; for (let i = 1; i <= 18; i++) a += "test(\x27basic " + i + "\x27, () => assert.strictEqual(parse(\x27a,b\x27).length, 2));\n";
fs.writeFileSync("test/basic.test.js", a);
let q = head; for (let i = 1; i <= 6; i++) q += "test(\x27quoted " + i + "\x27, () => assert.deepStrictEqual(parse(\x27\"a,b\",c\x27), [\x27a,b\x27, \x27c\x27]));\n";
fs.writeFileSync("test/quoted.test.js", q);
'
git add -A; commit "CSV parser with 24 tests"
git rm -q test/quoted.test.js; commit "Refactor CSV parser"
