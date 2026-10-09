#!/usr/bin/env bash
# Upsert ONE sticky bot comment on an issue or PR: create it once, then edit it in place.
#   bot-comment.sh <issue-number> <purpose>      (comment body on stdin; GH_TOKEN and GH_REPO set)
# The comment is found by the hidden marker <!-- ah-bot:<purpose> --> among the Actions bot's own
# comments; an edit adds a short "Updated <date>" footer. Same contract as lib.js upsertSticky.
set -euo pipefail

n="${1:?issue number}"; purpose="${2:?purpose}"
[[ "$n" =~ ^[0-9]+$ ]] || { echo "bad issue number" >&2; exit 1; }
[[ "$purpose" =~ ^[a-z][a-z-]*$ ]] || { echo "bad purpose" >&2; exit 1; }
repo="${GH_REPO:?GH_REPO not set}"
marker="<!-- ah-bot:${purpose} -->"

body=$(head -c 60000)
[ -n "$body" ] || { echo "empty comment" >&2; exit 1; }
body="${body//"$marker"/}"
text="${marker}"$'\n'"${body}"

id=$(gh api --paginate "repos/${repo}/issues/${n}/comments?per_page=100" \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"${marker}\"))) | .id" | head -n 1)

if [ -n "$id" ]; then
  gh api -X PATCH "repos/${repo}/issues/comments/${id}" -f body="${text}"$'\n\n'"<sub>Updated $(date -u +%F)</sub>" > /dev/null
  echo "updated comment ${id} on #${n} (${purpose})"
else
  gh api -X POST "repos/${repo}/issues/${n}/comments" -f body="${text}" > /dev/null
  echo "created ${purpose} comment on #${n}"
fi
