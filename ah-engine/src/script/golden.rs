//! Golden parity corpus of the scripted checks (D88): `tests/golden/<check>.jsonl`, one case per line, each with the
//! payload, the request environment, the files to lay out under a fresh home directory and `expect`, the answer the
//! compiled port gave before it was removed. The script must give the byte-identical answer; `parity/run-golden.js` replays
//! the same corpus against the Node hook, which is the oracle.
//!
//! Placeholders in every string of a case: `{HOME}` is the case's fresh home directory, `{HOMEREAL}` its canonical path.
//! `files` maps a path under the home to its text, or to `{"link": target}` (a symbolic link) or `{"dir": true}`.
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

fn sub(v: &Value, home: &str, real: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace("{HOMEREAL}", real).replace("{HOME}", home)),
        Value::Array(a) => Value::Array(a.iter().map(|x| sub(x, home, real)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.replace("{HOMEREAL}", real).replace("{HOME}", home), sub(x, home, real))).collect()),
        other => other.clone(),
    }
}

/// The inverse of [`sub`] for an answer (canonical path first: it contains the plain one).
fn unsub(s: &str, home: &str, real: &str) -> String {
    s.replace(real, "{HOMEREAL}").replace(home, "{HOME}")
}

/// A case laid out on disk: `(payload, opts, event, env, home, real home)`.
pub struct Laid {
    pub payload: Value,
    pub opts: Value,
    pub event: String,
    pub env: RequestEnv,
    pub home: String,
    pub real: String,
}

static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn lay(case: &Value) -> Laid {
    let home = std::env::temp_dir().join(format!("ah-golden-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(&home).unwrap();
    let real = std::fs::canonicalize(&home).unwrap().to_string_lossy().into_owned();
    let home = home.to_string_lossy().into_owned();
    if let Some(files) = case.get("files").and_then(Value::as_object) {
        for (rel, spec) in files {
            let path = Path::new(&home).join(rel.replace("{HOME}/", ""));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            match spec {
                Value::String(t) => std::fs::write(&path, t.replace("{HOMEREAL}", &real).replace("{HOME}", &home)).unwrap(),
                Value::Object(o) if o.contains_key("link") => {
                    let target = o["link"].as_str().unwrap().replace("{HOMEREAL}", &real).replace("{HOME}", &home);
                    std::os::unix::fs::symlink(target, &path).unwrap();
                }
                _ => std::fs::create_dir_all(&path).unwrap(),
            }
        }
    }
    let env: Vec<(String, String)> = case
        .get("env")
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().replace("{HOMEREAL}", &real).replace("{HOME}", &home))).collect())
        .unwrap_or_default();
    Laid {
        payload: sub(case.get("payload").unwrap_or(&Value::Null), &home, &real),
        opts: sub(case.get("opts").unwrap_or(&Value::Null), &home, &real),
        event: case.get("event").and_then(Value::as_str).unwrap_or("PreToolUse").to_string(),
        env: RequestEnv::from_pairs(env),
        home,
        real,
    }
}

/// The verdict as the corpus stores it, with the case's directories replaced by their placeholders.
pub fn verdict_json(v: &Option<Verdict>, l: &Laid) -> Value {
    let u = |s: &str| unsub(s, &l.home, &l.real);
    match v {
        None => json!({"v": "none"}),
        Some(Verdict::Allow) => json!({"v": "allow"}),
        Some(Verdict::Defer) => json!({"v": "defer"}),
        Some(Verdict::Block(m)) => json!({"v": "block", "text": u(m)}),
        Some(Verdict::Advisory(m)) => json!({"v": "advisory", "text": u(m)}),
        Some(Verdict::Exact(x)) => json!({"v": "exact", "code": x.code, "out": u(&x.out), "err": u(&x.err)}),
        Some(other) => json!({"v": format!("{other:?}")}),
    }
}

/// Every case's answer from the script, against its stored `expect`. Returns the number of cases and of each kind.
pub fn assert_script_matches(check: &str) -> BTreeMap<String, usize> {
    let mut kinds = BTreeMap::new();
    let cases = load(check);
    assert!(cases.len() >= 20, "{check}: a golden corpus of real size");
    for c in &cases {
        let l = lay(c);
        let got = run_forced(check, &l.payload, &l.opts, &l.event, &l.env).unwrap_or_else(|| panic!("{check}: no shipped script"));
        let got = verdict_json(&got, &l);
        assert_eq!(got, c["expect"], "{check}: script differs from the compiled port on case {}: {}", c["n"], c["payload"]);
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
        let l = lay(&c);
        let mut c = c;
        c["expect"] = verdict_json(&compiled(&l), &l);
        out.push_str(&serde_json::to_string(&c).unwrap());
        out.push('\n');
        crate::discard::harmless(std::fs::remove_dir_all(&l.home)); // keep: cleanup of a scratch directory
    }
    std::fs::write(dir().join(format!("{check}.jsonl")), out).unwrap();
}
