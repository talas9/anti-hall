//! Golden parity corpus of the scripted checks (D88): `tests/golden/<check>.jsonl`, one case per line, each with the
//! payload, the request environment, the files to lay out under a fresh home directory and `expect`, the answer the
//! compiled port gave before it was removed. The script must give the byte-identical answer; `parity/run-golden.js` replays
//! the same corpus against the Node hook, which is the oracle.
//!
//! Placeholders in every string of a case: `{HOME}` is the case's fresh home directory, `{HOMEREAL}` its canonical path,
//! `{PLUGIN}` the canonical plugin root (for a check whose answer names it).
//! `files` maps a path under the home to its text, or to `{"link": target}` (a symbolic link), `{"dir": true}` or
//! `{"text": t, "age_ms": n, "mode": m}` (a file last modified `n` ms before the case's clock, with permission bits `m`: 493 is 0755).
//!
//! Time: a case runs at a pinned clock ([`NOW0`], the script's `ah.clock.now()`); a string may carry `{MS:-300000}` (that many
//! ms from the clock, as a number), `{ISO:-300000}` (its ISO text), `{HM:-300000}` (its `hh:mm UTC` text), `{DATE:..}` / `{LDATE:..}`
//! (its UTC / local calendar day) or `{LSTART:..}` (the local time as `ps -o lstart=` prints it). An answer is stored with the same
//! tokens, so the corpus does not depend on the day it is replayed. A case that places events at the real moment (`{NOW-5000}`,
//! `{ISO}`, `{DATE}`, no colon) or sets `normTs` runs at the real clock instead.
use super::*;
use serde_json::json;
use std::collections::BTreeMap;

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

pub fn load(check: &str) -> Vec<Value> {
    let text = std::fs::read_to_string(dir().join(format!("{check}.jsonl"))).unwrap_or_else(|e| panic!("golden {check}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("golden {check}: {e}"))).collect()
}

/// The canonical plugin root.
fn plugin() -> String {
    let _ = defaults::text("script.ext"); // the root is known once the defaults are loaded
    let root = defaults::root().expect("plugin root");
    std::fs::canonicalize(root).unwrap().to_string_lossy().into_owned()
}

/// The pinned clock a golden case runs at (the script's `ah.clock.now()`); generation uses the real time instead.
pub const NOW0: f64 = 1_790_000_000_000.0;

fn time_tokens(s: &str) -> Vec<(String, String, i64)> {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = R.get_or_init(|| regex::Regex::new(r"\{(MS|ISO|HM|DATE|LDATE|LSTART):(-?[0-9]+)\}").unwrap());
    re.captures_iter(s).map(|c| (c[0].to_string(), c[1].to_string(), c[2].parse().unwrap())).collect()
}

fn time_text(kind: &str, now: f64, off: i64) -> String {
    let t = now + off as f64;
    match kind {
        "MS" => format!("{}", t as i64),
        "ISO" => crate::checks::agent_scan::iso_utc(t),
        "DATE" => crate::checks::agent_scan::iso_utc(t)[..10].to_string(),
        "LDATE" => {
            // the machine's local calendar date (what a hook that names a directory after "today" sees)
            let v: Value = serde_json::from_str(&super::host_b3::local_time(t)).unwrap();
            format!("{:04}-{:02}-{:02}", v["year"].as_i64().unwrap(), v["month"].as_i64().unwrap(), v["day"].as_i64().unwrap())
        }
        "LSTART" => {
            // `ps -o lstart=` as macOS and Linux print it: `Mon Jan  5 03:04:05 2026`, in the local zone
            let v: Value = serde_json::from_str(&super::host_b3::local_time(t)).unwrap();
            let (wd, mon) =
                (["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
            let n = |k: &str| v[k].as_i64().unwrap();
            format!(
                "{} {} {:>2} {:02}:{:02}:{:02} {}",
                wd[n("weekday") as usize],
                mon[n("month") as usize - 1],
                n("day"),
                n("hour"),
                n("minute"),
                n("second"),
                n("year")
            )
        }
        _ => crate::checks::agent_scan::hhmm(t),
    }
}

fn fill_time(s: &str, now: f64) -> String {
    let mut out = s.to_string();
    for (tok, kind, off) in time_tokens(s) {
        out = out.replace(&tok, &time_text(&kind, now, off));
    }
    out
}

fn fill(s: &str, home: &str, real: &str, now: f64) -> String {
    // `{HOMEENC}`: the real home path as the host names a project directory (`/`, `\\`, `:` and `.` become `-`)
    let enc: String = real.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '.') { '-' } else { c }).collect();
    // `{NOW}`, `{NOW-<ms>}`, `{ISO..}`, `{DATE..}` (no colon) are the other token family: see `script::expand_now`
    super::expand_now(&fill_time(&s.replace("{PLUGIN}", &plugin()).replace("{HOMEENC}", &enc).replace("{HOMEREAL}", real).replace("{HOME}", home), now), now)
}

fn sub(v: &Value, home: &str, real: &str, now: f64) -> Value {
    match v {
        Value::String(s) => Value::String(fill(s, home, real, now)),
        Value::Array(a) => Value::Array(a.iter().map(|x| sub(x, home, real, now)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (fill(k, home, real, now), sub(x, home, real, now))).collect()),
        other => other.clone(),
    }
}

/// The inverse of [`sub`] for an answer (canonical path first: it contains the plain one; then the time texts the case's
/// tokens produced, longest first).
fn unsub(s: &str, home: &str, real: &str, times: &[(String, String)]) -> String {
    let mut out = s.replace(&plugin(), "{PLUGIN}").replace(real, "{HOMEREAL}").replace(home, "{HOME}");
    for (text, tok) in times {
        out = out.replace(text, tok);
    }
    out
}

/// A case laid out on disk: `(payload, opts, event, env, home, real home)`.
pub struct Laid {
    pub payload: Value,
    pub opts: Value,
    pub event: String,
    pub env: RequestEnv,
    pub home: String,
    pub real: String,
    /// The clock the case was laid out at.
    pub now: f64,
    /// `(text, token)` for every time token of the case, longest text first.
    pub times: Vec<(String, String)>,
    /// The case's `vmask`: regular expressions whose matches in an answer's text are not compared.
    pub vmask: Vec<String>,
    /// The case sets `normTs`: runs of 12 or more digits (a clock reading) are `{TS}` in its stored and compared answers, and
    /// the case runs at the real clock.
    pub norm: bool,
}

static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn lay(case: &Value) -> Laid {
    // A case that places events relative to the real moment (`{NOW-5000}`, `{ISO}`, `{DATE}`: no colon) or normalizes clock readings
    // (`normTs`) runs at the real clock, as the settings and skip files the host reads are judged against it; every other case runs at
    // the pinned one (the `{MS:-1000}` family, whose answers are stored as the same tokens).
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = R.get_or_init(|| regex::Regex::new(r"\{(NOW|ISO|DATE)([-+][0-9]+)?\}").unwrap());
    let real = case.get("normTs").and_then(Value::as_bool).unwrap_or(false) || re.is_match(&case.to_string());
    lay_at(case, if real { crate::checks::replykit::io::now_ms() } else { NOW0 })
}

pub fn lay_at(case: &Value, now: f64) -> Laid {
    let mut times: Vec<(String, String)> = time_tokens(&case.to_string()).into_iter().map(|(tok, kind, off)| (time_text(&kind, now, off), tok)).collect();
    times.sort_by_key(|(t, _)| std::cmp::Reverse(t.len()));
    times.dedup();
    let home = std::env::temp_dir().join(format!("ah-golden-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(&home).unwrap();
    let real = std::fs::canonicalize(&home).unwrap().to_string_lossy().into_owned();
    let home = home.to_string_lossy().into_owned();
    if let Some(files) = case.get("files").and_then(Value::as_object) {
        for (rel, spec) in files {
            let path = Path::new(&home).join(fill_time(&rel.replace("{HOME}/", ""), now));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            match spec {
                Value::String(t) => std::fs::write(&path, fill(t, &home, &real, now)).unwrap(),
                Value::Object(o) if o.contains_key("link") => {
                    let target = fill(o["link"].as_str().unwrap(), &home, &real, now);
                    std::os::unix::fs::symlink(target, &path).unwrap();
                }
                Value::Object(o) if o.contains_key("text") => {
                    std::fs::write(&path, fill(o["text"].as_str().unwrap(), &home, &real, now)).unwrap();
                    if let Some(mode) = o.get("mode").and_then(Value::as_u64) {
                        // an executable fixture (a fake `ps`): the file's permission bits
                        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(mode as u32)).unwrap();
                    }
                    if let Some(age) = o.get("age_ms").and_then(Value::as_f64) {
                        let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis((now - age).max(0.0) as u64);
                        std::fs::File::options().write(true).open(&path).unwrap().set_modified(at).unwrap();
                    }
                }
                _ => std::fs::create_dir_all(&path).unwrap(),
            }
        }
    }
    let env: Vec<(String, String)> = case
        .get("env")
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, v)| (k.clone(), fill(v.as_str().unwrap_or_default(), &home, &real, now))).collect())
        .unwrap_or_default();
    Laid {
        payload: sub(case.get("payload").unwrap_or(&Value::Null), &home, &real, now),
        opts: sub(case.get("opts").unwrap_or(&Value::Null), &home, &real, now),
        event: case.get("event").and_then(Value::as_str).unwrap_or("PreToolUse").to_string(),
        env: RequestEnv::from_pairs(env),
        home,
        real,
        now,
        times,
        norm: case.get("normTs").and_then(Value::as_bool).unwrap_or(false),
        vmask: case.get("vmask").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(),
    }
}

/// `text` with every run of 12 or more digits (a clock reading) replaced by `{TS}`.
fn norm_ts(text: &str, full: bool) -> String {
    let mut out = String::new();
    let mut run = String::new();
    for ch in text.chars().chain(std::iter::once('\0')) {
        if ch.is_ascii_digit() {
            run.push(ch);
            continue;
        }
        out.push_str(if run.len() >= 12 { "{TS}" } else { &run });
        run.clear();
        if ch != '\0' {
            out.push(ch);
        }
    }
    if full { day_ts(&iso_ts(&out)) } else { out }
}

/// `text` with every calendar day (`2026-10-09`) replaced by `{DATE}`.
fn day_ts(text: &str) -> String {
    let b = text.as_bytes();
    let shape = b"dddd-dd-dd";
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < b.len() {
        let digit_before = i > 0 && b[i - 1].is_ascii_digit();
        let hit = !digit_before
            && i + shape.len() <= b.len()
            && shape.iter().zip(&b[i..]).all(|(s, c)| if *s == b'd' { c.is_ascii_digit() } else { s == c })
            && !b.get(i + shape.len()).is_some_and(u8::is_ascii_digit);
        if hit {
            out.push_str("{DATE}");
            i += shape.len();
        } else {
            let ch = text[i..].chars().next().unwrap_or('\0');
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// `text` with every ISO-8601 UTC instant with milliseconds (`2026-10-09T00:12:51.123Z`) replaced by `{ISO}`.
fn iso_ts(text: &str) -> String {
    let b = text.as_bytes();
    let shape = b"dddd-dd-ddTdd:dd:dd.dddZ";
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < b.len() {
        let hit = i + shape.len() <= b.len() && shape.iter().zip(&b[i..]).all(|(s, c)| if *s == b'd' { c.is_ascii_digit() } else { s == c });
        if hit {
            out.push_str("{ISO}");
            i += shape.len();
        } else {
            let ch = text[i..].chars().next().unwrap_or('\0');
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// The verdict as the corpus stores it, with the case's directories replaced by their placeholders.
pub fn verdict_json(v: &Option<Verdict>, l: &Laid) -> Value {
    let u = |s: &str| {
        let mut t = unsub(s, &l.home, &l.real, &l.times);
        for m in &l.vmask {
            t = regex::Regex::new(m).unwrap().replace_all(&t, "{V*}").into_owned();
        }
        if l.norm { norm_ts(&t, true) } else { t }
    };
    match v {
        None => json!({"v": "none"}),
        Some(Verdict::Allow) => json!({"v": "allow"}),
        Some(Verdict::Defer) => json!({"v": "defer"}),
        Some(Verdict::Block(m)) => json!({"v": "block", "text": u(m)}),
        Some(Verdict::Advisory(m)) => json!({"v": "advisory", "text": u(m)}),
        Some(Verdict::Exact(x)) => json!({"v": "exact", "code": x.code, "out": u(&x.out), "err": u(&x.err)}),
        Some(Verdict::Routed(inner, meta)) => {
            let m: Vec<Value> = meta
                .iter()
                .map(|r| {
                    json!({
                        "requested_model": r.requested_model, "parent_model": r.parent_model, "task_class": r.task_class,
                        "recommended_tier": r.recommended_tier, "selected_model": r.selected_model, "outcome": r.outcome,
                        "spawn_key": r.spawn_key, "delegate": r.delegate, "blocked": r.blocked,
                    })
                })
                .collect();
            json!({"v": "routed", "verdict": verdict_json(&Some((**inner).clone()), l), "meta": m})
        }
    }
}

/// The text of a watched file with its timestamps (runs of 12 or more digits) replaced by `{TS}`, or `null` when absent.
fn watched(home: &str, real: &str, times: &[(String, String)], mask_iso: bool, masks: &[String], rel: &str, full: bool) -> Value {
    let Ok(mut text) = std::fs::read_to_string(Path::new(home).join(rel)) else { return Value::Null };
    if mask_iso {
        // a case flagged `mask_iso`: the written clock readings (ISO texts) are not compared, only that one was written; they are
        // masked before the case's own time tokens are turned back, or a date inside an ISO text would be tokenized first
        static R0: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        text = R0
            .get_or_init(|| regex::Regex::new(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z").unwrap())
            .replace_all(&text, "{ISO*}")
            .into_owned();
        // the Jev log row names the project of the PROCESS's working directory, which differs between runs and runners
        static P: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        text = P.get_or_init(|| regex::Regex::new(r#""project":"[^"]*""#).unwrap()).replace_all(&text, r#""project":"{P*}""#).into_owned();
    }
    let mut text = unsub(&text, home, real, times);
    for m in masks {
        // a case's own `mask` list: regular expressions whose matches are not compared (values that depend on the day or the path)
        text = regex::Regex::new(m).unwrap().replace_all(&text, "{M*}").into_owned();
    }
    let mut out = String::new();
    let mut run = String::new();
    for ch in text.chars().chain(std::iter::once('\0')) {
        if ch.is_ascii_digit() {
            run.push(ch);
            continue;
        }
        out.push_str(if run.len() >= 12 { "{TS}" } else { &run });
        run.clear();
        if ch != '\0' {
            out.push(ch);
        }
    }
    // a time with a fraction of a millisecond (a modification time Node read with its nanoseconds): the fraction is not compared
    static F: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let out = F.get_or_init(|| regex::Regex::new(r"\{TS\}\.[0-9]+").unwrap()).replace_all(&out, "{TS}").into_owned();
    Value::String(if full { day_ts(&iso_ts(&out)) } else { out })
}

/// What a case's `watch` files hold after a run: `{rel: text-with-{TS}-or-null}`.
pub fn watched_all_pub(case: &Value, l: &Laid) -> Value {
    watched_all(case, l)
}

fn watched_all(case: &Value, l: &Laid) -> Value {
    let masks: Vec<String> =
        case.get("mask").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    let rels: Vec<&str> = case.get("watch").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    Value::Object(
        rels.iter()
            .map(|r| {
                (
                    r.to_string(),
                    watched(
                        &l.home,
                        &l.real,
                        &l.times,
                        case.get("mask_iso").and_then(Value::as_bool).unwrap_or(false),
                        &masks,
                        &super::expand_now(&fill_time(r, l.now), l.now),
                        l.norm,
                    ),
                )
            })
            .collect(),
    )
}

/// The script's answer to a laid-out case, at the case's pinned clock.
pub fn run_case(check: &str, l: &Laid, repeat: usize) -> Option<Option<Verdict>> {
    super::host::set_clock(Some(l.now));
    // `repeat` runs: the earlier ones only leave their state behind, the last one is the answer
    for _ in 1..repeat {
        let _ = run_forced(check, &l.payload, &l.opts, &l.event, &l.env);
    }
    let got = run_forced(check, &l.payload, &l.opts, &l.event, &l.env);
    super::host::set_clock(None);
    got
}

/// How many times a case runs on the same home (`"repeat"`, default 1).
pub fn repeat_of(case: &Value) -> usize {
    case.get("repeat").and_then(Value::as_u64).map_or(1, |n| n.max(1) as usize)
}

/// Every case's answer from the script, against its stored `expect`. Returns the number of cases and of each kind.
pub fn assert_script_matches(check: &str) -> BTreeMap<String, usize> {
    let mut kinds = BTreeMap::new();
    let cases = load(check);
    assert!(cases.len() >= 20, "{check}: a golden corpus of real size");
    for c in &cases {
        let l = lay(c);
        let got = run_case(check, &l, repeat_of(c)).unwrap_or_else(|| panic!("{check}: no shipped script"));
        let got = verdict_json(&got, &l);
        assert_eq!(
            got,
            c["expect"],
            "{check}: script differs from the compiled port on case {}: {} (script errors: {:?})",
            c["n"],
            c["payload"],
            crate::discard::captured()
        );
        if c.get("watch").is_some() {
            assert_eq!(watched_all(c, &l), c["writes"], "{check}: the files the script wrote differ from the compiled port's on case {}", c["n"]);
        }
        *kinds.entry(got["v"].as_str().unwrap_or("").to_string()).or_insert(0) += 1;
        crate::discard::harmless(std::fs::remove_dir_all(&l.home)); // keep: cleanup of a scratch directory
    }
    kinds
}

/// Fill in (or rewrite) every case's `expect` from the compiled port. Used once per check, before its port is removed.
#[allow(dead_code)]
pub fn regenerate(check: &str, compiled: &dyn Fn(&Laid) -> Option<Verdict>) {
    let mut out = String::new();
    for c in load(check) {
        // the clock is read per case: a long corpus must not age its own fixtures
        let l = lay_at(&c, crate::checks::replykit::io::now_ms());
        let mut c = c;
        for _ in 1..repeat_of(&c) {
            let _ = compiled(&l);
        }
        c["expect"] = verdict_json(&compiled(&l), &l);
        if c.get("watch").is_some() {
            c["writes"] = watched_all(&c, &l);
        }
        out.push_str(&serde_json::to_string(&c).unwrap());
        out.push('\n');
        crate::discard::harmless(std::fs::remove_dir_all(&l.home)); // keep: cleanup of a scratch directory
    }
    std::fs::write(dir().join(format!("{check}.jsonl")), out).unwrap();
}
