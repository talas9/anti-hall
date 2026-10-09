//! The DevSwarm desktop app's database as one in-memory snapshot, ported from `companion/lib/devswarm-app-db.js` (`readSnapshot`,
//! `workspaceFor`, `briefDelivery`, `finishSignal`, `focusedWorkspaceId`, `transcriptCwdMatches`, `messageTimestamps`). The
//! database is opened read only and never waited for; an unreadable or unexpected one is `Ok(None)`, Node's `null` ("no
//! opinion"). Anything the engine cannot read like JavaScript does (a blob, an integer past 2^53, a date string V8's parser
//! might read differently, a relative path) is a [`Defer`]: the whole app sync is then Node's, before anything is written.
//!
//! The capability gate Node asks per table and column reduces to "the table/column/file exists", which the reads below test
//! anyway, so it adds nothing and `gated` is always empty.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep: Node's reader is fail-open
// (`try { ... } catch (_) { return null }`) and every optional file (the app version, a scrollback log, a transcript) is
// "absent" when unreadable.
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_number_of_str;
use crate::checks::jsport::date::{self, Parsed};
use crate::defaults;
use crate::meshw::appdb::{col_set, norm_path, open, select_for};
use crate::meshw::ident::{R, defer};
use rusqlite::types::ValueRef;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A JavaScript value read from a cell.
#[derive(Debug, Clone, PartialEq)]
pub enum J {
    /// `null`.
    Null,
    /// A number.
    Num(f64),
    /// A string.
    Str(String),
}

fn jv(v: ValueRef<'_>) -> R<J> {
    Ok(match v {
        ValueRef::Null => J::Null,
        ValueRef::Integer(i) => {
            if i.unsigned_abs() > defaults::num("mesh.js_safe_int") {
                return defer("app-db-int-range");
            }
            J::Num(i as f64)
        }
        ValueRef::Real(f) => J::Num(f),
        ValueRef::Text(t) => J::Str(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => return defer("app-db-blob"),
    })
}

impl J {
    /// `x == null ? null : String(x)`.
    pub fn string(&self) -> Option<String> {
        match self {
            J::Null => None,
            J::Num(n) => Some(crate::checks::guardkit::ojson::js_number_text(*n)),
            J::Str(s) => Some(s.clone()),
        }
    }

    /// `Number(x)` (`null` is 0).
    pub fn number(&self) -> f64 {
        match self {
            J::Null => 0.0,
            J::Num(n) => *n,
            J::Str(s) => js_number_of_str(s),
        }
    }

    fn is_null(&self) -> bool {
        matches!(self, J::Null)
    }

    /// `x == null ? null : Number(x) === 1`.
    fn flag(&self) -> Option<bool> {
        (!self.is_null()).then(|| self.number() == 1.0)
    }

    /// `tsMs(v)`: epoch ms, `None` for null, empty, non-positive or unparsable; a date string whose V8 reading is not certain defers.
    fn ts(&self) -> R<Option<f64>> {
        let n = match self {
            J::Null => return Ok(None),
            J::Str(s) if s.is_empty() => return Ok(None),
            J::Num(n) => *n,
            J::Str(s) => match date::parse(s) {
                Parsed::Ms(ms) => ms,
                Parsed::Nan => return Ok(None),
                Parsed::Unknown => return defer("app-db-date"),
            },
        };
        Ok((n.is_finite() && n > 0.0).then_some(n))
    }
}

/// One terminal of a builder.
#[derive(Debug, Clone)]
pub struct Term {
    /// `terminalId`.
    pub terminal_id: Option<String>,
    /// `terminalType`.
    pub terminal_type: Option<String>,
    /// The session id from `ai_session_config`.
    pub session_id: Option<String>,
    /// `isActive`.
    pub is_active: Option<bool>,
    /// `panelStatus`.
    pub panel_status: Option<String>,
    /// `createdAt` ms.
    pub created_at: Option<f64>,
    /// An initial prompt exists.
    pub brief_pending: bool,
    /// `initialPromptDeliveredAt` ms.
    pub delivered_at: Option<f64>,
    /// `initialPromptWithheldAt` ms.
    pub withheld_at: Option<f64>,
}

/// A pull request.
#[derive(Debug, Clone)]
pub struct Pr {
    /// `number`.
    pub number: Option<f64>,
    /// `state`.
    pub state: Option<String>,
    /// `isDraft`.
    pub is_draft: Option<bool>,
    /// `checkStatus`.
    pub check_status: Option<String>,
    /// `lastSyncedAt` ms.
    pub last_synced_at: Option<f64>,
}

/// A repository.
#[derive(Debug, Clone)]
pub struct Repo {
    /// `id`.
    pub id: String,
    /// `normPath(path)`.
    pub path: Option<String>,
    /// `name`.
    pub name: Option<String>,
}

/// A builder (workspace).
#[derive(Debug, Clone)]
pub struct Ws {
    /// `id`.
    pub id: String,
    /// `repositoryId`.
    pub repository_id: Option<String>,
    /// `label`.
    pub label: Option<String>,
    /// `branchName`.
    pub branch_name: Option<String>,
    /// `normPath(worktreePath)`.
    pub worktree_path: Option<String>,
    /// The worktree path as the app stored it.
    pub worktree_path_raw: Option<String>,
    /// `builderType`.
    pub builder_type: Option<String>,
    /// `rank`.
    pub rank: Option<f64>,
    /// `isPinned`.
    pub is_pinned: Option<bool>,
    /// `isHidden`.
    pub is_hidden: Option<bool>,
    /// Open in the app.
    pub active: bool,
    /// Archived in the app.
    pub archived: bool,
    /// `lastSelectedAt` ms.
    pub last_selected_at: Option<f64>,
    /// The pull request.
    pub pull_request: Option<Pr>,
    /// Its terminals.
    pub terminals: Vec<Term>,
    /// The current AI terminal's session.
    pub session_id: Option<String>,
    /// The current AI terminal, when open.
    pub ai_active: Option<Term>,
    /// The scrollback log's `(mtimeMs, size)`.
    pub scrollback: Option<(f64, u64)>,
}

/// The snapshot.
#[derive(Debug, Clone)]
pub struct Snap {
    /// `appVersion`.
    pub app_version: Option<String>,
    /// Missing tables and columns.
    pub missing: Vec<String>,
    /// The earliest recorded prompt delivery.
    pub delivery_tracked_since: Option<f64>,
    /// Repositories.
    pub repositories: Vec<Repo>,
    /// Workspaces, in table order.
    pub workspaces: Vec<Ws>,
}

fn table_rows(conn: &rusqlite::Connection, table: &str, schema: &[&str], missing: &mut Vec<String>) -> R<Option<Vec<HashMap<String, J>>>> {
    let Some(have) = col_set(conn, table) else {
        missing.push(format!("{table}{}", defaults::text("devswarm_sup.as_missing_table")));
        return Ok(Some(Vec::new()));
    };
    let mut present: Vec<&str> = Vec::new();
    for c in schema {
        if have.iter().any(|h| h == c) {
            present.push(c);
        } else {
            missing.push(format!("{table}.{c}"));
        }
    }
    let Some(q) = select_for(table, schema, &have) else { return Ok(Some(Vec::new())) };
    let prompt = defaults::text("mesh_write.app_prompt_column");
    let Ok(mut st) = conn.prepare(&q) else { return Ok(None) };
    let Ok(mut rows) = st.query([]) else { return Ok(None) };
    let mut out = Vec::new();
    loop {
        let r = match rows.next() {
            Ok(Some(r)) => r,
            Ok(None) => break,
            Err(_) => return Ok(None),
        };
        let mut m = HashMap::new();
        for (i, c) in present.iter().enumerate() {
            let Ok(v) = r.get_ref(i) else { return Ok(None) };
            let key = if *c == prompt { defaults::text("devswarm_sup.as_prompt_len") } else { c };
            m.insert((*key).to_string(), jv(v)?);
        }
        out.push(m);
    }
    Ok(Some(out))
}

fn get<'a>(m: &'a HashMap<String, J>, k: &str) -> &'a J {
    match m.get(k) {
        Some(j) => j,
        None => &J::Null,
    }
}

/// `parseSessionId(raw)`.
fn session_id_of(raw: &J) -> Option<String> {
    let text = raw.string()?;
    let v = OVal::parse(&text)?;
    match v.get("sessionId") {
        Some(OVal::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn scrollback_stat(db: &Path, terminal_id: &str) -> Option<(f64, u64)> {
    if !regex::Regex::new(defaults::text("devswarm_sup.as_scrollback_id_re")).ok()?.is_match(terminal_id) {
        return None;
    }
    let file = db.parent()?.join(defaults::text("devswarm_sup.as_scrollback_dir")).join(format!("{}{}", terminal_id.replace('.', "_"), defaults::text("devswarm_sup.as_scrollback_ext")));
    let m = std::fs::metadata(file).ok()?;
    Some((crate::checks::jsport::fsx::mtime_ms(&m), m.len()))
}

fn app_version(db: &Path) -> Option<String> {
    let f = db.parent()?.join(defaults::text("devswarm_sup.as_sentry_dir")).join(defaults::text("devswarm_sup.as_sentry_file"));
    match OVal::parse(&String::from_utf8_lossy(&std::fs::read(f).ok()?))?.get(defaults::text("devswarm_sup.as_sentry_key")) {
        Some(OVal::Str(s)) => Some(s.clone()),
        _ => None,
    }
}

/// `readSnapshot(file)`; `Ok(None)` is Node's null.
pub fn read(file: &str) -> R<Option<Snap>> {
    if !std::fs::metadata(file).is_ok_and(|m| m.is_file()) {
        return Ok(None);
    }
    let Some(conn) = open(file) else { return Ok(None) };
    let Some(bcols) = col_set(&conn, defaults::text("mesh_write.app_table_builders")) else { return Ok(None) };
    for core in defaults::list("mesh_write.app_core_columns") {
        if !bcols.iter().any(|c| c == core) {
            return Ok(None);
        }
    }
    let mut missing = Vec::new();
    let t = |k: &str| defaults::text(k);
    let Some(builders) = table_rows(&conn, t("mesh_write.app_table_builders"), &defaults::list("mesh_write.app_cols_builders"), &mut missing)? else { return Ok(None) };
    let Some(terminals) = table_rows(&conn, t("mesh_write.app_table_terminals"), &defaults::list("mesh_write.app_cols_builder_terminals"), &mut missing)? else { return Ok(None) };
    let Some(prs) = table_rows(&conn, t("mesh_write.app_table_pull_requests"), &defaults::list("mesh_write.app_cols_pull_requests"), &mut missing)? else { return Ok(None) };
    let Some(repos) = table_rows(&conn, t("mesh_write.app_table_repositories"), &defaults::list("mesh_write.app_cols_repositories"), &mut missing)? else { return Ok(None) };
    // workspace_messages is only schema-checked here
    match col_set(&conn, t("devswarm_sup.as_msg_table")) {
        None => missing.push(format!("{}{}", t("devswarm_sup.as_msg_table"), t("devswarm_sup.as_missing_table"))),
        Some(have) => {
            for c in defaults::list("devswarm_sup.as_msg_cols") {
                if !have.iter().any(|h| h == c) {
                    missing.push(format!("{}.{c}", t("devswarm_sup.as_msg_table")));
                }
            }
        }
    }
    let col = |k: &str| t(k);
    let (c_id, c_repo_id) = (col("devswarm_sup.as_c_id"), col("devswarm_sup.as_c_repository_id"));
    let mut repositories: Vec<Repo> = Vec::new();
    for r in &repos {
        let Some(id) = get(r, c_id).string() else { continue };
        let path = match get(r, col("devswarm_sup.as_c_path")) {
            J::Str(p) => norm_path(p)?,
            _ => None,
        };
        // the array keeps every row (`repos.filter().map()`)
        repositories.push(Repo { id, path, name: get(r, col("devswarm_sup.as_c_name")).string() });
    }
    let mut pr_by_id: HashMap<String, Pr> = HashMap::new();
    let mut pr_by_branch: HashMap<String, Pr> = HashMap::new();
    for p in &prs {
        let Some(id) = get(p, c_id).string() else { continue };
        let n = get(p, col("devswarm_sup.as_c_number"));
        let v = Pr {
            number: (!n.is_null()).then(|| n.number()),
            state: get(p, col("devswarm_sup.as_c_state")).string(),
            is_draft: get(p, col("devswarm_sup.as_c_is_draft")).flag(),
            check_status: get(p, col("devswarm_sup.as_c_check_status")).string(),
            last_synced_at: get(p, col("devswarm_sup.as_c_last_synced")).ts()?,
        };
        pr_by_id.insert(id, v.clone());
        if let (Some(r), Some(b)) = (get(p, c_repo_id).string(), get(p, col("devswarm_sup.as_c_branch_name")).string()) {
            pr_by_branch.insert(format!("{r}{}{b}", defaults::text("devswarm_sup.as_key_sep")), v);
        }
    }
    let mut delivery_tracked_since: Option<f64> = None;
    let mut terms_by_builder: HashMap<String, Vec<Term>> = HashMap::new();
    for t_ in &terminals {
        let Some(builder) = get(t_, col("devswarm_sup.as_c_builder_id")).string() else { continue };
        let d = get(t_, col("devswarm_sup.as_c_delivered")).ts()?;
        if let Some(d) = d
            && delivery_tracked_since.is_none_or(|s| d < s)
        {
            delivery_tracked_since = Some(d);
        }
        let plen = get(t_, col("devswarm_sup.as_prompt_len"));
        let v = Term {
            terminal_id: get(t_, col("devswarm_sup.as_c_terminal_id")).string(),
            terminal_type: get(t_, col("devswarm_sup.as_c_terminal_type")).string(),
            session_id: session_id_of(get(t_, col("devswarm_sup.as_c_session_config"))),
            is_active: get(t_, c_active()).flag(),
            panel_status: get(t_, col("devswarm_sup.as_c_panel_status")).string(),
            created_at: get(t_, col("devswarm_sup.as_c_created_at")).ts()?,
            brief_pending: !plen.is_null() && plen.number() > 0.0,
            delivered_at: d,
            withheld_at: get(t_, col("devswarm_sup.as_c_withheld")).ts()?,
        };
        terms_by_builder.entry(builder).or_default().push(v);
    }
    let has_hidden = bcols.iter().any(|c| c == col("devswarm_sup.as_c_is_hidden"));
    let mut workspaces: Vec<Ws> = Vec::new();
    let db_path = Path::new(file);
    for b in &builders {
        let Some(id) = get(b, c_id).string() else { continue };
        let is_active = get(b, c_active()).number();
        let active = is_active == 1.0;
        let archived = is_active == 0.0 && (!has_hidden || get(b, col("devswarm_sup.as_c_is_hidden")).number() == 1.0);
        let repo_id = get(b, c_repo_id).string();
        let branch = get(b, col("devswarm_sup.as_c_branch_name")).string();
        let by_id = get(b, col("devswarm_sup.as_c_pull_request_id")).string().and_then(|p| pr_by_id.get(&p).cloned());
        let pr = by_id.or_else(|| match (&repo_id, &branch) {
            (Some(r), Some(br)) => pr_by_branch.get(&format!("{r}{}{br}", defaults::text("devswarm_sup.as_key_sep"))).cloned(),
            _ => None,
        });
        let terms = terms_by_builder.get(&id).cloned().unwrap_or_default();
        let ai_type = defaults::text("devswarm_sup.as_ai_type");
        let mut ai_active: Option<Term> = None;
        for t_ in &terms {
            if t_.terminal_type.as_deref() != Some(ai_type) || t_.is_active != Some(true) {
                continue;
            }
            if ai_active.as_ref().is_none_or(|a| t_.created_at.unwrap_or(0.0) > a.created_at.unwrap_or(0.0)) {
                ai_active = Some(t_.clone());
            }
        }
        let wt_raw = get(b, col("devswarm_sup.as_c_worktree_path"));
        let worktree_path = match wt_raw {
            J::Str(p) => norm_path(p)?,
            _ => None,
        };
        let scrollback = if active { ai_active.as_ref().and_then(|a| a.terminal_id.as_deref()).and_then(|tid| scrollback_stat(db_path, tid)) } else { None };
        let rank = get(b, col("devswarm_sup.as_c_rank"));
        let ws = Ws {
            id,
            repository_id: repo_id,
            label: get(b, col("devswarm_sup.as_c_label")).string(),
            branch_name: branch,
            worktree_path,
            worktree_path_raw: wt_raw.string(),
            builder_type: get(b, col("devswarm_sup.as_c_builder_type")).string(),
            rank: (!rank.is_null()).then(|| rank.number()),
            is_pinned: get(b, col("devswarm_sup.as_c_is_pinned")).flag(),
            is_hidden: get(b, col("devswarm_sup.as_c_is_hidden")).flag(),
            active,
            archived,
            last_selected_at: get(b, col("devswarm_sup.as_c_last_selected")).ts()?,
            pull_request: pr,
            session_id: ai_active.as_ref().and_then(|a| a.session_id.clone()),
            ai_active,
            terminals: terms,
            scrollback,
        };
        // the creation and access times are read for their conversion errors only (Node's `tsMs` runs on them)
        get(b, col("devswarm_sup.as_c_created_at")).ts()?;
        get(b, col("devswarm_sup.as_c_last_accessed")).ts()?;
        workspaces.push(ws);
    }
    let version = app_version(db_path);
    Ok(Some(Snap { app_version: version, missing, delivery_tracked_since, repositories, workspaces }))
}

fn c_active() -> &'static str {
    defaults::text("devswarm_sup.as_c_is_active")
}

impl Snap {
    /// `workspaceFor(snap, { id, worktreePath })`.
    pub fn workspace_for(&self, id: Option<&str>, worktree: Option<&str>) -> R<Option<&Ws>> {
        if let Some(id) = id.filter(|i| !i.is_empty())
            && let Some(w) = self.workspaces.iter().find(|w| w.id == id)
        {
            return Ok(Some(w));
        }
        let Some(wt) = worktree.map(norm_path).transpose()?.flatten() else { return Ok(None) };
        Ok(self.workspaces.iter().find(|w| w.active && w.worktree_path.as_deref() == Some(wt.as_str())))
    }

    /// `focusedWorkspaceId(snap, now)`.
    pub fn focused(&self, now: f64) -> Option<&str> {
        let mut best: Option<(&str, f64)> = None;
        for w in &self.workspaces {
            if let Some(at) = w.last_selected_at
                && best.is_none_or(|(_, b)| at > b)
            {
                best = Some((&w.id, at));
            }
        }
        let (id, at) = best?;
        (now - at >= 0.0 && now - at <= defaults::num("devswarm_sup.as_focus_ms") as f64).then_some(id)
    }

    /// `briefDelivery(snap, ws, now)`: the status word.
    pub fn brief_status(&self, ws: &Ws, now: f64) -> Option<&'static str> {
        if !ws.active {
            return None;
        }
        let ai = defaults::text("devswarm_sup.as_ai_type");
        for term in &ws.terminals {
            if term.terminal_type.as_deref() != Some(ai) {
                continue;
            }
            let age = term.created_at.map(|c| now - c);
            if !term.brief_pending || term.delivered_at.is_some() {
                continue;
            }
            if term.withheld_at.is_some() {
                return Some(defaults::text("devswarm_sup.as_brief_withheld"));
            }
            match (self.delivery_tracked_since, term.created_at) {
                (Some(since), Some(c)) if c >= since => {}
                _ => continue,
            }
            let grace = defaults::num("devswarm_sup.as_brief_grace_ms") as f64;
            return Some(if age.is_some_and(|a| a >= grace) { defaults::text("devswarm_sup.as_brief_not_delivered") } else { defaults::text("devswarm_sup.as_brief_pending") });
        }
        None
    }
}

/// `branchTipMtimeMs(worktreePath, branchName)`: the modification time of the branch's loose ref file.
fn branch_tip_mtime(worktree: &str, branch: &str) -> Option<f64> {
    if worktree.is_empty() || branch.is_empty() || branch.contains("..") {
        return None;
    }
    let mut git_dir = PathBuf::from(worktree).join(defaults::text("devswarm_sup.as_git_entry"));
    let st = std::fs::metadata(&git_dir).ok()?;
    if st.is_file() {
        let text = String::from_utf8_lossy(&std::fs::read(&git_dir).ok()?).into_owned();
        let re = regex::Regex::new(defaults::text("devswarm_sup.as_gitdir_re")).ok()?;
        let m = re.captures(&text)?;
        git_dir = PathBuf::from(crate::meshw::ident::resolve(worktree, m[1].trim()));
    }
    let common = match std::fs::read(git_dir.join(defaults::text("devswarm_sup.as_commondir_file"))) {
        Ok(b) => PathBuf::from(crate::meshw::ident::resolve(&git_dir.to_string_lossy(), String::from_utf8_lossy(&b).trim())),
        Err(_) => git_dir,
    };
    let mut p = common.join(defaults::text("devswarm_sup.as_refs_dir"));
    for part in branch.split('/') {
        p.push(part);
    }
    std::fs::metadata(p).ok().map(|m| crate::checks::jsport::fsx::mtime_ms(&m))
}

/// `finishSignal(ws)`.
pub fn finish_signal(ws: &Ws) -> Option<String> {
    let pr = ws.pull_request.as_ref()?;
    let state = pr.state.as_ref().filter(|s| !s.is_empty())?;
    let tip = branch_tip_mtime(ws.worktree_path.as_deref()?, ws.branch_name.as_deref()?)?;
    let synced = pr.last_synced_at?;
    if synced <= tip {
        return None;
    }
    let mut s = String::from(defaults::text("devswarm_sup.as_pr_word"));
    if let Some(n) = pr.number {
        s.push_str(&format!(" #{}", crate::checks::guardkit::ojson::js_number_text(n)));
    }
    s.push(' ');
    s.push_str(state);
    if pr.is_draft == Some(true) {
        s.push_str(defaults::text("devswarm_sup.as_draft_suffix"));
    }
    if pr.check_status.as_deref().is_some_and(|c| c.to_ascii_lowercase().contains(defaults::text("devswarm_sup.as_fail_word"))) {
        s.push_str(defaults::text("devswarm_sup.as_checks_failed"));
    }
    Some(s)
}

/// `transcriptCwdMatches(home, sessionId, worktreePath)`: `Some(true/false)` or `None` (unverified).
pub fn transcript_cwd_matches(home: &Path, session: &str, worktree: &str) -> R<Option<bool>> {
    use std::io::Read;
    if worktree.is_empty() || !regex::Regex::new(defaults::text("devswarm_sup.as_sid_re")).is_ok_and(|r| r.is_match(session)) {
        return Ok(None);
    }
    let enc: String = worktree.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '.') { '-' } else { c }).collect();
    let file = home.join(defaults::text("devswarm_sup.as_projects_dir")).join(enc).join(format!("{session}{}", defaults::text("devswarm_sup.as_transcript_ext")));
    let Ok(f) = std::fs::File::open(file) else { return Ok(None) };
    let mut buf = Vec::new();
    if f.take(defaults::num("devswarm_sup.as_transcript_bytes")).read_to_end(&mut buf).is_err() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let Ok(re) = regex::Regex::new(defaults::text("devswarm_sup.as_cwd_re")) else { return Ok(None) };
    let Some(m) = re.captures(&text) else { return Ok(None) };
    let Some(OVal::Str(cwd)) = OVal::parse(&m[1]) else { return Ok(None) };
    Ok(Some(norm_path(&cwd)? == norm_path(worktree)?))
}

/// One app message row: the branch it went to and when it was created.
#[derive(Debug, Clone)]
pub struct AppMsg {
    /// `toBranch`.
    pub to_branch: Option<String>,
    /// `createdAt` ms.
    pub created_at: Option<f64>,
}

/// Repository id -> that repository's message rows.
pub type RepoMessages = Vec<(String, Vec<AppMsg>)>;

/// `messageTimestamps({ sinceMs: 0, untilMs })`: repository id -> rows, `Ok(None)` when unreadable (Node's null).
pub fn message_timestamps(file: &str, until_ms: f64) -> R<Option<RepoMessages>> {
    if !std::fs::metadata(file).is_ok_and(|m| m.is_file()) {
        return Ok(None);
    }
    let Some(conn) = open(file) else { return Ok(None) };
    let table = defaults::text("devswarm_sup.as_msg_table");
    let Some(have) = col_set(&conn, table) else { return Ok(None) };
    if !defaults::list("devswarm_sup.as_msg_cols").iter().all(|c| have.iter().any(|h| h == c)) {
        return Ok(None);
    }
    let Some(until) = date::to_iso(until_ms) else { return Ok(None) }; // `toISOString()` throws, Node's try/catch answers null
    let since = date::to_iso(0.0).unwrap_or_default();
    let Ok(mut st) = conn.prepare(crate::sql::AS_MESSAGES) else { return Ok(None) };
    let Ok(mut rows) = st.query(rusqlite::params![since, until]) else { return Ok(None) };
    let mut out: Vec<(String, Vec<AppMsg>)> = Vec::new();
    loop {
        let r = match rows.next() {
            Ok(Some(r)) => r,
            Ok(None) => break,
            Err(_) => return Ok(None),
        };
        let Ok(a) = r.get_ref(0) else { return Ok(None) };
        let Ok(b) = r.get_ref(1) else { return Ok(None) };
        let Ok(c) = r.get_ref(2) else { return Ok(None) };
        let (repo, branch, created) = (jv(a)?, jv(b)?, jv(c)?);
        let key = repo.string().unwrap_or_default();
        let msg = AppMsg { to_branch: branch.string(), created_at: created.ts()? };
        match out.iter_mut().find(|(k, _)| *k == key) {
            Some((_, v)) => v.push(msg),
            None => out.push((key, vec![msg])),
        }
    }
    Ok(Some(out))
}
