//! `devswarm.js plan set|show <id>` and `devswarm.js scope add <id>` (lane l8), ported from `scripts/devswarm-lib/heartbeat-plan.js`
//! (`cmdPlan`, `cmdScope`) and `companion/lib/devswarm-plan.js` (`parseSteps`, `splitGlobs`, `newPlan`, `replaceSteps`,
//! `addExtra`, `planKeyForWorktree`). The plan file, its lock, `findPlan`, `finishLabel` and the supervision log are the ones
//! the heartbeat's `--step` already uses ([`crate::meshw::plan`]).
//!
//! Anything the engine cannot treat exactly like JavaScript defers BEFORE the plan is written, and Node then runs the verb:
//! a `--steps-file` it cannot read (Node reports the operating system's message), a step or note cut that would split a
//! surrogate pair, a plan whose shape is not the one `devswarm-plan.js` writes (see [`plan`]), a supervision log due for rotation.
//! The plan write is the first thing this module does to the store; after it nothing defers (the supervision event is best
//! effort, as in Node).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{is_js_space, js_trim, slice_utf16};
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident::{R, defer};
use crate::meshw::idlock::is_safe_id;
use crate::meshw::plan;
use crate::meshw::send::{Answer, Effect};

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", v.stringify()), effect: Effect::None }
}

/// `{ok:false, action, [sub, id, key, reason,] error}` with exit code 2, fields in the order given.
fn fail(fields: &[(&str, OVal)]) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false));
    for (k, v) in fields {
        o.put(k, v.clone());
    }
    answer(2, o.done())
}

fn utf16(x: &str) -> usize {
    x.chars().map(char::len_utf16).sum()
}

// ---- parsing ------------------------------------------------------------------------------------------------------------

/// The `(number, body)` of one line of `/^\s*(?:[-*]\s+)?(?:step\s+)?(\d{1,3})[.):]\s+(\S.*)$/i`, or `None`.
fn match_step_line(line: &str) -> Option<(u32, &str)> {
    let skip_space = |from: usize| line[from..].find(|c: char| !is_js_space(c)).map_or(line.len(), |i| from + i);
    let mut i = skip_space(0);
    let bullets = defaults::text("devswarm_cli.plan_bullet_chars");
    let mut chars = line[i..].chars();
    if let (Some(b), Some(next)) = (chars.next(), chars.next())
        && bullets.contains(b)
        && is_js_space(next)
    {
        i = skip_space(i + b.len_utf8());
    }
    let word = defaults::text("devswarm_cli.plan_step_word");
    if let Some(head) = line.get(i..i + word.len())
        && head.eq_ignore_ascii_case(word)
        && line[i + word.len()..].chars().next().is_some_and(is_js_space)
    {
        i = skip_space(i + word.len());
    }
    let digits_end = line[i..].find(|c: char| !c.is_ascii_digit()).map_or(line.len(), |d| i + d);
    let digits = &line[i..digits_end];
    if digits.is_empty() || digits.len() > defaults::num("devswarm_cli.plan_max_number_digits") as usize {
        return None;
    }
    let sep = line[digits_end..].chars().next()?;
    if !defaults::text("devswarm_cli.plan_number_seps").contains(sep) {
        return None;
    }
    let after = digits_end + sep.len_utf8();
    if !line[after..].chars().next().is_some_and(is_js_space) {
        return None;
    }
    let body_at = skip_space(after);
    let body = &line[body_at..];
    // `\S.*$`: a first character that is not white space, then no line terminator up to the end
    if body.is_empty() || body.chars().any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')) {
        return None;
    }
    Some((digits.parse().ok()?, body))
}

/// `parseSteps(text)`: the first numbered list that runs 1, 2, 3 …; fewer than two items is no plan.
fn parse_steps(text: &str) -> R<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut expect = 1u32;
    let pieces: Vec<&str> = text.split('\n').collect();
    for (i, piece) in pieces.iter().enumerate() {
        // `split(/\r?\n/)`: only a CR that a LF follows goes with it
        let line = if i + 1 < pieces.len() { piece.strip_suffix('\r').unwrap_or(piece) } else { piece };
        let Some((num, body)) = match_step_line(line) else { continue };
        let Some(body) = slice_utf16(js_trim(body), defaults::num("devswarm_cli.plan_max_step_text") as usize) else { return defer("surrogate-cut") };
        if num == expect {
            out.push(body);
            expect += 1;
            if out.len() >= defaults::num("devswarm_cli.plan_max_steps") as usize {
                break;
            }
            continue;
        }
        if num == 1 {
            if out.len() >= 2 {
                break;
            }
            out.clear();
            out.push(body);
            expect = 2;
        }
    }
    Ok(if out.len() >= 2 { out } else { Vec::new() })
}

/// `splitGlobs(raw)`.
fn split_globs(raw: &str) -> Vec<String> {
    let seps = defaults::text("devswarm_cli.plan_glob_seps");
    let mut out: Vec<String> = Vec::new();
    for part in raw.split(|c: char| is_js_space(c) || seps.contains(c)) {
        let mut t = js_trim(part);
        // `.replace(/^`|`$/g, '')`: one leading and one trailing backtick
        t = t.strip_prefix('`').unwrap_or(t);
        t = t.strip_suffix('`').unwrap_or(t);
        if !t.is_empty() && utf16(t) <= defaults::num("devswarm_cli.plan_max_glob_len") as usize && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
        if out.len() >= defaults::num("devswarm_cli.plan_max_globs") as usize {
            break;
        }
    }
    out
}

/// `csvList(flags, name)`: every value split on commas, trimmed, without repeats.
fn csv_list(a: &Args, name: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in a.many(name) {
        for part in raw.split(',') {
            let t = js_trim(part);
            if !t.is_empty() && !out.iter().any(|x| x == t) {
                out.push(t.to_string());
            }
        }
    }
    out
}

// ---- the plan ----------------------------------------------------------------------------------------------------------

fn fresh_step(i: usize, text: &str) -> OVal {
    let mut o = Obj::default();
    o.put("n", n((i + 1) as f64)).put("text", s(text)).put("status", s("todo")).put("ts", OVal::Null).put("started_at", OVal::Null);
    o.done()
}

/// `newPlan({ key, id, worktreePath, steps, scope, base: null, source, now })`.
fn new_plan(key: &str, id: &str, wt: Option<&str>, steps: &[String], scope: &[String], source: &str, now: f64) -> OVal {
    let mut o = Obj::default();
    o.put("v", n(1.0))
        .put("key", s(key))
        .put("id", s(id))
        .put("worktreePath", wt.map_or(OVal::Null, s))
        .put("source", s(source))
        .put("created_at", n(now))
        .put("base", OVal::Null)
        .put("steps", OVal::Arr(steps.iter().take(defaults::num("devswarm_cli.plan_max_steps") as usize).enumerate().map(|(i, t)| fresh_step(i, t)).collect()))
        .put("scope_globs", OVal::Arr(scope.iter().take(defaults::num("devswarm_cli.plan_max_globs") as usize).map(|g| s(g)).collect()))
        .put("extras", OVal::Arr(Vec::new()))
        .put("step_ts", OVal::Null)
        .put("current", OVal::Null)
        .put("warned_at", OVal::Null)
        .put("warned_step", OVal::Null)
        .put("summaries", OVal::Arr(Vec::new()));
    o.done()
}

/// `replaceSteps(plan, steps, scope, now)` -> changed.
fn replace_steps(p: &mut OVal, steps: &[String], scope: Option<&[String]>, now: f64) -> R<bool> {
    let old: Vec<OVal> = plan::steps_of(p).to_vec();
    let same = old.len() == steps.len() && old.iter().zip(steps).all(|(x, t)| matches!(x.get("text"), Some(OVal::Str(y)) if y == t));
    let current_scope = match p.get("scope_globs") {
        Some(v) if v.truthy() => v.stringify(),
        _ => OVal::Arr(Vec::new()).stringify(),
    };
    let wanted_scope = scope.map(|g| OVal::Arr(g.iter().map(|x| s(x)).collect()).stringify());
    let scope_same = wanted_scope.as_ref().is_none_or(|w| *w == current_scope);
    if same && scope_same {
        return Ok(false);
    }
    if !same {
        let before = plan::steps_done(p);
        let kept: Vec<OVal> = steps
            .iter()
            .take(defaults::num("devswarm_cli.plan_max_steps") as usize)
            .enumerate()
            .map(|(i, t)| match old.get(i) {
                Some(prev) if matches!(prev.get("text"), Some(OVal::Str(y)) if y == t) => prev.clone(),
                _ => fresh_step(i, t),
            })
            .collect();
        p.set("steps", OVal::Arr(kept));
        p.set("replaced_at", n(now));
        plan::note_done_drop(p, before)?;
        plan::remove(p, "done_reported_at");
    }
    if let Some(g) = scope {
        p.set("scope_globs", OVal::Arr(g.iter().take(defaults::num("devswarm_cli.plan_max_globs") as usize).map(|x| s(x)).collect()));
    }
    Ok(true)
}

/// `addExtra(plan, glob, note, now)` -> changed.
fn add_extra(p: &mut OVal, glob: &str, note: &str, now: f64) -> R<bool> {
    if !matches!(p.get("extras"), Some(OVal::Arr(_))) {
        p.set("extras", OVal::Arr(Vec::new()));
    }
    let Some(n_text) = slice_utf16(note, defaults::num("devswarm_cli.plan_max_note") as usize) else { return defer("surrogate-cut") };
    let OVal::Obj(fields) = p else { return defer("plan-shape") };
    let Some((_, OVal::Arr(extras))) = fields.iter_mut().find(|(k, _)| k == "extras") else { return defer("plan-shape") };
    // `extras.find((e) => e.glob === glob)` throws on an entry that is no object
    if extras.iter().any(|e| !matches!(e, OVal::Obj(_))) {
        return defer("plan-shape");
    }
    if let Some(existing) = extras.iter_mut().find(|e| matches!(e.get("glob"), Some(OVal::Str(g)) if g == glob)) {
        if matches!(existing.get("note"), Some(OVal::Str(x)) if *x == n_text) {
            return Ok(false);
        }
        existing.set("note", s(&n_text));
        existing.set("ts", n(now));
        return Ok(true);
    }
    if extras.len() >= defaults::num("devswarm_cli.plan_max_extras") as usize {
        return Ok(false);
    }
    let mut e = Obj::default();
    e.put("glob", s(glob)).put("note", s(&n_text)).put("ts", n(now));
    extras.push(e.done());
    Ok(true)
}

/// The supervision event of a plan write, recorded after it (best effort); a log due for rotation was deferred beforehand.
fn record(inv: &Inv, typ: &str, fields: Vec<(String, OVal)>) {
    if plan::record(inv, typ, &fields, inv.now as f64).is_some() {
        plan::note_log(inv);
    }
}

// ---- plan ---------------------------------------------------------------------------------------------------------------

/// `plan set|show <id> ...`.
pub fn run_plan(inv: &Inv, a: &Args) -> R<Answer> {
    let sub = a.positionals.get(1).map(String::as_str);
    let id = a.positionals.get(2).map(String::as_str).unwrap_or("");
    let action = s(defaults::text("devswarm_cli.action_plan"));
    if !is_safe_id(id) {
        return Ok(fail(&[("action", action), ("error", s(defaults::text("devswarm_cli.msg_plan_bad_id")))]));
    }
    let id = match crate::meshw::actverbs::resolve_target_id(inv, id, defaults::text("devswarm_cli.action_plan"))? {
        Ok(x) => x,
        Err(refused) => return Ok(refused),
    };
    let id = id.as_str();
    let now = inv.now as f64;
    let sub_word = || sub.map_or(OVal::Null, s);
    let wt = plan::plan_ref(inv, id)?;
    if sub == Some(defaults::text("devswarm_cli.sub_show")) {
        let Some(found) = plan::find(inv, id)? else {
            return Ok(fail(&[("action", action), ("sub", sub_word()), ("id", s(id)), ("reason", s(defaults::text("devswarm_cli.plan_reason_none")))]));
        };
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(true))
            .put("action", action)
            .put("sub", sub_word())
            .put("id", s(id))
            .put("key", s(&found.key))
            .put("label", plan::finish_label(&found.plan, now)?)
            .put("plan", found.plan);
        return Ok(answer(0, o.done()));
    }
    if sub != Some(defaults::text("devswarm_cli.sub_set")) {
        return Ok(fail(&[("action", action), ("error", s(defaults::text("devswarm_cli.msg_plan_usage")))]));
    }
    let mut text = a.one(defaults::text("devswarm_cli.flag_steps")).map(str::to_string);
    if text.is_none()
        && let Some(file) = a.one(defaults::text("devswarm_cli.flag_steps_file"))
    {
        match std::fs::read(file) {
            Ok(b) => text = Some(String::from_utf8_lossy(&b).into_owned()),
            Err(_) => return defer("steps-file"),
        }
    }
    let steps = parse_steps(text.as_deref().unwrap_or(""))?;
    if steps.is_empty() {
        return Ok(fail(&[("action", action), ("sub", sub_word()), ("id", s(id)), ("error", s(defaults::text("devswarm_cli.msg_plan_no_steps")))]));
    }
    let scope = a.has(defaults::text("devswarm_cli.flag_scope")).then(|| split_globs(&csv_list(a, defaults::text("devswarm_cli.flag_scope")).join(",")));
    let found = plan::find(inv, id)?;
    let key = match &found {
        Some(f) => f.key.clone(),
        None => match wt.as_deref() {
            Some(w) => plan::key_for_worktree(w)?.unwrap_or_else(|| id.to_string()),
            None => id.to_string(),
        },
    };
    if plan::log_needs_rotation(inv) {
        return defer("supervision-rotate");
    }
    let source = defaults::text("devswarm_cli.plan_source_set");
    let done = plan::update_with(inv, &key, |cur| {
        Ok(match cur {
            Some(mut p) => {
                let changed = replace_steps(&mut p, &steps, scope.as_deref(), now)?;
                ((false, changed, p.clone()), changed.then_some(p))
            }
            None => {
                let p = new_plan(&key, id, wt.as_deref(), &steps, scope.as_deref().unwrap_or(&[]), source, now);
                ((true, true, p.clone()), Some(p))
            }
        })
    })?;
    let Some(((created, changed, p), written)) = done else {
        return Ok(fail(&[
            ("action", action),
            ("sub", sub_word()),
            ("id", s(id)),
            ("key", s(&key)),
            ("reason", s(defaults::text("devswarm_cli.plan_reason_busy"))),
            ("error", s(defaults::text("devswarm_cli.msg_plan_busy"))),
        ]));
    };
    if let Some(t) = written {
        crate::meshw::mark_committed();
        crate::meshw::note_written(&plan::plan_rel(&key), t.as_bytes());
    }
    let step_count = plan::steps_of(&p).len();
    if created {
        record(
            inv,
            defaults::text("devswarm_cli.plan_event_plan"),
            vec![("id".into(), s(id)), ("key".into(), s(&key)), ("source".into(), s(source)), ("steps".into(), n(step_count as f64))],
        );
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", action)
        .put("sub", sub_word())
        .put("id", s(id))
        .put("key", s(&key))
        .put("created", OVal::Bool(created))
        .put("changed", OVal::Bool(changed))
        .put("steps", n(step_count as f64));
    if let Some(g) = p.get("scope_globs") {
        o.put("scope", g.clone());
    }
    Ok(answer(0, o.done()))
}

// ---- scope --------------------------------------------------------------------------------------------------------------

/// `scope add <id> --glob G [--glob G2] --note TEXT`.
pub fn run_scope(inv: &Inv, a: &Args) -> R<Answer> {
    let sub = a.positionals.get(1).map(String::as_str);
    let id = a.positionals.get(2).map(String::as_str).unwrap_or("");
    let action = s(defaults::text("devswarm_cli.action_scope"));
    if !is_safe_id(id) {
        return Ok(fail(&[("action", action), ("error", s(defaults::text("devswarm_cli.msg_scope_bad_id")))]));
    }
    let id = match crate::meshw::actverbs::resolve_target_id(inv, id, defaults::text("devswarm_cli.action_scope"))? {
        Ok(x) => x,
        Err(refused) => return Ok(refused),
    };
    let id = id.as_str();
    if sub != Some(defaults::text("devswarm_cli.sub_add")) {
        return Ok(fail(&[("action", action), ("error", s(defaults::text("devswarm_cli.msg_scope_usage")))]));
    }
    let sub_word = || sub.map_or(OVal::Null, s);
    let now = inv.now as f64;
    let globs = split_globs(&csv_list(a, defaults::text("devswarm_cli.flag_glob")).join(","));
    let note = a.one(defaults::text("devswarm_cli.flag_note"));
    if globs.is_empty() {
        return Ok(fail(&[("action", action), ("sub", sub_word()), ("id", s(id)), ("error", s(defaults::text("devswarm_cli.msg_scope_glob_required")))]));
    }
    let note = match note {
        Some(t) if !js_trim(t).is_empty() => t,
        _ => {
            return Ok(fail(&[("action", action), ("sub", sub_word()), ("id", s(id)), ("error", s(defaults::text("devswarm_cli.msg_scope_note_required")))]));
        }
    };
    let wt = plan::plan_ref(inv, id)?;
    let found = plan::find(inv, id)?;
    let key = match &found {
        Some(f) => f.key.clone(),
        None => match wt.as_deref() {
            Some(w) => plan::key_for_worktree(w)?.unwrap_or_else(|| id.to_string()),
            None => id.to_string(),
        },
    };
    if plan::log_needs_rotation(inv) {
        return defer("supervision-rotate");
    }
    let source = defaults::text("devswarm_cli.plan_source_scope");
    let done = plan::update_with(inv, &key, |cur| {
        let created = cur.is_none();
        let mut p = cur.unwrap_or_else(|| new_plan(&key, id, wt.as_deref(), &[], &[], source, now));
        let mut changed = false;
        for g in &globs {
            if add_extra(&mut p, g, note, now)? {
                changed = true;
            }
        }
        let write = (changed || created).then(|| p.clone());
        Ok(((changed, p), write))
    })?;
    let Some(((changed, p), written)) = done else {
        return Ok(fail(&[
            ("action", action),
            ("sub", sub_word()),
            ("id", s(id)),
            ("key", s(&key)),
            ("reason", s(defaults::text("devswarm_cli.plan_reason_busy"))),
            ("error", s(defaults::text("devswarm_cli.msg_plan_busy"))),
        ]));
    };
    if let Some(t) = written {
        crate::meshw::mark_committed();
        crate::meshw::note_written(&plan::plan_rel(&key), t.as_bytes());
    }
    if changed {
        record(
            inv,
            defaults::text("devswarm_cli.plan_event_extra"),
            vec![("id".into(), s(id)), ("key".into(), s(&key)), ("globs".into(), n(globs.len() as f64))],
        );
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("action", action).put("sub", sub_word()).put("id", s(id)).put("key", s(&key)).put("changed", OVal::Bool(changed));
    if let Some(x) = p.get("extras") {
        o.put("extras", x.clone());
    }
    Ok(answer(0, o.done()))
}
