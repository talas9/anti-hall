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

cat > package.json <<'EOF'
{ "name": "portal", "private": true, "dependencies": { "@acme/internal-utils": "^2.3.0", "left-pad": "^1.3.0" } }
EOF
cat > .npmrc <<'EOF'
@acme:registry=https://npm.acme.test/
EOF
cat > package-lock.json <<'EOF'
{
  "name": "portal",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/@acme/internal-utils": {
      "version": "2.3.1",
      "resolved": "https://npm.acme.test/@acme/internal-utils/-/internal-utils-2.3.1.tgz",
      "integrity": "sha512-PINNED-INTERNAL-SENTINEL-77aa"
    },
<<<<<<< HEAD
    "node_modules/left-pad": { "version": "1.3.0" }
=======
    "node_modules/left-pad": { "version": "1.2.0" }
>>>>>>> feature/forms
  }
}
EOF
git add -A; commit "Merge feature/forms (conflict in lockfile)"
