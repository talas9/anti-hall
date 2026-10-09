//! What the sweep does with an answer it may act on, exactly as Node's supervisor did while these integrations were on.
//!
//! * devswarmWaitKind: the verdict (`stuck` or waiting on CI, the owner or a peer) is attached to the child's idle and stall
//!   warnings as a `jev` note, the way Node's `note()` did; it never removes a warning.
//! * devswarmLoop: the verdict is attached to the burn warning, else the stall warning; when neither exists and the answer is
//!   `looping`, the sweep adds Jev's own advisory `loop` warning (counted against `devswarm.strayWarnMax` like any other).
//! * devswarmStepMap: the step number is written into the plan as `inferred_step` under the plan lock, on the fresh plan, so a
//!   concurrent heartbeat is never lost; the plan label shows it as `~#N` only while no step was ever reported.
//!
//! The supervisor rewrites a child's straying state on each of its own passes from the signals it computes, which carry no note, so
//! the sweep keeps the last acted-on answer of each subject in its memory and puts the note back on every later pass until the
//! subject changes (the supervisor re-read Jev's cached answer on every pass for the same reason). Every effect is also written to
//! the supervision log (`jev` once per subject, `warn` for an advisory warning) so `supervision-report` counts the answers.
//! All words, files, thresholds and signal names are in `engine/defaults/jev_sweep.toml`.
use super::evidence::Outcome;
use super::*;
use crate::checks::guardkit::ojson::OVal;
use crate::meshw::common::Inv;

fn act_str(k: &str) -> &'static str {
    defaults::raw("sweep.act").str_field(k)
}
fn act_int(k: &str) -> i64 {
    defaults::raw("sweep.act").get(k).and_then(defaults::V::as_integer).unwrap_or(0)
}
fn act_words(k: &str) -> &'static str {
    defaults::raw("sweep.act_words").str_field(k)
}
fn act_list(k: &str) -> Vec<&'static str> {
    defaults::raw("sweep.act").get(k).map(defaults::V::strings).unwrap_or_default()
}

/// Everything an effect needs to know about the child and the moment.
pub(super) struct Ctx<'a> {
    pub home: &'a Path,
    pub env: &'a Env,
    pub base: &'a Path,
    pub now: i64,
    pub key: &'a str,
    pub id: &'a str,
    pub plan: &'a Value,
    /// The quiet window (`devswarm.stepStallMin`) the supervisor's stall warning uses.
    pub stall: i64,
    /// The cap of warnings per signal and step (`devswarm.strayWarnMax`).
    pub warn_max: i64,
}

impl Ctx<'_> {
    fn stray_file(&self) -> PathBuf {
        self.base.join(act_str("stray_dir")).join(format!("{}{}", self.key, path_cfg("plan_ext")))
    }
    fn inv(&self) -> Inv {
        Inv {
            home: self.home.to_path_buf(),
            env: self.env.to_map(),
            cwd: String::new(),
            now: self.now,
            stdin: None,
            write_home: self.home.to_path_buf(),
            store_override: None,
        }
    }
}

/// How the linked PR is named in a CI line taken from the realtime layer.
pub(super) fn pr_name(n: Option<i64>) -> String {
    match n {
        Some(n) => act_words("rt_pr_name").replace("{n}", &n.to_string()),
        None => act_words("rt_pr_unnamed").to_string(),
    }
}

/// The integration's answer that means yes (`stuck`, `looping`), from the evidence gate's own table.
fn true_label(integ: &str) -> &'static str {
    defaults::raw("evidence.cfg").get(integ).map_or("", |c| c.str_field("true_label"))
}

fn round(c: f64) -> f64 {
    let s = act_int("confidence_scale").max(1) as f64;
    (c * s).round() / s
}

/// The note Node's `note()` attached: integration, verdict, confidence and whether Jev supports the warning.
fn note_json(integ: &str, verdict: &str, confidence: f64, supports: bool) -> Value {
    json!({"integration": integ, "verdict": verdict, "confidence": round(confidence), "supports": supports})
}

fn read_stray(ctx: &Ctx) -> Option<Value> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(ctx.stray_file()).ok()?).ok()?;
    v.is_object().then_some(v)
}

fn write_stray(ctx: &Ctx, v: &Value) {
    if let Some(dir) = ctx.stray_file().parent() {
        crate::discard::logged("jev_act_stray_dir", std::fs::create_dir_all(dir));
    }
    crate::discard::logged("jev_act_stray", crate::atomic::write(ctx.stray_file(), v.to_string()));
}

/// Attach `note` to the entry's `jev` list, replacing an earlier note of the same integration. True when the entry changed.
fn put_note(entry: &mut Value, note: &Value) -> bool {
    let integ = &note["integration"];
    let mut list: Vec<Value> = entry["jev"].as_array().cloned().unwrap_or_default();
    if let Some(at) = list.iter().position(|n| n["integration"] == *integ) {
        if list[at] == *note {
            return false;
        }
        list[at] = note.clone();
    } else {
        list.push(note.clone());
    }
    entry["jev"] = Value::Array(list);
    true
}

/// The current step's number and when it began (what Node's loop key is built from).
fn step_and_since(ctx: &Ctx) -> (i64, i64) {
    let cur = current_step(ctx.plan);
    let n = cur.and_then(|c| c["n"].as_i64()).unwrap_or(0);
    let since = cur.and_then(|c| num(c, "started_at")).or_else(|| num(ctx.plan, "created_at")).unwrap_or(ctx.now);
    (n, since)
}

/// Whether the supervisor's own stall warning applies now (what Node's `has('stall')` read for a live child).
fn stall_applies(ctx: &Ctx) -> bool {
    !ctx.plan["done_reported_at"].is_number() && ctx.now - last_progress(ctx.plan, ctx.now) >= ctx.stall
}

/// Put the note on the warnings it belongs to; return whether the stray file changed. With `advisory`, a `looping` answer that
/// finds no warning to join adds its own (bounded by `warn_max`), exactly once per episode.
fn attach(ctx: &Ctx, hosts: &[&str], note: &Value, advisory: bool) -> (bool, Option<bool>) {
    let mut st = read_stray(ctx).unwrap_or_else(
        || json!({"v": 1, "key": ctx.key, "id": ctx.id, "worktreePath": Value::Null, "warned": {}, "perStep": {}, "active": [], "updated_at": ctx.now}),
    );
    let mut changed = false;
    let mut joined = false;
    let mut active: Vec<Value> = st["active"].as_array().cloned().unwrap_or_default();
    // the hosts in order: the first signal kind that has an entry takes the note (Loop: burn, else stall); WaitKind takes all of them
    let first_only = advisory;
    for host in hosts {
        let mut hit = false;
        for e in active.iter_mut().filter(|e| e["signal"] == *host) {
            hit = true;
            changed |= put_note(e, note);
        }
        joined |= hit;
        if hit && first_only {
            break;
        }
    }
    let mut issued: Option<bool> = None;
    if advisory && !joined && note["supports"] == Value::Bool(true) && !stall_applies(ctx) {
        let (n, since) = step_and_since(ctx);
        let sig = act_str("loop_signal");
        let k = act_str("loop_key").replace("{n}", &n.to_string()).replace("{since}", &since.to_string());
        let cap = format!("{sig}:{n}");
        let existing = st["warned"][&k].clone();
        let w = if existing.is_object() {
            Some(existing)
        } else if ctx.warn_max > 0 && st["perStep"][&cap].as_i64().unwrap_or(0) < ctx.warn_max {
            let c = st["perStep"][&cap].as_i64().unwrap_or(0);
            let w = json!({"at": ctx.now, "n": c + 1, "signal": sig, "step": n});
            st["warned"][&k] = w.clone();
            st["perStep"][&cap] = json!(c + 1);
            issued = Some(c > 0);
            Some(w)
        } else {
            None
        };
        if let Some(w) = w {
            if let Some(e) = active.iter_mut().find(|e| e["key"] == k.as_str()) {
                changed |= put_note(e, note);
            } else {
                let reason = act_words("loop_reason").replace("{dur}", &dur(ctx.now - since));
                let mut e = json!({"key": k, "signal": sig, "step": n, "reason": reason, "at": w["at"], "n": w["n"]});
                put_note(&mut e, note);
                active.push(e);
                changed = true;
            }
        }
    }
    if changed {
        st["active"] = Value::Array(active);
        st["updated_at"] = json!(ctx.now);
        write_stray(ctx, &st);
    }
    (changed, issued)
}

fn log_event(ctx: &Ctx, typ: &str, fields: Vec<(&str, OVal)>) {
    let inv = ctx.inv();
    if crate::meshw::plan::log_needs_rotation(&inv) {
        return; // Node rotates the log; the engine only appends
    }
    let f: Vec<(String, OVal)> = fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    crate::meshw::plan::record(&inv, typ, &f, ctx.now as f64);
}

fn s(x: &str) -> OVal {
    OVal::Str(x.to_string())
}

/// The effect of an answer. Returns what to remember for later passes (the note, or `Null` when nothing needs re-applying) and a
/// word for the sweep's result; `None` when the answer may not be acted on.
pub(super) fn apply(ctx: &Ctx, integ: &str, o: &Outcome) -> Option<(Value, &'static str)> {
    if !o.actionable {
        return None;
    }
    let label = o.label.as_deref()?;
    // a model answer must clear the integration's own floor; a rule's answer carries the configured rule confidence
    let min = defaults::raw("sweep.act").get("min_confidence_pct").and_then(|t| t.get(integ)).and_then(defaults::V::as_integer).unwrap_or(0);
    if o.confidence.is_some_and(|c| c * 100.0 + 1e-9 < min as f64) {
        return None;
    }
    let confidence = o.confidence.unwrap_or(act_int("rule_confidence_pct") as f64 / 100.0);
    let mode = act_words("mode_on");
    let event = |agree: bool| {
        log_event(
            ctx,
            act_words("ev_jev"),
            vec![
                ("id", s(ctx.id)),
                ("key", s(ctx.key)),
                ("integration", s(integ)),
                ("mode", s(mode)),
                ("agree", OVal::Bool(agree)),
                ("confidence", OVal::Num(round(confidence))),
            ],
        )
    };
    match integ {
        "devswarmWaitKind" => {
            let yes = label == true_label(integ);
            let note = note_json(integ, act_words(if yes { "wait_true" } else { "wait_false" }), confidence, yes);
            attach(ctx, &act_list("wait_signals"), &note, false);
            event(yes);
            Some((note, "annotated"))
        }
        "devswarmLoop" => {
            let yes = label == true_label(integ);
            let note = note_json(integ, act_words(if yes { "loop_true" } else { "loop_false" }), confidence, yes);
            let (_, issued) = attach(ctx, &act_list("loop_hosts"), &note, true);
            if let Some(repeat) = issued {
                let (n, _) = step_and_since(ctx);
                log_event(
                    ctx,
                    act_words("ev_warn"),
                    vec![
                        ("id", s(ctx.id)),
                        ("key", s(ctx.key)),
                        ("signal", s(act_str("loop_signal"))),
                        ("step", OVal::Num(n as f64)),
                        ("repeat", OVal::Bool(repeat)),
                    ],
                );
            }
            event(!yes);
            Some((note, if issued.is_some() { "advisory_loop" } else { "annotated" }))
        }
        "devswarmStepMap" => {
            let n: i64 = label.trim().parse().ok()?;
            let steps = ctx.plan["steps"].as_array().map_or(0, Vec::len) as i64;
            if n < 1 || n > steps || ctx.plan["inferred_step"].as_i64() == Some(n) {
                return None;
            }
            let wrote = crate::meshw::plan::update_with(&ctx.inv(), ctx.key, |cur| {
                Ok(match cur {
                    Some(mut p) if p.get("inferred_step").is_none_or(|v| !matches!(v, OVal::Num(x) if *x == n as f64)) => {
                        p.set("inferred_step", OVal::Num(n as f64));
                        ((), Some(p))
                    }
                    _ => ((), None),
                })
            });
            let written = matches!(wrote, Ok(Some((_, Some(_)))));
            let cur = current_step(ctx.plan).and_then(|c| c["n"].as_i64());
            event(cur == Some(n));
            written.then_some((Value::Null, "inferred_step"))
        }
        _ => None,
    }
}

/// Put an earlier acted-on note back on the warnings the supervisor has rewritten since (no new event, no new warning count).
pub(super) fn reapply(ctx: &Ctx, integ: &str, note: &Value) {
    match integ {
        "devswarmWaitKind" => {
            attach(ctx, &act_list("wait_signals"), note, false);
        }
        "devswarmLoop" => {
            attach(ctx, &act_list("loop_hosts"), note, true);
        }
        _ => {}
    }
}
