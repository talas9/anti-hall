//! `ah-engine devswarm <verb>`: the DevSwarm owner verbs and the readers of the realtime state, under the role matrix
//! (`devswarm_wire.role_matrix`). Reads are open to every role; the verbs that act (`archive`, `plan-prune`, `prune`) are for the
//! main session only, so a subagent, a Codex session or a workspace child that calls one is refused before anything is read.
//!
//! `create` and `merge` answer `deferred` (exit 75, nothing done): their Node checks (the source-freshness check, the merge gate)
//! are not reproduced by the engine yet, and a verb the engine cannot do exactly as Node does is left to Node.
use super::live::RtLive;
use crate::cli::Parsed;
use crate::defaults;
use crate::devswarm_rt::reconcile::{Cause, Rt};
use crate::dsact::exec::Act;
use crate::dsact::ledger::Word;
use crate::dsact::runner::System;
use crate::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The caller's role: codex (a marker variable), subagent (an automated caller), child (a DevSwarm workspace) or main.
pub fn role(env: &dyn Fn(&str) -> Option<String>) -> &'static str {
    let words = defaults::list("devswarm_wire.role_words");
    let set = |k: &str| env(k).is_some_and(|v| !v.trim().is_empty());
    if defaults::list("devswarm_wire.role_codex_env").iter().any(|k| set(k)) {
        return words[3];
    }
    let caller = env(defaults::text("devswarm_act.caller_env")).filter(|c| !c.is_empty());
    if caller.is_some_and(|c| c != defaults::text("devswarm_act.interactive_caller")) {
        return words[2];
    }
    if set(defaults::text("devswarm_wire.role_child_env")) { words[1] } else { words[0] }
}

/// Whether `role` may run `verb`; a verb the matrix does not list is refused.
pub fn allowed(role: &str, verb: &str) -> bool {
    defaults::raw("devswarm_wire.role_matrix").get(verb).is_some_and(|r| r.strings().contains(&role))
}

fn flag(rest: &[String], name: &str) -> String {
    rest.iter().position(|a| a == name).and_then(|i| rest.get(i + 1)).cloned().unwrap_or_default()
}

fn paths() -> Option<(PathBuf, PathBuf)> {
    let home = defaults::env_var("home").map(PathBuf::from)?;
    Some((home, crate::bootstrap::state_dir()?))
}

fn out(p: &Parsed, v: Value) {
    if p.json {
        println!("{v}");
    } else {
        println!("{}", crate::cli::human(&v));
    }
}

fn fail(p: &Parsed, msg: String, code: i32) -> i32 {
    if p.json {
        println!("{}", json!({"error": msg}));
    } else {
        eprintln!("{msg}");
    }
    code
}

/// A one-shot state read: detect, then derive the state once. `None` when DevSwarm is absent or the layer is off.
fn one_shot(home: &Path) -> Option<Rt> {
    let env: std::collections::HashMap<String, String> = std::env::vars().collect();
    let rt = crate::devswarm_rt::start(home, &env)?;
    rt.run_live(Cause::Startup, None, None);
    Some(rt)
}

/// The command handler.
pub fn run(p: &Parsed) -> i32 {
    run_with(p, &|k| std::env::var(k).ok())
}

/// [`run`] with the caller's environment given (the role comes from it).
pub fn run_with(p: &Parsed, env: &dyn Fn(&str) -> Option<String>) -> i32 {
    let verb = p.rest.first().cloned().unwrap_or_default();
    let (usage, deferred) = (defaults::num("devswarm_wire.usage_exit") as i32, defaults::num("devswarm_wire.deferred_exit") as i32);
    let compat = defaults::list("devswarm_wire.compat_verbs").contains(&verb.as_str());
    if !compat && !defaults::list("devswarm_wire.owner_verbs").contains(&verb.as_str()) {
        return fail(p, defaults::render("devswarm_wire.msg_unknown_verb", &[("verb", &verb)]), usage);
    }
    let r = role(env);
    if !allowed(r, &verb) {
        return fail(p, defaults::render("devswarm_wire.msg_role_refused", &[("verb", &verb), ("role", &r)]), usage);
    }
    if compat {
        return compat_run(p);
    }
    if verb == "create" || verb == "merge" {
        out(p, json!({"outcome": Word::Deferred.text(), "verb": verb, "why": defaults::render("devswarm_wire.msg_deferred", &[("verb", &verb)])}));
        return deferred;
    }
    let Some((home, state_dir)) = paths() else { return fail(p, defaults::text("devswarm_wire.msg_inert").to_string(), usage) };
    let rest = &p.rest[1..];
    if verb == "supervisor" {
        let st = crate::checks::git::util::Settings::from_env(&RequestEnv::capture());
        out(p, crate::dssup::cli::status(&home, &st, crate::dssup::owner(), crate::health::now_ms() as i64));
        return 0;
    }
    if verb == "ingest" {
        out(p, crate::dssup::ingest::status(&home, &state_dir, crate::health::now_ms() as i64));
        return 0;
    }
    if verb == "recover" {
        let (report, code) = crate::dssup::cli::recover(rest, &RequestEnv::capture(), &System::configured());
        out(p, report);
        return code;
    }
    if verb == "advisory" {
        let session = flag(rest, defaults::text("devswarm_wire.session_flag"));
        let text = crate::client::ctl(&defaults::render("devswarm_wire.ctl_advisory", &[("session", &session)]))
            .filter(|t| !t.is_empty() && t != defaults::text("devswarm_wire.ctl_none"));
        out(p, json!({"advisory": text}));
        return 0;
    }
    let Some(rt) = one_shot(&home) else { return fail(p, defaults::text("devswarm_wire.msg_inert").to_string(), usage) };
    match verb.as_str() {
        "status" => {
            out(p, status_json(&rt));
            0
        }
        "line" => {
            println!("{}", super::consume::line(&rt));
            0
        }
        _ => act_verb(p, &verb, rest, &rt, &home, &state_dir),
    }
}

/// A `devswarm.js` verb ported to the engine (`devswarm_wire.compat_verbs`): the same argv as `node scripts/devswarm.js`, the same
/// front as `ah-engine mesh <argv>` (which keeps `--json` and every word in place: `parseArgs` lets a flag swallow its neighbour).
fn compat_run(p: &Parsed) -> i32 {
    let mut args = std::env::args_os();
    let from_process = args.nth(1).is_some_and(|w| w.to_str() == Some(defaults::text("devswarm_wire.command_word")));
    let raw: Vec<std::ffi::OsString> = if from_process {
        args.collect()
    } else {
        p.rest.iter().cloned().chain(p.json.then(|| defaults::text("devswarm_cli.json_word").to_string())).map(Into::into).collect()
    };
    crate::meshw::run_front(&raw)
}

/// The state summary the `status` verb and the daemon's control verb print.
pub fn status_json(rt: &Rt) -> Value {
    let snap = rt.current();
    json!({
        "mode": format!("{:?}", rt.mode()).to_lowercase(), "generation": snap.generation, "appReadable": snap.app_readable,
        "workspaces": snap.workspaces.len(), "line": super::consume::line(rt), "repairs": rt.repairs(),
        "executors": defaults::list("devswarm_wire.act_kinds").iter().map(|k| (k.to_string(), json!(format!("{:?}", super::executor(k)).to_lowercase()))).collect::<serde_json::Map<_, _>>(),
    })
}

fn act_verb(p: &Parsed, verb: &str, rest: &[String], rt: &Rt, home: &Path, state_dir: &Path) -> i32 {
    let runner = System::configured();
    let env = RequestEnv::capture();
    let live =
        RtLive { rt, home: home.to_path_buf(), runner: &runner, state_dir: state_dir.to_path_buf(), env: env.clone(), now: crate::health::now_ms() as i64 };
    let act = Act::new(home, state_dir, env, &live, &runner);
    let usage = defaults::num("devswarm_wire.usage_exit") as i32;
    let need = |f: &str| -> Result<String, i32> {
        let v = flag(rest, f);
        if v.is_empty() { Err(fail(p, defaults::render("devswarm_wire.msg_missing_arg", &[("flag", &f)]), usage)) } else { Ok(v) }
    };
    match verb {
        "archive" => {
            let (Ok(id), Ok(request)) = (need(defaults::text("devswarm_wire.id_flag")), need(defaults::text("devswarm_wire.request_flag"))) else {
                return usage;
            };
            let rep = act.request(defaults::list("devswarm_act.owner_kinds")[0], &json!({"id": id, "request": request}));
            out(p, rep.json());
            i32::from(rep.word != Word::Done)
        }
        "plan-prune" => {
            let Ok(days) = need(defaults::text("devswarm_wire.days_flag")) else { return usage };
            let Ok(days) = days.parse::<u64>() else {
                return fail(p, defaults::render("devswarm_wire.msg_missing_arg", &[("flag", &defaults::text("devswarm_wire.days_flag"))]), usage);
            };
            match act.plan_prune(days) {
                Ok(plan) => {
                    out(p, plan);
                    0
                }
                Err(e) => fail(p, e, 1),
            }
        }
        _ => {
            let (Ok(ids), Ok(nonce)) = (need(defaults::text("devswarm_wire.ids_flag")), need(defaults::text("devswarm_wire.plan_flag"))) else { return usage };
            let ids: Vec<String> = ids.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            let v = act.delete_confirmed(&ids, &nonce);
            let ok = v.get("ok").and_then(Value::as_bool).unwrap_or(false);
            out(p, v);
            i32::from(!ok)
        }
    }
}

/// The daemon's `devswarm` control verb: `advisory session=<id>` (the text, or `-` when there is none) and `status`.
pub fn ctl(args: &str) -> String {
    let none = defaults::text("devswarm_wire.ctl_none").to_string();
    let Some(w) = super::global() else { return none };
    let kv = |name: &str| {
        args.split_whitespace().find_map(|t| t.strip_prefix(&defaults::render("devswarm_wire.ctl_kv", &[("name", &name)]))).unwrap_or_default().to_string()
    };
    match args.split_whitespace().next().unwrap_or_default() {
        word if word == defaults::text("devswarm_wire.ctl_advisory_word") => {
            super::consume::advisory(&w.rt, &w.state_dir, &kv("session"), crate::health::now_ms() as i64).unwrap_or(none)
        }
        _ => status_json(&w.rt).to_string(),
    }
}
