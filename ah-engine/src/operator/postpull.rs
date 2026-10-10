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
//! Anything else is the stage's real work on the DevSwarm stores or the settings. Those run by the script's own exported
//! stage function in a bounded Node subprocess, exactly as `update.js` calls it (so the answer is the script's, key order and
//! all). A stage whose plugin files are not all there is also left to the script, which reports the missing file.
use super::update::{Paths, progress, run_child, stage_quiet};
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::json::{self, J, stringify};
use crate::checks::spawnctx::devswarm_active;
use crate::defaults;
use crate::jev::settings::Env;
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

    /// A stage the script builds from one library call (`migrate-state.js`): the call runs in Node, the answer is shaped here
    /// exactly as the script shapes it (`r.x || 0` for every count, the detail line, the error suffix).
    fn lib_stage(&self, row: &'static defaults::V, lib: &str) -> J {
        let (name, label, func) = (row.str_field("name"), row.str_field("label"), row.str_field("lib_fn"));
        let got = match self.node_call(text("update_post.lib_snippet"), &[lib.to_string(), func.to_string()]) {
            Ok(g) => g,
            Err(why) => return fill(parse_json(text("update_post.node_failed_json")), &[("name", name), ("why", &why)]),
        };
        let detail = |d: String| J::Obj(vec![("attempted".into(), J::Bool(false)), ("detail".into(), J::Str(d))]);
        if let Some(J::Str(why)) = got.get("__err") {
            return detail(defaults::fill(text("update_post.lib_raised"), &[("label", &label), ("why", why)]));
        }
        let Some(r) = got.get("r") else {
            return detail(defaults::fill(text("update_post.lib_nofn"), &[("label", &label), ("fn", &func)]));
        };
        let count = |k: &str| match r.get(k) {
            Some(J::Num(n)) if *n != 0.0 && !n.is_nan() => J::Num(*n),
            Some(J::Str(s)) if !s.is_empty() => J::Str(s.clone()),
            Some(v @ (J::Arr(_) | J::Obj(_) | J::Bool(true))) => v.clone(),
            _ => J::Num(0.0),
        };
        let mut out = vec![("attempted".to_string(), J::Bool(true))];
        let mut shown: Vec<(String, String)> = Vec::new();
        for k in row.get("out").map(|o| o.strings()).unwrap_or_default() {
            let v = count(k);
            let errors_left = k == "errors" && !matches!(&v, J::Num(n) if *n == 0.0);
            shown.push((
                k.to_string(),
                if k == "errors" {
                    if errors_left { defaults::fill(text("update_post.lib_errors"), &[("n", &js_string(&v))]) } else { String::new() }
                } else {
                    js_string(&v)
                },
            ));
            out.push((k.to_string(), v));
        }
        let args: Vec<(&str, &dyn std::fmt::Display)> = shown.iter().map(|(k, v)| (k.as_str(), v as &dyn std::fmt::Display)).collect();
        out.push(("detail".into(), J::Str(defaults::fill(row.str_field("detail"), &args))));
        J::Obj(out)
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
        if let Some(lib) = row.get("lib").and_then(defaults::V::as_str) {
            return self.lib_stage(row, lib);
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
