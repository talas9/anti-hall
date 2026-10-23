//! The Settings screens' side of the server: the engine's `describe` (settings, config files, checks, switches, Jev modes), its
//! per-check fire counts and the `config` write verbs (`set`, `reset`, `undo`, `history`), run as engine commands so the engine
//! validates, writes and audits every change. Nothing is written here. The texts and limits are in `web_manage.toml`, read next
//! to `web.toml` on each request (these screens are used rarely, so a small read costs less than a held copy).
use crate::app::App;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Duration;

/// The typed view of `web_manage.toml`.
#[derive(Debug, Clone, Deserialize)]
pub struct Cfg {
    pub describe_timeout_ms: u64,
    pub write_timeout_ms: u64,
    pub history_limit: usize,
    pub rows_max: usize,
    pub stats_limit: usize,
    pub key_max_chars: usize,
    pub value_max_chars: usize,
    pub actor: String,
    pub actor_env: String,
    pub jev_setting_prefix: String,
    pub jev_modes: Vec<String>,
    pub safety_categories: Vec<String>,
    pub guard_categories: Vec<String>,
    pub msg_bad_request: String,
    pub msg_flag_value: String,
    pub msg_timeout: String,
    pub msg_engine_failed: String,
    pub ui: BTreeMap<String, String>,
}

impl Cfg {
    /// Read the file beside `web.toml` (every `[web.manage.<name>]` table's `value`).
    pub fn load(web_toml: &std::path::Path, file: &str) -> Result<Cfg, String> {
        let path = web_toml.with_file_name(file);
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let doc: toml::Table = text.parse().map_err(|e| format!("{}: {e}", path.display()))?;
        let m = doc.get("web").and_then(|w| w.get("manage")).and_then(toml::Value::as_table).ok_or("no [web.manage] section")?;
        let mut flat = toml::Table::new();
        for (k, e) in m {
            if let Some(v) = e.get("value") {
                flat.insert(k.clone(), v.clone());
            }
        }
        toml::Value::Table(flat).try_into().map_err(|e| format!("{}: {e}", path.display()))
    }

    /// What the page needs at start: its texts and the few limits it shows.
    pub fn for_page(&self) -> Value {
        json!({ "ui": self.ui, "jev_modes": self.jev_modes, "safety_categories": self.safety_categories, "guard_categories": self.guard_categories, "rows_max": self.rows_max, "jev_prefix": self.jev_setting_prefix })
    }
}

/// Run `ah-engine <args>` and parse its JSON answer. The engine prints its refusals as JSON too, so a non-zero exit with JSON is an answer.
async fn engine(app: &App, c: &Cfg, args: &[String], timeout_ms: u64, actor: bool) -> Result<Value, String> {
    let mut cmd = tokio::process::Command::new(&app.engine);
    cmd.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    if actor {
        cmd.env(&c.actor_env, &c.actor);
    }
    match tokio::time::timeout(Duration::from_millis(timeout_ms), cmd.output()).await {
        Ok(Ok(out)) => serde_json::from_slice(&out.stdout).map_err(|_| c.msg_engine_failed.clone()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(c.msg_timeout.clone()),
    }
}

fn describe_args(part: &str) -> Vec<String> {
    ["describe", "--part", part, "--json"].iter().map(|s| s.to_string()).collect()
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// `GET /api/manage/data`: the settings registry, the checks (with their events, switch and fire counts), the Jev modes and the
/// config file list, reduced to what the page shows.
pub async fn data(app: &App, c: &Cfg) -> Result<Value, String> {
    let t = c.describe_timeout_ms;
    let doc = engine(app, c, &describe_args("settings_registry,checks,switches,jev_integrations,files"), t, false).await?;
    let stats = engine(app, c, &["query".into(), "checks".into(), "--limit".into(), c.stats_limit.to_string(), "--json".into()], t, false).await.unwrap_or(Value::Null);
    let fires: BTreeMap<String, &Value> = stats.get("rows").and_then(Value::as_array).map(|rows| rows.iter().map(|r| (s(r, "h"), r)).collect()).unwrap_or_default();
    let settings: Vec<Value> = doc.get("settings_registry").and_then(Value::as_array).cloned().unwrap_or_default();
    let by_id: BTreeMap<String, &Value> = settings.iter().map(|x| (s(x, "id"), x)).collect();
    let switches: BTreeMap<String, Value> = doc.get("switches").and_then(Value::as_array).map(|l| l.iter().map(|x| (s(x, "id"), x.clone())).collect()).unwrap_or_default();
    let checks: Vec<Value> = doc
        .get("checks")
        .and_then(Value::as_array)
        .map(|l| {
            l.iter()
                .map(|ch| {
                    let name = s(ch, "name");
                    let mut events: Vec<String> = ch.get("bindings").and_then(Value::as_array).map(|b| b.iter().map(|x| s(x, "event")).collect()).unwrap_or_default();
                    events.sort();
                    events.dedup();
                    let sw = ch.get("switch").and_then(Value::as_str).and_then(|id| switches.get(id));
                    let setting = sw.map(|x| s(x, "setting")).unwrap_or_default();
                    let reg = by_id.get(&setting);
                    let f = fires.get(&name);
                    json!({
                        "name": name, "summary": s(ch, "summary"), "events": events,
                        "setting": setting, "on": reg.and_then(|r| r.get("value")).cloned().or_else(|| sw.and_then(|x| x.get("value")).cloned()),
                        "registry": reg.is_some(), "category": reg.map(|r| s(r, "category")).unwrap_or_default(),
                        "safety_note": reg.map(|r| s(r, "safety_note")).unwrap_or_default(),
                        "fires": f.and_then(|r| r.get("n")).cloned(), "outcomes": f.and_then(|r| r.get("outcomes")).cloned(), "p50_us": f.and_then(|r| r.get("p50_us")).cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let files: Vec<Value> = doc
        .get("files")
        .and_then(Value::as_array)
        .map(|l| {
            l.iter()
                .map(|f| {
                    let changed = f.get("keys").and_then(Value::as_array).map_or(0, |k| k.iter().filter(|x| x.get("changed") == Some(&Value::Bool(true))).count());
                    json!({"file": s(f, "file"), "count": f.get("count"), "changed": changed})
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "settings": settings, "checks": checks, "jev": doc.get("jev_integrations"), "files": files, "generated_ms": doc.get("generated_ms") }))
}

/// `GET /api/manage/file?name=`: the keys of one config file.
pub async fn file_keys(app: &App, c: &Cfg, name: &str) -> Result<Value, String> {
    let doc = engine(app, c, &describe_args("files"), c.describe_timeout_ms, false).await?;
    let f = doc.get("files").and_then(Value::as_array).and_then(|l| l.iter().find(|f| s(f, "file") == name)).cloned();
    f.map(|f| json!({"file": name, "keys": f.get("keys")})).ok_or_else(|| c.msg_bad_request.clone())
}

/// `GET /api/manage/history`: the newest changes.
pub async fn history(app: &App, c: &Cfg) -> Result<Value, String> {
    engine(app, c, &["config".into(), "history".into(), "--limit".into(), c.history_limit.to_string(), "--json".into()], c.describe_timeout_ms, false).await
}

/// A write request from the page.
#[derive(Debug, Deserialize)]
pub struct Write {
    /// `set`, `reset` or `undo`.
    pub op: String,
    /// The setting key (`set`, `reset`) or the history row id (`undo`).
    pub key: String,
    #[serde(default)]
    pub value: String,
    /// Validate only (`set`).
    #[serde(default)]
    pub check: bool,
    #[serde(default)]
    pub confirmed: bool,
}

fn key_ok(k: &str, max: usize) -> bool {
    !k.is_empty() && k.len() <= max && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

/// `POST /api/manage/write`: one `config set|reset|undo` as the engine runs it (it validates, writes and audits). The engine's own
/// answer (`ok`, `note`, `warning`, `needs_confirmation`, `prev`, `value`) goes back as it is.
pub async fn write(app: &App, c: &Cfg, w: Write) -> Result<Value, String> {
    if !key_ok(&w.key, c.key_max_chars) || w.value.len() > c.value_max_chars {
        return Err(c.msg_bad_request.clone());
    }
    let mut args: Vec<String> = vec!["config".into()];
    match w.op.as_str() {
        "set" => {
            // the engine reads a word that starts with two dashes as an option
            if w.value.starts_with("--") {
                return Err(c.msg_flag_value.clone());
            }
            args.extend(["set".into(), w.key.clone(), w.value.clone()]);
            if w.check {
                args.push("--check".into());
            }
        }
        "reset" => args.extend(["reset".into(), w.key.clone()]),
        "undo" => args.extend(["undo".into(), w.key.clone()]),
        _ => return Err(c.msg_bad_request.clone()),
    }
    if w.confirmed {
        args.push("--confirmed".into());
    }
    args.push("--json".into());
    engine(app, c, &args, c.write_timeout_ms, true).await
}
