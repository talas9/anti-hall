//! Allocation budget of the scripted checks on a LONG command: one PreToolUse Bash call must not allocate in proportion to
//! (length x characters). A 15 KB command used to make `git`, `command` and `coordinator-work-guard` allocate 38-42 MB each (and
//! `merge-side-pick` 79 MB on a heredoc commit) because the logic built strings one character at a time (see
//! `tests/logic_charwise_concat.rs`). Budgets are in `tests/logic_lint.toml` `[logic_alloc]`. Own test binary: the counting
//! allocator and the measure knob are process-wide.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use ah_engine::memstat;
use ah_engine::reqenv::RequestEnv;
use serde_json::json;
use std::path::Path;

#[global_allocator]
static ALLOC: memstat::Counting = memstat::Counting;

const MIB: u64 = 1024 * 1024;

fn budgets() -> toml::Table {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/logic_lint.toml")).unwrap().parse::<toml::Table>().unwrap()["logic_alloc"]
        .as_table()
        .unwrap()
        .clone()
}

/// (allocated bytes, wall ms) of one call of `check` for `command` (after one unmeasured call that loads the check).
fn alloc_of(check: &str, command: &str, home: &Path) -> (u64, u128) {
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), home.to_string_lossy().into_owned())]);
    let payload = json!({
        "cwd": home, "hook_event_name": "PreToolUse", "session_id": "alloc-budget", "tool_name": "Bash",
        "tool_input": { "command": command }
    });
    let run = || ah_engine::script::run_forced(check, &payload, &json!({}), "PreToolUse", &env);
    memstat::configure_measure(false, 1);
    run();
    memstat::configure_measure(true, 1);
    let t = std::time::Instant::now();
    let (_, delta) = ah_engine::mem::measure(run);
    let ms = t.elapsed().as_millis();
    (delta.unwrap_or_else(|| panic!("{check}: the call was not measured (counting allocator not installed?)")).alloc, ms)
}

#[test]
fn long_commands_do_not_make_a_check_allocate_in_proportion_to_length_times_characters() {
    // judge THIS checkout's logic, not an installed plugin the state directory points at (an explicit AH_ENGINE_PLUGIN_ROOT still wins,
    // which is how the budget is shown to fail on another tree)
    if std::env::var_os("AH_ENGINE_PLUGIN_ROOT").is_none() {
        ah_engine::bootstrap::set_root_flag(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall"));
    }
    let b = budgets();
    let words = b["command_len_words"].as_integer().unwrap() as usize;
    let lines = b["heredoc_lines"].as_integer().unwrap() as usize;
    let echo = format!("echo {}", "word ".repeat(words));
    let line = "- line of a long commit message with some words and 'quotes' and $VAR and (parens) ; semicolons";
    let heredoc = format!("git commit -m \"$(cat <<'EOF'\n{}\nEOF\n)\" && git push origin main", vec![line; lines].join("\n"));

    // an UNQUOTED heredoc body expands, so the git check reads it position by position; many heredocs make the masking pass restart per heredoc
    // no expansion in the body: the scan then reads every position (a `$VAR` early on would end it at once)
    let plain = "- line of a long commit message with some words and 'quotes' and (parens) ; semicolons";
    let body = vec![plain; 15 * 1024 / (plain.len() + 1)].join("\n");
    let unquoted = format!("git commit -m \"$(cat <<EOF\n{body}\nEOF\n)\"");
    let many = "cat <<A\nx\nA\n".repeat(15 * 1024 / 14);

    let home = std::env::temp_dir().join(format!("ah-alloc-budget-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let home = std::fs::canonicalize(&home).unwrap();
    let mut over = Vec::new();
    for (table, command) in [("echo_mib", &echo), ("heredoc_mib", &heredoc), ("unquoted_heredoc_mib", &unquoted), ("many_heredocs_mib", &many)] {
        for (check, limit) in b[table].as_table().unwrap() {
            let limit = limit.as_integer().unwrap() as u64 * MIB;
            let (got, ms) = alloc_of(check, command, &home);
            println!("ALLOC {table} {check}: {} KiB (budget {} KiB), {ms} ms", got / 1024, limit / 1024);
            if got > limit {
                over.push(format!("{check} on {table}: {} KiB > {} KiB", got / 1024, limit / 1024));
            }
            // wall time too, where the cost of a bad scan is time, not bytes (the table name without `_mib`, then the check)
            let key = table.trim_end_matches("_mib");
            if let Some(max_ms) = b.get("max_ms").and_then(|t| t.get(key)).and_then(|t| t.get(check)).and_then(toml::Value::as_integer) {
                if ms > max_ms as u128 {
                    over.push(format!("{check} on {key}: {ms} ms > {max_ms} ms"));
                }
            }
        }
    }
    std::fs::remove_dir_all(&home).ok();
    assert!(over.is_empty(), "checks over their allocation budget on a {}-byte command:\n{}", echo.len(), over.join("\n"));
}
