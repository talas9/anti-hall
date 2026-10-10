//! Lane L03 (v1.0, no Node): the operator verbs answer every case natively. For each case the engine used to leave to its Node
//! script (exit 75) this file either compares the engine with the Node script (same stdout, stderr, exit code and home tree on
//! scratch homes) or, where the native answer is an intended difference, pins the engine's answer and says why. New verbs
//! (`dispatch-report`, `finding-dedup`, `auto-handover-config`, `coordinator-work-baseline`, the `jev-setup` review verbs)
//! are compared with their Node scripts the same way. Nothing touches the real home.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use regex::Regex;
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

type R<T = ()> = Result<T, Box<dyn Error>>;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
static COUNTER: AtomicUsize = AtomicUsize::new(0);
static CASES: AtomicUsize = AtomicUsize::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> R<Scratch> {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ah-l03-parity-{}-{n}-{tag}", std::process::id()));
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        fs::create_dir_all(&dir)?;
        Ok(Scratch(dir.canonicalize()?))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.0) {
            eprintln!("could not remove {}: {e}", self.0.display());
        }
    }
}

fn plugin_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins").join("anti-hall").canonicalize().unwrap()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Out {
    stdout: String,
    stderr: String,
    code: i32,
}

fn run(mut cmd: Command, home: &Path, cwd: &Path, extra: &[(&str, &str)], stdin: &str) -> R<Out> {
    cmd.env_clear()
        .env("PATH", std::env::var("PATH")?)
        .env("HOME", home)
        .env("TMPDIR", home.join("tmp"))
        .env("CLAUDE_PLUGIN_ROOT", plugin_src())
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("AH_ENGINE_SHADOW_RATE_STATUSLINE", "0")
        .env("AH_ENGINE_SHADOW_RATE_SETTINGS", "0")
        .env("AH_ENGINE_SHADOW_RATE_DEFECT", "0")
        .env("AH_ENGINE_SHADOW_RATE_PHASE", "0")
        .env("AH_ENGINE_SHADOW_RATE_INSTALL", "0")
        .env("AH_ENGINE_SHADOW_RATE_UNINSTALL", "0")
        // the Node installer writes the Node-only command; the engine's installer writes the launcher form unless told otherwise
        .env("ANTIHALL_STATUSLINE_NODE_ONLY", "1")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn()?;
    let mut pipe = child.stdin.take().ok_or("no stdin pipe")?;
    let input = stdin.as_bytes().to_vec();
    let writer = std::thread::spawn(move || pipe.write_all(&input));
    let out = child.wait_with_output()?;
    match writer.join().map_err(|_| "stdin writer panicked")? {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => {}
        Err(e) => return Err(e.into()),
    }
    Ok(Out {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code().unwrap_or(-1),
    })
}

fn mask(s: &str, homes: &[&Path]) -> String {
    let mut s = s.to_string();
    for h in homes {
        s = s.replace(&h.to_string_lossy().into_owned(), "HOME");
    }
    for (re, with) in [
        (r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", "TS"),
        (r"corrupt-\d+", "corrupt-N"),
        (r#""ts":\d+"#, r#""ts":N"#),
        (r#""started":\d+"#, r#""started":N"#),
        (r"[\u{25d0}\u{25d3}\u{25d1}\u{25d2}]", "S"),
        (r"\.\d+\.[0-9a-f]{8}\.tmp", ".tmp"),
        // the activity sweep moves every 400 ms: the lit cell is a clock value
        ("\u{1b}\\[36m\u{2588}\u{1b}\\[0m", "\u{1b}[2m\u{2500}\u{1b}[0m"),
    ] {
        s = Regex::new(re).unwrap().replace_all(&s, with).into_owned();
    }
    s
}

fn snapshot(root: &Path) -> R<BTreeMap<String, String>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> R {
        for e in fs::read_dir(dir)? {
            let p = e?.path();
            let rel = p.strip_prefix(root)?.to_string_lossy().into_owned();
            if rel.starts_with(".anti-hall/ah-engine") || rel.ends_with(".lock") || rel == "tmp" {
                continue;
            }
            let meta = fs::symlink_metadata(&p)?;
            let mode = meta.permissions().mode() & 0o777;
            if meta.is_dir() {
                out.insert(format!("{rel}/"), format!("{mode:o}"));
                walk(root, &p, out)?;
            } else {
                out.insert(mask(&rel, &[]), format!("{mode:o}\n{}", mask(&String::from_utf8_lossy(&fs::read(&p)?), &[root])));
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out)?;
    if !out.keys().any(|k| k.starts_with(".anti-hall/") && k != ".anti-hall/") {
        out.remove(".anti-hall/");
    }
    Ok(out)
}

fn copy_dir(from: &Path, to: &Path) -> R {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let t = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &t)?;
        } else {
            fs::copy(e.path(), t)?;
        }
    }
    Ok(())
}

fn write(root: &Path, rel: &str, content: &str) -> R {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().ok_or("no parent")?)?;
    fs::write(p, content)?;
    Ok(())
}

/// Assert two texts are equal, showing the first difference with its surroundings instead of both whole texts.
fn assert_text(name: &str, what: &str, node: &str, engine: &str) {
    if node == engine {
        return;
    }
    let at = node.chars().zip(engine.chars()).position(|(a, b)| a != b).unwrap_or_else(|| node.chars().count().min(engine.chars().count()));
    let around = |s: &str| s.chars().skip(at.saturating_sub(40)).take(120).collect::<String>();
    panic!("{name}: {what} differs at char {at}\n  node:   {:?}\n  engine: {:?}", around(node), around(engine));
}

/// One scenario: run `script_rel` (Node) and `verb` (engine) on copies of `seed`, compare everything.
struct Same<'a> {
    script: &'a str,
    verb: &'a str,
    seed: Option<&'a Path>,
    cwd: Option<&'a Path>,
    env: &'a [(&'a str, &'a str)],
    stdin: &'a str,
}

fn same(c: &Same, args: &[&str]) -> R<Out> {
    let name = format!("{} {}", c.verb, args.join(" ").chars().take(80).collect::<String>());
    let (nh, eh) = (Scratch::new("n")?, Scratch::new("e")?);
    for h in [nh.path(), eh.path()] {
        fs::create_dir_all(h.join("tmp"))?;
        if let Some(s) = c.seed {
            copy_dir(s, h)?;
        }
    }
    let wd = Scratch::new("cwd")?;
    let cwd = c.cwd.unwrap_or_else(|| wd.path());
    let mut n = Command::new("node");
    n.arg(plugin_src().join(c.script)).args(args);
    let mut e = Command::new(BIN);
    e.arg(c.verb).args(args);
    let homes = [nh.path(), eh.path()];
    let no = run(n, nh.path(), cwd, c.env, c.stdin)?;
    let eo = run(e, eh.path(), cwd, c.env, c.stdin)?;
    let m = |o: &Out, h: &Path| Out { stdout: mask(&o.stdout, &[h]), stderr: mask(&o.stderr, &[h]), code: o.code };
    let (nm, em) = (m(&no, homes[0]), m(&eo, homes[1]));
    assert_text(&name, "stdout", &nm.stdout, &em.stdout);
    assert_text(&name, "stderr", &nm.stderr, &em.stderr);
    assert_eq!(nm.code, em.code, "{name}: exit code");
    let (nt, et) = (snapshot(nh.path())?, snapshot(eh.path())?);
    assert_eq!(nt, et, "{name}: home tree");
    CASES.fetch_add(1, Ordering::SeqCst);
    Ok(eo)
}

fn git(dir: &Path, args: &[&str]) -> R {
    let o = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_SYSTEM", "/dev/null").output()?;
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    Ok(())
}

fn repo(dir: &Path) -> R {
    fs::create_dir_all(dir)?;
    git(dir, &["init", "-q", "."])?;
    git(dir, &["config", "user.email", "a@b.c"])?;
    git(dir, &["config", "user.name", "tester"])?;
    Ok(())
}

/// Run one side alone (the engine's `verb`, or Node's `script` when `verb` is `None`) in a fresh copy of `seed`; returns the
/// output and the scratch home (kept alive by the caller for inspection).
fn one(script: &str, verb: Option<&str>, seed: Option<&Path>, cwd: Option<&Path>, env: &[(&str, &str)], args: &[&str]) -> R<(Out, Scratch)> {
    let h = Scratch::new("one")?;
    fs::create_dir_all(h.path().join("tmp"))?;
    if let Some(s) = seed {
        copy_dir(s, h.path())?;
    }
    let wd = Scratch::new("cwd")?;
    let cwd = cwd.unwrap_or_else(|| wd.path());
    let mut c = match verb {
        Some(v) => {
            let mut c = Command::new(BIN);
            c.arg(v);
            c
        }
        None => {
            let mut c = Command::new("node");
            c.arg(plugin_src().join(script));
            c
        }
    };
    c.args(args);
    let o = run(c, h.path(), cwd, env, "")?;
    assert_ne!(o.code, 75, "{script} {args:?}: deferred to Node instead of answering");
    Ok((o, h))
}

fn defect_files(home: &Path, sub: &str) -> R<Vec<String>> {
    let mut out = Vec::new();
    for e in fs::read_dir(home.join(".anti-hall/defects").join(sub))? {
        let p = e?.path();
        if p.extension().is_some_and(|x| x == "jsonl") {
            out.push(fs::read_to_string(p)?);
        }
    }
    Ok(out)
}

// ---- defect ---------------------------------------------------------------------------------------------------------------

const DEFECT: &str = "scripts/defect.js";

#[test]
fn defect_cuts_inside_a_surrogate_pair_with_a_replacement_character() -> R {
    // an identity of 63 letters and an emoji: the 64-unit cap falls between the emoji's two halves
    let proj = format!("{}\u{1F600}tail", "a".repeat(63));
    let args = ["report", "--class", "doc", "--sev", "p1", "--sym", "emoji cut", "--proj", proj.as_str(), "--json"];
    let (e, eh) = one(DEFECT, Some("defect"), None, None, &[], &args)?;
    let (n, _nh) = one(DEFECT, None, None, None, &[], &args)?;
    assert_eq!((e.code, e.stdout.as_str()), (n.code, n.stdout.as_str()), "the outcome line is Node's");
    let rec = defect_files(eh.path(), "")?.join("");
    let row: serde_json::Value = serde_json::from_str(rec.lines().next().unwrap())?;
    let p = row["proj"].as_str().unwrap();
    // Node keeps the lone high half (stored as a \ud83d escape); the engine stores U+FFFD, the same one code unit
    assert_eq!(p, format!("{}\u{FFFD}", "a".repeat(63)));
    assert_eq!(p.encode_utf16().count(), 64);
    Ok(())
}

/// History records with the given components, one fix each, all counted alike so the name order decides.
fn component_store(names: &[&str]) -> R<Scratch> {
    let s = Scratch::new("store")?;
    for (i, c) in names.iter().enumerate() {
        for k in 0..2 {
            let sha = format!("{i:02}{k}{}", "a".repeat(37));
            let line = serde_json::json!({"t":"backfill","at":format!("2026-0{}-1{k}T00:00:00+00:00", i % 9 + 1),"source":"backfill","status":"fixed",
                "fixCommit":sha,"subject":format!("fix: thing {i} {k}"),"component":c,"cause":"logic","fixedIn":"0.1.0"});
            write(s.path(), &format!(".anti-hall/defects/history/{}.jsonl", &sha[..12]), &(line.to_string() + "\n"))?;
        }
    }
    Ok(s)
}

#[test]
fn defect_sorts_names_of_any_script_like_node() -> R {
    // Latin before Greek before Cyrillic before Han: ICU's root order and the code point order agree here
    let store = component_store(&["hooks/日本", "hooks/жук", "hooks/βeta", "hooks/alpha", "hooks/Zed"])?;
    let c = Same { script: DEFECT, verb: "defect", seed: Some(store.path()), cwd: None, env: &[], stdin: "" };
    for a in [&["recurring"][..], &["recurring", "--json"][..], &["similar", "thing"][..], &["similar", "thing", "--json"][..]] {
        let o = same(&c, a)?;
        assert_ne!(o.code, 75);
    }
    Ok(())
}

#[test]
fn defect_sorts_accented_names_in_a_fixed_order_instead_of_deferring() -> R {
    // ICU sorts "ünicode" beside "u"; the engine's fixed order puts it after every ASCII letter (documented difference)
    let store = component_store(&["hooks/ünicode", "hooks/zeta", "hooks/abc"])?;
    let (o, _h) = one(DEFECT, Some("defect"), Some(store.path()), None, &[], &["recurring", "--json"])?;
    assert_eq!(o.code, 0, "{o:?}");
    let v: serde_json::Value = serde_json::from_str(&o.stdout)?;
    let names: Vec<&str> = v["byComponent"].as_array().unwrap().iter().map(|r| r["component"].as_str().unwrap()).collect();
    assert_eq!(names, ["hooks/abc", "hooks/zeta", "hooks/ünicode"], "{v}");
    Ok(())
}

#[test]
fn defect_since_in_local_time_matches_node_and_an_unreadable_one_is_refused() -> R {
    let store = component_store(&["hooks/a", "hooks/b"])?;
    for tz in ["UTC", "Asia/Dubai", "America/New_York"] {
        let c = Same { script: DEFECT, verb: "defect", seed: Some(store.path()), cwd: None, env: &[("TZ", tz)], stdin: "" };
        for since in ["2026-02-10T12:00", "2026-02-10T12:00:30", "Mar 1, 2026", "2026-02-10", "v0.1.0", "nonsense"] {
            same(&c, &["recurring", "--json", "--since", since])?;
        }
    }
    let (o, _h) = one(DEFECT, Some("defect"), Some(store.path()), None, &[], &["recurring", "--since", "02/10/2026"])?;
    assert_eq!(o.code, 1);
    assert!(o.stderr.contains("--since \"02/10/2026\" is not a date this tool reads"), "{o:?}");
    assert!(o.stdout.is_empty());
    Ok(())
}

#[test]
fn defect_archive_keeps_entries_it_cannot_date_or_move() -> R {
    let seed = Scratch::new("seed")?;
    let rep = |sym: &str, at: &str| {
        serde_json::json!({"t":"report","at":at,"class":"doc","sev":"p2","sym":sym,"proj":"pa","v":"0.1.0"}).to_string()
    };
    let rule = |at: &str| serde_json::json!({"t":"rule","at":at,"status":"fixed","fixedIn":"0.1.1"}).to_string();
    write(seed.path(), ".anti-hall/defects/aaaaaaaaaaa1.jsonl", &format!("{}\n{}\n", rep("odd date", "2020-01-01T00:00:00.000Z"), rule("01/02/2020")))?;
    write(seed.path(), ".anti-hall/defects/aaaaaaaaaaa2.jsonl", &format!("{}\n{}\n", rep("old", "2020-01-01T00:00:00.000Z"), rule("2020-01-02T00:00:00.000Z")))?;
    let (o, h) = one(DEFECT, Some("defect"), Some(seed.path()), None, &[], &["archive", "--json"])?;
    assert_eq!(o.code, 0, "{o:?}");
    let rows: serde_json::Value = serde_json::from_str(&o.stdout)?;
    let by = |fp: &str| rows.as_array().unwrap().iter().find(|r| r["fp"] == fp).cloned().unwrap();
    assert_eq!(by("aaaaaaaaaaa1")["reason"], "unreadable date");
    assert_eq!(by("aaaaaaaaaaa1")["moved"], false);
    assert_eq!(by("aaaaaaaaaaa2")["moved"], true);
    assert!(h.path().join(".anti-hall/defects/aaaaaaaaaaa1.jsonl").exists(), "an undated entry stays in place");
    // a move that fails (the month bucket is a file): the entry stays and the reason says why; Node stops with a stack trace
    let blocked = Scratch::new("seed")?;
    copy_dir(seed.path(), blocked.path())?;
    let month = {
        let (o, _h) = one(DEFECT, Some("defect"), Some(seed.path()), None, &[], &["archive", "--json"])?;
        let v: serde_json::Value = serde_json::from_str(&o.stdout)?;
        let dest = v.as_array().unwrap().iter().find_map(|r| r["dest"].as_str().map(str::to_string)).unwrap();
        Path::new(&dest).parent().unwrap().file_name().unwrap().to_string_lossy().into_owned()
    };
    write(blocked.path(), &format!(".anti-hall/defects/archive/{month}"), "not a directory")?;
    let (o, h) = one(DEFECT, Some("defect"), Some(blocked.path()), None, &[], &["archive", "--json"])?;
    assert_eq!(o.code, 0, "{o:?}");
    let rows: serde_json::Value = serde_json::from_str(&o.stdout)?;
    let r2 = rows.as_array().unwrap().iter().find(|r| r["fp"] == "aaaaaaaaaaa2").unwrap();
    assert_eq!(r2["moved"], false);
    assert!(r2["reason"].as_str().unwrap().starts_with("move failed: "), "{r2}");
    assert!(h.path().join(".anti-hall/defects/aaaaaaaaaaa2.jsonl").exists());
    Ok(())
}

#[test]
fn defect_reads_a_hand_edited_record_with_non_text_fields() -> R {
    let store = component_store(&["hooks/a"])?;
    write(
        store.path(),
        ".anti-hall/defects/history/ffffffffffff.jsonl",
        &(serde_json::json!({"t":"backfill","at":1767225600000_i64,"source":"backfill","status":"fixed","fixCommit":"ffffffffffff",
            "subject":42,"component":"hooks/a","cause":"logic","fixedIn":"0.1.0","changelog":{"x":1}})
        .to_string()
            + "\n"),
    )?;
    for a in [&["recurring", "--json"][..], &["recurring"][..], &["similar", "42", "--json"][..]] {
        let (o, _h) = one(DEFECT, Some("defect"), Some(store.path()), None, &[], a)?;
        assert_eq!(o.code, 0, "{a:?}: {o:?}");
    }
    let (o, _h) = one(DEFECT, Some("defect"), Some(store.path()), None, &[], &["similar", "42", "--json"])?;
    assert!(o.stdout.contains("\"subject\":\"42\""), "a number reads as its text: {}", o.stdout);
    Ok(())
}

#[test]
fn defect_identity_in_a_repository_the_file_resolver_is_unsure_of_matches_node() -> R {
    // a `.git` file with a CRLF line end: the engine's file resolver is unsure of it and asks git
    let work = Scratch::new("crlf")?;
    let wt = work.path().join("proj");
    fs::create_dir_all(&wt)?;
    let real = work.path().join("real.git");
    let o = Command::new("git")
        .args(["init", "-q", "--separate-git-dir"])
        .arg(&real)
        .arg(&wt)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()?;
    assert!(o.status.success());
    fs::write(wt.join(".git"), format!("gitdir: {}\r\n", real.display()))?;
    let c = Same { script: DEFECT, verb: "defect", seed: None, cwd: Some(&wt), env: &[], stdin: "" };
    for a in [&["report", "--class", "doc", "--sev", "p1", "--sym", "crlf repo"][..], &["list", "--mine", "--json"][..]] {
        same(&c, a)?;
    }
    Ok(())
}
