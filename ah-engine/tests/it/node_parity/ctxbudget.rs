//! Parity of the four context-budget built-in checks against their Node hooks, run as real processes:
//! `limit-conserve-inject.js` (UserPromptSubmit), `auto-handover.js` (UserPromptSubmit), `auto-handover-pause-nag.js` (Stop),
//! `compact-advice-guard.js` (Stop).
//!
//! These hooks have no `evaluate()` entry point, so each scenario runs the hook as a child process (stdin payload, a fixture home,
//! `ANTIHALL_TEST_ISOLATION=1`, `ANTIHALL_INGEST_DRY_RUN=1`) and then the engine as `ah-engine check <name>` on a fresh copy of
//! the same fixture at the very same path (state files hold hashes of paths, so the two homes must not differ in path). Fixture
//! files get one fixed modification time, so a state file that records a file's mtime records the same number on both sides. A
//! scenario is one input or a sequence (`steps`), run in order on the same home, so dedupe, nag steps, re-arms and latches carry
//! from one turn to the next. Where the engine defers (prints `AHFALLBACK`), it must have written nothing, and the Node hook then
//! runs on the engine's home, as the dispatcher does. After every step, compared byte for byte: exit code, stdout, stderr, and the
//! whole home tree (each file's content; a number in a JSON or NDJSON file, or an ISO instant anywhere, within ten minutes of now reads as `<NOW>`, since the two runs
//! happen moments apart).
//!   answered   counted as "same" when all of that equals Node's, else MISMATCH.
//!   deferred   counted as "needed" when Node printed something other than the empty context or wrote a file, else "unneeded"
//!              (a missed offload, not a parity failure).
//! The corpus (`ctxbudget_corpus/ctxbudget.json`) is data: hand-written scenarios (settings and skip variants, malformed payloads and
//! state files, boundary numbers, unicode, huge input, fire, nag, re-arm and dedupe sequences) and the seeded fuzz of the old
//! generator, with times as tokens (`{{NOW-60000}}`, `{{ISO+3600000}}`, `{{MTIME}}`, `{{TODAY}}`, `{"$now": 3600000}`) expanded once per run.

use super::jsjson::{J, map_strings, parse};
use super::support::*;
use regex::Regex;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

const CORPUS: &str = include_str!("ctxbudget_corpus/ctxbudget.json");

const HOOKS: [(&str, &str); 4] = [
    ("limit-conserve-inject", "limit-conserve-inject.js"),
    ("auto-handover", "auto-handover.js"),
    ("auto-handover-pause-nag", "auto-handover-pause-nag.js"),
    ("compact-advice-guard", "compact-advice-guard.js"),
];
const EMPTY: &str = "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"\"}}\n";

struct Sc {
    hook: String,
    id: String,
    input: String,
    steps: Vec<String>,
    settings: Option<String>,
    skip: Option<String>,
    claude: Option<String>,
    files: Vec<(String, String)>,
    env: Env,
}

fn is_undef(j: &J) -> bool {
    matches!(j, J::Obj(o) if o.len() == 1 && o[0].0 == "$undef")
}

/// The nanoseconds part of the fixed modification time every fixture file gets (a fraction of a millisecond, so a state file
/// that records `mtimeMs` records a number with decimals).
const MTIME_NS: u32 = 123_456_789;

/// The whole seconds of the fixed modification time: two hours before the run.
fn mtime_secs(now0: i64) -> u64 {
    (now0 / 1000 - 7200) as u64
}

/// `fs.statSync(f).mtimeMs` of a fixture file, as Node computes it (seconds * 1000 + nanoseconds / 1e6).
fn mtime_ms(now0: i64) -> f64 {
    mtime_secs(now0) as f64 * 1000.0 + f64::from(MTIME_NS) / 1e6
}

fn set_mtime_ns(path: &Path, secs: u64) {
    let t = std::time::UNIX_EPOCH + std::time::Duration::new(secs, MTIME_NS);
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
        f.set_times(std::fs::FileTimes::new().set_accessed(t).set_modified(t)).ok();
    }
}

fn pre_expand(s: &str, now0: i64) -> String {
    if !s.contains("{{") {
        return s.to_string();
    }
    let today = s.contains("{{TODAY}}").then(|| local_day(0.0));
    let s = &today.map_or_else(|| s.to_string(), |d| s.replace("{{TODAY}}", &d));
    let s = &Regex::new(r"\{\{MTIME([-+]\d+)?\}\}")
        .unwrap()
        .replace_all(s, |c: &regex::Captures| format!("{}", mtime_ms(now0) + c.get(1).map_or(0.0, |m| m.as_str().parse::<f64>().unwrap_or(0.0))));
    let a = Regex::new(r"\{\{NOW([-+]\d+)?\}\}")
        .unwrap()
        .replace_all(s, |c: &regex::Captures| (now0 + c.get(1).map_or(0, |m| m.as_str().parse::<i64>().unwrap_or(0))).to_string());
    let b = Regex::new(r"\{\{ISO([-+]\d+)?\}\}")
        .unwrap()
        .replace_all(&a, |c: &regex::Captures| iso_from_ms(now0 + c.get(1).map_or(0, |m| m.as_str().parse::<i64>().unwrap_or(0))));
    let c = Regex::new(r"\{\{REP:([0-9a-f]+):(\d+)\}\}").unwrap().replace_all(&b, |c: &regex::Captures| {
        char::from_u32(u32::from_str_radix(&c[1], 16).unwrap_or(0x78)).unwrap_or('x').to_string().repeat(c[2].parse().unwrap_or(0))
    });
    let d = Regex::new(r"\{\{REPS:([^:}]*):(\d+)\}\}").unwrap().replace_all(&c, |c: &regex::Captures| {
        let b = c[1].as_bytes();
        let mut unit = Vec::new();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 2 < b.len() {
                unit.push(u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("00"), 16).unwrap_or(0));
                i += 3;
            } else {
                unit.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8_lossy(&unit).repeat(c[2].parse().unwrap_or(0))
    });
    Regex::new(r"\{\{FILLERS:(\d+):(\d+)\}\}")
        .unwrap()
        .replace_all(&d, |c: &regex::Captures| {
            let (n, y): (usize, usize) = (c[1].parse().unwrap_or(0), c[2].parse().unwrap_or(0));
            (0..n)
                .map(|k| {
                    format!(
                        "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"filler {k} {}\"}}]}}}}",
                        "y".repeat(y)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .to_string()
}

/// A number the corpus wrote as `{"$now": k}` is now + k; other numbers are as written.
fn resolve_now(j: J, now0: i64) -> J {
    match j {
        J::Obj(o) if o.len() == 1 && o[0].0 == "$now" => match &o[0].1 {
            J::Num(k) => J::Num(now0 as f64 + k),
            _ => J::Null,
        },
        J::Obj(o) => J::Obj(o.into_iter().filter(|(_, v)| !is_undef(v)).map(|(k, v)| (k, resolve_now(v, now0))).collect()),
        J::Arr(a) => J::Arr(a.into_iter().map(|v| if is_undef(&v) { J::Null } else { resolve_now(v, now0) }).collect()),
        other => other,
    }
}

fn load(now0: i64) -> Vec<Sc> {
    let j = parse(CORPUS).expect("the corpus is valid JSON");
    let J::Arr(list) = map_strings(j, &|s| pre_expand(s, now0)) else { panic!("a corpus is an array") };
    let text = |j: Option<&J>| -> Option<String> {
        match j {
            Some(J::Str(s)) => Some(s.clone()),
            Some(v) if !is_undef(v) && !matches!(v, J::Null) => Some(resolve_now(v.clone(), now0).text()),
            _ => None,
        }
    };
    list.into_iter()
        .map(|sc| {
            let get = |k: &str| sc.get(k).filter(|v| !is_undef(v)).cloned();
            let ctx = get("ctx").unwrap_or_else(|| J::Obj(Vec::new()));
            let field = |k: &str| ctx.get(k).filter(|v| !is_undef(v)).cloned();
            let files = match field("files") {
                Some(J::Obj(o)) => o
                    .into_iter()
                    .map(|(k, v)| {
                        (
                            k,
                            match v {
                                J::Str(s) => s,
                                other => other.text(),
                            },
                        )
                    })
                    .collect(),
                _ => Vec::new(),
            };
            let env = match field("env") {
                Some(J::Obj(o)) => o
                    .into_iter()
                    .map(|(k, v)| {
                        (
                            k,
                            Some(match v {
                                J::Str(s) => s,
                                other => other.text(),
                            }),
                        )
                    })
                    .collect(),
                _ => Vec::new(),
            };
            Sc {
                hook: match get("hook") {
                    Some(J::Str(s)) => s,
                    _ => String::new(),
                },
                id: match get("id") {
                    Some(J::Str(s)) => s,
                    _ => String::new(),
                },
                input: match get("input") {
                    Some(J::Str(s)) => s,
                    _ => String::new(),
                },
                steps: match get("steps") {
                    Some(J::Arr(a)) => a.into_iter().filter_map(|v| if let J::Str(s) = v { Some(s) } else { None }).collect(),
                    _ => Vec::new(),
                },
                settings: text(field("settings").as_ref()),
                skip: text(field("skip").as_ref()),
                claude: field("claude").map(|v| resolve_now(v, now0).text()),
                files,
                env,
            }
        })
        .collect()
}

fn mk_home(dir: &Path, sc: &Sc, mtime: u64) {
    std::fs::create_dir_all(dir.join(".anti-hall")).expect("state dir");
    if let Some(s) = &sc.settings {
        write_file(&dir.join(".anti-hall/settings.json"), s.as_bytes());
    }
    if let Some(s) = &sc.skip {
        write_file(&dir.join(".anti-hall/skip.json"), s.as_bytes());
    }
    if let Some(s) = &sc.claude {
        write_file(&dir.join(".claude/settings.json"), s.as_bytes());
    }
    for (rel, body) in &sc.files {
        write_file(&dir.join(rel), body.as_bytes());
    }
    for rel in [".anti-hall/settings.json", ".anti-hall/skip.json", ".claude/settings.json"].into_iter().chain(sc.files.iter().map(|f| f.0.as_str())) {
        set_mtime_ns(&dir.join(rel), mtime);
    }
    std::fs::create_dir_all(dir.join("proj")).expect("proj dir");
}

/// path to the file's content (directories: `D`); in a JSON file every number within ten minutes of now reads as `<NOW>`.
fn snap(dir: &Path) -> BTreeMap<String, String> {
    let now = now_ms() as f64;
    fn norm(j: J, now: f64) -> J {
        match j {
            J::Num(n) if (n - now).abs() < 600_000.0 => J::Str("<NOW>".into()),
            J::Obj(o) => J::Obj(o.into_iter().map(|(k, v)| (k, norm(v, now))).collect()),
            J::Arr(a) => J::Arr(a.into_iter().map(|v| norm(v, now)).collect()),
            other => other,
        }
    }
    let mut out = BTreeMap::new();
    fn walk(d: &Path, rel: &str, now: f64, out: &mut BTreeMap<String, String>, norm: &dyn Fn(J, f64) -> J) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        names.sort();
        for n in names {
            let f = d.join(&n);
            let r = if rel.is_empty() { n.clone() } else { format!("{rel}/{n}") };
            if r.ends_with(".anti-hall/ah-engine") {
                continue; // the engine's own state dir (its telemetry): Node has nothing to compare it with
            }
            let Ok(md) = std::fs::symlink_metadata(&f) else { continue };
            if md.is_dir() {
                out.insert(format!("{r}/"), "D".into());
                walk(&f, &r, now, out, norm);
            } else {
                let text = String::from_utf8_lossy(&std::fs::read(&f).unwrap_or_default()).to_string();
                let v = match parse(&text) {
                    Some(j) if n.ends_with(".json") => super::jsjson::stringify(&norm(j, now)),
                    _ if n.ends_with(".ndjson") => {
                        text.lines().map(|l| parse(l).map_or_else(|| l.to_string(), |j| super::jsjson::stringify(&norm(j, now)))).collect::<Vec<_>>().join("\n")
                    }
                    _ => text,
                };
                // an ISO instant within ten minutes of now (a log row's time) reads as `<NOW>` too
                let v = super::lab::norm_text(&v, "\u{0}");
                out.insert(r, v);
            }
        }
    }
    walk(dir, "", now, &mut out, &norm);
    out
}

fn diff(a: &BTreeMap<String, String>, b: &BTreeMap<String, String>) -> Vec<String> {
    let mut d: Vec<String> = a.keys().chain(b.keys()).filter(|k| a.get(*k) != b.get(*k)).cloned().collect();
    d.sort();
    d.dedup();
    d
}

#[derive(Default, Debug)]
pub(crate) struct Stats {
    pub n: usize,
    pub same: usize,
    pub loud: usize,
    pub needed: usize,
    pub unneeded: usize,
    pub mismatch: usize,
    pub groups: BTreeMap<String, usize>,
}

pub(crate) fn run_lane(hooks_dir: &Path, mutate: Option<usize>) -> (BTreeMap<String, Stats>, String) {
    let now0 = now_ms() as i64;
    let mut scenarios = load(now0);
    if let Some(n) = mutate {
        scenarios.truncate(n);
    }
    if let Some(dir) = std::env::var_os("AH_PARITY_DUMP") {
        let ids: String = scenarios.iter().map(|s| format!("{}\n", s.id)).collect();
        std::fs::create_dir_all(&dir).ok();
        std::fs::write(Path::new(&dir).join("ctxbudget.ids"), ids).expect("dump");
        if std::env::var_os("AH_PARITY_DUMP_ONLY").is_some() {
            return (BTreeMap::new(), String::new());
        }
    }
    let scratch = Scratch::new("ctxbudget");
    let tmp = scratch.path().to_path_buf();
    let stats: Mutex<BTreeMap<String, Stats>> = Mutex::new(BTreeMap::new());
    let mism: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let counter = std::sync::atomic::AtomicUsize::new(0);
    let base_path = std::env::var("PATH").unwrap_or_default();
    let only = std::env::var("AH_PARITY_ONLY").ok();
    let todo: Vec<&Sc> = scenarios.iter().filter(|s| only.as_ref().is_none_or(|o| s.hook == *o)).collect();
    let mtime = mtime_secs(now0);
    pool(&todo, 6, |sc, _| {
        let id = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let base = tmp.join(format!("s{id}"));
        let home = base.join("h");
        let h = home.to_string_lossy().to_string();
        let env = env_merge(
            &env_of(&[("PATH", &base_path), ("HOME", &h), ("USERPROFILE", &h), ("ANTIHALL_TEST_ISOLATION", "1"), ("ANTIHALL_INGEST_DRY_RUN", "1")]),
            &sc.env,
        );
        let inputs: Vec<String> = std::iter::once(&sc.input).chain(&sc.steps).map(|i| i.replace("$HOME", &h)).collect();
        let hook_file = hooks_dir.join(HOOKS.iter().find(|(x, _)| *x == sc.hook).map(|(_, f)| *f).expect("a known hook")).to_string_lossy().to_string();
        let run_node = |input: &str| node(&strs(&[&hook_file]), input.as_bytes(), &env, "/tmp");
        // Node's pass: each step's answer and the home tree after it
        mk_home(&home, sc, mtime);
        let mut before = snap(&home);
        let mut node_steps = Vec::new();
        for input in &inputs {
            let mut nd = run_node(input);
            if mutate.is_some() {
                nd.out.push_str("~mutant");
            }
            let after = snap(&home);
            let quiet = if sc.hook == "limit-conserve-inject" || sc.hook == "auto-handover" { nd.out == EMPTY || nd.out.is_empty() } else { nd.out.is_empty() };
            let silent = quiet && nd.code_is(0) && nd.err.is_empty() && after == before;
            before = after.clone();
            node_steps.push((nd, after, silent));
        }
        wipe(&home);
        // the engine's pass on a fresh copy at the same path; a deferral runs the Node hook there, as the dispatcher does
        mk_home(&home, sc, mtime);
        let mut rows = Vec::new();
        for (k, input) in inputs.iter().enumerate() {
            let pre = snap(&home);
            let en = run(ENGINE, &strs(&["check", &sc.hook]), input.as_bytes(), &env, "/tmp");
            let deferred = en.out.trim() == "AHFALLBACK";
            let mut wrote_deferring = Vec::new();
            let got = if deferred {
                wrote_deferring = diff(&pre, &snap(&home));
                run_node(input)
            } else {
                en
            };
            let tree = snap(&home);
            let (nd, ntree, silent) = &node_steps[k];
            let same = got.code == nd.code && got.out == nd.out && got.err == nd.err && &tree == ntree;
            rows.push((k, deferred, *silent, same, wrote_deferring, got, diff(ntree, &tree)));
        }
        wipe(&base);
        let mut all = stats.lock().unwrap_or_else(|e| e.into_inner());
        let st = all.entry(sc.hook.clone()).or_default();
        for (k, deferred, silent, same, wrote, got, tdiff) in rows {
            st.n += 1;
            let nd = &node_steps[k].0;
            if deferred {
                if silent {
                    st.unneeded += 1;
                    let g = sc.id.split('/').nth(1).unwrap_or("").split('-').next().unwrap_or("").to_string();
                    *st.groups.entry(g).or_insert(0) += 1;
                } else {
                    st.needed += 1;
                }
            } else if same {
                st.same += 1;
                if !silent {
                    st.loud += 1;
                }
            }
            if deferred && !silent && std::env::var_os("AH_PARITY_VERBOSE").is_some() {
                eprintln!("deferred-needed {} step {k}", sc.id);
            }
            if !wrote.is_empty() || !same {
                st.mismatch += 1;
                mism.lock().unwrap_or_else(|e| e.into_inner()).push(format!(
                    "{} step {k}: deferred={deferred} wroteWhileDeferring={wrote:?} node=({}, {:?}, {:?}) got=({}, {:?}, {:?}) treeDiff={tdiff:?} input={:?}",
                    sc.id,
                    nd.code,
                    clip(&nd.out, 300),
                    clip(&nd.err, 300),
                    got.code,
                    clip(&got.out, 300),
                    clip(&got.err, 300),
                    clip(&inputs[k], 300)
                ));
            }
        }
    });
    let stats = stats.into_inner().unwrap_or_else(|e| e.into_inner());
    let mism = mism.into_inner().unwrap_or_else(|e| e.into_inner());
    let mut summary = String::new();
    for (h, s) in &stats {
        summary.push_str(&format!(
            "{h}: steps={} same={} (of them printing or writing: {}) deferred-needed={} deferred-unneeded={} MISMATCH={}\n",
            s.n, s.same, s.loud, s.needed, s.unneeded, s.mismatch
        ));
        if !s.groups.is_empty() {
            summary.push_str(&format!("  unneeded deferrals by group: {}\n", serde_json::to_string(&s.groups).unwrap_or_default()));
        }
    }
    for m in mism.iter().take(15) {
        summary.push_str(&format!("  MISMATCH {m}\n"));
    }
    drop(scratch);
    (stats, summary)
}

pub(crate) fn require(hooks_dir: &Path) {
    let (stats, summary) = run_lane(hooks_dir, None);
    if std::env::var_os("AH_PARITY_DUMP_ONLY").is_some() {
        return;
    }
    println!("{summary}");
    if let Some(dir) = std::env::var_os("AH_PARITY_DUMP") {
        std::fs::write(Path::new(&dir).join("ctxbudget.summary.txt"), &summary).ok();
    }
    assert!(stats.values().all(|s| s.mismatch == 0), "parity mismatches:\n{summary}");
    for (hook, _) in HOOKS.iter().filter(|(h, _)| std::env::var("AH_PARITY_ONLY").is_ok_and(|o| o == *h) || std::env::var_os("AH_PARITY_ONLY").is_none()) {
        let n = stats.get(*hook).map_or(0, |s| s.n);
        assert!(n >= 30, "{hook}: only {n} scenarios\n{summary}");
    }
}
