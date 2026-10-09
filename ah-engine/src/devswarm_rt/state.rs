//! The workspace state record, its pure derivation from sources, and the diff between two snapshots.
//!
//! Invariants (v2 design I2, with the numbering of the lane brief):
//! * **I1** every field is derived from a named source; an unreadable source gives `unknown`, never a guess.
//! * **I2** an archived or closed workspace emits no stuck, CI or paused edge.
//! * **I3** a field observed longer ago than `stale_ms` reads as stale ([`Field::is_stale`]).
//! * **I4** an edge is emitted only when a value changed, and carries the generation that produced it.
//! * **I5** nothing is written back to any source (the sources module only reads; the property tests check the files).
use crate::defaults;
use crate::devswarm_rt::sources::{AppBuilder, AppPr, AppRead, GhPr, GithubState, Probe};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The settings the derivation needs, read once from `devswarm_rt.*` (tests build their own).
#[derive(Debug, Clone, PartialEq)]
pub struct Cfg {
    /// A field older than this reads as stale.
    pub stale_ms: i64,
    /// An active workspace silent for longer than this is stuck.
    pub stall_ms: i64,
    /// Start-up changes are not notified before this long after start.
    pub restart_grace_ms: i64,
    /// Most change records kept.
    pub edge_cap: usize,
    /// How often the whole state is re-read.
    pub reconcile_ms: i64,
    /// The paused signal is proven (`panel_resumable`): `paused?` evidence then reports `paused`.
    pub paused_proven: bool,
    /// The panel status that is the paused candidate (lower case).
    pub panel_resumable: String,
    /// PR state words (lower case).
    pub pr_open: String,
    /// See `pr_open`.
    pub pr_merged: String,
    /// See `pr_open`.
    pub pr_closed: String,
    /// CI status words (lower case).
    pub ci_failing: Vec<String>,
    /// See `ci_failing`.
    pub ci_running: Vec<String>,
    /// See `ci_failing`.
    pub ci_passing: Vec<String>,
    /// The state-store namespace.
    pub namespace: String,
}

impl Cfg {
    /// Read the settings from the loaded defaults.
    pub fn from_defaults() -> Cfg {
        let low = |k: &str| defaults::text(k).to_lowercase();
        let lows = |k: &str| defaults::list(k).iter().map(|s| s.to_lowercase()).collect::<Vec<_>>();
        Cfg {
            stale_ms: defaults::num("devswarm_rt.stale_ms") as i64,
            stall_ms: defaults::num("devswarm_rt.stall_ms") as i64,
            restart_grace_ms: defaults::num("devswarm_rt.restart_grace_ms") as i64,
            edge_cap: defaults::num("devswarm_rt.edge_cap") as usize,
            reconcile_ms: defaults::num("devswarm_rt.reconcile_ms") as i64,
            paused_proven: defaults::text("devswarm_rt.paused_signal") == defaults::text("devswarm_rt.panel_resumable_signal"),
            panel_resumable: low("devswarm_rt.panel_resumable"),
            pr_open: low("devswarm_rt.pr_open"),
            pr_merged: low("devswarm_rt.pr_merged"),
            pr_closed: low("devswarm_rt.pr_closed"),
            ci_failing: lows("devswarm_rt.ci_failing"),
            ci_running: lows("devswarm_rt.ci_running"),
            ci_passing: lows("devswarm_rt.ci_passing"),
            namespace: defaults::text("devswarm_rt.namespace").to_string(),
        }
    }
}

/// Where a field's value came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Src {
    /// The DevSwarm app database.
    AppDb,
    /// The app database's PR table (its CI data is only as fresh as its last sync).
    AppPr,
    /// The GitHub realtime feature.
    Github,
    /// The workspace's heartbeat file.
    Heartbeat,
    /// The workspace's plan file.
    Plan,
    /// The mesh unread union.
    Mesh,
    /// Computed from other fields of the same record.
    Derived,
    /// No source could be read.
    None,
}

/// A value with its provenance (I1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Field<T> {
    /// The value.
    pub value: T,
    /// The source it was derived from.
    pub source: Src,
    /// When the source was observed (epoch ms; for the app's CI data, its last sync).
    pub observed_ms: i64,
    /// Signature of the source state it came from.
    pub sig: String,
}

impl<T> Field<T> {
    fn new(value: T, source: Src, observed_ms: i64, sig: impl Into<String>) -> Field<T> {
        Field { value, source, observed_ms, sig: sig.into() }
    }
    /// I3: observed longer ago than `stale_ms`.
    pub fn is_stale(&self, now: i64, stale_ms: i64) -> bool {
        now.saturating_sub(self.observed_ms) > stale_ms
    }
}

/// Where a workspace is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    /// `isActive=1, isHidden=0`.
    Active,
    /// `isActive=0, isHidden=0`.
    Closed,
    /// `isActive=0, isHidden=1`.
    Archived,
    /// `isActive=1, isHidden=1`.
    Hidden,
    /// The flags are unreadable (or the hidden flag is missing from an old schema, which would make closed and archived indistinguishable).
    Unknown,
}

/// Whether a workspace is paused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Paused {
    /// No evidence of a pause.
    No,
    /// `paused?`: evidence exists but no signal is proven, so nothing is claimed.
    Maybe(String),
    /// Paused, by a signal the owner has proven with a fixture.
    Yes(String),
    /// The terminals table could not be read.
    Unknown,
}

/// What a workspace is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    /// Beating within `stall_ms`.
    Working,
    /// Active but silent beyond `stall_ms`.
    Stuck,
    /// Its linked PR's CI is running.
    WaitingCi,
    /// Its linked PR is merged.
    Done,
    /// No source, or the workspace is archived or closed (all stuck and CI verdicts are suppressed).
    Unknown,
}

/// A linked PR's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    /// Open.
    Open,
    /// Merged.
    Merged,
    /// Closed without merging.
    Closed,
    /// A state word this build does not know.
    Unknown,
}

/// A linked PR's CI roll-up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ci {
    /// Passed.
    Passing,
    /// Running.
    Running,
    /// Failed.
    Failing,
    /// None reported, or a word this build does not know.
    Unknown,
}

/// The linked PR.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrView {
    /// PR number.
    pub number: Option<i64>,
    /// PR state.
    pub state: PrState,
    /// CI roll-up.
    pub checks: Ci,
}

/// One workspace's record. Optional values are `None` when unknown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    /// The workspace (builder) id.
    pub id: String,
    /// Its label.
    pub label: Option<String>,
    /// Its worktree.
    pub worktree: Option<String>,
    /// Its branch.
    pub branch: Option<String>,
    /// Its repository id.
    pub repo: Option<String>,
    /// Lifecycle.
    pub lifecycle: Field<Lifecycle>,
    /// Paused or not.
    pub paused: Field<Paused>,
    /// Activity.
    pub activity: Field<Activity>,
    /// Unread mesh messages.
    pub unread: Field<Option<usize>>,
    /// The plan step in progress.
    pub plan_step: Field<Option<String>>,
    /// Last heartbeat (epoch ms).
    pub last_activity_ms: Field<Option<i64>>,
    /// The linked PR (`None`: no PR linked).
    pub pr: Field<Option<PrView>>,
}

/// All workspaces at one generation.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Snapshot {
    /// Rises by one whenever a change is emitted.
    pub generation: u64,
    /// When the sources were last read.
    pub at_ms: i64,
    /// Once a full read (or a persisted snapshot) has been loaded; an unseeded snapshot is seeded without edges.
    pub seeded: bool,
    /// Whether the app database was readable at the last read.
    pub app_readable: bool,
    /// Every workspace by id.
    pub workspaces: BTreeMap<String, Workspace>,
}

/// What can change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    /// Lifecycle (including a workspace appearing or disappearing).
    Lifecycle,
    /// Paused or `paused?`.
    Paused,
    /// Activity (stuck, waiting_ci, done, ...).
    Activity,
    /// Unread count.
    Unread,
    /// Plan step.
    PlanStep,
    /// Linked PR number or state.
    Pr,
    /// CI roll-up.
    Checks,
}

impl EdgeKind {
    /// The kind's name.
    pub fn as_str(&self) -> &'static str {
        match self {
            EdgeKind::Lifecycle => "lifecycle",
            EdgeKind::Paused => "paused",
            EdgeKind::Activity => "activity",
            EdgeKind::Unread => "unread",
            EdgeKind::PlanStep => "plan_step",
            EdgeKind::Pr => "pr",
            EdgeKind::Checks => "checks",
        }
    }
    /// A kind I2 suppresses for an archived or closed workspace.
    fn suppressed_when_finished(&self) -> bool {
        matches!(self, EdgeKind::Activity | EdgeKind::Paused | EdgeKind::Checks)
    }
}

/// One change between two snapshots (I4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    /// The workspace.
    pub ws: String,
    /// What changed.
    pub kind: EdgeKind,
    /// The value before (rendered).
    pub from: String,
    /// The value after (rendered).
    pub to: String,
    /// The snapshot generation that produced it.
    pub generation: u64,
    /// When it was found.
    pub at_ms: i64,
    /// Found by the start-up diff: it happened while the engine was down.
    pub while_down: bool,
    /// A notifier must not announce it before this time, and only if the condition still holds (0: no hold).
    pub hold_until_ms: i64,
}

/// The sources one derivation reads.
pub struct Inputs<'a> {
    /// The app database read (`None`: unreadable).
    pub app: Option<&'a AppRead>,
    /// File-based facts.
    pub probe: &'a dyn Probe,
    /// The GitHub feature, when enabled.
    pub gh: Option<&'a dyn GithubState>,
    /// The clock.
    pub now: i64,
}

fn render<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(j) => j.to_string(),
        Err(_) => String::new(),
    }
}

fn lifecycle_of(b: &AppBuilder) -> Lifecycle {
    match (b.active, b.hidden) {
        (Some(true), Some(false)) => Lifecycle::Active,
        (Some(true), Some(true)) => Lifecycle::Hidden,
        (Some(false), Some(false)) => Lifecycle::Closed,
        (Some(false), Some(true)) => Lifecycle::Archived,
        // an active workspace on a schema without the hidden flag is still visibly active; an inactive one is not classifiable
        (Some(true), None) => Lifecycle::Active,
        _ => Lifecycle::Unknown,
    }
}

fn finished(l: Lifecycle) -> bool {
    matches!(l, Lifecycle::Archived | Lifecycle::Closed)
}

fn pr_state(cfg: &Cfg, s: Option<&str>) -> PrState {
    let w = s.unwrap_or_default().to_lowercase();
    if w == cfg.pr_open {
        PrState::Open
    } else if w == cfg.pr_merged {
        PrState::Merged
    } else if w == cfg.pr_closed {
        PrState::Closed
    } else {
        PrState::Unknown
    }
}

fn ci_of(cfg: &Cfg, s: Option<&str>) -> Ci {
    let w = s.unwrap_or_default().to_lowercase();
    if cfg.ci_failing.contains(&w) {
        Ci::Failing
    } else if cfg.ci_running.contains(&w) {
        Ci::Running
    } else if cfg.ci_passing.contains(&w) {
        Ci::Passing
    } else {
        Ci::Unknown
    }
}

fn paused_of(cfg: &Cfg, b: &AppBuilder, app: &AppRead, lifecycle: Lifecycle) -> Paused {
    if !matches!(lifecycle, Lifecycle::Active | Lifecycle::Hidden) {
        return Paused::No;
    }
    let Some(terms) = &app.terminals else { return Paused::Unknown };
    let open: Vec<_> = terms.iter().filter(|t| t.builder_id == b.id && t.active == Some(true)).collect();
    if !open.is_empty() && open.iter().all(|t| t.panel.as_deref().map(str::to_lowercase).as_deref() == Some(cfg.panel_resumable.as_str())) {
        let ev = defaults::render("devswarm_rt.paused_evidence", &[("n", &open.len()), ("panel", &cfg.panel_resumable)]);
        return if cfg.paused_proven { Paused::Yes(ev) } else { Paused::Maybe(ev) };
    }
    Paused::No
}

fn pr_field(cfg: &Cfg, b: &AppBuilder, app: &AppRead, gh: Option<&dyn GithubState>, now: i64) -> Field<Option<PrView>> {
    if let (Some(g), Some(wt), Some(br)) = (gh, b.worktree.as_deref(), b.branch.as_deref())
        && let Some(GhPr { number, state, checks, observed_ms }) = g.pr(wt, br)
    {
        return Field::new(Some(PrView { number, state, checks }), Src::Github, observed_ms, String::new());
    }
    let (Some(prs), Some(id)) = (&app.prs, b.pr_id.as_deref()) else {
        // no link, or the PR table is unreadable (unknown): without a link there is nothing to report either way
        return Field::new(None, if b.pr_id.is_some() { Src::None } else { Src::AppDb }, now, app.sig.clone());
    };
    match prs.iter().find(|p: &&AppPr| p.id == id) {
        Some(p) => Field::new(
            Some(PrView { number: p.number, state: pr_state(cfg, p.state.as_deref()), checks: ci_of(cfg, p.checks.as_deref()) }),
            Src::AppPr,
            p.synced_ms.unwrap_or(0),
            app.sig.clone(),
        ),
        None => Field::new(None, Src::AppPr, now, app.sig.clone()),
    }
}

/// Derive a snapshot from the sources. Pure apart from the reads the inputs perform. `prev` supplies the records kept when
/// the app database is unreadable. The generation is carried over; the reconciler raises it when edges are emitted.
pub fn derive(cfg: &Cfg, inp: &Inputs<'_>, prev: &Snapshot) -> Snapshot {
    let now = inp.now;
    let Some(app) = inp.app else {
        // I1: with the app database unreadable no lifecycle can be known; every record keeps its last value only as `unknown`
        let workspaces = prev
            .workspaces
            .iter()
            .map(|(id, w)| {
                let mut w = w.clone();
                w.lifecycle = Field::new(Lifecycle::Unknown, Src::None, now, String::new());
                w.paused = Field::new(Paused::Unknown, Src::None, now, String::new());
                w.activity = Field::new(Activity::Unknown, Src::None, now, String::new());
                (id.clone(), w)
            })
            .collect();
        return Snapshot { generation: prev.generation, at_ms: now, seeded: prev.seeded, app_readable: false, workspaces };
    };
    let mut workspaces = BTreeMap::new();
    for b in &app.builders {
        let lifecycle = lifecycle_of(b);
        let lc_src = if lifecycle == Lifecycle::Unknown { Src::None } else { Src::AppDb };
        let hb = inp.probe.heartbeat_ms(&b.id);
        let plan = if finished(lifecycle) { None } else { b.worktree.as_deref().and_then(|w| inp.probe.plan_step(w)) };
        let unread = if finished(lifecycle) { None } else { inp.probe.unread(&b.id) };
        let pr = pr_field(cfg, b, app, inp.gh, now);
        let activity = if finished(lifecycle) || lifecycle == Lifecycle::Unknown {
            Field::new(Activity::Unknown, Src::Derived, now, String::new())
        } else if pr.value.as_ref().is_some_and(|p| p.state == PrState::Merged) {
            Field::new(Activity::Done, Src::Derived, pr.observed_ms, pr.sig.clone())
        } else if pr.value.as_ref().is_some_and(|p| p.state == PrState::Open && p.checks == Ci::Running) {
            Field::new(Activity::WaitingCi, Src::Derived, pr.observed_ms, pr.sig.clone())
        } else {
            match hb {
                None => Field::new(Activity::Unknown, Src::None, now, String::new()),
                Some(t) if now - t > cfg.stall_ms => Field::new(Activity::Stuck, Src::Heartbeat, t, t.to_string()),
                Some(t) => Field::new(Activity::Working, Src::Heartbeat, t, t.to_string()),
            }
        };
        let w = Workspace {
            id: b.id.clone(),
            label: b.label.clone(),
            worktree: b.worktree.clone(),
            branch: b.branch.clone(),
            repo: b.repo.clone(),
            lifecycle: Field::new(lifecycle, lc_src, now, app.sig.clone()),
            paused: Field::new(paused_of(cfg, b, app, lifecycle), Src::AppDb, now, app.sig.clone()),
            activity,
            unread: Field::new(unread, if unread.is_some() { Src::Mesh } else { Src::None }, now, String::new()),
            plan_step: Field::new(plan.clone(), if plan.is_some() { Src::Plan } else { Src::None }, now, String::new()),
            last_activity_ms: Field::new(
                hb,
                if hb.is_some() { Src::Heartbeat } else { Src::None },
                hb.unwrap_or(now),
                hb.map(|t| t.to_string()).unwrap_or_default(),
            ),
            pr,
        };
        workspaces.insert(b.id.clone(), w);
    }
    Snapshot { generation: prev.generation, at_ms: now, seeded: prev.seeded, app_readable: true, workspaces }
}

fn pr_number_state(p: &Option<PrView>) -> String {
    match p {
        None => String::new(),
        Some(p) => format!("#{} {}", p.number.map(|n| n.to_string()).unwrap_or_default(), render(&p.state)),
    }
}

/// The changes from `prev` to `next` (I4: only value changes; I2: nothing stuck, CI or paused for a finished workspace).
pub fn diff(prev: &Snapshot, next: &Snapshot, cfg: &Cfg, generation: u64, now: i64, while_down: bool) -> Vec<Edge> {
    let hold = if while_down { now + cfg.restart_grace_ms } else { 0 };
    let mut out = Vec::new();
    let mut push = |ws: &str, kind: EdgeKind, from: String, to: String| {
        if from != to {
            out.push(Edge { ws: ws.to_string(), kind, from, to, generation, at_ms: now, while_down, hold_until_ms: hold });
        }
    };
    for (id, n) in &next.workspaces {
        let Some(p) = prev.workspaces.get(id) else {
            push(id, EdgeKind::Lifecycle, String::new(), render(&n.lifecycle.value));
            continue;
        };
        let done = finished(n.lifecycle.value);
        push(id, EdgeKind::Lifecycle, render(&p.lifecycle.value), render(&n.lifecycle.value));
        if !done {
            let pr = |k: EdgeKind, f: String, t: String| (k, f, t);
            let items = [
                pr(EdgeKind::Paused, render(&p.paused.value), render(&n.paused.value)),
                pr(EdgeKind::Activity, render(&p.activity.value), render(&n.activity.value)),
                pr(
                    EdgeKind::Checks,
                    p.pr.value.as_ref().map(|x| render(&x.checks)).unwrap_or_default(),
                    n.pr.value.as_ref().map(|x| render(&x.checks)).unwrap_or_default(),
                ),
            ];
            for (k, f, t) in items {
                debug_assert!(k.suppressed_when_finished());
                push(id, k, f, t);
            }
        }
        push(id, EdgeKind::Unread, p.unread.value.map(|x| x.to_string()).unwrap_or_default(), n.unread.value.map(|x| x.to_string()).unwrap_or_default());
        push(id, EdgeKind::PlanStep, p.plan_step.value.clone().unwrap_or_default(), n.plan_step.value.clone().unwrap_or_default());
        push(id, EdgeKind::Pr, pr_number_state(&p.pr.value), pr_number_state(&n.pr.value));
    }
    for (id, p) in &prev.workspaces {
        if !next.workspaces.contains_key(id) {
            push(id, EdgeKind::Lifecycle, render(&p.lifecycle.value), String::new());
        }
    }
    out
}

/// An invariant a snapshot or edge broke (the property tests assert there are none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    /// Which invariant.
    pub rule: Rule,
    /// The workspace.
    pub ws: String,
}

/// The invariants of this module, numbered as in the module documentation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    /// I1: a value claims a source it does not have.
    I1ValueWithoutSource,
    /// I1: paused claimed without a proven signal.
    I1PausedUnproven,
    /// I2: a finished workspace carries activity.
    I2FinishedHasActivity,
    /// I2: a stuck, CI or paused edge on a finished workspace.
    I2EdgeOnFinished,
    /// I3: staleness disagrees with age.
    I3Staleness,
    /// I4: an edge without a value change.
    I4NoChange,
    /// I4: an edge from a generation that does not exist yet.
    I4FutureGeneration,
}

/// Check the invariants of a snapshot and of the edges that led to it; empty means all hold.
pub fn check_invariants(cfg: &Cfg, snap: &Snapshot, edges: &[Edge], now: i64) -> Vec<Violation> {
    let mut bad = Vec::new();
    let mut flag = |rule: Rule, ws: &str| bad.push(Violation { rule, ws: ws.to_string() });
    for w in snap.workspaces.values() {
        if (w.lifecycle.source == Src::None && w.lifecycle.value != Lifecycle::Unknown)
            || (w.unread.source == Src::None && w.unread.value.is_some())
            || (w.last_activity_ms.source == Src::None && w.last_activity_ms.value.is_some())
        {
            flag(Rule::I1ValueWithoutSource, &w.id);
        }
        if matches!(w.paused.value, Paused::Yes(_)) && !cfg.paused_proven {
            flag(Rule::I1PausedUnproven, &w.id);
        }
        if finished(w.lifecycle.value) && !matches!(w.activity.value, Activity::Unknown) {
            flag(Rule::I2FinishedHasActivity, &w.id);
        }
        if w.lifecycle.is_stale(now, cfg.stale_ms) != (now - w.lifecycle.observed_ms > cfg.stale_ms) {
            flag(Rule::I3Staleness, &w.id);
        }
    }
    for e in edges {
        if e.from == e.to {
            flag(Rule::I4NoChange, &e.ws);
        }
        if e.generation > snap.generation {
            flag(Rule::I4FutureGeneration, &e.ws);
        }
        if e.kind.suppressed_when_finished() && snap.workspaces.get(&e.ws).is_some_and(|w| finished(w.lifecycle.value)) {
            flag(Rule::I2EdgeOnFinished, &e.ws);
        }
    }
    bad
}
