# Mesh CLI verb inventory (`ah-engine mesh <argv>`)

Source of truth for the old CLI: `plugins/anti-hall-node/scripts/devswarm.js` + `devswarm-lib`.
Status columns: yes = handled natively, no = exit 69 `meshw:unhandled_verb` or usage error, partial = works minus a named piece.

## Forms that were NOT fully native before this change

| Form | Before | After | Notes |
|---|---|---|---|
| `inbox messages <id>` (+ `--limit --tail --since --unread --ack --ack-as-owner --legacy-ack-now`) | no | yes | history view; output byte-identical to Node on a copy of the live store |
| `inbox drain-primary-legacy <id>` | no | yes | shares the read-primary path |
| `inbox <unknown sub>` / bare `inbox` | no | yes | Node's error text, exit 2 |
| `inbox tick` with no id | no (invalid id) | yes | id from `DEVSWARM_BUILDER_ID`, else caller identity, else a usage line naming the id (new; Node refused) |
| `reconcile` | no | yes | calls native `dssup::recon::sweep::cmd_reconcile`; `no-project` outside a repo, same as Node |
| `read <id>` / `read --id` without `--db` | no (unknown command) | yes | resolves the project store from the cwd repo key; id held by exactly one other store is used; several = ambiguity error |
| `unread`, `dump` without `--db` | no | yes | same resolver |
| `prune-archived` | no | retired | message names `ah-engine devswarm plan-prune` / `prune`; exit 2 |
| any other unknown verb | exit 69 "report this site" | exit 2 | Node's `unknown command` list; text in `mesh_write.toml` |
| `inbox read-primary` / `peek-primary` / `messages` Jev triage | partial | partial | Jev triage still not ported |
| `roster --all --json` archived `worktreePath` / `meshId` | partial (null) | yes | see cause below |

## Everything else (unchanged, already yes)

`primary register ensure heartbeat inbox{read ack count pull tick read-primary ack-primary peek-primary} workspaces gate done nudge archive reap-orphans reconcile-registry unarchive archive-ignore archive-unignore archive-request register-primary migrate logs migrate-owner-keys send relay roster wake-directive app-state ...` (47 top-level verbs in Node; the rest were already native).

## Counts (forms listed above plus the already-native verbs)

Before: 7 no, 3 partial (Jev triage x3 unchanged) + roster partial; after: 0 no, 1 retired-with-replacement, partial = Jev triage only (3 forms).

## worktreePath null cause

`archived_rows()` in `ah-engine/src/meshw/rosterrows.rs` checked the descriptor had a worktreePath, then printed null for `worktreePath` and `meshId` (carried over from a Node bug in `roster-diag.js` ~671-677). Now both are filled; 17 archived rows, 0 null.
