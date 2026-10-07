//! What the Node decision layer keeps besides the decision log, so moving the calls into the engine changes nothing the
//! owner reads: the budget watch (`jev-budget.json` and its `budget-warning` row), the opt-in audit snippets
//! (`jev-audit.ndjson`) and the daily rollups folded out of the log just before its oldest generation is replaced.
//!
//! Mirrors `maybeWarnBudget`, `maybeWriteAuditSnippet`, `buildDailyRollups` and `writeDailyRollups` in
//! `hooks/lib/jev-assist.js`. Every function is best effort: a failure never reaches the caller's decision (D35).
//! The daily-rollup retention setting (`jev.rollupRetentionDays`, default 0: keep everything) is not applied here: the
//! engine never removes a rollup file, and the Node hooks still prune when the owner set a retention.
use super::scrub::scrub_secrets;
use crate::checks::replykit::json::{js_number, quote};
use crate::defaults;
use serde_json::Value;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};

/// `Date.parse` of the one ISO form the logs hold (`YYYY-MM-DDTHH:MM:SS[.fff]Z`), in epoch milliseconds.
pub fn parse_iso_z(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || *b.last()? != b'Z' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, sec) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let frac = match &s[19..s.len() - 1] {
        "" => 0,
        f if f.starts_with('.') && f.len() > 1 && f[1..].bytes().all(|c| c.is_ascii_digit()) => format!("{:0<3}", &f[1..]).get(..3)?.parse::<i64>().ok()?,
        _ => return None,
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    // days from civil, after Howard Hinnant
    let y2 = y - i64::from(mo <= 2);
    let era = y2.div_euclid(400);
    let yoe = y2.rem_euclid(400);
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + sec * 1000 + frac)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn today() -> String {
    super::assist::iso_ms(now_ms())[..10].to_string()
}

/// JavaScript `slice(0, n)` over UTF-16 units; a pair the cut would split is left out.
fn head(s: &str, n: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in s.chars() {
        used += c.len_utf16();
        if used > n {
            break;
        }
        out.push(c);
    }
    out
}

/// JavaScript `slice(-n)` over UTF-16 units; a pair the cut would split is left out.
fn tail(s: &str, n: usize) -> String {
    let mut used = 0;
    let mut start = s.len();
    for (i, c) in s.char_indices().rev() {
        used += c.len_utf16();
        if used > n {
            break;
        }
        start = i;
    }
    s[start..].to_string()
}

// ---- budget watch ------------------------------------------------------------------------------------------------

/// `maybeWarnBudget`: with `jev.budget.mode` = `watch` and a known cost, add it to the day's spend; the first time the day's
/// spend passes `jev.budget.usdPerDay` it returns `(spent, limit)` for the caller to write as one `budget-warning` row to
/// the decision log. Never disables Jev.
pub fn maybe_warn_budget(home: &Path, watch: bool, usd_per_day: Option<f64>, cost: Option<f64>) -> Option<(f64, f64)> {
    let cost = cost.filter(|c| watch && c.is_finite())?;
    let path = home.join(defaults::text("paths.base_dir")).join(defaults::text("jev.state_dir")).join(defaults::text("jev.budget_file"));
    let today = today();
    let state: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).filter(Value::is_object).unwrap_or(Value::Null);
    let (mut spent, mut warned) = if state.get("date").and_then(Value::as_str) == Some(today.as_str()) {
        (
            state.get("spentUsd").and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0),
            state.get("warnedDate").and_then(Value::as_str).map(str::to_string),
        )
    } else {
        (0.0, None)
    };
    spent += cost;
    let mut warning = None;
    if let Some(limit) = usd_per_day
        && spent > limit
        && warned.as_deref() != Some(today.as_str())
    {
        warning = Some((spent, limit));
        warned = Some(today.clone());
    }
    let body =
        format!("{{\"date\":{},\"spentUsd\":{},\"warnedDate\":{}}}", quote(&today), js_number(spent), warned.as_deref().map_or("null".to_string(), quote));
    let _ = path.parent().map(std::fs::create_dir_all);
    let _ = std::fs::write(&path, body);
    warning
}

// ---- audit snippets ----------------------------------------------------------------------------------------------

/// `maybeWriteAuditSnippet`: with `jev.audit.snippets` on, a redacted snippet of the judged text for a decision that changed
/// the outcome (`changed`) or would have (`would_change`, a shadow row, marked `shadow`), in `jev-audit.ndjson` (mode 600,
/// one backup). `changed` and `would_change` are the direction words of the log row, or null.
pub fn maybe_write_audit_snippet(log_dir: &Path, enabled: bool, id: &str, hash: &str, state: &str, changed: &Value, would_change: &Value) {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let truthy = |v: &Value| !v.is_null() && v.as_str().is_none_or(|s| !s.is_empty());
    if !enabled || state.is_empty() || !(truthy(changed) || truthy(would_change)) {
        return;
    }
    let (h, t) = (defaults::num("jev.audit_head_chars") as usize, defaults::num("jev.audit_tail_chars") as usize);
    let snippet = if defaults::list("jev.audit_tail_ids").contains(&id) {
        // the verdict sits at the end: scrub the whole text first so a secret straddling a cut cannot survive half redacted
        let scrubbed = scrub_secrets(state);
        if scrubbed.encode_utf16().count() <= h + t { scrubbed } else { format!("{} \u{2026} {}", head(&scrubbed, h), tail(&scrubbed, t)) }
    } else {
        head(&scrub_secrets(&head(state, defaults::num("jev.audit_scrub_chars") as usize)), defaults::num("jev.audit_plain_chars") as usize)
    };
    let path = log_dir.join(defaults::text("jev.audit_file"));
    let _ = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(log_dir)?;
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > defaults::num("jev.audit_max_bytes")) {
            let mut old = path.as_os_str().to_os_string();
            old.push(".1");
            std::fs::rename(&path, PathBuf::from(old))?; // replaces the one backup, as Node's remove-then-rename does
        }
        let shadow = if truthy(changed) || !truthy(would_change) { String::new() } else { ",\"shadow\":true".to_string() };
        let row = format!(
            "{{\"ts\":{},\"id\":{},\"h\":{},\"snippet\":{}{shadow}}}\n",
            quote(&super::assist::iso_ms(now_ms())),
            quote(id),
            quote(hash),
            quote(&snippet)
        );
        let mut f = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(&path)?;
        f.write_all(row.as_bytes())?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
    })();
}

// ---- daily rollups -----------------------------------------------------------------------------------------------

/// A group of one day: one integration, backend and mode.
#[derive(Default)]
struct Group {
    id: String,
    backend: String,
    mode: String,
    n: u64,
    fresh: u64,
    changed: std::collections::HashSet<String>,
    timeouts: u64,
    failures: u64,
    fell_back: u64,
    cost: f64,
    cost_known: bool,
    ms: Vec<f64>,
}

#[derive(Default)]
struct Day {
    groups: Vec<Group>,
    outcomes: Vec<(String, String, u64)>,
    transports: Vec<(String, u64)>,
}

/// ICU-like string order for the group sort (`localeCompare`): punctuation, then digits, then letters ignoring case; on a
/// tie a lower-case letter comes first.
fn locale_cmp(a: &str, b: &str) -> Ordering {
    let primary = |c: char| -> (u8, u32) {
        if c.is_ascii_alphabetic() {
            (3, c.to_ascii_lowercase() as u32)
        } else if c.is_ascii_digit() {
            (2, c as u32)
        } else {
            (1, c as u32)
        }
    };
    let pa: Vec<_> = a.chars().map(primary).collect();
    let pb: Vec<_> = b.chars().map(primary).collect();
    pa.cmp(&pb).then_with(|| {
        let first_case_diff = a.chars().zip(b.chars()).find(|(x, y)| x != y).map(|(x, _)| x.is_ascii_uppercase());
        match first_case_diff {
            Some(true) => Ordering::Greater,
            Some(false) => Ordering::Less,
            None => Ordering::Equal,
        }
    })
}

fn pctile(sorted: &[f64], p: f64) -> String {
    if sorted.is_empty() {
        return "null".into();
    }
    js_number(sorted[(sorted.len() - 1).min((p * sorted.len() as f64).floor() as usize)])
}

/// `buildDailyRollups`: per UTC day, the rollup JSON (without `generatedAt` and `complete`), keyed by the day.
pub fn build_daily_rollups(rows: &[Value]) -> Vec<(String, String)> {
    let mut days: Vec<(String, Day)> = Vec::new();
    for r in rows {
        let (Some(ts), Some(id)) = (r.get("ts").and_then(Value::as_str), r.get("id").and_then(Value::as_str).filter(|i| !i.is_empty())) else { continue };
        let Some(t) = parse_iso_z(ts) else { continue };
        let day = super::assist::iso_ms(t.max(0) as u64)[..10].to_string();
        let di = days.iter().position(|(d, _)| *d == day).unwrap_or_else(|| {
            days.push((day.clone(), Day::default()));
            days.len() - 1
        });
        let d = &mut days[di].1;
        let ty = r.get("type").filter(|v| !v.is_null() && v.as_str() != Some("") && **v != Value::Bool(false));
        if r.get("type").and_then(Value::as_str) == Some("outcome") {
            let outcome = match r.get("outcome") {
                Some(Value::String(s)) => s.clone(),
                Some(v) => v.to_string(),
                None => "undefined".into(),
            };
            match d.outcomes.iter_mut().find(|(i, o, _)| i == id && *o == outcome) {
                Some(e) => e.2 += 1,
                None => d.outcomes.push((id.to_string(), outcome, 1)),
            }
            continue;
        }
        if ty.is_some() {
            continue;
        }
        if let Some(tr) = r.get("transport").and_then(Value::as_str).filter(|t| *t == "vercel" || *t == "typesafe") {
            match d.transports.iter_mut().find(|(k, _)| k == tr) {
                Some(e) => e.1 += 1,
                None => d.transports.push((tr.to_string(), 1)),
            }
        }
        let backend = r.get("backend").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("unknown");
        let mode = r.get("mode").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("unknown");
        let gi = d.groups.iter().position(|g| g.id == id && g.backend == backend && g.mode == mode).unwrap_or_else(|| {
            d.groups.push(Group { id: id.into(), backend: backend.into(), mode: mode.into(), ..Group::default() });
            d.groups.len() - 1
        });
        let g = &mut d.groups[gi];
        g.n += 1;
        if backend != "cache" {
            g.fresh += 1;
        }
        let dir = if r.get("mode").and_then(Value::as_str) == Some("on") { r.get("changed") } else { r.get("wouldChange") };
        let dir_truthy = dir.is_some_and(|v| !v.is_null() && v.as_str().is_none_or(|s| !s.is_empty()) && *v != Value::Bool(false));
        if dir_truthy
            && !r.get("jev").is_some_and(Value::is_string)
            && backend != "cache"
            && let Some(h) = r.get("h").and_then(Value::as_str).filter(|h| !h.is_empty())
        {
            g.changed.insert(h.to_string());
        }
        if r.get("reason").and_then(Value::as_str) == Some("timeout") {
            g.timeouts += 1;
        }
        if r.get("fellBack") == Some(&Value::Bool(true)) {
            g.fell_back += 1;
        }
        if backend == "baseline-only" && r.get("reason").is_some_and(|v| !v.is_null() && v.as_str().is_none_or(|s| !s.is_empty())) {
            g.failures += 1;
        }
        if let Some(c) = r.get("costUsd").and_then(Value::as_f64).filter(|c| c.is_finite()) {
            g.cost += c;
            g.cost_known = true;
        }
        if let Some(ms) = r.get("ms").and_then(Value::as_f64).filter(|m| m.is_finite()) {
            g.ms.push(ms);
        }
    }
    days.into_iter()
        .map(|(day, mut d)| {
            d.groups.sort_by(|a, b| locale_cmp(&format!("{}{}{}", a.id, a.backend, a.mode), &format!("{}{}{}", b.id, b.backend, b.mode)));
            let groups: Vec<String> = d
                .groups
                .iter_mut()
                .map(|g| {
                    g.ms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
                    let cost = if g.cost_known { js_number((g.cost * 1e8 + 0.5).floor() / 1e8) } else { "null".into() };
                    format!(
                        "{{\"id\":{},\"backend\":{},\"mode\":{},\"n\":{},\"fresh\":{},\"changed\":{},\"timeouts\":{},\"failures\":{},\"fellBack\":{},\"costUsd\":{cost},\"p50Ms\":{},\"p95Ms\":{}}}",
                        quote(&g.id),
                        quote(&g.backend),
                        quote(&g.mode),
                        g.n,
                        g.fresh,
                        g.changed.len(),
                        g.timeouts,
                        g.failures,
                        g.fell_back,
                        pctile(&g.ms, 0.5),
                        pctile(&g.ms, 0.95)
                    )
                })
                .collect();
            let outcomes: Vec<String> = d.outcomes.iter().map(|(i, o, n)| format!("{{\"id\":{},\"outcome\":{},\"n\":{n}}}", quote(i), quote(o))).collect();
            let transports: Vec<String> = d.transports.iter().map(|(k, n)| format!("{}:{n}", quote(k))).collect();
            let body = format!("\"v\":1,\"day\":{},\"groups\":[{}],\"outcomes\":[{}],\"transports\":{{{}}}", quote(&day), groups.join(","), outcomes.join(","), transports.join(","));
            (day, body)
        })
        .collect()
}

/// The retained generations of the log, oldest first: `p.K` ... `p.1`, then `p` (every numeric suffix on disk).
fn retained(p: &Path) -> Vec<PathBuf> {
    let (Some(dir), Some(base)) = (p.parent(), p.file_name().map(|b| b.to_string_lossy().into_owned())) else { return Vec::new() };
    let mut gens: Vec<u64> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_prefix(&format!("{base}."))?.parse::<u64>().ok())
        .collect();
    gens.sort_unstable_by(|a, b| b.cmp(a));
    let mut out: Vec<PathBuf> = gens.into_iter().map(|g| PathBuf::from(format!("{}.{g}", p.display()))).collect();
    if p.exists() {
        out.push(p.to_path_buf());
    }
    out
}

/// `writeDailyRollups`: fold every retained generation of the log into one rollup file per UTC day, called before the
/// oldest generation is replaced. A day is rewritten only when all its rows are still on disk, or when it has no rollup
/// yet; a day whose early rows already rotated away keeps its earlier, complete rollup. Returns the files written.
pub fn write_daily_rollups(log_path: &Path) -> usize {
    let rows: Vec<Value> = retained(log_path)
        .iter()
        .filter_map(|f| std::fs::read_to_string(f).ok())
        .flat_map(|t| t.lines().filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok()).collect::<Vec<_>>())
        .collect();
    let oldest = rows.iter().filter_map(|r| r.get("ts").and_then(Value::as_str).and_then(parse_iso_z)).min();
    let Some(dir) = log_path.parent().map(|d| d.join(defaults::text("jev.rollup_dir"))) else { return 0 };
    if std::fs::create_dir_all(&dir).is_err() {
        return 0;
    }
    let generated = super::assist::iso_ms(now_ms());
    let mut written = 0;
    for (day, body) in build_daily_rollups(&rows) {
        let file = dir.join(format!("{day}.json"));
        let day_start = parse_iso_z(&format!("{day}T00:00:00Z")).unwrap_or(i64::MAX);
        let complete = oldest.is_none_or(|o| day_start >= o);
        if !complete && file.exists() {
            continue;
        }
        let tmp = dir.join(format!("{day}.json.tmp.{}", std::process::id()));
        let text = format!("{{\"generatedAt\":{},\"complete\":{complete},{body}}}", quote(&generated));
        if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, &file).is_ok() {
            written += 1;
        }
    }
    written
}
