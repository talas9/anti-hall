//! `ah-engine codex-limit-status` and `codex-activate`: the two Codex-only helper scripts (`codex/scripts/limit-conserve-status.js`
//! and `write-activation-sentinel.js`) as verbs (v1.0 lane L16). This file only resolves the inputs (the limit-conservation
//! settings through the settings store, the working directory, the clock) and prints what the plugin script
//! `engine/logic/rules/codex-scripts.js` returns; the decision and the files' content are that script's.
use super::{env_snapshot, err, home, out, plugin_root};
use crate::checks::jsport::date::{now_ms, to_iso};
use crate::checks::jsport::json::J;
use crate::cli::Parsed;
use crate::defaults;
use crate::migrate::settings as store;
use crate::migrate::{Ctx, plugin_version};
use serde_json::{Value, json};

fn spec() -> &'static defaults::V {
    defaults::raw("codex_scripts.script")
}

fn call(entry_key: &str, args: &Value) -> Option<Value> {
    let s = spec();
    crate::script::call_fn(s.str_field("script"), s.str_field(entry_key), args)
}

fn no_script(verb: &str) -> i32 {
    err(&(defaults::render("codex_scripts.err_script", &[("verb", &verb)]) + "\n"));
    1
}

/// A limitConserve setting as the store answers it (environment, file, plugin option) and the tier it came from.
fn setting(ctx: &Ctx, key: &str) -> (Option<J>, &'static str) {
    let entry = store::find("limitConserve", key);
    (entry.and_then(|e| store::get(ctx, e, None)), entry.map_or("default", |e| store::source(ctx, e)))
}

/// `codex-limit-status`
pub fn cmd_limit_status(p: &Parsed) -> i32 {
    let _ = p;
    let env = env_snapshot();
    let home = home(&env);
    let root = plugin_root(&env);
    let mut ctx = Ctx::new(home.clone(), String::new(), env, false, None, root.clone());
    ctx.version = root.as_deref().and_then(|r| plugin_version(&ctx, r));
    let (mode, mode_src) = setting(&ctx, "mode");
    let (threshold, _) = setting(&ctx, "threshold");
    let (check, _) = setting(&ctx, "accountCheck");
    let str_of = |j: Option<J>, d: &str| match j {
        Some(J::Str(s)) => s,
        _ => d.to_string(),
    };
    let mode = str_of(mode, defaults::raw("ctxbudget.set_limit_mode").str_field("default"));
    let threshold = match threshold {
        Some(J::Num(n)) => n,
        _ => defaults::raw("ctxbudget.set_limit_threshold").get("default").and_then(defaults::V::as_integer).unwrap_or_default() as f64,
    };
    let check = !matches!(check, Some(J::Bool(false)));
    let input = json!({"home": home, "mode": mode, "modeSource": mode_src, "threshold": threshold, "accountCheck": check});
    match call("status", &input).and_then(|v| v.get("text").and_then(Value::as_str).map(str::to_string)) {
        Some(text) => {
            out(&text);
            0
        }
        None => no_script("codex-limit-status"),
    }
}

/// `codex-activate`
pub fn cmd_activate(p: &Parsed) -> i32 {
    let _ = p;
    let env = env_snapshot();
    let home = home(&env);
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let input = json!({"at": to_iso(now_ms()).unwrap_or_default(), "cwd": cwd});
    let path = format!("{home}/{}", defaults::text("codex_scripts.sentinel_rel"));
    match call("activate", &input).and_then(|v| v.get("ok").and_then(Value::as_bool)) {
        Some(true) => {
            out(&(defaults::render("codex_scripts.activated_line", &[("path", &path)]) + "\n"));
            0
        }
        Some(false) => {
            err(&(defaults::render("codex_scripts.err_write", &[("path", &path)]) + "\n"));
            1
        }
        None => no_script("codex-activate"),
    }
}
