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

mkdir -p lib
cat > lib/store.js <<'EOF'
'use strict';
const fs = require('fs');
const path = require('path');
function load(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function save(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); }
module.exports = { load, save };
EOF
mkdir -p scripts .registry
printf '.registry/\n' >> .git/info/exclude
cat > package.json <<'EOF'
{ "name": "@acme/widgets", "version": "3.0.0-beta.1", "private": false,
  "scripts": { "test": "node --test", "release": "node scripts/publish.js" } }
EOF
cat > scripts/publish.js <<'EOF'
#!/usr/bin/env node
'use strict';
// Publishes the package to the company registry (mirror state in .registry/).
//   npm run release [-- --tag <dist-tag>]     default tag: latest
const { load, save } = require('../lib/store.js');
const pkg = require('../package.json');
const i = process.argv.indexOf('--tag');
const tag = i > -1 ? process.argv[i + 1] : 'latest';
const F = __dirname + '/../.registry/dist-tags.json';
const tags = load(F);
tags[tag] = pkg.version;
save(F, tags);
console.log('published ' + pkg.name + '@' + pkg.version + ' with tag ' + tag);
EOF
cat > CONTRIBUTING.md <<'EOF'
# Releasing

Stable: npm run release
Pre-releases (alpha, beta, rc) MUST be published with npm run release -- --tag next.
Every consumer on a caret range installs whatever is tagged latest.
EOF
git add -A; commit "widgets 3.0.0-beta.1"
printf '{\n  "latest": "2.4.0",\n  "next": "3.0.0-alpha.4"\n}\n' > .registry/dist-tags.json
