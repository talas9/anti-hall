//! The DevSwarm CLI verbs that need no store, ported from `scripts/devswarm.js` and its lib (lane l8): `help` (with the
//! unknown-command answer, since both come out of `run()` before any verb), `skip`, `archive-ignore`, `archive-unignore`,
//! `gate-intent` and `notice --list`.
//!
//! Each answers with the exact stdout and exit code Node's `main()` prints, and writes the same bytes to the same files
//! (`~/.anti-hall/skip.json`, `devswarm/archive-ignore/<id>.json`, `devswarm/parent-gate/<session>.json`). Everything that
//! needs more than the engine reads is a [`Defer`] decided BEFORE the first write, so Node then runs the verb and nothing
//! is written twice:
//!
//! * a home that is not an absolute, already normalized path (Node joins paths lexically);
//! * a state file the engine cannot parse the way `JSON.parse` does (Node starts over from `{}` or reports no block; the
//!   engine does not guess), a key that JavaScript treats specially (`__proto__`), a lone UTF-16 surrogate cut;
//! * a `skip` whose expiry is outside what `Date` can print (Node writes the file and then throws);
//! * every filesystem error on the way to the write (Node's message is the operating system's, not the engine's);
//! * `notice --post` (a rate limit, a settings read, a central-log event and a random id).
//!
//! The Node version stays as the non-acting background witness: [`prepare`] copies what Node reads into a scratch home
//! before the engine writes, [`launch`] starts a detached engine after it answered, and [`run_witness`] runs the real
//! `devswarm.js` there with the engine's clock and compares stdout, exit code and every written file.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - the witness is advisory: a step that fails only means this call is not verified
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::git::util::{path_join, posix_normalize};
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{js_number_of_str, js_trim, js_trim_end, slice_utf16};
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, now_ms, s};
use crate::meshw::ident::{R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::send::{Answer, Effect};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Which verb of this module an argv names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Simple {
    /// Any help request (`help`, `-h`, `--help`, `<verb> --help`).
    Help,
    /// A command that is not a verb.
    Unknown,
    /// `skip <guard> [--ttl <minutes>]`.
    Skip,
    /// `archive-ignore <id>`.
    ArchiveIgnore,
    /// `archive-unignore <id>`.
    ArchiveUnignore,
    /// `gate-intent --reason <text> [--session <id>]`.
    GateIntent,
    /// `notice --list` (and its usage error); `--post` is Node's.
    Notice,
}

/// The verb of a parsed argv, in the order `run()` meets them: a help request first (before any verb, whatever it names),
/// then the verb itself, and a command that is no verb at all is the unknown-command answer.
pub fn classify(a: &Args) -> Option<Simple> {
    if a.is_help() {
        return Some(Simple::Help);
    }
    let cmd = a.positionals.first().map(String::as_str);
    let is = |k: &str| cmd == Some(defaults::text(k));
    if is("devswarm_cli.verb_skip") {
        Some(Simple::Skip)
    } else if is("devswarm_cli.verb_archive_ignore") {
        Some(Simple::ArchiveIgnore)
    } else if is("devswarm_cli.verb_archive_unignore") {
        Some(Simple::ArchiveUnignore)
    } else if is("devswarm_cli.verb_gate_intent") {
        Some(Simple::GateIntent)
    } else if is("devswarm_cli.verb_notice") {
        Some(Simple::Notice)
    } else if cmd.is_some_and(|c| defaults::list("devswarm_cli.verbs").contains(&c)) {
        None
    } else {
        Some(Simple::Unknown)
    }
}

/// Run one of the verbs.
pub fn run(inv: &Inv, a: &Args, v: Simple) -> R<Answer> {
    match v {
        Simple::Help => help(a),
        Simple::Unknown => Ok(unknown(a)),
        Simple::Skip => skip(inv, a),
        Simple::ArchiveIgnore => ignore(inv, a, true),
        Simple::ArchiveUnignore => ignore(inv, a, false),
        Simple::GateIntent => gate_intent(inv, a),
        Simple::Notice => notice(inv, a),
    }
}

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", v.stringify()), effect: Effect::None }
}

/// `{ok:false, error}` with exit code 2.
fn fail(msg: &str) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(msg));
    answer(2, o.done())
}

fn quote(x: &str) -> String {
    serde_json::to_string(x).unwrap_or_default()
}

// ---- help ---------------------------------------------------------------------------------------------------------------

/// `VERB_HELP[verb]`: the synopsis and the side-effect note (`None` when empty).
fn info(verb: &str) -> (String, Option<String>) {
    match defaults::raw("devswarm_cli.help").get(verb) {
        Some(v) => (v.str_field("synopsis").to_string(), Some(v.str_field("mutates").to_string()).filter(|m| !m.is_empty())),
        None => (defaults::text("devswarm_cli.no_synopsis").to_string(), None),
    }
}

/// `topLevelUsage()`.
fn top_usage(verbs: &[&str]) -> String {
    let mut lines = vec![defaults::text("devswarm_cli.usage_head").to_string(), String::new(), defaults::text("devswarm_cli.usage_verbs_label").to_string()];
    for v in verbs {
        let (syn, mutates) = info(v);
        let note = match mutates {
            Some(m) if m != defaults::text("devswarm_cli.read_only_word") => defaults::render("devswarm_cli.usage_mutates", &[("mutates", &m)]),
            _ => String::new(),
        };
        lines.push(defaults::render("devswarm_cli.usage_verb_line", &[("verb", v), ("synopsis", &syn), ("mutates", &note)]));
    }
    lines.push(String::new());
    lines.push(defaults::text("devswarm_cli.usage_tail").to_string());
    lines.join("\n")
}

/// `verbUsage(verb)`.
fn verb_usage(verb: &str, verbs: &[&str]) -> String {
    if !verbs.contains(&verb) {
        return format!("{}\n\n{}", defaults::render("devswarm_cli.unknown_verb", &[("verb", &quote(verb))]), top_usage(verbs));
    }
    let (syn, mutates) = info(verb);
    let mut lines = vec![defaults::render("devswarm_cli.verb_usage_head", &[("verb", &verb)]), String::new(), syn];
    if let Some(m) = mutates {
        lines.push(String::new());
        lines.push(defaults::render("devswarm_cli.side_effects", &[("mutates", &m)]));
    }
    lines.join("\n")
}

fn utf16(x: &str) -> usize {
    x.chars().map(char::len_utf16).sum()
}

/// `shortSynopsis(text)`: the first line, cut to the short-index width. `None` when the cut would split a surrogate pair.
fn short_synopsis(text: &str) -> Option<String> {
    let line = js_trim(text.split('\n').next().unwrap_or("")).to_string();
    let max = defaults::num("devswarm_cli.short_max") as usize;
    if utf16(&line) <= max {
        return Some(line);
    }
    let cut = slice_utf16(&line, max - 1)?;
    Some(format!("{}{}", js_trim_end(&cut), defaults::text("devswarm_cli.ellipsis")))
}

/// The help answer: `run()`'s help intercept and `main()`'s rendering of it.
fn help(a: &Args) -> R<Answer> {
    let cmd = a.positionals.first().map(String::as_str);
    let verb = if cmd == Some(defaults::text("devswarm_cli.verb_help")) {
        a.positionals.get(1).map(String::as_str)
    } else if cmd == Some(defaults::text("mesh_write.flag_dash_h")) {
        None
    } else {
        cmd
    }
    .filter(|v| !v.is_empty());
    let verbs = defaults::list("devswarm_cli.verbs");
    let short = a.has(defaults::text("devswarm_cli.flag_short")) && verb.is_none();
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("action", s(defaults::text("devswarm_cli.action_help")));
    let usage = if short {
        o.put("short", OVal::Bool(true)).put("verb", OVal::Null).put("known", OVal::Bool(true));
        let mut lines = Vec::new();
        for v in &verbs {
            let (syn, _) = info(v);
            // a synopsis whose cut splits a surrogate pair cannot be built here: it never occurs in the shipped table, and the
            // table is compared with Node's by the parity test
            let syn = short_synopsis(&syn).unwrap_or(syn);
            lines.push(defaults::render("devswarm_cli.short_verb_line", &[("verb", v), ("synopsis", &syn)]));
        }
        lines.join("\n")
    } else {
        o.put("verb", verb.map_or(OVal::Null, s)).put("known", OVal::Bool(verb.is_none_or(|v| verbs.contains(&v))));
        verb.map_or_else(|| top_usage(&verbs), |v| verb_usage(v, &verbs))
    };
    o.put("verbs", OVal::Arr(verbs.iter().map(|v| s(v)).collect())).put("usage", s(&usage));
    let argv0 = a.raw.first().map(String::as_str).unwrap_or("");
    if a.raw.iter().any(|w| w == defaults::text("devswarm_cli.json_word")) || defaults::list("devswarm_cli.help_json_verbs").contains(&argv0) {
        return Ok(answer(0, o.done()));
    }
    // main() renders a help result with the verb's own renderer for these shapes (a one-line summary, a report, the quiet
    // line); the engine does not reproduce them, and none of them is the usage text
    let has = |w: &str| a.raw.iter().any(|x| x == w);
    let quiet = format!("--{}", defaults::text("mesh_write.flag_quiet"));
    let format_text = has(&format!("{}={}", defaults::text("devswarm_cli.format_flag"), defaults::text("devswarm_cli.format_text")))
        || a.raw
            .iter()
            .position(|x| x == defaults::text("devswarm_cli.format_flag"))
            .is_some_and(|i| a.raw.get(i + 1).map(String::as_str) == Some(defaults::text("devswarm_cli.format_text")));
    let at = |i: usize, k: &str| a.raw.get(i).map(String::as_str) == Some(defaults::text(k));
    let own = defaults::list("devswarm_cli.help_own_renderer_verbs").contains(&argv0)
        || (at(0, "mesh_write.verb_send") && has(&quiet))
        || (at(0, "mesh_write.verb_inbox") && at(1, "mesh_write.verb_tick") && has(&quiet))
        || (at(0, "mesh_write.verb_inbox") && at(1, "mesh_write.verb_read_primary") && format_text);
    if own {
        return defer("help-renderer");
    }
    Ok(Answer { code: 0, stdout: format!("{usage}\n"), effect: Effect::None })
}

/// The `default:` branch of `runArmed`.
fn unknown(a: &Args) -> Answer {
    let cmd = a.positionals.first().map(String::as_str).unwrap_or("");
    let verbs = defaults::list("devswarm_cli.verbs").join(defaults::text("devswarm_cli.verb_sep"));
    fail(&defaults::render("devswarm_cli.msg_unknown_command", &[("cmd", &quote(cmd)), ("verbs", &verbs)]))
}

// ---- shared bits --------------------------------------------------------------------------------------------------------

/// The home as a string Node's `path.join` would leave alone.
fn home_str(inv: &Inv) -> R<String> {
    let Some(h) = inv.home.to_str() else { return defer("home-shape") };
    if !h.starts_with('/') || posix_normalize(h) != h {
        return defer("home-shape");
    }
    Ok(h.to_string())
}

/// `home/<anti-hall dir>`.
fn ah_dir(home: &str) -> String {
    path_join(home, defaults::text("mesh_write.dir_anti_hall"))
}

/// A file's text as `readFileSync(.., 'utf8')` gives it; `None` when it cannot be read.
fn read_text(p: &Path) -> Option<String> {
    std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// `JSON.parse` of a state file the engine will rewrite: a lone surrogate escape is the one value serde rejects and
/// JavaScript accepts, so it (and any parse failure) is a deferral rather than a guess.
fn parse_state(text: &str) -> R<OVal> {
    if text.to_ascii_lowercase().contains("\\ud") {
        return defer("state-surrogate");
    }
    OVal::parse(text).map_or_else(|| defer("state-unparseable"), Ok)
}

/// Write `body` to `file` through `<file><suffix>` and a rename, as Node does; any error defers (nothing is left behind).
fn stage_and_rename(file: &str, tmp: &str, body: &str) -> R<()> {
    if let Some(dir) = Path::new(file).parent()
        && std::fs::create_dir_all(dir).is_err()
    {
        return defer("io");
    }
    if std::fs::write(tmp, body).is_err() {
        crate::discard::harmless(std::fs::remove_file(tmp)); // keep: a half-written staging file is only disk
        return defer("io");
    }
    if std::fs::rename(tmp, file).is_err() {
        crate::discard::harmless(std::fs::remove_file(tmp)); // keep: as above
        return defer("io");
    }
    Ok(())
}

/// Record what the verb wrote for the witness (`rel` is relative to the home).
fn wrote(home: &str, file: &str, body: &str) {
    crate::meshw::mark_committed();
    crate::meshw::note_written(file.strip_prefix(&format!("{home}/")).unwrap_or(file), body.as_bytes());
}

// ---- skip ---------------------------------------------------------------------------------------------------------------

fn skip(inv: &Inv, a: &Args) -> R<Answer> {
    let guard = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if guard.is_empty() {
        return Ok(fail(defaults::text("devswarm_cli.msg_skip_usage")));
    }
    let ttl_flag = defaults::text("devswarm_cli.flag_ttl");
    let mut ttl = defaults::num("devswarm_cli.skip_default_ttl_min") as f64;
    let raw = a.one(ttl_flag);
    if a.has(ttl_flag) && raw.is_none() {
        return Ok(fail(defaults::text("devswarm_cli.msg_skip_ttl_missing")));
    }
    if let Some(r) = raw {
        let v = js_number_of_str(r);
        if !v.is_finite() || v <= 0.0 {
            return Ok(fail(defaults::text("devswarm_cli.msg_skip_ttl_bad")));
        }
        ttl = v;
    }
    // `data['__proto__'] = x` sets a prototype in JavaScript, not a key
    if guard == "__proto__" {
        return defer("proto-key");
    }
    let home = home_str(inv)?;
    let file = path_join(&ah_dir(&home), defaults::text("devswarm_cli.skip_file"));
    let mut data = OVal::Obj(Vec::new());
    if let Some(text) = read_text(Path::new(&file)) {
        let t = js_trim(&text);
        if !t.is_empty() {
            // a parsed value that is no plain object starts over, as Node's
            if let o @ OVal::Obj(_) = parse_state(t)? {
                data = o;
            }
        }
    }
    let now = inv.now as f64;
    let expires = now + ttl * defaults::num("devswarm_cli.skip_ms_per_min") as f64;
    if !expires.is_finite() {
        return Ok(fail(defaults::text("devswarm_cli.msg_skip_ttl_infinite")));
    }
    // Node writes the file and only then formats the date; a date it cannot format throws after the write
    let Some(iso) = crate::checks::jsport::date::to_iso(expires) else { return defer("date-range") };
    data.set(guard, n(expires));
    let body = data.stringify_pretty();
    stage_and_rename(&file, &format!("{file}.{}.tmp", std::process::id()), &body)?;
    wrote(&home, &file, &body);
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("devswarm_cli.action_skip")))
        .put("guard", s(guard))
        .put("ttlMinutes", n(ttl))
        .put("expiresAt", n(expires))
        .put("expiresAtIso", s(&iso))
        .put("path", s(&file));
    Ok(answer(0, o.done()))
}

// ---- archive-ignore / archive-unignore ------------------------------------------------------------------------------------

fn ignore(inv: &Inv, a: &Args, set: bool) -> R<Answer> {
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if !is_safe_id(id) {
        return Ok(fail(defaults::text("devswarm_cli.msg_bad_id")));
    }
    let home = home_str(inv)?;
    let dir = devswarm_root(Path::new(&home)).join(defaults::text("devswarm_cli.ignore_dir"));
    let file = dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let file_s = file.to_string_lossy().into_owned();
    let mut o = Obj::default();
    if set {
        let mut mark = Obj::default();
        mark.put("id", s(id)).put("ignoredAt", n(inv.now as f64));
        let body = mark.done().stringify();
        stage_and_rename(&file_s, &format!("{file_s}{}", defaults::text("mesh_write.tmp_suffix")), &body)?;
        wrote(&home, &file_s, &body);
        o.put("ok", OVal::Bool(true)).put("action", s(defaults::text("devswarm_cli.action_archive_ignore"))).put("id", s(id)).put("ignored", OVal::Bool(true));
    } else {
        let removed = std::fs::remove_file(&file).is_ok();
        if removed {
            wrote(&home, &file_s, "");
        }
        o.put("ok", OVal::Bool(true))
            .put("action", s(defaults::text("devswarm_cli.action_archive_unignore")))
            .put("id", s(id))
            .put("removed", OVal::Bool(removed));
    }
    Ok(answer(0, o.done()))
}

// ---- gate-intent --------------------------------------------------------------------------------------------------------

/// `String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_')`: the pattern has no `u` flag, so a character outside the basic plane is
/// two UTF-16 units and becomes two underscores.
fn safe_session(session: &str) -> String {
    let mut out = String::new();
    for c in session.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            out.push(c);
        } else {
            out.push_str(&"_".repeat(c.len_utf16()));
        }
    }
    out
}

fn gate_intent(inv: &Inv, a: &Args) -> R<Answer> {
    let env = |k: &str| inv.env.get(k).filter(|v| !v.is_empty()).map(String::as_str);
    let session = a
        .one(defaults::text("devswarm_cli.flag_session"))
        .filter(|v| !v.is_empty())
        .or_else(|| env(defaults::text("mesh_write.env_session_id")))
        .or_else(|| env(defaults::text("devswarm_role.builder_env")));
    let Some(session) = session else { return Ok(fail(defaults::text("devswarm_cli.msg_gate_no_session"))) };
    let reason = a.one(defaults::text("devswarm_cli.flag_reason")).map(js_trim).unwrap_or("");
    if reason.is_empty() {
        return Ok(fail(defaults::text("devswarm_cli.msg_gate_no_reason")));
    }
    let home = home_str(inv)?;
    let dir = devswarm_root(Path::new(&home)).join(defaults::text("devswarm_cli.gate_dir"));
    let file = dir.join(format!("{}{}", safe_session(session), defaults::text("mesh_write.json_suffix")));
    let file_s = file.to_string_lossy().into_owned();
    let existing = match read_text(&file) {
        None => None,
        Some(text) => Some(parse_state(&text)?),
    };
    let sig = match existing.as_ref().and_then(|e| e.get("sig")) {
        Some(OVal::Str(x)) => x.clone(),
        _ => String::new(),
    };
    if sig.is_empty() {
        return Ok(fail(&defaults::render("devswarm_cli.msg_gate_no_block", &[("session", &quote(session))])));
    }
    let Some(mut next) = existing.filter(|e| matches!(e, OVal::Obj(_))) else { return defer("state-shape") };
    // `nextIntents['__proto__'] = ...` and `Object.assign` of an own `__proto__` key both set a prototype, not a key
    if sig == "__proto__" || next.get("__proto__").is_some() {
        return defer("proto-key");
    }
    let max = defaults::num("devswarm_cli.gate_reason_max") as usize;
    let kept = if utf16(reason) > max {
        let Some(c) = slice_utf16(reason, max) else { return defer("surrogate-cut") };
        c
    } else {
        reason.to_string()
    };
    let mut one_intent = Obj::default();
    one_intent.put("ts", n(inv.now as f64)).put("reason", s(&kept));
    let mut intents = Obj::default();
    intents.put(&sig, one_intent.done());
    next.set("intents", intents.done());
    let body = next.stringify();
    stage_and_rename(&file_s, &format!("{file_s}.{}.tmp", std::process::id()), &body)?;
    wrote(&home, &file_s, &body);
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("devswarm_cli.action_gate_intent")))
        .put("session", s(session))
        .put("sig", s(&sig))
        .put("ts", n(inv.now as f64));
    Ok(answer(0, o.done()))
}

// ---- notice -------------------------------------------------------------------------------------------------------------

/// `Number(x) || 0` of a notice's `ts`; a value whose coercion the engine does not reproduce defers.
fn ts_key(v: Option<&OVal>) -> R<f64> {
    let x = match v {
        None | Some(OVal::Null) => 0.0,
        Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
        Some(OVal::Num(x)) => *x,
        Some(OVal::Str(t)) => js_number_of_str(t),
        Some(_) => return defer("notice-ts"),
    };
    if x.is_nan() {
        return Ok(0.0);
    }
    if !x.is_finite() {
        return defer("notice-ts");
    }
    Ok(x)
}

fn notice(inv: &Inv, a: &Args) -> R<Answer> {
    if a.has(defaults::text("devswarm_cli.flag_post")) {
        return defer("notice-post");
    }
    if !a.has(defaults::text("devswarm_cli.flag_list")) {
        return Ok(fail(defaults::text("devswarm_cli.msg_notice_usage")));
    }
    let home = home_str(inv)?;
    let file = devswarm_root(Path::new(&home)).join(defaults::text("devswarm_cli.notice_file"));
    let mut rows: Vec<OVal> = Vec::new();
    for line in read_text(&file).unwrap_or_default().split('\n') {
        let t = js_trim(line);
        if t.is_empty() {
            continue;
        }
        let row = parse_state(t)?;
        if matches!(row, OVal::Obj(_)) && row.get("id").is_some_and(OVal::truthy) {
            rows.push(row);
        }
    }
    let now = inv.now as f64;
    let mut live: Vec<(f64, OVal)> = Vec::new();
    for r in rows {
        let expired = matches!(r.get("expiresAt"), Some(OVal::Num(x)) if x.is_finite() && *x <= now);
        if !expired {
            live.push((ts_key(r.get("ts"))?, r));
        }
    }
    live.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
    let shown = defaults::num("devswarm_cli.notice_max_shown") as usize;
    let from = live.len().saturating_sub(shown);
    let notices: Vec<OVal> = live[from..]
        .iter()
        .map(|(_, r)| {
            let mut o = Obj::default();
            for k in ["id", "ts", "expiresAt", "text"] {
                if let Some(v) = r.get(k) {
                    o.put(k, v.clone());
                }
            }
            o.done()
        })
        .collect();
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("notices", OVal::Arr(notices));
    Ok(answer(0, o.done()))
}

// ---- the Node witness ---------------------------------------------------------------------------------------------------

/// Copy what Node reads or rewrites for these verbs into a scratch home; `None` when that fails (the call is then not
/// verified).
pub fn prepare(inv: &Inv) -> Option<PathBuf> {
    let scratch = crate::paths::dir().join(defaults::text("devswarm_cli.witness_dir")).join(format!("{}-{}", std::process::id(), now_ms()));
    let home = scratch.join(defaults::text("mesh_write.shadow_home"));
    std::fs::create_dir_all(&home).ok()?;
    for rel in defaults::list("devswarm_cli.witness_copy_paths") {
        let src = inv.home.join(rel);
        let dst = home.join(rel);
        if src.is_dir() {
            crate::meshw::verify::copy_tree(&src, &dst).ok()?;
        } else if src.is_file() {
            std::fs::create_dir_all(dst.parent()?).ok()?;
            std::fs::copy(&src, &dst).ok()?;
        }
    }
    Some(scratch)
}

/// After the engine answered: save what it printed and wrote, and start the detached witness.
pub fn launch(scratch: &Path, inv: &Inv, argv: &[String], ans: &Answer) {
    let (written, _) = crate::meshw::take_written();
    let save = || -> std::io::Result<()> {
        std::fs::write(scratch.join("expect-stdout"), &ans.stdout)?;
        std::fs::write(scratch.join("expect-code"), ans.code.to_string())?;
        let mut manifest = Vec::new();
        for (i, (rel, bytes)) in written.iter().enumerate() {
            std::fs::write(scratch.join(format!("expect-w{i}")), bytes)?;
            manifest.push(serde_json::json!([rel, format!("expect-w{i}")]));
        }
        std::fs::write(scratch.join("expect-manifest"), serde_json::Value::Array(manifest).to_string())
    };
    if save().is_err() {
        crate::meshw::verify::discard_tree(scratch);
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let mut c = Command::new(exe);
    c.arg(defaults::text("mesh_write.verb_mesh")).arg(defaults::text("devswarm_cli.witness_flag")).arg(scratch).arg(inv.now.to_string()).args(argv);
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0);
    crate::discard::harmless(c.spawn()); // keep: a witness that does not start only leaves this call unverified
}

/// The witness process: `args` = scratch dir, clock, the verb's argv. Runs the real `devswarm.js` in the scratch home and
/// logs whether its stdout, exit code and written files equal the engine's.
pub fn run_witness(args: &[String]) -> i32 {
    let t0 = now_ms();
    let (Some(scratch), Some(now)) = (args.first().map(PathBuf::from), args.get(1)) else { return 1 };
    let argv = &args[2..];
    let verb = argv.first().cloned().unwrap_or_default();
    let log = |result: &str, extra: serde_json::Value| {
        let mut rec = serde_json::json!({"ts": t0, "verb": verb, "result": result, "ms": now_ms() - t0, "kind": "cli"});
        if let (Some(r), Some(e)) = (rec.as_object_mut(), extra.as_object()) {
            r.extend(e.clone());
        }
        crate::meshw::verify_log(&rec);
    };
    let home = scratch.join(defaults::text("mesh_write.shadow_home"));
    let Some(root) = defaults::root() else {
        log(defaults::text("mesh_write.verify_error"), serde_json::json!({"reason": "no-plugin-root"}));
        return 0;
    };
    let real_home = std::env::var_os(defaults::text("mesh_write.env_home")).map(PathBuf::from).unwrap_or_default();
    let mut node = Command::new(defaults::text("mesh_write.node_bin"));
    node.arg("-e")
        .arg(defaults::text("devswarm_cli.witness_node_snippet"))
        .arg(root.join(defaults::text("mesh_write.node_cli")))
        .arg(now)
        .args(argv)
        .env(defaults::text("mesh_write.env_home"), &home)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    match crate::meshw::verify::bounded_output(&mut node) {
        Ok(o) => {
            let read = |p: &Path| std::fs::read(p).unwrap_or_default();
            let node_stdout = String::from_utf8_lossy(&o.stdout).replace(&home.to_string_lossy().into_owned(), &real_home.to_string_lossy());
            let node_code = o.status.code().unwrap_or(-1);
            let want_stdout = String::from_utf8_lossy(&read(&scratch.join("expect-stdout"))).into_owned();
            let want_code: i32 = String::from_utf8_lossy(&read(&scratch.join("expect-code"))).trim().parse().unwrap_or(-1);
            let manifest: Vec<(String, String)> = serde_json::from_slice(&read(&scratch.join("expect-manifest"))).unwrap_or_default();
            let mut diff: Vec<String> = Vec::new();
            for (rel, file) in &manifest {
                if read(&scratch.join(file)) != read(&home.join(rel)) {
                    diff.push(rel.clone());
                }
            }
            if node_stdout == want_stdout && node_code == want_code && diff.is_empty() {
                log(defaults::text("mesh_write.verify_match"), serde_json::json!({}));
            } else {
                let cap = |t: &str| t.chars().take(defaults::num("mesh_write.verify_cap") as usize).collect::<String>();
                log(
                    defaults::text("mesh_write.verify_mismatch"),
                    serde_json::json!({"engine": cap(&want_stdout), "node": cap(&node_stdout), "engineCode": want_code, "nodeCode": node_code, "diff": diff}),
                );
            }
        }
        Err(_) => log(defaults::text("mesh_write.verify_error"), serde_json::json!({"reason": "node"})),
    }
    crate::meshw::verify::discard_tree(&scratch);
    0
}
