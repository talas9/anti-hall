//! `ah-engine phase`: write or update the phase state the status line's phase bar shows. Port of `statusline/phase.js`.
//!
//! The coordinator calls it as real work progresses (`set`, `advance`, `step`, `agents`, `update`, `clear`); the state is one
//! JSON line in `~/.anti-hall/phase-state.json`. It fails open like the script: a problem writing the file is not an error
//! and the exit code is 0. The object is written in JavaScript's own key order (integer index keys first, ascending) and an
//! `update` of `__proto__` is ignored unless the state holds an own `__proto__` key, as in JavaScript. An existing state that
//! is not a JSON object (where the script's assignments throw or are dropped), or JSON the parser cannot represent exactly, is
//! left untouched: nothing is written and the exit code is 0.
use super::{env_snapshot, err, home, jsio};
use crate::checks::jsport::json::{self, J};
use crate::cli::Parsed;
use crate::defaults;
use crate::setup::jsfmt::parse_int;
use std::path::Path;

/// `parseInt(s, 10)` of an optional argument: `None` is NaN.
fn int_of(s: Option<&String>) -> Option<f64> {
    s.and_then(|s| parse_int(s))
}

/// `parseInt(s, 10) || fallback`: NaN and zero (also -0) take the fallback.
fn int_or(s: Option<&String>, fallback: f64) -> f64 {
    match int_of(s) {
        Some(n) if n != 0.0 => n,
        _ => fallback,
    }
}

/// A key JavaScript keeps in numeric order ahead of the others (an array index: canonical and below 2^32 - 1).
fn is_index_key(k: &str) -> bool {
    let canonical = k == "0" || (k.starts_with(|c: char| ('1'..='9').contains(&c)) && k.bytes().all(|b| b.is_ascii_digit()));
    canonical && k.parse::<u64>().is_ok_and(|n| n < u64::from(u32::MAX))
}

fn num(n: f64) -> J {
    J::Num(n)
}

/// What a mutating subcommand starts from.
enum State {
    /// The object to change (`{}` when the file is absent, unreadable or not JSON, as in the script).
    Obj(Vec<(String, J)>),
    /// A state the engine leaves exactly as it is.
    Keep,
}

/// The state as the script reads it.
fn read_object(file: &Path) -> State {
    let Some(text) = crate::checks::jsport::fsx::read_utf8(&file.to_string_lossy()) else { return State::Obj(Vec::new()) };
    match json::parse(&text, defaults::num("setup.json_max_depth") as usize) {
        Ok(J::Obj(o)) => State::Obj(o),
        Err(json::Fail::Invalid) => State::Obj(Vec::new()),
        Ok(_) | Err(json::Fail::Unsupported) => State::Keep,
    }
}

/// The object's members in the order `JSON.stringify` lists them: integer index keys ascending, then the rest as inserted.
fn js_order(mut o: Vec<(String, J)>) -> Vec<(String, J)> {
    let (mut idx, rest): (Vec<_>, Vec<_>) = o.drain(..).partition(|(k, _)| is_index_key(k));
    idx.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(u64::MAX));
    idx.extend(rest);
    idx
}

fn set_key(o: &mut Vec<(String, J)>, k: &str, v: J) {
    match o.iter_mut().find(|(ek, _)| ek == k) {
        Some(slot) => slot.1 = v,
        None => o.push((k.to_string(), v)),
    }
}

fn exec(args: &[String]) {
    let env = env_snapshot();
    let dir = Path::new(&home(&env)).join(defaults::text("paths.base_dir"));
    let file = dir.join(defaults::text("statusline.phase_state_file"));
    let cmd = args.first().map(String::as_str);
    let rest = args.get(1..).unwrap_or(&[]);
    let is = |key: &str| cmd == Some(defaults::text(key));
    let state: Vec<(String, J)> = if is("slcfg.phase_set") {
        let keys = defaults::list("slcfg.phase_set_keys");
        let text = |i: usize| J::Str(rest.get(i).cloned().unwrap_or_default());
        let count = |i: usize| num(int_or(rest.get(i), 0.0));
        let started = num(crate::checks::jsport::date::now_ms());
        vec![(keys[0].into(), text(0)), (keys[1].into(), text(1)), (keys[2].into(), count(2)), (keys[3].into(), count(3)), (keys[4].into(), started)]
    } else if is("slcfg.phase_advance") {
        let State::Obj(mut s) = read_object(&file) else { return };
        let key = defaults::text("slcfg.phase_key_done");
        let before = super::statusline::util::parse_int_of(s.iter().find(|(k, _)| k == key).map(|(_, v)| v)).unwrap_or(0.0);
        let before = if before == 0.0 { 0.0 } else { before };
        set_key(&mut s, key, num(before + int_or(rest.first(), 1.0)));
        s
    } else if is("slcfg.phase_step") {
        let State::Obj(mut s) = read_object(&file) else { return };
        set_key(&mut s, defaults::text("slcfg.phase_key_step"), J::Str(rest.join(" ")));
        s
    } else if is("slcfg.phase_agents") {
        let State::Obj(mut s) = read_object(&file) else { return };
        let key = defaults::text("slcfg.phase_key_agents");
        match int_of(rest.first()) {
            Some(n) => set_key(&mut s, key, num(n)),
            None => s.retain(|(k, _)| k != key),
        }
        s
    } else if is("slcfg.phase_update") {
        let State::Obj(mut s) = read_object(&file) else { return };
        for a in rest {
            let Some(i) = a.find('=').filter(|i| *i > 0) else { continue };
            let (k, v) = (&a[..i], &a[i + 1..]);
            // `__proto__` is an accessor unless the object already has an own member of that name; a string or number given
            // to the accessor is ignored
            if k == defaults::text("slcfg.phase_proto_key") && !s.iter().any(|(ek, _)| ek == k) {
                continue;
            }
            let digits = v.strip_prefix('-').unwrap_or(v);
            let value = if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) { num(parse_int(v).unwrap_or(0.0)) } else { J::Str(v.to_string()) };
            set_key(&mut s, k, value);
        }
        s
    } else if is("slcfg.phase_clear") {
        crate::discard::harmless(std::fs::remove_file(&file)); // keep: already gone is the goal state, and the script ignores it too
        return;
    } else {
        let shown = cmd.unwrap_or_else(|| defaults::text("slcfg.phase_undefined"));
        err(&(defaults::render("slcfg.phase_unknown", &[("cmd", &shown)]) + "\n"));
        return;
    };
    // fail-open: a state that cannot be written is not an error
    if std::fs::create_dir_all(&dir).is_ok() {
        crate::discard::harmless(jsio::write_file(&file.to_string_lossy(), json::stringify(&J::Obj(js_order(state))).as_bytes())); // keep: the script is fail-open here too
    }
}

/// `phase <set|advance|step|agents|update|clear> ...`
pub fn run(p: &Parsed) -> i32 {
    let plan = super::shadow::begin(defaults::text("ops.verb_phase"), defaults::text("ops.script_phase"), &p.raw, None);
    exec(&p.raw);
    super::shadow::end(plan, 0);
    0
}
