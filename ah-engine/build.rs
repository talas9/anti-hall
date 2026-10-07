//! Compiles `defaults/*.toml` into static Rust data (D17).
//!
//! Why at build time: the defaults are the single source of truth for every tunable, table and message, but parsing
//! the TOML at every hook-client start nearly doubled its start-up (3.7 to 3.8 ms against 1.9 to 2.1 ms, measured),
//! which defeats the thin client (D1). So the same files are parsed here, validated, and emitted as `static` data the
//! binary reads without parsing or allocating. A malformed or undocumented entry fails the build instead of a user's
//! hook call.
use std::fmt::Write as _;
use std::path::Path;

/// The shipped defaults files, in the order their entries are listed.
const FILES: [&str; 27] = [
    "engine.toml",
    "messages.toml",
    "git.toml",
    "command.toml",
    "commands.toml",
    "telemetry.toml",
    "storage.toml",
    "config.toml",
    "transcript.toml",
    "gitcache.toml",
    "schedules.toml",
    "small_guards.toml",
    "spawn_context.toml",
    "jev.toml",
    "dispatch.toml",
    "hooks.toml",
    "verify_first.toml",
    "prompt_emit.toml",
    "ctxbudget.toml",
    "session.toml",
    "response_guards.toml",
    "agent_controls.toml",
    "spawn_guards.toml",
    "session_gates.toml",
    "codex_handover.toml",
    "task_guards.toml",
    "devswarm_role.toml",
];

fn value(v: &toml::Value, out: &mut String) {
    match v {
        toml::Value::Integer(n) => {
            let _ = write!(out, "V::Int({n})");
        }
        toml::Value::Boolean(b) => {
            let _ = write!(out, "V::Bool({b})");
        }
        toml::Value::String(s) => {
            let _ = write!(out, "V::Str({s:?})");
        }
        toml::Value::Array(a) => {
            out.push_str("V::List(&[");
            for x in a {
                value(x, out);
                out.push_str(", ");
            }
            out.push_str("])");
        }
        toml::Value::Table(t) => {
            out.push_str("V::Table(&[");
            for (k, x) in t {
                let _ = write!(out, "({k:?}, ");
                value(x, out);
                out.push_str("), ");
            }
            out.push_str("])");
        }
        other => panic!("defaults: unsupported TOML value {other:?} (use integers, booleans, strings, arrays and tables)"),
    }
}

fn opt_str(t: &toml::Table, k: &str) -> String {
    match t.get(k).and_then(toml::Value::as_str) {
        Some(s) => format!("Some({s:?})"),
        None => "None".into(),
    }
}

fn opt_int(t: &toml::Table, k: &str) -> String {
    match t.get(k).and_then(toml::Value::as_integer) {
        Some(n) => format!("Some({n})"),
        None => "None".into(),
    }
}

fn main() {
    let root = Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("defaults");
    let mut entries = String::new();
    let mut keys: Vec<(String, usize)> = Vec::new();
    let mut n = 0usize;
    // `defaults/hooks.d/*.toml` (D87): one file per batch of ported hooks, each holding that batch's `[events.<Event>]` and
    // `[entries."<id>"]` defaults, so parallel lanes add files instead of editing a shared one. Sorted by name, after FILES.
    let mut files: Vec<String> = FILES.iter().map(|f| f.to_string()).collect();
    println!("cargo:rerun-if-changed={}", root.join("hooks.d").display());
    if let Ok(rd) = std::fs::read_dir(root.join("hooks.d")) {
        let mut extra: Vec<String> =
            rd.flatten().filter_map(|e| e.file_name().to_str().filter(|n| n.ends_with(".toml")).map(|n| format!("hooks.d/{n}"))).collect();
        extra.sort();
        files.extend(extra);
    }
    for file in files.iter().map(String::as_str) {
        let path = root.join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let table: toml::Table = text.parse().unwrap_or_else(|e| panic!("{file} does not parse: {e}"));
        for (section, body) in &table {
            let body = body.as_table().unwrap_or_else(|| panic!("{file}: [{section}] must be a table of settings"));
            for (name, e) in body {
                let key = format!("{section}.{name}");
                let e = e.as_table().unwrap_or_else(|| panic!("{file}: {key} must be a table with `value` and `doc`"));
                let doc = e.get("doc").and_then(toml::Value::as_str).unwrap_or_else(|| panic!("{file}: {key} has no `doc`"));
                assert!(doc.trim().ends_with('.'), "{file}: {key}: doc must be a sentence ending in a period: {doc:?}");
                let v = e.get("value").unwrap_or_else(|| panic!("{file}: {key} has no `value`"));
                for k in e.keys() {
                    assert!(["value", "doc", "env", "min", "max", "unit"].contains(&k.as_str()), "{file}: {key}: unknown field {k:?}");
                }
                let mut vs = String::new();
                value(v, &mut vs);
                let _ = writeln!(
                    entries,
                    "    Entry {{ key: {key:?}, file: {file:?}, value: {vs}, doc: {doc:?}, env: {}, min: {}, max: {}, unit: {} }},",
                    opt_str(e, "env"),
                    opt_int(e, "min"),
                    opt_int(e, "max"),
                    opt_str(e, "unit")
                );
                keys.push((key, n));
                n += 1;
            }
        }
    }
    keys.sort();
    for w in keys.windows(2) {
        assert!(w[0].0 != w[1].0, "defaults: duplicate key {}", w[0].0);
    }
    let mut index = String::new();
    for (k, i) in &keys {
        let _ = writeln!(index, "    ({k:?}, {i}),");
    }
    let code = format!(
        "// @generated by build.rs from defaults/*.toml; do not edit.\n/// Every shipped setting, in file order.\npub static ENTRIES: &[Entry] = &[\n{entries}];\n/// (key, position in `ENTRIES`), sorted by key for binary search.\npub static INDEX: &[(&str, usize)] = &[\n{index}];\n"
    );
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("defaults_gen.rs");
    std::fs::write(out, code).unwrap();
}
