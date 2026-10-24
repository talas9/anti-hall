//! `devswarm.js reconcile`: drain every worktree registered in this project's store once (the manual form of the sweep the engine runs
//! after an update). The sweep itself is `dssup::recon::sweep::cmd_reconcile`, which is also what the update's post-pull stage runs; this
//! file is its command line: the plugin root, the settings tiers of the caller's environment, the clock, and Node's rendering of the
//! result (`{ok, ...}` as one JSON line, exit 0 when `ok`, else 2).
use crate::checks::git::util::Settings;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::json::J;
use crate::defaults;
use crate::dsact::runner::System;
use crate::dssup::recon::Hooks;
use crate::dssup::recon::sweep::{self, ProjectEnd};
use crate::dssup::tick::Ctx;
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, s};
use crate::meshw::ident::R;
use crate::meshw::send::{Answer, Effect};
use std::collections::HashMap;

/// Run `reconcile` for the project the working directory is in.
pub fn run(inv: &Inv, _a: &Args) -> R<Answer> {
    let env: HashMap<String, String> = inv.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let st = Settings { home: inv.home.to_string_lossy().into_owned(), env: env.clone() };
    let envmap: std::collections::BTreeMap<String, String> = env.into_iter().collect();
    let Some(root) = crate::ops::plugin_root(&envmap) else {
        return Ok(failure(defaults::text("mesh_write.reason_no_plugin_root"), defaults::text("mesh_write.msg_reconcile_no_plugin_root")));
    };
    let ctx = Ctx { home: &inv.home, root: std::path::Path::new(&root), st: &st, now: inv.now, engine_pokes: false };
    let runner = System::configured();
    let result = match sweep::cmd_reconcile(&ctx, &runner, &inv.cwd, &sweep::Opts::real(), &Hooks::none()) {
        ProjectEnd::Result(v) => v,
        // a read the identity layer refused: nothing was drained, and the next pass (or this command again) tries again
        ProjectEnd::Node(why) => return Ok(failure(defaults::text("mesh_write.reason_reconcile_held"), &why)),
    };
    let ok = result.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false);
    // the summary of the sweep is a store write the verb made: a failure from here on is a committed one
    crate::meshw::mark_committed();
    Ok(Answer { code: if ok { 0 } else { 2 }, stdout: format!("{}\n", crate::checks::jsport::json::stringify(&to_j(&result))), effect: Effect::None })
}

fn failure(reason: &str, error: &str) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("reason", s(reason)).put("error", s(error));
    Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }
}

/// A result value as the JavaScript-style JSON value that prints it (whole numbers without a fraction, as `JSON.stringify` does; the keys
/// come in the order the sweep built them, which a `serde_json` map keeps sorted).
fn to_j(v: &serde_json::Value) -> J {
    match v {
        serde_json::Value::Null => J::Null,
        serde_json::Value::Bool(b) => J::Bool(*b),
        serde_json::Value::Number(n) => J::Num(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(t) => J::Str(t.clone()),
        serde_json::Value::Array(a) => J::Arr(a.iter().map(to_j).collect()),
        serde_json::Value::Object(m) => J::Obj(m.iter().map(|(k, x)| (k.clone(), to_j(x))).collect()),
    }
}
