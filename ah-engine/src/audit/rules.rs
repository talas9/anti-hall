//! The audit's data from `engine/defaults/audit.toml`: the command-string rules, the allowlist and the general lists. Nothing here is a
//! pattern or a word of the audit itself (D88); an invalid pattern in the file is reported and skipped, never a panic.
use crate::defaults::{self, V};
use regex::Regex;

/// One finding of the audit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// The section (a name from `audit.sections`).
    pub section: String,
    /// The file, process or source the finding is in.
    pub path: String,
    /// The 1-based line, 0 when the finding has no line.
    pub line: usize,
    /// The offending text.
    pub text: String,
    /// The rule that matched.
    pub rule: String,
}

/// A command-string rule.
struct Rule {
    id: String,
    scope: Vec<String>,
    re: Option<Regex>,
    path: Option<Regex>,
    line: Option<Regex>,
    must: Option<Regex>,
}

/// An allowlist entry.
struct Allow {
    section: String,
    path: Option<Regex>,
    text: Option<Regex>,
    rule: String,
}

/// The audit's configuration, read once per run.
pub struct Cfg {
    rules: Vec<Rule>,
    allow: Vec<Allow>,
    /// The extensions (with the dot) of a script file.
    pub exts: Vec<String>,
    /// The file paths whose lines are checked for command strings.
    pub cmd_files: Vec<Regex>,
}

/// A pattern from the file; an invalid one is reported and dropped.
pub fn rx(id: &str, pattern: &str) -> Option<Regex> {
    if pattern.is_empty() {
        return None;
    }
    Regex::new(pattern)
        .map_err(|e| eprintln!("{}", defaults::render("audit_msg.bad_regex", &[("id", &id), ("error", &e)])))
        .ok()
}

fn opt(v: &V, id: &str, key: &str) -> Option<Regex> {
    rx(id, v.str_field(key))
}

fn hit(re: &Option<Regex>, s: &str) -> bool {
    re.as_ref().is_none_or(|r| r.is_match(s))
}

impl Cfg {
    /// Read the rules and lists from the shipped defaults.
    pub fn load() -> Cfg {
        let rules = defaults::raw("audit.rules")
            .as_array()
            .unwrap_or_default()
            .iter()
            .map(|r| {
                let id = r.str_field("id");
                Rule {
                    id: id.to_string(),
                    scope: r.get("scope").map(|s| s.strings().into_iter().map(str::to_string).collect()).unwrap_or_default(),
                    re: opt(r, id, "re"),
                    path: opt(r, id, "path"),
                    line: opt(r, id, "line"),
                    must: opt(r, id, "must"),
                }
            })
            .filter(|r| r.re.is_some() || r.must.is_some())
            .collect();
        let allow = defaults::raw("audit.allow")
            .as_array()
            .unwrap_or_default()
            .iter()
            .map(|a| Allow { section: a.str_field("section").to_string(), path: opt(a, "allow", "path"), text: opt(a, "allow", "text"), rule: a.str_field("rule").to_string() })
            .collect();
        Cfg {
            rules,
            allow,
            exts: defaults::list("audit.file_exts").into_iter().map(str::to_string).collect(),
            cmd_files: defaults::list("audit.cmd_files").into_iter().filter_map(|p| rx("cmd_files", p)).collect(),
        }
    }

    /// Whether the allowlist lets a finding through.
    pub fn allowed(&self, section: &str, path: &str, text: &str, rule: &str) -> bool {
        self.allow.iter().any(|a| a.section == section && hit(&a.path, path) && hit(&a.text, text) && (a.rule.is_empty() || a.rule == rule))
    }

    /// The findings in `text` (a file's content, a plist, a crontab): every line a rule of `section` flags and the allowlist does not
    /// pass. `path` is what the report shows.
    pub fn scan_text(&self, section: &str, path: &str, text: &str) -> Vec<Finding> {
        let mut out = Vec::new();
        for (i, raw) in text.lines().enumerate() {
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }
            for r in self.rules.iter().filter(|r| r.scope.is_empty() || r.scope.iter().any(|s| s == section)) {
                let flagged = match &r.must {
                    Some(must) => hit(&r.path, path) && r.line.as_ref().is_some_and(|l| l.is_match(line)) && !must.is_match(line),
                    None => hit(&r.path, path) && r.re.as_ref().is_some_and(|re| re.is_match(line)),
                };
                if flagged && !self.allowed(section, path, line, &r.id) {
                    out.push(Finding { section: section.to_string(), path: path.to_string(), line: i + 1, text: line.to_string(), rule: r.id.clone() });
                }
            }
        }
        out
    }
}
