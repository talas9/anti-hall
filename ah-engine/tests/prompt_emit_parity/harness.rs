//! Runs a scenario against the Node hook and the engine check (see `main.rs`).
use ah_engine::checks::guardkit::jsval::Js;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A file to write into the home before a step.
#[derive(Clone)]
pub struct W {
    pub rel: String,
    pub body: Vec<u8>,
    pub append: bool,
    /// Set the file's modification time this many seconds in the past.
    pub age_s: Option<u64>,
    /// Rewrite the file's current text instead of writing `body`.
    pub edit: Option<std::sync::Arc<dyn Fn(&str) -> String + Send + Sync>>,
}

pub fn w(rel: &str, body: impl AsRef<[u8]>) -> W {
    W { rel: rel.into(), body: body.as_ref().to_vec(), append: false, age_s: None, edit: None }
}

pub fn wa(rel: &str, body: impl AsRef<[u8]>) -> W {
    W { rel: rel.into(), body: body.as_ref().to_vec(), append: true, age_s: None, edit: None }
}

/// Rewrite a file's text with `f` (an absent file reads as empty).
pub fn ed(rel: &str, f: impl Fn(&str) -> String + Send + Sync + 'static) -> W {
    W { rel: rel.into(), body: Vec::new(), append: false, age_s: None, edit: Some(std::sync::Arc::new(f)) }
}

pub fn aged(mut x: W, secs: u64) -> W {
    x.age_s = Some(secs);
    x
}

/// What the Node hook produced for the previous step.
pub struct Prev {
    pub out: Vec<u8>,
    /// The newest `additionalContext` any earlier step emitted.
    pub last_ctx: Option<String>,
}

impl Prev {
    /// The `additionalContext` of the previous output, if it had one.
    pub fn context(&self) -> Option<String> {
        let v: Value = serde_json::from_slice(&self.out).ok()?;
        Some(v.get("hookSpecificOutput")?.get("additionalContext")?.as_str()?.to_string())
    }
}

type After = Box<dyn Fn(&Prev, f64) -> Vec<W> + Send + Sync>;

pub struct Step {
    /// The hook's stdin; `$HOME` stands for the home directory.
    pub raw: String,
    /// Files written before the step.
    pub pre: Vec<W>,
    /// Files derived from the previous step's Node output, written before the step.
    pub after: Option<After>,
}

pub fn step(raw: impl Into<String>) -> Step {
    Step { raw: raw.into(), pre: Vec::new(), after: None }
}

impl Step {
    pub fn pre(mut self, files: Vec<W>) -> Step {
        self.pre = files;
        self
    }

    pub fn after(mut self, f: impl Fn(&Prev, f64) -> Vec<W> + Send + Sync + 'static) -> Step {
        self.after = Some(Box::new(f));
        self
    }
}

pub struct Scn {
    pub name: String,
    /// The hook file stem and the check name (they are the same here).
    pub hook: &'static str,
    pub seed: Vec<W>,
    pub env: Vec<(String, String)>,
    pub steps: Vec<Step>,
    /// `Some(true)`: the engine must defer every step; `Some(false)`: it must handle every step; `None`: either.
    pub expect_defer: Option<bool>,
    /// The last step must be a deferral (the earlier ones may be either).
    pub last_defers: bool,
}

pub fn scn(name: impl Into<String>, hook: &'static str, steps: Vec<Step>) -> Scn {
    Scn { name: name.into(), hook, seed: Vec::new(), env: Vec::new(), steps, expect_defer: Some(false), last_defers: false }
}

impl Scn {
    pub fn seed(mut self, files: Vec<W>) -> Scn {
        self.seed = files;
        self
    }

    pub fn env(mut self, kv: &[(&str, &str)]) -> Scn {
        self.env = kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        self
    }

    pub fn defers(mut self) -> Scn {
        self.expect_defer = Some(true);
        self
    }

    /// Only the last step must defer.
    pub fn defers_second_step(mut self) -> Scn {
        self.expect_defer = None;
        self.last_defers = true;
        self
    }

}

#[derive(Default)]
pub struct Report {
    pub scenarios: usize,
    pub steps: usize,
    pub handled: usize,
    pub deferred: usize,
    pub divergences: Vec<String>,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as f64
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for a millisecond timestamp.
pub fn iso(ms: f64) -> String {
    let total = ms.floor() as i64;
    let (secs, milli) = (total.div_euclid(1000), total.rem_euclid(1000));
    let (days, sod) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // civil from days (Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

struct Out {
    code: i32,
    out: Vec<u8>,
    err: Vec<u8>,
}

fn run(mut cmd: Command, input: &[u8]) -> Out {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = so.read_to_end(&mut b);
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = se.read_to_end(&mut b);
        b
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "child exceeded 60 seconds: {cmd:?}");
        std::thread::sleep(Duration::from_millis(2));
    };
    let _ = writer.join();
    Out { code: status.code().unwrap_or(-1), out: ro.join().unwrap(), err: re.join().unwrap() }
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn base_env(c: &mut Command, home: &Path, scn: &Scn) {
    c.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1");
    for (k, v) in &scn.env {
        c.env(k, v.replace("$HOME", &home.to_string_lossy()));
    }
}

fn run_node(scn: &Scn, home: &Path, input: &[u8]) -> Out {
    let mut c = Command::new("node");
    c.arg(repo().join("plugins/anti-hall/hooks").join(format!("{}.js", scn.hook))).current_dir(home);
    base_env(&mut c, home, scn);
    run(c, input)
}

fn run_engine(scn: &Scn, home: &Path, scratch: &Path, input: &[u8]) -> Out {
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check").arg(scn.hook).current_dir(home);
    base_env(&mut c, home, scn);
    c.env("AH_ENGINE_DIR", scratch.join("engine"));
    run(c, input)
}

/// `$HOME` is the home directory; `$TP(<text>)` is the 16-character path hash the dedupe store keeps for `<text>`.
fn sub(s: &str, home: &Path) -> String {
    let s = s.replace("$HOME", &home.to_string_lossy());
    let mut out = String::new();
    let mut rest = s.as_str();
    while let Some(i) = rest.find("$TP(") {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 4..];
        let Some(j) = tail.find(')') else { break };
        out.push_str(&ah_engine::checks::emit_dedupe::sha1_hex(tail[..j].as_bytes())[..16]);
        rest = &tail[j + 1..];
    }
    out.push_str(rest);
    out
}

fn apply(files: &[W], home: &Path) {
    for f in files {
        let p = home.join(sub(&f.rel, home));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let body: Vec<u8> = String::from_utf8(f.body.clone()).map(|s| sub(&s, home).into_bytes()).unwrap_or_else(|_| f.body.clone());
        if let Some(edit) = &f.edit {
            let cur = std::fs::read_to_string(&p).unwrap_or_default();
            std::fs::write(&p, edit(&cur)).unwrap();
        } else if f.append {
            let mut fh = std::fs::OpenOptions::new().create(true).append(true).open(&p).unwrap();
            fh.write_all(&body).unwrap();
        } else {
            std::fs::write(&p, &body).unwrap();
        }
        if let Some(age) = f.age_s {
            let t = SystemTime::now() - Duration::from_secs(age);
            std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
        }
    }
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    let st = Command::new("cp").arg("-Rp").arg(format!("{}/.", from.display())).arg(to).status().unwrap();
    assert!(st.success());
}

fn reset_dir(dir: &Path, from: &Path, root: &Path) {
    assert!(dir.starts_with(root), "refusing to clear {} outside {}", dir.display(), root.display());
    let _ = std::fs::remove_dir_all(dir);
    copy_tree(from, dir);
}

/// `x.json.<pid>.<8 hex>.tmp` -> `x.json.<pid>.<rnd>.tmp`: the temporary names are random by design.
fn tmp_name(rel: &str) -> String {
    match rel.rfind(".json.") {
        Some(i) if rel.ends_with(".tmp") => format!("{}<tmp>", &rel[..i + 6]),
        _ => rel.to_string(),
    }
}

const TIME_KEYS: [&str; 5] = ["lastEmittedAt", "lastSeenAt", "resetAt", "lastSuppressedAt", "lastSweep"];

fn normalize_json(j: &mut Js, now: f64) {
    match j {
        Js::Obj(v) => {
            for (k, x) in v.iter_mut() {
                if TIME_KEYS.contains(&k.as_str())
                    && let Js::Num(n) = x
                    && (*n - now).abs() < 900_000.0
                {
                    *n = -1.0;
                } else {
                    normalize_json(x, now);
                }
            }
        }
        Js::Arr(a) => a.iter_mut().for_each(|x| normalize_json(x, now)),
        _ => {}
    }
}

/// Every file under `home` (relative path to normalized content). The `.anti-hall/emit-dedupe` JSON is compared parsed.
fn tree(snap: &Path, home: &Path, now: f64) -> BTreeMap<String, String> {
    fn walk(dir: &Path, root: &Path, home: &Path, now: f64, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, root, home, now, out);
                continue;
            }
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().to_string();
            let bytes = std::fs::read(&p).unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes).replace(&home.to_string_lossy().to_string(), "$HOME");
            let shown = if rel.contains(".anti-hall/emit-dedupe/") && (rel.ends_with(".json") || (rel.contains(".json.") && rel.ends_with(".tmp"))) {
                match Js::parse(&text) {
                    Some(mut j) => {
                        normalize_json(&mut j, now);
                        j.stringify()
                    }
                    None => format!("<unparsed> {text}"),
                }
            } else if rel.len() > 4096 || bytes.len() > 2_000_000 {
                format!("<{} bytes>", bytes.len())
            } else {
                text
            };
            let rel = tmp_name(&rel);
            out.insert(rel, shown);
        }
    }
    let mut out = BTreeMap::new();
    walk(snap, snap, home, now, &mut out);
    out
}

fn show(o: &Out) -> String {
    format!("code={} out={:?} err={:?}", o.code, String::from_utf8_lossy(&o.out), String::from_utf8_lossy(&o.err))
}

fn run_one(scn: &Scn, root: &Path, report: &Mutex<Report>) {
    let dir = root.join(format!("{}-{}", COUNTER.fetch_add(1, Ordering::Relaxed), scn.name.chars().filter(|c| c.is_ascii_alphanumeric()).take(40).collect::<String>()));
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    apply(&scn.seed, &home);
    let (mut handled, mut deferred, mut steps, mut bad) = (0, 0, 0, Vec::new());
    let mut prev = Prev { out: Vec::new(), last_ctx: None };
    let now0 = now_ms();
    for (i, st) in scn.steps.iter().enumerate() {
        steps += 1;
        apply(&st.pre, &home);
        if let Some(f) = &st.after {
            apply(&f(&prev, now_ms()), &home);
        }
        let input = sub(&st.raw, &home);
        let s0 = dir.join("s0");
        let sn = dir.join("sn");
        let _ = std::fs::remove_dir_all(&s0);
        let _ = std::fs::remove_dir_all(&sn);
        copy_tree(&home, &s0);
        let node = run_node(scn, &home, input.as_bytes());
        copy_tree(&home, &sn);
        reset_dir(&home, &s0, &dir);
        let mut eng = run_engine(scn, &home, &dir, input.as_bytes());
        let was_deferred = eng.code == 0 && String::from_utf8_lossy(&eng.out).trim() == "AHFALLBACK";
        if was_deferred {
            eng = run_node(scn, &home, input.as_bytes());
            deferred += 1;
        } else {
            handled += 1;
        }
        if std::env::var("PE_SHOW").is_ok_and(|n| scn.name.contains(&n)) {
            eprintln!("[{}] step {i}: node {} | engine deferred={was_deferred}\n  state: {:?}", scn.name, show(&node), tree(&sn, &home, now0));
        }
        if let Some(want) = scn.expect_defer
            && want != was_deferred
        {
            bad.push(format!("[{}] step {i}: expected {} but the engine {}", scn.name, if want { "a deferral" } else { "an answer" }, if was_deferred { "deferred" } else { "answered" }));
        }
        if scn.last_defers && i + 1 == scn.steps.len() && !was_deferred {
            bad.push(format!("[{}] step {i}: expected a deferral on the last step but the engine answered", scn.name));
        }
        if node.code != eng.code || node.out != eng.out || node.err != eng.err {
            bad.push(format!("[{}] step {i}: output differs\n  node  : {}\n  engine: {}", scn.name, show(&node), show(&eng)));
        }
        let (tn, te) = (tree(&sn, &home, now0), tree(&home, &home, now0));
        if tn != te {
            let keys: Vec<&String> = tn.keys().chain(te.keys()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
            for k in keys {
                if tn.get(k) != te.get(k) {
                    bad.push(format!("[{}] step {i}: file {k} differs\n  node  : {:?}\n  engine: {:?}", scn.name, tn.get(k), te.get(k)));
                }
            }
        }
        let mut next = Prev { out: node.out, last_ctx: prev.last_ctx.clone() };
        if let Some(c) = next.context() {
            next.last_ctx = Some(c);
        }
        prev = next;
        reset_dir(&home, &sn, &dir);
        if !bad.is_empty() {
            break;
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    let mut r = report.lock().unwrap();
    r.scenarios += 1;
    r.steps += steps;
    r.handled += handled;
    r.deferred += deferred;
    r.divergences.extend(bad);
}

pub fn run_all(name: &str, scenarios: Vec<Scn>) -> Report {
    let root = std::env::temp_dir().join(format!("ah-pe-{name}-{}-{}", std::process::id(), now_ms() as u64));
    std::fs::create_dir_all(&root).unwrap();
    let report = Mutex::new(Report::default());
    let queue = Mutex::new(scenarios.into_iter().collect::<std::collections::VecDeque<_>>());
    std::thread::scope(|s| {
        for _ in 0..4 {
            s.spawn(|| {
                loop {
                    let next = queue.lock().unwrap().pop_front();
                    let Some(sc) = next else { break };
                    run_one(&sc, &root, &report);
                }
            });
        }
    });
    let _ = std::fs::remove_dir_all(&root);
    report.into_inner().unwrap()
}

/// A JSON line of a transcript.
pub fn line(v: Value) -> String {
    format!("{v}\n")
}

/// A UserPromptSubmit `hook_additional_context` attachment line, delivered at `ts` with `content` elements.
pub fn ups_attachment(ts: f64, content: &[&str]) -> String {
    line(json!({"type":"attachment","timestamp":iso(ts),"attachment":{"type":"hook_additional_context","hookEvent":"UserPromptSubmit","content":content}}))
}

/// A plain transcript entry that carries a timestamp and nothing a hook reads.
pub fn filler(ts: f64) -> String {
    line(json!({"type":"assistant","timestamp":iso(ts),"message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}))
}

/// A hook payload as raw JSON text.
pub fn payload(fields: Value) -> String {
    fields.to_string()
}
