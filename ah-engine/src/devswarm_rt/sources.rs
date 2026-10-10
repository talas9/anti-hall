//! Read-only sources of workspace state. Nothing here writes to a source (invariant I5): the app database is opened
//! `SQLITE_OPEN_READ_ONLY` through the mesh lane's reader, the other files are only read.
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::devswarm_rt::state::{Ci, PrState};
use crate::meshw::appdb;
use crate::meshw::idlock::devswarm_root;
use crate::meshw::{ident, union};
use rusqlite::types::ValueRef;
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// One `builders` row.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AppBuilder {
    /// The builder (workspace) id.
    pub id: String,
    /// `isActive` (None: not 0 or 1, or the column is missing).
    pub active: Option<bool>,
    /// `isHidden` (None: not 0 or 1, or the column is missing).
    pub hidden: Option<bool>,
    /// The worktree path.
    pub worktree: Option<String>,
    /// The branch.
    pub branch: Option<String>,
    /// The repository id.
    pub repo: Option<String>,
    /// The label.
    pub label: Option<String>,
    /// The builder type.
    pub builder_type: Option<String>,
    /// The linked `pull_requests.id`.
    pub pr_id: Option<String>,
}

/// One `builder_terminals` row.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AppTerminal {
    /// The builder it belongs to.
    pub builder_id: String,
    /// `panelStatus`.
    pub panel: Option<String>,
    /// `isActive`.
    pub active: Option<bool>,
}

/// One `pull_requests` row.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AppPr {
    /// The row id.
    pub id: String,
    /// The PR number.
    pub number: Option<i64>,
    /// `state`.
    pub state: Option<String>,
    /// `checkStatus`.
    pub checks: Option<String>,
    /// `lastSyncedAt`, as epoch ms.
    pub synced_ms: Option<i64>,
}

/// What one read of the app database found.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AppRead {
    /// Every builder row.
    pub builders: Vec<AppBuilder>,
    /// Every terminal row; `None` when that table could not be read (the paused evidence is then unknown, not absent).
    pub terminals: Option<Vec<AppTerminal>>,
    /// Every PR row; `None` when that table could not be read.
    pub prs: Option<Vec<AppPr>>,
    /// Signature of the database and WAL files (mtime, size), the source signature of everything read from it.
    pub sig: String,
}

/// Facts about one PR, supplied by the GitHub realtime feature (A) when it is enabled. Defined here as a trait so this lane
/// does not depend on A's code.
pub trait GithubState: Send + Sync {
    /// The PR for a workspace's worktree and branch, `None` when A has no answer for it.
    fn pr(&self, worktree: &str, branch: &str) -> Option<GhPr>;
}

/// One PR as the GitHub feature reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct GhPr {
    /// PR number.
    pub number: Option<i64>,
    /// PR state.
    pub state: PrState,
    /// CI roll-up.
    pub checks: Ci,
    /// When A observed it (epoch ms).
    pub observed_ms: i64,
}

/// The file-based facts about a workspace. A trait so tests (and the mesh lanes' fixtures) can stand in.
pub trait Probe {
    /// The last heartbeat time of a workspace (epoch ms), `None` when unknown.
    fn heartbeat_ms(&self, id: &str) -> Option<i64>;
    /// The step being worked on, from the workspace's plan, `None` when unknown or no step is in progress.
    fn plan_step(&self, worktree: &str) -> Option<String>;
    /// Unread mesh messages, `None` when the store cannot be read.
    fn unread(&self, id: &str) -> Option<usize>;
    /// The times (epoch ms) of the other activity of a workspace that is not its heartbeat: its transcript being written, its git
    /// directory changing. Empty when the probe knows none. A source that does not exist for the workspace is simply not listed.
    fn other_activity_ms(&self, _id: &str, _worktree: Option<&str>) -> Vec<i64> {
        Vec::new()
    }
}

fn flag(v: ValueRef<'_>) -> Option<bool> {
    match v {
        ValueRef::Integer(0) => Some(false),
        ValueRef::Integer(1) => Some(true),
        _ => None,
    }
}

fn text(v: ValueRef<'_>) -> Option<String> {
    match v {
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Integer(i) => Some(i.to_string()),
        ValueRef::Real(f) => Some(f.to_string()),
        ValueRef::Null | ValueRef::Blob(_) => None,
    }
}

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` as epoch ms (the engine's one ISO parser, shared with the task-state reader); `None` for any other shape.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    crate::checks::taskstate::tail::parse_iso_ms(s).ok().flatten().map(|f| f as i64)
}

fn have_cols(conn: &rusqlite::Connection, table: &str) -> Option<Vec<String>> {
    let q = format!("{}{table}{}", crate::sql::MESHW_APP_TABLE_INFO_OPEN, crate::sql::MESHW_APP_TABLE_INFO_CLOSE);
    let mut st = conn.prepare(&q).ok()?;
    let cols: Vec<String> = st.query_map([], |r| r.get::<_, String>(1)).ok()?.collect::<Result<_, _>>().ok()?;
    (!cols.is_empty()).then_some(cols)
}

/// Rows of the wanted columns that the table has, as `(column -> value)` readers. `None` when the table or a read fails.
fn rows(conn: &rusqlite::Connection, table: &str, want: &[&str]) -> Option<(Vec<String>, Vec<Vec<rusqlite::types::Value>>)> {
    let have = have_cols(conn, table)?;
    let present: Vec<String> = want.iter().filter(|w| have.iter().any(|h| h == *w)).map(|w| (*w).to_string()).collect();
    if present.is_empty() {
        return None;
    }
    let q = crate::sql::MESHW_APP_QUOTE;
    let list: Vec<String> = present.iter().map(|c| format!("{q}{c}{q}")).collect();
    let sel = format!("{}{}{}{q}{table}{q}", crate::sql::MESHW_APP_SELECT, list.join(crate::sql::MESHW_APP_LIST_SEP), crate::sql::MESHW_APP_FROM);
    let mut st = conn.prepare(&sel).ok()?;
    let mut rs = st.query([]).ok()?;
    let mut out = Vec::new();
    loop {
        match rs.next() {
            Ok(Some(r)) => {
                let mut row = Vec::with_capacity(present.len());
                for i in 0..present.len() {
                    row.push(r.get::<_, rusqlite::types::Value>(i).ok()?);
                }
                out.push(row);
            }
            Ok(None) => break,
            Err(_) => return None,
        }
    }
    Some((present, out))
}

fn cell<'a>(cols: &[String], row: &'a [rusqlite::types::Value], name: &str) -> Option<ValueRef<'a>> {
    cols.iter().position(|c| c == name).and_then(|i| row.get(i)).map(rusqlite::types::Value::as_ref_value)
}

trait AsRefValue {
    fn as_ref_value(&self) -> ValueRef<'_>;
}
impl AsRefValue for rusqlite::types::Value {
    fn as_ref_value(&self) -> ValueRef<'_> {
        ValueRef::from(self)
    }
}

/// Signature of the app database: its mtime and size and its WAL's.
pub fn db_sig(file: &Path) -> String {
    let one = |p: &Path| std::fs::metadata(p).map(|m| format!("{}.{}:{}", m.mtime(), m.mtime_nsec(), m.size())).unwrap_or_default();
    let mut wal = file.as_os_str().to_os_string();
    wal.push(defaults::text("mesh_write.app_wal_suffix"));
    format!("{}|{}", one(file), one(Path::new(&wal)))
}

/// Read the app database. `None` is "unreadable" (no file, locked beyond the busy timeout, unexpected shape): the caller keeps
/// no opinion (invariant I1). A missing terminals or PR table is reported inside the result, not as a failure.
pub fn read_app(file: &Path) -> Option<AppRead> {
    let f = file.to_str()?;
    if !file.is_file() {
        return None;
    }
    let conn = appdb::open(f)?;
    let c = |k: &str| defaults::text(k);
    let bcols = [
        c("mesh_write.app_col_id"),
        c("mesh_write.app_col_active"),
        c("mesh_write.app_col_hidden"),
        c("mesh_write.app_col_worktree"),
        c("mesh_write.app_col_builder_type"),
        c("devswarm_rt.col_branch"),
        c("devswarm_rt.col_repo"),
        c("devswarm_rt.col_label"),
        c("devswarm_rt.col_pr"),
    ];
    let (cols, brows) = rows(&conn, c("mesh_write.app_table_builders"), &bcols)?;
    if !cols.iter().any(|x| x == c("mesh_write.app_col_id")) || !cols.iter().any(|x| x == c("mesh_write.app_col_active")) {
        return None;
    }
    let mut builders = Vec::new();
    for r in &brows {
        let get = |k: &str| cell(&cols, r, c(k));
        let Some(id) = get("mesh_write.app_col_id").and_then(text) else { continue };
        builders.push(AppBuilder {
            id,
            active: get("mesh_write.app_col_active").and_then(flag),
            hidden: get("mesh_write.app_col_hidden").and_then(flag),
            worktree: get("mesh_write.app_col_worktree").and_then(text).filter(|s| !s.is_empty()),
            branch: get("devswarm_rt.col_branch").and_then(text).filter(|s| !s.is_empty()),
            repo: get("devswarm_rt.col_repo").and_then(text),
            label: get("devswarm_rt.col_label").and_then(text),
            builder_type: get("mesh_write.app_col_builder_type").and_then(text),
            pr_id: get("devswarm_rt.col_pr").and_then(text),
        });
    }
    let tcols = [c("devswarm_rt.col_term_builder"), c("devswarm_rt.col_term_panel"), c("devswarm_rt.col_term_active")];
    let terminals = rows(&conn, c("mesh_write.app_table_terminals"), &tcols).map(|(cols, rs)| {
        rs.iter()
            .filter_map(|r| {
                let get = |k: &str| cell(&cols, r, c(k));
                Some(AppTerminal {
                    builder_id: get("devswarm_rt.col_term_builder").and_then(text)?,
                    panel: get("devswarm_rt.col_term_panel").and_then(text),
                    active: get("devswarm_rt.col_term_active").and_then(flag),
                })
            })
            .collect()
    });
    let pcols = [
        c("devswarm_rt.col_pr_id"),
        c("devswarm_rt.col_pr_number"),
        c("devswarm_rt.col_pr_state"),
        c("devswarm_rt.col_pr_checks"),
        c("devswarm_rt.col_pr_synced"),
    ];
    let prs = rows(&conn, c("mesh_write.app_table_pull_requests"), &pcols).map(|(cols, rs)| {
        rs.iter()
            .filter_map(|r| {
                let get = |k: &str| cell(&cols, r, c(k));
                Some(AppPr {
                    id: get("devswarm_rt.col_pr_id").and_then(text)?,
                    number: get("devswarm_rt.col_pr_number").and_then(|v| if let ValueRef::Integer(i) = v { Some(i) } else { None }),
                    state: get("devswarm_rt.col_pr_state").and_then(text),
                    checks: get("devswarm_rt.col_pr_checks").and_then(text),
                    synced_ms: get("devswarm_rt.col_pr_synced").and_then(text).and_then(|s| parse_iso_ms(&s)),
                })
            })
            .collect()
    });
    Some(AppRead { builders, terminals, prs, sig: db_sig(file) })
}

/// The file-system probe: heartbeats, plans and the mesh unread union under the DevSwarm state directory.
pub struct FsProbe {
    home: PathBuf,
    now: i64,
    plans: OnceLock<HashMap<String, PathBuf>>,
}

impl FsProbe {
    /// A probe over `home`'s DevSwarm directory; `now` is the clock the unread union uses.
    pub fn new(home: &Path, now: i64) -> FsProbe {
        FsProbe { home: home.to_path_buf(), now, plans: OnceLock::new() }
    }
    fn dir(&self, key: &str) -> PathBuf {
        devswarm_root(&self.home).join(defaults::text(key))
    }
    fn json(&self, dir: &str, id: &str) -> PathBuf {
        self.dir(dir).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")))
    }
    fn read_json(p: &Path) -> Option<OVal> {
        OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))
    }
    /// worktree -> plan file, scanned once per probe.
    fn plan_files(&self) -> &HashMap<String, PathBuf> {
        self.plans.get_or_init(|| {
            let mut m = HashMap::new();
            let Ok(rd) = std::fs::read_dir(self.dir("mesh_write.dir_plans")) else { return m };
            for e in rd.flatten() {
                let p = e.path();
                if let Some(OVal::Str(wt)) = Self::read_json(&p).and_then(|j| j.get(defaults::text("devswarm_rt.plan_key_worktree")).cloned()) {
                    m.insert(wt, p);
                }
            }
            m
        })
    }
}

impl Probe for FsProbe {
    fn heartbeat_ms(&self, id: &str) -> Option<i64> {
        match Self::read_json(&self.json("mesh_write.dir_heartbeats", id))?.get(defaults::text("devswarm_rt.heartbeat_key_ts")) {
            Some(OVal::Num(n)) if n.is_finite() && *n > 0.0 => Some(*n as i64),
            _ => None,
        }
    }
    fn plan_step(&self, worktree: &str) -> Option<String> {
        let j = Self::read_json(self.plan_files().get(worktree)?)?;
        let OVal::Arr(steps) = j.get(defaults::text("devswarm_rt.plan_key_steps"))? else { return None };
        steps.iter().find_map(|s| match (s.get(defaults::text("devswarm_rt.plan_key_status")), s.get(defaults::text("devswarm_rt.plan_key_n"))) {
            (Some(OVal::Str(st)), Some(OVal::Num(n))) if st == defaults::text("devswarm_rt.plan_status_doing") => {
                Some(crate::checks::jsport::num::to_js_string(*n))
            }
            _ => None,
        })
    }
    fn other_activity_ms(&self, id: &str, worktree: Option<&str>) -> Vec<i64> {
        use crate::dswire::facts;
        let wanted = defaults::list("devswarm_rt.stall_sources");
        let mtime = |p: &Path| {
            std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64)
        };
        let mut out = Vec::new();
        if wanted.contains(&"transcript") {
            let descs = facts::descriptors(&self.home);
            out.extend(
                descs
                    .iter()
                    .filter(|d| d.id == id || worktree == Some(d.worktree.as_str()))
                    .filter_map(|d| mtime(&facts::transcript_path(&self.home, &d.worktree, &d.session))),
            );
        }
        if wanted.contains(&"git")
            && let Some(g) = worktree.and_then(facts::git_dir)
        {
            // the git directory is ONE source: the newest of its files
            out.extend(defaults::list("devswarm_rt.stall_git_paths").iter().filter_map(|n| mtime(&g.join(n))).max());
        }
        out
    }
    fn unread(&self, id: &str) -> Option<usize> {
        let desc = Self::read_json(&self.json("mesh_write.dir_workspaces", id))?;
        let inbox = union::path_field(&desc, defaults::text("mesh_write.field_inbox_path")).ok()?;
        let cursor = union::path_field(&desc, defaults::text("mesh_write.field_cursor_path")).ok()?;
        let wt = union::path_field(&desc, defaults::text("mesh_write.field_worktree_path")).ok()??;
        let reader = match ident::repo_key_for_worktree(&wt).ok()? {
            Some(key) => {
                let dir = union::store_dir(&self.home, &key);
                let marker = std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker"))).map(|m| m.trim().to_lowercase()).unwrap_or_default();
                let db = dir.join(defaults::text("mesh_write.store_file"));
                if marker == defaults::text("mesh.backend_sqlite") && db.exists() { Some(crate::mesh::MeshReader::open(&db).ok()?) } else { None }
            }
            None => None,
        };
        let (store_base, nd_base) = match &reader {
            Some(r) => union::floor_bases(r, &self.home, id, cursor.as_deref()).ok()?,
            None => (0.0, 0.0),
        };
        let u = union::union_unread(&union::UnionIn {
            inbox: inbox.as_deref(),
            cursor_file: cursor.as_deref(),
            id,
            store: reader.as_ref(),
            store_base,
            nd_base,
            now: self.now,
        })
        .ok()?;
        Some(u.unread)
    }
}
