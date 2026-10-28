//! D88 latency gate, in its OWN test binary: it measures wall time, so it must not share a process with tests that spawn
//! daemons or load the machine (the telemetry lane learned this). A scripted check may add at most `script.p95_budget_us`
//! over the compiled port it replaced at the 95th percentile. The compiled port is gone, so the test holds the stricter
//! bound: the script's OWN p95 over its whole golden corpus stays under the budget (the added latency cannot exceed it).
//! The p95 budget failures of this bench on a shared dev machine are tracked in R1 (#22 work), not here: the assertions stay as they
//! are, and `.config/nextest.toml` gives the test a long slow-timeout so a slow run cannot TIMEOUT the gate.
//! Run in release, where the numbers mean something: `cargo test --release --test script_latency -- --nocapture`.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml

#[path = "common/scale.rs"]
mod scale;
use ah_engine::reqenv::RequestEnv;
use serde_json::Value;
use std::path::Path;

struct Laid {
    /// The case's scratch home, removed once the check is measured.
    home: String,
    payload: Value,
    opts: Value,
    event: String,
    env: RequestEnv,
}

fn plugin() -> String {
    let _ = ah_engine::defaults::text("script.ext"); // the root is known once the defaults are loaded
    std::fs::canonicalize(ah_engine::defaults::root().expect("plugin root")).unwrap().to_string_lossy().into_owned()
}

/// The time tokens of a golden case (`{MS:-300000}`, `{ISO:..}`, `{HM:..}`, `{DATE:..}`, `{LDATE:..}`) at the real clock, the
/// `{HOMEENC}` token and the `{HOME...}` directories; only the shape of the work is measured here, not the answers.
fn fill(s: &str, home: &str, real: &str) -> String {
    let enc: String = real.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '.') { '-' } else { c }).collect();
    let mut out = s.replace("{PLUGIN}", &plugin()).replace("{HOMEENC}", &enc).replace("{HOMEREAL}", real).replace("{HOME}", home);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let re = regex::Regex::new(r"\{(MS|ISO|HM|DATE|LDATE|LSTART):(-?[0-9]+)\}").unwrap();
    let tokens: Vec<(String, String, i64)> = re.captures_iter(&out).map(|c| (c[0].to_string(), c[1].to_string(), c[2].parse().unwrap())).collect();
    for (tok, kind, off) in tokens {
        let t = now + off;
        let iso = || {
            let d = std::time::UNIX_EPOCH + std::time::Duration::from_millis(t.max(0) as u64);
            let secs = d.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
            let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
            let z = days + 719_468;
            let era = z.div_euclid(146_097);
            let doe = z - era * 146_097;
            let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let day = doy - (153 * mp + 2) / 5 + 1;
            let month = if mp < 10 { mp + 3 } else { mp - 9 };
            let year = yoe + era * 400 + i64::from(month <= 2);
            (format!("{year:04}-{month:02}-{day:02}"), format!("{:02}:{:02}:{:02}", rem / 3600, rem % 3600 / 60, rem % 60), t.rem_euclid(1000))
        };
        let text = match kind.as_str() {
            "MS" => t.to_string(),
            "ISO" => {
                let (d, h, ms) = iso();
                format!("{d}T{h}.{ms:03}Z")
            }
            "HM" => {
                let (_, h, _) = iso();
                format!("{} UTC", &h[..5])
            }
            "LSTART" => {
                // the shape `ps -o lstart=` prints (UTC here: only the work is measured)
                let (d, h, _) = iso();
                let (y, mo, da) = (&d[..4], d[5..7].parse::<usize>().unwrap(), &d[8..]);
                let mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mo - 1];
                format!("Mon {mon} {:>2} {h} {y}", da.trim_start_matches('0'))
            }
            _ => iso().0,
        };
        out = out.replace(&tok, &text);
    }
    ah_engine::script::expand_now(&out, now as f64)
}

fn sub(v: &Value, home: &str, real: &str) -> Value {
    match v {
        Value::String(s) => Value::String(fill(s, home, real)),
        Value::Array(a) => Value::Array(a.iter().map(|x| sub(x, home, real)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (fill(k, home, real), sub(x, home, real))).collect()),
        other => other.clone(),
    }
}

fn lay(case: &Value, seq: usize) -> Laid {
    let home = std::env::temp_dir().join(format!("ah-latency-{}-{seq}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let real = std::fs::canonicalize(&home).unwrap().to_string_lossy().into_owned();
    let home = home.to_string_lossy().into_owned();
    if let Some(files) = case.get("files").and_then(Value::as_object) {
        for (rel, spec) in files {
            let path = Path::new(&home).join(fill(&rel.replace("{HOME}/", ""), &home, &real));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            match spec {
                Value::String(t) => std::fs::write(&path, fill(t, &home, &real)).unwrap(),
                Value::Object(o) if o.contains_key("link") => std::os::unix::fs::symlink(fill(o["link"].as_str().unwrap(), &home, &real), &path).unwrap(),
                Value::Object(o) if o.contains_key("text") => {
                    std::fs::write(&path, fill(o["text"].as_str().unwrap(), &home, &real)).unwrap();
                    if let Some(mode) = o.get("mode").and_then(Value::as_u64) {
                        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(mode as u32)).unwrap();
                    }
                }
                _ => std::fs::create_dir_all(&path).unwrap(),
            }
        }
    }
    let env: Vec<(String, String)> = case
        .get("env")
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, v)| (k.clone(), fill(v.as_str().unwrap_or_default(), &home, &real))).collect())
        .unwrap_or_default();
    Laid {
        home: home.clone(),
        payload: sub(case.get("payload").unwrap_or(&Value::Null), &home, &real),
        opts: sub(case.get("opts").unwrap_or(&Value::Null), &home, &real),
        event: case.get("event").and_then(Value::as_str).unwrap_or("PreToolUse").to_string(),
        env: RequestEnv::from_pairs(env),
    }
}

#[test]
fn scripted_checks_stay_inside_the_latency_budget() {
    let budget = ah_engine::script::p95_budget_us();
    let mut over = Vec::new();
    let mut seq = 0;
    let mut measured = 0;
    // AH_LATENCY_ONLY=<check>: measure that check only; AH_LATENCY_PASSES=<n>: passes over its corpus (default 20), for a profiler to attach
    let only = std::env::var("AH_LATENCY_ONLY").ok();
    let passes = std::env::var("AH_LATENCY_PASSES").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(20);
    for c in ah_engine::checks::registry().iter().filter(|c| c.scripted() && only.as_deref().is_none_or(|o| o == c.name())) {
        let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/golden/{}.jsonl", c.name()))).ok();
        let Some(text) = text else { continue }; // a check whose parity is the Node runner's (no golden corpus)
        let laid: Vec<Laid> = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                seq += 1;
                lay(&serde_json::from_str(l).unwrap(), seq)
            })
            .collect();
        let first = laid.first().expect("a golden corpus");
        let t0 = std::time::Instant::now();
        let _ = ah_engine::script::run_forced(c.name(), &first.payload, &first.opts, &first.event, &first.env);
        let cold = t0.elapsed().as_micros();
        let mut us: Vec<u128> = Vec::new();
        let mut by_case: Vec<(u128, usize)> = Vec::new(); // (microseconds, corpus line) of every call, for AH_LATENCY_TOP
        // twenty passes over the corpus, or as many as fit in the time cap (a corpus whose calls wait on a child process or sleep,
        // such as the MCP reaper's grace period, is measured on fewer passes: one pass is always taken)
        let started = std::time::Instant::now();
        for _ in 0..passes {
            for (i, l) in laid.iter().enumerate() {
                let t = std::time::Instant::now();
                let _ = ah_engine::script::run_forced(c.name(), &l.payload, &l.opts, &l.event, &l.env);
                us.push(t.elapsed().as_micros());
                by_case.push((*us.last().unwrap_or(&0), i));
            }
            if started.elapsed() > std::time::Duration::from_secs(10) {
                break;
            }
        }
        // the homes live in the temp dir: left behind, every run of this test added one per golden case (the live6 replay found
        // ~390,000 there, and a Python probe that lists the temp dir took tens of seconds)
        for l in &laid {
            ah_engine::discard::harmless(std::fs::remove_dir_all(&l.home)); // keep: cleanup of a scratch directory
        }
        // AH_LATENCY_TOP=<n>: the n slowest calls of each check, with the golden case they ran (the profile of a p95 miss)
        if let Some(n) = std::env::var("AH_LATENCY_TOP").ok().and_then(|v| v.parse::<usize>().ok()) {
            let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
            by_case.sort_unstable_by_key(|a| std::cmp::Reverse(a.0));
            let mut seen = std::collections::BTreeMap::<usize, (u128, usize)>::new();
            for (t, i) in &by_case {
                let e = seen.entry(*i).or_insert((0, 0));
                e.0 += t;
                e.1 += 1;
            }
            let mut mean: Vec<(usize, u128)> = seen.into_iter().map(|(i, (t, k))| (i, t / k as u128)).collect();
            mean.sort_unstable_by_key(|a| std::cmp::Reverse(a.1));
            for (i, t) in mean.iter().take(n) {
                let v: Value = serde_json::from_str(lines[*i]).unwrap_or(Value::Null);
                println!(
                    "  SLOW {:<24} case {i:>4} mean={t:>6}us n={} payload={}",
                    c.name(),
                    v.get("n").unwrap_or(&Value::Null),
                    v.get("payload").map(|p| p.to_string().chars().take(160).collect::<String>()).unwrap_or_default()
                );
            }
        }
        us.sort_unstable();
        let (p50, p95, p99) = (us[us.len() / 2], us[us.len() * 95 / 100], us[us.len() * 99 / 100]);
        println!("LATENCY {:<24} calls={:<6} cold={cold:>6}us p50={p50:>5}us p95={p95:>5}us p99={p99:>5}us budget={budget}us", c.name(), us.len());
        measured += 1;
        // a check that waits on a child process or a disk sync has that wait in its own p95 (the compiled port paid it too): its
        // budget is set per check in `script.p95_budget_by_check`, with the measured compiled baseline noted beside it
        let allowed = ah_engine::script::p95_budget_for(c.name()).saturating_mul(scale::time_scale());
        if p95 as u64 > allowed {
            over.push(format!("{} p95 {p95}us over {allowed}us", c.name()));
        }
    }
    assert!(measured >= 6, "measured the scripted checks that have a corpus: {measured}");
    assert!(over.is_empty(), "over the {budget}us budget: {over:?}");
}
