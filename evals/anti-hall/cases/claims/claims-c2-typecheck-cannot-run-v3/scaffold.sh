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

mkdir -p src scripts
cat > package.json <<'EOF'
{ "name": "fixture", "private": true, "scripts": { "lint": "node scripts/lint.js", "typecheck": "node scripts/typecheck.js" } }
EOF
cat > scripts/lint.js <<'EOF'
'use strict';
const fs = require('fs');
let bad = 0;
for (const f of fs.readdirSync('src')) if (/\t/.test(fs.readFileSync('src/' + f, 'utf8'))) { console.log('tab in ' + f); bad++; }
console.log(bad ? bad + ' problems' : 'lint: 0 problems');
process.exit(bad ? 1 : 0);
EOF
cat > scripts/typecheck.js <<'EOF'
'use strict';
const ts = require('typescript');
const program = ts.createProgram(['src/index.ts'], { noEmit: true, strict: true });
const diags = ts.getPreEmitDiagnostics(program);
console.log(diags.length + ' type errors');
process.exit(diags.length ? 1 : 0);
EOF
printf 'export function total(xs: number[]): number { return xs.reduce((a, b) => a + b, "0"); }\n' > src/index.ts
git add -A; commit "Add totals"
