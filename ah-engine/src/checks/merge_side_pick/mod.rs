//! Built-in `check = "merge-side-pick"`: a port of the Node merge-side-pick guard (PreToolUse and PostToolUse on
//! Bash; advisory only, never blocks).
//!
//! PostToolUse records a conflict resolved by taking one side wholesale (`git checkout --ours`, `git merge -X theirs`,
//! ...) and test runs, per session; a push while a side-pick has no test run after it adds one advisory line.
//!
//! Differences from the Node guard (deliberate): the state lives in the engine's memory ([`SessionState`]) instead of
//! `~/.anti-hall/merge-side-pick-<session>.json`, so it is lost when the engine restarts and is not shared with a
//! Node-run guard (the prune of old files is therefore not ported); the PostToolUse pass is selected by the event name
//! in the payload, which is what the hook wiring passes (`--post` is only ever given to the PostToolUse entry).
//!
//! Mirrors `hooks/merge-side-pick.js` and `hooks/lib/merge-side-pick.js`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::state::{self, SessionState, session_key};
use crate::checks::guardkit::text::{collapse_ws, js_trim, slice_utf16};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

#[cfg(test)]
mod tests;

/// The compiled patterns, built once from the defaults.
struct Pats {
    masks: Vec<Regex>,
    split: Regex,
    picks: Vec<Regex>,
    push: Regex,
    dry_run: Regex,
    tests: Vec<Regex>,
}

fn pats() -> &'static Pats {
    static P: OnceLock<Pats> = OnceLock::new();
    P.get_or_init(|| {
        let prefix = defaults::text("merge_side_pick.git_prefix");
        Pats {
            masks: defaults::list("merge_side_pick.quote_masks").into_iter().map(|s| jsre::compile(s, false)).collect(),
            split: jsre::compile(defaults::text("merge_side_pick.segment_split"), false),
            picks: defaults::list("merge_side_pick.pick_tails").into_iter().map(|t| jsre::compile(&format!("{prefix}{t}"), false)).collect(),
            push: jsre::compile(&format!("{prefix}{}", defaults::text("merge_side_pick.push_tail")), false),
            dry_run: jsre::compile(defaults::text("merge_side_pick.dry_run"), false),
            tests: defaults::list("merge_side_pick.test_patterns").into_iter().map(|s| jsre::compile(s, false)).collect(),
        }
    })
}

/// Blank quoted spans (same length) so a quoted message or echo argument cannot be mistaken for a command.
///
/// Mirrors `lib/merge-side-pick.js` `maskShellQuotes`.
fn mask_quotes(cmd: &str) -> String {
    let mut s = cmd.to_string();
    for re in &pats().masks {
        // `' '.repeat(m.length)`: one space per UTF-16 unit
        s = re.replace_all(&s, |c: &regex::Captures<'_>| " ".repeat(c[0].encode_utf16().count())).into_owned();
    }
    s
}

/// Command segments split on `;`, `&`, `|` and newlines, quotes already masked.
///
/// Mirrors `lib/merge-side-pick.js` `segments`.
fn segments(cmd: &str) -> Vec<String> {
    let masked = mask_quotes(cmd);
    pats().split.split(&masked).map(|s| js_trim(s).to_string()).filter(|s| !s.is_empty()).collect()
}

fn seg_pick(s: &str) -> bool {
    pats().picks.iter().any(|re| re.is_match(s))
}

fn seg_test(s: &str) -> bool {
    pats().tests.iter().any(|re| re.is_match(s))
}

fn seg_push(s: &str) -> bool {
    pats().push.is_match(s) && !pats().dry_run.is_match(s)
}

/// A side-pick segment as stored and shown: white space collapsed, cut to the configured length.
fn keep(s: &str) -> Option<String> {
    slice_utf16(&collapse_ws(s), defaults::num("merge_side_pick.cmd_keep") as usize)
}

/// One session's record: a monotonic sequence orders events within the session.
#[derive(Default, Clone, Debug, PartialEq, Eq)]
struct Rec {
    seq: i64,
    pick_seq: i64,
    test_seq: i64,
    cmd: String,
}

impl Rec {
    fn load(raw: Option<&str>) -> Rec {
        let Some(Value::Object(o)) = raw.and_then(|r| serde_json::from_str::<Value>(r).ok()) else { return Rec::default() };
        let n = |k: &str| o.get(k).and_then(Value::as_i64).unwrap_or(0);
        Rec { seq: n("seq"), pick_seq: n("pickSeq"), test_seq: n("testSeq"), cmd: o.get("cmd").and_then(Value::as_str).unwrap_or("").to_string() }
    }

    fn dump(&self) -> String {
        serde_json::json!({"seq": self.seq, "pickSeq": self.pick_seq, "testSeq": self.test_seq, "cmd": self.cmd}).to_string()
    }
}

/// PostToolUse: record a side-pick or a test run. `None` means the text could not be handled exactly (defer).
///
/// Mirrors `lib/merge-side-pick.js` `record`.
fn record(store: &dyn SessionState, sid: &str, cmd: &str) -> Option<()> {
    let key = session_key(sid);
    if key.is_empty() {
        return Some(());
    }
    let segs = segments(cmd);
    if !segs.iter().any(|s| seg_pick(s) || seg_test(s)) {
        return Some(());
    }
    let mut failed = false;
    store.update(defaults::text("merge_side_pick.state_ns"), &key, &mut |cur| {
        let mut st = Rec::load(cur);
        for s in &segs {
            if seg_pick(s) {
                st.seq += 1;
                st.pick_seq = st.seq;
                match keep(s) {
                    Some(k) => st.cmd = k,
                    None => {
                        failed = true;
                        return None;
                    }
                }
            } else if seg_test(s) {
                st.seq += 1;
                st.test_seq = st.seq;
            }
        }
        Some(st.dump())
    });
    if failed { None } else { Some(()) }
}

/// The recorded side-pick command when no test run followed it, else empty.
///
/// Mirrors `lib/merge-side-pick.js` `pending`.
fn pending(store: &dyn SessionState, sid: &str) -> String {
    let key = session_key(sid);
    if key.is_empty() {
        return String::new();
    }
    let st = Rec::load(store.get(defaults::text("merge_side_pick.state_ns"), &key).as_deref());
    if st.pick_seq > 0 && st.pick_seq > st.test_seq {
        if st.cmd.is_empty() { defaults::text("merge_side_pick.fallback_cmd").to_string() } else { st.cmd }
    } else {
        String::new()
    }
}

/// The side-pick command to warn about when `cmd` pushes with an untested side-pick (recorded earlier or earlier in
/// this same command), else empty. `None` means defer.
///
/// Mirrors `lib/merge-side-pick.js` `pushCheck`.
fn push_check(store: &dyn SessionState, sid: &str, cmd: &str) -> Option<String> {
    let mut pend = pending(store, sid);
    for s in segments(cmd) {
        if seg_pick(&s) {
            pend = keep(&s)?;
        } else if seg_test(&s) {
            pend.clear();
        } else if seg_push(&s) && !pend.is_empty() {
            return Some(pend);
        }
    }
    Some(String::new())
}

/// The check's decision on one payload against `st` and `store`. `None`: nothing to say (not for this check, or no
/// advisory).
///
/// Mirrors `hooks/merge-side-pick.js` `main`.
pub fn decide(p: &Value, st: &Settings, store: &dyn SessionState) -> Option<Verdict> {
    if p.get("tool_name").and_then(Value::as_str) != Some("Bash") {
        return None;
    }
    let cmd = p.get("tool_input").and_then(|t| t.get("command")).and_then(Value::as_str).unwrap_or("");
    let sid = p.get("session_id").and_then(Value::as_str).map(js_trim).unwrap_or("");
    if cmd.is_empty() || sid.is_empty() {
        return None;
    }
    if !get_bool(st, defaults::raw("merge_side_pick.setting")) || is_skipped(st, defaults::text("merge_side_pick.guard_name")) {
        return None;
    }
    if p.get("hook_event_name").and_then(Value::as_str) == Some("PostToolUse") {
        return match record(store, sid, cmd) {
            Some(()) => None,
            None => Some(Verdict::Defer),
        };
    }
    let Some(pick) = push_check(store, sid, cmd) else { return Some(Verdict::Defer) };
    if pick.is_empty() {
        return None;
    }
    let what = msg::render("merge_side_pick.msg_what", &[("pick", &pick)]);
    let text = msg::message(
        Kind::Warn,
        defaults::text("merge_side_pick.guard_name"),
        &Parts { what: &what, why: defaults::text("merge_side_pick.msg_why"), instead: defaults::text("merge_side_pick.msg_instead"), ..Parts::default() },
    );
    Some(Verdict::Advisory(msg::advisory_json("PreToolUse", &text)))
}

/// The registered `merge-side-pick` check.
pub struct MergeSidePick;

impl Check for MergeSidePick {
    fn name(&self) -> &'static str {
        "merge-side-pick"
    }

    fn summary(&self) -> &'static str {
        defaults::text("merge_side_pick.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        // Without the whole payload (session id, event name) the check cannot decide: let Node do it.
        (s.tool == Some("Bash")).then_some(Verdict::Defer)
    }

    fn run_payload(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value) -> Option<Verdict> {
        decide(payload, &Settings::from_process(), state::global())
    }
}
