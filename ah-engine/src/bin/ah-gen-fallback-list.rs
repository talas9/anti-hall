//! Write every file generated from the dispatch table (D87) into a checkout: per host the thin `hooks.json`, the per-hook
//! registry, the wrapper's fallback list and its fallback map, at the paths `dispatch.generated_files` names. The same
//! text `ah-engine gen-hooks` prints; `tests/hooks_files.rs` requires the committed files to equal it.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use ah_engine::dispatch::table;
use ah_engine::{defaults, hooksgen};
use std::env;
use std::fs;
use std::path::PathBuf;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let repo = PathBuf::from(arg("--repo").unwrap_or_else(|| ".".to_string()));
    for host in table::hosts() {
        let files = defaults::raw("dispatch.generated_files").get(host).and_then(|h| h.as_table()).unwrap_or(&[]);
        for (kind, path) in files {
            let target = repo.join(path.as_str().unwrap_or(""));
            let text = hooksgen::render(host, kind).unwrap_or_default();
            if let Err(e) = fs::write(&target, text) {
                eprintln!("{}: {e}", target.display());
                std::process::exit(1);
            }
        }
    }
}
