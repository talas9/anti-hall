//! `ah-engine jev-report`: the Jev report of the `/anti-hall:jev` skill, the port of `scripts/jev-report.js`.
//!
//! The command reads what the report is made of (the decision, triage, judge and supervision logs with every retained
//! generation, the daily rollups, the human labels, `jev.json`, the budget settings and state, the cached credit balance) and
//! hands the raw text to the plugin script `engine/logic/rules/jev-report.js` (`script::call_fn`, JSON in and out), which parses
//! the arguments, aggregates, gives the KEEP / REVIEW / REMOVE verdicts and renders the text or `--json` report. Every
//! threshold, list and word is `engine/defaults/jev_report.toml`. What stays here is I/O: the reads, the three small writes
//! (`label` appends a human label, `prune-audit` rewrites the audit log, the report keeps its once-a-day low-credit latch)
//! and the credit balance request.
//!
//! A run that cannot be reproduced (the script is off or failed, a write failed, the balance answer has a shape the port does
//! not read) writes nothing, says so on stderr and exits with the deferral code, so the Node script can be run instead.
use super::credentials::resolve_key;
use super::settings::{Env, JevSettings, Sources, Vendor};
use super::transport::{BodyError, HttpTransport, NetError, Request, Transport};
use crate::cli::Parsed;
use crate::defaults;
use crate::ops::{defer_code, env_snapshot, err, home, out};
use regex::Regex;
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

fn rules(func: &str, input: &Value) -> Option<Value> {
    crate::script::call_fn(defaults::text("jevrep.rules_script"), func, input)
}

fn defer(why: &str) -> i32 {
    err(&(defaults::render("jevrep.msg_defer", &[("why", &why)]) + "\n"));
    defer_code()
}

/// The report's thresholds, texts and table header, as the script reads them.
fn cfg() -> Value {
    let strip = |prefix: &str| -> serde_json::Map<String, Value> {
        defaults::with_prefix(prefix).into_iter().filter_map(|e| e.key.strip_prefix(prefix).map(|k| (k.to_string(), e.value.to_json()))).collect()
    };
    let mut texts = strip("jevrep.t_");
    texts.insert("table_header".into(), defaults::raw("jevrep.table_header").to_json());
    texts.insert("no_key_notice".into(), Value::String(defaults::text("setup.msg_no_key_notice").to_string()));
    json!({"thresholds": Value::Object(strip("jevrep.thr_")), "texts": Value::Object(texts)})
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// `retainedLogFiles`: the numbered generations oldest first, then the live file when it exists.
fn retained(p: &Path) -> Vec<PathBuf> {
    let (Some(dir), Some(base)) = (p.parent(), p.file_name().map(|n| n.to_string_lossy().into_owned())) else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let prefix = format!("{base}.");
    let mut gens: Vec<u64> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let rest = name.strip_prefix(&prefix)?;
            (!rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())).then(|| rest.parse::<u64>().ok()).flatten()
        })
        .collect();
    gens.sort_unstable_by(|a, b| b.cmp(a));
    let mut out: Vec<PathBuf> = gens.into_iter().map(|g| PathBuf::from(format!("{}.{g}", p.display()))).collect();
    if p.exists() {
        out.push(p.to_path_buf());
    }
    out
}

/// The texts of `files` that could be read (an unreadable file is skipped).
fn texts(files: &[PathBuf]) -> Vec<String> {
    files.iter().filter_map(|f| std::fs::read(f).ok()).map(|b| String::from_utf8_lossy(&b).into_owned()).collect()
}

fn read_one(p: &Path) -> Option<String> {
    std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// The daily rollups' texts, by file name.
fn rollups(base: &Path) -> Vec<String> {
    let dir = base.join(defaults::text("jevrep.rollup_dir"));
    let Ok(re) = Regex::new(defaults::text("jevrep.rollup_name_re")) else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| re.is_match(n)).collect();
    names.sort();
    names.iter().filter_map(|n| read_one(&dir.join(n))).collect()
}

fn base_of(home: &Path) -> PathBuf {
    home.join(defaults::text("paths.base_dir"))
}

fn settings_for(home: &Path) -> JevSettings {
    JevSettings::resolve(home, Sources::load(home, Env::process()))
}

// ---- the credit balance ------------------------------------------------------------------------------------------------

/// A number as `JSON.stringify` writes it.
fn jnum(f: f64) -> String {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9e15 { format!("{}", f as i64) } else { format!("{f}") }
}

/// `Number(v)` for the shapes a balance endpoint answers with; `Err` for a shape this port does not read.
fn js_number(v: &Value) -> Result<f64, ()> {
    match v {
        Value::Null => Ok(0.0),
        Value::Bool(b) => Ok(f64::from(u8::from(*b))),
        Value::Number(n) => n.as_f64().ok_or(()),
        Value::String(s) => {
            let t = s.trim_matches(super::is_js_whitespace);
            if t.is_empty() {
                return Ok(0.0);
            }
            let lower = t.to_ascii_lowercase();
            if lower.starts_with("0x") || lower.starts_with("0o") || lower.starts_with("0b") {
                return Err(());
            }
            Ok(t.parse::<f64>().ok().filter(|_| !lower.contains("inf") && !lower.contains("nan")).unwrap_or(f64::NAN))
        }
        _ => Err(()),
    }
}

/// The result object of one balance request, in Node's key order, without the `cached` mark.
fn balance_request(settings: &JevSettings, transport: &dyn Transport) -> Result<String, ()> {
    let reason = |r: &str, ms: Option<u128>| -> String {
        match ms {
            Some(ms) => format!("{{\"ok\":false,\"reason\":{},\"ms\":{ms}}}", super::question::json_str(r)),
            None => format!("{{\"ok\":false,\"reason\":{}}}", super::question::json_str(r)),
        }
    };
    if !settings.enabled {
        return Ok(reason(defaults::text("jevrep.reason_disabled"), None));
    }
    let primary = settings.transport == Vendor::Vercel;
    if !primary && settings.fallback != Some(Vendor::Vercel) {
        return Ok(format!(
            "{{\"ok\":false,\"reason\":{},\"transport\":{}}}",
            super::question::json_str(defaults::text("jevrep.reason_unsupported")),
            super::question::json_str(settings.transport.as_str())
        ));
    }
    let Some(key) = resolve_key(settings, Vendor::Vercel).key else { return Ok(reason(defaults::text("jevrep.reason_no_key"), None)) };
    let url = settings.endpoint_overrides[0]
        .clone()
        .or_else(|| if primary { settings.endpoint_override.clone() } else { None })
        .unwrap_or_else(|| defaults::text("jevrep.credits_endpoint").to_string());
    let started = Instant::now();
    let timeout = std::time::Duration::from_millis(settings.timeout_ms);
    let res = transport.send(&Request { body: None, url: &url, bearer: key.expose(), timeout });
    let ms = || started.elapsed().as_millis();
    let resp = match res {
        Ok(r) => r,
        Err(NetError::Timeout) => return Ok(reason(defaults::text("jevrep.reason_timeout"), Some(ms()))),
        Err(NetError::Network) => return Ok(reason(defaults::text("jevrep.reason_network"), Some(ms()))),
    };
    if !(200..300).contains(&resp.status) {
        return Ok(reason(&defaults::render("jevrep.reason_http", &[("status", &resp.status)]), Some(ms())));
    }
    let body = match resp.body {
        Ok(b) => b,
        Err(BodyError::Timeout | BodyError::Other) => return Ok(reason(defaults::text("jevrep.reason_parse"), Some(ms()))),
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&body) else { return Ok(reason(defaults::text("jevrep.reason_parse"), Some(ms()))) };
    // `Number(json && json.balance)`: a falsy answer reads as 0 for both fields, an object answers by field, anything else is NaN
    let pick = |name: &str| -> Result<f64, ()> {
        match &parsed {
            Value::Null | Value::Bool(false) => Ok(0.0),
            Value::Number(n) if n.as_f64() == Some(0.0) => Ok(0.0),
            Value::String(t) if t.is_empty() => Ok(0.0),
            Value::Object(m) => m.get(name).map_or(Ok(f64::NAN), js_number),
            _ => Ok(f64::NAN),
        }
    };
    let (balance, used) = (pick(defaults::text("jevrep.credits_balance_field"))?, pick(defaults::text("jevrep.credits_used_field"))?);
    if !balance.is_finite() {
        return Ok(reason(defaults::text("jevrep.reason_bad_response"), Some(ms())));
    }
    Ok(format!(
        "{{\"ok\":true,\"vendor\":{},\"balanceUsd\":{},\"totalUsedUsd\":{},\"ms\":{}}}",
        super::question::json_str(Vendor::Vercel.as_str()),
        jnum(balance),
        if used.is_finite() { jnum(used) } else { "null".to_string() },
        ms()
    ))
}

/// `getCreditBalanceCached`: the result as JSON text (with the `cached` mark), and the cache file's new text when it changed.
fn credit_text(real_home: &Path, now: u64, transport: &dyn Transport) -> Result<(String, Option<String>), ()> {
    let base = base_of(real_home);
    let cache_path = base.join(defaults::text("jevrep.credits_cache_file"));
    let cache_text = read_one(&cache_path);
    let probe = rules("jevReportCredit", &json!({"cacheText": cache_text, "now": now, "ttl": defaults::num("jevrep.credits_ttl_ms")})).ok_or(())?;
    if let Some(hit) = probe.get("hit").and_then(Value::as_str) {
        return Ok((hit.to_string(), None));
    }
    let settings = settings_for(real_home);
    let result = balance_request(&settings, transport)?;
    let reason = serde_json::from_str::<Value>(&result).ok().and_then(|v| v.get("reason").and_then(Value::as_str).map(str::to_string));
    let local = reason.as_deref().is_some_and(|r| defaults::list("jevrep.uncached_reasons").contains(&r));
    let entry = (!local).then(|| format!("{{\"fetchedAt\":{now},\"vendor\":{},\"result\":{result}}}", super::question::json_str(Vendor::Vercel.as_str())));
    let with_mark = format!("{},\"cached\":false}}", &result[..result.len().saturating_sub(1)]);
    Ok((with_mark, entry))
}

// ---- the writes -------------------------------------------------------------------------------------------------------

fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::OpenOptions::new().append(true).create(true).open(path)?.write_all(line.as_bytes())
}

fn rewrite_audit(path: &Path, lines: &[String]) -> std::io::Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if lines.is_empty() {
        remove_if_there(path)?;
    } else {
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(defaults::num("jevrep.audit_mode") as u32).open(path)?;
        f.write_all((lines.join("\n") + "\n").as_bytes())?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(defaults::num("jevrep.audit_mode") as u32))?;
    }
    remove_if_there(&PathBuf::from(format!("{}.{}", path.display(), defaults::text("jevrep.audit_backup_gen"))))
}

fn remove_if_there(p: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Write the credit cache the way Node does: a temporary file beside it, renamed over it; best effort.
fn write_cache(path: &Path, text: &str) {
    let tmp = PathBuf::from(format!("{}.tmp.{}", path.display(), std::process::id()));
    if let Some(dir) = path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: the cache is best effort, as Node's
    }
    if std::fs::write(&tmp, text).is_ok() {
        crate::discard::harmless(std::fs::rename(&tmp, path)); // keep: as above
    }
}

// ---- the command ------------------------------------------------------------------------------------------------------

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

/// `jev-report [...]`
pub fn run_cmd(p: &Parsed) -> i32 {
    run_with(p, &HttpTransport::new())
}

pub(crate) fn run_with(p: &Parsed, transport: &dyn Transport) -> i32 {
    let env = env_snapshot();
    let real_home = PathBuf::from(home(&env));
    let argv = &p.raw;
    let Some(plan) = rules("jevReportPlan", &json!({"argv": argv})) else { return defer(defaults::text("jevrep.why_script")) };
    let given = s(&plan, "home").filter(|h| !h.is_empty());
    let home_dir = given.as_deref().map_or_else(|| real_home.clone(), PathBuf::from);
    let base = base_of(&home_dir);
    let now = now_ms();
    let path = |key: &str| base.join(defaults::text(key));
    let cmd = s(&plan, "cmd").unwrap_or_default();
    let audit_files = || -> Vec<PathBuf> {
        let live = base.join(defaults::text("jev.log_dir")).join(defaults::text("jev.audit_file"));
        vec![PathBuf::from(format!("{}.{}", live.display(), defaults::text("jevrep.audit_backup_gen"))), live]
    };
    let mut input = json!({"argv": argv, "now": now, "cfg": cfg()});
    let mut label_path = None;
    let mut audit_path = None;
    match cmd.as_str() {
        "label" => {
            let labels_file = path("jevrep.labels_log");
            input["labels"] = json!(read_one(&labels_file).into_iter().collect::<Vec<_>>());
            input["audit"] = json!(texts(&audit_files()));
            label_path = Some(labels_file);
        }
        "prune-audit" => {
            input["audit"] = json!(texts(&audit_files()));
            audit_path = audit_files().pop();
        }
        _ => {
            let weekly = plan.get("weekly").and_then(Value::as_bool).unwrap_or(false);
            let grouped = plan.get("grouped").and_then(Value::as_bool).unwrap_or(false);
            let logs = |key: &str| texts(&retained(&path(key)));
            input["assist"] = json!(texts(&retained(&base.join(defaults::text("jev.log_file")))));
            input["triage"] = json!(logs("jevrep.triage_log"));
            input["judge"] = json!(logs("jevrep.judge_log"));
            input["supervision"] = json!(logs("jevrep.supervision_log"));
            input["rollups"] = json!(rollups(&base));
            input["labels"] = json!(read_one(&path("jevrep.labels_log")).into_iter().collect::<Vec<_>>());
            input["jevJson"] = json!(read_one(&base.join(defaults::text("jev.legacy_file"))));
            let st = settings_for(&home_dir);
            input["budget"] = json!({
                "mode": if st.budget_watch { defaults::text("jevrep.budget_watch") } else { defaults::text("jevrep.budget_unlimited") },
                "usdPerDay": st.budget_usd_per_day, "usdPerWeek": st.budget_usd_per_week, "minCreditUsd": st.budget_min_credit_usd,
            });
            input["modes"] = Value::Null;
            input["credit"] = json!(defaults::text("jevrep.credit_skipped"));
            input["budgetState"] = json!(read_one(&base.join(defaults::text("jev.state_dir")).join(defaults::text("jev.budget_file"))));
            if weekly && given.as_deref().is_some_and(|h| Path::new(h) != real_home) {
                return defer(defaults::text("jevrep.why_home"));
            }
            let mut cache_entry = None;
            if !weekly && !grouped {
                match credit_text(&real_home, now, transport) {
                    Ok((text, entry)) => {
                        input["credit"] = json!(text);
                        cache_entry = entry;
                    }
                    Err(()) => return defer(defaults::text("jevrep.why_credit")),
                }
            }
            if weekly {
                let Some(first) = rules("jevReportRun", &input) else { return defer(defaults::text("jevrep.why_script")) };
                let ids = first.get("needModes").and_then(Value::as_array).cloned().unwrap_or_default();
                let mut modes = serde_json::Map::new();
                let wst = settings_for(&real_home);
                for id in &ids {
                    let Some(name) = id.as_str() else { return defer(defaults::text("jevrep.why_id")) };
                    modes.insert(name.to_string(), json!(wst.mode(name, false).as_str()));
                }
                input["modes"] = Value::Object(modes);
            }
            return finish(&input, label_path, audit_path, &base, cache_entry.map(|e| (real_home.clone(), e)));
        }
    }
    finish(&input, label_path, audit_path, &base, None)
}

/// Run the script over the data and carry out what it asks for.
fn finish(input: &Value, label_path: Option<PathBuf>, audit_path: Option<PathBuf>, base: &Path, cache: Option<(PathBuf, String)>) -> i32 {
    let Some(res) = rules("jevReportRun", input) else { return defer(defaults::text("jevrep.why_script")) };
    if let (Some(line), Some(p)) = (s(&res, "appendLabel"), label_path.as_ref())
        && append_line(p, &line).is_err()
    {
        return defer(defaults::text("jevrep.why_write"));
    }
    if let (Some(a), Some(p)) = (res.get("audit").filter(|a| !a.is_null()), audit_path.as_ref()) {
        let lines: Vec<String> =
            a.get("lines").and_then(Value::as_array).map(|l| l.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if rewrite_audit(p, &lines).is_err() {
            return defer(defaults::text("jevrep.why_write"));
        }
    }
    if let Some(state) = s(&res, "budgetState") {
        let sp = base.join(defaults::text("jev.state_dir")).join(defaults::text("jev.budget_file"));
        if let Some(dir) = sp.parent() {
            crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: the latch is best effort, as Node's
        }
        crate::discard::harmless(std::fs::write(&sp, state)); // keep: as above
    }
    if let Some((home, entry)) = cache {
        write_cache(&base_of(&home).join(defaults::text("jevrep.credits_cache_file")), &entry);
    }
    if let Some(t) = s(&res, "out").filter(|t| !t.is_empty()) {
        out(&t);
    }
    if let Some(t) = s(&res, "err").filter(|t| !t.is_empty()) {
        err(&t);
    }
    res.get("exit").and_then(Value::as_i64).unwrap_or(0) as i32
}
