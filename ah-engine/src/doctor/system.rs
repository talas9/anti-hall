//! The machine around the engine: HOME, PATH, the tools the hook wrapper needs, Node (the fallback), git and gh, WSL, the log and
//! telemetry files, and the optional Node witness kit. Every probe of another program is bounded ([`crate::proc::run`]).
use super::Doc;
use crate::defaults;
use crate::migrate::Ctx;
use std::collections::BTreeMap;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// The first executable named `name` on `path` (a colon list), searched the way a shell does.
pub fn which(name: &str, path: &str) -> Option<PathBuf> {
    path.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(name)).find(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & defaults::num("doctor.exec_bit") as u32 != 0))
}

/// Run `program args` bounded; its first stdout line, or why it failed.
fn probe(program: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    match crate::proc::run(cmd, defaults::text("doctor.probe_label"), defaults::millis("doctor.probe_timeout_ms"), defaults::millis("doctor.probe_poll_ms")) {
        Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string()),
        Ok(o) => Err(defaults::render(
            "doctor_msg.why_exit",
            &[("code", &o.status.code().unwrap_or(-1)), ("err", &String::from_utf8_lossy(&o.stderr).lines().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(defaults::num("doctor.why_max") as usize).collect::<String>())],
        )),
        Err(crate::proc::Error::Timeout) => Err(defaults::text("doctor_msg.why_timeout").to_string()),
        Err(e) => Err(e.into_io().to_string()),
    }
}

/// The major version of a `node --version` line such as `v22.3.0`.
pub fn node_major(v: &str) -> Option<u64> {
    v.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

/// PATH findings: empty, relative or empty entries, missing system directories.
pub fn path_findings(path: Option<&str>) -> Vec<(bool, String)> {
    let Some(p) = path.filter(|p| !p.is_empty()) else {
        return vec![(true, defaults::text("doctor_msg.path_empty").to_string())];
    };
    let mut out = Vec::new();
    let entries: Vec<&str> = p.split(':').collect();
    for e in &entries {
        if e.is_empty() || !e.starts_with('/') {
            let shown = if e.is_empty() { defaults::text("doctor_msg.path_empty_entry") } else { e };
            out.push((false, defaults::render("doctor_msg.path_relative", &[("entry", &shown)])));
        }
    }
    let lacking: Vec<&str> = defaults::list("doctor.core_dirs").into_iter().filter(|d| !entries.contains(d)).collect();
    if lacking.len() == defaults::list("doctor.core_dirs").len() {
        out.push((false, defaults::render("doctor_msg.path_lacks", &[("dirs", &lacking.join(", "))])));
    }
    out
}

/// EV-01..11, ND-01..05: HOME, PATH, tools, Node, git, gh, WSL. Returns whether Node can run.
pub fn environment_section(doc: &mut Doc, ctx: &Ctx, engine_usable: bool, uid: u32) -> bool {
    doc.head(defaults::text("doctor_msg.head_toolchain"));
    let home = &ctx.home;
    if !Path::new(home).is_absolute() {
        doc.bad(defaults::render("doctor_msg.home_relative", &[("home", home)]));
    } else {
        match std::fs::metadata(home) {
            Ok(m) if m.is_dir() => {
                if let Some(pw) = super::facts::passwd_home().filter(|pw| pw != home)
                    && m.uid() != uid
                {
                    doc.warnl(defaults::render("doctor_msg.home_differs", &[("home", home), ("pw", &pw)]));
                }
            }
            _ => doc.bad(defaults::render("doctor_msg.home_not_dir", &[("home", home)])),
        }
    }
    let env_path = ctx.env.get("PATH").map(String::as_str);
    for (bad, msg) in path_findings(env_path) {
        if bad {
            doc.bad(msg);
        } else {
            doc.warnl(msg);
        }
    }
    let path = env_path.unwrap_or("");
    let missing: Vec<&str> = defaults::list("doctor.required_tools").into_iter().filter(|t| which(t, path).is_none()).collect();
    if !missing.is_empty() {
        doc.warnl(defaults::render("doctor_msg.tools_missing", &[("tools", &missing.join(", "))]));
    }
    if let Some(stat) = which("stat", path) {
        let flavour = if probe(&stat, &defaults::list("doctor.stat_gnu_args")).is_ok() { "doctor_msg.userland_gnu" } else { "doctor_msg.userland_bsd" };
        doc.infol(defaults::render("doctor_msg.userland", &[("flavour", &defaults::text(flavour))]));
    }
    if std::fs::read_to_string(defaults::text("doctor.proc_version")).is_ok_and(|r| super::runtime::is_wsl(&r)) {
        let release = std::fs::read_to_string(defaults::text("doctor.proc_version")).unwrap_or_default();
        doc.infol(defaults::render("doctor_msg.wsl", &[("release", &release.split_whitespace().nth(2).unwrap_or(""))]));
    }
    match which("git", path) {
        None => doc.warnl(defaults::text("doctor_msg.git_missing").to_string()),
        Some(g) => {
            if let Err(why) = probe(&g, &["--version"]) {
                doc.warnl(defaults::render("doctor_msg.git_broken", &[("why", &why)]));
            }
        }
    }
    if which("gh", path).is_none() {
        doc.infol(defaults::text("doctor_msg.gh_missing").to_string());
    }
    let min = defaults::num("doctor.node_min_major");
    let mut node_ok = false;
    match which("node", path) {
        None => {
            doc.warnl(defaults::render("doctor_msg.node_missing", &[("min", &min)]));
            if !engine_usable {
                doc.bad(defaults::text("doctor_msg.no_engine_no_node").to_string());
            }
        }
        Some(n) => match probe(&n, &["--version"]) {
            Err(why) => doc.bad(defaults::render("doctor_msg.node_broken", &[("why", &why)])),
            Ok(v) if node_major(&v).is_some_and(|m| m >= min) => {
                node_ok = true;
                doc.ok(defaults::render("doctor_msg.node_ok", &[("v", &v), ("min", &min)]));
            }
            Ok(v) => doc.bad(defaults::render("doctor_msg.node_old", &[("v", &v), ("min", &min)])),
        },
    }
    node_ok
}

/// The cached verdict on whether this Claude Code version has a usable `doctor` subcommand: `<version> <yes|no>`.
fn claude_cache() -> PathBuf {
    crate::paths::dir().join(defaults::text("doctor.claude_cache"))
}

/// An optional, bounded sub-check: Claude Code's own `claude doctor` (installation health, settings problems), run once per
/// Claude Code version to learn whether the subcommand exists, skipped when the CLI is missing or does not have it. Its problem
/// lines are shown next to ours; the checks it already makes (its install method, updater, settings parsing) are not repeated.
pub fn claude_section(doc: &mut Doc, ctx: &Ctx) {
    doc.head(defaults::text("doctor_msg.head_claude"));
    let path = ctx.env.get("PATH").map(String::as_str).unwrap_or("");
    let Some(claude) = which(defaults::text("doctor.claude_bin"), path) else {
        doc.infol(defaults::text("doctor_msg.claude_missing").to_string());
        return;
    };
    let ver = probe(&claude, &["--version"]).unwrap_or_default();
    let cache = claude_cache();
    let known = std::fs::read_to_string(&cache).ok().and_then(|t| t.trim().rsplit_once(' ').map(|(v, s)| (v.to_string(), s.to_string())));
    if known.as_ref().is_some_and(|(v, s)| *v == ver && s == defaults::text("doctor.claude_no")) {
        doc.infol(defaults::render("doctor_msg.claude_unsupported", &[("v", &ver)]));
        return;
    }
    let mut cmd = std::process::Command::new(&claude);
    cmd.arg(defaults::text("doctor.claude_sub"));
    let out = crate::proc::run(cmd, defaults::text("doctor.probe_label"), defaults::millis("doctor.claude_timeout_ms"), defaults::millis("doctor.probe_poll_ms"));
    let (text, supported) = match out {
        Ok(o) if o.status.success() => {
            let t = String::from_utf8_lossy(&o.stdout).into_owned();
            let ok = t.contains(defaults::text("doctor.claude_marker"));
            (t, ok)
        }
        Ok(_) => (String::new(), false),
        Err(crate::proc::Error::Timeout) => {
            doc.infol(defaults::render("doctor_msg.claude_timeout", &[("v", &ver)]));
            return;
        }
        Err(_) => (String::new(), false),
    };
    if cache.parent().is_some_and(Path::is_dir) {
        let verdict = if supported { defaults::text("doctor.claude_yes") } else { defaults::text("doctor.claude_no") };
        crate::discard::harmless(std::fs::write(&cache, format!("{ver} {verdict}\n"))); // keep: only a cache of a probe; the next run probes again
    }
    if !supported {
        doc.infol(defaults::render("doctor_msg.claude_unsupported", &[("v", &ver)]));
        return;
    }
    if text.contains(defaults::text("doctor.claude_clean")) {
        doc.ok(defaults::render("doctor_msg.claude_ok", &[("v", &ver)]));
        return;
    }
    let words = defaults::list("doctor.claude_problem_words");
    let problems: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty() && words.iter().any(|w| l.to_lowercase().contains(w))).take(defaults::num("doctor.claude_max_lines") as usize).collect();
    if problems.is_empty() {
        doc.ok(defaults::render("doctor_msg.claude_ok", &[("v", &ver)]));
    }
    for l in problems {
        doc.warnl(defaults::render("doctor_msg.claude_problem", &[("line", &l)]));
    }
}

fn tail(p: &Path) -> Option<(u64, Vec<String>)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(p).ok()?;
    let len = f.metadata().ok()?.len();
    let want = defaults::num("doctor.tail_bytes");
    f.seek(SeekFrom::Start(len.saturating_sub(want))).ok()?;
    let mut buf = Vec::new();
    f.take(want).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    let skip = usize::from(len > want);
    Some((len, text.lines().skip(skip).map(str::to_string).collect()))
}

fn mb(n: u64) -> u64 {
    n / defaults::num("doctor.mb")
}

/// LG-01..05: the event log, the telemetry inbox, quarantined spool files.
pub fn logs_section(doc: &mut Doc) {
    doc.head(defaults::text("doctor_msg.head_logs"));
    let dir = crate::paths::dir();
    let factor = defaults::num("doctor.log_warn_factor");
    let mut clean = true;
    let log = dir.join(crate::health::log_name());
    if let Some((len, lines)) = tail(&log) {
        let cap = defaults::num("health.log_cap");
        if len > cap.saturating_mul(factor) {
            clean = false;
            doc.warnl(defaults::render("doctor_msg.log_huge", &[("file", &log.display()), ("mb", &mb(len)), ("cap_mb", &mb(cap))]));
        }
        let bad = lines.iter().filter(|l| !l.is_empty() && !(l.splitn(4, '\t').count() == 4 && l.split('\t').next().is_some_and(|t| t.parse::<u64>().is_ok()))).count();
        if bad > 0 {
            clean = false;
            doc.warnl(defaults::render("doctor_msg.log_corrupt", &[("n", &bad), ("m", &lines.len()), ("file", &log.display())]));
        }
    }
    let inbox = dir.join(defaults::text("files.telemetry_inbox"));
    if let Some((len, lines)) = tail(&inbox) {
        let cap = defaults::num("telemetry.inbox_max_bytes");
        if len > cap.saturating_mul(factor) {
            clean = false;
            doc.warnl(defaults::render("doctor_msg.inbox_huge", &[("file", &inbox.display()), ("mb", &mb(len)), ("cap_mb", &mb(cap))]));
        }
        let bad = lines.iter().filter(|l| !l.is_empty() && serde_json::from_str::<serde_json::Value>(l).is_err()).count();
        if bad > 0 {
            clean = false;
            doc.warnl(defaults::render("doctor_msg.inbox_corrupt", &[("n", &bad), ("m", &lines.len()), ("file", &inbox.display())]));
        }
    }
    let quarantine = dir.join(defaults::text("files.spool_quarantine"));
    let held = std::fs::read_dir(&quarantine).map(|rd| rd.flatten().count()).unwrap_or(0);
    if held > 0 {
        clean = false;
        doc.warnl(defaults::render("doctor_msg.spool_quarantined", &[("n", &held), ("dir", &quarantine.display())]));
    }
    if clean {
        doc.ok(defaults::text("doctor_msg.logs_ok").to_string());
    }
}

/// Expand a leading `~` or `$HOME` in a hook command's path token.
fn expand(tok: &str, home: &str) -> String {
    let t = tok.trim_matches(|c| c == '"' || c == '\'');
    for p in ["~", "$HOME", "${HOME}"] {
        if let Some(rest) = t.strip_prefix(p) {
            return format!("{home}{rest}");
        }
    }
    t.to_string()
}

/// SH-01..07: the optional Node witness kit.
pub fn witness_section(doc: &mut Doc, ctx: &Ctx) {
    doc.head(defaults::text("doctor_msg.head_witness"));
    let dir = Path::new(&ctx.home).join(defaults::text("paths.base_dir")).join(defaults::text("doctor.shadow_dir"));
    let script = defaults::text("doctor.shadow_script");
    let settings = Path::new(&ctx.home).join(defaults::text("doctor.claude_settings"));
    let registered: Vec<String> = std::fs::read_to_string(&settings)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .map(|v| {
            let mut cmds = BTreeMap::new();
            collect_commands(&v, &mut cmds);
            cmds.into_keys().filter(|c| c.contains(script)).collect()
        })
        .unwrap_or_default();
    if !dir.exists() && registered.is_empty() {
        doc.infol(defaults::text("doctor_msg.witness_absent").to_string());
        return;
    }
    let mut clean = true;
    for cmd in &registered {
        let target = cmd.split_whitespace().find(|t| t.contains(script)).map(|t| expand(t, &ctx.home));
        if target.is_some_and(|t| !Path::new(&t).exists()) {
            clean = false;
            doc.warnl(defaults::render("doctor_msg.witness_script_gone", &[("cmd", cmd)]));
            break;
        }
    }
    if dir.join(script).exists() && !dir.join(defaults::text("doctor.shadow_skip")).exists() {
        clean = false;
        doc.warnl(defaults::render("doctor_msg.witness_no_skip", &[("dir", &dir.display())]));
    }
    if let Ok(root) = std::fs::read_to_string(dir.join(defaults::text("doctor.shadow_root")))
        && !root.trim().is_empty()
        && !Path::new(root.trim()).exists()
    {
        clean = false;
        doc.warnl(defaults::render("doctor_msg.witness_root_gone", &[("root", &root.trim())]));
    }
    let log = dir.join(defaults::text("doctor.shadow_log"));
    if let Ok(m) = std::fs::metadata(&log) {
        if m.len() > defaults::num("doctor.shadow_log_warn_mb") * defaults::num("doctor.mb") {
            clean = false;
            doc.warnl(defaults::render("doctor_msg.witness_log_huge", &[("file", &log.display()), ("mb", &mb(m.len()))]));
        }
        let age_days = m.modified().ok().and_then(|t| t.elapsed().ok()).map_or(0, |d| d.as_secs() / defaults::num("doctor.day_s"));
        if !registered.is_empty() && age_days >= defaults::num("doctor.shadow_stale_days") {
            clean = false;
            doc.warnl(defaults::render("doctor_msg.witness_stale", &[("days", &age_days)]));
        }
    }
    if clean {
        let lines = std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
        doc.ok(defaults::render("doctor_msg.witness_ok", &[("mb", &mb(lines)), ("n", &registered.len())]));
    }
}

fn collect_commands(v: &serde_json::Value, out: &mut BTreeMap<String, ()>) {
    match v {
        serde_json::Value::Object(m) => {
            if let Some(c) = m.get("command").and_then(|c| c.as_str()) {
                out.insert(c.to_string(), ());
            }
            m.values().for_each(|x| collect_commands(x, out));
        }
        serde_json::Value::Array(a) => a.iter().for_each(|x| collect_commands(x, out)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_versions_parse() {
        assert_eq!(node_major("v22.3.0"), Some(22));
        assert_eq!(node_major("v8.17.0"), Some(8));
        assert_eq!(node_major("garbage"), None);
    }

    #[test]
    fn path_oddities() {
        crate::defaults::init().unwrap();
        assert!(path_findings(None)[0].0 && path_findings(Some(""))[0].0);
        let rel = path_findings(Some("/usr/bin:.:/bin"));
        assert_eq!(rel.len(), 1, "{rel:?}");
        assert!(rel[0].1.contains('.'));
        assert!(path_findings(Some("/usr/bin::/bin")).iter().any(|f| f.1.contains("empty")));
        assert!(path_findings(Some("/opt/x")).iter().any(|f| f.1.contains("/usr/bin")));
        assert!(path_findings(Some("/usr/bin:/bin")).is_empty());
    }

    #[test]
    fn home_prefixes_expand() {
        assert_eq!(expand("\"$HOME/.a/b.sh\"", "/h"), "/h/.a/b.sh");
        assert_eq!(expand("~/x", "/h"), "/h/x");
        assert_eq!(expand("/abs", "/h"), "/abs");
    }
}
