//! Parity of the four context-budget built-in checks against their Node hooks, run as real processes:
//! `limit-conserve-inject.js` (UserPromptSubmit), `auto-handover.js` (UserPromptSubmit), `auto-handover-pause-nag.js` (Stop),
//! `compact-advice-guard.js` (Stop).
//!
//! These hooks have no `evaluate()` entry point, so each scenario runs the hook as a child process (stdin payload, an isolated copy
//! of a fixture home, `ANTIHALL_TEST_ISOLATION=1`) and the engine as `ah-engine check <name>` on another copy of the same fixture.
//! The engine may either answer or defer (print `AHFALLBACK`). Compared, byte for byte:
//!   answered   exit code, stdout, stderr must equal Node's, AND the Node hook must have left the home tree exactly as the fixture
//!              had it (it wrote nothing), AND the engine must have left its copy untouched. A scenario Node answers with output or
//!              a state write must therefore be deferred: an answer there is a MISMATCH.
//!   deferred   reported as "needed" when Node printed something other than the empty context or wrote a file, else as "unneeded"
//!              (a missed offload, not a parity failure).
//! The corpus (`ctxbudget_corpus/ctxbudget.json`) is data: hand-written scenarios (settings and skip variants, malformed payloads and
//! state files, boundary numbers, unicode, huge input) and the seeded fuzz of the old generator, with times as tokens
//! (`{{NOW-60000}}`, `{{ISO+3600000}}`, `{"$now": 3600000}`) expanded once per run. The windows cut from a developer's real
//! transcripts the old runner could add are local data and not part of it.

use super::jsjson::{J, map_strings, parse};
use super::support::*;
use regex::Regex;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
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
    settings: Option<String>,
    skip: Option<String>,
    claude: Option<String>,
    files: Vec<(String, String)>,
    env: Env,
}

fn is_undef(j: &J) -> bool {
    matches!(j, J::Obj(o) if o.len() == 1 && o[0].0 == "$undef")
}

fn pre_expand(s: &str, now0: i64) -> String {
    if !s.contains("{{") {
        return s.to_string();
    }
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
                settings: text(field("settings").as_ref()),
                skip: text(field("skip").as_ref()),
                claude: field("claude").map(|v| resolve_now(v, now0).text()),
                files,
                env,
            }
        })
        .collect()
}

fn mk_home(dir: &Path, sc: &Sc) {
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
    std::fs::create_dir_all(dir.join("proj")).expect("proj dir");
}

/// path to the file's SHA-1 (directories: `D`)
fn snap(dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    fn walk(d: &Path, rel: &str, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        names.sort();
        for n in names {
            let f = d.join(&n);
            let r = if rel.is_empty() { n.clone() } else { format!("{rel}/{n}") };
            let Ok(md) = std::fs::symlink_metadata(&f) else { continue };
            if md.is_dir() {
                out.insert(format!("{r}/"), "D".into());
                walk(&f, &r, out);
            } else {
                out.insert(r, sha1_hex_bytes(&std::fs::read(&f).unwrap_or_default()));
            }
        }
    }
    walk(dir, "", &mut out);
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
        let _ = std::fs::create_dir_all(&dir);
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
    pool(&todo, 6, |sc, _| {
        let id = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let base = tmp.join(format!("s{id}"));
        let (hn, he, h0): (PathBuf, PathBuf, PathBuf) = (base.join("node"), base.join("eng"), base.join("ref"));
        for d in [&hn, &he, &h0] {
            mk_home(d, sc);
        }
        let reference = snap(&h0);
        let mk_env = |home: &Path| {
            let h = home.to_string_lossy().to_string();
            env_merge(&env_of(&[("PATH", &base_path), ("HOME", &h), ("USERPROFILE", &h), ("ANTIHALL_TEST_ISOLATION", "1")]), &sc.env)
        };
        let input = |home: &Path| sc.input.replace("$HOME", &home.to_string_lossy());
        let hook_file = HOOKS.iter().find(|(h, _)| *h == sc.hook).map(|(_, f)| *f).expect("a known hook");
        let mut nd = node(&strs(&[&hooks_dir.join(hook_file).to_string_lossy()]), input(&hn).as_bytes(), &mk_env(&hn), "/tmp");
        if mutate.is_some() {
            nd.out.push_str("~mutant");
        }
        let en = run(ENGINE, &strs(&["check", &sc.hook]), input(&he).as_bytes(), &mk_env(&he), "/tmp");
        let node_wrote = diff(&reference, &snap(&hn));
        let eng_wrote = diff(&reference, &snap(&he));
        let quiet = if sc.hook == "limit-conserve-inject" || sc.hook == "auto-handover" { nd.out == EMPTY || nd.out.is_empty() } else { nd.out.is_empty() };
        let node_silent = quiet && nd.code_is(0) && node_wrote.is_empty() && nd.err.is_empty();
        let deferred = en.out.trim() == "AHFALLBACK";
        let mut all = stats.lock().unwrap_or_else(|e| e.into_inner());
        let st = all.entry(sc.hook.clone()).or_default();
        st.n += 1;
        if deferred {
            if node_silent {
                st.unneeded += 1;
                let g = sc.id.split('/').nth(1).unwrap_or("").split('-').next().unwrap_or("").to_string();
                *st.groups.entry(g).or_insert(0) += 1;
            } else {
                st.needed += 1;
            }
            if !eng_wrote.is_empty() {
                st.mismatch += 1;
                mism.lock().unwrap_or_else(|e| e.into_inner()).push(format!("{}: engine wrote while deferring: {eng_wrote:?}", sc.id));
            }
            return;
        }
        let same_out = en.code == nd.code && en.out == nd.out && en.err == nd.err;
        if same_out && node_wrote.is_empty() && eng_wrote.is_empty() {
            st.same += 1;
            return;
        }
        st.mismatch += 1;
        mism.lock().unwrap_or_else(|e| e.into_inner()).push(format!(
            "{}: node=({}, {:?}, {:?}) eng=({}, {:?}, {:?}) nodeWrote={node_wrote:?} engWrote={eng_wrote:?} input={:?}",
            sc.id,
            nd.code,
            clip(&nd.out, 200),
            clip(&nd.err, 200),
            en.code,
            clip(&en.out, 200),
            clip(&en.err, 200),
            clip(&sc.input, 300)
        ));
    });
    let stats = stats.into_inner().unwrap_or_else(|e| e.into_inner());
    let mism = mism.into_inner().unwrap_or_else(|e| e.into_inner());
    let mut summary = String::new();
    for (h, s) in &stats {
        summary.push_str(&format!(
            "{h}: scenarios={} same={} deferred-needed={} deferred-unneeded={} MISMATCH={}\n",
            s.n, s.same, s.needed, s.unneeded, s.mismatch
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
        let _ = std::fs::write(Path::new(&dir).join("ctxbudget.summary.txt"), &summary);
    }
    assert!(stats.values().all(|s| s.mismatch == 0), "parity mismatches:\n{summary}");
    for (hook, _) in HOOKS {
        let n = stats.get(hook).map_or(0, |s| s.n);
        assert!(n >= 30, "{hook}: only {n} scenarios\n{summary}");
    }
}
