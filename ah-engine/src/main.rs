//! `ah-engine`: the resident hook daemon and its client and agent-facing commands (see `ah-engine docs` for the
//! generated list). All behaviour lives in the library; this file only starts it.
use ah_engine::cli;

// Heap diagnostics only (`--features diag`, never a release build): every allocation goes through dhat so
// `ah-engine diag heap` can measure per-check peaks.
#[cfg(feature = "diag")]
#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

// Counts live heap bytes for `status` (see `memstat`); one relaxed atomic add per allocation. Replaced by dhat under `diag`.
#[cfg(not(feature = "diag"))]
#[global_allocator]
static ALLOC: ah_engine::memstat::Counting = ah_engine::memstat::Counting;

fn main() {
    ah_engine::crash::install_panic_hook();
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(feature = "diag")]
    if args.first().map(String::as_str) == Some("diag") && args.get(1).map(String::as_str) == Some("heap") {
        std::process::exit(ah_engine::diag::run(&args[1..]));
    }
    // a panic is recorded by the hook; a write to a closed pipe (`ah-engine docs | head`) is the reader leaving, so exit
    // quietly with the SIGPIPE convention (128 + 13) instead of the panic exit code
    let code = std::panic::catch_unwind(|| cli::run(&args)).unwrap_or_else(|_| if ah_engine::crash::broken_pipe_seen() { 141 } else { 101 });
    std::process::exit(code);
}
