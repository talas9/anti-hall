//! Section 4 of the audit: a read-only look at the running machine. Nothing is changed and nothing is started except the two listing
//! commands named in `entry_audit.toml` (the process list and the crontab).
use super::rules::{Cfg, Finding, rx};
use super::scan::{self, Entry};
use crate::defaults;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The standard output of the command whose words are the list `key`, or nothing when it cannot run or fails.
fn run_list(key: &str) -> String {
    let words = defaults::list(key);
    let Some((prog, args)) = words.split_first() else { return String::new() };
    Command::new(prog).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

fn processes(cfg: &Cfg, section: &str, out: &mut Vec<Finding>) {
    let Some(re) = rx("live_proc_re", defaults::text("entry_audit.live_proc_re")) else { return };
    let words = defaults::num("entry_audit.live_proc_tokens") as usize;
    let own = std::process::id().to_string();
    for row in run_list("entry_audit.live_ps").lines() {
        let row = row.trim();
        let Some((pid, command)) = row.split_once(char::is_whitespace) else { continue };
        let head = command.split_whitespace().take(words).collect::<Vec<_>>().join(" ");
        let rule = defaults::text("entry_audit_msg.live_proc");
        if pid != own && re.is_match(&head) && !cfg.allowed(section, pid, command, rule) {
            out.push(Finding { section: section.to_string(), path: defaults::render("entry_audit_msg.live_proc_path", &[("pid", &pid)]), line: 0, text: command.trim().to_string(), rule: rule.to_string() });
        }
    }
}

fn units(cfg: &Cfg, home: &Path, section: &str, out: &mut Vec<Finding>) {
    let dir = home.join(defaults::text("entry_audit.live_plist_dir"));
    let Some(name_re) = rx("live_plist_re", defaults::text("entry_audit.live_plist_re")) else { return };
    let mut entries = Vec::new();
    scan::walk(&dir, &mut entries);
    for e in entries.into_iter().filter(|e| !e.link) {
        if !e.path.file_name().and_then(|n| n.to_str()).is_some_and(|n| name_re.is_match(n)) {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&e.path) {
            out.extend(cfg.scan_text(section, &format!("~/{}", scan::shown(home, &e.path)), &text));
        }
    }
}

fn crontab(cfg: &Cfg, section: &str, out: &mut Vec<Finding>) {
    let text: String = run_list("entry_audit.live_crontab").lines().filter(|l| !l.trim_start().starts_with('#')).collect::<Vec<_>>().join("\n");
    out.extend(cfg.scan_text(section, defaults::text("entry_audit_msg.live_cron_path"), &text));
}

/// The plugin roots a hook can run from: the installed-plugins entries that are anti-hall's, plus the extra roots.
fn plugin_roots(home: &Path) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let key_re = rx("live_plugin_key_re", defaults::text("entry_audit.live_plugin_key_re"));
    let json: Value = std::fs::read_to_string(home.join(defaults::text("entry_audit.live_installed_json"))).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    // only installs the host has ENABLED run hooks: a disabled cache is not live
    let host: Value = std::fs::read_to_string(home.join(defaults::text("entry_audit.live_enabled_file"))).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let enabled = |k: &str| host.pointer(defaults::text("entry_audit.live_enabled_pointer")).and_then(|m| m.get(k)).and_then(Value::as_bool).unwrap_or(false);
    let mut any_enabled = false;
    let mut stack = vec![&json];
    while let Some(v) = stack.pop() {
        match v {
            Value::Object(m) => {
                for (k, x) in m {
                    if key_re.as_ref().is_some_and(|r| r.is_match(k)) {
                        if !enabled(k) {
                            continue;
                        }
                        any_enabled = true;
                        let items = x.as_array().cloned().unwrap_or_else(|| vec![x.clone()]);
                        roots.extend(items.iter().filter_map(|i| i.get("installPath").and_then(Value::as_str)).map(PathBuf::from));
                    } else {
                        stack.push(x);
                    }
                }
            }
            Value::Array(a) => stack.extend(a.iter()),
            _ => {}
        }
    }
    if any_enabled {
        roots.extend(defaults::list("entry_audit.live_roots_extra").into_iter().map(|r| home.join(r)));
    }
    roots.sort();
    roots.dedup();
    roots
}

fn installed_roots(cfg: &Cfg, home: &Path, section: &str, out: &mut Vec<Finding>) {
    for root in plugin_roots(home) {
        for rel in defaults::list("entry_audit.live_root_files") {
            let file = root.join(rel);
            if let Ok(text) = std::fs::read_to_string(&file) {
                out.extend(cfg.scan_text(section, &format!("{}", file.display()), &text));
            }
        }
    }
}

fn launcher_dirs(cfg: &Cfg, home: &Path, section: &str, out: &mut Vec<Finding>) {
    for rel in defaults::list("entry_audit.live_bin_dirs") {
        let mut entries: Vec<Entry> = Vec::new();
        let dir = home.join(rel);
        if let Ok(rd) = std::fs::read_dir(&dir) {
            entries.extend(rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file())).map(|e| Entry { path: e.path(), link: false, mode: 0 }));
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        for e in entries {
            let (labels, sheb) = scan::script_labels(cfg, &e.path, 0, false);
            if labels.is_empty() {
                continue;
            }
            let rule = defaults::text("entry_audit_msg.live_bin");
            let shown = format!("~/{}", scan::shown(home, &e.path));
            let text = sheb.unwrap_or_else(|| labels.join(defaults::text("entry_audit_msg.file_join")));
            if !cfg.allowed(section, &shown, &text, rule) {
                out.push(Finding { section: section.to_string(), path: shown, line: 0, text, rule: rule.to_string() });
            }
        }
    }
}

fn settings(cfg: &Cfg, home: &Path, section: &str, out: &mut Vec<Finding>) {
    let Some(mine) = rx("live_settings_re", defaults::text("entry_audit.live_settings_re")) else { return };
    for rel in defaults::list("entry_audit.live_settings") {
        let json: Value = std::fs::read_to_string(home.join(rel)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        let Some(cmd) = json.pointer("/statusLine/command").and_then(Value::as_str).filter(|c| mine.is_match(c)) else { continue };
        let path = defaults::render("entry_audit_msg.live_status_path", &[("file", &format!("~/{rel}"))]);
        out.extend(cfg.scan_text(section, &path, cmd));
    }
}

/// Section 4: the running processes, the LaunchAgents, the crontab, the hooks.json of the live plugin roots, the launcher directories
/// and the statusLine command.
pub fn findings(cfg: &Cfg, home: &Path, section: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    processes(cfg, section, &mut out);
    units(cfg, home, section, &mut out);
    crontab(cfg, section, &mut out);
    installed_roots(cfg, home, section, &mut out);
    launcher_dirs(cfg, home, section, &mut out);
    settings(cfg, home, section, &mut out);
    out
}
