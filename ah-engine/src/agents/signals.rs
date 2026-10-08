//! The signals, the flags that follow them, the reminders they cause and the outcomes that measure whether reminders work.
//!
//! A signal is a fact about an agent over a window (silent, repeating, spending without progress, off its step, a stale heartbeat, no
//! wake path armed). A flag is a signal that stays up across ticks. A reminder is queued once a flag has stayed up `confirm_ticks`
//! ticks, subject to a per-signal cooldown, a daily cap, a per-tick cap and the size of the agent's undelivered queue. When a flag
//! clears, its outcome is recorded: recovered after a reminder (with how long it took), or a false positive (it cleared on its own
//! while the agent made progress). A reminded flag still up after the outcome window is recorded as not recovered. Nothing here
//! ever stops an agent.
use super::facts::words;
use super::sinks::{self, MeshOutbox, OwnerNotices, Reminder, SessionQueue, Sink, age};
use super::{Agent, Env, Flag, Sample, State, cap, chan, defaults_signals, fmtn, kind_name, lim, pth, state_name};
use crate::defaults::{self, V};
use crate::telemetry::emit::{self, AgentRec};
use crate::telemetry::event::{Fields, Outcome};
use std::collections::{BTreeMap, BTreeSet};

/// A raised signal: the number it tripped on and the words it carries.
pub(crate) type Raised = (u64, String);

/// The state of an agent as the tracker reads it.
pub(crate) fn state_of(a: &Agent) -> &'static str {
    let host = |k: &str| defaults::raw("agent_tracker.claude_cli").get(k).map(V::strings).unwrap_or_default().contains(&a.host.as_str());
    if a.kind == kind_name("heartbeat") {
        return if a.flags.contains_key("heartbeat_stale") { state_name("stale") } else { state_name("running") };
    }
    if a.gone {
        return state_name("done");
    }
    if !a.host.is_empty() {
        if host("waiting") || host("blocked") {
            return state_name("waiting");
        }
        if host("busy") {
            return state_name("running");
        }
    }
    match (a.running, a.kind == kind_name("subagent")) {
        (true, _) => state_name("running"),
        (false, true) => state_name("done"),
        (false, false) => state_name("waiting"),
    }
}

fn running(a: &Agent) -> bool {
    state_of(a) == state_name("running")
}

fn label(a: &Agent) -> String {
    let n = if a.name.is_empty() { &a.id } else { &a.name };
    n.chars().take(super::fmtn("name_max") as usize).collect()
}

// ---- sampling -----------------------------------------------------------------------------------------------

fn sample(a: &mut Agent, now: u64) {
    a.samples.push(Sample { t: now, tin: a.tin, tout: a.tout, tcr: a.tcr, tcw: a.tcw, tools: a.tools, progress: a.progress });
    let keep = now.saturating_sub(lim("waste_window_ms") * 2);
    a.samples.retain(|s| s.t >= keep);
    let max = lim("samples_max") as usize;
    if a.samples.len() > max {
        a.samples.drain(..a.samples.len() - max);
    }
}

// ---- the signals --------------------------------------------------------------------------------------------

fn hung(a: &Agent, now: u64) -> Option<Raised> {
    if !running(a) || a.last_output_ms == 0 {
        return None;
    }
    let limit = if a.pending.is_empty() { lim("hung_ms") } else { lim("hung_pending_ms") };
    let idle = now.saturating_sub(a.last_output_ms);
    if idle <= limit {
        return None;
    }
    let tool = a
        .pending
        .values()
        .min_by_key(|p| p.ts)
        .map(|p| format!("{} {}", p.name, p.label))
        .or_else(|| a.recent.last().map(|r| r.1.clone()))
        .unwrap_or_else(|| defaults::render("msg.agent_no_tool", &[]));
    Some((idle / fmtn("ms_per_s"), tool))
}

fn looping(a: &Agent) -> Option<Raised> {
    if !running(a) {
        return None;
    }
    // only calls close together in time repeat in a loop; the same poll every few minutes is not one
    let newest = a.recent.iter().map(|r| r.3).max().unwrap_or(0).max(a.errs.iter().map(|e| e.2).max().unwrap_or(0));
    let from = newest.saturating_sub(lim("loop_span_ms"));
    let mut counts: BTreeMap<&str, (u64, &str, bool)> = BTreeMap::new();
    for (sig, lab, edit, _) in a.recent.iter().filter(|r| r.3 >= from) {
        let e = counts.entry(sig.as_str()).or_insert((0, lab.as_str(), *edit));
        e.0 += 1;
    }
    for (n, lab, edit) in counts.values() {
        if *n >= if *edit { lim("loop_edit_repeats") } else { lim("loop_repeats") } {
            return Some((*n, lab.to_string()));
        }
    }
    let mut errs: BTreeMap<u64, (u64, &str)> = BTreeMap::new();
    for (h, lab, _) in a.errs.iter().filter(|e| e.2 >= from) {
        errs.entry(*h).or_insert((0, lab.as_str())).0 += 1;
    }
    errs.values().find(|(n, _)| *n >= lim("error_repeats")).map(|(n, lab)| (*n, lab.to_string()))
}

fn token_waste(a: &Agent, now: u64) -> Option<Raised> {
    if !running(a) {
        return None;
    }
    let from = now.saturating_sub(lim("waste_window_ms"));
    let base = a.samples.iter().find(|s| s.t >= from)?;
    let cur = a.samples.last()?;
    if cur.t.saturating_sub(base.t) < lim("waste_min_span_ms") {
        return None;
    }
    let tokens = (cur.tin - base.tin) + (cur.tout - base.tout) + (cur.tcw - base.tcw) + (cur.tcr - base.tcr) * lim("cache_read_pct") / fmtn("pct");
    (tokens >= lim("waste_min_tokens") && cur.progress - base.progress <= lim("waste_max_progress")).then(|| (tokens, String::new()))
}

fn drift(a: &Agent) -> Option<Raised> {
    if a.step.is_empty() || a.step_events < lim("drift_min_events") {
        return None;
    }
    let step: BTreeSet<String> = words(&a.step).into_iter().collect();
    if (step.len() as u64) < lim("drift_min_step_words") {
        return None;
    }
    let work: BTreeSet<&String> = a.work.iter().collect();
    let hit = step.iter().filter(|w| work.contains(w)).count() as u64;
    let pct = hit * fmtn("pct") / step.len() as u64;
    (pct <= lim("drift_max_overlap_pct")).then(|| (pct, a.step.clone()))
}

fn heartbeat_stale(a: &Agent, now: u64) -> Option<Raised> {
    if a.kind != kind_name("heartbeat") {
        return None;
    }
    let old = now.saturating_sub(a.hb_ts);
    (old >= lim("heartbeat_stale_ms")).then(|| (old / fmtn("ms_per_s"), a.hb_step.clone()))
}

fn monitor_unarmed(a: &Agent, st: &State, now: u64) -> Option<Raised> {
    if (a.kind != kind_name("main") && a.kind != kind_name("workspace")) || a.gone {
        return None;
    }
    if let Some(Some(armed)) = a.ws.as_ref().map(|w| w.armed) {
        return (!armed && !a.gone).then(|| (0, a.ws.as_ref().map(|w| w.id.clone()).unwrap_or_default()));
    }
    let subs = st.agents.values().filter(|s| s.kind == kind_name("subagent") && s.parent == a.id && running(s)).count() as u64;
    let shells = a.bg_bash.iter().filter(|t| now.saturating_sub(**t) <= lim("bg_bash_ms")).count() as u64;
    let bg = subs + shells;
    (bg >= lim("monitor_min_bg") && now > a.armed_until).then(|| {
        let armed = if a.armed_at == 0 {
            defaults::render("msg.agent_armed_never", &[])
        } else {
            defaults::render("msg.agent_armed_lapsed", &[("ago", &age(now - a.armed_at))])
        };
        (bg, armed)
    })
}

fn raise(a: &Agent, st: &State, now: u64) -> BTreeMap<&'static str, Raised> {
    let mut out = BTreeMap::new();
    for s in defaults_signals() {
        let r = match s {
            "hung" => hung(a, now),
            "looping" => looping(a),
            "token_waste" => token_waste(a, now),
            "drift" => drift(a),
            "heartbeat_stale" => heartbeat_stale(a, now),
            "monitor_unarmed" => monitor_unarmed(a, st, now),
            _ => None,
        };
        if let Some(r) = r {
            out.insert(s, r);
        }
    }
    out
}

// ---- telemetry ----------------------------------------------------------------------------------------------

fn base(a: &Agent) -> Fields {
    Fields::new().tok("agent", &a.id).tok("akind", &a.kind).tok("state", state_of(a))
}

fn rec(env: &Env, class: &str, name: &str, outcome: Outcome, fields: Fields) {
    if env.act {
        emit::event(emit::agent_call(AgentRec { class, name, outcome, fields }));
    }
}

fn series(env: &Env, a: &mut Agent) {
    if !env.act || env.now_ms.saturating_sub(a.last_series) < lim("series_every_ms") {
        return;
    }
    a.last_series = env.now_ms;
    let f = base(a)
        .num("tin", a.tin)
        .num("tout", a.tout)
        .num("tcr", a.tcr)
        .num("tcw", a.tcw)
        .num("tools", a.tools)
        .num("progress", a.progress)
        .num("flagged", u64::from(!a.flags.is_empty()))
        .num("idle_s", env.now_ms.saturating_sub(a.last_output_ms) / fmtn("ms_per_s"))
        .tok("source", &a.source);
    rec(env, "series", &a.kind, Outcome::Allow, f);
    let row = serde_json::json!({"t": env.now_ms, "agent": a.id, "kind": a.kind, "state": state_of(a), "tin": a.tin, "tout": a.tout, "tcr": a.tcr, "tcw": a.tcw, "tools": a.tools, "progress": a.progress, "flagged": a.flags.keys().collect::<Vec<_>>()});
    let path = env.dir().join(pth("series"));
    if let Some(d) = path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the append below reports a missing directory
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        crate::discard::harmless(f.write_all(format!("{row}\n").as_bytes())); // keep: a series line lost to a full disk is only a gap
    }
}

fn trim_series(env: &Env) {
    let path = env.dir().join(pth("series"));
    let Ok(t) = std::fs::read_to_string(&path) else { return };
    if t.len() as u64 <= lim("series_max_bytes") {
        return;
    }
    let cutoff = env.now_ms.saturating_sub(lim("series_retention_ms"));
    let mut keep: Vec<&str> =
        t.lines().filter(|l| serde_json::from_str::<serde_json::Value>(l).ok().and_then(|v| v["t"].as_u64()).is_some_and(|x| x >= cutoff)).collect();
    if keep.iter().map(|l| l.len() as u64 + 1).sum::<u64>() > lim("series_max_bytes") {
        keep.drain(..keep.len() / 2);
    }
    crate::discard::harmless(crate::atomic::write(&path, keep.join("\n") + "\n")); // keep: the next tick trims again
}

// ---- reminders ----------------------------------------------------------------------------------------------

enum Target {
    Session(String),
    Mesh { ws: String, to_parent: bool },
    Owner,
}

fn text_for(env: &Env, a: &Agent, sig: &str, f: &Flag) -> String {
    let who = label(a);
    let kind: &str = &a.kind;
    let t = match sig {
        "hung" => defaults::render("msg.agent_hung", &[("agent", &who), ("kind", &kind), ("idle", &age(f.evidence * fmtn("ms_per_s"))), ("tool", &f.text)]),
        "looping" => defaults::render("msg.agent_looping", &[("agent", &who), ("kind", &kind), ("count", &f.evidence), ("what", &f.text)]),
        "token_waste" => {
            defaults::render("msg.agent_token_waste", &[("agent", &who), ("kind", &kind), ("tokens", &f.evidence), ("window", &age(lim("waste_window_ms")))])
        }
        "drift" => defaults::render("msg.agent_drift", &[("agent", &who), ("step", &f.text), ("overlap", &f.evidence)]),
        "heartbeat_stale" => defaults::render("msg.agent_heartbeat_stale", &[("agent", &who), ("age", &age(f.evidence * fmtn("ms_per_s"))), ("step", &f.text)]),
        _ if a.ws.as_ref().is_some_and(|w| w.armed == Some(false)) => {
            let root = env.plugin_root.as_ref().map(|r| r.join(pth("watcher")).to_string_lossy().to_string()).unwrap_or_else(|| pth("watcher").to_string());
            defaults::render("msg.agent_monitor_unarmed_devswarm", &[("command", &format!("node {root}"))])
        }
        _ => defaults::render("msg.agent_monitor_unarmed", &[("count", &f.evidence), ("armed", &f.text)]),
    };
    cap(&t, defaults::raw("agent_tracker.spam").get("max_text").and_then(V::as_integer).unwrap_or(0).max(0) as u64)
}

fn targets(env: &Env, st: &State, a: &Agent, sig: &str) -> Vec<Target> {
    let routes = defaults::raw("agent_tracker.routes").get(sig).map(V::strings).unwrap_or_default();
    let mut out = Vec::new();
    for r in routes {
        if r == chan("self") {
            out.push(match &a.ws {
                Some(w) => Target::Mesh { ws: w.id.clone(), to_parent: false },
                None => Target::Session(a.id.clone()),
            });
        } else if r == chan("coordinator") {
            let t = match (&a.ws, a.kind.as_str()) {
                (Some(w), _) => Some(Target::Mesh { ws: w.id.clone(), to_parent: true }),
                (None, k) if k == kind_name("subagent") => Some(Target::Session(a.parent.clone())),
                (None, k) if k == kind_name("heartbeat") => {
                    st.agents.values().filter(|m| m.kind == kind_name("main")).max_by_key(|m| m.last_output_ms).map(|m| Target::Session(m.id.clone()))
                }
                _ => Some(Target::Session(a.id.clone())),
            };
            out.extend(t);
        } else if r == chan("owner") && env.switch("agent_tracker.owner_setting") {
            out.push(Target::Owner);
        }
    }
    out
}

fn remind(env: &Env, st: &mut State, a: &mut Agent, sig: &str, queued: &mut u64) {
    if !env.act || !env.switch("agent_tracker.remind_setting") {
        return;
    }
    let now = env.now_ms;
    let cd = defaults::raw("agent_tracker.cooldowns").get(sig);
    let cool = cd.and_then(|c| c.get("cooldown_ms")).and_then(V::as_integer).unwrap_or(0).max(0) as u64;
    let per_day = cd.and_then(|c| c.get("max_per_day")).and_then(V::as_integer).unwrap_or(0).max(0) as u64;
    let spam = |k: &str| defaults::raw("agent_tracker.spam").get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64;
    let day = fmtn("day_ms");
    a.sent_log.retain(|(_, t)| now.saturating_sub(*t) < day);
    let why = if a.last_sent.get(sig).is_some_and(|t| now.saturating_sub(*t) < cool) {
        Some("cooldown")
    } else if per_day > 0 && a.sent_log.iter().filter(|(s, _)| s == sig).count() as u64 >= per_day {
        Some("cap")
    } else if *queued >= spam("max_per_tick") {
        Some("tick_cap")
    } else {
        None
    };
    let Some(flag) = a.flags.get(sig).cloned() else { return };
    let tg = targets(env, st, a, sig);
    let mut sent = 0;
    let mut held = why;
    for t in &tg {
        let (sink, key): (Box<dyn Sink>, String) = match t {
            Target::Session(k) => (Box::new(SessionQueue), k.clone()),
            Target::Mesh { ws, to_parent } => (Box::new(MeshOutbox { to_parent: *to_parent }), ws.clone()),
            Target::Owner => (Box::new(OwnerNotices), String::new()),
        };
        if held.is_none() && sink.backlog(env, &key) >= spam("max_pending") {
            held = Some("pending");
        }
        let f = base(a).tok("channel", sink.channel()).tok("result", held.unwrap_or("queued")).num("evidence", flag.evidence);
        if let Some(h) = held {
            let quiet = a.last_sent.get(&format!("held:{sig}")).is_some_and(|t| now.saturating_sub(*t) < cool.max(1));
            if !quiet {
                rec(env, "reminder", sig, Outcome::Skip, f.tok("source", h));
                st.day(env).suppressed += 1;
                a.last_sent.insert(format!("held:{sig}"), now);
            }
            continue;
        }
        let r = Reminder {
            id: format!("{:x}", crate::health::fnv(&format!("{}{sig}{now}", a.id))),
            ts: now,
            signal: sig.into(),
            agent: a.id.clone(),
            text: text_for(env, a, sig, &flag),
        };
        match sink.deliver(env, &key, &r) {
            Ok(()) => {
                rec(env, "reminder", sig, Outcome::Advise, f);
                st.day(env).queued += 1;
                sent += 1;
            }
            Err(e) => crate::health::log_event("agents", "queue_write", &e),
        }
    }
    if sent > 0 {
        *queued += 1;
        a.last_sent.insert(sig.into(), now);
        a.sent_log.push((sig.into(), now));
        if let Some(f) = a.flags.get_mut(sig)
            && f.reminded_at == 0
        {
            f.reminded_at = now;
        }
    }
}

fn resolve(env: &Env, st: &mut State, a: &Agent, sig: &str, f: &Flag) {
    let now = env.now_ms;
    if f.reminded_at > 0 {
        let lat = now.saturating_sub(f.reminded_at) / fmtn("ms_per_s");
        rec(env, "outcome", "recovered", Outcome::Allow, base(a).tok("source", sig).num("recovered", 1).num("lat_s", lat));
        st.day(env).recovered += 1;
    } else if a.progress >= f.base_progress + lim("fp_min_progress") {
        rec(env, "outcome", "false_positive", Outcome::Allow, base(a).tok("source", sig).num("fp", 1));
        st.day(env).false_positives += 1;
    } else {
        rec(env, "outcome", "cleared", Outcome::Allow, base(a).tok("source", sig));
    }
}

fn apply(env: &Env, st: &mut State, a: &mut Agent, raised: BTreeMap<&'static str, Raised>, queued: &mut u64) {
    let now = env.now_ms;
    for sig in defaults_signals() {
        match (raised.get(sig), a.flags.contains_key(sig)) {
            (Some((ev, text)), false) => {
                let f =
                    Flag { since: now, evidence: *ev, text: text.clone(), ticks: 1, base_progress: a.progress, base_tokens: a.tin + a.tout, ..Flag::default() };
                rec(
                    env,
                    "signal",
                    sig,
                    Outcome::Advise,
                    base(a).num("evidence", *ev).num("idle_s", now.saturating_sub(a.last_output_ms) / fmtn("ms_per_s")).tok("source", &a.source),
                );
                if env.act {
                    st.day(env).signals += 1;
                }
                a.flags.insert(sig.into(), f);
            }
            (Some((ev, text)), true) => {
                if let Some(f) = a.flags.get_mut(sig) {
                    f.ticks += 1;
                    f.evidence = *ev;
                    f.text.clone_from(text);
                }
            }
            (None, true) => {
                if let Some(f) = a.flags.remove(sig)
                    && env.act
                {
                    resolve(env, st, a, sig, &f);
                }
                continue;
            }
            (None, false) => continue,
        }
        let Some(f) = a.flags.get(sig).cloned() else { continue };
        if f.ticks >= lim("confirm_ticks") {
            remind(env, st, a, sig, queued);
        }
        if let Some(f) = a.flags.get_mut(sig)
            && f.reminded_at > 0
            && !f.timed_out
            && now.saturating_sub(f.reminded_at) > lim("outcome_timeout_ms")
        {
            f.timed_out = true;
            rec(env, "outcome", "unrecovered", Outcome::Allow, base(a).tok("source", sig));
            if env.act {
                st.day(env).unrecovered += 1;
            }
        }
    }
}

/// Read the rows the hook check appended to the delivered file since the last tick.
fn take_deliveries(env: &Env, st: &mut State) {
    let Ok(t) = std::fs::read_to_string(env.dir().join(pth("delivered"))) else { return };
    let all: Vec<&str> = t.lines().collect();
    let from = (st.delivered_lines as usize).min(all.len());
    for l in all.iter().skip(from).take(lim("delivered_max") as usize) {
        st.delivered_lines += 1;
        let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else { continue };
        let (agent, sig, ts) = (v["agent"].as_str().unwrap_or(""), v["signal"].as_str().unwrap_or(""), v["ts"].as_u64().unwrap_or(env.now_ms));
        let lat = st.agents.get_mut(agent).and_then(|a| a.flags.get_mut(sig)).map(|f| {
            f.delivered_at = ts;
            ts.saturating_sub(f.reminded_at) / fmtn("ms_per_s")
        });
        if env.act {
            st.day(env).delivered += 1;
            emit::event(emit::agent_call(AgentRec {
                class: "delivery",
                name: sig,
                outcome: Outcome::Advise,
                fields: Fields::new().tok("agent", agent).tok("channel", chan("session")).num("lat_s", lat.unwrap_or(0)),
            }));
        }
    }
}

/// One evaluation pass over every agent.
pub(crate) fn evaluate_all(env: &Env, st: &mut State) {
    let now = env.now_ms;
    take_deliveries(env, st);
    let mut queued = 0;
    let ids: Vec<String> = st.agents.keys().cloned().collect();
    for id in ids {
        let Some(mut a) = st.agents.remove(&id) else { continue };
        let prev = a.samples.last().map(|s| s.tin + s.tout).unwrap_or(a.tin + a.tout);
        sample(&mut a, now);
        let raised = raise(&a, st, now);
        apply(env, st, &mut a, raised, &mut queued);
        if env.act && !a.flags.is_empty() {
            st.day(env).burned += (a.tin + a.tout).saturating_sub(prev);
        }
        series(env, &mut a);
        st.agents.insert(id, a);
    }
    let keep = lim("day_retention");
    let today = now / fmtn("day_ms");
    st.days.retain(|d, _| d.parse::<u64>().is_ok_and(|d| today.saturating_sub(d) <= keep));
    if env.act {
        sinks::compact(env);
        trim_series(env);
    }
}
