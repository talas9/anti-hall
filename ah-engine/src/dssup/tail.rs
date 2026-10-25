//! The per-workspace tail of the verdicts duty: what `sweepOnce` of `companion/devswarm-supervisor.js` does for a workspace after its
//! liveness verdict is written, besides poke and escalate (those are the engine's own actions).
//!
//! * **The Jev blocker label** (`jevBlockerLabel`): when the Primary last rendered a triage-labelled message from this child (the
//!   pending-inbound cache of the Jev triage), the child reads `wedged` (a blocker) or `waiting-on-parent` (a question). It is a
//!   report annotation only, attached after any poke and never changing what the sweep did. The decision is logged as a Jev
//!   decision row derived from the triage label (`derivedFrom: triage`), asked at most once per input per
//!   `devswarm.supervisorBlockerLabelReaskSec`, and shown only in mode `on`.
//! * **The straying signals** (`superviseStraying` over `companion/lib/devswarm-supervision.js`): for a child with a step plan,
//!   `idle` (the verdict is stale, nudged or escalated), `stall` (alive, but no step progress for `devswarm.stepStallMin`), `burn`
//!   (the child's own transcript shows more than `devswarm.burnTokensWarn` weighted tokens since its last step progress) and
//!   `off-scope` (its commits touch files outside the plan's scope globs, from the read-only `ready-check`). Each signal episode
//!   warns once, a new episode of the same signal on the same step warns again up to `devswarm.strayWarnMax`; the state is
//!   `devswarm/stray/<planKey>.json`, which the parent Stop gate reads. Advisory only: nothing messages the child, blocks the
//!   Primary or kills anything. The Jev notes on an `off-scope` warning (`devswarmOnBrief`, `devswarmExtraSanctioned`) are
//!   decided here (`super::jevnotes`); the notes of the other signals are put there by the engine's `jev sweep`.
//!
//! Everything is fail-open per workspace: an error for one never affects the others. The supervision log (`warn` and `tokens`
//! events) is rotated natively past its size limit (`super::suplog`: the daily roll-ups first) before an event is appended.
// Discard triage (E3): every `.ok()` / `harmless` in this file is a deliberate keep, for these reasons:
// - an unreadable optional state file is the absent one (Node: `try { JSON.parse(...) } catch (_) {}`)
// - the ask-state and token-usage files are best-effort bookkeeping (Node: "fail-open: dedupe is best-effort")
use super::liveness::Desc;
use super::tick::Ctx;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::settings as gset;
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::jev::assist::{content_hash, iso_ms};
use crate::jev::log::{DecisionLog, FileLog, Row};
use crate::jev::settings::{Env as JevEnv, JevSettings, Mode, Sources};
use crate::meshw::common::Inv;
use crate::meshw::idlock::devswarm_root;
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

fn inv_of(ctx: &Ctx, cwd: &str) -> Inv {
    Inv {
        home: ctx.home.to_path_buf(),
        env: ctx.st.env.clone(),
        cwd: cwd.to_string(),
        now: ctx.now,
        stdin: None,
        write_home: ctx.home.to_path_buf(),
        store_override: None,
    }
}

fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

pub(super) fn write_json(path: &Path, v: &OVal) -> bool {
    if let Some(d) = path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports the failure
    }
    crate::atomic::write(path, v.stringify()).is_ok()
}

pub(super) fn read_obj(path: &Path) -> Option<OVal> {
    OVal::parse(&String::from_utf8_lossy(&std::fs::read(path).ok()?)).filter(|v| matches!(v, OVal::Obj(_)))
}

// ---- the Jev blocker label --------------------------------------------------------------------------------------------------

fn pending_file(home: &Path) -> PathBuf {
    home.join(defaults::text("mesh_write.dir_anti_hall")).join(defaults::text("mesh_write.dir_state")).join(defaults::text("mesh_write.jev_pending_file"))
}

fn ask_state_path(home: &Path, id: &str) -> PathBuf {
    devswarm_root(home).join(defaults::text("devswarm_sup.tl_ask_dir")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")))
}

/// `resolveBlockerLabelReaskMs(env)`.
pub(super) fn reask_ms(ctx: &Ctx) -> f64 {
    let sec = gset::get_number(ctx.st, defaults::raw("devswarm_sup.tl_set_reask_sec"));
    (if sec.is_finite() && sec > 0.0 { sec } else { defaults::num("devswarm_sup.tl_reask_default_sec") as f64 })
        * defaults::num("devswarm_sup.lv_ms_per_sec") as f64
}

/// The unit of the Jev decision log: its settings once per pass.
struct JevLane {
    settings: JevSettings,
    log: FileLog,
}

impl JevLane {
    fn load(ctx: &Ctx) -> JevLane {
        let env = JevEnv::from_pairs(ctx.st.env.iter().map(|(k, v)| (k.clone(), v.clone())));
        let settings = JevSettings::resolve(ctx.home, Sources::load(ctx.home, env));
        let path = ctx.home.join(defaults::text("paths.base_dir")).join(defaults::text("jev.log_file"));
        let log = FileLog::new(path, defaults::num("jev.log_max_bytes"), settings.log_rotated_files);
        JevLane { settings, log }
    }

    /// The decision row of a label re-read from the triage cache (Node's `finalize` with `r = {ok, answer: label, confidence: 1, ms: 0}`,
    /// `cachedFlag`, trust `advisory`, baseline `null`).
    fn row(&self, ctx: &Ctx, id: &str, hash: &str, label: &str, mode: Mode) -> Row {
        let confident = 1.0 >= self.settings.assist_threshold;
        let would_be = if confident { json!(true) } else { Value::Null };
        let changed = mode == Mode::On && would_be != Value::Null;
        let word = |c: bool| if c { json!(defaults::text("devswarm_sup.tl_changed")) } else { Value::Null };
        let mut row = Row::default();
        row.put("ts", json!(iso_ms(ctx.now.max(0) as u64)));
        row.put("id", json!(id));
        row.put("h", json!(hash));
        row.put("base", Value::Null);
        row.put("jev", json!(label));
        row.put("conf", json!(1));
        row.put("ms", json!(0));
        row.put("backend", json!(defaults::text("devswarm_sup.tl_backend_cache")));
        row.put("final", if mode == Mode::On { would_be.clone() } else { Value::Null });
        row.put("changed", word(changed));
        if mode != Mode::On {
            row.put("wouldChange", word(would_be != Value::Null));
        }
        row.put("cached", json!(true));
        row.put("mode", json!(mode.as_str()));
        row.put(
            "project",
            json!(
                std::env::current_dir()
                    .ok()
                    .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| defaults::text("devswarm_sup.tl_project_unknown").to_string())
            ),
        );
        row.put("derivedFrom", json!(defaults::text("devswarm_sup.tl_derived_from")));
        row.put("costUsd", json!(0));
        row.put("costSource", json!(defaults::text("devswarm_sup.tl_backend_cache")));
        row
    }
}

/// `jevBlockerLabel(childId, home, opts)`: the label to attach to the child's report row, or `None`.
fn blocker_label(ctx: &Ctx, lane: &JevLane, id: &str) -> Option<&'static str> {
    let pending = read_obj(&pending_file(ctx.home))?;
    let OVal::Obj(entries) = &pending else { return None };
    let suffix = format!("{}{id}", defaults::text("devswarm_sup.lv_jev_key_sep"));
    let hit = entries.iter().find(|(k, _)| k.ends_with(&suffix)).map(|(_, v)| v)?;
    let kind = match hit.get("kind") {
        Some(OVal::Str(k)) => k.as_str(),
        _ => return None,
    };
    let [blocker_kind, question_kind] = [defaults::text("devswarm_sup.tl_kind_blocker"), defaults::text("devswarm_sup.tl_kind_question")];
    if kind != blocker_kind && kind != question_kind {
        return None;
    }
    let label: &'static str =
        if kind == blocker_kind { defaults::text("devswarm_sup.tl_label_wedged") } else { defaults::text("devswarm_sup.tl_label_waiting") };
    let ts = hit.get("ts").map_or_else(|| "undefined".to_string(), crate::dssup::ingest::import::js_string);
    let sep = defaults::text("devswarm_sup.lv_jev_key_sep");
    let input_hash = format!("{id}{sep}{kind}{sep}{ts}");
    let now = ctx.now as f64;
    // dedupe: the same input within the re-ask interval is not asked or logged again, but the label the last ask decided still shows
    let state_path = ask_state_path(ctx.home, id);
    let prev = read_obj(&state_path);
    let prev_hash = match prev.as_ref().and_then(|p| p.get("hash")) {
        Some(OVal::Str(h)) => h.as_str(),
        _ => "",
    };
    let prev_at = match prev.as_ref().and_then(|p| p.get("askedAt")) {
        Some(OVal::Num(x)) if x.is_finite() => *x,
        _ => 0.0,
    };
    let prev_mode = match prev.as_ref().and_then(|p| p.get("mode")) {
        Some(OVal::Str(m)) => m.as_str(),
        _ => "",
    };
    if prev_hash == input_hash && now - prev_at < reask_ms(ctx) {
        return (prev_mode == Mode::On.as_str()).then_some(label);
    }
    let remember = |mode: &str| {
        write_json(
            &state_path,
            &OVal::Obj(vec![("hash".into(), OVal::Str(input_hash.clone())), ("askedAt".into(), OVal::Num(now)), ("mode".into(), OVal::Str(mode.to_string()))]),
        )
    };
    let id_name = defaults::text("devswarm_sup.tl_integration");
    let mode = lane.settings.mode(id_name, false);
    if mode == Mode::Off {
        // no log row, no label; the ask is still recorded so an off->on flip mid-interval is not blocked by a stale entry
        remember(Mode::Off.as_str());
        return None;
    }
    let cache_key = format!("{id}{sep}{ts}");
    let hash = content_hash(&[id_name, defaults::text("jev.question_version"), &cache_key]);
    crate::discard::harmless(lane.log.append(&lane.row(ctx, id_name, &hash, label, mode))); // keep: a decision row that cannot be written never changes the label
    remember(mode.as_str());
    (mode == Mode::On).then_some(label)
}

// ---- the child's token burn -------------------------------------------------------------------------------------------------

/// The result of one incremental read of a child's transcript.
#[derive(Debug, Clone, PartialEq)]
struct Usage {
    /// Weighted tokens since the progress mark.
    since_step: f64,
    /// The mark the count restarted at.
    mark_ts: Option<f64>,
    /// The period the mark's move closed: `(tokens, from, to)`.
    closed: Option<(f64, f64, f64)>,
}

fn usage_path(home: &Path, key: &str) -> PathBuf {
    devswarm_root(home).join(defaults::text("devswarm_sup.tl_usage_dir")).join(format!("{key}{}", defaults::text("mesh_write.json_suffix")))
}

/// The weighted tokens of one `message.usage`: input + output + cache creation + `w` x cache read, each only when a positive finite number.
fn weigh(u: &serde_json::Map<String, Value>, w: f64) -> f64 {
    let n = |k: &str| u.get(k).and_then(Value::as_f64).filter(|x| x.is_finite() && *x > 0.0).unwrap_or(0.0);
    n("input_tokens") + n("output_tokens") + n("cache_creation_input_tokens") + w * n("cache_read_input_tokens")
}

pub(super) fn transcript_of(home: &Path, wt: &str, session: &str) -> Option<PathBuf> {
    if session.is_empty() || !session.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') || wt.is_empty() {
        return None;
    }
    super::liveness::transcript_path(home, wt, session)
}

/// `tokenUsage.update(home, key, d, markTs, { cacheReadWeight })`: read the transcript from where the last pass stopped (whole lines
/// only, at most `devswarm_sup.tl_usage_read_max` bytes), count each assistant message once by its id, restart the count when the
/// plan's progress mark moves.
fn usage_update(home: &Path, key: &str, wt: &str, session: &str, mark_ts: Option<f64>, weight: f64, now: i64) -> Option<Usage> {
    if !super::liveness::safe_key(key) {
        return None;
    }
    let path = usage_path(home, key);
    let prev = read_obj(&path);
    let field = |k: &str| prev.as_ref().and_then(|p| p.get(k));
    let num = |k: &str| match field(k) {
        Some(OVal::Num(x)) if x.is_finite() => *x,
        _ => 0.0,
    };
    let mut file: Option<String> = match field("file") {
        Some(OVal::Str(f)) => Some(f.clone()),
        _ => None,
    };
    let (mut offset, mut total, mut since) = (num("offset"), num("total"), num("sinceStep"));
    let mut mark: Option<f64> = match field("markTs") {
        Some(OVal::Num(x)) if x.is_finite() => Some(*x),
        _ => None,
    };
    let mut seen: Vec<String> = match field("seen") {
        Some(OVal::Arr(a)) => a.iter().filter_map(|v| if let OVal::Str(s) = v { Some(s.clone()) } else { None }).collect(),
        _ => Vec::new(),
    };
    let mut closed = None;
    if let Some(m) = mark_ts.filter(|m| m.is_finite())
        && mark != Some(m)
    {
        if let Some(old) = mark {
            closed = Some((since.round(), old, m));
        }
        mark = Some(m);
        since = 0.0;
    }
    if let Some(tp) = transcript_of(home, wt, session) {
        let tps = tp.to_string_lossy().into_owned();
        if file.as_deref() != Some(tps.as_str()) {
            file = Some(tps);
            offset = 0.0;
            seen.clear();
        }
        // no transcript yet: the totals stay as they are
        if let Ok(mut f) = std::fs::File::open(&tp)
            && let Ok(size) = f.metadata().map(|m| m.len())
        {
            if (size as f64) < offset {
                offset = 0.0; // truncated or replaced
                seen.clear();
            }
            let len = (size - offset as u64).min(defaults::num("devswarm_sup.tl_usage_read_max"));
            if len > 0 && f.seek(SeekFrom::Start(offset as u64)).is_ok() {
                let mut buf = vec![0u8; len as usize];
                if f.read_exact(&mut buf).is_ok()
                    && let Some(last_nl) = buf.iter().rposition(|b| *b == b'\n')
                {
                    offset += (last_nl + 1) as f64;
                    let keep = defaults::num("devswarm_sup.tl_usage_seen_keep") as usize;
                    for line in String::from_utf8_lossy(&buf[..last_nl]).split('\n') {
                        if !line.contains(defaults::text("devswarm_sup.tl_usage_marker")) {
                            continue;
                        }
                        let Ok(j) = serde_json::from_str::<Value>(line) else { continue };
                        if j.get("type").and_then(Value::as_str) != Some(defaults::text("devswarm_sup.tl_assistant")) {
                            continue;
                        }
                        let Some(m) = j.get("message").filter(|m| m.is_object()) else { continue };
                        let Some(usage) = m.get("usage").and_then(Value::as_object) else { continue };
                        if let Some(mid) = m.get("id").and_then(Value::as_str) {
                            if seen.iter().any(|s| s == mid) {
                                continue;
                            }
                            seen.push(mid.to_string());
                            if seen.len() > keep {
                                seen.remove(0);
                            }
                        }
                        let t = weigh(usage, weight);
                        total += t;
                        let ts = j.get("timestamp").and_then(Value::as_str).map(crate::checks::jsport::date::parse);
                        let ts = match ts {
                            Some(crate::checks::jsport::date::Parsed::Ms(x)) if x.is_finite() => Some(x),
                            _ => None,
                        };
                        if mark.is_none() || ts.is_none() || ts >= mark {
                            since += t;
                        }
                    }
                }
            }
        }
    }
    let state = OVal::Obj(vec![
        ("v".into(), OVal::Num(1.0)),
        ("file".into(), file.map_or(OVal::Null, OVal::Str)),
        ("offset".into(), OVal::Num(offset)),
        ("total".into(), OVal::Num(total)),
        ("sinceStep".into(), OVal::Num(since)),
        ("markTs".into(), mark.map_or(OVal::Null, OVal::Num)),
        ("seen".into(), OVal::Arr(seen.into_iter().map(OVal::Str).collect())),
        ("updated_at".into(), OVal::Num(now as f64)),
    ]);
    write_json(&path, &state);
    Some(Usage { since_step: since.round(), mark_ts: mark, closed })
}

/// `tokenUsage.fmt(n)`: `1.8M`, `420k` or `900`.
fn fmt_tokens(v: f64) -> String {
    if v >= 1e6 {
        format!("{}M", to_js_string((v / 1e5).round() / 10.0))
    } else if v >= 1e3 {
        format!("{}k", to_js_string((v / 1e3).round()))
    } else {
        to_js_string(v.round())
    }
}

// ---- the straying signals ---------------------------------------------------------------------------------------------------

/// One straying signal of one episode.
#[derive(Debug, Clone)]
struct Signal {
    signal: &'static str,
    step: Value,
    key: String,
    reason: String,
    files: Option<Vec<String>>,
    /// The Jev recommendations on it (`jevnotes`).
    jev: Vec<super::jevnotes::Note>,
}

/// `planLib.currentStep(plan)`: the open step that is being worked on (newest first), else the first open one.
pub(super) fn current_step(plan: &Value) -> Option<&Value> {
    let steps = plan.get("steps")?.as_array()?;
    if steps.is_empty() {
        return None;
    }
    let done = defaults::text("devswarm_sup.tl_step_done");
    let open: Vec<&Value> = steps.iter().filter(|s| s.get("status").and_then(Value::as_str) != Some(done)).collect();
    let mut best: Option<&Value> = None;
    for s in &open {
        if !matches!(s.get("status").and_then(Value::as_str), Some("doing" | "blocked")) {
            continue;
        }
        if best.is_none_or(|b| finite(s.get("ts")).unwrap_or(0.0) >= finite(b.get("ts")).unwrap_or(0.0)) {
            best = Some(s);
        }
    }
    best.or_else(|| open.first().copied())
}

/// The off-scope files of a child's commits (`offScopeFiles`): the read-only `ready-check` over the plan's scope globs; `None` when
/// the plan has no scope or the check cannot say.
fn off_scope_files(ctx: &Ctx, runner: &dyn Runner, plan: &Value, wt: &str) -> Option<Vec<String>> {
    let globs: Vec<&str> = plan.get("scope_globs")?.as_array()?.iter().filter_map(Value::as_str).collect();
    if globs.is_empty() || wt.is_empty() {
        return None;
    }
    let mut allow: Vec<String> = globs.iter().map(|g| (*g).to_string()).collect();
    for e in plan.get("extras").and_then(Value::as_array).into_iter().flatten() {
        allow.push(e.get("glob").map_or_else(|| "undefined".to_string(), |g| g.as_str().map_or_else(|| g.to_string(), str::to_string)));
    }
    let base = plan.get("base").and_then(Value::as_str).filter(|b| !b.is_empty()).unwrap_or(defaults::text("devswarm_sup.tl_default_base"));
    let allow = allow.join(",");
    let argv: Vec<String> = defaults::list("devswarm_sup.tl_ready_args").iter().map(|a| a.replace("{base}", base).replace("{allow}", &allow)).collect();
    let args = crate::meshw::args::parse(&argv);
    let answer = crate::meshw::gitverbs::ready_check_with(&inv_of(ctx, wt), &args, runner).ok()?;
    let r: Value = serde_json::from_str(answer.stdout.trim()).ok()?;
    if r.get("ok") == Some(&json!(false))
        || r.get("reasons").and_then(Value::as_array).is_some_and(|rs| rs.iter().any(|x| x.as_str() == Some(defaults::text("devswarm_sup.tl_diff_unknown"))))
    {
        return None;
    }
    Some(r.get("outside_allowed").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default())
}

/// What the straying evaluation of one child needs besides the plan.
struct Child<'a> {
    wt: &'a str,
    status: &'a str,
    stale_since: Option<f64>,
    dormant: bool,
}

/// `deterministicSignals(plan, verdict, ctx)`.
fn signals_of(ctx: &Ctx, runner: &dyn Runner, plan: &Value, c: &Child, usage: Option<&Usage>, stall_ms: f64, burn_warn: f64) -> Vec<Signal> {
    let Some(cur) = current_step(plan) else { return Vec::new() };
    let now = ctx.now as f64;
    let n = cur.get("n").cloned().unwrap_or(Value::Null);
    let ns = match &n {
        Value::Number(x) => to_js_string(x.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        _ => "undefined".to_string(),
    };
    let mut out = Vec::new();
    let awaiting = finite(plan.get("done_reported_at")).is_some() || c.dormant;
    let last_progress = finite(plan.get("step_ts"))
        .or_else(|| finite(plan.get("created_at")))
        .unwrap_or(now)
        .max(finite(plan.get("activity_ts")).unwrap_or(0.0))
        .max(finite(plan.get("warned_at")).unwrap_or(0.0));
    let (stale, nudged, escalated, alive) = (
        defaults::text("devswarm_sup.lv_status_stale"),
        defaults::text("devswarm_sup.tl_status_nudged"),
        defaults::text("devswarm_sup.tl_status_escalated"),
        defaults::text("devswarm_sup.lv_status_alive"),
    );
    if awaiting {
        // a done child awaits its parent, a dormant one is surfaced by the roster: no liveness or progress signals
    } else if c.status == stale || c.status == nudged || c.status == escalated {
        let since = c.stale_since.unwrap_or(last_progress);
        out.push(Signal {
            signal: "idle",
            step: n.clone(),
            key: format!("idle:{ns}:{}", to_js_string(since)),
            reason: format!("{}{}", defaults::text("devswarm_sup.tl_reason_idle"), crate::meshw::plan::dur(now - since)),
            files: None,
            jev: Vec::new(),
        });
    } else if c.status == alive && now - last_progress >= stall_ms {
        out.push(Signal {
            signal: "stall",
            step: n.clone(),
            key: format!("stall:{ns}:{}", to_js_string(last_progress)),
            reason: format!("{}{}", defaults::text("devswarm_sup.tl_reason_stall"), crate::meshw::plan::dur(now - last_progress)),
            files: None,
            jev: Vec::new(),
        });
    }
    if let Some(u) = usage.filter(|u| !awaiting && burn_warn > 0.0 && u.since_step >= burn_warn) {
        out.push(Signal {
            signal: "burn",
            step: n.clone(),
            key: format!("burn:{ns}:{}", u.mark_ts.map_or_else(|| "undefined".to_string(), to_js_string)),
            reason: defaults::render("devswarm_sup.tl_reason_burn", &[("used", &fmt_tokens(u.since_step)), ("step", &ns)]),
            files: None,
            jev: Vec::new(),
        });
    }
    if let Some(mut files) = off_scope_files(ctx, runner, plan, c.wt).filter(|f| !f.is_empty()) {
        files.sort();
        let shown = defaults::num("devswarm_sup.tl_files_shown") as usize;
        let more = if files.len() > shown { defaults::render("devswarm_sup.tl_reason_more", &[("n", &(files.len() - shown))]) } else { String::new() };
        let digest = content_digest(&files.join("\n"));
        out.push(Signal {
            signal: "off-scope",
            step: n,
            key: format!("off-scope:{ns}:{digest}"),
            reason: format!("{}{}{more}", defaults::text("devswarm_sup.tl_reason_off_scope"), files.iter().take(shown).cloned().collect::<Vec<_>>().join(", ")),
            files: Some(files.into_iter().take(defaults::num("devswarm_sup.tl_files_kept") as usize).collect()),
            jev: Vec::new(),
        });
    }
    out
}

/// `shortHash(s)`: the first ten hex digits of the SHA-1.
fn content_digest(s: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, s.as_bytes());
    d.as_ref().iter().map(|b| format!("{b:02x}")).collect::<String>().chars().take(defaults::num("devswarm_sup.tl_digest_len") as usize).collect()
}

fn stray_path(home: &Path, key: &str) -> PathBuf {
    devswarm_root(home).join(defaults::text("devswarm_sup.tl_stray_dir")).join(format!("{key}{}", defaults::text("mesh_write.json_suffix")))
}

fn obj_or_empty(v: Option<&OVal>) -> OVal {
    match v {
        Some(o @ OVal::Obj(_)) => o.clone(),
        _ => OVal::Obj(Vec::new()),
    }
}

/// The supervision log, rotated first when it is over its limit, then appended to.
pub(super) fn log_event(ctx: &Ctx, typ: &str, fields: Vec<(&str, OVal)>) {
    super::suplog::rotate_if_needed(ctx.home);
    let f: Vec<(String, OVal)> = fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    crate::meshw::plan::record(&inv_of(ctx, ""), typ, &f, ctx.now as f64);
}

/// One pass's settings and bookkeeping.
struct Pass<'a> {
    ctx: &'a Ctx<'a>,
    runner: &'a dyn Runner,
    plan_tracking: bool,
    warn_max: i64,
    stall_ms: f64,
    burn_warn: f64,
    weight: f64,
    /// The Jev settings of the pass (the modes of the off-scope questions).
    jev: &'a JevSettings,
}

impl Pass<'_> {
    /// `rowLivenessState(row, home, { now, lastOutboundTs }) === 'dormant'`: silent past the window and no live session.
    fn dormant(&self, d: &Desc, wt: &str, session: &str, last_out: Option<f64>) -> bool {
        let home = self.ctx.home;
        let mut best = super::liveness::heartbeat_ts(home, &d.id).filter(|t| t.is_finite()).unwrap_or(0.0).max(0.0);
        let mut saw = false;
        if !session.is_empty()
            && let Ok(Some(t)) = super::liveness::transcript_mtime(home, wt, session)
            && t.is_finite()
        {
            saw = true;
            best = best.max(t);
        }
        if let Some(t) = last_out.filter(|t| t.is_finite()) {
            best = best.max(t);
        }
        if best == 0.0 {
            best = super::liveness::registration_ts(home, &d.id).filter(|t| *t > 0.0).unwrap_or(0.0);
        }
        let now = self.ctx.now as f64;
        if best <= 0.0 || now - best < 0.0 {
            return false;
        }
        let threshold = if saw {
            let v = gset::get_number(self.ctx.st, defaults::raw("devswarm_sup.tl_set_dormant_ms"));
            if v.is_finite() && v > 0.0 { v } else { defaults::num("devswarm_sup.tl_dormant_default_ms") as f64 }
        } else {
            let raw =
                self.ctx.st.env.get(defaults::text("devswarm_sup.tl_env_idle_ms")).map(|v| crate::checks::guardkit::text::js_number_of_str(v)).unwrap_or(0.0);
            if raw.is_finite() && raw > 0.0 { raw } else { defaults::num("devswarm_sup.tl_idle_default_ms") as f64 }
        };
        if now - best < threshold {
            return false;
        }
        !(!session.is_empty() && super::liveness::session_alive(home, session).unwrap_or(false))
    }

    /// `superviseStraying(d, verdict, opts)`: `(signals, issued)` of a child with a step plan, `None` otherwise.
    fn straying(&mut self, d: &Desc, verdict: &OVal) -> Option<(Vec<&'static str>, Vec<&'static str>)> {
        let ctx = self.ctx;
        let wt = match d.raw.get(defaults::text("mesh_write.field_worktree_path")) {
            Some(OVal::Str(w)) if !w.is_empty() => w.as_str(),
            _ => "",
        };
        let session = match d.raw.get(defaults::text("mesh_write.field_session_id")) {
            Some(OVal::Str(s)) => s.as_str(),
            _ => "",
        };
        if !wt.is_empty() && crate::meshw::ident::primary_workspace_id(wt).ok().as_deref() == Some(d.id.as_str()) {
            return None; // the Primary's own row is no child
        }
        if !self.plan_tracking {
            return None;
        }
        let inv = inv_of(ctx, wt);
        let found = crate::meshw::plan::find_for(&inv, &d.id, (!wt.is_empty()).then_some(wt)).ok().flatten()?;
        let plan: Value = serde_json::from_str(&found.plan.stringify()).ok()?;
        if plan.get("steps").and_then(Value::as_array).is_none_or(Vec::is_empty) {
            return None;
        }
        let key = found.key.as_str();
        let status = match verdict.get(defaults::list("devswarm_sup.lv_keys")[0]) {
            Some(OVal::Str(s)) => s.as_str(),
            _ => "",
        };
        let num_of = |i: usize| match verdict.get(defaults::list("devswarm_sup.lv_keys")[i]) {
            Some(OVal::Num(x)) if x.is_finite() => Some(*x),
            _ => None,
        };
        let (stale_since, last_out) = (num_of(2), num_of(1));
        let mark = finite(plan.get("step_ts")).or_else(|| finite(plan.get("created_at")));
        let usage = usage_update(ctx.home, key, wt, session, mark, self.weight, ctx.now);
        if let Some((tokens, _, _)) = usage.as_ref().and_then(|u| u.closed).filter(|(t, _, _)| *t > 0.0) {
            let done = plan["steps"]
                .as_array()
                .map_or(0, |s| s.iter().filter(|x| x.get("status").and_then(Value::as_str) == Some(defaults::text("devswarm_sup.tl_step_done"))).count());
            log_event(
                ctx,
                defaults::text("devswarm_sup.tl_ev_tokens"),
                vec![
                    ("id", OVal::Str(d.id.clone())),
                    ("key", OVal::Str(key.to_string())),
                    ("tokens", OVal::Num(tokens)),
                    ("stepsDone", OVal::Num(done as f64)),
                ],
            );
        }
        let dormant = self.dormant(d, wt, session, last_out);
        let child = Child { wt, status, stale_since, dormant };
        let mut signals = signals_of(ctx, self.runner, &plan, &child, usage.as_ref(), self.stall_ms, self.burn_warn);
        if let Some(off) = signals.iter_mut().find(|s| s.signal == "off-scope") {
            let files = off.files.clone().unwrap_or_default();
            off.jev = super::jevnotes::adjust(
                ctx,
                self.runner,
                self.jev,
                &super::jevnotes::Off { id: &d.id, key, plan: &plan, wt, session, files: &files, signal_key: &off.key },
            );
        }
        // the state: what was warned before, bounded, and what is active now
        let prev = read_obj(&stray_path(ctx.home, key));
        let now = ctx.now as f64;
        let mut warned = obj_or_empty(prev.as_ref().and_then(|p| p.get("warned")));
        let mut per_step = obj_or_empty(prev.as_ref().and_then(|p| p.get("perStep")));
        let mut active: Vec<OVal> = Vec::new();
        let mut issued: Vec<(&'static str, Value, bool)> = Vec::new();
        for s in &signals {
            let step_text = match &s.step {
                Value::Number(x) => to_js_string(x.as_f64().unwrap_or(f64::NAN)),
                Value::String(t) => t.clone(),
                _ => "undefined".to_string(),
            };
            let mut w = warned.get(&s.key).cloned().filter(|w| w.truthy());
            if w.is_none() && self.warn_max > 0 {
                let cap_key = format!("{}:{step_text}", s.signal);
                let n = match per_step.get(&cap_key) {
                    Some(OVal::Num(x)) if x.is_finite() => *x,
                    _ => 0.0,
                };
                if n < self.warn_max as f64 {
                    let rec = OVal::Obj(vec![
                        ("at".into(), OVal::Num(now)),
                        ("n".into(), OVal::Num(n + 1.0)),
                        ("signal".into(), OVal::Str(s.signal.to_string())),
                        ("step".into(), json_to_oval(&s.step)),
                    ]);
                    warned.set(&s.key, rec.clone());
                    per_step.set(&cap_key, OVal::Num(n + 1.0));
                    issued.push((s.signal, s.step.clone(), n > 0.0));
                    w = Some(rec);
                }
            }
            if let Some(w) = w {
                let mut e = vec![
                    ("key".to_string(), OVal::Str(s.key.clone())),
                    ("signal".to_string(), OVal::Str(s.signal.to_string())),
                    ("step".to_string(), json_to_oval(&s.step)),
                    ("reason".to_string(), OVal::Str(s.reason.clone())),
                ];
                if let Some(f) = &s.files {
                    e.push(("files".to_string(), OVal::Arr(f.iter().cloned().map(OVal::Str).collect())));
                }
                e.push(("at".to_string(), w.get("at").cloned().unwrap_or(OVal::Null)));
                e.push(("n".to_string(), w.get("n").cloned().unwrap_or(OVal::Null)));
                if !s.jev.is_empty() {
                    e.push(("jev".to_string(), OVal::Arr(s.jev.iter().map(super::jevnotes::Note::to_oval).collect())));
                }
                active.push(OVal::Obj(e));
            }
        }
        // the warned map stays bounded: the oldest are dropped first
        if let OVal::Obj(entries) = &mut warned {
            let cap = defaults::num("devswarm_sup.tl_warned_keep") as usize;
            if entries.len() > cap {
                let at = |v: &OVal| match v.get("at") {
                    Some(OVal::Num(x)) => *x,
                    _ => 0.0,
                };
                let mut order: Vec<(f64, String)> = entries.iter().map(|(k, v)| (at(v), k.clone())).collect();
                order.sort_by(|a, b| a.0.total_cmp(&b.0));
                let drop: Vec<String> = order.into_iter().take(entries.len() - cap).map(|(_, k)| k).collect();
                entries.retain(|(k, _)| !drop.contains(k));
            }
        }
        let wt_field = if !wt.is_empty() {
            OVal::Str(wt.to_string())
        } else {
            plan.get("worktreePath").and_then(Value::as_str).map_or(OVal::Null, |w| OVal::Str(w.to_string()))
        };
        let state = OVal::Obj(vec![
            ("v".into(), OVal::Num(1.0)),
            ("key".into(), OVal::Str(key.to_string())),
            ("id".into(), OVal::Str(d.id.clone())),
            ("worktreePath".into(), wt_field),
            ("warned".into(), warned),
            ("perStep".into(), per_step),
            ("active".into(), OVal::Arr(active)),
            ("updated_at".into(), OVal::Num(now)),
        ]);
        write_json(&stray_path(ctx.home, key), &state);
        for (signal, step, repeat) in &issued {
            log_event(
                ctx,
                defaults::text("devswarm_sup.tl_ev_warn"),
                vec![
                    ("id", OVal::Str(d.id.clone())),
                    ("key", OVal::Str(key.to_string())),
                    ("signal", OVal::Str((*signal).to_string())),
                    ("step", json_to_oval(step)),
                    ("repeat", OVal::Bool(*repeat)),
                ],
            );
            // a stable alert kind: the child id rides in the details, never in the kind
            crate::dssup::recon::sweep::log_line(
                ctx,
                defaults::text("devswarm_sup.tl_alert_component"),
                defaults::text("devswarm_sup.tl_alert_op"),
                defaults::text("devswarm_sup.tl_alert_level"),
                defaults::text("devswarm_sup.tl_alert_msg"),
                &json!({"kind": defaults::text("devswarm_sup.tl_alert_kind"), "details": {"id": d.id, "signal": signal, "step": step, "reason": signals.iter().find(|s| s.signal == *signal).map(|s| s.reason.clone())}}),
            );
        }
        let names = |list: Vec<&'static str>| list;
        Some((names(signals.iter().map(|s| s.signal).collect()), names(issued.iter().map(|(s, _, _)| *s).collect())))
    }
}

fn json_to_oval(v: &Value) -> OVal {
    match v {
        Value::Number(x) => OVal::Num(x.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => OVal::Str(s.clone()),
        Value::Bool(b) => OVal::Bool(*b),
        _ => OVal::Null,
    }
}

/// The tail of one pass over the workspaces whose verdict was written: the blocker label and the straying signals of each. The
/// record counts and names what was attached or warned.
pub fn run(ctx: &Ctx, runner: &dyn Runner, items: &[(Desc, OVal)]) -> Value {
    let lane = JevLane::load(ctx);
    let mut pass = Pass {
        ctx,
        runner,
        plan_tracking: gset::get_bool(ctx.st, defaults::raw("devswarm_sup.tl_set_plan_tracking")),
        warn_max: gset::get_number(ctx.st, defaults::raw("sweep.setting_warn_max")) as i64,
        stall_ms: gset::get_number(ctx.st, defaults::raw("sweep.setting_step_stall"))
            .max(defaults::raw("sweep.setting_step_stall").get("floor_min").and_then(defaults::V::as_integer).unwrap_or(1) as f64)
            * defaults::num("devswarm_sup.tl_ms_per_minute") as f64,
        burn_warn: gset::get_number(ctx.st, defaults::raw("devswarm_sup.tl_set_burn_warn")),
        weight: gset::get_number(ctx.st, defaults::raw("devswarm_sup.tl_set_burn_cache_pct")) / 100.0,
        jev: &lane.settings,
    };
    let (mut labels, mut straying) = (Vec::new(), Vec::new());
    for (d, verdict) in items {
        if let Some(label) = blocker_label(ctx, &lane, &d.id) {
            labels.push(json!({"id": d.id, "label": label}));
        }
        if let Some((signals, issued)) = pass.straying(d, verdict) {
            straying.push(json!({"id": d.id, "signals": signals, "issued": issued}));
        }
    }
    json!({"workspaces": items.len(), "blockerLabels": labels, "straying": straying})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::git::util::Settings;
    use crate::dsact::runner::{RunResult, RunSpec};

    /// A runner whose every call fails (nothing here may need git or hivecontrol).
    struct Nothing;
    impl Runner for Nothing {
        fn run(&self, _spec: &RunSpec) -> RunResult {
            RunResult { ok: false, missing: true, ..RunResult::default() }
        }
    }

    const NOW: i64 = 1_760_000_000_000;

    struct Fix {
        _dir: crate::db::TempDir,
        home: PathBuf,
        st: Settings,
        repo: String,
    }

    fn fix(tag: &str) -> Fix {
        crate::defaults::init().unwrap();
        let dir = crate::db::TempDir::new(tag);
        let home = dir.0.join("home");
        let repo = dir.0.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&repo).status().unwrap().success());
        let repo = std::fs::canonicalize(&repo).unwrap().to_string_lossy().into_owned();
        let mut env = std::collections::HashMap::new();
        env.insert("HOME".to_string(), home.to_string_lossy().into_owned());
        env.insert("ANTIHALL_JEV".to_string(), "1".to_string());
        let st = Settings { home: home.to_string_lossy().into_owned(), env };
        Fix { _dir: dir, home, st, repo }
    }

    impl Fix {
        fn ctx(&self, now: i64) -> Ctx<'_> {
            Ctx { home: &self.home, root: &self.home, st: &self.st, now, engine_pokes: true }
        }
        fn put(&self, rel: &str, text: &str) {
            let p = self.home.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        fn desc(&self, id: &str) -> Desc {
            Desc { id: id.to_string(), raw: OVal::parse(&json!({"id": id, "worktreePath": self.repo, "sessionId": "sess-1"}).to_string()).unwrap() }
        }
        fn read(&self, rel: &str) -> Option<String> {
            std::fs::read_to_string(self.home.join(rel)).ok()
        }
    }

    fn verdict(status: &str, stale_since: Option<i64>) -> OVal {
        OVal::parse(&json!({"status": status, "lastOutboundTs": null, "staleSince": stale_since}).to_string()).unwrap()
    }

    fn pending(f: &Fix, key: &str, kind: &str, ts: i64) {
        f.put(".anti-hall/state/jev-triage-pending.json", &json!({key: {"kind": kind, "ts": ts}}).to_string());
    }

    #[test]
    fn dssup_tail_blocker_label_shadow_logs_once_and_shows_nothing() {
        let f = fix("tail-blocker-shadow");
        pending(&f, "msg\u{1}w1", "blocker", 111);
        let ctx = f.ctx(NOW);
        let lane = JevLane::load(&ctx);
        // shadow (the shipped default): the decision is logged and remembered, the label is not shown
        assert_eq!(blocker_label(&ctx, &lane, "w1"), None);
        let log = f.read(".anti-hall/logs/jev-assist.ndjson").expect("a decision row");
        let row: Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
        assert_eq!((row["id"].as_str(), row["jev"].as_str(), row["mode"].as_str()), (Some("supervisorBlockerLabel"), Some("wedged"), Some("shadow")));
        assert_eq!((row["derivedFrom"].as_str(), row["backend"].as_str(), row["cached"].as_bool()), (Some("triage"), Some("cache"), Some(true)));
        assert_eq!(row["wouldChange"], "changed");
        assert!(row.get("changed").is_some_and(Value::is_null));
        // the same input within the re-ask window is neither asked nor logged again
        assert_eq!(blocker_label(&f.ctx(NOW + 1000), &lane, "w1"), None);
        assert_eq!(f.read(".anti-hall/logs/jev-assist.ndjson").unwrap().lines().count(), 1);
        // no pending entry: no label, no row
        assert_eq!(blocker_label(&ctx, &lane, "other"), None);
    }

    #[test]
    fn dssup_tail_blocker_label_on_shows_the_label_and_keeps_it_while_deduped() {
        let f = fix("tail-blocker-on");
        f.put(".anti-hall/settings.json", &json!({"jevIntegrations": {"supervisorBlockerLabel": "on"}}).to_string());
        pending(&f, "msg\u{1}w2", "question-needs-answer", 222);
        let ctx = f.ctx(NOW);
        let lane = JevLane::load(&ctx);
        assert_eq!(blocker_label(&ctx, &lane, "w2"), Some("waiting-on-parent"));
        let row: Value = serde_json::from_str(f.read(".anti-hall/logs/jev-assist.ndjson").unwrap().lines().next().unwrap()).unwrap();
        assert_eq!((row["mode"].as_str(), row["final"].as_bool(), row["changed"].as_str()), (Some("on"), Some(true), Some("changed")));
        assert!(row.get("wouldChange").is_none());
        // a deduped pass still reports the label the last ask decided
        assert_eq!(blocker_label(&f.ctx(NOW + 5000), &lane, "w2"), Some("waiting-on-parent"));
        assert_eq!(f.read(".anti-hall/logs/jev-assist.ndjson").unwrap().lines().count(), 1);
        // a new input (the child asked again) is a new decision
        pending(&f, "msg\u{1}w2", "blocker", 333);
        assert_eq!(blocker_label(&f.ctx(NOW + 6000), &lane, "w2"), Some("wedged"));
        assert_eq!(f.read(".anti-hall/logs/jev-assist.ndjson").unwrap().lines().count(), 2);
    }

    #[test]
    fn dssup_tail_token_usage_counts_each_message_once_from_where_it_stopped() {
        let f = fix("tail-usage");
        let tp = transcript_of(&f.home, &f.repo, "sess-1").unwrap();
        std::fs::create_dir_all(tp.parent().unwrap()).unwrap();
        let line = |id: &str, ts: &str, i: u64, o: u64, cr: u64| {
            json!({"type": "assistant", "timestamp": ts, "message": {"id": id, "usage": {"input_tokens": i, "output_tokens": o, "cache_read_input_tokens": cr}}}).to_string()
        };
        // m1 is written twice (one entry per content block), m2 before the mark; a trailing line without a newline is not read yet
        let body = format!(
            "{}\n{}\n{}\n{}\n{}",
            line("m1", "2025-10-09T08:00:10.000Z", 100, 50, 1000),
            line("m1", "2025-10-09T08:00:10.000Z", 100, 50, 1000),
            line("m2", "2025-10-09T07:00:00.000Z", 7, 3, 0),
            "not json at all with \"usage\"",
            line("m3", "2025-10-09T08:00:20.000Z", 1, 1, 0)
        );
        std::fs::write(&tp, body).unwrap();
        // the mark is 08:00:00 UTC: m2 is before it (counted in the total only)
        let mark = 1_759_996_800_000.0_f64; // 2025-10-09T08:00:00Z
        let u = usage_update(&f.home, "plan1", &f.repo, "sess-1", Some(mark), 0.1, NOW).unwrap();
        assert_eq!(u.since_step, 250.0); // 100 + 50 + 0.1 * 1000
        assert_eq!(u.mark_ts, Some(mark));
        assert!(u.closed.is_none());
        // the unfinished line is picked up once it is complete, and counted once
        let mut more = std::fs::read_to_string(&tp).unwrap();
        more.push('\n');
        std::fs::write(&tp, more).unwrap();
        let u = usage_update(&f.home, "plan1", &f.repo, "sess-1", Some(mark), 0.1, NOW + 1).unwrap();
        assert_eq!(u.since_step, 252.0);
        // a moved mark closes the period and restarts the count
        let u = usage_update(&f.home, "plan1", &f.repo, "sess-1", Some(mark + 5000.0), 0.1, NOW + 2).unwrap();
        assert_eq!(u.closed, Some((252.0, mark, mark + 5000.0)));
        assert_eq!(u.since_step, 0.0);
    }

    #[test]
    fn dssup_tail_straying_warns_once_per_episode_and_keeps_the_state() {
        let f = fix("tail-stray");
        let two_hours = 2 * 3600 * 1000;
        f.put(
            ".anti-hall/devswarm/plans/w1.json",
            &json!({"id": "w1", "created_at": NOW - 3 * 3600 * 1000, "step_ts": NOW - two_hours, "steps": [{"n": 1, "text": "first", "status": "doing", "ts": NOW - two_hours}]}).to_string(),
        );
        let ctx = f.ctx(NOW);
        let lane = JevLane::load(&ctx);
        let mut pass = Pass {
            ctx: &ctx,
            runner: &Nothing,
            plan_tracking: true,
            warn_max: 2,
            stall_ms: 30.0 * 60_000.0,
            burn_warn: 2_000_000.0,
            weight: 0.1,
            jev: &lane.settings,
        };
        let d = f.desc("w1");
        let (signals, issued) = pass.straying(&d, &verdict("alive", None)).expect("a child with a plan");
        assert_eq!((signals.as_slice(), issued.as_slice()), (&["stall"][..], &["stall"][..]));
        let state: Value = serde_json::from_str(&f.read(".anti-hall/devswarm/stray/w1.json").unwrap()).unwrap();
        assert_eq!(state["active"][0]["signal"], "stall");
        assert_eq!(state["active"][0]["reason"], "no step progress 2h");
        assert_eq!(state["perStep"]["stall:1"], 1);
        // the same episode is not warned again, but stays active
        let (signals, issued) = pass.straying(&d, &verdict("alive", None)).unwrap();
        assert_eq!((signals.len(), issued.len()), (1, 0));
        let state: Value = serde_json::from_str(&f.read(".anti-hall/devswarm/stray/w1.json").unwrap()).unwrap();
        assert_eq!(state["active"].as_array().unwrap().len(), 1);
        assert_eq!(state["perStep"]["stall:1"], 1);
        // the warning is on the supervision log, once, with a stable alert kind
        let log = f.read(".anti-hall/logs/devswarm-supervision.ndjson").unwrap();
        assert_eq!(log.lines().filter(|l| l.contains("\"warn\"")).count(), 1);
        // an idle verdict is a new episode of another signal
        let (signals, issued) = pass.straying(&d, &verdict("stale", Some(NOW - 3600 * 1000))).unwrap();
        assert_eq!((signals.as_slice(), issued.as_slice()), (&["idle"][..], &["idle"][..]));
        // the Primary's own row and a workspace with no plan have no straying state
        assert!(pass.straying(&f.desc("nope"), &verdict("alive", None)).is_none());
        // plan tracking off: nothing is evaluated
        pass.plan_tracking = false;
        assert!(pass.straying(&d, &verdict("alive", None)).is_none());
    }
}
