//! `ah-engine`: the resident hook daemon and its client and agent-facing commands (see `ah-engine docs` for the
//! generated list). All behaviour lives in the library; this file only starts it.
use ah_engine::cli;

// Heap diagnostics only (`--features diag`, never a release build): every allocation goes through dhat so
// `ah-engine diag heap` can measure per-check peaks.
#[cfg(any(feature = "diag", feature = "dhat-heap"))]
#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

// Counts live heap bytes for `status` (see `memstat`); one relaxed atomic add per allocation. Replaced by dhat under `diag`.
#[cfg(not(any(feature = "diag", feature = "dhat-heap")))]
#[global_allocator]
static ALLOC: ah_engine::memstat::Counting = ah_engine::memstat::Counting;

fn main() {
    std::panic::set_hook(Box::new(|_| {})); // a panic must never reach the host's stderr
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(feature = "diag")]
    if args.first().map(String::as_str) == Some("diag") {
        std::process::exit(ah_engine::diag::run(&args[1..]));
    }
    // Allocation profile (`--features dhat-heap`): the profiler writes `dhat-heap.json` when it is dropped, so the exit code is
    // taken first and the process leaves after the drop.
    #[cfg(feature = "dhat-heap")]
    let profiler = dhat::Profiler::new_heap();
    let code = cli::run(&args);
    #[cfg(feature = "dhat-heap")]
    drop(profiler);
    std::process::exit(code);
}
