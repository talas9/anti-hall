//! The six DevSwarm reconcile-family stages of the post-pull run (`reconcile`, `fold`, `fold-all-stores`, `heal-orphan-partitions`,
//! `fold-archived-rows`, `heal-registry-rows`) run by the engine's ports when the engine-mode switch says engine (the default).
//!
//! Each stage hands the work to the recon ports (`dssup::recon`), which plan it and apply the plan to the real home unit by unit,
//! each under its own lock with its preconditions re-checked; a unit the ports do not reproduce is `held` (counted, tried again on
//! the next pass). The switch is the supervisor's own: `devswarm_sup.reconcile_mode` for `reconcile`,
//! `devswarm_sup.sweep_tail_mode` for the rest; set to `off` the stage is `disabled`.
//!
//! What this module adds around the ports is the update wrapper's own part: the answer in the script's shape and key order, the
//! enumeration of the stores of a first run (the listing smallest store first), the stage's sweep budget and the overall post-pull
//! deadline that caps it. The resume list, the throttled walk and the one-time markers are `dssup::recon::stage`'s.
use super::Run;
use crate::checks::guardkit::text::js_number_of_str;
use crate::checks::jsport::json::J;
use crate::defaults;
use crate::dsact::runner::System;
use crate::dssup::recon::{Hooks, archive, stage, sweep};
use crate::dssup::tick::Ctx;
use serde_json::{Value, json};
use std::path::Path;

fn text(key: &str) -> &'static str {
    defaults::text(key)
}

/// A count as the double JavaScript would hold it.
fn num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn js_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            n.as_f64().map_or_else(|| n.to_string(), |f| if f.fract() == 0.0 && f.abs() < 1e15 { format!("{}", f as i64) } else { f.to_string() })
        }
        other => other.to_string(),
    }
}

fn count_text(x: f64) -> String {
    js_text(&json!(x))
}

/// The answer value as an insertion-ordered object: `order` first (what is present of it), then whatever else the value holds; the
/// members of a nested object follow the order the table `update_post.recon_nested` names for their key.
fn ordered(v: &Value, order: &[&str]) -> J {
    match v {
        Value::Null => J::Null,
        Value::Bool(b) => J::Bool(*b),
        Value::Number(n) => J::Num(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => J::Str(s.clone()),
        Value::Array(a) => J::Arr(a.iter().map(|x| ordered(x, order)).collect()),
        Value::Object(o) => {
            let mut out: Vec<(String, J)> = Vec::new();
            let keys = order.iter().map(|k| (*k).to_string()).chain(o.keys().cloned());
            for k in keys {
                if out.iter().any(|(e, _)| *e == k) {
                    continue;
                }
                if let Some(m) = o.get(&k) {
                    let nested: Vec<&str> = defaults::raw("update_post.recon_nested").get(&k).map(|n| n.strings()).unwrap_or_default();
                    out.push((k, ordered(m, &nested)));
                }
            }
            J::Obj(out)
        }
    }
}

/// `sweepBudgetMs(env)`: a number from the environment (empty reads as 0), else the default.
fn sweep_budget_ms(env: &crate::jev::settings::Env) -> f64 {
    match env.get(text("update_post.sweep_budget_env")) {
        Some(raw) => {
            let n = js_number_of_str(raw);
            if n.is_finite() && n >= 0.0 { n } else { defaults::num("update_post.sweep_budget_default") as f64 }
        }
        None => defaults::num("update_post.sweep_budget_default") as f64,
    }
}

/// The size `storeDirSizeBytes` reads: the files of the directory plus the files one level into each subdirectory; an entry that
/// cannot be read counts as 0.
fn store_dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut total = 0u64;
    for e in entries.flatten() {
        let p = e.path();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            for sub in std::fs::read_dir(&p).into_iter().flatten().flatten() {
                total += std::fs::metadata(sub.path()).map_or(0, |m| m.len());
            }
        } else {
            total += std::fs::metadata(&p).map_or(0, |m| m.len());
        }
    }
    total
}

impl Run<'_> {
    /// The store hashes of a first run, smallest store first (`orderStoreHashesBySize(listStoreHashes(home))`; the sort is stable).
    fn ordered_hashes(&self) -> Vec<String> {
        let ctx = self.migrate_ctx();
        let mut sized: Vec<(String, u64)> = crate::migrate::list_store_hashes(&ctx)
            .into_iter()
            .map(|h| {
                let size = store_dir_size(&Path::new(self.home).join(crate::dssup::recon::view::store_rel(&h)));
                (h, size)
            })
            .collect();
        if sized.len() > 1 {
            sized.sort_by_key(|(_, s)| *s);
        }
        sized.into_iter().map(|(h, _)| h).collect()
    }

    /// Whether the switch says the engine runs this stage.
    fn recon_engine(&self, kind: &str, st: &crate::checks::git::util::Settings) -> bool {
        if kind == text("update_post.recon_reconcile") {
            sweep::mode_is_engine(&crate::dswire::effective_text(text("update_post.recon_reconcile_mode_key")))
        } else {
            archive::engine_mode(st)
        }
    }

    /// The stage run by the engine's ports behind the switch, shaped as the script shapes it. With the switch off the stage is
    /// `disabled`. `None`: the ports hand the work back (the caller holds the stage).
    pub(super) fn recon_stage(&self, row: &'static defaults::V, deadline: Option<u64>) -> Option<J> {
        let kind = row.get("recon").and_then(defaults::V::as_str)?;
        let st = crate::checks::git::util::Settings { home: self.home.to_string(), env: self.env.to_map() };
        if !self.recon_engine(kind, &st) {
            return Some(self.off_stage(row.str_field("name")));
        }
        let root = Path::new(&self.paths.plugin_src);
        let home = Path::new(self.home);
        let ctx = Ctx { home, root, st: &st, now: now_i64(), engine_pokes: false };
        let runner = System::configured();
        let hooks = Hooks::none();
        let order: Vec<&str> = row.get("out").map(|o| o.strings()).unwrap_or_default();
        let value = if kind == text("update_post.recon_reconcile") {
            self.reconcile_answer(&ctx, &runner, &hooks)?
        } else if kind == text("update_post.recon_fold") {
            self.fold_answer(&ctx, &runner, &hooks)?
        } else {
            let stage_name = row.str_field("name");
            let version = self.latest.filter(|v| !v.is_empty());
            let up =
                stage::UpdateRun { version, hashes: self.ordered_hashes(), budget_ms: sweep_budget_ms(self.env), deadline_cap: deadline.map(|d| d as i64) };
            let out = stage::run_update(&ctx, &runner, stage_name, &hooks, &up)?;
            for rec in out.items.iter().filter(|r| r["by"] == defaults::text("devswarm_recon.by_held")) {
                crate::discard::note("update_post_note", &format!("{stage_name}: {rec}"));
            }
            out.result
        };
        Some(ordered(&value, &order))
    }

    /// `reconcilePostUpdate`: `devswarm.js reconcile` for the project of the working directory, then the answer built from its result.
    fn reconcile_answer(&self, ctx: &Ctx, runner: &System, hooks: &Hooks) -> Option<Value> {
        let cwd = std::env::current_dir().ok()?.to_string_lossy().into_owned();
        let result = match sweep::cmd_reconcile(ctx, runner, &cwd, &sweep::Opts::real(), hooks) {
            sweep::ProjectEnd::Result(v) => v,
            sweep::ProjectEnd::Node(why) => {
                crate::discard::note("update_post_note", &defaults::render("update_post.recon_note_reconcile", &[("why", &why)]));
                return None;
            }
        };
        let results: Vec<Value> = result.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
        let flagged = |k: &str| results.iter().filter(|x| truthy(x.get(k))).count() as f64;
        let (skipped, timeouts) = (flagged("skipped"), flagged("nativeTimeout"));
        let mut m = serde_json::Map::new();
        m.insert("attempted".into(), json!(true));
        if !truthy(result.get("ok")) {
            let detail = if truthy(result.get("lost")) {
                defaults::render(
                    "update_post.recon_lost",
                    &[("lost", &js_text(&result["lost"])), ("count", &if truthy(result.get("count")) { js_text(&result["count"]) } else { "0".into() })],
                )
            } else {
                let mut why = result.get("reason").filter(|r| truthy(Some(r))).map(js_text);
                if why.is_none() && result.get("results").is_some_and(Value::is_array) {
                    let real: Vec<&Value> = results
                        .iter()
                        .filter(|x| truthy(Some(x)) && defaults::list("update_post.recon_benign_flags").iter().all(|k| !truthy(x.get(*k))))
                        .collect();
                    if !real.is_empty() {
                        let cap = defaults::num("update_post.recon_max_listed") as usize;
                        let shown: Vec<String> = real
                            .iter()
                            .take(cap)
                            .map(|x| {
                                let err = x.get("error").filter(|e| truthy(Some(e))).map_or_else(|| text("update_post.recon_unknown").to_string(), js_text);
                                defaults::render(
                                    "update_post.recon_row",
                                    &[("id", &x.get("id").map_or_else(|| text("update_post.recon_undefined").to_string(), js_text)), ("error", &err)],
                                )
                            })
                            .collect();
                        let more = if real.len() > cap { defaults::render("update_post.recon_more", &[("n", &(real.len() - cap))]) } else { String::new() };
                        why = Some(shown.join(text("update_post.recon_row_sep")) + &more);
                    }
                }
                let also = if skipped > 0.0 { defaults::render("update_post.recon_also_skipped", &[("n", &count_text(skipped))]) } else { String::new() };
                defaults::render("update_post.recon_failed", &[("why", &why.unwrap_or_else(|| text("update_post.recon_unknown").to_string())), ("also", &also)])
            };
            for k in ["count", "lost"] {
                if let Some(v) = result.get(k) {
                    m.insert(k.into(), v.clone());
                }
            }
            m.insert("skipped".into(), json!(skipped));
            if let Some(r) = result.get("results") {
                m.insert("results".into(), r.clone());
            }
            m.insert("detail".into(), json!(detail));
            return Some(Value::Object(m));
        }
        let count = num(result.get("count"));
        let sk = if skipped > 0.0 { defaults::render("update_post.recon_skipped", &[("n", &count_text(skipped))]) } else { String::new() };
        let nt = if timeouts > 0.0 { defaults::render("update_post.recon_timeouts", &[("n", &count_text(timeouts))]) } else { String::new() };
        let detail = defaults::render(
            "update_post.recon_done",
            &[
                ("n", &count_text(count - skipped - timeouts)),
                ("skipped", &sk),
                ("timeouts", &nt),
                ("imported", &js_text(result.get("imported").unwrap_or(&Value::Null))),
            ],
        );
        for k in ["count", "imported"] {
            if let Some(v) = result.get(k) {
                m.insert(k.into(), v.clone());
            }
        }
        m.insert("lost".into(), if truthy(result.get("lost")) { result["lost"].clone() } else { json!(0) });
        m.insert("skipped".into(), json!(skipped));
        m.insert("nativeTimeouts".into(), json!(timeouts));
        if let Some(r) = result.get("results") {
            m.insert("results".into(), r.clone());
        }
        m.insert("detail".into(), json!(detail));
        Some(Value::Object(m))
    }

    /// `foldMeshPostUpdate`: the mesh fold of the store of the working directory's project.
    fn fold_answer(&self, ctx: &Ctx, runner: &System, hooks: &Hooks) -> Option<Value> {
        let cwd = std::env::current_dir().ok()?.to_string_lossy().into_owned();
        // a working directory that is not a project folds nothing: the empty fold, with no store opened
        let Some(repo_key) = crate::meshw::ident::repo_key_for_worktree(&cwd).ok().flatten() else {
            return Some(json!({
                "attempted": true, "pendingRows": 0, "retired": 0, "forwarded": 0, "folded": 0, "left": 0, "rekeyed": 0,
                "detail": defaults::render("update_post.fold_done", &[("retired", &count_text(0.0))]),
            }));
        };
        let end = crate::dssup::recon::fold::run(ctx, runner, &repo_key, hooks).ok()?;
        if end.verdict != crate::dssup::recon::gate::Verdict::Agreed || !end.deferred.is_empty() {
            crate::discard::note(
                "update_post_note",
                &defaults::render("update_post.recon_note_fold", &[("verdict", &format!("{:?}", end.verdict)), ("deferred", &format!("{:?}", end.deferred))]),
            );
            return None;
        }
        let r = &end.result;
        let (retired, left) = (r.retired.len() as f64, r.left.len() as f64);
        let pending = r.pending.len() as f64;
        let mut detail = defaults::render("update_post.fold_done", &[("retired", &count_text(retired))]);
        for (on, key, n) in [
            (r.forwarded > 0, "update_post.fold_forwarded", r.forwarded as f64),
            (r.rekeyed > 0, "update_post.fold_rekeyed", r.rekeyed as f64),
            (left > 0.0, "update_post.fold_left", left),
            (pending > 0.0, "update_post.fold_pending", pending),
        ] {
            if on {
                detail.push_str(&defaults::render(key, &[("n", &count_text(n))]));
            }
        }
        Some(json!({
            "attempted": true, "pendingRows": pending, "retired": retired, "forwarded": r.forwarded, "folded": r.folded,
            "left": left, "rekeyed": r.rekeyed, "detail": detail,
        }))
    }
}

fn now_i64() -> i64 {
    crate::health::now_ms() as i64
}
