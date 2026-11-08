//! Allocation budget of the scripted checks on a LONG command: one PreToolUse Bash call must not allocate in proportion to
//! (length x characters). A 15 KB command used to make `git`, `command` and `coordinator-work-guard` allocate 38-42 MB each (and
//! `merge-side-pick` 79 MB on a heredoc commit) because the logic built strings one character at a time (see
//! `tests/logic_charwise_concat.rs`). Budgets are in `tests/logic_lint.toml` `[logic_alloc]`. Own test binary: the counting
//! allocator is process-wide.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use ah_engine::memstat;
use ah_engine::reqenv::RequestEnv;
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout};
use std::cell::Cell;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

// Why not `memstat`'s `alloc` total: QuickJS-ng serves blocks of up to 512 bytes from arenas of at most 4 KiB and frees an arena the
// moment its last block goes. A scanner that makes and drops a one-character string per step then pays one arena malloc/free per
// step whenever no other live block pins that arena, and whether one does depends on the heap layout, i.e. on the size and order of
// the lib files loaded into the shared context (measured: one unused `var` in a lib file moved git on 15 KB of `a>|b ` from 7.1 to 8.8
// MiB; another lib file moved it to 94 MiB = 22722 arena refills of 4080 bytes). That churn is neither a regression of the check nor
// bounded by its logic, so it is not counted: only requests above the arena size (`arena_max_bytes` in logic_lint.toml), where a
// string built character by character shows its copying, are.
struct BigOnly;

static MIN_BIG: AtomicUsize = AtomicUsize::new(usize::MAX);

thread_local! {
    static BIG: Cell<u64> = const { Cell::new(0) };
}

fn note(size: usize) {
    if size > MIN_BIG.load(Ordering::Relaxed) {
        BIG.with(|b| b.set(b.get().wrapping_add(size as u64)));
    }
}

// SAFETY: every method forwards to `memstat::Counting` unchanged and only adds to a per-thread counter that never allocates.
unsafe impl GlobalAlloc for BigOnly {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        note(l.size());
        // SAFETY: forwarded unchanged from this unsafe `GlobalAlloc::alloc` call.
        unsafe { memstat::Counting.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        note(l.size());
        // SAFETY: forwarded unchanged from this unsafe `GlobalAlloc::alloc_zeroed` call.
        unsafe { memstat::Counting.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        // SAFETY: forwarded unchanged from this unsafe `GlobalAlloc::dealloc` call.
        unsafe { memstat::Counting.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        note(new);
        // SAFETY: forwarded unchanged from this unsafe `GlobalAlloc::realloc` call.
        unsafe { memstat::Counting.realloc(p, l, new) }
    }
}

#[global_allocator]
static ALLOC: BigOnly = BigOnly;

const MIB: u64 = 1024 * 1024;

fn budgets() -> toml::Table {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/logic_lint.toml")).unwrap().parse::<toml::Table>().unwrap()["logic_alloc"]
        .as_table()
        .unwrap()
        .clone()
}

/// Bytes of the requests above the arena size that one call of `check` for `command` made (after one unmeasured call that loads the check).
fn alloc_of(check: &str, command: &str, home: &Path) -> u64 {
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), home.to_string_lossy().into_owned())]);
    let payload = json!({
        "cwd": home, "hook_event_name": "PreToolUse", "session_id": "alloc-budget", "tool_name": "Bash",
        "tool_input": { "command": command }
    });
    let run = || ah_engine::script::run_forced(check, &payload, &json!({}), "PreToolUse", &env);
    run();
    let before = BIG.with(Cell::get);
    run();
    let n = BIG.with(Cell::get).wrapping_sub(before);
    // a script call that moved off the calling thread would count 0 here and pass every budget silently
    assert!(n > 0, "no large allocation counted for `{check}`: the call no longer runs on the measuring thread");
    n
}

#[test]
fn long_commands_do_not_make_a_check_allocate_in_proportion_to_length_times_characters() {
    // judge THIS checkout's logic, not an installed plugin the state directory points at (an explicit AH_ENGINE_PLUGIN_ROOT still wins,
    // which is how the budget is shown to fail on another tree)
    if std::env::var_os("AH_ENGINE_PLUGIN_ROOT").is_none() {
        ah_engine::bootstrap::set_root_flag(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall"));
    }
    let b = budgets();
    MIN_BIG.store(b["arena_max_bytes"].as_integer().unwrap() as usize, Ordering::Relaxed);
    let words = b["command_len_words"].as_integer().unwrap() as usize;
    let lines = b["heredoc_lines"].as_integer().unwrap() as usize;
    let echo = format!("echo {}", "word ".repeat(words));
    let line = "- line of a long commit message with some words and 'quotes' and $VAR and (parens) ; semicolons";
    let heredoc = format!("git commit -m \"$(cat <<'EOF'\n{}\nEOF\n)\" && git push origin main", vec![line; lines].join("\n"));

    // text that makes the segment scanner look at the segment so far at every `}` / `>|` / `&`: joining at each read would bring the cost back
    let braces = format!("echo {}", "a} ".repeat(5000));
    let redirects = format!("echo {}", "a>|b ".repeat(3000));

    let home = std::env::temp_dir().join(format!("ah-alloc-budget-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let home = std::fs::canonicalize(&home).unwrap();
    let mut over = Vec::new();
    for (table, command) in [("echo_mib", &echo), ("heredoc_mib", &heredoc), ("braces_mib", &braces), ("redirects_mib", &redirects)] {
        for (check, limit) in b[table].as_table().unwrap() {
            let limit = limit.as_integer().unwrap() as u64 * MIB;
            let got = alloc_of(check, command, &home);
            println!("ALLOC {table} {check}: {} KiB (budget {} KiB)", got / 1024, limit / 1024);
            if got > limit {
                over.push(format!("{check} on {table}: {} KiB > {} KiB", got / 1024, limit / 1024));
            }
        }
    }
    std::fs::remove_dir_all(&home).ok();
    assert!(over.is_empty(), "checks over their allocation budget on a {}-byte command:\n{}", echo.len(), over.join("\n"));
}
