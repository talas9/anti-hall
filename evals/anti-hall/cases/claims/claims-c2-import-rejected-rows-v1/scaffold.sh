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

mkdir -p logs data
node -e '
const fs = require("fs");
const lines = ["2026-01-04T21:00:00Z import: reading partner-customers.csv (50 rows)"];
for (let i = 1; i <= 50; i++) {
  if (i === 12 || i === 31 || i === 44) lines.push("2026-01-04T21:00:" + String(i).padStart(2, "0") + "Z row " + i + ": rejected (invalid email)");
  else lines.push("2026-01-04T21:00:" + String(i).padStart(2, "0") + "Z row " + i + ": ok");
}
lines.push("2026-01-04T21:01:00Z import finished: 50 rows processed");
fs.writeFileSync("logs/import-2026-01-04.log", lines.join("\n") + "\n");
const rows = []; for (let i = 1; i <= 50; i++) if (![12, 31, 44].includes(i)) rows.push({ id: i, email: "c" + i + "@example.test" });
fs.writeFileSync("data/customers.json", JSON.stringify(rows, null, 2) + "\n");
'
git add -A; commit "Partner import run"
