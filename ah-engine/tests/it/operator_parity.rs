//! Node-vs-engine parity of the operator command-line tools (L9a): `settings`, `defect` and `statusline`.
//!
//! The real Node script and the engine command run on identical seeded scratch homes and are compared on stdout, stderr, the
//! exit code and the home directory tree (every file's path, mode and masked content). Nothing touches the real home: each
//! side gets its own scratch home with `HOME` pointed at it, an otherwise empty environment and the Node shadow turned off.
//! Clock values (ISO timestamps, `"ts"`, the spinner frame, elapsed times) are masked, because the two runs cannot share a
//! clock; the status line is re-run up to three times when only the second changed.
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
        let dir = std::env::temp_dir().join(format!("ah-ops-parity-{}-{n}-{tag}", std::process::id()));
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

// ---- settings ---------------------------------------------------------------------------------------------------------

fn settings_seed(root: &Path) -> R {
    write(
        root,
        ".anti-hall/settings.json",
        r#"{"autoHandover":{"pct":70,"enabled":"off"},"jev":{"enabled":true,"semanticJudge":"yes","prices":{"m":{"inPerMTok":1,"outPerMTok":2}}},"jevIntegrations":{"triage":"shadow","modelRouting":"on"},"guards":{"stashGuard":true,"editGuardAllow":"docs/**,a.md"},"safety":{"gitGuard":false}}"#,
    )?;
    write(root, ".anti-hall/jev.json", r#"{"enabled":false,"triage":false,"integrations":{"speculation":"on"},"budget":{"usdPerDay":3}}"#)?;
    write(
        root,
        ".claude/settings.json",
        r#"{"pluginConfigs":{"anti-hall@anti-hall":{"options":{"auto_handover_pct":60,"guards_model_routing":"advisory"}}}}"#,
    )?;
    Ok(())
}

const SETTINGS_CASES: &[&str] = &[
    "show",
    "show --json",
    "show --section jev",
    "show --section jev --all --json",
    "show --section jevIntegrations",
    "show --section guards --all --json",
    "show --section nope",
    "show --section nope --json",
    "get guards.modelRouting",
    "get nope.x --json",
    "get",
    "get autoHandover.pct",
    "get jev.budget.usdPerDay --json",
    "get guards.modelRouting --json",
    "set autoHandover.pct 80",
    "set autoHandover.pct 80 --json",
    "set autoHandover.pct 200 --json",
    "set autoHandover.pct 200",
    "set autoHandover.pct abc",
    "set autoHandover.enabled off",
    "set autoHandover.enabled maybe",
    "set guards.modelRouting bogus",
    "set guards.modelRouting advisory --json",
    "set autoHandover.pct",
    "set jev.prices x",
    "set guards.stashGuard false",
    "set guards.stashGuard false --confirmed",
    "set guards.editGuardAllow docs/**,b.md",
    "set guards.editGuardAllow a.md",
    "set safety.gitGuard true",
    "set safety.gitGuard false --json",
    "set safety.gitGuard false --confirmed --json",
    "reset autoHandover.pct",
    "reset autoHandover.pct --json",
    "reset nope.x",
    "reset guards.stashGuard",
    "reset guards.stashGuard --confirmed --json",
    "judge status",
    "judge on",
    "judge off",
    "judge x",
    "bogus",
];

#[test]
fn settings_agree_with_node_on_a_seeded_home() -> R {
    let seed = Scratch::new("seed")?;
    settings_seed(seed.path())?;
    let c = Same { script: "scripts/settings.js", verb: "settings", seed: Some(seed.path()), cwd: None, env: &[], stdin: "" };
    for a in SETTINGS_CASES {
        same(&c, &a.split(' ').collect::<Vec<_>>())?;
    }
    // an empty home
    let c = Same { seed: None, ..c };
    for a in SETTINGS_CASES {
        same(&c, &a.split(' ').collect::<Vec<_>>())?;
    }
    Ok(())
}

#[test]
fn settings_agree_with_node_under_environment_overrides() -> R {
    let seed = Scratch::new("seed")?;
    settings_seed(seed.path())?;
    let envs: &[&[(&str, &str)]] = &[
        &[("ANTIHALL_AUTO_HANDOVER_PCT", "50"), ("ANTIHALL_JEV", "1"), ("ANTIHALL_JEV_TRIAGE", "0")],
        &[("CLAUDE_PLUGIN_OPTION_AUTO_HANDOVER_PCT", "77"), ("CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY", "sk"), ("ANTIHALL_JEV_SPECULATION", "0")],
        &[("ANTIHALL_JEV", "0"), ("ANTHROPIC_API_KEY", "x")],
    ];
    for env in envs {
        let c = Same { script: "scripts/settings.js", verb: "settings", seed: Some(seed.path()), cwd: None, env, stdin: "" };
        for a in [
            "show --json",
            "show --section jev",
            "show --section jevIntegrations --json",
            "get autoHandover.pct --json",
            "reset autoHandover.pct --json",
            "judge status",
            "set autoHandover.pct 55 --json",
        ] {
            same(&c, &a.split(' ').collect::<Vec<_>>())?;
        }
    }
    Ok(())
}

#[test]
fn settings_agree_with_node_on_a_corrupt_store() -> R {
    let seed = Scratch::new("seed")?;
    write(seed.path(), ".anti-hall/settings.json", "{not json")?;
    write(seed.path(), ".anti-hall/jev.json", r#"{"enabled":true,"budget":{"usdPerDay":9}}"#)?;
    let c = Same { script: "scripts/settings.js", verb: "settings", seed: Some(seed.path()), cwd: None, env: &[], stdin: "" };
    for a in ["set jev.enabled false", "get jev.enabled --json", "show --section jev --json", "reset jev.enabled"] {
        same(&c, &a.split(' ').collect::<Vec<_>>())?;
    }
    Ok(())
}

#[test]
fn trust_allowlists_agree_with_node() -> R {
    let work = Scratch::new("repo")?;
    let r = work.path().join("repo");
    repo(&r)?;
    write(
        &r,
        ".anti-hall/command-allow.json",
        r#"{"patterns":["^npm test$","^ls ","^git status$|^rm -rf /$","^(.*)$","rm","^cat .*","^node [a-z]+\\.js$",5,"^x(","^a\\.b c$","^go build ./...$","^foo [^;]+$","^foo (?<n>x)$"]}"#,
    )?;
    write(&r, ".anti-hall/edit-allow.json", r#"{"paths":["docs/**","*.md","/abs","../x","a\\b","**"," pad",7,"~/x","C:foo","a/../b",""]}"#)?;
    let c = Same { script: "scripts/settings.js", verb: "settings", seed: None, cwd: Some(&r), env: &[], stdin: "" };
    for a in [
        "trust-command-allow",
        "trust-command-allow --json",
        "trust-command-allow --confirmed",
        "trust-command-allow --confirmed --json",
        "trust-edit-allow",
        "trust-edit-allow --json",
        "trust-edit-allow --confirmed",
        "trust-command-allow /nonexistent-xyz",
        "trust-command-allow /nonexistent-xyz --json",
    ] {
        same(&c, &a.split(' ').collect::<Vec<_>>())?;
    }
    Ok(())
}

// ---- defect -----------------------------------------------------------------------------------------------------------

fn defect_seed(root: &Path) -> R {
    let rep = |sym: &str, cls: &str, sev: &str, proj: &str, v: &str, at: &str, extra: &str| {
        format!(
            r#"{{"t":"report","at":"{at}","v":"{v}","proj":"{proj}","sid":"s1","class":"{cls}","sev":"{sev}","sym":"{sym}","repro":"r","claimed":"c","observed":"o"{extra}}}"#
        )
    };
    let rule = |at: &str, status: &str, extra: &str| format!(r#"{{"t":"ruling","at":"{at}","status":"{status}"{extra}}}"#);
    let fp = |cls: &str, sym: &str| {
        let out = Command::new("node")
            .arg("-e")
            .arg(format!("process.stdout.write(require('{}/hooks/lib/defect-store.js').fingerprint({cls:?},{sym:?}))", plugin_src().display()))
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap()
    };
    let put = |cls: &str, sym: &str, lines: Vec<String>| write(root, &format!(".anti-hall/defects/{}.jsonl", fp(cls, sym)), &(lines.join("\n") + "\n"));
    put("doc", "open one", vec![rep("open one", "doc", "p2", "pa", "0.5.0", "2026-01-01T00:00:00.000Z", "")])?;
    put(
        "hook-crash",
        "acked crash",
        vec![
            rep("acked crash", "hook-crash", "p0", "pb", "0.5.0", "2026-01-02T00:00:00.000Z", ""),
            rule("2026-01-03T00:00:00.000Z", "ack", r#","note":"looking""#),
        ],
    )?;
    put(
        "guard-miss",
        "fixed old",
        vec![
            rep("fixed old", "guard-miss", "p1", "pa", "0.4.0", "2020-01-02T00:00:00.000Z", r#","component":"hooks/x","cause":"lock-or-race""#),
            rule("2020-01-03T00:00:00.000Z", "fixed", r#","fixedIn":"0.4.1","commit":"abc123","note":"done""#),
        ],
    )?;
    put(
        "guard-miss",
        "regressed one",
        vec![
            rep("regressed one", "guard-miss", "p1", "pa", "0.4.0", "2026-02-02T00:00:00.000Z", ""),
            rule("2026-02-03T00:00:00.000Z", "fixed", r#","fixedIn":"0.4.1""#),
            rep("regressed one", "guard-miss", "p1", "pa", "0.4.2", "2026-02-04T00:00:00.000Z", ""),
            rep("regressed one", "guard-miss", "p1", "pa", "0.3.0", "2026-02-05T00:00:00.000Z", ""),
        ],
    )?;
    put(
        "state-leak",
        "partial one",
        vec![
            rep("partial one", "state-leak", "p2", "pc", "0.5.0", "2026-03-01T00:00:00.000Z", ""),
            rule("2026-03-02T00:00:00.000Z", "partial", r#","fixedIn":"0.5.1","note":"half""#),
        ],
    )?;
    put(
        "doc",
        "torn",
        vec![
            rep("torn", "doc", "p2", "pa", "0.5.0", "2026-01-01T00:00:00.000Z", ""),
            r#"{"t":"report","at":"2026"#.into(),
            "[1,2]".into(),
            r#""str""#.into(),
            "null".into(),
        ],
    )?;
    put(
        "other",
        "wontfix old",
        vec![rep("wontfix old", "other", "p2", "pa", "0.1.0", "2019-05-05T00:00:00.000Z", ""), rule("2019-05-06T00:00:00.000Z", "wontfix", r#","note":"n""#)],
    )?;
    write(
        root,
        ".anti-hall/defects/archive/2025-01/aaaaaaaaaaaa.jsonl",
        &format!(
            "{}\n{}\n",
            rep("arch", "doc", "p2", "pa", "0.1.0", "2024-01-01T00:00:00.000Z", ""),
            rule("2024-01-02T00:00:00.000Z", "fixed", r#","fixedIn":"0.1.1""#)
        ),
    )?;
    let bf = |sha: &str, at: &str, subj: &str, comp: &str, cause: &str, fixed: &str, cl: &str| {
        format!(
            r#"{{"t":"backfill","at":"{at}","source":"backfill","status":"fixed","fixCommit":"{sha}","subject":"{subj}","component":"{comp}","cause":"{cause}","fixedIn":{fixed}{cl}}}"#
        )
    };
    let z = "0".repeat(28);
    write(
        root,
        ".anti-hall/defects/history/1111111111aa.jsonl",
        &(bf(
            &format!("1111111111aa{z}"),
            "2026-01-10T00:00:00+00:00",
            "fix(hooks): lock race in settings",
            "hooks/x",
            "lock-or-race",
            r#""0.3.0""#,
            r#","changelog":"settings lock race""#,
        ) + "\n"),
    )?;
    write(
        root,
        ".anti-hall/defects/history/2222222222bb.jsonl",
        &(bf(&format!("2222222222bb{z}"), "2026-02-10T00:00:00+00:00", "fix: lock race again in hooks x", "hooks/x", "lock-or-race", r#""0.4.0""#, "") + "\n"),
    )?;
    write(
        root,
        ".anti-hall/defects/history/3333333333cc.jsonl",
        &(bf(&format!("3333333333cc{z}"), "2026-03-10T00:00:00+00:00", "fix: another lock race hooks x", "hooks/x", "lock-or-race", "null", "") + "\n"),
    )?;
    write(
        root,
        ".anti-hall/defects/history/4444444444dd.jsonl",
        &(bf(
            &format!("4444444444dd{z}"),
            "2026-03-11T00:00:00+00:00",
            "fix: parse regex in transcript",
            "hooks/t",
            "transcript-parse",
            r#""0.4.0""#,
            r#","changelog":"parse transcript regex""#,
        ) + "\n"),
    )?;
    Ok(())
}

#[test]
fn defect_reports_and_listings_agree_with_node() -> R {
    let c = Same { script: "scripts/defect.js", verb: "defect", seed: None, cwd: None, env: &[], stdin: "" };
    let long = "x".repeat(1500);
    let long_sym = "S".repeat(250);
    let long_proj = "P".repeat(100);
    let many = [
        "report --class doc --sev p1 --sym alpha_bug_one --proj pa",
        "report --class doc --sev p1 --sym alpha_bug_one --proj pa --json",
        "report --class doc --sev p9 --sym x --proj pa",
        "report --class nope --sev p1 --sym x --proj pa",
        "report --class doc --sev p1 --sym x --proj pa --bogus 1",
        "report --class doc --sev p1 --sym x --proj pa --fixed-in 1.0",
        "report --class hook-crash --sev p0 --sym crash on 12345abcdef start --proj pa --repro r --claimed c --observed o --component plugins/anti-hall/hooks/lib/x.js --cause lock-or-race",
        "report --class doc --sev p1 --sym x --proj pa --cause bogus",
        "report --class doc --sev p1 --sym x --proj pa --regression-of zz",
        "report --class doc --sev p1 --sym",
        "report --class doc --sev p1 --sym x",
        "list",
        "list --json",
        "list --open",
        "list --unfinished --json",
        "list --mine --proj pa",
        "show nonexistent",
        "show",
        "rule",
        "rule 000000000000 --status ack",
        "archive",
        "archive --json",
        "bogus",
        "recurring",
        "recurring --json",
        "similar",
        "similar lock race",
        "similar lock race --json",
        "backfill --dry-run",
    ];
    for a in many {
        same(&c, &a.split(' ').collect::<Vec<_>>())?;
    }
    same(&c, &["report", "--class", "doc", "--sev", "p1", "--sym", &long_sym, "--proj", "p"])?;
    same(&c, &["report", "--class", "doc", "--sev", "p1", "--sym", "ansi\u{1b}[31mred\u{1b}[0m tab", "--proj", &long_proj])?;
    same(
        &c,
        &[
            "report",
            "--class",
            "doc",
            "--sev",
            "p1",
            "--sym",
            "long",
            "--proj",
            "pa",
            "--repro",
            &long,
            "--claimed",
            &"c".repeat(700),
            "--observed",
            &"o".repeat(700),
        ],
    )?;
    same(&c, &["report", "--class", "doc", "--sev", "p1", "--sym", "ünï", "--proj", "é"])?;
    Ok(())
}

#[test]
fn defect_state_changes_agree_with_node_on_a_seeded_store() -> R {
    let seed = Scratch::new("seed")?;
    defect_seed(seed.path())?;
    let c = Same { script: "scripts/defect.js", verb: "defect", seed: Some(seed.path()), cwd: None, env: &[], stdin: "" };
    let list = same(&c, &["list", "--json"])?;
    assert!(list.stdout.contains("regressed"), "the seed exercises the regression status");
    for a in [
        "list",
        "list --open --json",
        "list --unfinished",
        "archive --json",
        "archive",
        "recurring",
        "recurring --json",
        "recurring --since 0.4.0",
        "recurring --since 2026-02-01",
        "recurring --top 1",
        "recurring --since v0.3.0 --json",
        "similar lock race",
        "similar lock race --component hooks/x --top 2",
        "similar parse --json",
        "similar --component hooks/t",
        "rule 061d5810bd0b --status ack --note hello",
        "rule 061d5810bd0b --status fixed --fixed-in 0.9.0 --commit deadbeef --note done --json",
        "rule 061d5810bd0b --status nope",
        "rule 061d5810bd0b --status dup --superseded-by 123456789012",
        "rule 061d5810bd0b --status ack --component hooks/y.js --cause wrong-default --regression-of 061d5810bd0b",
        "rule 061d5810bd0b --status ack --cause nope",
        "rule 061d5810bd0b",
        "report --class doc --sev p1 --sym open one --proj pa",
        "report --class guard-miss --sev p1 --sym regressed one --proj pa --v 0.9.9",
        "report --class guard-miss --sev p1 --sym regressed one --proj pa --v 0.1.0",
        "report --class state-leak --sev p2 --sym partial one --proj pc",
        "report --class doc --sev p2 --sym torn --proj pa",
        "list --mine --json",
    ] {
        same(&c, &a.split(' ').collect::<Vec<_>>())?;
    }
    for fp in ["061d5810bd0b", "f439e1659a84", "ac892214626c"] {
        same(&c, &["show", fp])?;
        same(&c, &["show", fp, "--json"])?;
    }
    Ok(())
}

#[test]
fn defect_identity_and_history_agree_with_node_in_a_repository() -> R {
    let work = Scratch::new("repo")?;
    let r = work.path().join("repoh");
    repo(&r)?;
    fs::create_dir_all(r.join("hooks/lib"))?;
    fs::create_dir_all(r.join("tests/hooks"))?;
    fs::create_dir_all(r.join("skills/foo"))?;
    let steps: &[(&str, &str, &str, Option<&str>)] = &[
        ("hooks/lib/a.js", "a\n", "feat: start", None),
        ("hooks/lib/a.js", "b\n", "fix(hooks): lock race in settings write", None),
        ("tests/hooks/zz.test.js", "c\n", "fix: test flake timeout", Some("v0.2.0")),
        ("skills/foo/SKILL.md", "d\n", "fix(skills): stale path in skill", None),
        ("hooks/lib/a.js", "e\n", "fix: v0.3.0 - parse regex crlf in transcript", Some("0.3.0")),
        ("x.txt", "f\n", "fix!: windows win32 crash", None),
    ];
    for (file, body, msg, tag) in steps {
        let mut f = fs::OpenOptions::new().create(true).append(true).open(r.join(file))?;
        f.write_all(body.as_bytes())?;
        git(&r, &["add", "-A"])?;
        git(&r, &["commit", "-q", "-m", msg, "-m", "body text silent swallow errors"])?;
        if let Some(t) = tag {
            git(&r, &["tag", t])?;
        }
    }
    write(
        &r,
        "CHANGELOG.md",
        "# Changelog\n\n## 0.3.0\n- Settings write: lock race fixed in the settings writer\n  continued line\n- parse regex for transcript crlf\n\n## v0.2.0\n- test flake timeout handled\n",
    )?;
    git(&r, &["add", "-A"])?;
    git(&r, &["commit", "-q", "-m", "docs: changelog"])?;
    let repo_s = r.to_string_lossy().into_owned();
    let c = Same { script: "scripts/defect.js", verb: "defect", seed: None, cwd: Some(&r), env: &[], stdin: "" };
    for a in [
        vec!["backfill", "--repo", &repo_s, "--dry-run"],
        vec!["backfill", "--repo", &repo_s],
        vec!["backfill", "--repo", &repo_s, "--json"],
        vec!["backfill", "--repo", "/nonexistent-zz"],
        vec!["report", "--class", "doc", "--sev", "p1", "--sym", "no proj given"],
        vec!["report", "--class", "doc", "--sev", "p1", "--sym", "no proj given again", "--sid", "S1", "--v", "9.9.9"],
        vec!["list", "--mine"],
        vec!["list", "--mine", "--json"],
    ] {
        same(&c, &a)?;
    }
    let env: &[(&str, &str)] = &[("CLAUDE_SESSION_ID", "sess123"), ("ANTIHALL_DEFECT_PROJ", "envproj")];
    let c = Same { env, ..c };
    for a in [vec!["report", "--class", "doc", "--sev", "p1", "--sym", "env proj"], vec!["list", "--mine", "--json"]] {
        same(&c, &a)?;
    }
    // history queries over a backfilled store
    let store = Scratch::new("store")?;
    let seeded = Command::new("node")
        .arg(plugin_src().join("scripts/defect.js"))
        .args(["backfill", "--repo", &repo_s])
        .env("HOME", store.path())
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .output()?;
    assert!(seeded.status.success());
    let c = Same { script: "scripts/defect.js", verb: "defect", seed: Some(store.path()), cwd: None, env: &[], stdin: "" };
    for a in ["recurring", "recurring --json", "similar lock race", "similar windows crash --json", "similar regex --component hooks/a", "list"] {
        same(&c, &a.split(' ').collect::<Vec<_>>())?;
    }
    Ok(())
}

// ---- statusline -------------------------------------------------------------------------------------------------------

fn statusline_pair(c: &Same, args: &[&str]) -> R {
    for attempt in 0..3 {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| same(c, args))) {
            Ok(r) => return r.map(|_| ()),
            Err(e) if attempt == 2 => std::panic::resume_unwind(e),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(1100)),
        }
    }
    Ok(())
}

#[test]
fn statusline_agrees_with_node() -> R {
    let work = Scratch::new("repo")?;
    let r = work.path().join("proj");
    repo(&r)?;
    write(&r, "a.txt", "a")?;
    git(&r, &["add", "-A"])?;
    git(&r, &["commit", "-q", "-m", "init"])?;
    write(&r, "b.txt", "b")?;
    write(&r, "a.txt", "changed")?;
    let sub = r.join("pkg/inner");
    fs::create_dir_all(&sub)?;
    let seed = Scratch::new("seed")?;
    write(seed.path(), ".claude.json", r#"{"oauthAccount":{"emailAddress":" me@example.com "},"projects":{}}"#)?;
    write(seed.path(), ".anti-hall/version-check.json", r#"{"latest":"99.0.0"}"#)?;
    let started = ah_engine::checks::jsport::date::now_ms() as i64 - 2 * 3_600_000;
    write(
        seed.path(),
        ".anti-hall/phase-state.json",
        &format!(
            r#"{{"code":"P2","desc":"build the api with a long description that is cut","done":2,"total":5,"started":{started},"agents":1,"step":"compiling a very long step text here"}}"#
        ),
    )?;
    let bare = Scratch::new("bare")?;
    write(bare.path(), ".claude.json", "{}")?;
    let inputs = [
        r#"{"model":{"display_name":"Opus"},"context_window":{"used_percentage":56.7,"remaining_percentage":40,"used_tokens":128000,"max_tokens":230000},"cost":{"total_cost_usd":1.234,"total_duration_ms":125000},"session_id":"abc","effort":"high"}"#,
        r#"{"model":{"display_name":"Sonnet"},"context_window":{"used_percentage":95},"cost":{"total_cost_usd":0,"total_duration_ms":5000},"output_style":{"name":"thinking"}}"#,
        r#"{"context_window":{"remaining_percentage":10}}"#,
        r#"{"cost":{"total_cost_usd":"5"}}"#,
        "{}",
        "not json",
        "",
    ];
    for (seeded, dirs) in [(Some(seed.path()), vec![r.as_path(), sub.as_path()]), (Some(bare.path()), vec![r.as_path()]), (None, vec![work.path()])] {
        for cwd in dirs {
            for input in &inputs {
                let c = Same { script: "statusline/statusline.js", verb: "statusline", seed: seeded, cwd: Some(cwd), env: &[], stdin: input };
                statusline_pair(&c, &[])?;
            }
        }
    }
    // colors off, base commands, consolidated base
    let c =
        Same { script: "statusline/statusline.js", verb: "statusline", seed: Some(seed.path()), cwd: Some(&r), env: &[("NO_COLOR", "1")], stdin: inputs[0] };
    statusline_pair(&c, &[])?;
    let base = Scratch::new("base")?;
    write(base.path(), ".anti-hall/base-statusline.json", r#"{"command":"printf 'BASE LINE\\n'"}"#)?;
    let c = Same { seed: Some(base.path()), ..c };
    statusline_pair(&c, &[])?;
    write(base.path(), ".anti-hall/base-statusline.json", r#"{"command":"exit 3"}"#)?;
    statusline_pair(&c, &[])?;
    write(base.path(), ".anti-hall/base-statusline.json", "{}")?;
    write(base.path(), ".anti-hall/consolidated-base.json", r#"{"command":"cat >/dev/null; echo CONSOLIDATED"}"#)?;
    statusline_pair(&c, &[])?;
    // context bridge, activity and the gauge
    let act = Scratch::new("act")?;
    let now = ah_engine::checks::jsport::date::now_ms() as i64;
    write(act.path(), ".anti-hall/agent-spawns.log", &format!("{now} abc\n{} abc\n{now} other\n", now - 600_000))?;
    let c = Same { seed: Some(act.path()), env: &[], stdin: inputs[0], ..c };
    statusline_pair(&c, &[])?;
    // fallback renderers (a string cost makes the rich renderer throw)
    let c = Same { stdin: r#"{"model":{"display_name":"M"},"cost":{"total_cost_usd":"5"},"context_window":{"remaining_percentage":30}}"#, ..c };
    statusline_pair(&c, &[])?;
    fs::write(r.join(".gitmodules"), "")?;
    statusline_pair(&c, &[])?;
    Ok(())
}

// ---- phase ------------------------------------------------------------------------------------------------------------

const PHASE_CASES: &[&[&str]] = &[
    &["set", "P1", "build the api", "2", "5"],
    &["set"],
    &["set", "P", "x y", "abc", "3"],
    &["set", "P", "d", "-3", "+4"],
    &["set", "", "", "0", "0"],
    &["set", "P", "d", "1e3", "99999999999999999999"],
    &["advance"],
    &["advance", "3"],
    &["advance", "abc"],
    &["advance", "0"],
    &["advance", "-2"],
    &["advance", "2.9"],
    &["step", "a", "b", "c"],
    &["step"],
    &["step", "--json"],
    &["agents", "3"],
    &["agents", "abc"],
    &["agents"],
    &["agents", "-0"],
    &["agents", "007"],
    &["update", "a=1", "b=x", "c=", "=5", "d=-7", "e=007", "f=1.5", "g", "h=a=b", "i=-0", "j=+4"],
    &["update"],
    &["update", "done=9", "step=hello"],
    &["update", "5=x"],
    &["update", "__proto__=1"],
    &["clear"],
    &["bogus"],
    &[],
    &[""],
    &["SET", "P"],
];

fn phase_seed(root: &Path, state: &str) -> R {
    write(root, ".anti-hall/phase-state.json", state)
}

#[test]
fn phase_agrees_with_node() -> R {
    let states: Vec<Option<&str>> = vec![
        None,
        Some(r#"{"code":"P","desc":"d","done":"7","total":5,"started":1,"agents":2,"step":"s","extra":{"a":[1,2]}}"#),
        Some(r#"{"done":2.5,"agents":"x"}"#),
        Some(r#"{"done":[3]}"#),
        Some(r#"{"done":{}}"#),
        Some(r#"{"done":true}"#),
        Some(r#"{"done":null,"z":1,"a":2}"#),
        Some(r#"{"done":1e21}"#),
        Some("{bad"),
        Some(""),
        Some("\u{feff}{}"),
        Some(r#"{"a":1,"a":2,"b":"\u00e9\ud83d\ude00"}"#),
    ];
    for state in states {
        let seed = Scratch::new("seed")?;
        if let Some(st) = state {
            phase_seed(seed.path(), st)?;
        }
        for args in PHASE_CASES {
            if state.is_some_and(|s| s.is_empty() || s == "{bad") && args.first() == Some(&"update") && args.contains(&"5=x") {
                continue;
            }
            let c = Same { script: "statusline/phase.js", verb: "phase", seed: state.map(|_| seed.path()), cwd: None, env: &[], stdin: "" };
            // `update 5=x` and `update __proto__=1` are left to Node by design: compare only that nothing is written
            if args.contains(&"5=x") || args.contains(&"__proto__=1") {
                let eh = Scratch::new("e")?;
                let before = snapshot(eh.path())?;
                let mut cmd = Command::new(BIN);
                cmd.arg("phase").args(*args);
                let o = run(cmd, eh.path(), eh.path(), &[], "")?;
                assert_eq!(o.code, 75, "deferred");
                assert_eq!(before, snapshot(eh.path())?, "a deferral writes nothing");
                CASES.fetch_add(1, Ordering::SeqCst);
                continue;
            }
            same(&c, args)?;
        }
    }
    Ok(())
}

#[test]
fn phase_defers_on_a_state_javascript_would_mishandle() -> R {
    for state in ["[1,2]", "null", "5", "\"str\"", "true"] {
        for args in [vec!["advance"], vec!["step", "x"], vec!["agents", "2"], vec!["update", "a=1"]] {
            let h = Scratch::new("defer")?;
            phase_seed(h.path(), state)?;
            let mut cmd = Command::new(BIN);
            cmd.arg("phase").args(&args);
            let o = run(cmd, h.path(), h.path(), &[], "")?;
            assert_eq!(o.code, 75, "{state} {args:?}");
            assert_eq!(fs::read_to_string(h.path().join(".anti-hall/phase-state.json"))?, state, "nothing written");
        }
    }
    // set and clear never read the old state
    for (state, args) in [("[1,2]", vec!["set", "P", "d", "1", "2"]), ("null", vec!["clear"])] {
        let h = Scratch::new("defer-ok")?;
        phase_seed(h.path(), state)?;
        let mut cmd = Command::new(BIN);
        cmd.arg("phase").args(&args);
        assert_eq!(run(cmd, h.path(), h.path(), &[], "")?.code, 0);
    }
    Ok(())
}

// ---- install-statusline and uninstall-statusline ------------------------------------------------------------------------

type Case<'a> = (Option<String>, Vec<(&'a str, &'a str)>);

struct Inst<'a> {
    home: Option<&'a Path>,
    cwd: Option<&'a Path>,
    env: &'a [(&'a str, &'a str)],
}

/// Run the steps (`(script, verb, args)`) with Node on one pair of (home, project) scratch copies and with the engine on
/// another, comparing output, exit code and both trees after each step. Returns the engine's last output.
fn inst(c: &Inst, steps: &[(&str, &str, &[&str])]) -> R<Out> {
    let (nh, eh, nc, ec) = (Scratch::new("nh")?, Scratch::new("eh")?, Scratch::new("nc")?, Scratch::new("ec")?);
    for h in [nh.path(), eh.path()] {
        fs::create_dir_all(h.join("tmp"))?;
        if let Some(s) = c.home {
            copy_dir(s, h)?;
        }
    }
    for d in [nc.path(), ec.path()] {
        if let Some(s) = c.cwd {
            copy_dir(s, d)?;
        }
    }
    let mut last = None;
    for (script, verb, args) in steps {
        let name = format!("{verb} {}", args.join(" "));
        let mut n = Command::new("node");
        n.arg(plugin_src().join(script)).args(*args);
        let mut e = Command::new(BIN);
        e.arg(verb).args(*args);
        let no = run(n, nh.path(), nc.path(), c.env, "")?;
        let eo = run(e, eh.path(), ec.path(), c.env, "")?;
        let m = |o: &Out, h: &Path, d: &Path| {
            let cw = |t: &str| t.replace(&d.to_string_lossy().into_owned(), "CWD");
            Out { stdout: mask(&cw(&o.stdout), &[h]), stderr: mask(&cw(&o.stderr), &[h]), code: o.code }
        };
        let (nm, em) = (m(&no, nh.path(), nc.path()), m(&eo, eh.path(), ec.path()));
        assert_text(&name, "stdout", &nm.stdout, &em.stdout);
        assert_text(&name, "stderr", &nm.stderr, &em.stderr);
        assert_eq!(nm.code, em.code, "{name}: exit code");
        assert_eq!(snapshot(nh.path())?, snapshot(eh.path())?, "{name}: home tree");
        assert_eq!(snapshot(nc.path())?, snapshot(ec.path())?, "{name}: project tree");
        CASES.fetch_add(1, Ordering::SeqCst);
        last = Some(eo);
    }
    last.ok_or_else(|| "no steps".into())
}

const INSTALL: &str = "statusline/install-statusline.js";
const UNINSTALL: &str = "statusline/uninstall-statusline.js";

fn one(c: &Inst, install: bool, args: &[&str]) -> R<Out> {
    let (script, verb) = if install { (INSTALL, "install-statusline") } else { (UNINSTALL, "uninstall-statusline") };
    inst(c, &[(script, verb, args)])
}

fn home_with(settings: Option<&str>, extra: &[(&str, &str)]) -> R<Scratch> {
    let h = Scratch::new("hseed")?;
    if let Some(s) = settings {
        write(h.path(), ".claude/settings.json", s)?;
    }
    for (p, c) in extra {
        write(h.path(), p, c)?;
    }
    Ok(h)
}

#[test]
fn install_agrees_with_node_in_the_user_scope() -> R {
    let ours = format!("node \"{}/statusline/statusline.js\"", plugin_src().display());
    let installed = format!(r#"{{"model":"x","statusLine":{{"type":"command","command":{}}}}}"#, serde_json::to_string(&ours)?);
    let cases: Vec<Case> = vec![
        (None, vec![]),
        (Some("{}".into()), vec![]),
        (Some("{}\n".into()), vec![(".anti-hall/base-statusline.json", r#"{"command":"printf shared"}"#)]),
        (Some(r#"{"a":{"b":[1,2,{"c":null}]},"statusLine":{"type":"command","command":"echo hi","padding":2},"z":1e21,"u":"\u00e9"}"#.into()), vec![]),
        (Some(r#"{"statusLine":{"type":"command","command":"echo hi"}}"#.into()), vec![(".anti-hall/base-statusline.json", r#"{"command":"printf shared"}"#)]),
        (Some(r#"{"statusLine":{"type":"command","command":"echo hi"}}"#.into()), vec![(".claude/settings.json.bak-antihall", "{\"old\":true}")]),
        (Some(r#"{"statusLine":"plain"}"#.into()), vec![]),
        (Some(r#"{"statusLine":12.50}"#.into()), vec![]),
        (Some(r#"{"statusLine":null}"#.into()), vec![]),
        (Some(r#"{"statusLine":{"type":"static"}}"#.into()), vec![]),
        (Some(r#"{"statusLine":{"command":""}}"#.into()), vec![]),
        (Some(r#"{"statusLine":["a",null]}"#.into()), vec![]),
        (Some(r#"{"statusLine":{"command":5}}"#.into()), vec![]),
        (Some(installed.clone()), vec![]),
        (Some(r#"{"statusLine":{"type":"command","command":"node /x/anti-hall/statusline/statusline.js"}}"#.into()), vec![]),
        (Some(r#"{"statusLine":{"type":"command","command":"node /x/other/statusline.js"}}"#.into()), vec![]),
        (Some("{}".into()), vec![(".claude/plugins/marketplaces/anti-hall/plugins/anti-hall/statusline/statusline.js", "")]),
    ];
    for (settings, extra) in &cases {
        let seed = home_with(settings.as_deref(), extra)?;
        let c = Inst { home: Some(seed.path()), cwd: None, env: &[] };
        for args in [&[][..], &["--user"], &["--consolidate"]] {
            one(&c, true, args)?;
        }
    }
    Ok(())
}

#[test]
fn install_agrees_with_node_on_the_consolidate_and_overrides() -> R {
    let seed = home_with(Some(r#"{"statusLine":{"type":"command","command":"echo hi"}}"#), &[])?;
    let seed_c = home_with(Some(r#"{"statusLine":{"type":"command","command":"echo hi"}}"#), &[(".anti-hall/consolidated-base.json", "{}")])?;
    for s in [&seed, &seed_c] {
        let c = Inst { home: Some(s.path()), cwd: None, env: &[] };
        one(&c, true, &["--consolidate"])?;
    }
    for ov in ["/x/y/statusline.js", "/x y/statusline.js", "a;b", "/x/$(id)/s.js", "", "relative/s.js", "/tmp/with'quote", "/x/\u{e9}/s.js"] {
        let c = Inst { home: Some(seed.path()), cwd: None, env: &[("ANTIHALL_DISPATCHER_OVERRIDE", ov)] };
        one(&c, true, &[])?;
    }
    // an installer chained after an installer: idempotent
    let c = Inst { home: Some(seed.path()), cwd: None, env: &[] };
    inst(&c, &[(INSTALL, "install-statusline", &[]), (INSTALL, "install-statusline", &[]), (INSTALL, "install-statusline", &["--consolidate"])])?;
    Ok(())
}

#[test]
fn install_agrees_with_node_on_unwritable_and_unreadable_files() -> R {
    let seed = home_with(Some(r#"{"statusLine":{"type":"command","command":"echo hi"}}"#), &[])?;
    fs::set_permissions(seed.path().join(".claude/settings.json"), fs::Permissions::from_mode(0o444))?;
    let c = Inst { home: Some(seed.path()), cwd: None, env: &[] };
    let o = one(&c, true, &[])?;
    assert_eq!(o.code, 1);
    fs::set_permissions(seed.path().join(".claude/settings.json"), fs::Permissions::from_mode(0o600))?;
    // a read-only base directory: the base file cannot be written, the install goes on
    let seed2 = home_with(Some(r#"{"statusLine":{"type":"command","command":"echo hi"}}"#), &[(".anti-hall/keep", "")])?;
    fs::set_permissions(seed2.path().join(".anti-hall"), fs::Permissions::from_mode(0o555))?;
    let c2 = Inst { home: Some(seed2.path()), cwd: None, env: &[] };
    let r = one(&c2, true, &[]);
    let r2 = one(&c2, true, &["--consolidate"]);
    fs::set_permissions(seed2.path().join(".anti-hall"), fs::Permissions::from_mode(0o755))?;
    r?;
    r2?;
    Ok(())
}

#[test]
fn install_defers_on_a_settings_file_it_cannot_parse_like_javascript() -> R {
    for body in ["{bad", "", "null", "[1]", "5", "\u{feff}{}", "{\"a\":\"\\ud800\"}"] {
        let seed = home_with(Some(body), &[])?;
        let before = snapshot(seed.path())?;
        let mut cmd = Command::new(BIN);
        cmd.arg("install-statusline");
        let o = run(cmd, seed.path(), seed.path(), &[], "")?;
        // `[1]` and `5` have no statusLine and Node would add one; the engine leaves every non-object file to Node
        assert_eq!(o.code, 75, "{body:?}: {}", o.stderr);
        assert!(o.stdout.is_empty(), "{body:?}: a deferral prints nothing on stdout, got {:?}", o.stdout);
        assert_eq!(before, snapshot(seed.path())?, "{body:?}: a deferral writes nothing");
        let mut cmd = Command::new(BIN);
        cmd.arg("uninstall-statusline");
        let o = run(cmd, seed.path(), seed.path(), &[], "")?;
        assert_eq!(o.code, 75, "{body:?} uninstall: {}", o.stderr);
        assert_eq!(before, snapshot(seed.path())?, "{body:?}: a deferral writes nothing");
    }
    Ok(())
}

fn project_cwd(files: &[(&str, &str)], git_tracked: Option<&str>) -> R<Scratch> {
    let d = Scratch::new("cwdseed")?;
    for (p, c) in files {
        write(d.path(), p, c)?;
    }
    if let Some(tracked) = git_tracked {
        repo(d.path())?;
        git(d.path(), &["add", "-f", tracked])?;
    }
    Ok(d)
}

#[test]
fn install_agrees_with_node_in_the_project_scope() -> R {
    let ours = format!("node \"{}/statusline/statusline.js\"", plugin_src().display());
    let ours_json = serde_json::to_string(&ours)?;
    let sl = |cmd: &str| format!(r#"{{"statusLine":{{"type":"command","command":{}}}}}"#, serde_json::to_string(cmd).unwrap());
    let cwds: Vec<Scratch> = vec![
        project_cwd(&[], None)?,
        project_cwd(&[(".claude/settings.json", &sl("echo committed"))], None)?,
        project_cwd(&[(".claude/settings.local.json", &sl("echo local"))], None)?,
        project_cwd(&[(".claude/settings.local.json", "{\"model\":\"x\"}"), (".gitignore", "node_modules\n")], None)?,
        project_cwd(&[(".gitignore", "a\n.claude/settings.local.json\nb")], None)?,
        project_cwd(&[(".gitignore", "a\n  .claude/settings.local.json  \r\n")], None)?,
        project_cwd(&[(".gitignore", "no newline at end")], None)?,
        project_cwd(&[(".gitignore", "")], None)?,
        project_cwd(&[(".claude/settings.local.json", "{}")], Some(".claude/settings.local.json"))?,
        project_cwd(&[(".claude/settings.json", &sl(&ours)), (".claude/settings.local.json", "{}")], None)?,
        project_cwd(&[(".claude/settings.local.json", &format!(r#"{{"statusLine":{{"type":"command","command":{ours_json}}}}}"#))], None)?,
        project_cwd(&[(".claude/settings.local.json", "{\"statusLine\":\"s\"}"), (".claude/settings.json", "{\"statusLine\":42}")], None)?,
        project_cwd(&[(".claude/settings.json", "{\"statusLine\":null}")], None)?,
        project_cwd(&[(".claude/settings.json", "{\"statusLine\":[1,{}]}")], None)?,
        project_cwd(&[(".claude/settings.json", "{\"statusLine\":{\"command\":[\"a\",null,\"b\"]}}")], None)?,
        project_cwd(&[(".claude/settings.json", "{\"statusLine\":{\"command\":0}}")], None)?,
        project_cwd(&[(".claude/settings.json", "{not json")], None)?,
    ];
    let homes: Vec<Scratch> = vec![home_with(None, &[])?, home_with(Some(&sl("echo user")), &[])?, home_with(Some(&sl(&ours)), &[])?];
    for cwd in &cwds {
        for home in &homes {
            let c = Inst { home: Some(home.path()), cwd: Some(cwd.path()), env: &[] };
            one(&c, true, &["--project"])?;
            one(&c, true, &["--project", "--consolidate"])?;
        }
    }
    // a .gitignore that is a directory: Node crashes with a stack trace, the engine leaves it to Node
    let d = project_cwd(&[(".claude/settings.local.json", "{}"), (".gitignore/x", "")], None)?;
    let h = home_with(None, &[])?;
    let mut cmd = Command::new(BIN);
    cmd.args(["install-statusline", "--project"]);
    let o = run(cmd, h.path(), d.path(), &[], "")?;
    assert_eq!(o.code, 75);
    Ok(())
}

#[test]
fn uninstall_agrees_with_node() -> R {
    let ours = format!("node \"{}/statusline/statusline.js\"", plugin_src().display());
    let sl = |cmd: &str| {
        format!(
            r#"{{"keep":1,"statusLine":{{"type":"command","command":{},"padding":0,"refreshInterval":1}},"tail":[1,2]}}"#,
            serde_json::to_string(cmd).unwrap()
        )
    };
    let base = (".anti-hall/base-statusline.json", r#"{"command":"  echo original  "}"#);
    let bak = (".claude/settings.json.bak-antihall", r#"{"keep":2,"statusLine":{"type":"command","command":"echo from-backup"}}"#);
    let cases: Vec<Case> = vec![
        (None, vec![]),
        (Some(sl(&ours)), vec![]),
        (Some(sl(&ours)), vec![base]),
        (Some(sl(&ours)), vec![base, bak]),
        (Some(sl("echo foreign")), vec![base]),
        (Some(sl("echo foreign")), vec![base, bak]),
        (Some("{}".into()), vec![base]),
        (Some("{\"statusLine\":\"str\"}".into()), vec![base]),
        (Some(sl(&ours)), vec![(".anti-hall/base-statusline.json", "{}")]),
        (Some(sl(&ours)), vec![(".anti-hall/base-statusline.json", r#"{"command":"   "}"#)]),
        (Some(sl(&ours)), vec![(".anti-hall/base-statusline.json", r#"{"command":5}"#)]),
        (Some(sl(&ours)), vec![(".anti-hall/base-statusline.json", "null")]),
        (Some(sl(&ours)), vec![(".anti-hall/base-statusline.json", "[]")]),
        (Some(sl(&ours)), vec![bak]),
        (Some(sl(&ours)), vec![(".claude/settings.json.bak-antihall", "{\"keep\":3}")]),
        (Some(sl(&ours)), vec![(".claude/settings.json.bak-antihall", "null")]),
        (Some(sl(&ours)), vec![(".claude/settings.json.bak-antihall", "[1,2]")]),
        (Some(sl(&ours)), vec![(".claude/settings.json.bak-antihall", "7")]),
        (Some(sl(&ours)), vec![(".claude/settings.json.bak-antihall", "{\"statusLine\":null}")]),
        (Some("{\"a\":1}".into()), vec![]),
        (Some("{\"statusLine\":{\"x\":[1,2,{\"y\":null}]}}".into()), vec![]),
    ];
    for (settings, extra) in &cases {
        let seed = home_with(settings.as_deref(), extra)?;
        let c = Inst { home: Some(seed.path()), cwd: None, env: &[] };
        for args in [&[][..], &["--purge-base"], &["--user"]] {
            one(&c, false, args)?;
        }
    }
    // base and backup present only for the project scope, local file preferred and the fallback to the committed one
    let local = (".claude/settings.local.json", sl(&ours));
    let committed = (".claude/settings.json", sl(&ours));
    for files in [vec![local.clone()], vec![committed.clone()], vec![local.clone(), committed.clone()], vec![]] {
        let files: Vec<(&str, &str)> = files.iter().map(|(a, b)| (*a, b.as_str())).collect();
        let cwd = project_cwd(&files, None)?;
        for h in [home_with(None, &[])?, home_with(None, &[base])?] {
            let c = Inst { home: Some(h.path()), cwd: Some(cwd.path()), env: &[] };
            one(&c, false, &["--project"])?;
            one(&c, false, &["--project", "--purge-base"])?;
        }
    }
    Ok(())
}

#[test]
fn install_then_uninstall_round_trips_like_node() -> R {
    let seed = home_with(Some(r#"{"keep":1,"statusLine":{"type":"command","command":"echo mine"}}"#), &[])?;
    let c = Inst { home: Some(seed.path()), cwd: None, env: &[] };
    inst(
        &c,
        &[
            (INSTALL, "install-statusline", &[]),
            (UNINSTALL, "uninstall-statusline", &[]),
            (UNINSTALL, "uninstall-statusline", &[]),
            (INSTALL, "install-statusline", &["--consolidate"]),
            (UNINSTALL, "uninstall-statusline", &["--purge-base"]),
        ],
    )?;
    let cwd = project_cwd(&[(".gitignore", "x\n")], None)?;
    let h = home_with(Some(r#"{"statusLine":{"type":"command","command":"echo user"}}"#), &[])?;
    let c = Inst { home: Some(h.path()), cwd: Some(cwd.path()), env: &[] };
    inst(
        &c,
        &[
            (INSTALL, "install-statusline", &["--project"]),
            (INSTALL, "install-statusline", &["--project"]),
            (UNINSTALL, "uninstall-statusline", &["--project"]),
            (UNINSTALL, "uninstall-statusline", &["--project", "--purge-base"]),
        ],
    )?;
    Ok(())
}

#[test]
fn the_installers_keep_the_mode_and_the_link_of_the_settings_file() -> R {
    let h = home_with(Some("{}"), &[])?;
    let real = h.path().join("dotfiles/settings.json");
    fs::create_dir_all(real.parent().ok_or("no parent")?)?;
    fs::write(&real, "{\"keep\":1}\n")?;
    fs::set_permissions(&real, fs::Permissions::from_mode(0o640))?;
    let link = h.path().join(".claude/settings.json");
    fs::remove_file(&link)?;
    std::os::unix::fs::symlink(&real, &link)?;
    let mut cmd = Command::new(BIN);
    cmd.arg("install-statusline");
    let o = run(cmd, h.path(), h.path(), &[], "")?;
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(fs::symlink_metadata(&link)?.file_type().is_symlink(), "the link survives");
    assert!(fs::read_to_string(&real)?.contains("\"statusLine\""), "the target is updated");
    assert_eq!(fs::metadata(&real)?.permissions().mode() & 0o777, 0o640, "the mode is kept");
    let bak = h.path().join(".claude/settings.json.bak-antihall");
    assert_eq!(fs::read_to_string(bak)?, "{\"keep\":1}\n", "the backup holds the original");
    let leftovers: Vec<_> = fs::read_dir(real.parent().ok_or("no parent")?)?.flatten().filter(|e| e.file_name().to_string_lossy().contains(".tmp")).collect();
    assert!(leftovers.is_empty(), "no temporary file is left behind");
    Ok(())
}

#[test]
fn the_installers_refuse_user_config_outside_a_temp_dir_under_a_test() -> R {
    // a home outside every temporary directory (it does not exist: the refusal comes before any file is touched)
    let h = home_with(Some("{}"), &[])?;
    for marker in ["NODE_TEST_CONTEXT", "ANTIHALL_TEST_ISOLATION"] {
        for (home_env, refused) in [(Some("/ah-nonexistent-home"), true), (None, false)] {
            let env: Vec<(&str, &str)> = [Some((marker, "1")), home_env.map(|h| ("HOME", h))].into_iter().flatten().collect();
            let c = Inst { home: Some(h.path()), cwd: None, env: &env };
            for install_it in [true, false] {
                let o = one(&c, install_it, &[])?;
                assert_eq!(o.stderr.contains("refused under a test"), refused, "{marker} {home_env:?}: {}", o.stderr);
            }
        }
    }
    // without a marker the same home is not refused (it is simply missing)
    let c = Inst { home: None, cwd: None, env: &[("HOME", "/ah-nonexistent-home")] };
    assert_eq!(one(&c, true, &[])?.code, 1);
    Ok(())
}

// ---- the Node shadow --------------------------------------------------------------------------------------------------

fn engine_with_shadow(home: &Path, rate: &str, node: Option<&Path>, args: &[&str]) -> R {
    let mut c = Command::new(BIN);
    c.args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH")?)
        .env("HOME", home)
        .env("CLAUDE_PLUGIN_ROOT", plugin_src())
        .env("AH_ENGINE_SHADOW_RATE_SETTINGS", rate)
        .env("AH_ENGINE_DIR", home.join("state"))
        .stdout(Stdio::null());
    if let Some(n) = node {
        c.env("AH_ENGINE_NODE", n);
    }
    assert!(c.status()?.success());
    Ok(())
}

fn wait_shadow_done(state: &Path) -> bool {
    let d = state.join("shadow");
    for _ in 0..200 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let entries: Vec<_> = fs::read_dir(&d).map(|rd| rd.flatten().collect()).unwrap_or_default();
        if entries.iter().all(|e| e.path().join("mismatch.txt").exists())
            && !entries.iter().any(|e| e.path().join("job.json").exists() && !e.path().join("mismatch.txt").exists())
        {
            return true;
        }
    }
    false
}

#[test]
fn a_sampled_run_leaves_no_trace_when_node_agrees_and_a_report_when_it_does_not() -> R {
    let seed = Scratch::new("seed")?;
    settings_seed(seed.path())?;
    let home = Scratch::new("shadow")?;
    copy_dir(seed.path(), home.path())?;
    let state = home.path().join("state");
    engine_with_shadow(home.path(), "1000", None, &["settings", "show", "--json"])?;
    assert!(wait_shadow_done(&state), "the comparison finished");
    let left: Vec<_> = fs::read_dir(state.join("shadow")).map(|rd| rd.flatten().collect()).unwrap_or_default();
    assert!(left.is_empty(), "a matching shadow removes its scratch directory: {left:?}");
    // a Node that answers differently is a mismatch with the report kept
    let fake = home.path().join("fake-node.sh");
    fs::write(&fake, "#!/bin/sh\necho different\n")?;
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755))?;
    engine_with_shadow(home.path(), "1000", Some(&fake), &["settings", "show", "--json"])?;
    assert!(wait_shadow_done(&state), "the second comparison finished");
    let reports: Vec<_> = fs::read_dir(state.join("shadow"))?.flatten().filter(|e| e.path().join("mismatch.txt").exists()).collect();
    assert_eq!(reports.len(), 1, "one mismatch report");
    let text = fs::read_to_string(reports[0].path().join("mismatch.txt"))?;
    assert!(text.contains("different"), "the report holds Node's output");
    // the shadow never changed the real state: settings.json is as seeded
    assert_eq!(fs::read_to_string(home.path().join(".anti-hall/settings.json"))?, fs::read_to_string(seed.path().join(".anti-hall/settings.json"))?);
    eprintln!("operator parity cases: {}", CASES.load(Ordering::SeqCst));
    Ok(())
}

fn engine_shadowed(home: &Path, cwd: &Path, node: Option<&Path>, extra: &[(&str, &Path)], args: &[&str]) -> R<Out> {
    let mut c = Command::new(BIN);
    c.args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH")?)
        .env("HOME", home)
        .env("CLAUDE_PLUGIN_ROOT", plugin_src())
        .env("AH_ENGINE_SHADOW_RATE_PHASE", "1000")
        .env("AH_ENGINE_SHADOW_RATE_INSTALL", "1000")
        .env("AH_ENGINE_SHADOW_RATE_UNINSTALL", "1000")
        .env("AH_ENGINE_DIR", home.join("state"))
        .current_dir(cwd);
    if let Some(n) = node {
        c.env("AH_ENGINE_NODE", n);
    }
    for (k, v) in extra {
        c.env(k, v);
    }
    let o = c.output()?;
    Ok(Out {
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        code: o.status.code().unwrap_or(-1),
    })
}

fn shadow_dirs(state: &Path) -> Vec<PathBuf> {
    fs::read_dir(state.join("shadow")).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default()
}

#[test]
fn a_sampled_phase_run_is_replayed_by_node_and_agrees() -> R {
    let home = Scratch::new("shadow-phase")?;
    let state = home.path().join("state");
    for args in [
        vec!["phase", "set", "P1", "build", "1", "4"],
        vec!["phase", "advance", "2"],
        vec!["phase", "update", "a=1", "b=x"],
        vec!["phase", "clear"],
        vec!["phase", "bogus"],
    ] {
        let o = engine_shadowed(home.path(), home.path(), None, &[], &args)?;
        assert_eq!(o.code, 0, "{args:?}");
        assert!(wait_shadow_done(&state), "the comparison finished: {args:?}");
        let left = shadow_dirs(&state);
        assert!(left.is_empty(), "{args:?}: Node agreed, so nothing is kept: {left:?}");
    }
    Ok(())
}

#[test]
fn a_sampled_installer_run_is_replayed_on_a_scratch_copy_and_never_writes_twice() -> R {
    let home = home_with(Some(r#"{"keep":1,"statusLine":{"type":"command","command":"echo mine"}}"#), &[])?;
    let cwd = project_cwd(&[(".claude/settings.json", r#"{"statusLine":{"type":"command","command":"echo committed"}}"#), (".gitignore", "x\n")], None)?;
    let state = home.path().join("state");
    let log = home.path().join("fake-node.log");
    // Node agrees (the real script, on the scratch copy), for the user and the project scope and for the uninstaller
    for args in [
        vec!["install-statusline"],
        vec!["install-statusline", "--project"],
        vec!["install-statusline", "--consolidate"],
        vec!["uninstall-statusline"],
        vec!["uninstall-statusline", "--project", "--purge-base"],
        vec!["install-statusline"],
        vec!["install-statusline"],
    ] {
        let o = engine_shadowed(home.path(), cwd.path(), None, &[], &args)?;
        assert!(o.code == 0, "{args:?}: {} {}", o.stdout, o.stderr);
        assert!(wait_shadow_done(&state), "the comparison finished: {args:?}");
        let left = shadow_dirs(&state);
        assert!(left.is_empty(), "{args:?}: Node agreed, so nothing is kept: {left:?}");
    }
    // a Node that answers differently leaves a report; it ran in the scratch home and the scratch working directory
    let fake = home.path().join("fake-node.sh");
    fs::write(&fake, "#!/bin/sh\necho \"$HOME|$(pwd)\" >> \"$AH_FAKE_LOG\"\necho different\n")?;
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755))?;
    let before_cwd = snapshot(cwd.path())?;
    let o = engine_shadowed(home.path(), cwd.path(), Some(&fake), &[("AH_FAKE_LOG", &log)], &["install-statusline", "--project"])?;
    assert_eq!(o.code, 0);
    assert!(wait_shadow_done(&state), "the second comparison finished");
    let reports: Vec<_> = shadow_dirs(&state).into_iter().filter(|d| d.join("mismatch.txt").exists()).collect();
    assert_eq!(reports.len(), 1, "one mismatch report");
    assert!(fs::read_to_string(reports[0].join("mismatch.txt"))?.contains("different"), "the report holds Node's output");
    let seen = fs::read_to_string(&log)?;
    let (h, d) = seen.trim().split_once('|').ok_or("no log line")?;
    assert!(h.contains("/shadow/") && d.contains("/shadow/"), "Node ran in scratch directories: {seen}");
    assert_ne!(Path::new(h), home.path());
    assert_ne!(Path::new(d), cwd.path());
    // the real files hold exactly the engine's write: the settings and the ignore file changed once, the engine's way
    let after_cwd = snapshot(cwd.path())?;
    assert_ne!(before_cwd, after_cwd, "the engine wrote the project's local settings");
    assert_eq!(fs::read_to_string(cwd.path().join(".gitignore"))?.matches(".claude/settings.local.json").count(), 1);
    Ok(())
}

#[test]
fn a_deferred_installer_run_leaves_no_shadow_behind() -> R {
    let home = home_with(Some("{bad"), &[])?;
    let state = home.path().join("state");
    let o = engine_shadowed(home.path(), home.path(), None, &[], &["install-statusline"])?;
    assert_eq!(o.code, 75);
    assert!(wait_shadow_done(&state));
    assert!(shadow_dirs(&state).is_empty(), "nothing to compare after a deferral");
    Ok(())
}

#[test]
fn zz_report_the_case_count() {
    eprintln!("operator parity cases run in this process: {}", CASES.load(Ordering::SeqCst));
}
