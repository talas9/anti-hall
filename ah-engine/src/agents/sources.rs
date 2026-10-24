//! Where the tracker finds agents: Claude Code transcripts (sessions and their subagents), heartbeat files, DevSwarm descriptors, plans
//! and wake-watch locks, and the Claude Code CLI's own session listing (`claude agents --json`).
//!
//! The CLI is used only where it beats a transcript (whether a session is busy, waiting or gone). It runs as a bounded subprocess,
//! is probed once per Claude Code version and cached, and a failed or unverified probe falls back to the transcripts. Only the
//! `--json` form is read; no human-formatted output is ever parsed.
use super::facts;
use super::live::{self, Session};
use super::{Agent, Env, State, Ws, fmtn, kind_name, lim, pth};
use crate::checks::agent_scan::mtime_ms;
use crate::defaults::{self, V};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

/// What a refresh learned about its sources, for the status footer.
#[derive(Debug, Clone, Default)]
pub struct Listing {
    /// The Claude Code version the CLI source was checked on.
    pub cli_version: String,
    /// The CLI listing was used this tick.
    pub cli_used: bool,
}

pub(super) struct Found {
    pub(super) id: String,
    pub(super) kind: &'static str,
    pub(super) parent: String,
    pub(super) name: String,
    pub(super) path: String,
    pub(super) mtime: u64,
    pub(super) team: String,
    pub(super) finished: bool,
}

pub(super) fn read_dir(p: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(p).map(|r| r.filter_map(|e| e.ok().map(|e| e.path())).collect()).unwrap_or_default()
}

pub(super) fn json_of(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// Whether a transcript is a headless one-shot run: its start names a headless entrypoint (`agent_tracker.headless`).
fn headless_head(path: &Path) -> bool {
    let h = defaults::raw("agent_tracker.headless");
    let mut buf = Vec::new();
    let Ok(f) = std::fs::File::open(path) else { return false };
    if std::io::Read::read_to_end(&mut std::io::Read::take(f, lim("headless_head_bytes")), &mut buf).is_err() {
        return false;
    }
    let head = String::from_utf8_lossy(&buf);
    let key = h.str_field("key");
    h.get("values").map(V::strings).unwrap_or_default().iter().any(|v| head.contains(&format!("\"{key}\":\"{v}\"")))
}

/// Discover the transcripts in the active window. Headless runs are left out and returned by id.
fn discover(env: &Env, sessions: &[Session], tracked: &std::collections::BTreeMap<String, Agent>, known: &std::collections::BTreeSet<String>) -> (Vec<Found>, std::collections::BTreeSet<String>) {
    let cutoff = env.now_ms.saturating_sub(lim("active_window_ms"));
    let ext = pth("transcript_ext");
    let dirs = defaults::raw("agent_tracker.headless").get("dir_contains").map(V::strings).unwrap_or_default();
    let mut out = Vec::new();
    let mut headless = std::collections::BTreeSet::new();
    for proj in read_dir(&env.home.join(pth("projects"))) {
        let dir_headless = proj.file_name().is_some_and(|n| dirs.iter().any(|d| n.to_string_lossy().contains(d)));
        for f in read_dir(&proj) {
            let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if let Some(stem) = name.strip_suffix(ext) {
                if let Some(m) = mtime_ms(&f).map(|m| m as u64).filter(|m| *m >= cutoff) {
                    if dir_headless || known.contains(stem) || (!tracked.get(stem).is_some_and(|a| a.interactive) && !sessions.iter().any(|s| s.id == stem) && headless_head(&f)) {
                        headless.insert(stem.to_string());
                        continue;
                    }
                    out.push(Found {
                        id: stem.to_string(),
                        kind: kind_name("main"),
                        parent: stem.to_string(),
                        name: String::new(),
                        path: f.to_string_lossy().to_string(),
                        mtime: m,
                        team: String::new(),
                        finished: false,
                    });
                }
            } else if f.is_dir() && !dir_headless && !known.contains(&name) {
                for s in read_dir(&f.join(pth("subagents"))) {
                    let n = s.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    let Some(stem) = n.strip_suffix(ext) else { continue };
                    let Some(m) = mtime_ms(&s).map(|m| m as u64).filter(|m| *m >= cutoff) else { continue };
                    let path = s.to_string_lossy().to_string();
                    let meta = json_of(Path::new(&facts::meta_path(&path))).unwrap_or(Value::Null);
                    let mf = defaults::raw("agent_tracker.meta");
                    let text = |k: &str| meta.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                    let mate = text(mf.str_field("task_kind")) == mf.str_field("teammate");
                    out.push(Found {
                        id: stem.strip_prefix(pth("agent_prefix")).unwrap_or(stem).to_string(),
                        kind: if mate { kind_name("teammate") } else { kind_name("subagent") },
                        parent: name.clone(),
                        name: if mate { text(mf.str_field("name")) } else { text(super::tr("description")) },
                        path,
                        mtime: m,
                        team: text(mf.str_field("team")),
                        finished: meta.get(mf.str_field("finished")).and_then(Value::as_bool).unwrap_or(false),
                    });
                }
            }
        }
    }
    out.sort_by_key(|f| std::cmp::Reverse(f.mtime));
    out.truncate(lim("max_agents") as usize);
    // a session with a live process is followed however long its transcript has been quiet (and whatever the cap says)
    out.extend(live::quiet_sessions(env, sessions, &out));
    out.extend(live::codex_found(env));
    (out, headless)
}

/// Heartbeat files (`<base>/agents/<id>.json`): the agents only a heartbeat shows.
fn heartbeats(env: &Env, st: &mut State) {
    let f = defaults::raw("agent_tracker.devswarm_fields");
    let done = defaults::raw("agent_tracker.words").get("hb_final").map(V::strings).unwrap_or_default();
    for p in read_dir(&env.base().join(pth("heartbeats"))) {
        if p.extension().is_none_or(|e| e.to_string_lossy() != pth("json_ext").trim_start_matches('.')) {
            continue;
        }
        let Some(v) = json_of(&p) else { continue };
        let ts = v.get(f.str_field("hb_ts")).and_then(Value::as_u64).unwrap_or(0);
        let status = v.get(f.str_field("hb_status")).and_then(Value::as_str).unwrap_or("").to_string();
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let id = format!("{}{}", kind_name("heartbeat"), v.get(f.str_field("hb_id")).and_then(Value::as_str).unwrap_or(&stem));
        if ts == 0 || ts + lim("active_window_ms") < env.now_ms || done.contains(&status.as_str()) {
            st.agents.remove(&id);
            continue;
        }
        let a = st.agents.entry(id.clone()).or_insert_with(|| Agent {
            id,
            kind: kind_name("heartbeat").into(),
            source: defaults::raw("agent_tracker.sources").str_field("heartbeat").into(),
            first_seen: env.now_ms,
            running: true,
            ..Agent::default()
        });
        a.seen = env.now_ms;
        a.hb_ts = ts;
        a.last_output_ms = ts;
        a.hb_status = status;
        a.hb_step = super::cap(v.get(f.str_field("hb_step")).and_then(Value::as_str).unwrap_or(""), lim("text_cap"));
        a.name = stem;
    }
}

/// DevSwarm workspaces: inert unless the DevSwarm descriptor directory exists.
fn devswarm(env: &Env, st: &mut State) {
    let root = env.base().join(pth("devswarm"));
    let descs = read_dir(&root.join(pth("workspaces")));
    if descs.is_empty() {
        return;
    }
    let f = defaults::raw("agent_tracker.devswarm_fields");
    let g = |v: &Value, k: &str| v.get(f.str_field(k)).and_then(Value::as_str).unwrap_or("").to_string();
    let plans: Vec<Value> = read_dir(&root.join(pth("plans"))).iter().filter_map(|p| json_of(p)).collect();
    // the workspace's display title (DevSwarm's name cache) names its agent; an archived workspace keeps its title
    let title_of = |id: &str| json_of(&root.join(pth("names")).join(format!("{id}{}", pth("json_ext")))).map(|t| g(&t, "title")).unwrap_or_default();
    for p in read_dir(&root.join(pth("archived"))) {
        let Some(d) = json_of(&p) else { continue };
        let title = title_of(&g(&d, "id"));
        if let Some(a) = st.agents.get_mut(&g(&d, "session")).filter(|_| !title.is_empty()) {
            a.name = super::cap(&title, lim("text_cap"));
        }
    }
    for p in descs {
        let Some(d) = json_of(&p) else { continue };
        let (id, session, wt) = (g(&d, "id"), g(&d, "session"), g(&d, "worktree"));
        if id.is_empty() {
            continue;
        }
        let key = if st.agents.contains_key(&session) {
            Some(session)
        } else {
            st.agents.iter().find(|(_, a)| a.kind == kind_name("main") && !wt.is_empty() && a.cwd == wt).map(|(k, _)| k.clone())
        };
        let Some(a) = key.and_then(|k| st.agents.get_mut(&k)) else { continue };
        let title = title_of(&id);
        if !title.is_empty() {
            a.name = super::cap(&title, lim("text_cap"));
        }
        if root.join(pth("archived")).join(format!("{id}{}", pth("json_ext"))).exists() {
            continue;
        }
        a.kind = kind_name("workspace").into();
        let (mut step, mut done) = (String::new(), 0u64);
        if let Some(plan) = plans.iter().find(|pl| g(pl, "worktree") == wt) {
            let steps = plan.get(f.str_field("steps")).and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
            let open: Vec<&Value> = steps.iter().filter(|s| g(s, "step_status") != f.str_field("step_done")).collect();
            done = (steps.len() - open.len()) as u64;
            let live = |s: &&&Value| g(s, "step_status") == f.str_field("step_doing") || g(s, "step_status") == f.str_field("step_blocked");
            let cur = open.iter().filter(live).max_by_key(|s| s.get(f.str_field("step_ts")).and_then(Value::as_u64).unwrap_or(0)).or(open.first());
            step = cur.map(|s| g(s, "step_text")).unwrap_or_default();
        }
        let before = a.ws.as_ref().map_or(0, |w| w.done);
        if a.ws.is_some() && done > before {
            a.progress += (done - before) * super::weight("step");
        }
        if !step.is_empty() {
            facts::set_step(a, &step);
        }
        // a Primary's DevSwarm watcher arms only while it has a live child (its idle-skip), so "unarmed" says nothing about it
        let armed = (!id.starts_with(defaults::text("agent_tracker.primary_prefix"))).then(|| watcher_armed(env, &id));
        a.ws = Some(Ws { id: id.clone(), armed, step, done });
        live_plan(env, &id, a, done);
    }
}

/// The live facts of a workspace's work (task-list completions, commits, pushes, merges and deploys, and when it last shipped), kept in
/// one small file per workspace for the roster: its plan is the workspace's own report (`heartbeat --step`) and stays as stale as the
/// last report, so the roster shows these facts next to it. Written only when they change.
fn live_plan(env: &Env, id: &str, a: &Agent, plan_done: u64) {
    if !env.act || (a.steps_done == 0 && a.commits == 0 && a.shipped == 0 && a.pushes == 0) {
        return;
    }
    let path = env.dir().join(defaults::raw("agent_tracker.live_plan").str_field("dir")).join(format!("{id}{}", pth("json_ext")));
    let facts = serde_json::json!({"tasks_done": a.steps_done, "commits": a.commits, "pushes": a.pushes, "shipped": a.shipped, "last_ship_ms": a.last_ship_ms, "plan_done": plan_done});
    if json_of(&path).is_some_and(|v| v["facts"] == facts) {
        return;
    }
    if let Some(d) = path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports a missing directory
    }
    crate::discard::harmless(crate::atomic::write(path, serde_json::json!({"ts": env.now_ms, "facts": facts}).to_string())); // keep: the next tick writes it again
}

/// Whether a live wake-watch Monitor covers the workspace: the same check `inbox tick` makes (its own lock, or the live lock of another
/// row on its checkout). A lock the check cannot read decides nothing, so it reads as not armed.
fn watcher_armed(env: &Env, id: &str) -> bool {
    let found = crate::meshw::watcher::live_for_workspace(&env.home, id, env.now_ms as i64);
    if found.as_ref().is_ok_and(|f| f.by_checkout) {
        crate::metrics::bump("mesh_watcher_matched_by_checkout", &[]);
    }
    found.is_ok_and(|f| f.armed)
}

// ---- the Claude Code CLI --------------------------------------------------------------------------------

fn cli_cfg(k: &str) -> &'static V {
    defaults::raw("agent_tracker.claude_cli").get(k).unwrap_or(&V::Int(0))
}

fn cli_run(args: &[&'static str]) -> Option<String> {
    let bin = defaults::env_var("claude_bin").filter(|b| !b.is_empty()).unwrap_or_else(|| cli_cfg("bin").as_str().unwrap_or("").to_string());
    let mut c = Command::new(&bin);
    c.args(args);
    let o = crate::proc::run(c, &bin, std::time::Duration::from_millis(lim("claude_cli_timeout_ms")), defaults::millis("health.probe_poll_ms")).ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).to_string())
}

fn cli_rows(out: &str) -> Option<Vec<Value>> {
    let v: Value = serde_json::from_str(out).ok()?;
    let rows = v.as_array()?;
    let id = cli_cfg("id").as_str().unwrap_or("");
    rows.iter().all(|r| r.get(id).is_some()).then(|| rows.clone())
}

/// Whether the host's listing is due by age (or has never been taken). Without the CLI nothing is cached, so it is always due.
fn listing_due(env: &Env, st: &State) -> bool {
    !env.use_cli || st.cli_ok == Some(false) || st.cli_listed == 0 || env.now_ms.saturating_sub(st.cli_listed) >= lim("cli_list_ttl_ms")
}

/// Whether the host's session listing must be taken now: it is due by age, or an agent the last listing did not cover has appeared.
fn relist(env: &Env, st: &State, due: bool) -> bool {
    due || st.agents.values().any(|a| (a.kind == kind_name("main") || a.kind == kind_name("workspace")) && !st.cli_seen.contains(&a.id)) && env.use_cli
}

fn cli(env: &Env, st: &mut State, relist: bool) -> Listing {
    let mut l = Listing { cli_version: st.cli_version.clone(), cli_used: false };
    if !env.use_cli {
        return l;
    }
    if st.cli_ok.is_none() || env.now_ms.saturating_sub(st.cli_checked) > lim("probe_ttl_ms") {
        let ver = cli_run(&cli_cfg("version_args").strings()).and_then(|t| t.split_whitespace().next().map(str::to_string)).unwrap_or_default();
        let changed = ver != st.cli_version || st.cli_ok.is_none();
        if changed {
            st.cli_ok = Some(!ver.is_empty() && cli_run(&cli_cfg("agents_args").strings()).and_then(|o| cli_rows(&o)).is_some());
        }
        st.cli_version = ver;
        st.cli_checked = env.now_ms;
        l.cli_version = st.cli_version.clone();
    }
    if st.cli_ok != Some(true) {
        return l;
    }
    if !relist {
        l.cli_used = true; // the listing of a moment ago still stands
        return l;
    }
    // stamped on the attempt, so a listing that fails is not retried at every tick either
    st.cli_listed = env.now_ms;
    st.cli_seen = st.agents.values().filter(|a| a.kind == kind_name("main") || a.kind == kind_name("workspace")).map(|a| a.id.clone()).collect();
    let Some(rows) = cli_run(&cli_cfg("agents_args").strings()).and_then(|o| cli_rows(&o)) else { return l };
    l.cli_used = true;
    let field = |r: &Value, k: &str| r.get(cli_cfg(k).as_str().unwrap_or("")).and_then(Value::as_str).unwrap_or("").to_string();
    let live: std::collections::HashSet<String> = rows.iter().map(|r| field(r, "id")).collect();
    for a in st.agents.values_mut() {
        // an interactive or background session the host no longer lists has no process: it cannot be hung, only gone
        a.gone = (a.kind == kind_name("main") || a.kind == kind_name("workspace")) && !live.contains(&a.id);
    }
    for r in rows {
        let Some(a) = st.agents.get_mut(&field(&r, "id")) else { continue };
        let s = [field(&r, "status"), field(&r, "state")].into_iter().find(|s| !s.is_empty()).unwrap_or_default();
        a.host = s;
        a.gone = r.get(cli_cfg("pid").as_str().unwrap_or("")).and_then(Value::as_u64).is_some_and(|p| !crate::health::pid_alive(p as u32));
    }
    l
}

/// A subagent whose launching session records it as ended (a terminal task notice: completed, failed, stopped, killed; or a
/// `TaskStop` that was answered) is done, whatever its own transcript last said: a stopped agent writes no closing line, so
/// reading only its transcript would call it running (and silent) for as long as the transcript is tracked.
fn stopped_subagents(env: &Env, st: &mut State) {
    let opts = crate::checks::agent_scan::Opts { now_ms: env.now_ms as f64, ignore_unanswered_stops: true };
    let tail = defaults::num("agent_scan.tail_bytes");
    let mut ended: std::collections::HashMap<String, std::collections::HashSet<String>> = std::collections::HashMap::new();
    let live: Vec<(String, String)> =
        st.agents.values().filter(|a| super::is_child(a) && a.running).map(|a| (a.id.clone(), a.path.clone())).collect();
    for (id, path) in live {
        // <projects>/<dir>/<parent session>/subagents/agent-<id>.jsonl: the launching session's transcript is <dir>/<parent session>.jsonl
        let Some(session_dir) = Path::new(&path).parent().and_then(Path::parent) else { continue };
        let parent = format!("{}{}", session_dir.to_string_lossy(), pth("transcript_ext"));
        let set = ended
            .entry(parent.clone())
            .or_insert_with(|| crate::checks::agent_scan::scan_transcript(&parent, tail, &opts).ok().flatten().map(|s| s.terminal.into_iter().chain(s.stopped_agents).collect()).unwrap_or_default());
        if set.contains(&id)
            && let Some(a) = st.agents.get_mut(&id)
        {
            a.running = false;
        }
    }
}

/// The stops a launching session answered for in-process teammates, as task description -> latest stop time (ms): the host answers a
/// `TaskStop` of a teammate with its own task id (not the agent id or the name) plus the task's description, which is the `description`
/// field of that teammate's meta file. Only the answer is read here (the recent tail of the transcript), so a stop whose launch line is
/// long gone from the window still counts; the caller matches it to a teammate by description and start time.
fn teammate_stops(parent: &str) -> std::collections::HashMap<String, u64> {
    use std::collections::{HashMap, HashSet};
    let cfg = defaults::raw("agent_tracker.stop_result");
    let field = |k: &str| cfg.str_field(k);
    let stop_tool = defaults::text("agent_scan.stop_tool");
    let Some(text) = tail_of(parent, defaults::num("agent_scan.tail_bytes")) else { return HashMap::new() };
    let mut stop_calls: HashSet<String> = HashSet::new();
    let mut stopped: HashMap<String, u64> = HashMap::new();
    for v in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        let blocks = v["message"]["content"].as_array().map_or(&[][..], Vec::as_slice);
        for b in blocks.iter().filter(|b| b["type"] == field("use_type") && b["name"] == stop_tool) {
            stop_calls.insert(b["id"].as_str().unwrap_or_default().to_string());
        }
        let res = &v[field("result")];
        let answers_stop = blocks.iter().any(|b| b["tool_use_id"].as_str().is_some_and(|i| stop_calls.contains(i)));
        if answers_stop && res[field("kind")] == field("teammate")
            && let Some(desc) = res[field("command")].as_str()
        {
            let ts = crate::checks::agent_scan::date_parse(v[super::tr("ts")].as_str().unwrap_or_default()).ok().filter(|t| t.is_finite()).map_or(u64::MAX, |t| t as u64);
            let e = stopped.entry(desc.to_string()).or_insert(0);
            *e = (*e).max(ts);
        }
    }
    stopped
}

fn tail_of(path: &str, max: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(max))).ok()?;
    let mut buf = Vec::new();
    f.take(max).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// A teammate its launching session stopped with `TaskStop` is finished at once, without waiting for the host to drop it from the team
/// roster (which [`off_roster`] reads, later and only for a team that has a roster). The teammate's description comes from its own meta
/// file; a stop counts only when it is not older than the agent's start (a teammate launched again under the same description is new).
fn stopped_teammates(st: &mut State) {
    let mf = defaults::raw("agent_tracker.meta");
    let mut seen: std::collections::HashMap<String, std::collections::HashMap<String, u64>> = std::collections::HashMap::new();
    for a in st.agents.values_mut().filter(|a| a.kind == kind_name("teammate") && !a.finished) {
        let Some(dir) = Path::new(&a.path).parent().and_then(Path::parent) else { continue };
        let meta_file = facts::meta_path(&a.path);
        let desc = json_of(Path::new(&meta_file)).and_then(|m| m.get(mf.str_field("description")).and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
        if desc.is_empty() {
            continue;
        }
        let parent = format!("{}{}", dir.to_string_lossy(), pth("transcript_ext"));
        let stops = seen.entry(parent.clone()).or_insert_with(|| teammate_stops(&parent));
        let started = mtime_ms(Path::new(&meta_file)).map_or(0, |m| m as u64);
        if stops.get(&desc).is_some_and(|t| *t >= started) {
            a.finished = true;
        }
    }
}

/// A teammate the host's team roster (`agent_tracker.roster`) no longer lists - or lists as joined after this agent started, so the name
/// belongs to a newer spawn - was stopped or finished. The host writes nothing into such a teammate's own transcript, and the scan of
/// the launching session's transcript only sees a stop still inside its window, so the roster is the one record that stays true. A
/// roster that is missing or unreadable decides nothing. Runs over every tracked teammate, not only the ones read this tick: an agent
/// the tick's cap left out would otherwise keep its last "running" for as long as it is tracked.
fn off_roster(env: &Env, st: &mut State) {
    let r = defaults::raw("agent_tracker.roster");
    let num = |k: &str| r.get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64;
    let mut rosters: std::collections::HashMap<String, Option<std::collections::BTreeMap<String, u64>>> = std::collections::HashMap::new();
    for a in st.agents.values_mut().filter(|a| a.kind == kind_name("teammate") && !a.team.is_empty() && !a.name.is_empty()) {
        // a tick may read the roster between the host's two writes at spawn: an agent just followed decides nothing
        if env.now_ms.saturating_sub(a.first_seen) < num("grace_ms") {
            continue;
        }
        let roster = rosters.entry(a.team.clone()).or_insert_with(|| {
            let v = json_of(&env.home.join(r.str_field("dir")).join(&a.team).join(r.str_field("file")))?;
            let members = v.get(r.str_field("members"))?.as_array()?;
            Some(members.iter().filter_map(|m| Some((m.get(r.str_field("name"))?.as_str()?.to_string(), m.get(r.str_field("joined")).and_then(Value::as_u64).unwrap_or(0)))).collect())
        });
        let Some(roster) = roster else { continue };
        let started = mtime_ms(Path::new(&facts::meta_path(&a.path))).map_or(0, |m| m as u64);
        if roster.get(&a.name).is_none_or(|joined| *joined > started.saturating_add(num("rejoin_slack_ms"))) {
            a.finished = true;
        }
    }
}

/// Whether a session agent (main or workspace) has a live process: the registry gave it a pid that is alive.
pub(super) fn proc_live(a: &Agent) -> bool {
    a.pid != 0 && !a.gone && crate::health::pid_alive(a.pid)
}

/// Mark the agents nothing can bring back as dead (decided afresh each tick, so new output revives one; nothing is deleted). A Claude
/// subagent or teammate has no process of its own: it is dead when its transcript or working directory is gone, or when it has been
/// silent past `dead_idle_ms` while its launching session has no live process either (nobody is left to deliver to or to stop it). A
/// session is dead on the same terms with its own process in place of the parent's, once the host calls it gone. Codex rows and heartbeats keep their own rules.
fn mark_dead(env: &Env, st: &mut State) {
    let limit = lim("dead_idle_ms");
    let live: std::collections::BTreeSet<String> = st.agents.values().filter(|a| proc_live(a)).map(|a| a.id.clone()).collect();
    let missing = |p: &str| !p.is_empty() && !Path::new(p).exists();
    for a in st.agents.values_mut() {
        let session = a.kind == kind_name("main") || a.kind == kind_name("workspace");
        if !(session || super::is_child(a)) {
            continue;
        }
        let owner_live = if session { live.contains(&a.id) } else { live.contains(&a.parent) };
        let silent = limit > 0 && env.now_ms.saturating_sub(a.last_output_ms) > limit;
        let was = a.dead;
        // a session also needs the host to call it gone, so a host without a registry never reads an idle session as dead
        // a child that finished (the host's meta says so) or ended its turn with no call open completed: it is done, never dead
        let completed = !session && (a.finished || (!a.running && a.pending.is_empty()));
        a.dead = !completed && !owner_live && (!session || a.gone) && (missing(&a.path) || missing(&a.cwd) || silent);
        if a.dead && !was {
            super::signals::rec(env, "state", super::state_name("dead"), crate::telemetry::event::Outcome::Allow, super::signals::base(a).num("idle_s", env.now_ms.saturating_sub(a.last_output_ms) / super::fmtn("ms_per_s")));
        }
    }
}

/// Discover and ingest every source; drop agents that disappeared.
pub(crate) fn refresh(env: &Env, st: &mut State) -> Listing {
    let now = env.now_ms;
    let due = listing_due(env, st);
    let sessions = live::registry(env);
    let (found, headless) = discover(env, sessions.as_deref().unwrap_or(&[]), &st.agents, &st.headless);
    st.agents.retain(|id, a| !headless.contains(id) && !headless.contains(&a.parent));
    st.headless = headless;
    for f in found {
        let a = st.agents.entry(f.id.clone()).or_insert_with(|| Agent {
            id: f.id.clone(),
            kind: f.kind.into(),
            parent: f.parent.clone(),
            path: f.path.clone(),
            source: defaults::raw("agent_tracker.sources").str_field("transcript").into(),
            first_seen: now,
            ..Agent::default()
        });
        a.seen = now;
        a.path = f.path;
        a.interactive |= a.kind == kind_name("main") || a.kind == kind_name("workspace");
        a.team = f.team;
        a.finished = f.finished;
        if super::is_child(a) && (f.kind == kind_name("subagent") || f.kind == kind_name("teammate")) {
            a.kind = f.kind.into(); // a teammate seen before its meta named it one is re-kinded
        }
        if due {
            a.host.clear();
            a.gone = false;
        }
        if !f.name.is_empty() {
            a.name = f.name;
        }
        if a.kind == kind_name("codex") {
            live::codex_state(env, a, f.mtime);
            continue;
        }
        facts::ingest(a, now);
        // Host metadata can identify a rescue before its transcript has any tool uses.
        let nw = defaults::raw("agent_tracker.no_work");
        if let Some(meta) = json_of(Path::new(&facts::meta_path(&a.path))) {
            a.codex_rescue |= nw.get("agent_type_fields").map(V::strings).unwrap_or_default().iter().any(|k| meta.get(*k).and_then(Value::as_str) == Some(nw.str_field("rescue_type")));
        }
        if !super::is_child(a) && a.kind != kind_name("workspace") {
            a.kind = kind_name("main").into();
        }
    }
    // Rescue type belongs to the parent's launch input on hosts that omit it from child metadata.
    let rescue_children: std::collections::BTreeSet<String> = st.agents.values().flat_map(|a| a.rescue_children.iter().cloned()).collect();
    for id in rescue_children {
        if let Some(child) = st.agents.get_mut(&id) { child.codex_rescue = true; }
    }
    // a rollout that aged out of the scan is no longer found, so its row is judged again from its last write
    for a in st.agents.values_mut().filter(|a| a.kind == kind_name("codex") && a.seen < now) {
        live::codex_state(env, a, a.last_output_ms);
    }
    stopped_subagents(env, st);
    stopped_teammates(st);
    off_roster(env, st);
    heartbeats(env, st);
    devswarm(env, st);
    let again = relist(env, st, due);
    let l = cli(env, st, again);
    live::apply(st, sessions.as_deref(), l.cli_used);
    mark_dead(env, st);
    let keep = lim("active_window_ms");
    st.agents.retain(|_, a| now.saturating_sub(a.seen) <= keep);
    l
}

/// The seconds a duration reads as in the status table's age column.
pub(crate) fn unit_ms() -> Vec<u64> {
    defaults::raw("agent_tracker.fmt")
        .get("unit_ms")
        .and_then(V::as_array)
        .map(|a| a.iter().filter_map(V::as_integer).map(|n| n.max(1) as u64).collect())
        .unwrap_or_else(|| vec![fmtn("ms_per_s")])
}
