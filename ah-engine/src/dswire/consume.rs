//! The consumers of the realtime DevSwarm state (design B2): the per-session advisory, the statusline segment and the per-child
//! Jev dirty flags. All read the state through [`Rt`]; none of them writes a DevSwarm source.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - a seen-generation or dirty-queue file that is missing or malformed is the empty one: at worst an advisory repeats once
use crate::checks::guardkit::msg::render_with;
use crate::defaults;
use crate::devswarm_rt::detect::Mode;
use crate::devswarm_rt::reconcile::Rt;
use crate::devswarm_rt::state::{Activity, Edge, Lifecycle};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn list(k: &str) -> Vec<String> {
    defaults::list(k).into_iter().map(String::from).collect()
}

fn seen_path(state_dir: &Path, session: &str) -> Option<PathBuf> {
    let max = defaults::num("devswarm_wire.advisory_session_max") as usize;
    let ok = !session.is_empty() && session.chars().count() <= max && session.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    ok.then(|| state_dir.join(defaults::text("devswarm_wire.advisory_dir")).join(format!("{session}{}", defaults::text("mesh_write.json_suffix"))))
}

fn read_seen(p: &Path) -> Option<u64> {
    serde_json::from_str::<Value>(&std::fs::read_to_string(p).ok()?).ok()?.get("gen")?.as_u64()
}

fn prune_old(dir: &Path, now: i64) {
    let age = defaults::num("devswarm_wire.advisory_prune_ms");
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d.as_millis() as u64 > age);
        if old && now > 0 {
            crate::discard::harmless(std::fs::remove_file(e.path())); // keep: a stale marker; the next advisory prunes again
        }
    }
}

fn label(rt: &Rt, ws: &str) -> String {
    rt.workspace(ws)
        .and_then(|w| w.label)
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| ws.chars().take(defaults::num("devswarm_wire.label_chars") as usize).collect())
}

/// The advisory text for `session`: the changes since the generation it was last told about, within the size caps. The engine reads
/// the state and the session's marker; whether to speak, the text and the generation to remember are decided by the plugin script
/// `devswarm-rt-advisory.js`. `None` when there is nothing new, the layer is off, the script fails, or the marker cannot be written
/// (an unrecorded advisory would repeat). Two sessions each see a change once; one session never twice.
pub fn advisory(rt: &Rt, state_dir: &Path, session: &str, now: i64) -> Option<String> {
    let path = seen_path(state_dir, session);
    let gen_now = rt.current().generation;
    let seen = path.as_deref().and_then(read_seen);
    let edges: Vec<Value> = seen
        .map(|s| rt.edges_since(s))
        .unwrap_or_default()
        .iter()
        .map(|e| json!({"ws": e.ws, "label": label(rt, &e.ws), "kind": e.kind.as_str(), "from": e.from, "to": e.to}))
        .collect();
    let payload = json!({
        "enabled": rt.mode() == Mode::On && defaults::raw("devswarm_wire.advisory_enabled").as_bool().unwrap_or(false),
        "sessionOk": path.is_some(), "seen": seen, "generation": gen_now, "edges": edges,
    });
    let env = crate::reqenv::RequestEnv::from_pairs([(defaults::env_name("home"), rt.detection().home.to_string_lossy().into_owned())]);
    let ans = match crate::script::run_forced(
        defaults::text("devswarm_wire.check_script"),
        &payload,
        &Value::Null,
        defaults::text("devswarm_wire.check_event"),
        &env,
    ) {
        Some(Some(crate::checks::Verdict::Exact(x))) => serde_json::from_str::<Value>(&x.out).ok()?,
        _ => return None,
    };
    if let Some(mark) = ans.get("mark").and_then(Value::as_u64) {
        write_seen(path.as_deref()?, mark, now)?;
    }
    ans.get("advise").and_then(Value::as_str).map(str::to_string)
}

fn write_seen(path: &Path, gen_now: u64, now: i64) -> Option<()> {
    let dir = path.parent()?;
    std::fs::create_dir_all(dir).ok()?;
    prune_old(dir, now);
    crate::atomic::write(path, json!({"gen": gen_now}).to_string()).ok()
}

/// The statusline segment: workspaces in progress, stuck, unread mail.
pub fn line(rt: &Rt) -> String {
    let snap = rt.current();
    if !snap.app_readable {
        return defaults::text("devswarm_wire.msg_line_stale").to_string();
    }
    let live = snap.workspaces.values().filter(|w| w.lifecycle.value == Lifecycle::Active);
    let (mut active, mut stuck, mut unread) = (0, 0, 0usize);
    for w in live {
        active += 1;
        stuck += usize::from(w.activity.value == Activity::Stuck);
        unread += w.unread.value.unwrap_or(0);
    }
    render_with(
        defaults::text("devswarm_wire.msg_line"),
        &[("active", &active.to_string()), ("stuck", &stuck.to_string()), ("unread", &unread.to_string()), ("gen", &snap.generation.to_string())],
    )
}

// ---- Jev dirty flags --------------------------------------------------------------------------------------------------------

fn dirty_file(state_dir: &Path) -> PathBuf {
    state_dir.join(defaults::text("devswarm_wire.jev_dirty_file"))
}

fn dirty_load(state_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dirty_file(state_dir)).ok().and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok()).unwrap_or_default()
}

/// Queue a per-child Jev sweep for each workspace an edge of a dirty kind touched (a workspace already queued stays once).
/// Returns how many were newly queued.
pub fn mark_dirty(rt: &Rt, state_dir: &Path, edges: &[Edge]) -> usize {
    let kinds = list("devswarm_wire.jev_dirty_kinds");
    let ids: Vec<String> = edges
        .iter()
        .filter(|e| kinds.iter().any(|k| k == e.kind.as_str()) && rt.workspace(&e.ws).is_some_and(|w| w.lifecycle.value == Lifecycle::Active))
        .map(|e| e.ws.clone())
        .collect();
    queue_ids(state_dir, &ids)
}

/// Queue a per-child Jev sweep for each of `ids` (a source other than a state change: a transcript or a commit).
pub fn queue_ids(state_dir: &Path, ids: &[String]) -> usize {
    let mut q = dirty_load(state_dir);
    let before = q.len();
    for id in ids {
        if !q.contains(id) {
            q.push(id.clone());
        }
    }
    let cap = defaults::num("devswarm_wire.jev_dirty_cap") as usize;
    if q.len() > cap {
        q.drain(..q.len() - cap);
    }
    if q.len() != before {
        crate::discard::logged("dswire_jev_dirty", crate::atomic::write(dirty_file(state_dir), json!(q).to_string()));
    }
    q.len().saturating_sub(before)
}

/// Take the queue: the ids and, for matching the plan files, their worktrees.
pub fn take_dirty(rt: &Rt, state_dir: &Path) -> Vec<String> {
    let q = dirty_load(state_dir);
    if q.is_empty() {
        return q;
    }
    crate::discard::logged("dswire_jev_dirty", crate::atomic::write(dirty_file(state_dir), "[]"));
    q.into_iter().flat_map(|id| [Some(id.clone()), rt.workspace(&id).and_then(|w| w.worktree)]).flatten().collect()
}

// ---- the hook check ---------------------------------------------------------------------------------------------------------

/// Built-in `check = "devswarm-rt-advisory"` (UserPromptSubmit): tells the main session about the DevSwarm workspace changes it
/// has not seen. Engine-only (the Node fallback entry is a no-op). It needs the live state, which exists only inside the daemon,
/// so a dispatch answered in the hook client allows silently. It reads, never decides an action: whether there is anything to
/// say is a comparison of the session's last seen generation with the state's.
pub struct RtAdvisory;

impl crate::checks::Check for RtAdvisory {
    fn name(&self) -> &'static str {
        "devswarm-rt-advisory"
    }

    fn summary(&self) -> &'static str {
        defaults::text("devswarm_wire.check_summary")
    }

    fn run(&self, _s: &crate::rules::Subject<'_>, _opts: &Value) -> Option<crate::checks::Verdict> {
        Some(crate::checks::Verdict::Allow)
    }

    fn scripted(&self) -> bool {
        true
    }

    fn run_payload(&self, s: &crate::rules::Subject<'_>, payload: &Value, _opts: &Value) -> Option<crate::checks::Verdict> {
        use crate::checks::Verdict;
        let main_thread = payload.get("agent_id").and_then(Value::as_str).is_none_or(str::is_empty);
        let session = payload.get("session_id").and_then(Value::as_str).unwrap_or_default();
        let wire = super::global().filter(|_| s.event == defaults::text("devswarm_wire.check_event") && main_thread);
        let text = wire.and_then(|w| advisory(&w.rt, &w.state_dir, session, crate::health::now_ms() as i64));
        Some(match text {
            Some(t) => {
                wire.inspect(|w| w.count_advisory());
                Verdict::Advisory(crate::checks::guardkit::msg::advisory_json(s.event, &t))
            }
            None => Verdict::Allow,
        })
    }
}
