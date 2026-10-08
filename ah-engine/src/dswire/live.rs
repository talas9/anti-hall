//! [`LiveState`] over the realtime state: the facts the DevSwarm action layer re-reads right before it acts. The workspace
//! state (`devswarm_rt`) says WHICH workspaces to look at; every fact the decision depends on is read again from its source
//! (the app database, git, the descriptors, the mesh summary) at the moment of the call, never from the snapshot.
use super::facts::{self, Desc, Git};
use crate::defaults;
use crate::devswarm_rt::reconcile::Rt;
use crate::devswarm_rt::sources::{self, AppBuilder, AppRead, FsProbe};
use crate::devswarm_rt::state::{Activity, Lifecycle};
use crate::dsact::live::LiveState;
use crate::dsact::runner::Runner;
use crate::meshw::idlock::devswarm_root;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The live state of one run.
pub struct RtLive<'a> {
    /// The realtime state service.
    pub rt: &'a Rt,
    /// The home directory.
    pub home: PathBuf,
    /// Runs git.
    pub runner: &'a dyn Runner,
    /// The engine state directory (the poke record lives there).
    pub state_dir: PathBuf,
    /// The request environment (the settings tiers the actions obey).
    pub env: crate::reqenv::RequestEnv,
    /// The clock, epoch ms.
    pub now: i64,
}

fn is_primary(b: &AppBuilder) -> bool {
    // Node falls back to a checkout identity probe when the column is absent; the engine does not port it, so an unknown type
    // reads as primary (never archived, never deleted)
    b.builder_type.as_deref().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()).is_none_or(|t| t == "primary")
}

fn archived_flags(b: &AppBuilder) -> bool {
    b.active == Some(false) && b.hidden == Some(true)
}

impl RtLive<'_> {
    fn app(&self) -> Option<AppRead> {
        self.rt.detection().app_db.as_deref().and_then(sources::read_app)
    }

    fn git(&self) -> Git<'_> {
        Git { runner: self.runner }
    }

    /// `builders.lastSelectedAt` of `id`: `None` when the column does not exist, `Some(None)` when it holds nothing.
    fn last_selected(&self, id: &str) -> Option<Option<Value>> {
        let file = self.rt.detection().app_db.as_deref()?.to_str()?;
        let conn = crate::meshw::appdb::open(file)?;
        let table = defaults::text("mesh_write.app_table_builders");
        let col = defaults::text("devswarm_wire.col_last_selected");
        let has = conn.prepare(&format!("PRAGMA table_info({table})")).ok()?.query_map([], |r| r.get::<_, String>(1)).ok()?.flatten().any(|c| c == col);
        if !has {
            return None;
        }
        let sql = defaults::render("devswarm_wire.sql_last_selected", &[("col", &col), ("table", &table), ("id", &defaults::text("mesh_write.app_col_id"))]);
        let raw: Option<String> = conn.query_row(&sql, [id], |r| r.get::<_, Option<String>>(0)).ok().flatten().filter(|s| !s.is_empty());
        Some(raw.map(|s| sources::parse_iso_ms(&s).map_or(Value::String(s), |ms| json!(ms))))
    }

    fn primary_cwd(app: &AppRead, repo: &Option<String>) -> Option<String> {
        app.builders
            .iter()
            .find(|p| {
                is_primary(p) && p.builder_type.is_some() && (repo.is_none() || p.repo == *repo) && p.worktree.as_deref().is_some_and(|w| Path::new(w).exists())
            })
            .and_then(|p| p.worktree.clone())
    }

    fn auto_archive_facts(&self, app: &AppRead, b: &AppBuilder) -> Value {
        let descs = facts::descriptors(&self.home);
        let mine = facts::descs_of(&descs, b);
        let mut ids = vec![b.id.clone()];
        ids.extend(mine.iter().map(|d| d.id.clone()).filter(|i| *i != b.id));
        let wt = b.worktree.clone().or_else(|| mine.first().map(|d| d.worktree.clone())).unwrap_or_default();
        let repo_key = facts::repo_key(&wt);
        let summary = repo_key.as_deref().and_then(|k| facts::summary(&self.home, k));
        let git = self.git();
        let head = git.head(&wt);
        let done = facts::done_fact(summary.as_ref(), &ids, head.as_deref());
        let verified = ids.iter().find_map(|i| {
            let w = summary.as_ref()?.pointer(&format!("/workspaces/{i}"))?;
            (w.pointer("/gates/merged") == Some(&Value::Bool(true)) && w.get("mergedVerified") == Some(&Value::Bool(true)))
                .then(|| w.get("mergedVerifiedHead").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string))
                .flatten()
        });
        let merged = self.merged_fact(app, b, &wt, head.as_deref(), done["boundToHead"] == json!(true) && done["done"] == json!(true), verified.as_deref());
        let (clean, why) = git.clean(&wt);
        let probe = FsProbe::new(&self.home, self.now);
        let act = facts::activity_ms(&self.home, &probe, b, &mine);
        let last = self.last_selected(&b.id);
        // the newest inbound message and the commit time are floors under the idle clock, as in Node's real-work rule; the legacy
        // rule has neither, so they are not applied here (they could only make the workspace look less idle than Node does)
        json!({
            "id": b.id, "label": b.label, "branch": b.branch, "worktreePath": wt, "primaryCwd": Self::primary_cwd(app, &b.repo),
            "isPrimary": is_primary(b), "hasSummary": summary.is_some(), "done": done, "merged": merged,
            "clean": clean, "cleanReason": why, "unread": facts::unread_fact(&self.home, repo_key.as_deref(), summary.as_ref(), &ids),
            "hasLastSelected": last.is_some(), "lastSelectedAt": last.flatten(), "head": head,
            "idle": {"ts": act, "via": "activity", "openRealTurn": false, "pendingBackground": false},
        })
    }

    /// Node's `mergedFact`: the git ancestry proof first, then a merge proof the gate verb recorded at this HEAD, then (only for
    /// a done report bound to this HEAD) a merged PR row.
    fn merged_fact(&self, app: &AppRead, b: &AppBuilder, wt: &str, head: Option<&str>, allow_pr: bool, verified: Option<&str>) -> Value {
        let (mut default_unknown, mut head_s) = (false, head.map(str::to_string));
        if Path::new(wt).exists() {
            if head_s.is_none() {
                head_s = self.git().head(wt);
            }
            if let Some(h) = &head_s {
                let (m, via) = self.git().merge_proof(wt, h);
                match m {
                    Some(true) => return json!({"merged": true, "via": via}),
                    Some(false) => return json!({"merged": false, "via": "git:not-ancestor"}),
                    None => default_unknown = via == "default-branch-unknown",
                }
            }
        }
        if head_s.is_some() && verified == head_s.as_deref() {
            return json!({"merged": true, "via": "gate:merged_verified"});
        }
        if default_unknown {
            return json!({"merged": false, "via": "default-branch-unknown"});
        }
        if !allow_pr {
            return json!({"merged": false, "via": "unproven"});
        }
        let pr = app.prs.as_deref().unwrap_or_default().iter().find(|p| b.pr_id.as_deref() == Some(p.id.as_str()));
        match pr {
            Some(p) if p.state.as_deref().map(str::to_lowercase).as_deref() == Some("merged") => json!({"merged": true, "via": "pr"}),
            Some(p) => json!({"merged": false, "via": format!("pr:{}", p.state.as_deref().unwrap_or_default().to_lowercase())}),
            None => json!({"merged": false, "via": "unproven"}),
        }
    }

    fn found(&self, app: &Option<AppRead>, id: &str) -> Value {
        let Some(app) = app else { return json!({"appReadable": false}) };
        let Some(b) = app.builders.iter().find(|b| b.id == id) else { return json!({"appReadable": true, "found": false}) };
        let wt = b.worktree.clone().unwrap_or_default();
        let (clean, why) = self.git().clean(&wt);
        json!({
            "appReadable": true, "found": true, "builderType": b.builder_type, "archived": archived_flags(b), "isPrimary": is_primary(b),
            "cwd": b.worktree, "primaryCwd": Self::primary_cwd(app, &b.repo), "clean": clean, "cleanReason": why,
        })
    }

    /// The poke / escalate facts of a stale workspace (see the decision script's `dsPokeOrEscalate`). The commands are the
    /// descriptor's own argv arrays, run as Node's `defaultFireCommand` runs them.
    fn nudge_facts(&self, id: &str) -> Option<Value> {
        let desc: Desc = facts::descriptors(&self.home).into_iter().find(|d| d.id == id)?;
        let (nudge, escalate) = (desc.nudge, desc.escalate);
        let st = super::nudges::get(&self.state_dir, id);
        // one cooldown between a poke and the next decision about the workspace: the periodic sweep is shorter than the cooldown,
        // and without this it would escalate a workspace it poked a minute ago (Node's liveness verdict is not `stale` again
        // until its own cooldown has passed)
        let cooldown = crate::dsact::settings::ActSettings::read(&crate::checks::git::util::Settings::from_env(&self.env)).nudge_cooldown_sec * 1000;
        if st.at.is_some_and(|at| self.now - at < cooldown) {
            return None;
        }
        let snap = self.rt.current();
        let stale = snap.workspaces.get(id).is_some_and(|w| w.activity.value == Activity::Stuck && w.lifecycle.value == Lifecycle::Active);
        Some(json!({
            "id": id, "status": if st.escalated { "escalated" } else if stale { "stale" } else { "alive" },
            "nudgeAttempts": st.attempts, "nudgedAt": st.at, "nudgeArgv": nudge, "escalateArgv": escalate,
        }))
    }

    fn prune_row(&self, app: &AppRead, b: &AppBuilder, days: u64) -> Value {
        let id = b.id.clone();
        let since = archived_since(&self.home, &id);
        let age = since.map(|t| (self.now - t) / defaults::num("devswarm_wire.day_ms") as i64);
        let mut blockers: Vec<String> = Vec::new();
        match age {
            None => blockers.push("archive-age-unknown".into()),
            Some(a) if (a as u64) < days || a < 0 => blockers.push(format!("younger-than-{days}d")),
            _ => {}
        }
        if is_primary(b) {
            blockers.push("primary".into());
        }
        let wt = b.worktree.clone().unwrap_or_default();
        let git = self.git();
        let head = git.head(&wt);
        let repo_key = facts::repo_key(&wt);
        let summary = repo_key.as_deref().and_then(|k| facts::summary(&self.home, k));
        let merged = match &head {
            Some(h) => self.merged_fact(app, b, &wt, Some(h), false, None),
            None => json!({"merged": false, "via": "unproven"}),
        };
        if merged["merged"] != json!(true) {
            blockers.push(format!("not-merged({})", merged["via"].as_str().unwrap_or_default()));
        }
        let (clean, why) = git.clean(&wt);
        if clean != Some(true) {
            blockers.push(why.unwrap_or("unclean").to_string());
        }
        let un = repo_key
            .as_deref()
            .map(|_| facts::unread_fact(&self.home, repo_key.as_deref(), summary.as_ref(), std::slice::from_ref(&id)))
            .unwrap_or_else(|| json!({"toChild": null, "fromChild": null}));
        let to_child = un["toDirect"].as_f64().zip(un["toBroadcast"].as_f64()).map(|(d, b)| d + b);
        if to_child != Some(0.0) || un["fromChild"].as_u64() != Some(0) {
            blockers.push("unread".into());
        }
        json!({
            "id": id, "label": b.label, "branch": b.branch, "repositoryId": b.repo, "worktreePath": b.worktree,
            "archivedSince": since, "ageDays": age, "merged": merged["merged"], "mergedVia": merged["via"],
            "uncommitted": clean.map(|c| !c), "unread": {"toChild": to_child, "fromChild": un["fromChild"]},
            "eligible": blockers.is_empty(), "blockers": blockers,
        })
    }
}

/// When a workspace was archived, epoch ms: Node's auto-archive log first, else the archived marker's time.
fn archived_since(home: &Path, id: &str) -> Option<i64> {
    let log = home.join(defaults::text("devswarm_wire.archive_log_name"));
    let mut best = None;
    for l in std::fs::read_to_string(log).unwrap_or_default().lines() {
        if let Ok(r) = serde_json::from_str::<Value>(l)
            && r.get("id").and_then(Value::as_str) == Some(id)
            && r.get("ok") == Some(&Value::Bool(true))
            && let Some(t) = r.get("ts").and_then(Value::as_str).and_then(sources::parse_iso_ms)
        {
            best = Some(t);
        }
    }
    best.or_else(|| {
        let p = devswarm_root(home).join(defaults::text("mesh_write.dir_archived")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
        let t = std::fs::metadata(p).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
        Some(t.as_millis() as i64)
    })
}

impl LiveState for RtLive<'_> {
    fn present(&self) -> bool {
        self.rt.detection().active() && self.app().is_some()
    }

    fn now_ms(&self) -> i64 {
        self.now
    }

    fn candidates(&self) -> Vec<String> {
        let Some(app) = self.app() else { return Vec::new() };
        let descs = facts::descriptors(&self.home);
        app.builders.iter().filter(|b| b.active == Some(true) && !facts::descs_of(&descs, b).is_empty()).map(|b| b.id.clone()).collect()
    }

    fn stale(&self) -> Vec<String> {
        let snap = self.rt.current();
        snap.workspaces.values().filter(|w| w.activity.value == Activity::Stuck && w.lifecycle.value == Lifecycle::Active).map(|w| w.id.clone()).collect()
    }

    fn facts(&self, kind: &str, id: &str) -> Option<Value> {
        let kinds = defaults::list("devswarm_act.automatic_kinds");
        let owner = defaults::list("devswarm_act.owner_kinds");
        let app = self.app();
        if kind == kinds[0] {
            let app = app?;
            let b = app.builders.iter().find(|b| b.id == id)?;
            return Some(self.auto_archive_facts(&app, b));
        }
        if kind == format!("{}-or-{}", kinds[1], kinds[2]) {
            return self.nudge_facts(id);
        }
        if kind == owner[0] || kind == owner[3] {
            return Some(self.found(&app, id));
        }
        if kind == owner[1] || kind == owner[2] {
            return Some(json!({}));
        }
        None
    }

    fn archived(&self, id: &str) -> Option<bool> {
        self.app()?.builders.iter().find(|b| b.id == id).map(archived_flags)
    }

    fn prune_rows(&self, days: u64) -> Vec<Value> {
        let Some(app) = self.app() else { return Vec::new() };
        app.builders.iter().filter(|b| archived_flags(b)).map(|b| self.prune_row(&app, b, days)).collect()
    }
}
