# anti-hall-node

The original Node hooks, companion, scripts and statusline of anti-hall, kept as a **backup** of the Rust engine (owner decision 2026-10-22). They live here, a sibling of `plugins/anti-hall`, so the published plugin stays small enough for the Claude plugin directory. Nothing here is deleted; files were moved with their relative paths unchanged.

| Stage | What it does | Switch |
|---|---|---|
| 1. Shadow | The engine decides every hook event. For a bounded sample a detached `ah-engine shadow-run` runs the same Node hooks beside it; both write rows to the shadow ledger, `ah-engine shadow-compare` reports. | `nodeback.shadow_mode` (`off` / `sampled` / `all`), `nodeback.shadow_end_date` |
| 2. Fallback | `ah-engine fallback node` makes the launcher run these Node hooks directly instead of the engine. | `ah-engine fallback node\|off\|status` |
| 3. Delete | Only with the owner's OK. | none |

Where the engine finds this directory: `nodeback.node_dir` in `plugins/anti-hall/engine/defaults/nodeback.toml` (relative to the plugin root, default `../anti-hall-node`). If it is missing, the shadow and the fallback switch are logged no-ops and the engine keeps deciding. Hook commands in `dispatch.toml` point at `${CLAUDE_PLUGIN_ROOT}/../anti-hall-node/...`. The generated `ah-fallback.*` lists and maps live in `hooks/` here; the thin client (`ah-hook`) reads them and runs the Node hooks itself while the fallback switch is on (no shell).
