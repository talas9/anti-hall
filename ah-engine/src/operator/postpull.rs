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
//! The stages whose work the engine owns run natively (`native` in the stage table): the state-file migrations
//! (`migrate-state.js`), the settings forward-migration with the legacy Jev key opt-in and the triage cache repair, and the
//! Codex hooks.json graphify cleanup. The store repairs marked `empty_when` are answered natively when the machine has nothing
//! for them to walk (no DevSwarm store, no DevSwarm app database), stamped as the Node pass stamps them.
//!
//! Anything else is the stage's real work on the DevSwarm stores. Those run by the script's own exported stage function in a
//! bounded Node subprocess, exactly as `update.js` calls it (so the answer is the script's, key order and all). A stage whose
//! plugin files are not all there is also left to the script, which reports the missing file.
use super::update::{Paths, progress, run_child, stage_quiet};
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::json::{self, J, stringify};
use crate::checks::spawnctx::devswarm_active;
use crate::defaults;
use crate::jev::settings::Env;
use crate::migrate;
use crate::setup::jsfmt::js_string;
use std::path::Path;
use std::time::{Duration, Instant};

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

impl Run<'_> {
    fn plugin(&self, rel: &str) -> std::path::PathBuf {
        Path::new(&self.paths.plugin_src).join(rel)
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

    fn node_timeout(&self) -> Duration {
        let wide = Duration::from_millis(self.budget_ms + defaults::num("update.harness_timeout_ms") + defaults::num("update.reexec_margin_ms"));
        wide.max(defaults::millis("update_post.stage_timeout_ms"))
    }

    /// The Node binary, or why the script cannot run.
    fn node(&self) -> Result<String, String> {
        let script = Path::new(&self.paths.plugin_src).join(text("update.node_script_rel"));
        if !script.is_file() {
            return Err(defaults::render("update_msg.stage_script_missing", &[("script", &script.display())]));
        }
        Ok(self.env.get(defaults::text("env.node")).filter(|n| !n.is_empty()).unwrap_or_else(|| text("doctor.node_default")).to_string())
    }

    /// Node code run with the plugin dir and the arguments; its answer is the last JSON line it printed.
    fn node_call(&self, snippet: &str, args: &[String]) -> Result<J, String> {
        let node = self.node()?;
        let mut argv: Vec<String> = defaults::list("update_post.node_args").iter().map(|a| (*a).to_string()).collect();
        argv.push(snippet.to_string());
        argv.push(self.paths.plugin_src.clone());
        argv.extend(args.iter().cloned());
        let r = run_child(&node, &argv, None, &[], self.node_timeout());
        let line = r.stdout.lines().rev().find(|l| !l.trim().is_empty());
        match (r.status, line) {
            (Some(0), Some(l)) => json::parse(l, defaults::num("update.json_max_depth") as usize).map_err(|e| format!("{e:?}")),
            _ => Err(if r.reason.is_empty() { text("update_msg.unknown_error").to_string() } else { r.reason }),
        }
    }

    fn node_stage(&self, name: &str, func: &str, opts: J) -> J {
        match self.node_call(text("update_post.stage_snippet"), &[func.to_string(), stringify(&opts)]) {
            Ok(v) => v,
            Err(why) => fill(parse_json(text("update_post.node_failed_json")), &[("name", name), ("why", &why)]),
        }
    }

    /// The shared store-hash listing, only when a DevSwarm session is active and its files are there.
    fn hashes(&self, cache: &mut Option<Option<J>>) -> Option<J> {
        if cache.is_none() {
            let files = defaults::list("update_post.hash_files");
            let got = if self.files_there(&files) && self.active() {
                self.node_call(text("update_post.hashes_snippet"), &[]).ok().filter(|h| matches!(h, J::Arr(_)))
            } else {
                None
            };
            *cache = Some(got);
        }
        cache.clone().flatten()
    }

    fn version_opts(&self) -> J {
        let mut o = vec![];
        if let Some(v) = self.latest.filter(|v| !v.is_empty()) {
            o.push(("version".to_string(), J::Str(v.to_string())));
        }
        J::Obj(o)
    }

    fn ingest(&self) -> J {
        let files = defaults::list("update_post.ingest_files");
        let heal = || self.node_stage("ingest heal", text("update_post.ingest_heal_fn"), self.version_opts());
        if self.files_there(&files) && !self.active() {
            // with nothing synced the trigger is false before the heal is asked; synced, the heal's own gate answers
            return parse_json(text(if self.synced { "update_post.ingest_gate_json" } else { "update_post.ingest_idle_json" }));
        }
        if self.synced {
            return heal();
        }
        match self.node_call(text("update_post.stage_snippet"), &[text("update_post.ingest_needs_fn").to_string(), "{}".to_string()]) {
            Ok(J::Bool(true)) => heal(),
            _ => parse_json(text("update_post.ingest_idle_json")),
        }
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

    fn stage(&self, row: &'static defaults::V, deadline: Option<u64>, hashes: &mut Option<Option<J>>) -> J {
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
        match row.get("native").and_then(defaults::V::as_str) {
            Some("settings") => return self.settings_stage(),
            Some("codex_graphify") => return self.codex_graphify_stage(),
            Some(which) => {
                if let Some(v) = self.counts_stage(row, which) {
                    return v;
                }
            }
            None => {}
        }
        if row.get("empty_when").is_some()
            && !self.env.get(text("update_post.node_test_env")).is_some_and(|v| !v.is_empty())
            && let Some(v) = self.empty_store_stage(row)
        {
            return v;
        }
        let passes: Vec<&str> = row.get("passes").map(|f| f.strings()).unwrap_or_default();
        let mut o: Vec<(String, J)> = Vec::new();
        if passes.contains(&"version") && !version.is_empty() {
            o.push(("version".into(), J::Str(version.to_string())));
        }
        if passes.contains(&"hashes")
            && let Some(h) = self.hashes(hashes)
        {
            o.push(("hashes".into(), h));
        }
        if passes.contains(&"deadline")
            && let Some(d) = deadline
        {
            o.push(("postPullDeadline".into(), J::Num(d as f64)));
        }
        self.node_stage(name, row.str_field("fn"), J::Obj(o))
    }
}

/// Every stage, in the script's order; the answers come back in the script's status order.
pub(super) fn run(r: &Run) -> Vec<(String, J)> {
    let quiet = stage_quiet(r.env, r.home);
    let mut answers: Vec<(String, J)> = vec![("ingestHeal".into(), r.ingest())];
    let rows = defaults::raw("update_post.stages").as_array().unwrap_or(&[]);
    let deadline = (r.budget_ms > 0).then(|| now_ms() + r.budget_ms);
    let mut hashes: Option<Option<J>> = None;
    for row in rows {
        let name = row.str_field("name");
        let budgeted = row.get("budget").and_then(defaults::V::as_bool).unwrap_or(false);
        if budgeted && deadline.is_some_and(|d| now_ms() >= d) {
            let budget = r.budget_ms.to_string();
            answers.push((row.str_field("key").to_string(), fill(parse_json(text("update_post.deferred_json")), &[("name", name), ("budget", &budget)])));
            continue;
        }
        if !quiet {
            progress(&defaults::render("update_msg.stage_start", &[("name", &name)]));
        }
        let t0 = Instant::now();
        let v = r.stage(row, deadline, &mut hashes);
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
