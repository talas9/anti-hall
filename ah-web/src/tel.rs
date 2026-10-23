//! The Telemetry and Impact screens' data. One read of the engine's records (a `telemetry summary` window per day, the status, the
//! impact report, recent events and, when the engine has them, the weekly usage and the coverage report) is shared by both
//! documents and reused for `cache_s`. Every threshold, sentence and metric definition is in `web_tel.toml`. Nothing here
//! writes to the engine.
use crate::app::App;
use crate::ctl;
use ah_web_proto::tel::*;
use ah_web_proto::NumFmt;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DAY_MS: u64 = 86_400_000;

#[derive(Debug, Clone, Deserialize)]
struct MetricDef {
    id: String,
    label: String,
    source: String,
    unit: String,
    good: String,
    hint: String,
}

#[derive(Debug, Clone, Deserialize)]
struct MeasureDef {
    id: String,
    measure: String,
    anomaly: bool,
    label: String,
    hint: String,
}

#[derive(Debug, Clone, Deserialize)]
struct PeriodDef {
    id: String,
    label: String,
    cur: [usize; 2],
    prev: [usize; 2],
}

#[derive(Debug, Clone, Deserialize)]
struct PrevDef {
    id: String,
    label: String,
    hooks: Vec<String>,
    outcome: String,
    hint: String,
}

#[derive(Debug, Clone, Deserialize)]
struct FailDef {
    id: String,
    label: String,
    source: String,
    hint: String,
}

/// The values of `web_tel.toml`; no field has a default, a missing one is a load error naming it.
#[derive(Debug, Clone, Deserialize)]
pub struct TelCfg {
    series_days: usize,
    cache_s: u64,
    events_rows: usize,
    table_rows_max: usize,
    spark_points: usize,
    cmd_timeout_ms: u64,
    z_threshold: f64,
    mad_scale: f64,
    mad_floor_frac: f64,
    min_history_days: usize,
    min_day_fraction: f64,
    min_abs_change: f64,
    min_rel_change: f64,
    anomalies_max: usize,
    movers_max: usize,
    headline_checks: usize,
    heat_rows: usize,
    mover_measures: Vec<MeasureDef>,
    metrics: Vec<MetricDef>,
    periods: Vec<PeriodDef>,
    prevention: Vec<PrevDef>,
    failures: Vec<FailDef>,
    usage_cmd: Vec<String>,
    coverage_cmd: Vec<String>,
    week_hours: f64,
    forecast_bad_pct: f64,
    forecast_warn_pct: f64,
    uc_per_usd: f64,
    fmt_us: NumFmt,
    fmt_bytes: NumFmt,
    fmt_age: NumFmt,
    usd_decimals: usize,
    apex: Value,
    texts: BTreeMap<String, String>,
    export_path: String,
}

impl TelCfg {
    /// Read `path` (`web_tel.toml`: every `[webtel.<name>]` table's `value`).
    pub fn load(path: &Path) -> Result<TelCfg, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let doc: toml::Table = text.parse().map_err(|e| format!("{}: {e}", path.display()))?;
        let section = doc.get("webtel").and_then(toml::Value::as_table).ok_or("no [webtel] section")?;
        let mut flat = toml::Table::new();
        for (name, entry) in section {
            if let Some(v) = entry.get("value") {
                flat.insert(name.clone(), v.clone());
            }
        }
        toml::Value::Table(flat).try_into().map_err(|e| format!("{}: {e}", path.display()))
    }

    fn text(&self, key: &str) -> String {
        self.texts.get(key).cloned().unwrap_or_else(|| key.to_string())
    }

    fn fill(&self, key: &str, pairs: &[(&str, String)]) -> String {
        pairs.iter().fold(self.text(key), |t, (k, v)| t.replace(&format!("{{{k}}}"), v))
    }

    fn ui(&self, number: &NumFmt) -> TelUi {
        let apex = |k: &str| self.apex.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        TelUi {
            apex_file: apex("file"),
            apex_version: apex("version"),
            apex_json: self.apex.to_string(),
            spark_points: self.spark_points,
            export_path: self.export_path.clone(),
            fmt_us: self.fmt_us.clone(),
            fmt_bytes: self.fmt_bytes.clone(),
            fmt_age: self.fmt_age.clone(),
            usd_decimals: self.usd_decimals,
            number: number.clone(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

// ---- what the engine said -------------------------------------------------------------------------------------------------

/// One read of the engine. `sums[k]` is the telemetry summary of the last `k + 1` days, today included.
struct Raw {
    at: Instant,
    now_ms: u64,
    engine_ok: bool,
    sums: Vec<Value>,
    status: Value,
    impact: Value,
    events: Value,
    usage: Option<Value>,
    coverage: Option<Value>,
}

#[derive(Default)]
struct Cache {
    raw: Option<Arc<Raw>>,
    tel: Option<(Instant, Arc<TelDoc>)>,
    imp: Option<(Instant, Arc<ImpactDoc>)>,
}

static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
static BUILD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn cache() -> std::sync::MutexGuard<'static, Cache> {
    CACHE.get_or_init(|| Mutex::new(Cache::default())).lock().unwrap_or_else(|p| p.into_inner())
}

async fn run_cmd(engine: &Path, args: &[String], limit: Duration) -> Option<Value> {
    let run = tokio::process::Command::new(engine)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(limit, run).await.ok()?.ok()?;
    serde_json::from_slice(&out.stdout).ok()
}

async fn read_raw(app: &App, cfg: &TelCfg) -> Raw {
    let s = app.settings();
    let (timeout, max) = (Duration::from_millis(s.ctl_timeout_ms), s.ctl_max_bytes);
    let mut raw = Raw { at: Instant::now(), now_ms: now_ms(), engine_ok: false, sums: Vec::new(), status: Value::Null, impact: Value::Null, events: Value::Null, usage: None, coverage: None };
    for n in 1..=cfg.series_days {
        match ctl::call(&app.socket, &format!("telemetry summary window={n}d"), timeout, max).await {
            Ok(v) => raw.sums.push(v),
            Err(_) => return raw,
        }
    }
    raw.engine_ok = true;
    raw.status = ctl::call(&app.socket, "status", timeout, max).await.unwrap_or(Value::Null);
    raw.impact = ctl::call(&app.socket, "impact", timeout, max).await.unwrap_or(Value::Null);
    raw.events = ctl::call(&app.socket, &format!("telemetry events window=1d limit={}", cfg.events_rows), timeout, max).await.unwrap_or(Value::Null);
    let limit = Duration::from_millis(cfg.cmd_timeout_ms);
    raw.usage = run_cmd(&app.engine, &cfg.usage_cmd, limit).await;
    raw.coverage = run_cmd(&app.engine, &cfg.coverage_cmd, limit).await;
    raw
}

/// The telemetry config next to `web.toml`.
fn cfg_path(app: &App) -> std::path::PathBuf {
    app.config_path.with_file_name("web_tel.toml")
}

/// The shared read, reused for `cache_s`; one build at a time.
async fn raw(app: &App, cfg: &TelCfg) -> Arc<Raw> {
    let fresh = |c: &Cache| c.raw.clone().filter(|r| r.at.elapsed() < Duration::from_secs(cfg.cache_s));
    if let Some(r) = fresh(&cache()) {
        return r;
    }
    let _one = BUILD.lock().await;
    if let Some(r) = fresh(&cache()) {
        return r;
    }
    let r = Arc::new(read_raw(app, cfg).await);
    let mut c = cache();
    c.raw = Some(r.clone());
    c.tel = None;
    c.imp = None;
    r
}

// ---- reading a summary --------------------------------------------------------------------------------------------------

enum Src {
    Invocations,
    Outcome(String),
    Kind(String),
    HookN(String),
    HookOutcome(String, String),
    JevCalls,
}

fn parse_src(s: &str) -> Option<Src> {
    let parts: Vec<&str> = s.split(':').collect();
    match parts.as_slice() {
        ["invocations"] => Some(Src::Invocations),
        ["outcome", o] => Some(Src::Outcome((*o).into())),
        ["kind", k] => Some(Src::Kind((*k).into())),
        ["hook", h, "n"] => Some(Src::HookN((*h).into())),
        ["hook", h, o] => Some(Src::HookOutcome((*h).into(), (*o).into())),
        ["jev", "calls"] => Some(Src::JevCalls),
        _ => None,
    }
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn hooks(sum: &Value) -> &[Value] {
    sum.get("by_hook").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn eval(src: &Src, sum: &Value) -> f64 {
    match src {
        Src::Invocations => num(&sum["invocations"]),
        Src::Outcome(o) => num(&sum["by_outcome"][o.as_str()]),
        Src::Kind(k) => num(&sum["by_kind"][k.as_str()]),
        Src::HookN(h) => hooks(sum).iter().filter(|r| r["h"] == h.as_str()).map(|r| num(&r["n"])).sum(),
        Src::HookOutcome(h, o) => hooks(sum).iter().filter(|r| r["h"] == h.as_str()).map(|r| num(&r["outcomes"][o.as_str()])).sum(),
        Src::JevCalls => jev_calls(sum),
    }
}

fn jev_calls(sum: &Value) -> f64 {
    sum["detail"]["jev"]["by_integration"].as_object().map_or(0.0, |m| m.values().map(|i| num(&i["calls"])).sum())
}

fn jev_cost_uc(sum: &Value) -> f64 {
    sum["detail"]["jev"]["by_integration"].as_object().map_or(0.0, |m| m.values().map(|i| num(&i["cost_uc"])).sum())
}

impl Raw {
    /// Value per day from `f`, oldest first, today (so far) last. A day's figure is the difference of two cumulative windows.
    fn daily(&self, f: &dyn Fn(&Value) -> f64) -> Vec<f64> {
        (0..self.sums.len())
            .rev()
            .map(|k| {
                let hi = f(&self.sums[k]);
                let lo = if k == 0 { 0.0 } else { f(&self.sums[k - 1]) };
                (hi - lo).max(0.0)
            })
            .collect()
    }

    /// The part of today (UTC) already gone, in (0, 1].
    fn day_fraction(&self) -> f64 {
        ((self.now_ms % DAY_MS) as f64 / DAY_MS as f64).max(f64::EPSILON)
    }

    /// Index of the first day the engine has records for (leading empty days are before it was recording).
    fn first_active(&self) -> usize {
        self.daily(&|s| num(&s["invocations"])).iter().position(|v| *v > 0.0).unwrap_or(0)
    }

    fn day_starts(&self) -> Vec<u64> {
        let today = self.now_ms - self.now_ms % DAY_MS;
        (0..self.sums.len()).rev().map(|k| today - k as u64 * DAY_MS).collect()
    }
}

// ---- judging a series ---------------------------------------------------------------------------------------------------

fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let m = s.len() / 2;
    if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2.0 }
}

struct Judged {
    value: f64,
    projected: f64,
    usual: f64,
    score: f64,
}

impl Judged {
    fn change(&self) -> f64 {
        self.projected - self.usual
    }

    /// Far enough from the usual, in spread, in events and in share.
    fn unusual(&self, c: &TelCfg) -> bool {
        self.score.abs() >= c.z_threshold && self.change().abs() >= c.min_abs_change && self.change().abs() >= c.min_rel_change * self.usual
    }
}

/// Today (the last point, projected to a whole day) against the median and spread of the days before it.
fn judge(series: &[f64], first_active: usize, frac: f64, c: &TelCfg) -> Option<Judged> {
    let (today, before) = series.split_last()?;
    let history = before.get(first_active..).unwrap_or_default();
    if history.len() < c.min_history_days || frac < c.min_day_fraction {
        return None;
    }
    let usual = median(history);
    let mad = median(&history.iter().map(|x| (x - usual).abs()).collect::<Vec<_>>());
    let spread = (mad * c.mad_scale).max(usual * c.mad_floor_frac).max(c.min_abs_change / c.z_threshold);
    let projected = today / frac;
    Some(Judged { value: *today, projected, usual, score: (projected - usual) / spread })
}

fn tail(v: &[f64], n: usize) -> Vec<f64> {
    v[v.len().saturating_sub(n)..].to_vec()
}

// ---- the Telemetry document ---------------------------------------------------------------------------------------------

fn fmt_usd(usd: f64, c: &TelCfg) -> String {
    format!("{}{:.*}", c.text("unit_usd"), c.usd_decimals, usd)
}

fn tone_of(good: &str, j: Option<&Judged>, c: &TelCfg) -> &'static str {
    let Some(j) = j else { return "neutral" };
    let up = j.change() > 0.0;
    let bad_dir = match good {
        "down" => up,
        "up" => !up,
        _ => return "neutral",
    };
    if j.unusual(c) {
        if bad_dir { "bad" } else { "ok" }
    } else if j.change().abs() >= c.min_rel_change * j.usual && j.change().abs() >= c.min_abs_change {
        if bad_dir { "warn" } else { "ok" }
    } else {
        "neutral"
    }
}

fn pct(change: f64, usual: f64) -> Option<f64> {
    (usual > 0.0).then(|| change / usual * 100.0)
}

fn cell_text(v: &Value) -> Cell {
    Cell::Text(v.as_str().unwrap_or_default().to_string())
}

fn cell_num(v: &Value) -> Cell {
    Cell::Num(num(v))
}

fn col(c: &TelCfg, key: &str, label_key: &str, kind: &str) -> Col {
    Col { key: key.into(), label: c.text(label_key), kind: kind.into() }
}

fn tables(raw: &Raw, c: &TelCfg, kpis: &[Kpi], days: &[u64]) -> Vec<Table> {
    let cap = c.table_rows_max;
    let mut out = Vec::new();
    // checks over the whole series window, busiest first
    let mut rows: Vec<&Value> = hooks(raw.sums.last().unwrap_or(&Value::Null)).iter().collect();
    rows.sort_by(|a, b| num(&b["n"]).total_cmp(&num(&a["n"])));
    out.push(Table {
        id: "checks".into(),
        title: c.text("tab_checks"),
        cols: vec![
            col(c, "h", "col_check", "text"),
            col(c, "k", "col_kind", "text"),
            col(c, "n", "col_runs", "count"),
            col(c, "allow", "col_allow", "count"),
            col(c, "advise", "col_advise", "count"),
            col(c, "block", "col_block", "count"),
            col(c, "defer", "col_defer", "count"),
            col(c, "error", "col_error", "count"),
            col(c, "mean_us", "col_mean", "us"),
            col(c, "p50_us", "col_p50", "us"),
            col(c, "p95_us", "col_p95", "us"),
            col(c, "p99_us", "col_p99", "us"),
            col(c, "injected_bytes", "col_injected", "bytes"),
        ],
        rows: rows
            .iter()
            .take(cap)
            .map(|r| {
                let o = |k: &str| cell_num(&r["outcomes"][k]);
                vec![cell_text(&r["h"]), cell_text(&r["k"]), cell_num(&r["n"]), o("allow"), o("advise"), o("block"), o("defer"), o("error"), cell_num(&r["mean_us"]), cell_num(&r["p50_us"]), cell_num(&r["p95_us"]), cell_num(&r["p99_us"]), cell_num(&r["injected_bytes"])]
            })
            .collect(),
    });
    // per day, one column per metric card
    let mut cols = vec![col(c, "day", "col_day", "ts")];
    cols.extend(kpis.iter().map(|k| Col { key: k.id.clone(), label: k.label.clone(), kind: k.unit.clone() }));
    out.push(Table {
        id: "days".into(),
        title: c.text("tab_days"),
        cols,
        rows: (0..days.len()).rev().map(|i| std::iter::once(Cell::Num(days[i] as f64)).chain(kpis.iter().map(|k| Cell::Num(k.series.get(k.series.len().saturating_sub(days.len()) + i).copied().unwrap_or(0.0)))).collect()).take(cap).collect(),
    });
    // agents: what each tracked agent spent against what it produced
    let agents = raw.sums.first().map_or(&[][..], |s| s["agent_cost"]["agents"].as_array().map_or(&[][..], Vec::as_slice));
    out.push(Table {
        id: "agents".into(),
        title: c.text("tab_agents"),
        cols: vec![
            col(c, "agent", "col_agent", "text"),
            col(c, "kind", "col_kind", "text"),
            col(c, "tokens", "col_tokens", "count"),
            col(c, "outcomes", "col_outcomes", "count"),
            col(c, "tokens_per_outcome", "col_per_outcome", "count"),
            col(c, "commits", "col_commits", "count"),
            col(c, "guard_fires", "col_guard", "count"),
            col(c, "files_edited", "col_files", "count"),
            col(c, "tests_passed", "col_tests", "count"),
        ],
        rows: agents
            .iter()
            .take(cap)
            .map(|a| {
                let who = a["name"].as_str().filter(|n| !n.is_empty()).or(a["agent"].as_str()).unwrap_or_default();
                vec![Cell::Text(who.into()), cell_text(&a["kind"]), cell_num(&a["tokens"]), cell_num(&a["outcomes"]), cell_num(&a["tokens_per_outcome"]), cell_num(&a["commits"]), cell_num(&a["guard_fires"]), cell_num(&a["files_edited"]), cell_num(&a["tests_passed"])]
            })
            .collect(),
    });
    // Jev, per integration, over the window
    let jev = raw.sums.last().and_then(|s| s["detail"]["jev"]["by_integration"].as_object());
    out.push(Table {
        id: "jev".into(),
        title: c.text("tab_jev"),
        cols: vec![col(c, "integration", "col_integration", "text"), col(c, "calls", "col_calls", "count"), col(c, "mean_ms", "col_ms", "count"), col(c, "cost", "col_cost", "usd")],
        rows: jev
            .map(|m| m.iter().take(cap).map(|(name, i)| vec![Cell::Text(name.clone()), cell_num(&i["calls"]), cell_num(&i["mean_ms"]), Cell::Num(num(&i["cost_uc"]) / c.uc_per_usd)]).collect())
            .unwrap_or_default(),
    });
    // the raw events of the last day, newest first
    let mut events: Vec<&Value> = raw.events["events"].as_array().map_or(Vec::new(), |a| a.iter().collect());
    events.sort_by(|a, b| num(&b["ts"]).total_cmp(&num(&a["ts"])));
    out.push(Table {
        id: "events".into(),
        title: c.text("tab_events"),
        cols: vec![col(c, "ts", "col_time", "ts"), col(c, "k", "col_kind", "text"), col(c, "h", "col_check", "text"), col(c, "e", "col_event", "text"), col(c, "o", "col_outcome", "text"), col(c, "ms", "col_ms", "count")],
        rows: events.iter().take(cap).map(|e| vec![cell_num(&e["ts"]), cell_text(&e["k"]), cell_text(&e["h"]), cell_text(&e["e"]), cell_text(&e["o"]), cell_num(&e["ms"])]).collect(),
    });
    out
}

/// Per-check daily series of one measure (`n` or an outcome), for the checks the engine knows.
fn hook_series(raw: &Raw, measure: &str) -> Vec<(String, Vec<f64>)> {
    let mut names: Vec<String> = raw.sums.last().map_or(Vec::new(), |s| hooks(s).iter().filter_map(|r| r["h"].as_str().map(str::to_string)).collect());
    names.sort();
    names.dedup();
    names
        .into_iter()
        .map(|name| {
            let series = raw.daily(&|s| {
                hooks(s).iter().filter(|r| r["h"] == name.as_str()).map(|r| if measure == "n" { num(&r["n"]) } else { num(&r["outcomes"][measure]) }).sum()
            });
            (name, series)
        })
        .collect()
}

fn forecast(raw: &Raw, c: &TelCfg) -> Option<Forecast> {
    let usage = raw.usage.as_ref()?;
    let used = usage["weekly"].as_f64()?;
    let resets = usage["resetsAt"].as_str().and_then(|t| humantime::parse_rfc3339(t).ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64);
    let hours_in = resets.map(|r| c.week_hours - ((r - raw.now_ms as f64) / 3_600_000.0).clamp(0.0, c.week_hours));
    let projected = hours_in.filter(|h| *h > 0.0).map(|h| used * c.week_hours / h);
    let tone = projected.map_or("info", |p| if p >= c.forecast_bad_pct { "bad" } else if p >= c.forecast_warn_pct { "warn" } else { "ok" });
    let text = match projected {
        Some(p) => c.fill("h_forecast", &[("used", format!("{used:.0}")), ("projected", format!("{p:.0}"))]),
        None => c.fill("h_forecast_unknown", &[("used", format!("{used:.0}"))]),
    };
    Some(Forecast { used_pct: used, projected_pct: projected, hours_in, tone: tone.into(), text })
}

fn build_tel(raw: &Raw, c: &TelCfg, number: &NumFmt) -> TelDoc {
    let mut doc = TelDoc { generated_ms: raw.now_ms, engine_ok: raw.engine_ok, texts: c.texts.clone(), ui: c.ui(number), ..TelDoc::default() };
    if !raw.engine_ok || raw.sums.is_empty() {
        doc.headlines.push(Headline { tone: "bad".into(), text: c.text("h_engine_down") });
        return doc;
    }
    let (frac, first) = (raw.day_fraction(), raw.first_active());
    let today = raw.sums.first().unwrap_or(&Value::Null);
    let mut judged: Vec<(String, Judged)> = Vec::new();

    // metric cards
    for m in &c.metrics {
        let Some(src) = parse_src(&m.source) else { continue };
        let series = raw.daily(&|s| eval(&src, s));
        let j = judge(&series, first, frac, c);
        doc.kpis.push(Kpi {
            id: m.id.clone(),
            label: m.label.clone(),
            hint: c.text(&m.hint),
            unit: m.unit.clone(),
            value: series.last().copied().unwrap_or(0.0),
            usual: j.as_ref().map(|j| j.usual),
            delta_pct: j.as_ref().and_then(|j| pct(j.change(), j.usual)),
            tone: tone_of(&m.good, j.as_ref(), c).into(),
            series,
        });
        if let Some(j) = j.filter(|j| j.unusual(c)) {
            judged.push((m.id.clone(), j));
        }
    }
    // anomalies: the metric cards, then every check's block count, each against its own days
    let mut anomalies: Vec<Anomaly> = Vec::new();
    for (id, j) in &judged {
        let label = doc.kpis.iter().find(|k| &k.id == id).map(|k| k.label.clone()).unwrap_or_default();
        anomalies.push(anomaly(c, id, &label, j, number));
    }
    for m in &c.mover_measures {
        let mut rows: Vec<Mover> = Vec::new();
        for (name, series) in hook_series(raw, &m.measure) {
            let Some(j) = judge(&series, first, frac, c) else { continue };
            if m.anomaly && j.unusual(c) {
                anomalies.push(anomaly(c, &name, &format!("{name} ({})", m.label.to_lowercase()), &j, number));
            }
            if j.change().abs() >= c.min_abs_change {
                rows.push(Mover { name, value: j.value, usual: j.usual, change: j.change(), pct: pct(j.change(), j.usual), series: tail(&series, c.spark_points) });
            }
        }
        rows.sort_by(|a, b| b.change.abs().total_cmp(&a.change.abs()));
        rows.truncate(c.movers_max);
        doc.movers.push(MoverList { id: m.id.clone(), label: m.label.clone(), hint: c.text(&m.hint), rows });
    }
    anomalies.sort_by(|a, b| b.score.abs().total_cmp(&a.score.abs()));
    anomalies.truncate(c.anomalies_max);

    // headlines
    let k = |id: &str| doc.kpis.iter().find(|k| k.id == id).map_or(0.0, |k| k.value);
    let n = |v: f64| number.fmt(v.round() as u64);
    doc.headlines.push(Headline { tone: "info".into(), text: c.fill("h_totals", &[("decisions", n(k("decisions"))), ("blocks", n(k("blocks"))), ("advise", n(k("advisories"))), ("errors", n(k("errors")))]) });
    let mut blockers: Vec<(&str, f64)> = hooks(today).iter().filter_map(|r| Some((r["h"].as_str()?, num(&r["outcomes"]["block"])))).filter(|(_, b)| *b > 0.0).collect();
    blockers.sort_by(|a, b| b.1.total_cmp(&a.1));
    if blockers.is_empty() {
        doc.headlines.push(Headline { tone: "ok".into(), text: c.text("h_no_blocks") });
    }
    for (check, blocks) in blockers.iter().take(c.headline_checks) {
        doc.headlines.push(Headline { tone: "info".into(), text: c.fill("h_block_check", &[("check", (*check).into()), ("n", n(*blocks))]) });
    }
    let cost = &today["agent_cost"];
    let list = cost["agents"].as_array().map_or(&[][..], Vec::as_slice);
    if num(&cost["totals"]["tokens"]) > 0.0 {
        let committers = list.iter().filter(|a| num(&a["commits"]) > 0.0).count();
        doc.headlines.push(Headline { tone: "info".into(), text: c.fill("h_agents", &[("agents", n(num(&cost["totals"]["agents"]))), ("tokens", n(num(&cost["totals"]["tokens"]))), ("committers", committers.to_string())]) });
        if let Some(top) = list.first() {
            let who = top["name"].as_str().filter(|x| !x.is_empty()).or(top["agent"].as_str()).unwrap_or_default();
            doc.headlines.push(Headline { tone: "info".into(), text: c.fill("h_cost_top", &[("agent", who.chars().take(24).collect()), ("tokens", n(num(&top["tokens"]))), ("outcomes", n(num(&top["outcomes"])))]) });
        }
    } else {
        doc.headlines.push(Headline { tone: "info".into(), text: c.text("h_agents_none") });
    }
    if jev_calls(today) > 0.0 {
        doc.headlines.push(Headline { tone: "info".into(), text: c.fill("h_jev", &[("n", n(jev_calls(today))), ("usd", fmt_usd(jev_cost_uc(today) / c.uc_per_usd, c))]) });
    }
    for a in anomalies.iter().take(c.anomalies_max) {
        doc.headlines.push(Headline { tone: "warn".into(), text: a.text.clone() });
    }
    doc.forecast = forecast(raw, c);
    if let Some(f) = &doc.forecast {
        doc.headlines.push(Headline { tone: f.tone.clone(), text: f.text.clone() });
    }
    doc.anomalies = anomalies;

    // heatmap: the checks that blocked most over the window, day by day
    let mut by_total: Vec<(String, Vec<f64>)> = hook_series(raw, "block").into_iter().filter(|(_, s)| s.iter().sum::<f64>() > 0.0).collect();
    by_total.sort_by(|a, b| b.1.iter().sum::<f64>().total_cmp(&a.1.iter().sum::<f64>()));
    by_total.truncate(c.heat_rows);
    doc.heat = Heat { checks: by_total.iter().map(|(n, _)| n.clone()).collect(), cells: by_total.into_iter().map(|(_, s)| s).collect() };
    doc.day_ms = raw.day_starts();
    doc.tables = tables(raw, c, &doc.kpis, &doc.day_ms);
    doc
}

fn anomaly(c: &TelCfg, id: &str, label: &str, j: &Judged, number: &NumFmt) -> Anomaly {
    let high = j.change() > 0.0;
    let n = |v: f64| number.fmt(v.round() as u64);
    let text = c.fill(if high { "h_anomaly_high" } else { "h_anomaly_low" }, &[("label", label.into()), ("value", n(j.value)), ("projected", n(j.projected)), ("median", n(j.usual))]);
    Anomaly { id: id.into(), label: label.into(), dir: if high { "high" } else { "low" }.into(), value: j.value, projected: j.projected, usual: j.usual, score: j.score, text }
}

// ---- the Impact document ------------------------------------------------------------------------------------------------

/// `(sum over [from, to) days ago, days of the span)` of a daily series (oldest first, today last); today counts as the part gone.
fn span(series: &[f64], range: [usize; 2], frac: f64) -> (f64, f64) {
    let len = series.len();
    let mut total = 0.0;
    let mut days = 0.0;
    for ago in range[0]..range[1].min(len) {
        total += series[len - 1 - ago];
        days += if ago == 0 { frac } else { 1.0 };
    }
    (total, days)
}

fn pair(series: &[f64], p: &PeriodDef, frac: f64) -> Pair {
    let (cur, cur_days) = span(series, p.cur, frac);
    let (prev, prev_days) = span(series, p.prev, frac);
    let delta = (prev > 0.0 && cur_days > 0.0 && prev_days > 0.0).then(|| ((cur / cur_days) / (prev / prev_days) - 1.0) * 100.0);
    Pair { cur, prev, delta_pct: delta }
}

fn build_impact(raw: &Raw, c: &TelCfg, number: &NumFmt) -> ImpactDoc {
    let mut doc = ImpactDoc { generated_ms: raw.now_ms, engine_ok: raw.engine_ok, texts: c.texts.clone(), ui: c.ui(number), ..ImpactDoc::default() };
    if !raw.engine_ok || raw.sums.is_empty() {
        return doc;
    }
    let frac = raw.day_fraction();
    doc.periods = c.periods.iter().map(|p| Period { id: p.id.clone(), label: p.label.clone() }).collect();
    let row = |id: &str, label: &str, hint: &str, good: &str, series: &[f64]| ImpactRow { id: id.into(), label: label.into(), hint: c.text(hint), good: good.into(), pairs: c.periods.iter().map(|p| pair(series, p, frac)).collect() };
    for p in &c.prevention {
        let series = if p.hooks.iter().any(|h| h == "*") {
            raw.daily(&|s| num(&s["by_outcome"][p.outcome.as_str()]))
        } else {
            raw.daily(&|s| p.hooks.iter().map(|h| eval(&Src::HookOutcome(h.clone(), p.outcome.clone()), s)).sum())
        };
        doc.prevention.push(row(&p.id, &p.label, &p.hint, "up", &series));
    }
    for f in &c.failures {
        if let Some(src) = parse_src(&f.source) {
            doc.failures.push(row(&f.id, &f.label, &f.hint, "down", &raw.daily(&|s| eval(&src, s))));
        }
    }
    doc.savings = savings(raw, c);
    doc.waterfall = waterfall(raw, c);
    doc.waterfall_kind = doc.savings.iter().find(|s| s.id == "net").map_or_else(|| "estimate".into(), |s| s.kind.clone());
    doc.gaps = gaps(raw, c);
    doc
}

/// What the engine's impact report says it saved and spent. A saving is `measured` only when the report carries measured
/// benchmark savings; everything else is the report's own labelled estimate, with its formula.
fn savings(raw: &Raw, c: &TelCfg) -> Vec<Saving> {
    let imp = &raw.impact;
    let net = &imp["net"];
    let mut out = Vec::new();
    let measured = imp["savings"]["measured_benchmarks"].as_array().map_or(&[][..], Vec::as_slice);
    for b in measured {
        out.push(Saving {
            id: "measured".into(),
            label: b["label"].as_str().unwrap_or_default().to_string(),
            kind: "measured".into(),
            usd: b["usd"].as_f64(),
            formula: b["method"].as_str().unwrap_or_default().to_string(),
            range: b["range"].as_str().map_or_else(|| c.text("impact_no_range"), str::to_string),
            basis: b["baseline"].as_str().unwrap_or_default().to_string(),
        });
    }
    if measured.is_empty() {
        out.push(Saving { id: "measured".into(), label: c.text("impact_measured_savings"), kind: "measured".into(), usd: None, formula: String::new(), range: String::new(), basis: c.text("impact_no_measured") });
    }
    let routing = &imp["savings"]["model_routing"];
    out.push(Saving {
        id: "routing".into(),
        label: c.text("impact_routing_saved"),
        kind: routing["label"].as_str().unwrap_or("estimate").into(),
        usd: routing["estimated_usd"].as_f64(),
        formula: routing["method"].as_str().unwrap_or_default().to_string(),
        range: c.text("impact_no_range"),
        basis: routing["status"].as_str().unwrap_or_default().to_string(),
    });
    out.push(Saving {
        id: "net".into(),
        label: c.text("impact_net"),
        kind: net["label"].as_str().unwrap_or("estimate").into(),
        usd: net["net_usd"].as_f64(),
        formula: net["net_method"].as_str().unwrap_or_default().to_string(),
        range: c.text("impact_no_range"),
        basis: net["method"].as_str().unwrap_or_default().to_string(),
    });
    out
}

/// Spent (Jev, injected context, routing to dearer models), prevented (routing to cheaper models, measured savings), net.
fn waterfall(raw: &Raw, c: &TelCfg) -> Vec<Step> {
    let net = &raw.impact["net"];
    if net.is_null() {
        return Vec::new();
    }
    let step = |label: &str, kind: &str, usd: f64| Step { label: c.text(label), kind: kind.into(), usd };
    let sp = &net["spenders"];
    let measured: f64 = raw.impact["savings"]["measured_benchmarks"].as_array().map_or(0.0, |a| a.iter().map(|b| num(&b["usd"])).sum());
    vec![
        step("impact_jev_cost", "spent", num(&sp["jev_usd"])),
        step("impact_injection", "spent", num(&sp["injection_usd"])),
        step("impact_routing_up", "spent", num(&net["routing"]["spent_up_usd"])),
        step("impact_routing_saved", "prevented", num(&net["routing"]["saved_usd"])),
        step("impact_measured_savings", "prevented", measured),
        step("impact_net", "net", num(&net["net_usd"])),
    ]
}

fn gaps(raw: &Raw, c: &TelCfg) -> Vec<Gap> {
    let n = |v: f64| format!("{}", v.round() as i64);
    let mut out = Vec::new();
    match &raw.coverage {
        Some(cov) => {
            let (unmatched, unready) = (cov["unmatched"].as_array().map_or(0, Vec::len), cov["unready"].as_array().map_or(0, Vec::len));
            out.push(Gap {
                id: "coverage".into(),
                label: c.text("gap_coverage"),
                text: c.fill("gap_coverage_text", &[("covered", n(num(&cov["covered"]))), ("features", n(num(&cov["features"]))), ("unmatched", unmatched.to_string()), ("unready", unready.to_string())]),
                tone: if unmatched + unready > 0 { "warn" } else { "ok" }.into(),
            });
        }
        None => out.push(Gap { id: "coverage".into(), label: c.text("gap_coverage"), text: c.text("gap_unavailable"), tone: "info".into() }),
    }
    let defers = raw.daily(&|s| num(&s["by_outcome"]["defer"]));
    if let Some(p) = c.periods.first() {
        let pr = pair(&defers, p, raw.day_fraction());
        let unable = num(&raw.status["node_handback"]["native_unable"]);
        out.push(Gap {
            id: "defers".into(),
            label: c.text("gap_defers"),
            text: c.fill("gap_defers_text", &[("cur", n(pr.cur)), ("prev", n(pr.prev)), ("unable", n(unable))]),
            tone: if pr.cur > 0.0 { "warn" } else { "ok" }.into(),
        });
    }
    let budget = &raw.status["budget"];
    let over: Vec<String> = budget["breached"].as_array().map_or(Vec::new(), |a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect());
    out.push(Gap {
        id: "budgets".into(),
        label: c.text("gap_budgets"),
        text: c.fill("gap_budgets_text", &[("breaches", n(num(&budget["breaches"]))), ("over", if over.is_empty() { c.text("gap_budgets_none") } else { over.join(", ") })]),
        tone: if over.is_empty() { "ok" } else { "bad" }.into(),
    });
    out
}

// ---- the routes ---------------------------------------------------------------------------------------------------------

/// The Telemetry document (cached for `cache_s`).
pub async fn telemetry(app: &App) -> Result<Arc<TelDoc>, String> {
    let cfg = TelCfg::load(&cfg_path(app))?;
    let r = raw(app, &cfg).await;
    if let Some((_, d)) = cache().tel.clone().filter(|(at, _)| at.elapsed() < Duration::from_secs(cfg.cache_s)) {
        return Ok(d);
    }
    let doc = Arc::new(build_tel(&r, &cfg, &app.settings().number()));
    cache().tel = Some((Instant::now(), doc.clone()));
    Ok(doc)
}

/// The Impact document (cached for `cache_s`).
pub async fn impact(app: &App) -> Result<Arc<ImpactDoc>, String> {
    let cfg = TelCfg::load(&cfg_path(app))?;
    let r = raw(app, &cfg).await;
    if let Some((_, d)) = cache().imp.clone().filter(|(at, _)| at.elapsed() < Duration::from_secs(cfg.cache_s)) {
        return Ok(d);
    }
    let doc = Arc::new(build_impact(&r, &cfg, &app.settings().number()));
    cache().imp = Some((Instant::now(), doc.clone()));
    Ok(doc)
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() }
}

fn cell_string(c: &Cell) -> String {
    match c {
        Cell::Num(n) if n.fract() == 0.0 && n.abs() < 9.0e15 => format!("{}", *n as i64),
        Cell::Num(n) => n.to_string(),
        Cell::Text(t) => t.clone(),
    }
}

/// One table as a download: the rows whose cells contain `q` (any case), as CSV or JSON.
pub fn export(doc: &TelDoc, table: &str, format: &str, q: &str) -> Option<(String, &'static str, String)> {
    let t = doc.tables.iter().find(|t| t.id == table)?;
    let q = q.to_lowercase();
    let rows: Vec<&Vec<Cell>> = t.rows.iter().filter(|r| q.is_empty() || r.iter().any(|c| cell_string(c).to_lowercase().contains(&q))).collect();
    if format == "json" {
        let items: Vec<serde_json::Map<String, Value>> = rows
            .iter()
            .map(|r| t.cols.iter().zip(r.iter()).map(|(col, cell)| (col.key.clone(), serde_json::to_value(cell).unwrap_or_default())).collect())
            .collect();
        return Some((format!("{table}.json"), "application/json", serde_json::to_string_pretty(&items).unwrap_or_default()));
    }
    let mut out = t.cols.iter().map(|c| csv_field(&c.key)).collect::<Vec<_>>().join(",");
    out.push('\n');
    for r in rows {
        out.push_str(&r.iter().map(|c| csv_field(&cell_string(c))).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    Some((format!("{table}.csv"), "text/csv; charset=utf-8", out))
}
