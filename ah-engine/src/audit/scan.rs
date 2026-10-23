//! Sections 1 to 3 of the audit: the files of the plugin tree, the command strings, and what the engine itself generates.
use super::rules::{Cfg, Finding};
use crate::defaults;
use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// What a walk found: a path, and whether it is a symbolic link (never followed).
pub struct Entry {
    pub path: PathBuf,
    pub link: bool,
    pub mode: u32,
}

/// Every file and symbolic link under `dir`, skipping the directory names of `audit.skip_dirs`. Symbolic links are listed, not followed.
pub fn walk(dir: &Path, out: &mut Vec<Entry>) {
    let skip = defaults::list("audit.skip_dirs");
    walk_in(dir, &skip, out);
}

fn walk_in(dir: &Path, skip: &[&str], out: &mut Vec<Entry>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    paths.sort();
    for p in paths {
        let Ok(m) = fs::symlink_metadata(&p) else { continue };
        if m.file_type().is_symlink() {
            out.push(Entry { path: p, link: true, mode: 0 });
        } else if m.is_dir() {
            if !p.file_name().and_then(|n| n.to_str()).is_some_and(|n| skip.contains(&n)) {
                walk_in(&p, skip, out);
            }
        } else if m.is_file() {
            out.push(Entry { path: p, link: false, mode: m.permissions().mode() });
        }
    }
}

/// The display path: relative to `base`, or to the home directory as `~/...`.
pub fn shown(base: &Path, p: &Path) -> String {
    p.strip_prefix(base).unwrap_or(p).to_string_lossy().into_owned()
}

/// The first line of a file when it starts with the interpreter marker.
pub fn shebang_line(p: &Path) -> Option<String> {
    let marker = defaults::text("audit.shebang");
    let mut buf = vec![0u8; 256];
    let n = fs::File::open(p).and_then(|mut f| f.read(&mut buf)).ok()?;
    buf.truncate(n);
    let text = String::from_utf8_lossy(&buf).into_owned();
    text.starts_with(marker).then(|| text.lines().next().unwrap_or_default().to_string())
}

/// The labels (joined) of why a file is a script: an execute bit (only when `exec_bit`), an interpreter line, a script extension.
pub fn script_labels(cfg: &Cfg, p: &Path, mode: u32, exec_bit: bool) -> (Vec<&'static str>, Option<String>) {
    let mut labels = Vec::new();
    if exec_bit && mode & 0o111 != 0 {
        labels.push(defaults::text("audit_msg.file_exec"));
    }
    let sheb = shebang_line(p);
    if sheb.is_some() {
        labels.push(defaults::text("audit_msg.file_shebang"));
    }
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_lowercase();
    if cfg.exts.iter().any(|e| name.ends_with(e.as_str())) {
        labels.push(defaults::text("audit_msg.file_ext"));
    }
    (labels, sheb)
}

/// Section 1: the files of the plugin tree `plugin` that are scripts and not on the allowlist.
pub fn files(cfg: &Cfg, base: &Path, plugin: &Path, section: &str) -> Vec<Finding> {
    let mut entries = Vec::new();
    walk(plugin, &mut entries);
    let mut out = Vec::new();
    for e in entries {
        let rel = shown(base, &e.path);
        if e.link {
            let target = fs::read_link(&e.path).map(|t| t.to_string_lossy().into_owned()).unwrap_or_default();
            let text = defaults::render("audit_msg.link_text", &[("target", &target)]);
            out.extend(cfg.scan_text(section, &rel, &target).into_iter().map(|f| Finding { text: text.clone(), ..f }));
            continue;
        }
        let (labels, sheb) = script_labels(cfg, &e.path, e.mode, true);
        if labels.is_empty() {
            continue;
        }
        let rule = labels.join(defaults::text("audit_msg.file_join"));
        let text = sheb.unwrap_or_else(|| defaults::render("audit_msg.file_mode", &[("mode", &format!("{:04o}", e.mode & 0o7777))]));
        if !cfg.allowed(section, &rel, &text, &rule) {
            out.push(Finding { section: section.to_string(), path: rel, line: 0, text, rule });
        }
    }
    out
}

/// Section 2: the command strings in the files of `roots` that `audit.cmd_files` names.
pub fn commands(cfg: &Cfg, base: &Path, roots: &[PathBuf], section: &str) -> Vec<Finding> {
    let max = defaults::num("audit.max_file_bytes");
    let mut out = Vec::new();
    for root in roots {
        let mut entries = Vec::new();
        if root.is_file() {
            entries.push(Entry { path: root.clone(), link: false, mode: 0 });
        } else {
            walk(root, &mut entries);
        }
        for e in entries.into_iter().filter(|e| !e.link) {
            let rel = shown(base, &e.path);
            if !cfg.cmd_files.iter().any(|r| r.is_match(&rel)) || fs::metadata(&e.path).is_ok_and(|m| m.len() > max) {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&e.path) {
                out.extend(cfg.scan_text(section, &rel, &text));
            }
        }
    }
    out
}

/// One generated file: where the engine would write it and what.
pub struct Generated {
    pub id: String,
    pub kind: String,
    pub path: PathBuf,
    pub text: String,
}

/// What every generator of `audit.generators` would write under `home`.
pub fn generated(home: &Path) -> Vec<Generated> {
    let h = home.to_string_lossy().into_owned();
    let mut out = Vec::new();
    for g in defaults::raw("audit.generators").as_array().unwrap_or_default() {
        let (id, kind) = (g.str_field("id").to_string(), g.str_field("kind").to_string());
        match kind.as_str() {
            "shim" => {
                let watcher = g.get("watcher").and_then(defaults::V::as_bool).unwrap_or(false);
                let name = defaults::raw(g.str_field("row")).str_field("name");
                let path = home.join(defaults::text("devswarm_role.bin_dir")).join(name);
                out.push(Generated { id, kind, path, text: crate::checks::devswarm_role::text::shim_source(watcher, &h) });
            }
            "unit" => {
                let Some(m) = crate::setup::units::manager(defaults::text(g.str_field("os_key"))) else { continue };
                let exe = crate::paths::dir().join(defaults::text("doctor.bin_dir")).join(defaults::text("doctor.bin_name"));
                for (path, text) in crate::setup::units::engine_files(m, home, &exe.to_string_lossy()) {
                    out.push(Generated { id: id.clone(), kind: kind.clone(), path, text });
                }
            }
            _ => {}
        }
    }
    out
}

/// Section 3: what the generators would write that breaks the rules: a script extension, an interpreter line, a forbidden command.
pub fn generated_findings(cfg: &Cfg, home: &Path, gens: &[Generated], section: &str) -> Vec<Finding> {
    let mut out = Vec::new();
    for g in gens {
        let shown_path = shown(home, &g.path);
        let shown_path = if g.path.starts_with(home) { format!("~/{shown_path}") } else { shown_path };
        let name = g.path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_lowercase();
        let marker = defaults::text("audit.shebang");
        let first = g.text.lines().next().unwrap_or_default().to_string();
        let mut push = |rule: &str, text: String| {
            let f = Finding { section: section.to_string(), path: shown_path.clone(), line: 0, text, rule: rule.to_string() };
            if !cfg.allowed(section, &f.path, &f.text, rule) {
                out.push(f);
            }
        };
        if cfg.exts.iter().any(|e| name.ends_with(e.as_str())) {
            push(defaults::text("audit_msg.gen_name"), name.clone());
        }
        if g.text.starts_with(marker) {
            push(defaults::text("audit_msg.gen_shebang"), first);
        }
        for f in cfg.scan_text(section, &shown_path, &g.text) {
            if !out.iter().any(|o| o.path == f.path && o.line == f.line && o.rule == f.rule) {
                out.push(f);
            }
        }
    }
    out
}
