//! The Accounts & usage, Updates and Logs screens' side of the server. Everything it reads or runs is named in the plugin's
//! `web_ops.toml` (`web.ops_cfg_rel` in `web.toml`): the usage cache and account file paths, the engine arguments, the log sources and
//! the level rules. It never opens a credential: the account file is reduced to an allow-list of plan fields and a fingerprint, the
//! Codex login file is only looked at for its existence, and the update check refuses to run unless its arguments contain `--check`.
use crate::app::App;
use crate::ctl;
use crate::server::{cookie_ok, refuse};
use ah_web_proto::ops::{Accounts, Bucket, ClaudeAccount, CodexAccount, CostRow, LogLine, LogTail, OpsCfg, UpdateCheck};
use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type Shared = Arc<App>;

#[derive(Debug, Clone, Deserialize)]
struct BucketDef {
    id: String,
    pct: String,
    resets: String,
    label_key: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ScopedKeys {
    label: String,
    pct: String,
    resets: String,
}

#[derive(Debug, Clone, Deserialize)]
struct FieldDef {
    field: String,
    label_key: String,
}

#[derive(Debug, Clone, Deserialize)]
struct SourceDef {
    id: String,
    label_key: String,
    file: String,
    format: String,
    ts: String,
    comp: String,
    level: String,
    text: String,
    level_mode: String,
}

#[derive(Debug, Clone, Deserialize)]
struct LevelRule {
    level: String,
    words: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TreeGlyphs {
    branch: String,
    last: String,
    pipe: String,
    gap: String,
}

/// Every `web.ops.*` value. No field has a default: a missing or mistyped key is a load error naming it.
#[derive(Debug, Clone, Deserialize)]
pub struct Ops {
    usage_cache_rel: String,
    usage_cache_max_bytes: u64,
    usage_stale_ms: u64,
    usage_warn_pct: f64,
    usage_bad_pct: f64,
    usage_buckets: Vec<BucketDef>,
    usage_scoped_field: String,
    usage_scoped_keys: ScopedKeys,
    usage_timestamp_field: String,
    usage_data_field: String,
    claude_json_rel: String,
    claude_json_max_bytes: u64,
    claude_account_fields: Vec<FieldDef>,
    claude_account_key: String,
    claude_user_key: String,
    fingerprint_chars: usize,
    codex_auth_rel: String,
    cost_ctl: String,
    cost_key: String,
    cost_rows: usize,
    cost_tree: TreeGlyphs,
    cost_name_fallback: String,
    poll_accounts_ms: u64,
    tick_ms: u64,
    update_args: Vec<String>,
    update_guard_flag: String,
    update_timeout_ms: u64,
    update_min_gap_ms: u64,
    update_text_max: usize,
    logs_sources: Vec<SourceDef>,
    logs_diag_args: Vec<String>,
    logs_cache_ms: u64,
    logs_timeout_ms: u64,
    logs_max_lines: usize,
    logs_text_max: usize,
    logs_view_max: usize,
    logs_poll_ms: u64,
    log_levels: Vec<String>,
    log_default_level: String,
    log_level_rules: Vec<LevelRule>,
    pub idle_shell_state: String,
    text: BTreeMap<String, String>,
}

impl Ops {
    fn load(path: &Path) -> Result<Ops, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let doc: toml::Table = text.parse().map_err(|e| format!("{}: {e}", path.display()))?;
        let ops = doc.get("web").and_then(|w| w.get("ops")).and_then(toml::Value::as_table).ok_or("no [web.ops] section")?;
        let mut flat = toml::Table::new();
        for (name, entry) in ops {
            if let Some(v) = entry.get("value") {
                flat.insert(name.clone(), v.clone());
            }
        }
        toml::Value::Table(flat).try_into().map_err(|e| format!("{}: {e}", path.display()))
    }

    /// The numbers the page needs.
    fn page(&self) -> OpsCfg {
        OpsCfg {
            warn_pct: self.usage_warn_pct,
            bad_pct: self.usage_bad_pct,
            stale_ms: self.usage_stale_ms,
            poll_accounts_ms: self.poll_accounts_ms,
            tick_ms: self.tick_ms,
            logs_poll_ms: self.logs_poll_ms,
            logs_view_max: self.logs_view_max,
            levels: self.log_levels.clone(),
            sources: self.logs_sources.iter().map(|s| (s.id.clone(), s.label_key.clone())).collect(),
        }
    }
}

/// The config, re-read when its file changes (checked per request: one `stat`).
fn ops(app: &App) -> Result<Arc<Ops>, String> {
    static CACHE: Mutex<Option<(std::path::PathBuf, SystemTime, Arc<Ops>)>> = Mutex::new(None);
    let path = app.root.join(&app.settings().ops_cfg_rel);
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut g = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((p, t, o)) = g.as_ref()
        && *p == path
        && *t == mtime
    {
        return Ok(o.clone());
    }
    let o = Arc::new(Ops::load(&path)?);
    *g = Some((path, mtime, o.clone()));
    Ok(o)
}

/// The page's labels with this screen group's texts added (the page keeps one label table).
pub fn merged_ui(app: &App, base: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut ui = base.clone();
    if let Ok(o) = ops(app) {
        ui.extend(o.text.clone());
    }
    ui
}

/// The registry status word that means "a shell command is running" (empty when the config is unreadable, so nothing matches).
pub fn idle_shell_state(app: &App) -> String {
    ops(app).map(|o| o.idle_shell_state.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// A gate every handler starts with: the session cookie, then the config.
fn gate(app: &App, headers: &HeaderMap) -> Result<Arc<Ops>, Response> {
    if !cookie_ok(app, headers) {
        return Err(refuse(app));
    }
    ops(app).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e).into_response())
}

/// `GET /api/ops/config`.
pub async fn config(State(app): State<Shared>, headers: HeaderMap) -> Response {
    match gate(&app, &headers) {
        Ok(o) => Json(o.page()).into_response(),
        Err(r) => r,
    }
}

fn home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

/// A JSON file read under a size cap; `None` when it is missing, too big or not JSON.
async fn read_json(path: &Path, max: u64) -> Option<Value> {
    let len = tokio::fs::metadata(path).await.ok()?.len();
    if len > max {
        return None;
    }
    serde_json::from_slice(&tokio::fs::read(path).await.ok()?).ok()
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn u(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

fn text_of(o: &Ops, key: &str) -> String {
    o.text.get(key).cloned().unwrap_or_else(|| key.to_string())
}

/// The buckets of the usage cache. `Err` when the file exists but cannot be used.
async fn usage(o: &Ops, home: &Path) -> (Vec<Bucket>, u64, bool) {
    let path = home.join(&o.usage_cache_rel);
    if tokio::fs::metadata(&path).await.is_err() {
        return (Vec::new(), 0, false);
    }
    let Some(doc) = read_json(&path, o.usage_cache_max_bytes).await else { return (Vec::new(), 0, true) };
    let data = doc.get(&o.usage_data_field).cloned().unwrap_or(Value::Null);
    let mut out = Vec::new();
    for d in &o.usage_buckets {
        if let Some(p) = data.get(&d.pct).and_then(Value::as_f64) {
            out.push(Bucket { id: d.id.clone(), label: text_of(o, &d.label_key), percent: p, resets_at: s(&data, &d.resets) });
        }
    }
    let k = &o.usage_scoped_keys;
    for b in data.get(&o.usage_scoped_field).and_then(Value::as_array).into_iter().flatten() {
        if let Some(p) = b.get(&k.pct).and_then(Value::as_f64) {
            out.push(Bucket { id: s(b, "id"), label: s(b, &k.label), percent: p, resets_at: s(b, &k.resets) });
        }
    }
    (out, u(&doc, &o.usage_timestamp_field), false)
}

/// The logged-in Claude account from the host file: the plan fields on the allow-list and a fingerprint of the user id.
async fn claude(o: &Ops, home: &Path) -> ClaudeAccount {
    let Some(doc) = read_json(&home.join(&o.claude_json_rel), o.claude_json_max_bytes).await else { return ClaudeAccount::default() };
    let account = doc.get(&o.claude_account_key).filter(|a| a.is_object());
    let fields = account
        .map(|a| {
            o.claude_account_fields
                .iter()
                .filter_map(|f| {
                    let v = a.get(&f.field)?;
                    let shown = match v {
                        Value::Bool(true) => text_of(o, "ops_yes"),
                        Value::Bool(false) => text_of(o, "ops_no"),
                        Value::String(t) => t.clone(),
                        Value::Null => return None,
                        other => other.to_string(),
                    };
                    Some((f.label_key.clone(), shown))
                })
                .collect()
        })
        .unwrap_or_default();
    ClaudeAccount { signed_in: account.is_some(), fingerprint: s(&doc, &o.claude_user_key).chars().take(o.fingerprint_chars).collect(), fields }
}

/// Codex's login: only the file's existence and modified time.
async fn codex(o: &Ops, home: &Path) -> CodexAccount {
    match tokio::fs::metadata(home.join(&o.codex_auth_rel)).await {
        Ok(m) => CodexAccount { signed_in: true, changed_ms: m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64) },
        Err(_) => CodexAccount::default(),
    }
}

/// The per-agent cost report from the engine, as a table: one header row per project (with its totals), under it the agents nested
/// parent -> child. `None` when the engine does not answer.
async fn cost(app: &App, o: &Ops) -> Option<(u64, u64, Vec<CostRow>)> {
    let st = app.settings();
    let doc = ctl::call(&app.socket, &o.cost_ctl, Duration::from_millis(st.ctl_timeout_ms), st.ctl_max_bytes).await.ok()?;
    let report = doc.get(&o.cost_key)?;
    let totals = report.get("totals").cloned().unwrap_or(Value::Null);
    let list = report.get("agents").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let mut rows: Vec<CostRow> = Vec::new();
    let mut agents: Vec<ah_web_proto::Agent> = Vec::new();
    for a in list.iter().take(o.cost_rows) {
        let mut row = CostRow { agent: s(a, "agent"), name: s(a, "name"), kind: s(a, "kind"), tokens: u(a, "tokens"), outcomes: u(a, "outcomes"), tokens_per_outcome: u(a, "tokens_per_outcome"), ..CostRow::default() };
        let (parent, project) = (s(a, "parent"), s(a, "project"));
        let mut node = ah_web_proto::Agent { id: row.agent.clone(), kind: row.kind.clone(), parent: if parent == row.agent { String::new() } else { parent }, project, state: "running".into(), ..Default::default() };
        // a session id is named by the agent list (and a project's Primary is a Primary, whatever the report calls its kind)
        if let Some(live) = app.model().lookup(&row.agent, st.placeholder_id_chars) {
            node.role = live.role.clone();
            if node.project.is_empty() {
                node.project = live.project.clone();
            }
            row.kind = if live.role == st.project_primary_role { "main".to_string() } else { live.kind.clone() };
            node.kind = row.kind.clone();
        }
        rows.push(row);
        agents.push(node);
    }
    // the same project and parent links the Agents screen draws; a stand-in for a parent the report does not list is dropped, so its
    // children are orphans of their project
    crate::hier::link(&st, &mut agents);
    agents.retain(|a| !a.placeholder);
    let by_id: HashMap<&str, usize> = agents.iter().enumerate().map(|(i, a)| (a.id.as_str(), i)).collect();
    for (row, a) in rows.iter_mut().zip(&agents) {
        if row.name.is_empty() {
            let id: String = row.agent.chars().take(st.placeholder_id_chars).collect();
            let dir = a.project.rsplit('/').find(|p| !p.is_empty()).unwrap_or_default();
            row.name = if dir.is_empty() { id } else { o.cost_name_fallback.replace("{dir}", dir).replace("{id}", &id) };
        }
    }
    // projects, biggest spender first; inside each, the tree
    let mut groups: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, a) in agents.iter().enumerate() {
        groups.entry(a.project_root.as_str()).or_default().push(i);
    }
    let mut groups: Vec<(u64, Vec<usize>)> = groups.into_values().map(|g| (g.iter().map(|&i| rows[i].tokens).sum::<u64>(), g)).collect();
    groups.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    let mut out = Vec::new();
    for (tokens, members) in groups {
        let outcomes: u64 = members.iter().map(|&i| rows[i].outcomes).sum();
        out.push(CostRow { name: agents[members[0]].project_name.clone(), tokens, outcomes, tokens_per_outcome: tokens.checked_div(outcomes).unwrap_or(0), header: true, ..CostRow::default() });
        let in_group: std::collections::HashSet<usize> = members.iter().copied().collect();
        let parent_of = |i: usize| by_id.get(agents[i].parent.as_str()).copied().filter(|p| *p != i && in_group.contains(p));
        let mut kids: HashMap<usize, Vec<usize>> = HashMap::new();
        let (mut roots, mut orphans) = (Vec::new(), Vec::new());
        for &i in &members {
            match parent_of(i) {
                Some(p) => kids.entry(p).or_default().push(i),
                None if agents[i].parent.is_empty() => roots.push(i),
                None => orphans.push(i),
            }
        }
        let by_tokens = |v: &mut Vec<usize>| v.sort_by_key(|&i| std::cmp::Reverse(rows[i].tokens));
        by_tokens(&mut roots);
        by_tokens(&mut orphans);
        kids.values_mut().for_each(by_tokens);
        let mut seen = std::collections::HashSet::new();
        // depth-first; `lead` is what every descendant's line starts with
        let mut stack: Vec<(usize, String, String)> = roots.iter().chain(&orphans).rev().map(|&i| (i, String::new(), String::new())).collect();
        while let Some((i, prefix, lead)) = stack.pop() {
            if !seen.insert(i) {
                continue;
            }
            let mut row = rows[i].clone();
            row.prefix = prefix;
            out.push(row);
            let children = kids.get(&i).map_or(&[][..], Vec::as_slice);
            for (n, &c) in children.iter().enumerate().rev() {
                let last = n + 1 == children.len();
                let (glyph, carry) = if last { (&o.cost_tree.last, &o.cost_tree.gap) } else { (&o.cost_tree.branch, &o.cost_tree.pipe) };
                stack.push((c, format!("{lead}{glyph}"), format!("{lead}{carry}")));
            }
        }
    }
    Some((u(&totals, "tokens"), u(&totals, "outcomes"), out))
}

/// `GET /api/ops/accounts`.
pub async fn accounts(State(app): State<Shared>, headers: HeaderMap) -> Response {
    let o = match gate(&app, &headers) {
        Ok(o) => o,
        Err(r) => return r,
    };
    let Some(home) = home() else { return (StatusCode::INTERNAL_SERVER_ERROR, text_of(&o, "ops_failed")).into_response() };
    let ((buckets, usage_read_ms, usage_error), claude, codex, cost) = tokio::join!(usage(&o, &home), claude(&o, &home), codex(&o, &home), cost(&app, &o));
    let (cost_ok, (cost_total_tokens, cost_total_outcomes, cost_rows)) = match cost {
        Some(c) => (true, c),
        None => (false, (0, 0, Vec::new())),
    };
    Json(Accounts { claude, codex, buckets, usage_read_ms, usage_error, cost_total_tokens, cost_total_outcomes, cost_rows, cost_ok }).into_response()
}

/// Dotted version text as comparable numbers (`0.301.0` -> [0, 301, 0]); anything non-numeric ends the list.
fn version_nums(v: &str) -> Vec<u64> {
    v.trim_start_matches('v').split(['.', '-', '+']).map_while(|p| p.parse().ok()).collect()
}

/// `POST /api/ops/update-check`: run the engine's `update --check` (read only), at most once per `update_min_gap_ms`.
pub async fn update_check(State(app): State<Shared>, headers: HeaderMap) -> Response {
    static LAST: tokio::sync::Mutex<Option<(Instant, UpdateCheck)>> = tokio::sync::Mutex::const_new(None);
    let o = match gate(&app, &headers) {
        Ok(o) => o,
        Err(r) => return r,
    };
    let failed = |message: String| Json(UpdateCheck { ok: false, message, checked_ms: now_ms(), ..UpdateCheck::default() }).into_response();
    // the one safety rule of this button: the arguments must say --check, or nothing runs
    if !o.update_args.iter().any(|a| *a == o.update_guard_flag) {
        return failed(text_of(&o, "ops_check_failed"));
    }
    // held across the run: a second press waits for the first and then reuses its answer
    let mut last = LAST.lock().await;
    if let Some((at, c)) = last.as_ref()
        && at.elapsed() < Duration::from_millis(o.update_min_gap_ms)
    {
        return Json(UpdateCheck { reused: true, ..c.clone() }).into_response();
    }
    let run = tokio::process::Command::new(&app.engine)
        .args(&o.update_args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_millis(o.update_timeout_ms), run).await else { return failed(text_of(&o, "ops_check_failed")) };
    // the human text ends with the JSON status line
    let stdout = String::from_utf8_lossy(&out.stdout);
    let status: Value = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).and_then(|l| serde_json::from_str(l).ok()).unwrap_or(Value::Null);
    if !status.is_object() {
        return failed(text_of(&o, "ops_check_failed"));
    }
    let (installed, latest) = (s(&status, "installed"), s(&status, "latest"));
    let available = !installed.is_empty() && !latest.is_empty() && version_nums(&latest) > version_nums(&installed);
    let c = UpdateCheck { ok: out.status.success(), installed, latest, message: s(&status, "action").chars().take(o.update_text_max).collect(), available, checked_ms: now_ms(), reused: false };
    *last = Some((Instant::now(), c.clone()));
    Json(c).into_response()
}

#[derive(Deserialize)]
pub struct LogQuery {
    src: String,
    since: Option<u64>,
}

/// The level of `field` under the source's mode: `fixed` means the field is the level itself.
fn level_of(o: &Ops, mode: &str, field: &str) -> String {
    if mode == "fixed" {
        return field.to_string();
    }
    let low = field.to_lowercase();
    o.log_level_rules.iter().find(|r| r.words.iter().any(|w| low.contains(w.as_str()))).map_or_else(|| o.log_default_level.clone(), |r| r.level.clone())
}

/// One raw line as a [`LogLine`]; `None` when it does not parse.
fn parse_line(o: &Ops, src: &SourceDef, raw: &str) -> Option<LogLine> {
    let cut = |t: String| -> String { t.chars().take(o.logs_text_max).collect() };
    let (ts, comp, level_field, text) = match src.format.as_str() {
        "tsv" => {
            let cols: Vec<&str> = raw.splitn(src.text.parse::<usize>().ok()? + 1, '\t').collect();
            let at = |k: &str| k.parse::<usize>().ok().and_then(|i| cols.get(i).copied()).unwrap_or_default();
            (at(&src.ts).parse::<u64>().ok()?, at(&src.comp).to_string(), at(&src.level).to_string(), at(&src.text).to_string())
        }
        _ => {
            let v: Value = serde_json::from_str(raw).ok()?;
            let member = |k: &str| match v.get(k) {
                Some(Value::String(t)) => t.clone(),
                Some(Value::Null) | None => String::new(),
                Some(other) => other.to_string(),
            };
            let text = src.text.split(',').map(|k| member(k.trim())).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ");
            (v.get(&src.ts).and_then(Value::as_u64)?, member(&src.comp), if src.level_mode == "fixed" { src.level.clone() } else { member(&src.level) }, text)
        }
    };
    let level = level_of(o, &src.level_mode, &level_field);
    Some(LogLine { ts_ms: ts, level, comp, text: cut(text) })
}

/// The parsed tail of one source, reused for `logs_cache_ms`.
async fn tail(app: &App, o: &Ops, src: &SourceDef) -> Result<(Vec<LogLine>, bool), String> {
    type Cache = Mutex<HashMap<String, (Instant, Vec<LogLine>, bool)>>;
    static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, lines, cut)) = cache.lock().unwrap_or_else(|p| p.into_inner()).get(&src.id)
        && at.elapsed() < Duration::from_millis(o.logs_cache_ms)
    {
        return Ok((lines.clone(), *cut));
    }
    let args: Vec<String> = o.logs_diag_args.iter().map(|a| a.replace("{file}", &src.file)).collect();
    let run = tokio::process::Command::new(&app.engine).args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true).output();
    let out = tokio::time::timeout(Duration::from_millis(o.logs_timeout_ms), run).await.map_err(|_| "timeout".to_string())?.map_err(|e| e.to_string())?;
    let doc: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    if let Some(e) = doc.get("error").and_then(Value::as_str) {
        return Err(e.to_string());
    }
    let mut lines: Vec<LogLine> = doc.get("lines").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).filter_map(|l| parse_line(o, src, l)).collect();
    let skip = lines.len().saturating_sub(o.logs_max_lines);
    lines.drain(..skip);
    let cut = doc.get("truncated").and_then(Value::as_bool).unwrap_or(false) || skip > 0;
    cache.lock().unwrap_or_else(|p| p.into_inner()).insert(src.id.clone(), (Instant::now(), lines.clone(), cut));
    Ok((lines, cut))
}

/// `GET /api/ops/logs?src=<id>&since=<ts_ms>`: the lines of one log newer than `since`.
pub async fn logs(State(app): State<Shared>, headers: HeaderMap, Query(q): Query<LogQuery>) -> Response {
    let o = match gate(&app, &headers) {
        Ok(o) => o,
        Err(r) => return r,
    };
    // only a source named in the config is ever read: the id picks the file, the request never names one
    let Some(src) = o.logs_sources.iter().find(|x| x.id == q.src).cloned() else { return (StatusCode::NOT_FOUND, text_of(&o, "ops_failed")).into_response() };
    let since = q.since.unwrap_or(0);
    match tail(&app, &o, &src).await {
        Ok((lines, truncated)) => Json(LogTail { ok: true, lines: lines.into_iter().filter(|l| l.ts_ms > since).collect(), truncated, error: String::new() }).into_response(),
        Err(error) => Json(LogTail { ok: false, lines: Vec::new(), truncated: false, error }).into_response(),
    }
}
