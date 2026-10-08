//! Is dispatchable work sitting idle? The port of `lib/dispatch-demand.js` `evaluate` as task-guard asks it (per-task cover
//! from this session's running agents, the parallel cap, the proven count), the legacy machine-wide agent heartbeat
//! (`agentsRunning`), the task labels of the idle-neglect block and its metrics counter (`recordIdleNeglect`).
use crate::checks::agent_scan::{self, Row};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::jsval::{Js, quote};
use crate::checks::guardkit::settings::get_number;
use crate::checks::guardkit::text::{collapse_ws, js_trim, js_trim_end, slice_utf16};
use crate::checks::taskkit::jsval::{R, Unsure};
use crate::checks::taskstate::{Task, is_digits};
use crate::defaults;
use regex::Regex;
use std::collections::HashSet;
use std::path::Path;

struct Res {
    task_ref: Regex,
    in_progress: Regex,
    control: Regex,
    prio_prefix: Regex,
}

fn res() -> &'static Res {
    static R: crate::defaults::Cache<Res> = crate::defaults::Cache::new();
    R.get_or_init(|| Res {
        task_ref: jsre::compile(defaults::text("task_guard.task_ref_re"), false),
        in_progress: jsre::compile(defaults::text("task_guard.in_progress_re"), true),
        control: jsre::compile(defaults::text("taskkit.control_chars"), false),
        prio_prefix: jsre::compile(defaults::text("task_guard.label_priority_prefix_re"), true),
    })
}

/// A JSON text `JSON.parse` would read the same way: `Ok(None)` when both reject it, [`Unsure`] when only JavaScript might
/// accept it.
pub fn parse_js(text: &str) -> R<Option<Js>> {
    match Js::parse(text) {
        Some(v) => Ok(Some(v)),
        None if crate::checks::guardkit::jsdiff::js_reads_differently_str(text) => Err(Unsure),
        None => Ok(None),
    }
}

/// `agentsRunning()`: some `~/.anti-hall/agents/*.json` heartbeat (its `ts`, else the file time) is fresh.
pub fn agents_running(st: &Settings) -> R<bool> {
    let dir = Path::new(&st.home).join(defaults::text("paths.base_dir")).join(defaults::text("task_guard.agents_dir"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(false) };
    let now = agent_scan::now_ms();
    let fresh = defaults::num("task_guard.agents_fresh_ms") as f64;
    for e in rd {
        let Ok(e) = e else { return Err(Unsure) };
        let Some(name) = e.file_name().to_str().map(str::to_string) else { return Err(Unsure) };
        if !name.ends_with(defaults::text("task_guard.agents_ext")) {
            continue;
        }
        let full = dir.join(&name);
        let mut ts = 0.0;
        if let Ok(b) = std::fs::read(&full)
            && let Some(Js::Obj(o)) = parse_js(&crate::checks::guardkit::text::lossy_owned(b))?
            && let Some((_, Js::Num(n))) = o.iter().rev().find(|(k, _)| k == defaults::text("task_guard.agents_ts_key"))
        {
            ts = *n;
        }
        if ts == 0.0 {
            ts = agent_scan::mtime_ms(&full).unwrap_or(0.0);
        }
        if ts != 0.0 && !ts.is_nan() && now - ts < fresh {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `os.availableParallelism()` where the engine reads it the way libuv does: `sysconf(_SC_NPROCESSORS_ONLN)` on macOS, the
/// affinity mask on Linux (only when no CPU quota lowers Rust's answer below it, since libuv versions differ on quotas).
fn cores() -> R<f64> {
    let rust = std::thread::available_parallelism().map(|n| n.get() as f64).map_err(|_| Unsure)?;
    if cfg!(target_os = "macos") {
        return Ok(rust);
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: `set` is a zeroed cpu_set_t owned by this frame; sched_getaffinity writes at most its size.
        let affinity = unsafe {
            let mut set: libc::cpu_set_t = std::mem::zeroed();
            if libc::sched_getaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &mut set) != 0 {
                return Err(Unsure);
            }
            libc::CPU_COUNT(&set) as f64
        };
        if affinity == rust {
            return Ok(rust);
        }
    }
    Err(Unsure)
}

/// `configuredCap()`: `guards.maxParallelDispatch` when positive, else `max(1, min(16, cores - 2))`.
fn configured_cap(st: &Settings) -> R<f64> {
    let v = get_number(st, defaults::raw("task_guard.max_parallel_setting"));
    if v.is_finite() && v > 0.0 {
        return Ok(v.floor());
    }
    let c = cores()?;
    let c = if c == 0.0 { defaults::num("task_guard.cap_fallback_cores") as f64 } else { c };
    Ok((defaults::num("task_guard.cap_floor") as f64)
        .max((defaults::num("task_guard.cap_ceiling") as f64).min(c - defaults::num("task_guard.cap_reserve") as f64)))
}

/// `agentMaxAgeMs()`: `guards.idleNeglectAgentMaxAgeMin` in milliseconds.
fn agent_max_age_ms(st: &Settings) -> f64 {
    let n = get_number(st, defaults::raw("task_guard.agent_max_age_setting"));
    let n = if n.is_finite() && n >= 0.0 { n } else { defaults::num("task_guard.agent_max_age_default_min") as f64 };
    n * defaults::num("task_guard.ms_per_minute") as f64
}

/// `taskRefs(text)`: the `#N` task numbers a text names.
fn task_refs(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in res().task_ref.captures_iter(text) {
        let id = c[1].to_string();
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// A running agent's newest sign of life (`rowsOf` `lastActivityMs`): launch, resume, teammate activity or a write to its
/// output file. [`Unsure`] for a relative output file (Node resolves it against its own working directory).
fn last_activity(r: &Row) -> R<f64> {
    let rec = &r.rec;
    let mut act = f64::NAN;
    for v in [rec.launched_at_ms, rec.resumed_at_ms.unwrap_or(f64::NAN), rec.last_seen_ms] {
        if v.is_finite() && !(v <= act) {
            act = v;
        }
    }
    if !rec.output_file.is_empty() {
        if !rec.output_file.starts_with('/') {
            return Err(Unsure);
        }
        if let Some(m) = agent_scan::mtime_ms(Path::new(&rec.output_file))
            && m.is_finite()
            && !(m <= act)
        {
            act = m;
        }
    }
    Ok(act)
}

/// What `evaluate` answers.
pub struct Demand<'a> {
    /// The in_progress-first estimate says the work is uncovered.
    pub fire: bool,
    /// Uncovered under every placement of the agents that name no task (hung and pre-task agents discounted).
    pub proven: bool,
    /// The running count could not be trusted.
    pub unknown: bool,
    /// The actionable tasks no running agent names.
    pub dispatch: Vec<&'a Task>,
    /// The parallel cap (`None` on the legacy path, whose block text names the formula instead).
    pub cap: Option<f64>,
}

/// `evaluate({ actionable, knownIds, inProgressIds, running })`.
pub fn evaluate<'a>(st: &Settings, actionable: &[&'a Task], known: &[String], open: &[&Task], running: Option<Vec<Row>>) -> R<Demand<'a>> {
    let Some(running) = running else { return Ok(Demand { fire: false, proven: false, unknown: true, dispatch: Vec::new(), cap: Some(0.0) }) };
    let cap = configured_cap(st)?;
    let known: HashSet<&str> = known.iter().map(String::as_str).collect();
    let mut covered: HashSet<String> = HashSet::new();
    let mut unmapped = 0usize;
    let mut refs_of: Vec<Vec<String>> = Vec::new();
    for a in &running {
        let refs: Vec<String> = task_refs(&a.description).into_iter().filter(|id| known.contains(id.as_str())).collect();
        if refs.is_empty() {
            unmapped += 1;
        }
        covered.extend(refs.iter().cloned());
        refs_of.push(refs);
    }
    let in_progress = open.iter().filter(|t| res().in_progress.is_match(t.status.as_deref().unwrap_or(""))).filter(|t| !covered.contains(&t.id)).count();
    let on_pending = unmapped.saturating_sub(in_progress);
    let dispatch: Vec<&'a Task> = actionable.iter().copied().filter(|t| !covered.contains(&t.id)).collect();
    let fire = !dispatch.is_empty() && dispatch.len() > on_pending && (running.len() as f64) < cap;
    let now = agent_scan::now_ms();
    let max_age = agent_max_age_ms(st);
    // `sinces.every(Number.isFinite) ? Math.min(...sinces) : NaN`, read only when an agent needs it
    let earliest = || -> R<f64> {
        if dispatch.is_empty() {
            return Ok(f64::NAN);
        }
        let mut min = f64::INFINITY;
        for t in &dispatch {
            let v = t.since.value()?;
            if !v.is_finite() {
                return Ok(f64::NAN);
            }
            min = min.min(v);
        }
        Ok(min)
    };
    let mut proven_unmapped = 0usize;
    let mut uncounted = 0usize;
    for (a, refs) in running.iter().zip(&refs_of) {
        if !refs.is_empty() {
            continue;
        }
        let act = last_activity(a)?;
        let stale = max_age > 0.0 && act.is_finite() && now - act > max_age;
        let rec = &a.rec;
        let l = if rec.launched_at_ms.is_finite() { rec.launched_at_ms } else { f64::NEG_INFINITY };
        let r = rec.resumed_at_ms.filter(|v| v.is_finite()).unwrap_or(f64::NEG_INFINITY);
        let started = l.max(r);
        let before = !stale && started.is_finite() && {
            let e = earliest()?;
            e.is_finite() && started < e
        };
        if stale || before {
            uncounted += 1;
        } else {
            proven_unmapped += 1;
        }
    }
    let proven = !dispatch.is_empty() && dispatch.len() > proven_unmapped && ((running.len() - uncounted) as f64) < cap;
    Ok(Demand { fire, proven, unknown: false, dispatch, cap: Some(cap) })
}

/// `oneLine(s, max)` (also task-guard's `sanitizeSubject`): control characters become spaces, white space runs collapse,
/// the text is trimmed and cut to `max` UTF-16 units with an ellipsis. [`Unsure`] when the cut would split a surrogate pair.
pub fn one_line(s: &str, max: usize) -> R<String> {
    let spaced = res().control.replace_all(s, " ");
    let o = js_trim(&collapse_ws(&spaced)).to_string();
    if o.encode_utf16().count() > max {
        let cut = slice_utf16(&o, max).ok_or(Unsure)?;
        return Ok(format!("{}{}", js_trim_end(&cut), defaults::text("taskkit.ellipsis")));
    }
    Ok(o)
}

/// `JSON.stringify` of a string.
pub fn js_quote(s: &str) -> String {
    let mut out = String::new();
    quote(s, &mut out);
    out
}

/// `label(t)`: `#N "subject"` for a numbered task, the quoted subject otherwise.
pub fn label(t: &Task) -> R<String> {
    let id = t.id.as_str();
    let src = if !t.content.is_empty() { t.content.as_str() } else { id };
    let subj = one_line(&res().prio_prefix.replace(src, ""), defaults::num("task_guard.label_max") as usize)?;
    let quoted = js_quote(if subj.is_empty() { id } else { &subj });
    if !is_digits(id) {
        return Ok(quoted);
    }
    Ok(if !subj.is_empty() && subj != id { format!("#{id} {quoted}") } else { format!("#{id}") })
}

/// The metrics file after `recordIdleNeglect` (`None`: the file is not touched). Computed before any write, so a value only
/// JavaScript could read defers the Stop before anything changed.
pub fn idle_neglect_metrics(home: &str) -> R<(std::path::PathBuf, String)> {
    let p = Path::new(home).join(defaults::text("paths.base_dir")).join(defaults::text("task_guard.metrics_file"));
    let mut m = match std::fs::read(&p) {
        Ok(b) => match parse_js(&crate::checks::guardkit::text::lossy_owned(b))? {
            Some(v @ Js::Obj(_)) => v,
            // an array is an object to JavaScript: its named counters would be dropped by JSON.stringify
            Some(Js::Arr(_)) => return Err(Unsure),
            _ => Js::Obj(Vec::new()),
        },
        Err(_) => Js::Obj(Vec::new()),
    };
    for k in defaults::list("task_guard.metrics_counters") {
        if !m.get(k).and_then(Js::as_f64).is_some_and(|n| n.is_finite() && n >= 0.0) {
            m.set(k, Js::Num(0.0));
        }
    }
    let pending = defaults::text("task_guard.metrics_pending_key");
    if !matches!(m.get(pending), Some(Js::Obj(_) | Js::Arr(_))) {
        m.set(pending, Js::Obj(Vec::new()));
    }
    let key = defaults::text("task_guard.metrics_idle_key");
    let n = m.get(key).and_then(Js::as_f64).unwrap_or(0.0);
    m.set(key, Js::Num(n + 1.0));
    Ok((p, m.stringify()))
}

/// `writeMetrics`: the directory made, a temporary file renamed over the target; any failure is ignored (fail-open).
pub fn write_metrics(p: &Path, body: &str) {
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports nothing either way (Node catch)
    }
    let style = crate::atomic::Style { keep_json_ext: false, leave_temp_on_rename_failure: true, ..Default::default() };
    crate::discard::harmless(crate::atomic::write_styled(p, body, style)); // keep: Node's writeMetrics swallows every error
}
