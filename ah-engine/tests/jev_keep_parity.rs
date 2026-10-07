//! Node-vs-engine parity of what the Jev decision layer keeps besides the decision log: the daily rollups folded out of the
//! log, the budget-watch state and warning, and the opt-in audit snippets. Node's own functions (`hooks/lib/jev-assist.js`,
//! exported for exactly this) run on one isolated home and the engine's on another, from the same seeded input, and the
//! files they leave must be equal (clock fields removed). Nothing touches a real home; no network.
use ah_engine::jev::keep;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn home(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-jevkeep-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join(".anti-hall/logs")).unwrap();
    d
}

/// Run a snippet of Node with the Jev assist module as `a` and the JSON `arg` as `A`.
fn node(script: &str, arg: &Value) {
    let hooks = repo().join("plugins/anti-hall/hooks/lib/jev-assist.js");
    let code = format!("const a=require({});const A=JSON.parse(process.argv[1]);{script}", serde_json::to_string(&hooks.to_string_lossy()).unwrap());
    let out = Command::new("node")
        .arg("-e")
        .arg(code)
        .arg(arg.to_string())
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(out.status.success(), "node failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// A tiny deterministic generator, so the seeded log is the same on every run.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn pick<'a, T>(&mut self, v: &'a [T]) -> &'a T {
        &v[(self.next() as usize) % v.len()]
    }
}

fn seeded_rows() -> Vec<Value> {
    let mut g = Lcg(7);
    let ids = ["claimLedger", "speculation", "speculationFramed", "gitGuardSelfCredit", "dispatchTier", "modelRouting", "newRequest", "outputVerifyGuard", "mergeGateHedge"];
    let backends = ["jev", "cache", "baseline-only"];
    let modes = ["on", "shadow", "off"];
    let mut rows = Vec::new();
    for i in 0..400 {
        let day = 1 + (i % 5);
        let ts = format!("2026-09-{:02}T{:02}:{:02}:{:02}.{:03}Z", day, g.next() % 24, g.next() % 60, g.next() % 60, g.next() % 1000);
        let id = *g.pick(&ids);
        if i % 17 == 0 {
            rows.push(json!({"ts": ts, "type": "outcome", "id": id, "h": format!("h{i}"), "outcome": g.pick(&["evidence-added", "repeat-speculation", "user-override"]), "source": "regex", "project": "p"}));
            continue;
        }
        if i % 29 == 0 {
            rows.push(json!({"ts": ts, "type": "budget-warning", "window": "daily", "spentUsd": 1.5, "budgetUsd": 1}));
            continue;
        }
        let backend = *g.pick(&backends);
        let mode = *g.pick(&modes);
        let mut r = json!({"ts": ts, "id": id, "h": format!("{:x}", g.next() % 40), "base": false, "jev": if g.next() % 5 == 0 { json!("label") } else { json!(g.next() % 2 == 0) },
            "conf": 0.9, "ms": (g.next() % 3000) as f64, "backend": backend, "final": false, "changed": if g.next() % 3 == 0 { json!("added") } else { Value::Null },
            "cached": backend == "cache", "mode": mode, "project": "p"});
        if g.next() % 3 == 0 {
            r["wouldChange"] = json!("added");
        }
        if g.next() % 6 == 0 {
            r["reason"] = json!(*g.pick(&["timeout", "http-500", "no-key"]));
        }
        if g.next() % 4 == 0 {
            r["costUsd"] = json!((g.next() % 1000) as f64 / 1e6);
        }
        if g.next() % 5 == 0 {
            r["transport"] = json!(*g.pick(&["vercel", "typesafe"]));
        }
        if g.next() % 9 == 0 {
            r["fellBack"] = json!(true);
        }
        rows.push(r);
    }
    // one big group, so the percentiles are taken over many samples
    for i in 0..300 {
        rows.push(json!({"ts": format!("2026-09-03T12:{:02}:{:02}.000Z", i % 60, (i / 60) % 60), "id": "speculation", "h": format!("big{i}"), "backend": "jev", "mode": "shadow", "ms": (g.next() % 5000) as f64, "jev": true, "wouldChange": "added"}));
    }
    rows.push(json!({"id": "x", "backend": "jev"})); // no ts: skipped
    rows.push(json!({"ts": "not a date", "id": "x"})); // not a date: skipped
    rows
}

fn read_daily(home: &Path) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    for e in std::fs::read_dir(home.join(".anti-hall/logs/jev-daily")).unwrap().flatten() {
        let text = std::fs::read_to_string(e.path()).unwrap();
        let mut v: Value = serde_json::from_str(&text).unwrap();
        v.as_object_mut().unwrap().remove("generatedAt");
        // compare the text of the file with the clock field cut out, so key order and number text are compared too
        let cut = regex::Regex::new(r#""generatedAt":"[^"]*","#).unwrap().replace(&text, "").into_owned();
        assert!(v.get("complete").is_some(), "{text}");
        out.insert(e.file_name().to_string_lossy().into_owned(), cut);
    }
    out
}

#[test]
fn the_daily_rollups_are_the_same_files_as_node_writes() {
    let rows = seeded_rows();
    let text: String = rows.iter().map(|r| format!("{r}\n")).collect();
    let (nh, eh) = (home("rn"), home("re"));
    for h in [&nh, &eh] {
        // two generations, so the retained-files reader is exercised: the older half in `.1`, the rest in the live file
        let (old, new) = text.split_at(text.len() / 2);
        let cut = old.rfind('\n').map_or(0, |i| i + 1);
        std::fs::write(h.join(".anti-hall/logs/jev-assist.ndjson.1"), &text[..old.len().min(cut)]).unwrap();
        std::fs::write(h.join(".anti-hall/logs/jev-assist.ndjson"), format!("{}{new}", &text[old.len().min(cut)..old.len()])).unwrap();
        // a day whose early rows already rotated away keeps its earlier rollup
        std::fs::create_dir_all(h.join(".anti-hall/logs/jev-daily")).unwrap();
        std::fs::write(h.join(".anti-hall/logs/jev-daily/2026-09-01.json"), r#"{"generatedAt":"x","complete":true,"keep":"me"}"#).unwrap();
    }
    node("process.stdout.write(String(a.writeDailyRollups(A.home)))", &json!({"home": nh.to_string_lossy()}));
    keep::write_daily_rollups(&eh.join(".anti-hall/logs/jev-assist.ndjson"));
    let (n, e) = (read_daily(&nh), read_daily(&eh));
    assert_eq!(n.keys().collect::<Vec<_>>(), e.keys().collect::<Vec<_>>());
    for (k, v) in &n {
        assert_eq!(v, &e[k], "rollup {k} differs");
    }
    assert!(n.len() >= 5, "five seeded days");
}

#[test]
fn the_budget_watch_keeps_the_same_state_and_warns_once_a_day() {
    let (nh, eh) = (home("bn"), home("be"));
    let costs = [0.004, 0.004, 0.004, 0.0021, 0.5];
    let mut warnings = Vec::new();
    node(
        "for (const c of A.costs) a.maybeWarnBudget({home:A.home,costUsd:c});",
        &json!({"home": nh.to_string_lossy(), "costs": costs}),
    );
    std::fs::create_dir_all(nh.join(".anti-hall")).ok();
    // Node reads the budget mode from the home's settings: written before its calls
    let settings = r#"{"jev":{"budget":{"mode":"watch","usdPerDay":0.01}}}"#;
    for h in [&nh, &eh] {
        std::fs::write(h.join(".anti-hall/settings.json"), settings).unwrap();
    }
    let _ = std::fs::remove_dir_all(nh.join(".anti-hall/state"));
    let _ = std::fs::remove_file(nh.join(".anti-hall/logs/jev-assist.ndjson"));
    node("for (const c of A.costs) a.maybeWarnBudget({home:A.home,costUsd:c});", &json!({"home": nh.to_string_lossy(), "costs": costs}));
    for c in costs {
        if let Some(w) = keep::maybe_warn_budget(&eh, true, Some(0.01), Some(c)) {
            warnings.push(w);
        }
    }
    let state = |h: &Path| std::fs::read_to_string(h.join(".anti-hall/state/jev-budget.json")).unwrap();
    assert_eq!(state(&nh), state(&eh), "the budget state file");
    let node_rows: Vec<Value> = std::fs::read_to_string(nh.join(".anti-hall/logs/jev-assist.ndjson")).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(node_rows.len(), 1, "one warning a day");
    assert_eq!(warnings.len(), 1);
    assert_eq!((node_rows[0]["spentUsd"].as_f64().unwrap(), node_rows[0]["budgetUsd"].as_f64().unwrap()), warnings[0]);
    assert_eq!(keep::maybe_warn_budget(&eh, false, Some(0.01), Some(1.0)), None, "unlimited mode keeps nothing");
}

#[test]
fn the_audit_snippets_are_the_same_rows_as_node_writes() {
    let secret = "token sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 and AKIAIOSFODNN7EXAMPLE end";
    let long = format!("{secret} {}", "word ".repeat(600));
    let cases: Vec<(&str, String, Value, Value)> = vec![
        ("claimLedger", "a short text".into(), json!("added"), Value::Null),
        ("claimLedger", secret.into(), Value::Null, json!("added")),
        ("claimLedger", long.clone(), json!("relaxed"), Value::Null),
        ("outputVerifyGuard", long.clone(), Value::Null, json!("changed")),
        ("outputVerifyGuard", "short output".into(), json!("added"), Value::Null),
        ("speculation", "nothing changed".into(), Value::Null, Value::Null),
    ];
    let (nh, eh) = (home("an"), home("ae"));
    for h in [&nh, &eh] {
        std::fs::write(h.join(".anti-hall/settings.json"), r#"{"jev":{"audit":{"snippets":true}}}"#).unwrap();
    }
    for (id, state, changed, would) in &cases {
        node(
            "a.maybeWriteAuditSnippet({home:A.home,id:A.id,hash:'abc123',state:A.state,changed:A.changed,wouldChange:A.would})",
            &json!({"home": nh.to_string_lossy(), "id": id, "state": state, "changed": changed, "would": would}),
        );
        keep::maybe_write_audit_snippet(&eh.join(".anti-hall/logs"), true, id, "abc123", state, changed, would);
    }
    keep::maybe_write_audit_snippet(&eh.join(".anti-hall/logs"), false, "claimLedger", "off", "x", &json!("added"), &Value::Null);
    let rows = |h: &Path| -> Vec<String> {
        std::fs::read_to_string(h.join(".anti-hall/logs/jev-audit.ndjson"))
            .unwrap()
            .lines()
            .map(|l| regex::Regex::new(r#""ts":"[^"]*""#).unwrap().replace(l, "\"ts\":\"T\"").into_owned())
            .collect()
    };
    assert_eq!(rows(&nh).len(), 5, "the unchanged decision stores nothing");
    assert_eq!(rows(&nh), rows(&eh));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(eh.join(".anti-hall/logs/jev-audit.ndjson")).unwrap().permissions().mode() & 0o777, 0o600);
}
