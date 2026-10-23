//! The DevSwarm CLI verbs that need no store, ported from `scripts/devswarm.js` and its lib (lane l8): `help` (with the
//! unknown-command answer, since both come out of `run()` before any verb), `skip`, `archive-ignore`, `archive-unignore`,
//! `gate-intent` and `notice --list`.
//!
//! Each answers with the exact stdout and exit code Node's `main()` prints, and writes the same bytes to the same files
//! (`~/.anti-hall/skip.json`, `devswarm/archive-ignore/<id>.json`, `devswarm/parent-gate/<session>.json`). Nothing here hands a
//! case to Node: a state file the engine cannot read the way `JSON.parse` does is what Node's own `try`/`catch` makes of it
//! (start over, no block recorded, a skipped line), except a lone UTF-16 surrogate escape in a file the verb rewrites, which is
//! refused with a message instead of being rewritten differently; every filesystem error is worded the way Node words it and
//! printed (and logged) as the exception it would have been; `notice --post` is ported with its rate limit, settings read,
//! central-log events and random id.
//!
//! The Node version stays as the non-acting background witness: [`prepare`] copies what Node reads into a scratch home
//! before the engine writes, [`launch`] starts a detached engine after it answered, and [`run_witness`] runs the real
//! `devswarm.js` there with the engine's clock and compares stdout, exit code and every written file.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - the witness is advisory: a step that fails only means this call is not verified
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::git::util::path_join;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{js_number_of_str, js_trim, js_trim_end, slice_utf16};
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident::{self, R};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::send::{Answer, Effect};
use std::path::Path;

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
    /// `wake-directive <id>` for a child workspace.
    WakeDirective,
    /// `logs [--repo --component --min-level --since --limit]`.
    Logs,
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
    } else if is("devswarm_cli.verb_logs") {
        Some(Simple::Logs)
    } else if is("devswarm_cli.verb_wake_directive") {
        Some(Simple::WakeDirective)
    } else if cmd.is_some_and(|c| defaults::list("devswarm_cli.verbs").contains(&c)) || is("devswarm_cli.verb_create") {
        // `create` is the engine's other name of `spawn` (not one of devswarm.js's verbs)
        None
    } else {
        Some(Simple::Unknown)
    }
}

/// Run one of the verbs.
pub fn run(inv: &Inv, a: &Args, v: Simple) -> R<Answer> {
    match v {
        Simple::Help => Ok(help(a)),
        Simple::Unknown => Ok(unknown(a)),
        Simple::Skip => skip(inv, a),
        Simple::ArchiveIgnore => ignore(inv, a, true),
        Simple::ArchiveUnignore => ignore(inv, a, false),
        Simple::GateIntent => gate_intent(inv, a),
        Simple::Notice => notice(inv, a),
        Simple::WakeDirective => wake_directive(inv, a),
        Simple::Logs => logs(inv, a),
    }
}

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", unshield(&v.stringify())), effect: Effect::None }
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
fn help(a: &Args) -> Answer {
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
        return answer(0, o.done());
    }
    // main() renders a help result with the verb's own renderer for these shapes (a one-line summary, a report, the quiet
    // line); each of them is fed a help-shaped object, which has none of the fields they read: the line is therefore fixed
    let has = |w: &str| a.raw.iter().any(|x| x == w);
    let quiet = format!("--{}", defaults::text("mesh_write.flag_quiet"));
    let format_text = has(&format!("{}={}", defaults::text("devswarm_cli.format_flag"), defaults::text("devswarm_cli.format_text")))
        || a.raw
            .iter()
            .position(|x| x == defaults::text("devswarm_cli.format_flag"))
            .is_some_and(|i| a.raw.get(i + 1).map(String::as_str) == Some(defaults::text("devswarm_cli.format_text")));
    let at = |i: usize, k: &str| a.raw.get(i).map(String::as_str) == Some(defaults::text(k));
    let renderer = if at(0, "mesh_write.verb_send") && has(&quiet) {
        Some(defaults::text("devswarm_cli.help_render_send_quiet"))
    } else if at(0, "mesh_write.verb_inbox") && at(1, "mesh_write.verb_tick") && has(&quiet) {
        Some(defaults::text("devswarm_cli.help_render_tick_quiet"))
    } else if at(0, "mesh_write.verb_inbox") && at(1, "mesh_write.verb_read_primary") && format_text {
        Some(defaults::text("devswarm_cli.help_render_read_primary_text"))
    } else {
        // healthcheck / diagnose render the empty report; `supervision-report`'s own renderer throws on a help result in Node
        // (no such table entry), so it prints the usage like every other verb
        defaults::raw("devswarm_cli.help_own_render").get(argv0).and_then(|v| v.as_str())
    };
    Answer { code: 0, stdout: format!("{}\n", renderer.unwrap_or(&usage)), effect: Effect::None }
}

/// The `default:` branch of `runArmed`.
fn unknown(a: &Args) -> Answer {
    let cmd = a.positionals.first().map(String::as_str).unwrap_or("");
    let verbs = defaults::list("devswarm_cli.verbs").join(defaults::text("devswarm_cli.verb_sep"));
    fail(&defaults::render("devswarm_cli.msg_unknown_command", &[("cmd", &quote(cmd)), ("verbs", &verbs)]))
}

// ---- shared bits --------------------------------------------------------------------------------------------------------

/// The home as the absolute, normalized path Node's `path.join` and the file calls work on (a relative home is read against the
/// caller's directory, as Node's process would).
fn home_str(inv: &Inv) -> String {
    let h = inv.home.to_string_lossy();
    if h.starts_with('/') { ident::resolve_abs(&h) } else { ident::resolve(&inv.cwd, &h) }
}

/// `home/<anti-hall dir>`.
fn ah_dir(home: &str) -> String {
    path_join(home, defaults::text("mesh_write.dir_anti_hall"))
}

/// A file's text as `readFileSync(.., 'utf8')` gives it; `None` when it cannot be read.
fn read_text(p: &Path) -> Option<String> {
    std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// Where the stand-ins for lone surrogates start: Supplementary Private Use Area-A, one character per surrogate unit.
fn shield_base() -> u32 {
    defaults::num("devswarm_cli.act_shield_base") as u32
}

/// `JSON.parse` keeps a lone UTF-16 surrogate (`"\\ud800"`), a Rust string cannot. [`shield`] replaces each such escape of the
/// text with a private-use character before it is parsed; [`unshield`] writes the escapes back (as `JSON.stringify` spells them,
/// lower case) into whatever is printed or written.
fn shield(text: &str) -> Option<String> {
    if text.chars().any(|c| (shield_base()..shield_base() + 0x800).contains(&(c as u32))) {
        return None; // a text that already holds the stand-ins would be unshielded wrongly: it is taken as unreadable
    }
    if !text.contains("\\u") {
        return Some(text.to_string());
    }
    let unit_at = |chars: &[char], i: usize| -> Option<u32> {
        let hex: String = chars.get(i..i + 4)?.iter().collect();
        u32::from_str_radix(&hex, 16).ok().filter(|_| hex.chars().all(|c| c.is_ascii_hexdigit()))
    };
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '\\' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        // an escape: `\\x` is two characters, `\\uXXXX` six
        if chars.get(i + 1) != Some(&'u') {
            out.extend(chars.get(i..i + 2).unwrap_or(&chars[i..]));
            i += 2;
            continue;
        }
        match unit_at(&chars, i + 2) {
            Some(hi) if (0xD800..0xDC00).contains(&hi) && chars.get(i + 6) == Some(&'\\') && chars.get(i + 7) == Some(&'u') => {
                if unit_at(&chars, i + 8).is_some_and(|lo| (0xDC00..0xE000).contains(&lo)) {
                    out.extend(&chars[i..i + 12]); // a whole pair
                    i += 12;
                } else {
                    out.push(char::from_u32(shield_base() + (hi - 0xD800)).unwrap_or('\u{FFFD}'));
                    i += 6;
                }
            }
            Some(u) if (0xD800..0xE000).contains(&u) => {
                out.push(char::from_u32(shield_base() + (u - 0xD800)).unwrap_or('\u{FFFD}'));
                i += 6;
            }
            _ => {
                out.extend(chars.get(i..i + 2).unwrap_or(&chars[i..]));
                i += 2;
            }
        }
    }
    Some(out)
}

/// The inverse of [`shield`] on text about to be written or printed.
fn unshield(text: &str) -> String {
    if !text.chars().any(|c| (shield_base()..shield_base() + 0x800).contains(&(c as u32))) {
        return text.to_string();
    }
    text.chars()
        .map(|c| {
            let v = c as u32;
            if (shield_base()..shield_base() + 0x800).contains(&v) { format!("\\u{:04x}", 0xD800 + (v - shield_base())) } else { c.to_string() }
        })
        .collect()
}

/// `JSON.parse` of a state file; `None` when it throws (Node's `catch`).
fn parse_state(text: &str) -> Option<OVal> {
    OVal::parse(&shield(text)?)
}

/// The exception a failed file call is in Node, printed and logged the way `run()`'s catch does: `{ok:false, error}`, exit 2,
/// one central-log entry.
fn thrown(inv: &Inv, op: &str, msg: &str) -> Answer {
    let repo_key = ident::resolve_context(&inv.cwd, true).ok().and_then(|c| c.repo_key);
    crate::meshw::clog::refusal(inv, op, repo_key.as_deref(), None, msg, None);
    crate::meshw::mark_committed();
    fail(msg)
}

/// Node's message for a failed file call (`EACCES: permission denied, open '/x'`).
fn fs_message(e: &std::io::Error, syscall: &str, path: &str) -> String {
    crate::migrate::node_err(e, syscall, Path::new(path))
}

/// Write `body` to `file` through `tmp` and a rename, as Node does. `Err` carries the message of the call that failed (nothing
/// is left behind).
fn stage_and_rename(file: &str, tmp: &str, body: &str) -> Result<(), String> {
    if let Some(dir) = Path::new(file).parent()
        && let Err(e) = std::fs::create_dir_all(dir)
    {
        return Err(fs_message(&e, defaults::text("devswarm_cli.act_sys_mkdir"), &dir.to_string_lossy()));
    }
    if let Err(e) = std::fs::write(tmp, body) {
        crate::discard::harmless(std::fs::remove_file(tmp)); // keep: a half-written staging file is only disk
        return Err(fs_message(&e, defaults::text("devswarm_cli.act_sys_open"), tmp));
    }
    if let Err(e) = std::fs::rename(tmp, file) {
        crate::discard::harmless(std::fs::remove_file(tmp)); // keep: as above
        // Node words a rename `rename 'from' -> 'to'`: the path slot carries both names
        return Err(fs_message(&e, defaults::text("devswarm_cli.act_sys_rename"), &format!("{tmp}' -> '{file}")));
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
    let home = home_str(inv);
    let file = path_join(&ah_dir(&home), defaults::text("devswarm_cli.skip_file"));
    let mut data = OVal::Obj(Vec::new());
    if let Some(text) = read_text(Path::new(&file)) {
        let t = js_trim(&text);
        if !t.is_empty() {
            // a parsed value that is no plain object starts over, and so does text that does not parse, as Node's `catch`
            if let Some(o @ OVal::Obj(_)) = parse_state(t) {
                data = o;
            }
        }
    }
    let now = inv.now as f64;
    let expires = now + ttl * defaults::num("devswarm_cli.skip_ms_per_min") as f64;
    if !expires.is_finite() {
        return Ok(fail(defaults::text("devswarm_cli.msg_skip_ttl_infinite")));
    }
    // `data['__proto__'] = x` with a number is a no-op in JavaScript (the setter ignores a non-object), not a key
    if guard != defaults::text("devswarm_cli.act_proto_key") {
        data.set(guard, n(expires));
    }
    let body = unshield(&data.stringify_pretty());
    if let Err(msg) = stage_and_rename(&file, &format!("{file}.{}.tmp", std::process::id()), &body) {
        return Ok(thrown(inv, defaults::text("devswarm_cli.verb_skip"), &msg));
    }
    wrote(&home, &file, &body);
    // Node writes the file and only then formats the date; a date it cannot format throws after the write
    let Some(iso) = crate::checks::jsport::date::to_iso(expires) else {
        return Ok(thrown(inv, defaults::text("devswarm_cli.verb_skip"), defaults::text("devswarm_cli.act_msg_invalid_time")));
    };
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
    let action = defaults::text(if set { "devswarm_cli.action_archive_ignore" } else { "devswarm_cli.action_archive_unignore" });
    let id = match crate::meshw::actverbs::resolve_target_id(inv, id, action)? {
        Ok(x) => x,
        Err(refused) => return Ok(refused),
    };
    let id = id.as_str();
    let home = home_str(inv);
    let dir = devswarm_root(Path::new(&home)).join(defaults::text("devswarm_cli.ignore_dir"));
    let file = dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let file_s = file.to_string_lossy().into_owned();
    let mut o = Obj::default();
    if set {
        let mut mark = Obj::default();
        mark.put("id", s(id)).put("ignoredAt", n(inv.now as f64));
        let body = mark.done().stringify();
        if let Err(msg) = stage_and_rename(&file_s, &format!("{file_s}{}", defaults::text("mesh_write.tmp_suffix")), &body) {
            return Ok(thrown(inv, defaults::text("devswarm_cli.verb_archive_ignore"), &msg));
        }
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
    let home = home_str(inv);
    let dir = devswarm_root(Path::new(&home)).join(defaults::text("devswarm_cli.gate_dir"));
    let file = dir.join(format!("{}{}", safe_session(session), defaults::text("mesh_write.json_suffix")));
    let file_s = file.to_string_lossy().into_owned();
    // no state, state that does not parse, or state without a signature are all "no block to attach to"
    let existing = read_text(&file).and_then(|t| parse_state(&t));
    let (sig, mut next) = match existing {
        Some(e) => match e.get("sig") {
            Some(OVal::Str(x)) if !x.is_empty() => (x.clone(), e),
            _ => return Ok(fail(&defaults::render("devswarm_cli.msg_gate_no_block", &[("session", &quote(session))]))),
        },
        None => return Ok(fail(&defaults::render("devswarm_cli.msg_gate_no_block", &[("session", &quote(session))]))),
    };
    let max = defaults::num("devswarm_cli.gate_reason_max") as usize;
    // `reason.slice(0, max)` may end between the two halves of a surrogate pair: the lone high half is written as its escape
    let kept = if utf16(reason) > max { cut_utf16(reason, max) } else { reason.to_string() };
    let mut one_intent = Obj::default();
    one_intent.put("ts", n(inv.now as f64)).put("reason", s(&kept));
    // `nextIntents['__proto__'] = {...}` sets the object's prototype, not a key: the intents stay empty
    let mut intents = Obj::default();
    if sig != defaults::text("devswarm_cli.act_proto_key") {
        intents.put(&sig, one_intent.done());
    }
    // `Object.assign({}, existing, { intents })`: an own `__proto__` key of the state goes to the setter, not into the copy
    if let OVal::Obj(fields) = &mut next {
        fields.retain(|(k, _)| k != defaults::text("devswarm_cli.act_proto_key"));
    }
    next.set("intents", intents.done());
    let body = unshield(&next.stringify());
    if let Err(msg) = stage_and_rename(&file_s, &format!("{file_s}.{}.tmp", std::process::id()), &body) {
        return Ok(thrown(inv, defaults::text("devswarm_cli.verb_gate_intent"), &msg));
    }
    wrote(&home, &file_s, &body);
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("devswarm_cli.action_gate_intent")))
        .put("session", s(session))
        .put("sig", s(&sig))
        .put("ts", n(inv.now as f64));
    Ok(answer(0, o.done()))
}

/// `text.slice(0, max)` in UTF-16 units. A cut between the two halves of a surrogate pair leaves a lone high surrogate, which a
/// Rust string cannot hold: its [`shield`] stand-in is put there (and written back as the escape by [`unshield`]).
fn cut_utf16(text: &str, max: usize) -> String {
    if let Some(c) = slice_utf16(text, max) {
        return c;
    }
    let mut out = String::new();
    let mut units = 0;
    for c in text.chars() {
        if units + c.len_utf16() > max {
            let high = 0xD800 + ((c as u32 - 0x10000) >> 10);
            out.push(char::from_u32(shield_base() + (high - 0xD800)).unwrap_or('\u{FFFD}'));
            return out;
        }
        units += c.len_utf16();
        out.push(c);
    }
    out
}

// ---- notice -------------------------------------------------------------------------------------------------------------

/// `String(x)` of a parsed value, as JavaScript spells it (`null` as `"null"`, an array as its elements joined by commas with
/// `null` as nothing, any object as `[object Object]`).
pub(crate) fn js_text(v: &OVal) -> String {
    match v {
        OVal::Null => defaults::text("devswarm_cli.act_js_null").to_string(),
        OVal::Bool(b) => b.to_string(),
        OVal::Num(x) => crate::checks::jsport::num::to_js_string(*x),
        OVal::Str(t) => t.clone(),
        OVal::Arr(items) => items.iter().map(|x| if matches!(x, OVal::Null) { String::new() } else { js_text(x) }).collect::<Vec<_>>().join(","),
        OVal::Obj(_) => defaults::text("devswarm_cli.act_js_object").to_string(),
    }
}

/// `Number(x) || 0` of a notice's `ts`.
fn ts_key(v: Option<&OVal>) -> f64 {
    let x = match v {
        None | Some(OVal::Null) => 0.0,
        Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
        Some(OVal::Num(x)) => *x,
        Some(OVal::Str(t)) => js_number_of_str(t),
        // an array or object is converted through its string form
        Some(other) => js_number_of_str(&js_text(other)),
    };
    if x.is_nan() { 0.0 } else { x }
}

/// One line of an NDJSON file the way a tolerant reader takes it: the parsed value, or nothing for a line that does not parse
/// (Node's `catch`).
fn parse_line(line: &str) -> Option<OVal> {
    parse_state(line)
}

fn notice(inv: &Inv, a: &Args) -> R<Answer> {
    if a.has(defaults::text("devswarm_cli.flag_post")) {
        return Ok(notice_post(inv, a));
    }
    if !a.has(defaults::text("devswarm_cli.flag_list")) {
        return Ok(fail(defaults::text("devswarm_cli.msg_notice_usage")));
    }
    let home = home_str(inv);
    let rows = notice_rows(&home);
    let now = inv.now as f64;
    let mut live: Vec<(f64, OVal)> = Vec::new();
    for r in rows {
        let expired = matches!(r.get("expiresAt"), Some(OVal::Num(x)) if x.is_finite() && *x <= now);
        if !expired {
            live.push((ts_key(r.get("ts")), r));
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

/// `readAllRows(home)`: the notices on file (an object with a truthy `id`), a line that does not parse skipped.
fn notice_rows(home: &str) -> Vec<OVal> {
    let file = devswarm_root(Path::new(home)).join(defaults::text("devswarm_cli.notice_file"));
    let mut rows: Vec<OVal> = Vec::new();
    for line in read_text(&file).unwrap_or_default().split('\n') {
        let t = js_trim(line);
        if t.is_empty() {
            continue;
        }
        if let Some(row) = parse_line(t)
            && matches!(row, OVal::Obj(_))
            && row.get("id").is_some_and(OVal::truthy)
        {
            rows.push(row);
        }
    }
    rows
}

/// `parseTtl(s)` of the maintainer notice: milliseconds of `7d`, `24h`, `30m`, `10s`, `500ms` or a bare number of milliseconds;
/// nothing given is the default; text that is none of them is `None`.
fn parse_ttl(raw: Option<&str>) -> Option<f64> {
    let default = defaults::num("devswarm_cli.notice_default_ttl_ms") as f64;
    let Some(raw) = raw.filter(|r| !r.is_empty()) else { return Some(default) };
    let (num, unit) = split_number_unit(js_trim(raw))?;
    let unit = if unit.is_empty() { defaults::text("devswarm_cli.since_default_unit").to_string() } else { unit.to_ascii_lowercase() };
    let mult = defaults::raw("devswarm_cli.since_units").get(&unit)?.as_integer()?;
    (num.is_finite() && num > 0.0).then(|| (num * mult as f64 + 0.5).floor())
}

/// `/^(\d+(?:\.\d+)?)\s*(unit)?$/i` split: the number and the (not yet checked) unit text after optional blanks.
fn split_number_unit(t: &str) -> Option<(f64, &str)> {
    let int = t.find(|c: char| !c.is_ascii_digit()).unwrap_or(t.len());
    if int == 0 {
        return None;
    }
    let end = match t[int..].strip_prefix('.') {
        Some(rest) => {
            let frac = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
            if frac == 0 { int } else { int + 1 + frac }
        }
        None => int,
    };
    let num: f64 = t[..end].parse().ok()?;
    Some((num, t[end..].trim_start_matches(is_js_space_char)))
}

/// `checkoutIsAntiHall(cwd)`: the nearest `plugins/anti-hall/.claude-plugin/plugin.json` up the tree, if any, names `anti-hall`.
fn checkout_is_anti_hall(cwd: &str) -> bool {
    let mut dir = ident::resolve_abs(cwd);
    for _ in 0..defaults::num("devswarm_cli.notice_walk_levels") {
        if dir == "/" || dir.is_empty() {
            break;
        }
        let candidate = Path::new(&dir).join(defaults::text("devswarm_cli.notice_manifest"));
        if let Some(parsed) = read_text(&candidate).and_then(|t| OVal::parse(&t)) {
            return matches!(parsed.get("name"), Some(OVal::Str(n)) if n == defaults::text("devswarm_cli.notice_manifest_name"));
        }
        let parent = ident::dirname(&dir);
        if parent == dir {
            break;
        }
        dir = parent;
    }
    false
}

/// One refusal of `notice --post`: `{ ok:false, reason, error }`, exit 2 (Node's dispatcher does not log it; the module's own
/// event does, where it has one).
fn notice_refusal(reason_key: &str, error: &str) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("reason", s(defaults::text(reason_key))).put("error", s(error));
    answer(2, o.done())
}

/// The maintainer notice module's event (`logEvent`): component `devswarm-maintainer-notice`, level info.
fn notice_event(inv: &Inv, kind: &str, msg: &str, fields: Vec<(&str, OVal)>) {
    crate::meshw::clog::event_as(inv, defaults::text("devswarm_cli.act_notice_component"), kind, msg, fields);
}

/// `notice --post "<text>" [--ttl 7d]` (`devswarm-maintainer-notice.js` `post`): a mistake-guarded broadcast, refused unless
/// `devswarm.maintainerNotice.post` is on and the checkout is anti-hall's own, at most a few per day.
fn notice_post(inv: &Inv, a: &Args) -> Answer {
    let kind = defaults::text("devswarm_cli.act_notice_kind_post");
    let now = inv.now as f64;
    if !crate::checks::guardkit::settings::get_bool(&inv.settings(), defaults::raw("devswarm_cli.act_set_notice_post")) {
        notice_event(inv, kind, defaults::text("devswarm_cli.act_notice_log_setting_off"), vec![("reason", s(defaults::text("devswarm_cli.act_notice_reason_setting_off")))]);
        return notice_refusal("devswarm_cli.act_notice_reason_setting_off", defaults::text("devswarm_cli.act_notice_msg_setting_off"));
    }
    if !checkout_is_anti_hall(&inv.cwd) {
        notice_event(inv, kind, defaults::text("devswarm_cli.act_notice_log_wrong_checkout"), vec![("reason", s(defaults::text("devswarm_cli.act_notice_reason_wrong_checkout")))]);
        return notice_refusal("devswarm_cli.act_notice_reason_wrong_checkout", defaults::text("devswarm_cli.act_notice_msg_wrong_checkout"));
    }
    let text = a.one(defaults::text("devswarm_cli.flag_post")).unwrap_or("");
    if js_trim(text).is_empty() {
        return notice_refusal("devswarm_cli.act_notice_reason_empty_text", defaults::text("devswarm_cli.act_notice_msg_empty_text"));
    }
    let max_bytes = defaults::num("devswarm_cli.notice_max_text_bytes");
    if text.len() as u64 > max_bytes {
        notice_event(
            inv,
            kind,
            defaults::text("devswarm_cli.act_notice_log_too_long"),
            vec![("reason", s(defaults::text("devswarm_cli.act_notice_reason_too_long"))), ("bytes", n(text.len() as f64))],
        );
        return notice_refusal(
            "devswarm_cli.act_notice_reason_too_long",
            &defaults::render("devswarm_cli.act_notice_msg_too_long", &[("max", &max_bytes), ("got", &text.len())]),
        );
    }
    let ttl_raw = a.one(defaults::text("devswarm_cli.flag_ttl"));
    let Some(ttl_ms) = parse_ttl(ttl_raw) else {
        let shown = quote(ttl_raw.unwrap_or_default());
        return notice_refusal("devswarm_cli.act_notice_reason_bad_ttl", &defaults::render("devswarm_cli.act_notice_msg_bad_ttl", &[("ttl", &shown)]));
    };
    let home = home_str(inv);
    let day = defaults::num("devswarm_cli.notice_day_ms") as f64;
    let recent = notice_rows(&home)
        .iter()
        .filter(|r| matches!(r.get("ts"), Some(OVal::Num(t)) if t.is_finite() && *t > now - day && *t <= now))
        .count();
    let per_day = defaults::num("devswarm_cli.notice_max_posts_per_day");
    if recent as u64 >= per_day {
        notice_event(
            inv,
            kind,
            defaults::text("devswarm_cli.act_notice_log_rate"),
            vec![("reason", s(defaults::text("devswarm_cli.act_notice_reason_rate"))), ("recentCount", n(recent as f64))],
        );
        return notice_refusal("devswarm_cli.act_notice_reason_rate", &defaults::render("devswarm_cli.act_notice_msg_rate", &[("max", &per_day), ("count", &recent)]));
    }
    let mut raw_id = vec![0u8; defaults::num("devswarm_cli.notice_id_bytes") as usize];
    let id = {
        use ring::rand::SecureRandom;
        if ring::rand::SystemRandom::new().fill(&mut raw_id).is_err() {
            // no entropy: Node's randomBytes throws, which `run()` prints as the exception
            return thrown(inv, defaults::text("devswarm_cli.verb_notice"), defaults::text("devswarm_cli.act_msg_no_entropy"));
        }
        raw_id.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    let expires = now + ttl_ms;
    let mut row = Obj::default();
    row.put("id", s(&id)).put("ts", n(now)).put("expiresAt", n(expires)).put("text", s(text));
    let root = devswarm_root(Path::new(&home));
    let file = root.join(defaults::text("devswarm_cli.notice_file"));
    let line = format!("{}\n", row.done().stringify());
    let wrote_line = std::fs::create_dir_all(&root)
        .map_err(|e| fs_message(&e, defaults::text("devswarm_cli.act_sys_mkdir"), &root.to_string_lossy()))
        .and_then(|()| {
            use std::io::Write;
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file)
                .and_then(|mut f| f.write_all(line.as_bytes()))
                .map_err(|e| fs_message(&e, defaults::text("devswarm_cli.act_sys_open"), &file.to_string_lossy()))
        });
    if let Err(msg) = wrote_line {
        return notice_refusal("devswarm_cli.act_notice_reason_write_failed", &msg);
    }
    crate::meshw::mark_committed();
    let file_s = file.to_string_lossy().into_owned();
    crate::meshw::note_written(file_s.strip_prefix(&format!("{home}/")).unwrap_or(&file_s), line.as_bytes());
    notice_event(inv, kind, defaults::text("devswarm_cli.act_notice_log_posted"), vec![("id", s(&id)), ("ttlMs", n(ttl_ms)), ("bytes", n(text.len() as f64))]);
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("id", s(&id)).put("ts", n(now)).put("expiresAt", n(expires));
    answer(0, o.done())
}

// ---- logs ---------------------------------------------------------------------------------------------------------------

/// `parseSinceDuration(raw)`: milliseconds of `30m`, `2h`, `1d`, `500` (ms) ...; `None` for text that is none of them.
pub(crate) fn parse_since_duration(raw: Option<&str>) -> Option<f64> {
    let (num, unit) = split_number_unit(js_trim(raw?))?;
    let unit = if unit.is_empty() { defaults::text("devswarm_cli.since_default_unit").to_string() } else { unit.to_ascii_lowercase() };
    let mult = defaults::raw("devswarm_cli.since_units").get(&unit)?.as_integer()?;
    (num.is_finite() && num >= 0.0).then_some(num * mult as f64)
}

fn is_js_space_char(c: char) -> bool {
    crate::checks::guardkit::text::is_js_space(c)
}

/// `parseLogFile(path)`: the entries of a JSONL log in file order, a missing file empty, a line that does not parse skipped
/// (any JSON value is an entry, as in Node). A line whose only fault is a lone surrogate escape is skipped and counted.
fn parse_log_file(p: &Path) -> Vec<OVal> {
    let Some(text) = read_text(p) else { return Vec::new() };
    text.split('\n').filter(|line| !js_trim(line).is_empty()).filter_map(parse_line).collect()
}

/// `Date.parse(String(ts))` of an entry's `ts`: the instant, or `None` when it is no date (or one V8 reads by rules the engine
/// does not reproduce, which is counted).
fn entry_time(ts: &OVal) -> Option<f64> {
    use crate::checks::jsport::date::{Parsed, parse};
    match parse(&js_text(ts)) {
        Parsed::Ms(ms) if ms.is_finite() => Some(ms),
        Parsed::Nan | Parsed::Ms(_) => None,
        Parsed::Unknown => {
            crate::metrics::bump(defaults::text("devswarm_cli.act_metric_ts_unread"), &[("site", defaults::text("devswarm_cli.act_site_logs"))]);
            None
        }
    }
}

/// `String(x)` of a roll-up key (`(none)` for `null` or a missing field).
fn rollup_key(v: Option<&OVal>) -> String {
    match v {
        None | Some(OVal::Null) => defaults::text("devswarm_cli.log_none_label").to_string(),
        Some(other) => js_text(other),
    }
}

fn bump(counts: &mut Vec<(String, f64)>, key: String) {
    // `counts['__proto__'] = ...` with a string is a no-op in JavaScript: the key never appears
    if key == defaults::text("devswarm_cli.act_proto_key") {
        return;
    }
    match counts.iter_mut().find(|(k, _)| *k == key) {
        Some(slot) => slot.1 += 1.0,
        None => counts.push((key, 1.0)),
    }
}

fn logs(inv: &Inv, a: &Args) -> R<Answer> {
    let levels = defaults::list("devswarm_cli.log_levels");
    let repo = a.one(defaults::text("devswarm_cli.flag_repo"));
    let component = a.one(defaults::text("devswarm_cli.flag_component"));
    let min_level = a.one(defaults::text("devswarm_cli.flag_min_level"));
    // `LEVEL_RANK[minLevel]`: a known level ranks; a name every object inherits ranks as a function or object, which no level
    // compares `>=` to (every entry drops); any other name has no rank and the filter is skipped
    enum Rank {
        Skip,
        At(usize),
        DropAll,
    }
    let rank = match min_level {
        None => Rank::Skip,
        Some(l) => match levels.iter().position(|x| *x == l) {
            Some(r) => Rank::At(r),
            None if defaults::list("devswarm_cli.act_proto_names").contains(&l) => Rank::DropAll,
            None => Rank::Skip,
        },
    };
    let now = inv.now as f64;
    let since = parse_since_duration(a.one(defaults::text("devswarm_cli.flag_since"))).map(|d| now - d);
    let mut limit = defaults::num("devswarm_cli.logs_default_limit") as f64;
    if let Some(raw) = a.one(defaults::text("devswarm_cli.flag_limit")) {
        let x = js_number_of_str(raw);
        if x.is_finite() && x >= 0.0 {
            limit = x.floor();
        }
    }
    let home = home_str(inv);
    // `logDir()`: the override, else the home's own; a test context with no override has none (the read then finds nothing)
    let dir = match inv.env.get(defaults::text("devswarm_cli.env_log_dir")).filter(|v| !v.is_empty()) {
        Some(d) => Some(d.clone()),
        None if inv.env.get(defaults::text("devswarm_cli.env_test_context")).is_some_and(|v| !v.is_empty()) => None,
        None => Some(path_join(&ah_dir(&home), defaults::text("mesh_write.dir_logs"))),
    };
    let file = dir.as_deref().map(|d| path_join(d, defaults::text("devswarm_cli.log_file")));
    let mut entries: Vec<OVal> = Vec::new();
    if let Some(d) = dir.as_deref() {
        let current = parse_log_file(Path::new(&path_join(d, defaults::text("devswarm_cli.log_file"))));
        let mut need_rotated = (current.len() as f64) < limit;
        if let Some(cut) = since {
            let earliest = current.first().filter(|e| e.truthy()).and_then(|e| e.get("ts")).and_then(entry_time);
            if current.is_empty() || earliest.is_none() || earliest.is_some_and(|t| t > cut) {
                need_rotated = true;
            }
        }
        entries = if need_rotated {
            let mut older = parse_log_file(Path::new(&path_join(d, defaults::text("devswarm_cli.log_rotated_file"))));
            older.extend(current);
            older
        } else {
            current
        };
    }
    if let Some(r) = repo {
        entries.retain(|e| matches!(e.get("repoKey"), Some(OVal::Str(x)) if x == r));
    }
    if let Some(c) = component {
        entries.retain(|e| matches!(e.get("component"), Some(OVal::Str(x)) if x == c));
    }
    match rank {
        Rank::Skip => {}
        Rank::DropAll => entries.clear(),
        Rank::At(min) => entries.retain(|e| matches!(e.get("level"), Some(OVal::Str(l)) if levels.iter().position(|x| x == l).is_some_and(|r| r >= min))),
    }
    if let Some(cut) = since {
        entries.retain(|e| e.truthy() && e.get("ts").filter(|t| t.truthy()).and_then(entry_time).is_some_and(|t| t >= cut));
    }
    if (entries.len() as f64) > limit {
        entries.drain(..entries.len() - limit as usize);
    }
    let mut by_component: Vec<(String, f64)> = Vec::new();
    let mut by_level: Vec<(String, f64)> = Vec::new();
    for e in entries.iter().filter(|e| e.truthy()) {
        bump(&mut by_component, rollup_key(e.get("component")));
        bump(&mut by_level, rollup_key(e.get("level")));
    }
    let counts = |c: Vec<(String, f64)>| OVal::Obj(c.into_iter().map(|(k, v)| (k, n(v))).collect());
    let mut f = Obj::default();
    f.put("repoKey", repo.map_or(OVal::Null, s))
        .put("component", component.map_or(OVal::Null, s))
        .put("minLevel", min_level.map_or(OVal::Null, s))
        .put("sinceMs", since.map_or(OVal::Null, n))
        .put("limit", n(limit));
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("devswarm_cli.action_logs")))
        .put("logFile", file.as_deref().map_or(OVal::Null, s))
        .put("filters", f.done())
        .put("count", n(entries.len() as f64))
        .put("byComponent", counts(by_component))
        .put("byLevel", counts(by_level))
        .put("entries", OVal::Arr(entries));
    Ok(answer(0, o.done()))
}

// ---- wake-directive -----------------------------------------------------------------------------------------------------

/// `wake-directive <id>`: the SessionStart mailbox-wake directive, reprinted for the id asked about (`cmdWakeDirective`): the
/// child's wording inside a child workspace, the Primary's anywhere else.
fn wake_directive(inv: &Inv, a: &Args) -> R<Answer> {
    use crate::checks::devswarm_role::{settings as role_settings, text as role_text};
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if !is_safe_id(id) {
        return Ok(fail(defaults::text("devswarm_cli.msg_bad_id")));
    }
    let id = match crate::meshw::actverbs::resolve_target_id(inv, id, defaults::text("devswarm_cli.action_wake_directive"))? {
        Ok(x) => x,
        Err(refused) => return Ok(refused),
    };
    let id = id.as_str();
    let child = inv.env.get(defaults::text("devswarm_role.branch_env")).is_some_and(|v| !js_trim(v).is_empty());
    let home = home_str(inv);
    let env = crate::reqenv::RequestEnv::capture();
    // `wakeCron` / `rearmOnTickOnly` fall back to their defaults when the settings cannot be read (Node's own `catch`)
    let (cron, tick_only) = match crate::checks::devswarm_role::usable_settings(&env) {
        Some(st) => (role_settings::wake_cron(&st), crate::checks::guardkit::settings::get_bool(&st, defaults::raw("devswarm_role.sw_rearm"))),
        None => (
            defaults::raw("devswarm_role.sw_wake_cron").str_field("default").to_string(),
            defaults::raw("devswarm_role.sw_rearm").get("default").and_then(|d| d.as_bool()).unwrap_or(true),
        ),
    };
    // the engine shims agents run (devswarm_role.engine_cli / engine_watcher)
    let (cli, watcher) = (role_text::engine_cli(&home), role_text::engine_watcher(&home));
    let agent_raw = inv.env.get(defaults::text("devswarm_role.agent_env")).map(String::as_str).unwrap_or("");
    let agent = js_trim(agent_raw).to_lowercase();
    let wake = role_text::Child { cli: &cli, watcher: &watcher, agent: &agent, id, cron: &cron, tick_only };
    let directive = if child { role_text::wake_part(&wake) } else { primary_wake_part(&wake) };
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("id", s(id))
        .put("isChild", OVal::Bool(child))
        .put("agent", if agent == defaults::text("devswarm_role.claude_agent") { s(&agent) } else { OVal::Null })
        .put("directive", s(js_trim(&directive)));
    Ok(answer(0, o.done()))
}

/// The mailbox-wake part of a Primary's directive: [`crate::checks::devswarm_role::text::wake_part`] with the Primary's wording.
fn primary_wake_part(c: &crate::checks::devswarm_role::text::Child<'_>) -> String {
    use crate::checks::devswarm_role::text::fill_once;
    if c.agent.is_empty() {
        return String::new();
    }
    if c.agent == defaults::text("devswarm_role.claude_agent") {
        let expiry = defaults::text(if c.tick_only { "devswarm_role.msg_expiry_tick" } else { "devswarm_role.msg_expiry_inline" });
        fill_once(
            defaults::text("devswarm_role.msg_wake_claude_parent"),
            &[("cli", c.cli), ("watcher", c.watcher), ("id", c.id), ("cron", c.cron), ("expiry", expiry)],
        )
    } else {
        fill_once(defaults::text("devswarm_role.msg_wake_other_parent"), &[("cli", c.cli), ("id", c.id), ("agent", c.agent)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init() {
        defaults::init().unwrap();
    }

    #[test]
    fn a_lone_surrogate_escape_survives_a_parse_and_write_back() {
        init();
        // lone high, lone low, a whole pair, and an escaped backslash that only looks like an escape
        let text = r#"{"a":"\ud800","b":"\udc00x","c":"😀","d":"\\ud800"}"#;
        let v = parse_state(text).expect("serde takes the shielded text");
        assert_eq!(unshield(&v.stringify()), r#"{"a":"\ud800","b":"\udc00x","c":"😀","d":"\\ud800"}"#);
    }

    #[test]
    fn text_that_already_holds_a_stand_in_is_unreadable_rather_than_unshielded_wrongly() {
        init();
        let stand_in = char::from_u32(shield_base()).unwrap();
        assert!(parse_state(&format!("{{\"a\":\"{stand_in}\"}}")).is_none());
    }

    #[test]
    fn garbage_is_not_state_and_a_cut_pair_keeps_its_high_half() {
        init();
        assert!(parse_state("not json").is_none());
        // a reason cut between the two halves of an emoji leaves the high surrogate, written as its escape
        let cut = cut_utf16("ab😀", 3);
        assert_eq!(unshield(&OVal::Str(cut).stringify()), r#""ab\ud83d""#);
        assert_eq!(cut_utf16("abc", 2), "ab");
    }

    #[test]
    fn a_maintainer_notice_ttl_reads_like_node_does() {
        init();
        let day = defaults::num("devswarm_cli.notice_day_ms") as f64;
        assert_eq!(parse_ttl(None), Some(defaults::num("devswarm_cli.notice_default_ttl_ms") as f64));
        assert_eq!(parse_ttl(Some("")), Some(defaults::num("devswarm_cli.notice_default_ttl_ms") as f64));
        assert_eq!(parse_ttl(Some("7d")), Some(7.0 * day));
        assert_eq!(parse_ttl(Some(" 1.5 H ")), Some(5_400_000.0));
        assert_eq!(parse_ttl(Some("30m")), Some(1_800_000.0));
        assert_eq!(parse_ttl(Some("1500")), Some(1500.0));
        assert_eq!(parse_ttl(Some("0")), None);
        assert_eq!(parse_ttl(Some("soon")), None);
        assert_eq!(parse_ttl(Some("5 parsecs")), None);
    }

    #[test]
    fn a_since_duration_keeps_zero_and_rejects_text() {
        init();
        assert_eq!(parse_since_duration(Some("0")), Some(0.0));
        assert_eq!(parse_since_duration(Some("2h")), Some(7_200_000.0));
        assert_eq!(parse_since_duration(Some("x")), None);
        assert_eq!(parse_since_duration(None), None);
    }

    #[test]
    fn javascript_string_and_number_coercions_of_parsed_values() {
        init();
        let v = |t: &str| OVal::parse(t).unwrap();
        assert_eq!(js_text(&v("[1,null,[2,3],\"x\"]")), "1,,2,3,x");
        assert_eq!(js_text(&v("{\"a\":1}")), "[object Object]");
        assert_eq!(ts_key(Some(&v("[5]"))), 5.0);
        assert_eq!(ts_key(Some(&v("{}"))), 0.0);
        assert_eq!(ts_key(Some(&v("\"12\""))), 12.0);
        assert_eq!(ts_key(None), 0.0);
    }

    #[test]
    fn object_keys_list_in_the_order_javascript_lists_them() {
        init();
        // the order JavaScript lists keys in: integer-like names first
        let fields = vec![("b".to_string(), OVal::Null), ("2".to_string(), OVal::Null), ("a".to_string(), OVal::Null), ("1".to_string(), OVal::Null)];
        assert_eq!(crate::meshw::actverbs::js_key_order_for_tests(&fields), vec!["1", "2", "b", "a"]);
    }
}
