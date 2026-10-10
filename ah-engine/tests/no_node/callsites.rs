//! Every command line the skills (both ports) and agents tell an agent to run. A direct `node <script>` is a Node path as
//! written (surface `doc`). A launcher line (`sh .../scripts/ah-run.sh <verb> ...`) is run in the no-Node world when it is a
//! concrete command (no placeholder), and the Node starts it makes are its Node paths (surface `run/<verb>`). Launcher lines
//! with placeholders are inventoried in the report. Unit files the runs leave in HOME are checked too (surface `unit/<file>`).

use crate::expected;
use crate::harness::{self, Seen, World, cfg_int, cfg_list, note};

use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Site {
    /// plugin-relative file:line
    pub at: String,
    pub kind: Kind,
}

#[derive(Debug, Clone)]
pub enum Kind {
    /// `node <script>`: the plugin-relative script (as the text names it, root spelling removed)
    Node(String),
    /// an `ah-run.sh` launcher line: the arguments after the launcher
    Launcher(String),
}

/// Remove every spelling of the plugin root (harness.toml callsites.root_spellings) from the start of a path.
fn strip_root(p: &str, spellings: &[String]) -> String {
    let p = p.trim_matches(|c| c == '"' || c == '\'');
    for s in spellings {
        if let Some(rest) = p.strip_prefix(s.as_str()) {
            return rest.trim_start_matches('/').trim_matches('"').to_string();
        }
    }
    p.to_string()
}

/// A script named with an elided or relative path (`.../install-devswarm-ingest.js`) is the plugin file of that name when
/// exactly one exists; otherwise it stays as written (an agent-written helper the skill tells it to create and run).
fn resolve(plugin: &Path, script: &str) -> String {
    if plugin.join(script).is_file() {
        return script.to_string();
    }
    let name = script.rsplit('/').next().unwrap_or(script);
    let mut all = Vec::new();
    harness::files_with_ext(plugin, "js", &mut all);
    let found: Vec<_> = all.iter().filter(|p| p.file_name().is_some_and(|n| n == name)).collect();
    match found.as_slice() {
        [one] => one.strip_prefix(plugin).unwrap().display().to_string(),
        _ => script.to_string(),
    }
}

pub fn extract(plugin: &Path, cfg: &toml::Table) -> Vec<Site> {
    let spellings = cfg_list(cfg, "callsites", "root_spellings");
    let node_re = regex::Regex::new(r#"(?:^|[\s`(;&|])node\s+(?:--?[\w-]+\s+)*("?[^\s"`]+\.[mc]?js"?)"#).unwrap();
    let run_re = regex::Regex::new(r#"(?:^|[\s`(;&|])sh\s+"?[^\s"`]*scripts/ah-run\.sh"?\s+([^`\n]*)"#).unwrap();
    let mut files = Vec::new();
    for r in cfg_list(cfg, "callsites", "roots") {
        harness::files_with_ext(&plugin.join(r), "md", &mut files);
    }
    let mut sites = Vec::new();
    for f in files {
        let rel = f.strip_prefix(plugin).unwrap().display().to_string();
        let text = std::fs::read_to_string(&f).unwrap();
        for (i, line) in text.lines().enumerate() {
            let at = format!("{rel}:{}", i + 1);
            for c in node_re.captures_iter(line) {
                let script = strip_root(&c[1], &spellings);
                if script.contains('<') {
                    continue; // an illustration (`node <file>.js`), not a command
                }
                sites.push(Site { at: at.clone(), kind: Kind::Node(resolve(plugin, &script)) });
            }
            for c in run_re.captures_iter(line) {
                // a trailing shell comment is prose, not an argument
                let args = c[1].split(" #").next().unwrap().trim().to_string();
                sites.push(Site { at: at.clone(), kind: Kind::Launcher(args) });
            }
        }
    }
    sites
}

fn runnable(args: &str, cfg: &toml::Table) -> bool {
    !args.is_empty()
        && !cfg_list(cfg, "callsites", "placeholder_markers").iter().any(|m| args.contains(m.as_str()))
        && !cfg_list(cfg, "callsites", "never_run").iter().any(|n| args.starts_with(n.as_str()))
}

/// The extractor finds the call sites the harness exists for (a guard against a regex that silently matches nothing).
#[test]
fn the_extractor_finds_both_kinds_of_call_site() {
    let cfg = harness::cfg();
    let sites = extract(&harness::plugin_src(), &cfg);
    let launchers = sites.iter().filter(|s| matches!(s.kind, Kind::Launcher(_))).count();
    let runnable_n = sites.iter().filter(|s| matches!(&s.kind, Kind::Launcher(a) if runnable(a, &cfg))).count();
    assert!(launchers > 0 && runnable_n > 0, "no ah-run.sh launcher lines found ({launchers} launchers, {runnable_n} runnable)");
    for s in &sites {
        if let Kind::Node(script) = &s.kind {
            assert!(!script.contains('$'), "{}: the root spelling of `{script}` is not in harness.toml", s.at);
        }
    }
}

/// Run every concrete launcher line with no Node installed and inventory every direct Node reference.
#[test]
fn skill_and_agent_call_sites_run_without_node() {
    let list = expected::load();
    let mut w = World::new("callsites");
    w.start_daemon();
    let timeout = Duration::from_secs(cfg_int(&w.cfg, "timeouts", "callsite_s"));
    let sites = extract(&w.plugin, &w.cfg);
    let mut seen = Seen::new();
    let mut problems = Vec::new();
    let mut rows = Vec::new();
    let mut templates = Vec::new();
    let mut done = std::collections::BTreeSet::new();
    for s in &sites {
        match &s.kind {
            Kind::Node(script) => note(&mut seen, "doc", script, &s.at),
            Kind::Launcher(args) if !runnable(args, &w.cfg) => templates.push(serde_json::json!({"at": s.at, "args": args})),
            Kind::Launcher(args) => {
                if !done.insert(args.clone()) {
                    continue; // the same command line in another skill: run once
                }
                let verb = args.split_whitespace().next().unwrap().to_string();
                let launcher = w.plugin.join("scripts").join("ah-run.sh");
                let mut cmd = w.command("/bin/sh", &s.at);
                cmd.arg("-c").arg(format!("sh '{}' {args}", launcher.display()));
                let o = w.run(cmd, None, timeout);
                if o.timed_out {
                    problems.push(format!("`ah-run.sh {args}` ({}) did not finish within {timeout:?}", s.at));
                }
                rows.push((
                    format!("run/{verb}"),
                    s.at.clone(),
                    serde_json::json!({
                        "at": s.at, "args": args, "exit": o.code, "ms": o.elapsed_ms, "timed_out": o.timed_out,
                        "stderr": o.stderr.chars().take(300).collect::<String>(),
                    }),
                ));
            }
        }
    }
    w.settle();
    let rows: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(surface, at, mut row)| {
            let node: Vec<String> = w.hits_of(&at).iter().map(|h| w.script_key(&h.argv)).collect();
            for k in &node {
                note(&mut seen, &surface, k, &at);
            }
            row["node"] = serde_json::json!(node);
            row
        })
        .collect();
    // unit files the runs wrote (doctor --repair, update, installers): one that starts node is a Node path
    let starts_node = regex::Regex::new(r"(^|[/>\s=])node([<\s]|$)").unwrap();
    for d in cfg_list(&w.cfg, "units", "dirs") {
        let Ok(rd) = std::fs::read_dir(w.home.join(&d)) else { continue };
        for e in rd.flatten() {
            let body = std::fs::read_to_string(e.path()).unwrap_or_default();
            if starts_node.is_match(&body) {
                note(&mut seen, &format!("unit/{}", e.file_name().to_string_lossy()), "node", &d);
            }
        }
    }
    for prefix in ["doc", "run/", "unit/"] {
        problems.extend(expected::compare(&list, prefix, &seen));
    }
    let report = serde_json::json!({
        "call_sites": sites.len(),
        "launcher_lines_run": rows.len(),
        "launcher_templates": templates.len(),
        "node_paths": expected::seen_json(&seen),
        "runs": rows,
        "templates": templates,
    });
    expected::finish("callsites", report, &problems);
}
