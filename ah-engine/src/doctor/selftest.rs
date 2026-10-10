//! The live self-tests of `ah-engine doctor`: each built-in check is run in-process on a crafted payload and must block or allow
//! as the Node guard does (`hooks/doctor.js`, "Guard behavior"). The table, the payloads and the finding texts are in
//! the plugin's `engine/defaults/doctor.toml`.
//!
//! The tests run against a throwaway home (never the real one) that is removed afterwards, like the Node doctor's. A payload the
//! engine defers to its Node hook (the check cannot decide it exactly) is reported as such: a deferral is never a pass.
use super::Doc;
use crate::checks::emit_dedupe::sha1_hex;
use crate::checks::{self, Verdict};
use crate::defaults::{self, V};
use crate::migrate::Ctx;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// What a check did with a payload, in the terms of the Node hook's exit code and output.
pub(super) enum Got {
    /// Exit 0.
    Allow(String),
    /// Exit 2.
    Block(String),
    /// The engine does not decide this payload; its Node hook does.
    Defer,
}

fn classify(v: Option<Verdict>) -> Got {
    match v {
        None | Some(Verdict::Allow) => Got::Allow(String::new()),
        Some(Verdict::Block(m)) => Got::Block(m),
        Some(Verdict::Advisory(j)) => Got::Allow(j),
        Some(Verdict::Exact(x)) => {
            let text = format!("{}{}", x.out, x.err);
            if x.code == 2 { Got::Block(text) } else { Got::Allow(text) }
        }
        Some(Verdict::Defer) => Got::Defer,
        Some(Verdict::Routed(inner, _)) => classify(Some(*inner)),
    }
}

/// Run the named check on a payload the way the dispatcher would, with `env` as the request's environment.
pub(super) fn evaluate(name: &str, payload: &Value, env: BTreeMap<String, String>) -> Option<Got> {
    let check = checks::get(name)?;
    let null = Value::Null;
    let subject = Subject {
        event: payload.get("hook_event_name").and_then(Value::as_str).unwrap_or(defaults::text("doctor.default_event")),
        tool: payload.get("tool_name").and_then(Value::as_str),
        cwd: payload.get("cwd").and_then(Value::as_str),
        tool_input: payload.get("tool_input").unwrap_or(&null),
        prompt: payload.get("prompt").and_then(Value::as_str),
    };
    let opts = json!({ "payload_sha1": sha1_hex(payload.to_string().as_bytes()) });
    Some(classify(checks::run_env_guarded(check, &subject, payload, &opts, &RequestEnv::from(env))))
}

/// The Node hook the dispatcher would run when the engine defers: the payload on stdin, the test environment only. `None` when it
/// is not run (`doctor.node_twins` off: the doctor starts no Node) or cannot be run (no Node, no such hook,
/// killed after the time limit); the reason is noted.
pub(super) fn node_hook(ctx: &Ctx, plugin_root: Option<&str>, script: &str, payload: &Value, env: &BTreeMap<String, String>) -> Option<Got> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    if !super::node_twins() {
        return None;
    }
    let path = Path::new(plugin_root?).join(defaults::text("doctor.hooks_dir")).join(script);
    if !path.exists() {
        return None;
    }
    let node = ctx.env.get(defaults::env_name("node")).cloned().unwrap_or_else(|| defaults::text("doctor.node_default").to_string());
    let mut child = match Command::new(&node).arg(&path).env_clear().envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => {
            ctx.io_note("spawn", Path::new(&node), &e);
            return None;
        }
    };
    if let Some(mut stdin) = child.stdin.take()
        && let Err(e) = stdin.write_all(payload.to_string().as_bytes())
    {
        ctx.io_note("write", &path, &e);
    }
    let cap = defaults::num("doctor.max_hook_output");
    /// Capture at most `cap` bytes of a pipe; a read error ends the capture and is returned with what was read.
    fn reader<R: Read + Send + 'static>(pipe: Option<R>, cap: u64) -> std::thread::JoinHandle<(Vec<u8>, Option<std::io::Error>)> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let err = pipe.and_then(|p| p.take(cap).read_to_end(&mut buf).err());
            (buf, err)
        })
    }
    let (out, err) = (reader(child.stdout.take(), cap), reader(child.stderr.take(), cap));
    let deadline = std::time::Instant::now() + defaults::millis("doctor.node_timeout_ms");
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(defaults::millis("doctor.poll_ms")),
            Ok(None) => {
                if let Err(e) = child.kill() {
                    ctx.io_note("kill", &path, &e);
                }
                if let Err(e) = child.wait() {
                    ctx.io_note("wait", &path, &e);
                }
                ctx.note(defaults::render("doctor_msg.hook_timeout", &[("script", &script)]));
                break None;
            }
            Err(e) => {
                ctx.io_note("wait", &path, &e);
                break None;
            }
        }
    };
    let mut text = String::new();
    for h in [out, err] {
        match h.join() {
            Ok((bytes, read_err)) => {
                if let Some(e) = read_err {
                    ctx.io_note("read", &path, &e);
                }
                text.push_str(&String::from_utf8_lossy(&bytes));
            }
            Err(_) => ctx.note(defaults::render("doctor_msg.capture_failed", &[("script", &script)])),
        }
    }
    match status?.code()? {
        2 => Some(Got::Block(text)),
        _ => Some(Got::Allow(text)),
    }
}

/// A throwaway directory under the temp directory, removed when it goes out of scope. A failure to remove it is noted.
pub(super) struct Scratch<'a> {
    pub(super) dir: PathBuf,
    ctx: &'a Ctx,
}

impl<'a> Scratch<'a> {
    pub(super) fn new(ctx: &'a Ctx, label: &str) -> Option<Scratch<'a>> {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "{}{label}-{}-{}",
            defaults::text("doctor.selftest_home_prefix"),
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        match std::fs::create_dir_all(&dir) {
            Ok(()) => Some(Scratch { dir, ctx }),
            Err(e) => {
                ctx.io_note("mkdir", &dir, &e);
                None
            }
        }
    }
}

impl Drop for Scratch<'_> {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_dir_all(&self.dir) {
            self.ctx.io_note("rmdir", &self.dir, &e);
        }
    }
}

/// The environment of one self-test: the throwaway home, the plugin root, the process's `PATH` and `TMPDIR`, and the test's own.
pub(super) fn test_env(ctx: &Ctx, home: &Path, plugin_root: Option<&str>, extra: &[&str]) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for k in defaults::list("doctor.passthrough_env") {
        if let Some(v) = ctx.env.get(k) {
            env.insert(k.to_string(), v.clone());
        }
    }
    let h = home.to_string_lossy().into_owned();
    env.insert(defaults::env_name("home").to_string(), h.clone());
    env.insert(defaults::env_name("home_alt").to_string(), h);
    if let Some(r) = plugin_root {
        env.insert(defaults::env_name("plugin_root").to_string(), r.to_string());
    }
    for pair in extra {
        if let Some((k, v)) = pair.split_once('=') {
            env.insert(k.to_string(), v.to_string());
        }
    }
    env
}

pub(super) fn now_ms() -> String {
    crate::checks::jsport::num::to_js_string(crate::checks::jsport::date::now_ms())
}

/// Replace each `{NAME}` in every string of a payload.
pub(super) fn fill_value(v: &mut Value, pairs: &[(&str, String)]) {
    match v {
        Value::String(s) => {
            for (k, x) in pairs {
                *s = s.replace(k, x);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| fill_value(x, pairs)),
        Value::Object(o) => o.values_mut().for_each(|x| fill_value(x, pairs)),
        _ => {}
    }
}

/// Run one table row and record its finding.
fn one(doc: &mut Doc, ctx: &Ctx, home: &Scratch<'_>, fixtures: &Scratch<'_>, plugin_root: Option<&str>, t: &V) {
    let name = t.str_field("check");
    let transcript = fixtures.dir.join(defaults::text("doctor.transcript_file"));
    let lines = t.get("transcript").map(V::strings).unwrap_or_default();
    if !lines.is_empty()
        && let Err(e) = std::fs::write(&transcript, format!("{}\n", lines.join("\n")))
    {
        ctx.io_note("open", &transcript, &e);
    }
    let Ok(mut payload) = serde_json::from_str::<Value>(t.str_field("payload")) else {
        doc.bad(t.str_field("bad").to_string());
        return;
    };
    fill_value(
        &mut payload,
        &[("{TRANSCRIPT}", transcript.to_string_lossy().into_owned()), ("{CWD}", fixtures.dir.to_string_lossy().into_owned()), ("{NOW}", now_ms())],
    );
    let event = t.str_field("event");
    if !event.is_empty()
        && let Some(o) = payload.as_object_mut()
    {
        o.insert("hook_event_name".into(), Value::String(event.to_string()));
    }
    let extra = t.get("env").map(V::strings).unwrap_or_default();
    let env = test_env(ctx, &home.dir, plugin_root, &extra);
    let (want, ok, bad, warn) = (t.str_field("want"), t.str_field("ok"), t.str_field("bad"), t.str_field("warn"));
    let got = match evaluate(name, &payload, env.clone()) {
        Some(Got::Defer) | None => node_hook(ctx, plugin_root, t.str_field("script"), &payload, &env).unwrap_or(Got::Defer),
        Some(g) => g,
    };
    match (want, got) {
        (_, Got::Defer) => doc.warnl(defaults::render("doctor_msg.deferred", &[("check", &name)])),
        ("block", Got::Block(_)) | ("allow", Got::Allow(_)) => doc.ok(ok.to_string()),
        ("stop-block", Got::Allow(text) | Got::Block(text)) => {
            if crate::checks::lit_re(defaults::text("doctor.decision_block_re")).is_match(&text) {
                doc.ok(ok.to_string());
            } else {
                doc.bad(bad.to_string());
            }
        }
        (_, got) if !warn.is_empty() => {
            let code = if matches!(got, Got::Block(_)) { 2 } else { 0 };
            doc.warnl(defaults::fill(warn, &[("code", &code)]));
        }
        _ => doc.bad(bad.to_string()),
    }
}

/// `versionAlertTest`: a newer cached version must alert, an equal one must stay silent.
fn version_alert(doc: &mut Doc, ctx: &Ctx, plugin_root: Option<&str>, version: &str) {
    let Some(home) = Scratch::new(ctx, "va") else { return };
    let cache = home.dir.join(defaults::text("migrate.base_dir")).join(defaults::text("doctor.version_check_file"));
    let write = |latest: &str| -> bool {
        let body = format!("{{\"latest\":{},\"checkedAt\":{}}}", crate::checks::jsport::json::quote(latest), now_ms());
        if let Some(d) = cache.parent()
            && let Err(e) = std::fs::create_dir_all(d)
        {
            ctx.io_note("mkdir", d, &e);
            return false;
        }
        match std::fs::write(&cache, body) {
            Ok(()) => true,
            Err(e) => {
                ctx.io_note("open", &cache, &e);
                false
            }
        }
    };
    let run = |sid: &str| {
        let payload: Value = serde_json::from_str(&defaults::fill(defaults::text("doctor.version_alert_payload"), &[("SID", &format!("{sid}-{}", now_ms()))]))
            .unwrap_or(Value::Null);
        let env = test_env(ctx, &home.dir, plugin_root, &defaults::list("doctor.version_alert_env"));
        match evaluate(defaults::text("doctor.version_alert_check"), &payload, env.clone()) {
            Some(Got::Defer) | None => node_hook(ctx, plugin_root, defaults::text("doctor.version_alert_script"), &payload, &env),
            other => other,
        }
    };
    let text = |g: Option<Got>| match g {
        Some(Got::Allow(t) | Got::Block(t)) => Some(t),
        _ => None,
    };
    let sessions = defaults::list("doctor.version_alert_sessions");
    let (stale_run, current_run) = (write(defaults::text("doctor.stale_version")).then(|| run(sessions[0])), write(version).then(|| run(sessions[1])));
    // the engine deferred and no Node twin ran: not exercised, so a deferral (a warning), never a pass or a failure
    if !super::node_twins() && [&stale_run, &current_run].iter().any(|r| matches!(r, Some(None | Some(Got::Defer)))) {
        doc.warnl(defaults::render("doctor_msg.deferred", &[("check", &defaults::text("doctor.version_alert_check"))]));
        return;
    }
    let (stale, current) = (stale_run.flatten().and_then(|g| text(Some(g))), current_run.flatten().and_then(|g| text(Some(g))));
    let passed = match (stale, current) {
        (Some(s), Some(c)) => {
            let alert = crate::checks::lit_re(&defaults::fill(
                defaults::text("doctor.version_alert_re"),
                &[("stale", &regex::escape(defaults::text("doctor.stale_version")))],
            ));
            alert.is_match(&s) && c.trim().is_empty()
        }
        _ => false,
    };
    if passed {
        doc.ok(defaults::text("doctor_msg.version_alert_ok").to_string());
    } else {
        doc.bad(defaults::text("doctor_msg.version_alert_bad").to_string());
    }
}

/// Run every self-test, in the Node doctor's order, and record the findings.
pub(super) fn run(doc: &mut Doc, ctx: &Ctx, plugin_root: Option<&str>, version: &str) {
    let (Some(home), Some(fixtures)) = (Scratch::new(ctx, "home"), Scratch::new(ctx, "fx")) else { return };
    for t in defaults::raw("doctor.selftests").as_array().unwrap_or_default() {
        one(doc, ctx, &home, &fixtures, plugin_root, t);
    }
    version_alert(doc, ctx, plugin_root, version);
}

/// A built-in check run on a payload; when the engine defers it, its Node hook `script` runs instead, as the dispatcher would.
pub(super) fn run_check(ctx: &Ctx, plugin_root: Option<&str>, check: &str, script: &str, payload: &Value, env: &BTreeMap<String, String>) -> Got {
    match evaluate(check, payload, env.clone()) {
        Some(Got::Defer) | None => node_hook(ctx, plugin_root, script, payload, env).unwrap_or(Got::Defer),
        Some(g) => g,
    }
}

impl Got {
    /// What the check printed, `None` when it was deferred and could not be run.
    pub(super) fn text(&self) -> Option<&str> {
        match self {
            Got::Allow(t) | Got::Block(t) => Some(t),
            Got::Defer => None,
        }
    }
}
