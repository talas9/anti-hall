//! One command that regenerates every committed generated file and says what changed:
//! `REFERENCE.md` (`ah-engine docs --format md`), per host the files generated from the dispatch table (the thin `hooks.json`,
//! the per-hook registry, the wrapper's fallback list: `ah-engine gen-hooks`) and the `anti-hall:engine` skill family.
//! The drift tests (`tests/it/{reference,hooks_files,roles}.rs`) name this command when a committed file is stale.
//!
//! `cargo run -q --bin ah-regen` rewrites the stale files and lists them; `--check` writes nothing and exits 1 when any file
//! is stale (the CI-safe form); `--repo <dir>` names the checkout (default: the one this crate lives in). Nothing is deleted:
//! a skill directory the registry no longer generates is left for a person to remove.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable or absent committed file is "stale" (the empty text differs from the generated one), not an error
// A failure that must be seen goes through `crate::discard` instead.

use ah_engine::dispatch::table;
use ah_engine::{defaults, docs, hooksgen, skillgen};
use std::path::{Path, PathBuf};
use std::{env, fs, process};

/// One generated file: where it goes (relative to the checkout) and what it should contain.
struct Target {
    rel: String,
    text: String,
}

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn targets() -> Vec<Target> {
    let mut v = vec![Target { rel: "ah-engine/REFERENCE.md".to_string(), text: docs::markdown() }];
    for host in table::hosts() {
        let files = defaults::raw("dispatch.generated_files").get(host).and_then(|h| h.as_table()).unwrap_or(&[]);
        for (kind, path) in files {
            v.push(Target { rel: path.as_str().unwrap_or("").to_string(), text: hooksgen::render(host, kind).unwrap_or_default() });
        }
    }
    for host in skillgen::hosts() {
        for s in skillgen::family(host) {
            v.push(Target { rel: format!("plugins/anti-hall/{}", s.path), text: s.text });
        }
    }
    v
}

fn main() {
    let check = env::args().any(|a| a == "--check");
    let repo = arg("--repo").map(PathBuf::from).unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join(".."));
    let (mut stale, mut total) = (0usize, 0usize);
    for t in targets() {
        total += 1;
        let path = repo.join(&t.rel);
        if fs::read_to_string(&path).unwrap_or_default() == t.text {
            continue;
        }
        stale += 1;
        if check {
            println!("stale    {}", t.rel);
            continue;
        }
        if let Some(dir) = path.parent()
            && let Err(e) = fs::create_dir_all(dir)
        {
            eprintln!("{}: {e}", dir.display());
            process::exit(2);
        }
        if let Err(e) = fs::write(&path, &t.text) {
            eprintln!("{}: {e}", path.display());
            process::exit(2);
        }
        println!("rewrote  {}", t.rel);
    }
    println!("{stale} of {total} generated files {}", if check { "are stale" } else { "rewritten" });
    if check && stale > 0 {
        process::exit(1);
    }
}
