//! `ah-engine migrate [--dry-run] [--home <dir>] [--cwd <dir>] [--plugin-root <dir>] [--json]`: the persisted-state migrations
//! and sweeps (see the module docs of [`super`]). This is a command-line process, so its own environment is the right one to
//! read (the daemon never answers a request from its environment, D76).
use super::{Ctx, Row, plugin_version, report, run};
use crate::checks::jsport::json;
use crate::cli::Parsed;
use crate::defaults;
use std::collections::BTreeMap;

/// The value after `--<name>`, if present.
fn flag(p: &Parsed, name: &str) -> Option<String> {
    let f = format!("--{name}");
    p.rest.iter().position(|a| *a == f).and_then(|i| p.rest.get(i + 1)).cloned()
}

/// True when the flag is present.
fn has(p: &Parsed, name: &str) -> bool {
    let f = format!("--{name}");
    p.rest.contains(&f)
}

/// The context of a run: flags first, then this process's environment and working directory.
pub(crate) fn context(p: &Parsed) -> Result<(Ctx, String), String> {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let home = flag(p, "home")
        .or_else(|| env.get(defaults::env_name("home")).cloned())
        .or_else(|| env.get(defaults::env_name("home_alt")).cloned())
        .filter(|h| !h.is_empty())
        .ok_or_else(|| defaults::text("migrate_msg.no_home").to_string())?;
    if test_marked(&env) && crate::checks::jsport::home::real_home().is_some_and(|r| r == home) {
        return Err(defaults::render("migrate_msg.real_home_refused", &[("home", &home)]));
    }
    let cwd = match flag(p, "cwd") {
        Some(c) => c,
        None => std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).map_err(|e| defaults::render("migrate_msg.no_cwd", &[("error", &e)]))?,
    };
    let plugin_root = flag(p, "plugin-root").or_else(|| env.get(defaults::env_name("plugin_root")).cloned()).filter(|r| !r.is_empty());
    let mut ctx = Ctx::new(home, cwd, env, has(p, "dry-run"), None, plugin_root.clone());
    ctx.version = plugin_root.as_deref().and_then(|r| plugin_version(&ctx, r));
    let shown = ctx.version.clone().unwrap_or_else(|| defaults::text("migrate_msg.unknown_version").to_string());
    Ok((ctx, shown))
}

/// A test marker is set: a state-changing run must not touch the real home (the Node guard's rule).
fn test_marked(env: &BTreeMap<String, String>) -> bool {
    defaults::list("migrate.test_markers").iter().any(|k| env.get(*k).is_some_and(|v| !v.is_empty()))
}

/// Print the rows for a person.
fn human(rows: &[Row]) -> String {
    let mut out: Vec<String> =
        rows.iter().map(|r| defaults::render("migrate_msg.row_line", &[("status", &r.status), ("id", &r.id), ("msg", &r.msg)])).collect();
    let count = |s: &str| rows.iter().filter(|r| r.status == s).count();
    out.push(defaults::render("migrate_msg.summary", &[("fixed", &count("fixed")), ("skipped", &count("skipped")), ("failed", &count("failed"))]));
    out.join("\n")
}

/// The `migrate` command.
pub fn run_migrate(p: &Parsed) -> i32 {
    let (ctx, shown) = match context(p) {
        Ok(c) => c,
        Err(e) => {
            if p.json {
                println!("{}", json::stringify(&json::J::Obj(vec![("error".into(), json::J::Str(e))])));
            } else {
                eprintln!("{e}");
            }
            return 1;
        }
    };
    let rows = run(&ctx);
    for n in ctx.take_notes() {
        eprintln!("{}", defaults::render("migrate_msg.note_line", &[("note", &n)]));
    }
    let failed = rows.iter().any(|r| r.status == "failed");
    if p.json {
        println!("{}", json::stringify(&report(&shown, &rows, None)));
    } else {
        println!("{}", human(&rows));
    }
    i32::from(failed)
}
