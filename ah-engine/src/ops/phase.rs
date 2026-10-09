//! `ah-engine phase`: write or update the phase state the status line's phase bar shows. Port of `statusline/phase.js`.
//!
//! The coordinator calls it as real work progresses (`set`, `advance`, `step`, `agents`, `update`, `clear`); the state is one
//! JSON line in `~/.anti-hall/phase-state.json`. It fails open like the script: a problem writing the file is not an error
//! and the exit code is 0. An existing state that is not a JSON object, or a field name JavaScript would treat specially, is
//! left to the Node script (nothing written, exit with the deferral code).
use super::{defer_code, env_snapshot, err, home, jsio};
use crate::checks::jsport::json::{self, J};
use crate::cli::Parsed;
use crate::defaults;
use crate::ops::js::Defer;
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

/// A key JavaScript keeps in numeric order ahead of the others: the merge appends, so the engine leaves such a key to Node.
fn is_index_key(k: &str) -> bool {
    let canonical = k == "0" || (k.starts_with(|c: char| ('1'..='9').contains(&c)) && k.bytes().all(|b| b.is_ascii_digit()));
    canonical && k.parse::<u64>().is_ok_and(|n| n < u64::from(u32::MAX))
}

fn num(n: f64) -> J {
    J::Num(n)
}

/// The state as the script reads it: `{}` when the file is absent, unreadable or not JSON.
fn read(file: &Path) -> Result<J, Defer> {
    let Some(text) = crate::checks::jsport::fsx::read_utf8(&file.to_string_lossy()) else { return Ok(J::Obj(Vec::new())) };
    match json::parse(&text, defaults::num("setup.json_max_depth") as usize) {
        Ok(v) => Ok(v),
        Err(json::Fail::Invalid) => Ok(J::Obj(Vec::new())),
        Err(json::Fail::Unsupported) => Err(Defer),
    }
}

/// The state of a mutating subcommand: it must be an object (the script's assignments to anything else throw or behave
/// differently, and the engine does not reproduce that).
fn read_object(file: &Path) -> Result<Vec<(String, J)>, Defer> {
    match read(file)? {
        J::Obj(o) => Ok(o),
        _ => Err(Defer),
    }
}

fn set_key(o: &mut Vec<(String, J)>, k: &str, v: J) {
    match o.iter_mut().find(|(ek, _)| ek == k) {
        Some(slot) => slot.1 = v,
        None => o.push((k.to_string(), v)),
    }
}

fn exec(args: &[String]) -> Result<(), Defer> {
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
        let mut s = read_object(&file)?;
        let key = defaults::text("slcfg.phase_key_done");
        let before = super::statusline::util::parse_int_of(s.iter().find(|(k, _)| k == key).map(|(_, v)| v)).unwrap_or(0.0);
        let before = if before == 0.0 { 0.0 } else { before };
        set_key(&mut s, key, num(before + int_or(rest.first(), 1.0)));
        s
    } else if is("slcfg.phase_step") {
        let mut s = read_object(&file)?;
        set_key(&mut s, defaults::text("slcfg.phase_key_step"), J::Str(rest.join(" ")));
        s
    } else if is("slcfg.phase_agents") {
        let mut s = read_object(&file)?;
        let key = defaults::text("slcfg.phase_key_agents");
        match int_of(rest.first()) {
            Some(n) => set_key(&mut s, key, num(n)),
            None => s.retain(|(k, _)| k != key),
        }
        s
    } else if is("slcfg.phase_update") {
        let mut s = read_object(&file)?;
        for a in rest {
            let Some(i) = a.find('=').filter(|i| *i > 0) else { continue };
            let (k, v) = (&a[..i], &a[i + 1..]);
            if is_index_key(k) || k == defaults::text("slcfg.phase_proto_key") {
                return Err(Defer);
            }
            let digits = v.strip_prefix('-').unwrap_or(v);
            let value = if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) { num(parse_int(v).unwrap_or(0.0)) } else { J::Str(v.to_string()) };
            set_key(&mut s, k, value);
        }
        s
    } else if is("slcfg.phase_clear") {
        crate::discard::harmless(std::fs::remove_file(&file)); // keep: already gone is the goal state, and the script ignores it too
        return Ok(());
    } else {
        let shown = cmd.unwrap_or_else(|| defaults::text("slcfg.phase_undefined"));
        err(&(defaults::render("slcfg.phase_unknown", &[("cmd", &shown)]) + "\n"));
        return Ok(());
    };
    // fail-open: a state that cannot be written is not an error
    if std::fs::create_dir_all(&dir).is_ok() {
        crate::discard::harmless(jsio::write_file(&file.to_string_lossy(), json::stringify(&J::Obj(state)).as_bytes())); // keep: the script is fail-open here too
    }
    Ok(())
}

/// `phase <set|advance|step|agents|update|clear> ...`
pub fn run(p: &Parsed) -> i32 {
    let plan = super::shadow::begin(defaults::text("ops.verb_phase"), defaults::text("ops.script_phase"), &p.raw, None);
    let code = match exec(&p.raw) {
        Ok(()) => 0,
        Err(Defer) => {
            err(&(defaults::text("slcfg.deferred").to_string() + "\n"));
            defer_code()
        }
    };
    super::shadow::end(plan, code);
    code
}
