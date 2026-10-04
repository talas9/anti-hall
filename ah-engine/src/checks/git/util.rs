//! Small helpers: message builder, ASCII case-insensitive matching, Node-compatible path functions,
//! bounded child processes, and the settings / skip.json reads the Node guard performs.
use super::tables::{tables, Switch};
use super::tokenize::js_trim;
use crate::defaults;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// lib/block-message.js `blockMessage({guard:'git-guard', ...})`.
pub struct Msg<'a> {
    /// What was blocked.
    pub what: &'a str,
    /// Why it is blocked.
    pub why: &'a str,
    /// What to do instead.
    pub instead: &'a str,
    /// What is allowed here, if any.
    pub allowed: &'a str,
    /// The override command, if the guard has one.
    pub override_: &'a str,
}

/// Mirrors `lib/block-message.js` `clean`.
fn clean(s: &str) -> String {
    s.split(super::tokenize::is_js_space).filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ")
}

/// Render a block message in the guard's fixed layout (what, why, do instead, allowed, override).
///
/// Mirrors `git-guard.js` `gm`.
pub fn gm(m: Msg) -> String {
    let t = tables();
    let mut lines = vec![format!("{}{}{}", t.block_emoji, t.block_mark, clean(m.what))];
    if !m.why.is_empty() {
        lines.push(format!("{}{}", t.label_why, clean(m.why)));
    }
    if !m.instead.is_empty() {
        lines.push(format!("{}{}", t.label_instead, clean(m.instead)));
    }
    if !m.allowed.is_empty() {
        lines.push(format!("{}{}", t.label_allowed, clean(m.allowed)));
    }
    if !m.override_.is_empty() {
        lines.push(format!("{}{}", t.label_override, clean(m.override_)));
    }
    lines.join("\n")
}

/// A block message with no override line.
pub fn msg(what: &str, why: &str, instead: &str) -> String {
    gm(Msg { what, why, instead, allowed: "", override_: "" })
}

/// A block message with an override line.
pub fn msg_o(what: &str, why: &str, instead: &str, override_: &str) -> String {
    gm(Msg { what, why, instead, allowed: "", override_ })
}

/// Case-insensitive (ASCII only, like the JS /i flag on these patterns) substring test.
pub fn ci_contains(hay: &str, needle: &str) -> bool {
    hay.to_ascii_lowercase().contains(&needle.to_ascii_lowercase())
}

/// ASCII case-insensitive prefix test on a char slice at an offset.
pub fn ci_starts_with(hay: &[char], at: usize, needle: &str) -> bool {
    let nd: Vec<char> = needle.chars().collect();
    if at + nd.len() > hay.len() {
        return false;
    }
    nd.iter().enumerate().all(|(k, &c)| hay[at + k].eq_ignore_ascii_case(&c))
}

// ---------------------------------------------------------------------------------------------------
// Node `path` (posix) functions

/// Lexical normalization like Node `path.posix.normalize`.
pub fn posix_normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let is_abs = p.starts_with('/');
    let trailing = p.ends_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|l| *l != "..") {
                    out.pop();
                } else if !is_abs {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let mut path = out.join("/");
    if path.is_empty() {
        if is_abs {
            return "/".into();
        }
        return if trailing { "./".into() } else { ".".into() };
    }
    if trailing {
        path.push('/');
    }
    if is_abs {
        format!("/{path}")
    } else {
        path
    }
}

/// Like Node `path.posix.dirname`.
pub fn posix_dirname(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let has_root = p.starts_with('/');
    let bytes: Vec<char> = p.chars().collect();
    let mut end: isize = -1;
    let mut matched = true;
    let mut i = bytes.len() as isize - 1;
    while i >= 1 {
        if bytes[i as usize] == '/' {
            if !matched {
                end = i;
                break;
            }
        } else {
            matched = false;
        }
        i -= 1;
    }
    if end == -1 {
        return if has_root { "/".into() } else { ".".into() };
    }
    if has_root && end == 1 {
        return "//".into();
    }
    bytes[..end as usize].iter().collect()
}

/// Like Node `path.posix.basename`.
pub fn posix_basename(p: &str) -> String {
    let t = p.trim_end_matches('/');
    t.rsplit('/').next().unwrap_or("").to_string()
}

/// `path.resolve(base, rel)` for a posix path; `cwd` stands in for `process.cwd()`.
pub fn resolve(base: &str, rel: &str, cwd: &str) -> String {
    let mut stack: Vec<&str> = vec![rel, base];
    let mut resolved = String::new();
    let mut abs = false;
    for part in stack.drain(..) {
        if part.is_empty() {
            continue;
        }
        resolved = if resolved.is_empty() { part.to_string() } else { format!("{part}/{resolved}") };
        if part.starts_with('/') {
            abs = true;
            break;
        }
    }
    if !abs {
        resolved = if resolved.is_empty() { cwd.to_string() } else { format!("{cwd}/{resolved}") };
    }
    let n = posix_normalize(&resolved);
    if n.len() > 1 && n.ends_with('/') {
        n[..n.len() - 1].to_string()
    } else {
        n
    }
}

/// Like Node `path.posix.join`.
pub fn path_join(a: &str, b: &str) -> String {
    if a.is_empty() && b.is_empty() {
        return ".".into();
    }
    let j = if a.is_empty() {
        b.to_string()
    } else if b.is_empty() {
        a.to_string()
    } else {
        format!("{a}/{b}")
    };
    posix_normalize(&j)
}

// ---------------------------------------------------------------------------------------------------
// bounded child process

/// Run `prog args` with a wall-clock timeout; `Some(stdout)` only on exit status 0.
pub fn run_capture(prog: &str, args: &[String], cwd: Option<&str>, env: &HashMap<String, String>, timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(prog);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        let _ = tx.send(b);
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(tables().child_poll),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let bytes = rx.recv_timeout(tables().child_read).unwrap_or_default();
    if !status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).to_string())
}

// ---------------------------------------------------------------------------------------------------
// settings + skip.json (read per call; tiny files)

/// Process environment plus home, read once per request; every switch the Node guard consults resolves through it.
pub struct Settings {
    /// The home directory (`HOME`, else `USERPROFILE`).
    pub home: String,
    /// Snapshot of the environment.
    pub env: HashMap<String, String>,
}

fn bool_token(s: &str) -> Option<bool> {
    match s.trim().to_lowercase().as_str() {
        "1" | "on" | "true" | "yes" => Some(true),
        "0" | "off" | "false" | "no" => Some(false),
        _ => None,
    }
}

impl Settings {
    /// Snapshot the current process environment.
    pub fn from_process() -> Settings {
        let env: HashMap<String, String> = std::env::vars().collect();
        let home = env.get(defaults::env_name("home")).cloned().or_else(|| env.get(defaults::env_name("home_alt")).cloned()).unwrap_or_default();
        Settings { home, env }
    }

    /// `settings.enabled(section, key)`: false only when the switch resolves to exactly `false`.
    /// Chain: env var, settings.json, `CLAUDE_PLUGIN_OPTION_<name>` env, default (on).
    pub fn enabled(&self, sw: &Switch) -> bool {
        if let Some(v) = self.env.get(&sw.env) {
            if let Some(b) = bool_token(v) {
                return b;
            }
        }
        if !self.home.is_empty() {
            let p = format!("{}/{}", self.home, tables().settings_file);
            if let Ok(txt) = std::fs::read_to_string(&p) {
                if let Ok(serde_json::Value::Object(o)) = serde_json::from_str::<serde_json::Value>(&txt) {
                    let v = o.get(&sw.section).and_then(|s| s.as_object()).and_then(|s| s.get(&sw.key));
                    match v {
                        Some(serde_json::Value::Bool(b)) => return *b,
                        Some(serde_json::Value::String(s)) => {
                            if let Some(b) = bool_token(s) {
                                return b;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        if !sw.option.is_empty() {
            if let Some(v) = self.env.get(&format!("{}{}", tables().plugin_option_prefix, sw.option.to_uppercase())) {
                if let Some(b) = bool_token(v) {
                    return b;
                }
            }
        }
        true
    }

    /// Can the Jev add-block consult for `gitGuardSelfCredit` change a verdict? Only when Jev is enabled AND this
    /// integration's mode is `on` (the default `shadow` never changes an outcome). Env > settings.json > jev.json.
    pub fn jev_self_credit_on(&self) -> bool {
        let read = |rel: &str| -> Option<serde_json::Value> {
            if self.home.is_empty() {
                return None;
            }
            std::fs::read_to_string(format!("{}/{rel}", self.home)).ok().and_then(|t| serde_json::from_str(&t).ok())
        };
        let settings = read(&tables().settings_file);
        let jevjson = read(&tables().jev_file);
        let on = |v: Option<&serde_json::Value>| {
            matches!(v, Some(serde_json::Value::Bool(true))) || v.and_then(|x| x.as_str()).is_some_and(|x| bool_token(x) == Some(true))
        };
        let jn = &tables().jev;
        let mut enabled = on(jevjson.as_ref().and_then(|j| j.get(&jn.enabled_key))) || self.env.get(&jn.env_enabled).is_some_and(|v| v == "1");
        if let Some(v) = settings.as_ref().and_then(|j| j.get(&jn.section)).and_then(|j| j.get(&jn.enabled_key)) {
            enabled = on(Some(v));
        }
        if let Some(v) = self.env.get(&jn.env_enabled) {
            if v == "0" {
                enabled = false;
            }
        }
        if !enabled {
            return false;
        }
        if self.env.get(&jn.env_integration).is_some_and(|v| v == "0") {
            return false;
        }
        let mode = settings
            .as_ref()
            .and_then(|j| j.get(&jn.integrations_key))
            .and_then(|j| j.get(&jn.integration))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| self.env.get(&jn.env_integration).cloned())
            .or_else(|| {
                jevjson
                    .as_ref()
                    .and_then(|j| j.get(&jn.jev_json_integrations))
                    .and_then(|j| j.get(&jn.integration))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });
        mode.as_deref() == Some(jn.mode_on.as_str())
    }

    /// skip-guard.js `isSkipped('git-guard')`.
    pub fn is_skipped(&self, name: &str) -> bool {
        if self.home.is_empty() {
            return false;
        }
        let Ok(txt) = std::fs::read_to_string(format!("{}/{}", self.home, tables().skip_file)) else { return false };
        let txt = js_trim(&txt);
        if txt.is_empty() {
            return false;
        }
        let Ok(serde_json::Value::Object(o)) = serde_json::from_str::<serde_json::Value>(txt) else { return false };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        if let Some(v) = o.get(name).and_then(|v| v.as_f64()) {
            if v > now {
                return true;
            }
        }
        // git-guard is a destructive guard: a broad "all" skip does not cover it
        false
    }
}
