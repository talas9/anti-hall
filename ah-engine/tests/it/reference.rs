//! D50: the generated reference is committed and cannot drift. `REFERENCE.md` must equal what
//! `ah-engine docs --format md` prints; when a command, setting, metric, impact kind, check or error code changes,
//! regenerate it (`cargo run -q -- docs --format md > REFERENCE.md`) in the same commit.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

#[test]
fn committed_reference_matches_the_generated_one() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("REFERENCE.md");
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    let generated = ah_engine::docs::markdown();
    if committed != generated
        && let Some(dir) = std::env::var_os("RUNNER_TEMP").or_else(|| std::env::var_os("TMPDIR")).or_else(|| std::env::var_os("TEMP"))
    {
        let out = std::path::PathBuf::from(dir).join("ah-engine-generated-reference.md");
        match std::fs::write(&out, &generated) {
            Ok(()) => {}
            Err(err) => panic!("failed to write {}: {err}", out.display()),
        }
    }
    assert!(
        committed == generated,
        "REFERENCE.md is out of date: run `cargo run -q -- docs --format md > REFERENCE.md` and commit it ({} bytes committed, {} generated)",
        committed.len(),
        generated.len()
    );
}

/// Every `.rs` file under `dir` (skipping test directories and `tests.rs` files), read.
fn rust_sources(dir: &std::path::Path, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if name != "tests" {
                rust_sources(&p, out);
            }
        } else if p.extension().is_some_and(|x| x == "rs") && name != "tests.rs" {
            out.push(std::fs::read_to_string(&p).unwrap_or_default());
        }
    }
}

/// Every file under `dir` with one of the extensions, read.
fn files_with(dir: &std::path::Path, exts: &[&str], out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            files_with(&p, exts, out);
        } else if p.extension().and_then(|x| x.to_str()).is_some_and(|x| exts.contains(&x)) {
            out.push(std::fs::read_to_string(&p).unwrap_or_default());
        }
    }
}

fn tokens(text: &str, prefix: &str, ok: impl Fn(char) -> bool) -> Vec<String> {
    let mut v = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(prefix) {
        let tail = &rest[i..];
        let end = tail.find(|c: char| !ok(c)).unwrap_or(tail.len());
        v.push(tail[..end].to_string());
        rest = &tail[end.max(prefix.len())..];
    }
    v
}

#[test]
fn every_environment_variable_in_the_sources_is_in_the_reference() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let plugin = manifest.join("../plugins/anti-hall");
    let mut texts = Vec::new();
    rust_sources(&manifest.join("src"), &mut texts);
    files_with(&plugin.join("hooks"), &["sh", "js"], &mut texts);
    files_with(&plugin.join("engine"), &["sh", "toml"], &mut texts);
    let generated = ah_engine::docs::markdown();
    let section = generated.split("\n## Environment variables\n").nth(1).and_then(|s| s.split("\n## ").next()).unwrap_or_default();
    let mut missing: Vec<String> = texts
        .iter()
        .flat_map(|t| tokens(t, "AH_ENGINE_", |c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
        .filter(|v| !v.ends_with('_') && !section.contains(&format!("`{v}`")))
        .collect();
    missing.sort();
    missing.dedup();
    assert!(
        missing.is_empty(),
        "environment variables read by the engine or its wrappers but missing from the reference's Environment variables section \
         (add an `[env.<name>]` entry with a doc to engine.toml): {missing:?}"
    );
}

#[test]
fn every_flag_in_the_sources_is_documented_or_external() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut texts = Vec::new();
    rust_sources(&manifest.join("src"), &mut texts);
    let documented: Vec<String> = ah_engine::docs::documented_flags().into_iter().map(|(f, _)| f).collect();
    let external = ah_engine::defaults::list("docs.external_flags");
    let mut missing: Vec<String> = texts
        .iter()
        .flat_map(|t| tokens(t, "\"--", |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '"'))
        .filter(|t| t.ends_with('"') && t.len() > 4)
        .map(|t| t.trim_matches('"').to_string())
        .filter(|f| !documented.contains(f) && !external.contains(&f.as_str()))
        .collect();
    missing.sort();
    missing.dedup();
    assert!(
        missing.is_empty(),
        "flags the engine's source mentions but no `[flag.<name>]` entry in flags.toml documents (a flag of another program belongs in \
         `docs.external_flags`): {missing:?}"
    );
}
