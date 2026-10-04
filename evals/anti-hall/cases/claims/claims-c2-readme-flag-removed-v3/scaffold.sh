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

mkdir -p src
cat > src/cli.js <<'EOF'
#!/usr/bin/env node
'use strict';
const KNOWN = ['--target', '--verbose', '--yes'];
for (const a of process.argv.slice(2)) if (a.startsWith('--') && !KNOWN.includes(a)) { console.error('unknown flag ' + a); process.exit(2); }
console.log('syncing');
EOF
cat > README.md <<'EOF'
# sync-cli

## Usage

    sync --target <env>     sync to an environment
    sync --dry-run          show what would change without writing
    sync --verbose          more output
    sync --yes              skip the confirmation prompt
EOF
git add -A; commit "sync cli"
printf '# Changelog\n\n## 2.0.0\n- Removed --dry-run; use "sync plan" instead (coming in 2.1).\n' > CHANGELOG.md
git add -A; commit "Remove --dry-run"
