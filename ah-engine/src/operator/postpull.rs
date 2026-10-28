//! The post-pull stages of the engine's self-update, run by the engine (the stages `update.js` runs after the pull, in its order).
//!
//! The stage table is the plugin's own `engine/defaults/update_post.toml`. For each stage the engine answers by itself the
//! cases the script answers without doing any work, with the script's own text and key order:
//!
//! * the **overall post-pull budget** is spent before the stage starts (the whole stage is deferred, never run partly);
//! * the stage is **DevSwarm-session-only** and this is not one (the gate: `devswarm-detect.js`'s `isDevswarmActive`);
//! * the stage is a **one-time per-version migration** whose markers in `update-sweep-state.json` already say it is done for
//!   the new version.
//!
//! Every stage is native (`native` or `recon` in the stage table): the state-file migrations (`migrate-state.js`), the settings
//! forward-migration with the legacy Jev key opt-in and the triage cache repair, the Codex hooks.json graphify cleanup, the store
//! repairs, and the six reconcile-family stages (the engine's ports in `dssup::recon`). No Node runs. A stage the native path
//! cannot decide this time is `held` (`update_post.held_json`, counted `native_unable` at `postpull:<name>`; it runs again on the
//! NEXT update or doctor pass); a stage switched off (`enabled = false`, or the engine-mode switch of a reconcile-family stage)
//! is `disabled` (`update_post.disabled_json`). Each outcome has its own counter; none is a silent success.
use super::update::{Paths, progress, stage_quiet};
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::json::{self, J};
use crate::checks::spawnctx::devswarm_active;
use crate::defaults;
use crate::jev::settings::Env;
use crate::migrate;
use crate::setup::jsfmt::js_string;
use std::path::Path;
use std::time::Instant;

mod recon;
mod wake;

fn text(key: &str) -> &'static str {
    defaults::text(key)
}

/// Everything the stages need to know about the run.
pub(super) struct Run<'a> {
    pub env: &'a Env,
    pub home: &'a str,
    pub paths: &'a Paths,
    /// The new version, when it resolved.
    pub latest: Option<&'a str>,
    /// Whether this run copied a new version into the cache.
    pub synced: bool,
    /// The overall post-pull budget, ms (0: unlimited).
    pub budget_ms: u64,
    /// Set by a stage that did not run to its end (`held`, `disabled`), read (and cleared) by [`run`] to account the stage.
    pub outcome: std::cell::Cell<Option<crate::obs::counters::Outcome>>,
}

fn now_ms() -> u64 {
    crate::health::now_ms()
}

fn parse_json(s: &str) -> J {
    json::parse(s, defaults::num("update.json_max_depth") as usize).unwrap_or(J::Null)
}

/// `{version}` / `{name}` ... inside the string members of a shipped answer.
fn fill(mut v: J, args: &[(&str, &str)]) -> J {
    match &mut v {
        J::Str(s) => {
            for (k, val) in args {
                *s = s.replace(&format!("{{{k}}}"), val);
            }
        }
        J::Obj(o) => {
            for (_, m) in o.iter_mut() {
                *m = fill(std::mem::replace(m, J::Null), args);
            }
        }
        _ => {}
    }
    v
}

/// The `{name}` placeholders of a template, in order of first appearance.
fn placeholders(template: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = template;
    while let Some((_, after)) = rest.split_once('{') {
        let Some((name, tail)) = after.split_once('}') else { break };
        if !name.is_empty() && !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
        rest = tail;
    }
    out
}

impl Run<'_> {
    /// A file of the plugin tree. A `..` in `rel` (the Node backup tree is a sibling of the plugin, see `nodeback.node_dir`) is resolved
    /// in the text, so the paths the stages show name the real place.
    fn plugin(&self, rel: &str) -> std::path::PathBuf {
        let mut out = std::path::PathBuf::new();
        for part in Path::new(&self.paths.plugin_src).join(rel).components() {
            match part {
                std::path::Component::ParentDir if matches!(out.components().next_back(), Some(std::path::Component::Normal(_))) => {
                    out.pop();
                }
                other => out.push(other.as_os_str()),
            }
        }
        out
    }

    fn files_there(&self, files: &[&str]) -> bool {
        files.iter().all(|f| self.plugin(f).exists())
    }

    fn active(&self) -> bool {
        let st = crate::checks::git::util::Settings { home: self.home.to_string(), env: self.env.to_map() };
        devswarm_active(&st)
    }

    /// `migrations.js` `readMarkers`: the state object, `{}` for a missing, unreadable or non-object file.
    fn markers(&self) -> OVal {
        let file = Path::new(self.home).join(text("update_post.marker_file"));
        match std::fs::read(file).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) {
            Some(v @ OVal::Obj(_)) => v,
            _ => OVal::Obj(Vec::new()),
        }
    }

    fn done_for(&self, keys: &[&str]) -> bool {
        let Some(v) = self.latest.filter(|v| !v.is_empty()) else { return false };
        if keys.is_empty() {
            return false;
        }
        let m = self.markers();
        keys.iter().all(|k| matches!(m.get(k).and_then(|e| e.get("completedVersion")), Some(OVal::Str(c)) if c == v))
    }

    /// The engine owns the ingest daemons (`devswarm_ingest.mode` is engine: its drain runs in the daemon and `units heal`, the next
    /// stage of the update, retires the Node ingest units). Switchable with `update_post.ingest_native`.
    fn engine_owns_ingest(&self) -> bool {
        defaults::num("update_post.ingest_native") == 1 && crate::setup::units::engine_runs(text("units.duty_ingest"))
    }

    /// The ingest heal step: answered by the engine. While the engine does not own the ingest daemons (the switch is off, or the
    /// Node daemons drain) the step is `disabled`: nothing is healed or re-installed, and it says so.
    fn ingest(&self) -> J {
        if !self.engine_owns_ingest() {
            self.outcome.set(Some(crate::obs::counters::Outcome::Disabled));
            return parse_json(text("update_post.ingest_off_json"));
        }
        let key = if !self.synced {
            "update_post.ingest_idle_json"
        } else if !self.active() {
            "update_post.ingest_gate_json"
        } else {
            "update_post.ingest_engine_json"
        };
        parse_json(text(key))
    }

    /// A stage the native path cannot decide this time: counted `native_unable` at `postpull:<name>`, accounted `held`, answered with
    /// `update_post.held_json`. Nothing is run or written for it; the next update or doctor pass tries it again.
    fn held_stage(&self, name: &str, why: &str) -> J {
        crate::obs::counters::handback_why(crate::obs::counters::Handback::Abandoned, &format!("postpull:{name}"), why);
        self.outcome.set(Some(crate::obs::counters::Outcome::Held));
        fill(parse_json(text("update_post.held_json")), &[("name", name), ("why", why)])
    }

    /// A stage that is switched off: accounted `disabled`, answered with `update_post.disabled_json`.
    fn off_stage(&self, name: &str) -> J {
        self.outcome.set(Some(crate::obs::counters::Outcome::Disabled));
        fill(parse_json(text("update_post.disabled_json")), &[("name", name)])
    }

    /// A store stage whose every store is on the legacy journal backend (Node older than 22.5): the engine does not read those stores,
    /// so there is nothing for it to do. Accounted `disabled` (not held: nothing is waiting for a later try), answered with
    /// `update_post.legacy_json`; the doctor names the stores.
    fn legacy_stage(&self, name: &str) -> J {
        self.outcome.set(Some(crate::obs::counters::Outcome::Disabled));
        fill(parse_json(text("update_post.legacy_json")), &[("name", name)])
    }

    /// The migration context of the engine's own ports: this home, this process's environment and working directory, the new
    /// version (else the plugin tree's own, as `migrations.js` falls back to it) and the plugin tree.
    fn migrate_ctx(&self) -> migrate::Ctx {
        let env: std::collections::BTreeMap<String, String> = self.env.to_map().into_iter().collect();
        let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
        let plugin = self.paths.plugin_src.clone();
        let mut ctx = migrate::Ctx::new(self.home.to_string(), cwd, env, false, None, Some(plugin.clone()));
        ctx.version = self.latest.filter(|v| !v.is_empty()).map(str::to_string).or_else(|| migrate::plugin_version(&ctx, &plugin));
        ctx
    }

    /// What a port swallowed (Node swallows it too) goes to the event log, never to the output.
    fn log_notes(ctx: &migrate::Ctx) {
        for n in ctx.take_notes() {
            crate::discard::note("update_post_note", &n);
        }
    }

    fn dry_run(&self) -> bool {
        self.env.get(text("update_post.ingest_dry_run_env")) == Some(text("update_post.ingest_dry_run_on"))
    }

    /// A state-file migration (`migrate-state.js`), shaped exactly as the script shapes its answer (`r.x || 0` for every
    /// count, the detail line, the error suffix).
    fn counts_stage(&self, row: &'static defaults::V, which: &str) -> Option<J> {
        let ctx = self.migrate_ctx();
        let rep = migrate::state::apply(&ctx, which)?;
        Self::log_notes(&ctx);
        let already = row.str_field("already");
        let num = |n: u64| J::Num(n as f64);
        let mut fields = vec![("scanned", num(rep.scanned)), ("migrated", num(rep.migrated)), ("pending", num(rep.pending)), ("errors", num(rep.errors))];
        if !already.is_empty() {
            fields.push((already, num(rep.already)));
        }
        let mut out = vec![("attempted".to_string(), J::Bool(true))];
        let mut shown: Vec<(String, String)> = Vec::new();
        for k in row.get("out").map(|o| o.strings()).unwrap_or_default() {
            let v = fields.iter().find(|(f, _)| *f == k).map_or(J::Num(0.0), |(_, v)| v.clone());
            let nonzero = !matches!(&v, J::Num(n) if *n == 0.0);
            let txt = if k == "errors" {
                if nonzero { defaults::fill(text("update_post.lib_errors"), &[("n", &js_string(&v))]) } else { String::new() }
            } else {
                js_string(&v)
            };
            shown.push((k.to_string(), txt));
            out.push((k.to_string(), v));
        }
        let args: Vec<(&str, &dyn std::fmt::Display)> = shown.iter().map(|(k, v)| (k.as_str(), v as &dyn std::fmt::Display)).collect();
        out.push(("detail".into(), J::Str(defaults::fill(row.str_field("detail"), &args))));
        Some(J::Obj(out))
    }

    /// `settingsMigratePostUpdate`: the settings forward-migration, then the one-time legacy Jev key opt-in and the triage
    /// cache repair, each appended to the detail when it did more than skip.
    fn settings_stage(&self) -> J {
        let ctx = self.migrate_ctx();
        let mut rows = Vec::new();
        migrate::settings::settings_migration(&ctx, &mut rows);
        let key = migrate::settings::legacy_key_opt_in(&ctx);
        migrate::settings::jev_triage_cache(&ctx, &mut rows);
        Self::log_notes(&ctx);
        let (Some(main), Some(triage)) = (rows.first(), rows.get(1)) else { return J::Null };
        let mut detail = main.msg.clone();
        for (id, r) in [(text("update_post.key_opt_in_note_id"), &key), (triage.id.as_str(), triage)] {
            if r.status != "skipped" {
                detail.push_str(&defaults::fill(text("update_post.settings_note"), &[("id", &id), ("status", &r.status), ("msg", &r.msg)]));
            }
        }
        J::Obj(vec![("attempted".into(), J::Bool(true)), ("status".into(), J::Str(main.status.clone())), ("detail".into(), J::Str(detail))])
    }

    /// `codexGraphifyHooksMigratePostUpdate`: strip the hook groups that register a retired graphify script from the home's and
    /// the working directory's Codex hooks.json; every other event and group is kept as it is, a file with nothing to strip
    /// (or that does not parse) is not touched, a cleaned one is backed up first and never deleted.
    fn codex_graphify_stage(&self) -> J {
        let rel = text("update_post.graphify_hooks_rel");
        let cwd = std::env::current_dir().unwrap_or_default();
        let targets = [Path::new(self.home).join(rel), cwd.join(rel)];
        let removed_files = defaults::list("update_post.graphify_removed_files");
        let is_graphify = |g: &J| match g.get("hooks") {
            Some(J::Arr(hooks)) => hooks.iter().any(|h| match h.get("command") {
                Some(J::Str(c)) => {
                    let c = c.replace('\\', "/");
                    removed_files.iter().any(|f| c.contains(&format!("/{f}")))
                }
                _ => false,
            }),
            _ => false,
        };
        let (mut changed, mut removed_total, mut errors) = (0u64, 0u64, 0u64);
        let mut seen: Vec<&Path> = Vec::new();
        for target in &targets {
            if seen.contains(&target.as_path()) {
                continue;
            }
            seen.push(target);
            if !target.exists() {
                continue;
            }
            let Ok(bytes) = std::fs::read(target) else {
                errors += 1;
                continue;
            };
            let Ok(doc) = json::parse(&String::from_utf8_lossy(&bytes), defaults::num("update.json_max_depth") as usize) else { continue };
            let events: Vec<(String, J)> = match doc.get("hooks") {
                Some(J::Obj(o)) => o.clone(),
                Some(J::Arr(a)) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
                _ => Vec::new(),
            };
            let mut removed = 0u64;
            let mut hooks = Vec::new();
            for (event, groups) in events {
                let mut kept: Vec<J> = Vec::new();
                if let J::Arr(gs) = groups {
                    for g in gs {
                        if is_graphify(&g) {
                            removed += 1;
                        } else {
                            kept.push(g);
                        }
                    }
                }
                hooks.push((event, J::Arr(kept)));
            }
            if removed == 0 {
                continue;
            }
            let mut next = match doc {
                J::Obj(o) => J::Obj(o),
                _ => J::Obj(Vec::new()),
            };
            next.set("hooks", J::Obj(hooks));
            let stamp = crate::checks::jsport::date::to_iso(crate::checks::jsport::date::now_ms()).unwrap_or_default().replace([':', '.'], "-");
            let mut backup = target.as_os_str().to_os_string();
            backup.push(defaults::fill(text("update_post.graphify_backup_suffix"), &[("stamp", &stamp)]));
            let wrote = std::fs::copy(target, &backup).and_then(|_| crate::atomic::write(target, migrate::settings::pretty(&next) + "\n"));
            match wrote {
                Ok(()) => {
                    changed += 1;
                    removed_total += removed;
                }
                Err(e) => {
                    crate::discard::note("update_post_note", &format!("{}: {e}", target.display()));
                    errors += 1;
                }
            }
        }
        let err = if errors > 0 { defaults::fill(text("update_post.graphify_errors"), &[("n", &errors)]) } else { String::new() };
        let num = |n: u64| J::Num(n as f64);
        J::Obj(vec![
            ("attempted".into(), J::Bool(true)),
            ("targets".into(), num(targets.len() as u64)),
            ("changed".into(), num(changed)),
            ("removed".into(), num(removed_total)),
            ("errors".into(), num(errors)),
            (
                "detail".into(),
                J::Str(defaults::fill(text("update_post.graphify_detail"), &[("changed", &changed), ("removed", &removed_total), ("errors", &err)])),
            ),
        ])
    }

    /// A store repair with nothing to walk on this machine: the Node pass's zero answer and its completion stamp (stamped only
    /// with a known new version, as `recordRun` does). `None` when there is something to walk (the Node function runs).
    fn empty_store_stage(&self, row: &'static defaults::V) -> Option<J> {
        let ctx = self.migrate_ctx();
        let empty = match row.str_field("empty_when") {
            "no_stores" => migrate::list_store_hashes(&ctx).is_empty(),
            "no_app_db" => {
                let env = self.env.to_map();
                matches!(crate::meshw::appdb::builder_states(Path::new(self.home), &env, now_ms() as i64, false), Ok(None))
            }
            _ => false,
        };
        if !empty {
            Self::log_notes(&ctx);
            return None;
        }
        let latest = self.latest.filter(|v| !v.is_empty());
        if let Some(key) = row.get("state").map(|f| f.strings()).unwrap_or_default().first() {
            migrate::mark_applied(&ctx, key, latest);
        }
        Self::log_notes(&ctx);
        Some(parse_json(row.str_field(if self.dry_run() { "empty_dry_json" } else { "empty_json" })))
    }

    /// A DevSwarm store stage the engine answers itself (`migrate::poststages`): the Node function's counts shaped exactly as its
    /// wrapper in `update.js` shapes them, and its one-time marker stamped as `recordRun` stamps it (only with a known new version,
    /// no error and nothing pending). `None`: Node answers (a store the engine cannot open the way Node does, a case only Node decides).
    fn store_stage(&self, row: &'static defaults::V, which: &str) -> Option<J> {
        let ctx = self.migrate_ctx();
        let dry = self.dry_run();
        let t = migrate::poststages::run(&ctx, which, dry);
        Self::log_notes(&ctx);
        let t = t?;
        if t.all_legacy {
            return Some(self.legacy_stage(row.str_field("name")));
        }
        let errors = t.n.get("errors").copied().unwrap_or(0.0);
        let latest = self.latest.filter(|v| !v.is_empty());
        if let Some(key) = row.get("state").map(|f| f.strings()).unwrap_or_default().first()
            && errors == 0.0
            && t.pending_rows == 0.0
        {
            migrate::mark_applied(&ctx, key, latest);
            Self::log_notes(&ctx);
        }
        let template = match row.str_field("detail_dry") {
            d if dry && !d.is_empty() => d,
            // a stage whose text differs when it found nothing names the count that decides (`zero_key`) and the text (`detail_zero`)
            _ if row.get("zero_key").and_then(defaults::V::as_str).is_some_and(|k| t.n.get(k).copied().unwrap_or(0.0) == 0.0) => row.str_field("detail_zero"),
            _ => row.str_field("detail"),
        };
        let done_keys = row.get("done").map(|d| d.strings()).unwrap_or_default();
        let mut shown: Vec<(String, String)> = Vec::new();
        for name in placeholders(template) {
            let txt = match name.as_str() {
                "done" => done_keys.get(usize::from(dry)).map_or_else(String::new, |k| js_string(&J::Num(t.n.get(k).copied().unwrap_or(0.0)))),
                "errors" if errors > 0.0 => defaults::fill(row.str_field("errors_text"), &[("n", &js_string(&J::Num(errors)))]),
                "errors" => String::new(),
                "left_text0" => {
                    let left = t.n.get("left").copied().unwrap_or(0.0);
                    if left > 0.0 { defaults::fill(row.str_field("left_text0"), &[("left", &js_string(&J::Num(left)))]) } else { String::new() }
                }
                "left_text" => {
                    let left = t.n.get("left").copied().unwrap_or(0.0);
                    if left > 0.0 { defaults::fill(row.str_field("left_text"), &[("left", &js_string(&J::Num(left)))]) } else { String::new() }
                }
                k => js_string(&J::Num(t.n.get(k).copied().unwrap_or(0.0))),
            };
            shown.push((name, txt));
        }
        let args: Vec<(&str, &dyn std::fmt::Display)> = shown.iter().map(|(k, v)| (k.as_str(), v as &dyn std::fmt::Display)).collect();
        let mut out = vec![("attempted".to_string(), J::Bool(true))];
        for k in row.get("out").map(|o| o.strings()).unwrap_or_default() {
            let v = if k == "ok" { J::Bool(t.ok.unwrap_or(true)) } else { J::Num(t.n.get(k).copied().unwrap_or(0.0)) };
            out.push((k.to_string(), v));
        }
        out.push(("detail".into(), J::Str(defaults::fill(template, &args))));
        Some(J::Obj(out))
    }

    fn stage(&self, row: &'static defaults::V, deadline: Option<u64>) -> J {
        let name = row.str_field("name");
        let files: Vec<&str> = row.get("files").map(|f| f.strings()).unwrap_or_default();
        let version = self.latest.unwrap_or_default();
        if self.files_there(&files) {
            let gate = row.get("gate").and_then(defaults::V::as_bool).unwrap_or(false);
            if gate && !self.active() {
                return parse_json(row.str_field("gate_json"));
            }
            let state: Vec<&str> = row.get("state").map(|f| f.strings()).unwrap_or_default();
            if self.done_for(&state) {
                return fill(parse_json(row.str_field("done_json")), &[("version", version)]);
            }
        }
        if row.get("empty_when").is_some()
            && let Some(v) = self.empty_store_stage(row)
        {
            return v;
        }
        if row.get("recon").is_some() {
            return self.recon_stage(row, deadline).unwrap_or_else(|| self.held_stage(name, text("update_post.why_native_unable")));
        }
        match row.get("native").and_then(defaults::V::as_str) {
            Some("settings") => return self.settings_stage(),
            Some("codex_graphify") => return self.codex_graphify_stage(),
            Some("wake_monitor") => {
                if let Some(v) = self.wake_monitor_stage(row) {
                    return v;
                }
            }
            Some(which) if migrate::poststages::is_store_stage(which) => {
                if let Some(v) = self.store_stage(row, which) {
                    return v;
                }
            }
            Some(which) => {
                if let Some(v) = self.counts_stage(row, which) {
                    return v;
                }
            }
            None => {}
        }
        self.held_stage(name, text("update_post.why_native_unable"))
    }
}

/// Every stage, in the script's order; the answers come back in the script's status order.
pub(super) fn run(r: &Run) -> Vec<(String, J)> {
    let quiet = stage_quiet(r.env, r.home);
    let t_ingest = Instant::now();
    let ingest = r.ingest();
    crate::obs::counters::account(
        "stage",
        text("update_post.ingest_stage_name"),
        r.outcome.take().unwrap_or(crate::obs::counters::Outcome::Ok),
        0,
        t_ingest.elapsed().as_micros() as u64,
    );
    let mut answers: Vec<(String, J)> = vec![("ingestHeal".into(), ingest)];
    let mut repairs = Vec::new();
    let ctx = r.migrate_ctx();
    migrate::hooks_upgrade(&ctx, &mut repairs);
    Run::log_notes(&ctx);
    answers.extend(repairs.into_iter().map(|row| (row.id.clone(), row.to_j())));
    let rows = defaults::raw("update_post.stages").as_array().unwrap_or(&[]);
    let deadline = (r.budget_ms > 0).then(|| now_ms() + r.budget_ms);
    for row in rows {
        let name = row.str_field("name");
        if row.get("enabled").and_then(defaults::V::as_bool) == Some(false) {
            answers.push((row.str_field("key").to_string(), fill(parse_json(text("update_post.disabled_json")), &[("name", name)])));
            crate::obs::counters::account("stage", name, crate::obs::counters::Outcome::Disabled, 0, 0);
            continue;
        }
        let budgeted = row.get("budget").and_then(defaults::V::as_bool).unwrap_or(false);
        if budgeted && deadline.is_some_and(|d| now_ms() >= d) {
            let budget = r.budget_ms.to_string();
            answers.push((row.str_field("key").to_string(), fill(parse_json(text("update_post.deferred_json")), &[("name", name), ("budget", &budget)])));
            crate::obs::counters::account("stage", name, crate::obs::counters::Outcome::Held, 0, 0);
            continue;
        }
        if !quiet {
            progress(&defaults::render("update_msg.stage_start", &[("name", &name)]));
        }
        let t0 = Instant::now();
        let cpu0 = crate::limits::thread_cpu_us();
        let v = r.stage(row, deadline);
        let outcome = r.outcome.take().unwrap_or(crate::obs::counters::Outcome::Ok);
        crate::obs::counters::account("stage", name, outcome, crate::limits::thread_cpu_us().saturating_sub(cpu0), t0.elapsed().as_micros() as u64);
        if !quiet {
            progress(&defaults::render("update_msg.stage_done", &[("name", &name), ("ms", &t0.elapsed().as_millis())]));
        }
        answers.push((row.str_field("key").to_string(), v));
    }
    let mut ordered = Vec::new();
    for key in defaults::list("update_post.status_order") {
        if let Some(i) = answers.iter().position(|(k, _)| k == key) {
            ordered.push(answers.swap_remove(i));
        }
    }
    ordered
}
