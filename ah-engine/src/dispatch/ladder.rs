//! The nudge escalation ladder (GH #516): an advisory that keeps firing while nothing changes is re-emitted as a Stop block.
//!
//! Each nudge kind (`nudges.kinds`, the severity class table) lists the hooks whose advisories it counts. Per session and kind the
//! ladder counts at most one fire per turn (Stop to Stop); the kind's hooks running quiet `quiet_reset` times in a row is the
//! condition cleared, which resets the count (acted on). A due kind is held as pending and the next main-session Stop answers one
//! block naming the required next action: a `block` (P0) kind at its first fire, an `escalate` kind after `after` fires and every
//! `every` fires after that. A Stop with `stop_hook_active` never adds a ladder block, so an escalation cannot loop.
//!
//! The ladder observes the hook results BEFORE the token cuts (`inject`, `digest`, `shrink`) blank repeated advisories, and its
//! block is appended after them. It fails open: no session, an unreadable or corrupt state file, a state write that fails or a
//! panic adds nothing. Every class, threshold, list, path and text is in `engine/defaults/nudges.toml`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - unreadable or corrupt ladder state is a fresh state (fail open); a value that does not parse is the absent value
// A failure that must be seen goes through `crate::discard` or `health::log_event` instead.

use super::combine::{self, HookResult};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, read_object};
use crate::defaults::{self, V};
use crate::reqenv::RequestEnv;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// A kind's severity class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// Counted only.
    Advisory,
    /// Blocks after `after` fires, then every `every`.
    Escalate,
    /// P0: blocks at the first fire, then every `every`.
    Block,
    /// Not watched.
    Off,
}

fn class_of(word: &str) -> Option<Class> {
    let w = defaults::raw("nudges.class_words");
    [(Class::Advisory, "advisory"), (Class::Escalate, "escalate"), (Class::Block, "block"), (Class::Off, "off")]
        .into_iter()
        .find(|(_, k)| w.str_field(k) == word)
        .map(|(c, _)| c)
}

/// One row of the severity class table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kind {
    /// The kind name.
    pub name: String,
    /// Its class (after the owner's override).
    pub class: Class,
    /// Dispatch table ids whose advisories it counts.
    pub hooks: Vec<String>,
    /// Substrings of which one must be in the advisory (empty: any).
    pub matches: Vec<String>,
    /// Fires before the first block of an escalate kind.
    pub after: u64,
    /// Further fires between two blocks.
    pub every: u64,
    /// Consecutive quiet runs that reset the count (0: never).
    pub quiet_reset: u64,
    /// The required next action.
    pub action: String,
    /// Its hooks' blocks count as fires too (a guard whose condition is a deny or a Stop block, not an advisory).
    pub count_blocks: bool,
}

fn strings(v: Option<&V>) -> Vec<String> {
    v.map(V::strings).unwrap_or_default().into_iter().map(str::to_string).collect()
}

fn int(v: Option<&V>, dflt: u64) -> u64 {
    v.and_then(V::as_integer).map_or(dflt, |n| n.max(0) as u64)
}

/// The severity table from the TOML, with `overrides` (kind name to class word, from settings.json) applied.
pub fn kinds(overrides: &serde_json::Map<String, Value>) -> Vec<Kind> {
    let (after, every, quiet) = (defaults::num("nudges.after"), defaults::num("nudges.every"), defaults::num("nudges.quiet_reset"));
    let Some(rows) = defaults::raw("nudges.kinds").as_table() else { return Vec::new() };
    rows.iter()
        .filter_map(|(name, row)| {
            let word = overrides.get(*name).and_then(Value::as_str).unwrap_or_else(|| row.str_field("class"));
            let class = class_of(word).or_else(|| class_of(row.str_field("class")))?;
            Some(Kind {
                name: (*name).to_string(),
                class,
                hooks: strings(row.get("hooks")),
                matches: strings(row.get("match")),
                after: int(row.get("after"), after).max(1),
                every: int(row.get("every"), every).max(1),
                quiet_reset: int(row.get("quiet_reset"), quiet),
                action: row.str_field("action").to_string(),
                count_blocks: row.get("count_blocks").and_then(V::as_bool).unwrap_or(false),
            })
        })
        .collect()
}

/// What one call showed of a kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seen {
    /// One of its hooks gave a matching advisory: its first line.
    Fired(String),
    /// Its hooks ran and gave none.
    Quiet,
    /// None of its hooks ran.
    Absent,
}

fn advisory_text(r: &HookResult) -> Option<String> {
    if r.code != Some(0) || r.out.trim().is_empty() || combine::blocks(r) {
        return None;
    }
    let v: Value = serde_json::from_str(&r.out).unwrap_or(Value::String(r.out.clone())); // keep: plain-text stdout is the advisory itself
    let mut parts: Vec<String> = Vec::new();
    if let Some(c) = combine::context_of(&r.out) {
        parts.push(c);
    }
    if let Some(m) = v.get(defaults::text("nudges.system_message_field")).and_then(Value::as_str) {
        parts.push(m.to_string());
    }
    if let Value::String(s) = v {
        parts.push(s);
    }
    let text = parts.join("\n");
    (!text.trim().is_empty()).then_some(text)
}

/// The reason text of a block result: the JSON reason (or the deny reason), else stderr, else stdout.
fn block_text(r: &HookResult) -> Option<String> {
    if !combine::blocks(r) {
        return None;
    }
    let v: Value = serde_json::from_str(r.out.trim()).unwrap_or(Value::Null); // keep: a non-JSON block carries its reason on stderr
    let f = defaults::raw("nudges.block_reason_fields");
    let json = [f.str_field("reason"), f.str_field("deny")]
        .into_iter()
        .find_map(|k| v.get(k).or_else(|| v.get(f.str_field("specific")).and_then(|h| h.get(k))).and_then(Value::as_str));
    let t = json.map(str::to_string).unwrap_or_else(|| if r.err.trim().is_empty() { r.out.clone() } else { r.err.clone() });
    (!t.trim().is_empty()).then_some(t)
}

/// What `results` showed of `k`.
pub fn observe(k: &Kind, results: &[HookResult]) -> Seen {
    let mine: Vec<&HookResult> = results.iter().filter(|r| k.hooks.contains(&r.id)).collect();
    if mine.is_empty() {
        return Seen::Absent;
    }
    for r in mine {
        let text = advisory_text(r).or_else(|| if k.count_blocks { block_text(r) } else { None });
        if let Some(t) = text.filter(|t| k.matches.is_empty() || k.matches.iter().any(|m| t.contains(m.as_str()))) {
            let max = defaults::num("nudges.headline_chars") as usize;
            let first = t.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
            let ascii: String = first.chars().filter(char::is_ascii).collect::<String>().trim().chars().take(max).collect();
            return Seen::Fired(ascii);
        }
    }
    Seen::Quiet
}

/// One kind's ladder state in one session.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Track {
    /// Fires (one per turn at most) since the last reset.
    pub count: u64,
    /// Consecutive quiet runs.
    pub quiet: u64,
    /// A block is due at the next Stop.
    pub pending: bool,
    /// It already fired this turn.
    pub this_turn: bool,
    /// Blocks shown since the last reset.
    pub shown: u64,
    /// The newest advisory's first line.
    pub headline: String,
}

/// One session's ladder state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    /// Per kind name.
    pub kinds: BTreeMap<String, Track>,
}

/// A telemetry step: (kind, step word key, blocked).
pub type Step = (String, &'static str, bool);

fn due(k: &Kind, n: u64) -> bool {
    match k.class {
        Class::Block => n >= 1 && (n - 1).is_multiple_of(k.every),
        Class::Escalate => n >= k.after && (n - k.after).is_multiple_of(k.every),
        Class::Advisory | Class::Off => false,
    }
}

/// Count what one call showed. Returns the telemetry steps.
pub fn count(st: &mut State, kinds: &[Kind], seen: &[(String, Seen)]) -> Vec<Step> {
    let mut steps = Vec::new();
    for (name, s) in seen {
        let Some(k) = kinds.iter().find(|k| k.name == *name && k.class != Class::Off) else { continue };
        let t = st.kinds.entry(name.clone()).or_default();
        match s {
            Seen::Fired(h) => {
                t.quiet = 0;
                t.headline.clone_from(h);
                if !t.this_turn {
                    t.this_turn = true;
                    t.count += 1;
                    steps.push((name.clone(), if t.count == 1 { "fired" } else { "repeated" }, false));
                    if t.shown > 0 {
                        steps.push((name.clone(), "ignored", false));
                    }
                    if due(k, t.count) {
                        t.pending = true;
                    }
                }
            }
            Seen::Quiet if k.quiet_reset > 0 => {
                t.quiet += 1;
                if t.quiet >= k.quiet_reset {
                    if t.count > 0 {
                        steps.push((name.clone(), "acted", false));
                    }
                    *t = Track::default();
                }
            }
            Seen::Quiet | Seen::Absent => {}
        }
    }
    st.kinds.retain(|_, t| *t != Track::default());
    steps
}

/// At a Stop: the block reason of every pending kind (when `may_block`), and the turn boundary. Returns (reason, steps).
pub fn at_stop(st: &mut State, kinds: &[Kind], may_block: bool) -> (Option<String>, Vec<Step>) {
    let mut texts: Vec<String> = Vec::new();
    let mut steps = Vec::new();
    for k in kinds {
        let Some(t) = st.kinds.get_mut(&k.name) else { continue };
        if may_block && t.pending && matches!(k.class, Class::Block | Class::Escalate) {
            t.pending = false;
            t.shown += 1;
            let detail = if t.headline.is_empty() { String::new() } else { defaults::render("nudges.msg_detail", &[("text", &t.headline)]) };
            let key = if k.class == Class::Block { "nudges.msg_first_fire" } else { "nudges.msg_escalated" };
            texts.push(defaults::render(key, &[("action", &k.action), ("detail", &detail), ("n", &t.count)]));
            steps.push((k.name.clone(), if k.class == Class::Block { "blocked" } else { "escalated" }, true));
        }
        t.this_turn = false;
    }
    if texts.is_empty() {
        return (None, steps);
    }
    let max = defaults::num("nudges.max_chars") as usize;
    let reason: String = texts.join(defaults::text("dispatch.reason_joiner")).chars().take(max).collect();
    (Some(reason), steps)
}

fn session_key(p: &Value) -> Option<String> {
    let max = defaults::num("dispatch.stop_id_max_chars") as usize;
    let s: String = p.get("session_id")?.as_str()?.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(max).collect();
    (!s.is_empty()).then_some(s)
}

fn state_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}{}", defaults::text("nudges.state_ext")))
}

/// The session's state; unreadable or corrupt is a fresh state (fail open).
pub fn load(dir: &Path, key: &str) -> State {
    std::fs::read_to_string(state_file(dir, key)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(dir: &Path, key: &str, st: &State) -> bool {
    if crate::limits::ensure_private_dir(dir).is_err() {
        return false;
    }
    serde_json::to_string(st).is_ok_and(|t| crate::atomic::write(state_file(dir, key), t).is_ok())
}

fn prune(dir: &Path) {
    let max = std::time::Duration::from_secs(defaults::num("nudges.state_max_age_days") * 86_400);
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > max);
        if old && e.file_type().is_ok_and(|t| t.is_file()) {
            crate::discard::harmless(std::fs::remove_file(e.path())); // keep: cleanup that raced; an absent file is the goal state
        }
    }
}

fn emit(steps: &[Step]) {
    let words = defaults::raw("nudges.step_words");
    for (kind, step, blocked) in steps {
        crate::telemetry::emit::event(crate::telemetry::emit::nudge_step(kind, words.str_field(step), *blocked));
    }
}

/// One whole ladder pass over `results` with the state under `dir`: the block to add, if any.
pub fn run_in(dir: &Path, event: &str, p: &Value, kinds: &[Kind], results: &[HookResult]) -> Option<HookResult> {
    let key = session_key(p)?;
    let mut st = load(dir, &key);
    let seen: Vec<(String, Seen)> = kinds.iter().map(|k| (k.name.clone(), observe(k, results))).collect();
    let mut steps = count(&mut st, kinds, &seen);
    let mut reason = None;
    if defaults::list("nudges.block_events").contains(&event) {
        let active = p.get("stop_hook_active").and_then(Value::as_bool) == Some(true);
        // a Stop another hook already blocks carries that block; the ladder's waits for the next Stop (no stacked blocks)
        let blocked = results.iter().any(combine::blocks);
        let (r, s) = at_stop(&mut st, kinds, !active && !blocked);
        reason = r;
        steps.extend(s);
    }
    if !save(dir, &key, &st) {
        return None; // a block whose shown mark cannot be kept would repeat: fail open
    }
    emit(&steps);
    let out = serde_json::json!({ "decision": "block", "reason": reason? }).to_string();
    Some(HookResult { id: defaults::text("nudges.hook_id").to_string(), code: Some(0), out, err: String::new() })
}

/// The ladder for one dispatched call: observes `results` (before the token cuts) and returns the block to append, if any.
/// Never panics out and never blocks on an internal failure (fail open).
pub fn apply(event: &str, p: &Value, env: &RequestEnv, results: &[HookResult]) -> Option<HookResult> {
    if !defaults::list("nudges.events").contains(&event) {
        return None;
    }
    let st = Settings::from_env(env);
    if !get_bool(&st, defaults::raw("nudges.sw_enabled")) {
        return None;
    }
    let overrides = read_object(&st, defaults::text("guardkit.settings_file"))
        .and_then(|o| o.get(defaults::text("nudges.section")).and_then(|s| s.get(defaults::text("nudges.override_key"))).and_then(Value::as_object).cloned())
        .unwrap_or_default();
    let dir = crate::paths::dir().join(defaults::text("nudges.state_dir"));
    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        prune(&dir);
        run_in(&dir, event, p, &kinds(&overrides), results)
    }));
    run.unwrap_or_else(|_| {
        crate::health::log_event("nudge_ladder", event, &defaults::render("nudges.msg_fail_open", &[("why", &"panic")]));
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kind(class: Class, quiet_reset: u64) -> Kind {
        Kind {
            name: "k".into(),
            class,
            hooks: vec!["h".into()],
            matches: vec![],
            after: 3,
            every: 2,
            quiet_reset,
            action: "do the thing".into(),
            count_blocks: false,
        }
    }
    fn adv(text: &str) -> Vec<HookResult> {
        vec![HookResult { id: "h".into(), code: Some(0), out: json!({"systemMessage": text}).to_string(), err: String::new() }]
    }
    fn quiet() -> Vec<HookResult> {
        vec![HookResult::quiet("h")]
    }
    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-ladder-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d));
        d
    }
    fn stop(dir: &Path, k: &Kind, r: &[HookResult]) -> Option<HookResult> {
        run_in(dir, "Stop", &json!({"session_id": "s1"}), std::slice::from_ref(k), r)
    }

    #[test]
    fn an_escalate_kind_blocks_after_n_turns_then_every_m() {
        let d = tmp("esc");
        let k = kind(Class::Escalate, 2);
        let blocks: Vec<bool> = (0..7).map(|_| stop(&d, &k, &adv("⚠️ stop agents a, b")).is_some()).collect();
        assert_eq!(blocks, vec![false, false, true, false, true, false, true], "after 3, then every 2");
        let b = stop(&d, &k, &adv("x")).or_else(|| stop(&d, &k, &adv("x"))).unwrap();
        let reason = serde_json::from_str::<Value>(&b.out).unwrap()["reason"].as_str().unwrap().to_string();
        assert!(reason.contains("do the thing"), "{reason}");
    }

    #[test]
    fn several_fires_in_one_turn_count_once() {
        let d = tmp("turn");
        let k = kind(Class::Escalate, 2);
        for _ in 0..5 {
            assert!(run_in(&d, "PostToolUse", &json!({"session_id": "s1"}), std::slice::from_ref(&k), &adv("a")).is_none());
        }
        assert_eq!(load(&d, "s1").kinds["k"].count, 1);
    }

    #[test]
    fn the_condition_clearing_resets_the_count() {
        let d = tmp("reset");
        let k = kind(Class::Escalate, 2);
        stop(&d, &k, &adv("a"));
        stop(&d, &k, &adv("a"));
        let mut st = load(&d, "s1");
        let steps = count(&mut st, std::slice::from_ref(&k), &[("k".into(), Seen::Quiet)]);
        assert!(steps.is_empty(), "one quiet run is not enough");
        let steps = count(&mut st, std::slice::from_ref(&k), &[("k".into(), Seen::Quiet)]);
        assert_eq!(steps, vec![("k".to_string(), "acted", false)]);
        assert!(!st.kinds.contains_key("k"), "count reset");
        let absent = count(&mut st, std::slice::from_ref(&k), &[("k".into(), Seen::Absent)]);
        assert!(absent.is_empty(), "a hook that did not run proves nothing");
    }

    #[test]
    fn a_p0_kind_blocks_at_first_fire_with_two_lines_and_one_emoji() {
        let d = tmp("p0");
        let k = kind(Class::Block, 2);
        let b = stop(&d, &k, &adv("🛑 model routing note")).expect("blocked at first fire");
        let reason = serde_json::from_str::<Value>(&b.out).unwrap()["reason"].as_str().unwrap().to_string();
        assert!(reason.lines().count() <= 2, "{reason}");
        assert_eq!(reason.chars().filter(|c| !c.is_ascii()).count(), 1, "one emoji: {reason}");
        assert!(stop(&d, &k, &quiet()).is_none());
    }

    #[test]
    fn a_stop_that_was_already_blocked_never_adds_a_ladder_block() {
        let d = tmp("active");
        let k = kind(Class::Block, 2);
        let p = json!({"session_id": "s1", "stop_hook_active": true});
        assert!(run_in(&d, "Stop", &p, std::slice::from_ref(&k), &adv("a")).is_none());
        assert!(load(&d, "s1").kinds["k"].pending, "held for the next Stop");
    }

    #[test]
    fn corrupt_state_or_an_unwritable_dir_fails_open() {
        let d = tmp("corrupt");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(state_file(&d, "s1"), "{not json").unwrap();
        let k = kind(Class::Escalate, 2);
        assert!(stop(&d, &k, &adv("a")).is_none(), "a corrupt file is a fresh state, not a block");
        let file = tmp("file");
        std::fs::write(&file, "x").unwrap();
        let p0 = kind(Class::Block, 2);
        assert!(stop(&file.join("sub"), &p0, &adv("a")).is_none(), "state that cannot be written adds nothing");
        assert!(run_in(&d, "Stop", &json!({}), std::slice::from_ref(&p0), &adv("a")).is_none(), "no session, no ladder");
    }

    #[test]
    fn the_shipped_table_parses_and_an_override_changes_a_class() {
        let all = kinds(&serde_json::Map::new());
        assert!(all.iter().any(|k| k.class == Class::Block) && all.iter().any(|k| k.class == Class::Escalate));
        let first = all.first().unwrap().name.clone();
        let mut o = serde_json::Map::new();
        o.insert(first.clone(), json!(defaults::raw("nudges.class_words").str_field("off")));
        assert_eq!(kinds(&o).iter().find(|k| k.name == first).unwrap().class, Class::Off);
        for key in ["nudges.msg_escalated", "nudges.msg_first_fire"] {
            let t = defaults::text(key);
            assert!(t.lines().count() <= 2 && t.chars().filter(|c| !c.is_ascii()).count() == 1, "{key}: {t}");
        }
    }

    #[test]
    fn a_block_or_a_non_matching_advisory_is_not_a_fire() {
        let mut k = kind(Class::Escalate, 2);
        let blocked = vec![HookResult { id: "h".into(), code: Some(0), out: json!({"decision": "block", "reason": "r"}).to_string(), err: String::new() }];
        assert_eq!(observe(&k, &blocked), Seen::Quiet);
        k.matches = vec!["needle".into()];
        assert_eq!(observe(&k, &adv("hay")), Seen::Quiet);
        assert_eq!(observe(&k, &adv("a needle")), Seen::Fired("a needle".into()));
        k.count_blocks = true;
        let deny = vec![HookResult { id: "h".into(), code: Some(2), out: String::new(), err: "a needle denied\n".into() }];
        assert_eq!(observe(&k, &deny), Seen::Fired("a needle denied".into()), "a counted block is a fire");
    }

    #[test]
    fn a_stop_another_hook_blocks_holds_the_ladder_block_for_the_next_stop() {
        let d = tmp("held");
        let mut k = kind(Class::Block, 2);
        k.count_blocks = true;
        let b = vec![HookResult { id: "h".into(), code: Some(0), out: json!({"decision": "block", "reason": "r"}).to_string(), err: String::new() }];
        assert!(stop(&d, &k, &b).is_none(), "no second block on a Stop that is already blocked");
        assert!(load(&d, "s1").kinds["k"].pending, "held");
        assert!(stop(&d, &k, &[]).is_some(), "shown at the next Stop");
    }
}
