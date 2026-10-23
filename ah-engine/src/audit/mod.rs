//! `ah-engine audit entry-paths [--json] [--root <dir>] [--home <dir>] [--no-live]`: the mechanical inspection that no js/sh/wrong-entry
//! leftover ships. It inventories rather than searching for names already known, in four sections: the files of the plugin tree that are
//! scripts, the command strings an agent or hook is told to run, the files the engine itself generates into launcher directories, and a
//! read-only look at the running machine. The rules, the allowlist (each entry with its reason), the generator list and every text are in
//! `engine/defaults/entry_audit.toml` (D88). Exit 0 = clean, 1 = findings.
mod live;
mod rules;
mod scan;

use crate::cli::Parsed;
use crate::defaults;
use rules::Cfg;
pub use rules::Finding;
use serde_json::json;
use std::path::{Path, PathBuf};

/// What a run looks at.
pub struct Opts {
    /// A repository root (the plugin directory is under it) or a plugin root.
    pub root: PathBuf,
    /// The home directory the generated and live sections look under.
    pub home: PathBuf,
    /// Whether to run the machine section.
    pub live: bool,
}

/// The result of a run.
pub struct Report {
    /// The findings, in section order.
    pub findings: Vec<Finding>,
    /// Every generator and where it writes, as `(id, kind, path)`.
    pub generators: Vec<(String, String, String)>,
    /// Finding counts per section, in `audit.sections` order.
    pub counts: Vec<(String, usize)>,
}

/// Run the audit.
pub fn run(o: &Opts) -> Report {
    let cfg = Cfg::load();
    let names: Vec<&str> = defaults::list("entry_audit.sections");
    let name = |i: usize| names.get(i).copied().unwrap_or_default();
    let nested = o.root.join(defaults::text("entry_audit.plugin_rel"));
    let plugin = if nested.is_dir() { nested } else { o.root.clone() };
    let mut cmd_roots = vec![plugin.clone()];
    cmd_roots.extend(defaults::list("entry_audit.repo_cmd_roots").into_iter().map(|r| o.root.join(r)).filter(|p| p.exists() && !p.starts_with(&plugin)));
    let gens = scan::generated(&o.home);
    let mut findings = scan::files(&cfg, &o.root, &plugin, name(0));
    findings.extend(scan::commands(&cfg, &o.root, &cmd_roots, name(1)));
    findings.extend(scan::generated_findings(&cfg, &o.home, &gens, name(2)));
    if o.live {
        findings.extend(live::findings(&cfg, &o.home, name(3)));
    }
    let key = |f: &Finding| (names.iter().position(|n| *n == f.section).unwrap_or(names.len()), f.path.clone(), f.line, f.rule.clone());
    findings.sort_by_key(key);
    findings.dedup();
    let counts = names.iter().map(|n| (n.to_string(), findings.iter().filter(|f| f.section == *n).count())).collect();
    let generators = gens.iter().map(|g| (g.id.clone(), g.kind.clone(), scan::shown(&o.home, &g.path))).collect();
    Report { findings, generators, counts }
}

impl Report {
    fn count(&self, section: usize) -> usize {
        self.counts.get(section).map_or(0, |c| c.1)
    }

    /// The `{n} {files} {commands} {generated} {live}` arguments of the summary texts.
    fn summary(&self, key: &str) -> String {
        let n = self.findings.len();
        defaults::render(key, &[("n", &n), ("files", &self.count(0)), ("commands", &self.count(1)), ("generated", &self.count(2)), ("live", &self.count(3))])
    }

    fn table(&self) -> String {
        let max = defaults::num("entry_audit.text_max") as usize;
        let cut = |s: &str| -> String {
            if s.chars().count() > max { format!("{}{}", s.chars().take(max).collect::<String>(), defaults::text("entry_audit_msg.ellipsis")) } else { s.to_string() }
        };
        let place = |f: &Finding| if f.line > 0 { format!("{}:{}", f.path, f.line) } else { f.path.clone() };
        let mut rows: Vec<Vec<String>> = vec![defaults::list("entry_audit_msg.head").into_iter().map(str::to_string).collect()];
        rows.extend(self.findings.iter().map(|f| vec![f.section.clone(), place(f), cut(&f.text), f.rule.clone()]));
        let widths: Vec<usize> = (0..4).map(|c| rows.iter().map(|r| r.get(c).map_or(0, |s| s.chars().count())).max().unwrap_or(0)).collect();
        let sep = defaults::text("entry_audit_msg.col_sep");
        rows.iter()
            .map(|r| r.iter().enumerate().map(|(c, s)| format!("{s:<w$}", w = if c == 3 { 0 } else { widths.get(c).copied().unwrap_or(0) })).collect::<Vec<_>>().join(sep))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn text(&self) -> String {
        let mut out = String::new();
        if self.findings.is_empty() {
            out.push_str(defaults::text("entry_audit_msg.clean"));
        } else {
            out.push_str(&self.table());
            out.push('\n');
            out.push_str(&self.summary("entry_audit_msg.summary"));
        }
        out.push_str(&format!("\n{}\n", defaults::text("entry_audit_msg.generators_head")));
        for (id, kind, path) in &self.generators {
            out.push_str(&defaults::render("entry_audit_msg.generator_row", &[("id", id), ("kind", kind), ("path", path)]));
            out.push('\n');
        }
        out
    }

    fn json(&self) -> serde_json::Value {
        let counts: serde_json::Map<String, serde_json::Value> = self.counts.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        json!({
            "ok": self.findings.is_empty(),
            "total": self.findings.len(),
            "counts": counts,
            "findings": self.findings.iter().map(|f| json!({"section": f.section, "path": f.path, "line": f.line, "text": f.text, "rule": f.rule})).collect::<Vec<_>>(),
            "generators": self.generators.iter().map(|(id, kind, path)| json!({"id": id, "kind": kind, "path": path})).collect::<Vec<_>>(),
        })
    }
}

fn flag(p: &Parsed, name: &str) -> Option<String> {
    let f = format!("--{name}");
    p.rest.iter().position(|a| *a == f).and_then(|i| p.rest.get(i + 1)).cloned()
}

/// The home directory: the `--home` flag, else the process's.
fn home_dir(p: &Parsed) -> Option<PathBuf> {
    flag(p, "home").map(PathBuf::from).or_else(|| std::env::var_os(defaults::env_name("home")).map(PathBuf::from)).filter(|h| !h.as_os_str().is_empty())
}

/// `audit entry-paths`.
pub fn run_cmd(p: &Parsed) -> i32 {
    if p.rest.first().map(String::as_str) != Some(defaults::text("entry_audit.subcommand")) {
        eprintln!("{}", defaults::text("entry_audit_msg.usage"));
        return 64;
    }
    let root = flag(p, "root").map(PathBuf::from).or_else(defaults::root);
    let (Some(root), Some(home)) = (root, home_dir(p)) else {
        eprintln!("{}", defaults::text("entry_audit_msg.no_root"));
        return 64;
    };
    let report = run(&Opts { root, home, live: !p.rest.iter().any(|a| a == "--no-live") });
    if p.json {
        println!("{}", report.json());
    } else {
        print!("{}", report.text());
    }
    i32::from(!report.findings.is_empty())
}

/// The one-line summary for `doctor`: the audit of the plugin tree at `root` and the machine; `None` when clean.
pub fn doctor_line(root: &Path, home: &Path) -> Option<String> {
    let r = run(&Opts { root: root.to_path_buf(), home: home.to_path_buf(), live: true });
    (!r.findings.is_empty()).then(|| r.summary("entry_audit_msg.doctor_found"))
}
