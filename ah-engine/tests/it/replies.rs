//! Shared machinery of the response-guard parity tests: two isolated homes (one for the Node hook, one for the engine),
//! the same payload sequence run against both, and a comparison of exit code, stdout, stderr and the state each left.
//!
//! A step either must be answered by the engine exactly as Node answers it (`Same`: same bytes, same state files), or
//! must be deferred to Node (`Defer`: the engine prints the deferral marker and changes nothing; the Node hook then runs
//! on the Node home and the engine home is brought level, as in production where Node's answer and state stand).
#![allow(dead_code)]
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static ID: AtomicUsize = AtomicUsize::new(0);

/// What the engine must do with a step.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Expect {
    /// Answer with exactly what Node answers and leave the same state.
    Same,
    /// Defer to Node, touching nothing.
    Defer,
    /// Defer to Node, touching nothing, and do not run Node at all (it would call a model).
    DeferNoNode,
}

/// One payload to run.
#[derive(Clone)]
pub struct Step {
    pub payload: Value,
    /// When set, the exact stdin text (key order and spelling kept), with `$T` and `$H` replaced; `payload` is ignored.
    pub raw: Option<String>,
    pub expect: Expect,
}

/// One scenario: files to seed, environment, the transcript, and the steps.
#[derive(Clone)]
pub struct Case {
    pub name: String,
    pub files: Vec<(String, String)>,
    /// Files seeded with a modification time 30 days in the past.
    pub aged: Vec<(String, String)>,
    pub env: Vec<(String, String)>,
    pub transcript: Option<String>,
    pub steps: Vec<Step>,
    /// State files Node writes and the engine deliberately does not (a documented, reasoned difference; the verdict, exit code and
    /// stdout still have to match exactly). Skipped in the state comparison ONLY while the engine has not written the file.
    pub engine_omits: Vec<String>,
}

impl Case {
    pub fn new(name: &str) -> Case {
        Case { name: name.into(), files: Vec::new(), aged: Vec::new(), env: Vec::new(), transcript: None, steps: Vec::new(), engine_omits: Vec::new() }
    }
    pub fn file(mut self, rel: &str, body: &str) -> Case {
        self.files.push((rel.into(), body.into()));
        self
    }
    /// The engine deliberately leaves `rel` unwritten where Node writes it (see [`Case::engine_omits`]).
    pub fn engine_omits(mut self, rel: &str) -> Case {
        self.engine_omits.push(rel.into());
        self
    }
    pub fn aged(mut self, rel: &str, body: &str) -> Case {
        self.aged.push((rel.into(), body.into()));
        self
    }
    pub fn env(mut self, k: &str, v: &str) -> Case {
        self.env.push((k.into(), v.into()));
        self
    }
    pub fn transcript(mut self, lines: &[String]) -> Case {
        self.transcript = Some(lines.join("\n") + "\n");
        self
    }
    pub fn transcript_raw(mut self, body: &str) -> Case {
        self.transcript = Some(body.into());
        self
    }
    pub fn step(mut self, payload: Value, expect: Expect) -> Case {
        self.steps.push(Step { payload, raw: None, expect });
        self
    }
    pub fn raw(mut self, raw: &str, expect: Expect) -> Case {
        self.steps.push(Step { payload: Value::Null, raw: Some(raw.into()), expect });
        self
    }
    pub fn same(self, payload: Value) -> Case {
        self.step(payload, Expect::Same)
    }
    pub fn defer(self, payload: Value) -> Case {
        self.step(payload, Expect::Defer)
    }
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn subst(v: &Value, t: &str, h: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace("$T", t).replace("$H", h)),
        Value::Array(a) => Value::Array(a.iter().map(|x| subst(x, t, h)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), subst(x, t, h))).collect()),
        other => other.clone(),
    }
}

fn run(mut cmd: Command, input: &str) -> (i32, String, String) {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.as_bytes().to_vec();
    let w = std::thread::spawn(move || {
        ah_engine::discard::harmless(stdin.write_all(&input));
    });
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        so.read_to_end(&mut b).unwrap();
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        se.read_to_end(&mut b).unwrap();
        b
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "child exceeded 60 seconds");
        std::thread::sleep(Duration::from_millis(3));
    };
    w.join().unwrap();
    (status.code().unwrap_or(-1), String::from_utf8_lossy(&ro.join().unwrap()).into_owned(), String::from_utf8_lossy(&re.join().unwrap()).into_owned())
}

fn base_env(c: &mut Command, home: &Path) {
    c.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1");
    // the script limits the suite itself runs under (CI sets a larger CPU limit for a loaded shared runner)
    for k in ["AH_ENGINE_SCRIPT_TIME_MS", "AH_ENGINE_SCRIPT_EXEC_SCALE"] {
        if let Some(v) = std::env::var_os(k) {
            c.env(k, v);
        }
    }
}

fn run_engine(check: &str, home: &Path, case: &Case, input: &str) -> (i32, String, String) {
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check").arg(check);
    base_env(&mut c, home);
    c.env("AH_ENGINE_DIR", home.join("engine-state"));
    for (k, v) in &case.env {
        c.env(k, v);
    }
    run(c, input)
}

/// Every file under `home` (relative path to normalised text); the engine's own state directory and the Jev decision log
/// are not part of what is compared.
pub fn tree(home: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                if rel.starts_with("engine-state") {
                    continue;
                }
                let body = String::from_utf8_lossy(&std::fs::read(&p).unwrap_or_default()).into_owned();
                out.insert(rel, normalise(&body));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(home, home, &mut out);
    out
}

fn normalise(s: &str) -> String {
    let ts = regex::Regex::new(r#""ts":"[^"]*""#).unwrap();
    let sweep = regex::Regex::new(r#""lastSweep":\d+"#).unwrap();
    sweep.replace_all(&ts.replace_all(s, "\"ts\":\"TS\""), "\"lastSweep\":0").into_owned()
}

fn copy_tree(from: &Path, to: &Path) {
    ah_engine::discard::harmless(std::fs::remove_dir_all(to));
    fn cp(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap().flatten() {
            let p = e.path();
            let t = to.join(e.file_name());
            if p.is_dir() {
                cp(&p, &t);
            } else {
                std::fs::copy(&p, &t).unwrap();
            }
        }
    }
    cp(from, to);
}

/// What one hook's run produced.
#[derive(Default, Debug)]
pub struct Tally {
    pub steps: usize,
    pub same: usize,
    pub deferred: usize,
    /// Same-steps after which the hook had left some state file besides the seeded ones.
    pub wrote: usize,
    pub failures: Vec<String>,
}

fn mkhome(tag: &str, case: &Case) -> PathBuf {
    let n = ID.fetch_add(1, Ordering::Relaxed);
    let d = std::env::temp_dir().join(format!("ah-reply-{tag}-{}-{n}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    for (rel, body) in &case.files {
        let f = d.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, body).unwrap();
    }
    for (rel, body) in &case.aged {
        let f = d.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(&f, body).unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(30 * 86_400);
        std::fs::OpenOptions::new().write(true).open(&f).unwrap().set_modified(old).unwrap();
    }
    d
}

// ---- transcript line builders -----------------------------------------------------------------------------

pub fn asst(text: &str) -> String {
    serde_json::json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":text}]}}).to_string()
}
pub fn asst_id(id: &str, text: &str) -> String {
    serde_json::json!({"type":"assistant","message":{"role":"assistant","id":id,"content":[{"type":"text","text":text}]}}).to_string()
}
pub fn asst_tool(input: Value) -> String {
    serde_json::json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":input}]}}).to_string()
}
pub fn user(text: &str) -> String {
    serde_json::json!({"type":"user","message":{"role":"user","content":text},"uuid":format!("u-{}", text.len())}).to_string()
}
pub fn user_uuid(uuid: &str, text: &str) -> String {
    serde_json::json!({"type":"user","message":{"role":"user","content":text},"uuid":uuid}).to_string()
}
pub fn tool_result(text: &str) -> String {
    serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":text}]},"toolUseResult":{"stdout":text}}).to_string()
}
