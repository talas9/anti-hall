//! `ah-engine shadow-compare`: pairs the engine rows and the node rows of the shadow ledger and reports, per check and per day,
//! agreement, engine-weaker, engine-stricter and the errors of each side. Runs without the daemon (the ledger is a plain file).
//!
//! Severity runs `allow` < `advise` < `block` (`nodeback.verdict_words`). A side that gave no verdict (`error`, `timeout`) is counted
//! as an error of that side and the pair is neither an agreement nor a disagreement.
use super::ledger::{self, Row};
use crate::cli::Parsed;
use crate::defaults;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Counts of one group of compared checks.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Tally {
    /// Compared pairs.
    pub n: u64,
    /// Same verdict.
    pub agree: u64,
    /// The engine allowed or advised where Node was stricter.
    pub weaker: u64,
    /// The engine was stricter than Node.
    pub stricter: u64,
    /// Node gave no verdict.
    pub node_err: u64,
    /// The engine gave no verdict.
    pub engine_err: u64,
}

impl Tally {
    fn add(&mut self, o: &Tally) {
        self.n += o.n;
        self.agree += o.agree;
        self.weaker += o.weaker;
        self.stricter += o.stricter;
        self.node_err += o.node_err;
        self.engine_err += o.engine_err;
    }

    fn json(&self) -> Value {
        json!({"n": self.n, "agree": self.agree, "engine_weaker": self.weaker, "engine_stricter": self.stricter, "node_errors": self.node_err, "engine_errors": self.engine_err})
    }
}

type Pair<'a> = (Option<&'a Row>, Option<&'a Row>);

/// The result of pairing a ledger window.
#[derive(Debug, Default)]
pub struct Report {
    /// Per check.
    pub checks: BTreeMap<String, Tally>,
    /// Per UTC day (days since the epoch).
    pub daily: BTreeMap<i64, Tally>,
    /// Everything.
    pub total: Tally,
    /// Distinct calls with at least one compared pair.
    pub runs: u64,
}

fn rank(v: &str) -> Option<usize> {
    defaults::list("nodeback.verdict_words").iter().position(|w| *w == v)
}

/// Pair `rows` (engine with node, by call and check) and tally them; `check` / `event` narrow the rows.
pub fn compare(rows: &[Row], check: Option<&str>, event: Option<&str>) -> Report {
    let mut pairs: BTreeMap<(&str, &str), Pair<'_>> = BTreeMap::new();
    for r in rows.iter().filter(|r| check.is_none_or(|c| r.chk == c) && event.is_none_or(|e| r.ev == e)) {
        let slot = pairs.entry((r.inv.as_str(), r.chk.as_str())).or_default();
        match r.src.as_str() {
            "engine" => slot.0 = Some(r),
            "node" => slot.1 = Some(r),
            _ => {}
        }
    }
    let mut rep = Report::default();
    let mut calls = std::collections::BTreeSet::new();
    for ((inv, chk), (e, n)) in pairs {
        let (Some(e), Some(n)) = (e, n) else { continue };
        let mut t = Tally { n: 1, ..Tally::default() };
        match (rank(&e.v), rank(&n.v)) {
            (Some(a), Some(b)) if a == b => t.agree = 1,
            (Some(a), Some(b)) if a < b => t.weaker = 1,
            (Some(_), Some(_)) => t.stricter = 1,
            (a, b) => {
                t.engine_err = u64::from(a.is_none());
                t.node_err = u64::from(b.is_none());
            }
        }
        calls.insert(inv);
        rep.checks.entry(chk.to_string()).or_default().add(&t);
        rep.daily.entry(super::day_of(e.ts)).or_default().add(&t);
        rep.total.add(&t);
    }
    rep.runs = calls.len() as u64;
    rep
}

/// The skip counts of the shadow (`shadow` / `skip_*`), as `reason -> count`, from the accounting counters.
fn skips() -> BTreeMap<String, u64> {
    let snap = crate::obs::counters::snapshot();
    let mut out = BTreeMap::new();
    if let Some(m) = snap.pointer("/accounting/shadow").and_then(Value::as_object) {
        for (name, v) in m.iter().filter(|(k, _)| k.starts_with("skip")) {
            out.insert(name.clone(), v.get("calls").and_then(Value::as_u64).unwrap_or(0));
        }
    }
    out
}

fn fmt_tally(key: &str, label: &str, t: &Tally) -> String {
    let (check, day) = (label, label);
    defaults::render(
        key,
        &[
            ("check", &check),
            ("day", &day),
            ("n", &t.n),
            ("agree", &t.agree),
            ("weaker", &t.weaker),
            ("stricter", &t.stricter),
            ("node_err", &t.node_err),
            ("engine_err", &t.engine_err),
        ],
    )
}

/// The report as JSON and as text.
pub fn render(rep: &Report, days: u64, daily: bool, json_out: bool) -> String {
    let skips = skips();
    let mode = defaults::text("nodeback.shadow_mode");
    let end = defaults::text("nodeback.shadow_end_date");
    if json_out {
        let checks: serde_json::Map<String, Value> = rep.checks.iter().map(|(k, t)| (k.clone(), t.json())).collect();
        let by_day: serde_json::Map<String, Value> = rep.daily.iter().map(|(d, t)| (super::day_text(*d), t.json())).collect();
        return json!({"window_days": days, "runs": rep.runs, "mode": mode, "end_date": end, "total": rep.total.json(), "checks": checks, "daily": by_day, "skips": skips}).to_string();
    }
    if rep.total.n == 0 {
        return defaults::render("nodeback.msg_report_none", &[("days", &days), ("mode", &mode), ("end", &end)]);
    }
    let mut lines =
        vec![defaults::render("nodeback.msg_report_head", &[("days", &days), ("runs", &rep.runs), ("rows", &rep.total.n), ("mode", &mode), ("end", &end)])];
    let mut worst: Vec<(&String, &Tally)> = rep.checks.iter().collect();
    worst.sort_by_key(|(_, t)| std::cmp::Reverse(t.weaker * 1000 + t.stricter * 100 + t.node_err + t.engine_err));
    lines.extend(worst.into_iter().take(defaults::num("nodeback.report_max_checks") as usize).map(|(k, t)| fmt_tally("nodeback.msg_report_check", k, t)));
    if daily {
        lines.extend(rep.daily.iter().map(|(d, t)| fmt_tally("nodeback.msg_report_daily", &super::day_text(*d), t)));
    }
    lines.push(fmt_tally("nodeback.msg_report_total", "", &rep.total));
    if !skips.is_empty() {
        let pairs = skips.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(" ");
        lines.push(defaults::render("nodeback.msg_report_skips", &[("skips", &pairs)]));
    }
    lines.join("\n")
}

fn flag_value<'a>(rest: &'a [String], name: &str) -> Option<&'a str> {
    rest.iter().position(|a| a == name).and_then(|i| rest.get(i + 1)).map(String::as_str)
}

/// `shadow-compare [--days N] [--check ID] [--event NAME] [--daily] [--json]`
pub fn run(p: &Parsed) -> i32 {
    let known = defaults::list("nodeback.compare_flags");
    let bad = p
        .rest
        .iter()
        .enumerate()
        .any(|(i, a)| a.starts_with("--") && !known.contains(&a.as_str()) || (!a.starts_with("--") && !(i > 0 && known.contains(&p.rest[i - 1].as_str()))));
    if bad {
        crate::ops::err(&format!("{}\n", defaults::text("nodeback.msg_usage_compare")));
        return 64;
    }
    let days = flag_value(&p.rest, "--days").and_then(|d| d.parse::<u64>().ok()).filter(|d| *d > 0).unwrap_or_else(|| defaults::num("nodeback.report_days"));
    let since = crate::health::now_ms().saturating_sub(days * defaults::num("nodeback.day_ms"));
    let rep = compare(&ledger::read_since(since), flag_value(&p.rest, "--check"), flag_value(&p.rest, "--event"));
    crate::ops::out(&format!("{}\n", render(&rep, days, p.rest.iter().any(|a| a == "--daily"), p.json)));
    0
}

/// The daily scheduled report: the JSON of the default window written to `nodeback.report_file`; the job's result text is the
/// totals line.
pub fn scheduled() -> Result<String, String> {
    let days = defaults::num("nodeback.report_days");
    let since = crate::health::now_ms().saturating_sub(days * defaults::num("nodeback.day_ms"));
    let rep = compare(&ledger::read_since(since), None, None);
    let body = render(&rep, days, true, true);
    let path = super::state_file("nodeback.report_file");
    crate::atomic::write(&path, body.as_bytes()).map_err(|e| e.to_string())?;
    Ok(rep.total.json().to_string())
}
