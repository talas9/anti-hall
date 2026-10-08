//! Node-vs-engine parity of the operator helper commands (D81): `jev-setup`, `capability-scan`, `harvest` and `briefing`.
//!
//! The real Node script and the engine command run on identical seeded inputs and are compared on everything they leave
//! behind: stdout and stderr byte for byte, the exit code, and the home directory tree (every file's path, mode and
//! content). Nothing touches the real home: each side gets its own scratch home with `HOME` pointed at it, an otherwise
//! empty environment, `ANTIHALL_INGEST_DRY_RUN=1`, and made-up keys. There is no network: the one test that exercises the
//! credit-balance request points both sides at a loopback server through the loopback-only test endpoint override.
//!
//! Clock fields are masked (`fetchedAt`, `ms`, the `.corrupt-<ms>` suffix), because the two runs cannot share a clock.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type R<T = ()> = Result<T, Box<dyn Error>>;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// A scratch directory removed when the test ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> R<Scratch> {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ah-setup-parity-{}-{n}-{tag}", std::process::id()));
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        fs::create_dir_all(&dir)?;
        Ok(Scratch(dir))
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
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins").join("anti-hall")
}

/// What one process printed and returned.
#[derive(Debug, PartialEq, Eq)]
struct Out {
    stdout: String,
    stderr: String,
    code: i32,
}

fn run(mut cmd: Command, home: &Path, cwd: &Path, extra: &[(String, String)], stdin: &str) -> R<Out> {
    cmd.env_clear()
        .env("PATH", std::env::var("PATH")?)
        .env("HOME", home)
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
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
    // a process that ends without reading its stdin closes the pipe (a broken pipe), which is not a test failure
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

/// Assert that two texts are equal, naming the first line that differs instead of printing both whole.
fn assert_text(name: &str, what: &str, node: &str, engine: &str) {
    if node == engine {
        return;
    }
    let (n, e): (Vec<&str>, Vec<&str>) = (node.split('\n').collect(), engine.split('\n').collect());
    let at = n.iter().zip(&e).position(|(a, b)| a != b).unwrap_or(n.len().min(e.len()));
    panic!(
        "{name}: {what} differs at line {}\n  node:   {:?}\n  engine: {:?}\n  (node has {} lines, engine {})",
        at + 1,
        n.get(at).unwrap_or(&"<end>"),
        e.get(at).unwrap_or(&"<end>"),
        n.len(),
        e.len()
    );
}

/// Assert that two runs printed the same thing and returned the same code.
fn assert_out(name: &str, node: &Out, engine: &Out) {
    assert_text(name, "stdout", &node.stdout, &engine.stdout);
    assert_text(name, "stderr", &node.stderr, &engine.stderr);
    assert_eq!(node.code, engine.code, "{name}: exit code");
}

fn node(script: &Path, args: &[&str]) -> Command {
    let mut c = Command::new("node");
    c.arg(script).args(args);
    c
}

fn engine(sub: &str, args: &[&str]) -> Command {
    let mut c = Command::new(BIN);
    c.arg(sub).args(args);
    c
}

/// Replace the digits after every `marker` with `N`.
fn mask_digits(s: &str, marker: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find(marker) {
        out.push_str(&rest[..i + marker.len()]);
        rest = &rest[i + marker.len()..];
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 {
            out.push('N');
        }
        rest = &rest[digits..];
    }
    out.push_str(rest);
    out
}

/// Every file and directory of a tree with its mode and (masked) content.
fn snapshot(root: &Path) -> R<BTreeMap<String, String>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> R {
        for e in fs::read_dir(dir)? {
            let e = e?;
            let p = e.path();
            let rel = mask_digits(&p.strip_prefix(root)?.to_string_lossy(), ".corrupt-");
            if rel.starts_with(".anti-hall/ah-engine") {
                continue; // the engine's own state (its telemetry records the command): Node has nothing to compare it with
            }
            let meta = fs::symlink_metadata(&p)?;
            let mode = meta.permissions().mode() & 0o777;
            if meta.is_dir() {
                out.insert(format!("{rel}/"), format!("{mode:o}"));
                walk(root, &p, out)?;
            } else {
                let text = String::from_utf8_lossy(&fs::read(&p)?).into_owned();
                let text = mask_digits(&mask_digits(&text, "\"fetchedAt\":"), "\"ms\":");
                out.insert(rel, format!("{mode:o}\n{text}"));
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out)?;
    drop_empty_state_parent(&mut out);
    Ok(out)
}

/// The engine's own state dir is skipped by the walk; the `.anti-hall/` directory that only it created goes with it.
fn drop_empty_state_parent<V>(out: &mut BTreeMap<String, V>) {
    if !out.keys().any(|k| k.starts_with(".anti-hall/") && k != ".anti-hall/") {
        out.remove(".anti-hall/");
    }
}

/// Assert that two tree snapshots are equal, naming the first path that differs.
fn assert_tree(name: &str, what: &str, node: &BTreeMap<String, String>, engine: &BTreeMap<String, String>) {
    for (k, v) in node {
        assert_eq!(engine.get(k), Some(v), "{name}: {what}: {k}");
    }
    for k in engine.keys() {
        assert!(node.contains_key(k), "{name}: {what}: {k} exists only in the engine's tree");
    }
}

fn write(root: &Path, rel: &str, content: &str) -> R {
    let p = root.join(rel);
    if let Some(d) = p.parent() {
        fs::create_dir_all(d)?;
    }
    fs::write(p, content)?;
    Ok(())
}

fn envs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

// ---- jev-setup --------------------------------------------------------------------------------------------------------

/// One scenario: files to seed under the home, stdin, arguments and environment.
struct Case {
    name: &'static str,
    seed: Vec<(&'static str, String)>,
    stdin: &'static str,
    args: Vec<&'static str>,
    env: Vec<(&'static str, &'static str)>,
}

fn case(name: &'static str, seed: Vec<(&'static str, &str)>, args: Vec<&'static str>) -> Case {
    Case { name, seed: seed.into_iter().map(|(p, c)| (p, c.to_string())).collect(), stdin: "", args, env: Vec::new() }
}

fn script(name: &str) -> PathBuf {
    plugin_src().join("scripts").join(name)
}

/// Run Node's jev-setup and the engine's on identical homes; return the outputs after asserting that they are equal.
fn jev_setup_same(c: &Case) -> R<Out> {
    let (nh, rh) = (Scratch::new("jn")?, Scratch::new("jr")?);
    let (ncwd, rcwd) = (Scratch::new("jnc")?, Scratch::new("jrc")?);
    for h in [nh.path(), rh.path()] {
        for (p, content) in &c.seed {
            write(h, p, content)?;
        }
    }
    let extra = envs(&c.env);
    let n = run(node(&script("jev-setup.js"), &c.args), nh.path(), ncwd.path(), &extra, c.stdin)?;
    let mut args = vec![c.args[0]];
    args.extend(&c.args[1..]);
    let r = run(engine("jev-setup", &args), rh.path(), rcwd.path(), &extra, c.stdin)?;
    assert_out(c.name, &n, &r);
    assert_tree(c.name, "home tree", &snapshot(nh.path())?, &snapshot(rh.path())?);
    Ok(r)
}

fn settings_enabled() -> &'static str {
    r#"{"jev":{"enabled":true}}"#
}

#[test]
fn status_agrees_with_node_across_configurations() -> R {
    let now = ah_engine::checks::jsport::date::now_ms();
    let iso = |ago_ms: f64| ah_engine::checks::jsport::date::to_iso(now - ago_ms).ok_or("iso");
    let log_main = format!(
        "{}\n{}\n{}\nnot json\n{}\n{}\n",
        format_args!(r#"{{"ts":"{}","id":"claimLedger","hash":"h1"}}"#, iso(1000.0)?),
        format_args!(r#"{{"ts":"{}","id":"speculation","type":"outcome"}}"#, iso(2000.0)?),
        format_args!(r#"{{"ts":"{}","id":"triage"}}"#, iso(2.0 * 86_400_000.0)?),
        format_args!(r#"{{"ts":"{}"}}"#, iso(5.0)?),
        format_args!(r#"{{"ts":"{}","id":7}}"#, iso(60_000.0)?),
    );
    let log_rot = format!("{}\n", format_args!(r#"{{"ts":"{}","id":"modelRouting"}}"#, iso(3_600_000.0)?));
    let cases = vec![
        case("empty home", vec![], vec!["status"]),
        case("enabled in settings, vercel, no key", vec![(".anti-hall/settings.json", settings_enabled())], vec!["status"]),
        case(
            "legacy jev.json only",
            vec![(
                ".anti-hall/jev.json",
                r#"{"enabled":true,"transport":"typesafe","keyFile":"~/k","integrations":{"triage":"off","zzz":"on","yyy":"bogus"},"other":1.0}"#,
            )],
            vec!["status"],
        ),
        case(
            "settings.json outranks a disagreeing jev.json",
            vec![
                (".anti-hall/jev.json", r#"{"enabled":true,"transport":"typesafe","fallbackTransport":"vercel"}"#),
                (".anti-hall/settings.json", r#"{"jev":{"transport":"vercel","enabled":false}}"#),
            ],
            vec!["status"],
        ),
        case(
            "a fallback that equals the primary",
            vec![(".anti-hall/settings.json", r#"{"jev":{"transport":"typesafe","fallbackTransport":"typesafe"}}"#)],
            vec!["status"],
        ),
        case(
            "typesafe primary with a vercel fallback",
            vec![(".anti-hall/settings.json", r#"{"jev":{"enabled":true,"transport":"typesafe","fallbackTransport":"vercel"}}"#)],
            vec!["status"],
        ),
        case(
            "decision log counts the last day only",
            vec![(".anti-hall/logs/jev-assist.ndjson", log_main.as_str()), (".anti-hall/logs/jev-assist.ndjson.1", log_rot.as_str())],
            vec!["status"],
        ),
        case(
            "integration modes from settings and the kill switch",
            vec![(".anti-hall/settings.json", r#"{"jevIntegrations":{"newRequest":"on","claimLedger":"off","dispatchTier":"shadow"}}"#)],
            vec!["status"],
        ),
        case("a legacy key file is reported but not read", vec![(".config/vercel/ai-gateway-key", "k1\n")], vec!["status"]),
        case(
            "a key file that is refused is explained",
            vec![(".anti-hall/settings.json", r#"{"jev":{"enabled":true,"allowLegacyKeyRead":true}}"#), (".config/vercel/ai-gateway-key", "two words\n")],
            vec!["status"],
        ),
        case(
            "an empty key file under the opt-in",
            vec![(".anti-hall/settings.json", r#"{"jev":{"allowLegacyKeyRead":true}}"#), (".config/vercel/ai-gateway-key", "\n")],
            vec!["status"],
        ),
        case("a corrupt settings.json is read as empty", vec![(".anti-hall/settings.json", "{broken")], vec!["status"]),
    ];
    for c in &cases {
        jev_setup_same(c)?;
    }
    Ok(())
}

#[test]
fn status_agrees_with_node_under_environment_overrides() -> R {
    let mk = |name: &'static str, seed: Vec<(&'static str, &str)>, env: Vec<(&'static str, &'static str)>| {
        let mut c = case(name, seed, vec!["status"]);
        c.env = env;
        c
    };
    let cases = vec![
        mk("ANTIHALL_JEV=1 enables", vec![(".anti-hall/jev.json", r#"{"enabled":false,"transport":"typesafe"}"#)], vec![("ANTIHALL_JEV", "1")]),
        mk("ANTIHALL_JEV=0 wins over the file", vec![(".anti-hall/settings.json", settings_enabled())], vec![("ANTIHALL_JEV", "0")]),
        mk("a vendor key in the environment", vec![], vec![("CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY", "ts-key")]),
        mk(
            "a generic key bound to the default vendor and a typesafe primary",
            vec![(".anti-hall/settings.json", r#"{"jev":{"transport":"typesafe"}}"#)],
            vec![("CLAUDE_PLUGIN_OPTION_JEV_API_KEY", "generic")],
        ),
        mk(
            "a generic key re-bound to typesafe, with a vercel fallback",
            vec![(".anti-hall/settings.json", r#"{"jev":{"transport":"typesafe","fallbackTransport":"vercel","genericKeyVendor":"typesafe"}}"#)],
            vec![("CLAUDE_PLUGIN_OPTION_JEV_API_KEY", "generic")],
        ),
        mk("the per-integration kill switch", vec![], vec![("ANTIHALL_JEV_TRIAGE", "0"), ("ANTIHALL_JEV_NEW_REQUEST", "0")]),
        mk("a plugin option for the transport", vec![], vec![("CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT", "typesafe")]),
        mk("the environment outranks a legacy value", vec![(".anti-hall/jev.json", r#"{"enabled":true}"#)], vec![("ANTIHALL_JEV", "off")]),
        mk("legacy key env var is reported while the opt-in is off", vec![], vec![("AI_GATEWAY_API_KEY", "legacy-env-key")]),
        mk(
            "a refused key file with Jev on says so on stderr and asks for no balance",
            vec![(".anti-hall/settings.json", r#"{"jev":{"enabled":true,"allowLegacyKeyRead":true}}"#), (".config/vercel/ai-gateway-key", "two words\n")],
            vec![],
        ),
        mk(
            "a generic key bound elsewhere, Jev on: the diagnostic goes to stderr",
            vec![(".anti-hall/settings.json", r#"{"jev":{"enabled":true,"transport":"vercel","genericKeyVendor":"typesafe"}}"#)],
            vec![("CLAUDE_PLUGIN_OPTION_JEV_API_KEY", "generic")],
        ),
    ];
    for c in &cases {
        jev_setup_same(c)?;
    }
    Ok(())
}

#[test]
fn configuration_verbs_leave_the_same_files_as_node() -> R {
    let with_stdin = |name: &'static str, seed: Vec<(&'static str, &str)>, stdin: &'static str, args: Vec<&'static str>| {
        let mut c = case(name, seed, args);
        c.stdin = stdin;
        c
    };
    let existing = r#"{"a":{"x":1},"jev":{"zzz":2.50,"transport":"vercel"},"9":1}"#;
    let cases = vec![
        case("enable on an empty home", vec![], vec!["enable"]),
        case("enable with a transport and a fallback", vec![], vec!["enable", "--transport", "typesafe", "--fallback", "vercel"]),
        case("enable keeps unknown settings in place", vec![(".anti-hall/settings.json", existing)], vec!["enable", "--transport", "typesafe"]),
        case("enable with a fallback of none", vec![], vec!["enable", "--fallback", "none"]),
        case("enable with a fallback that equals the primary", vec![], vec!["enable", "--transport", "vercel", "--fallback", "vercel"]),
        case("enable with a bad transport", vec![], vec!["enable", "--transport", "nope"]),
        case("enable with a bad fallback", vec![], vec!["enable", "--fallback", "nope"]),
        case("enable with the option name last", vec![], vec!["enable", "--fallback"]),
        case("enable warns when the chosen vendor has no key and the generic key is bound elsewhere", vec![], vec!["enable", "--transport", "typesafe"]),
        case("disable", vec![(".anti-hall/settings.json", settings_enabled())], vec!["disable"]),
        case("bind the generic key", vec![], vec!["bind-generic-key", "--vendor", "typesafe"]),
        case("bind without a vendor", vec![], vec!["bind-generic-key"]),
        case("bind with a bad vendor", vec![], vec!["bind-generic-key", "--vendor", "x"]),
        case("a settings.json that is not an object is set aside", vec![(".anti-hall/settings.json", "[1]")], vec!["bind-generic-key", "--vendor", "typesafe"]),
        case("a corrupt settings.json is set aside", vec![(".anti-hall/settings.json", "{broken")], vec!["enable"]),
        case("mode on a known integration writes both stores", vec![], vec!["mode", "newRequest", "on"]),
        case("mode on an unknown integration writes jev.json only", vec![], vec!["mode", "custom-x", "shadow"]),
        case(
            "mode keeps the other legacy fields and order",
            vec![(".anti-hall/jev.json", r#"{"enabled":true,"integrations":{"triage":"off","zzz":"on"},"other":1.0}"#)],
            vec!["mode", "speculation", "shadow"],
        ),
        case("mode with a bad value", vec![], vec!["mode", "bad", "x"]),
        case("mode with no value", vec![], vec!["mode", "newRequest"]),
        case("mode with an integer-like integration id", vec![(".anti-hall/jev.json", r#"{"integrations":{"b":"on"}}"#)], vec!["mode", "5", "off"]),
        with_stdin("set-key for the default vendor", vec![], "sk-test-123\n", vec!["set-key"]),
        with_stdin("set-key with surrounding white space", vec![], "  sk-test-123  \n\n", vec!["set-key"]),
        with_stdin("set-key for typesafe", vec![], "sk-test", vec!["set-key", "--transport", "typesafe"]),
        with_stdin(
            "set-key for the fallback",
            vec![(".anti-hall/settings.json", r#"{"jev":{"transport":"typesafe","fallbackTransport":"vercel"}}"#)],
            "fb-key",
            vec!["set-key", "--role", "fallback"],
        ),
        with_stdin("set-key for the fallback when none is set", vec![], "fb-key", vec!["set-key", "--role", "fallback"]),
        with_stdin("set-key with a bad role", vec![], "k", vec!["set-key", "--role", "primary"]),
        with_stdin("set-key with a bad transport", vec![], "k", vec!["set-key", "--transport", "x"]),
        with_stdin("set-key with nothing on stdin", vec![], "", vec!["set-key"]),
        with_stdin("set-key with a control character", vec![], "ab\u{1}cd", vec!["set-key"]),
        with_stdin(
            "set-key honours an explicit key file for the bound vendor",
            vec![(".anti-hall/settings.json", r#"{"jev":{"keyFile":"~/.anti-hall/custom-key"}}"#)],
            "k-explicit",
            vec!["set-key"],
        ),
        with_stdin("set-key replaces an existing key file", vec![(".config/vercel/ai-gateway-key", "old\n")], "new-key", vec!["set-key"]),
    ];
    for c in &cases {
        jev_setup_same(c)?;
    }
    Ok(())
}

/// A loopback server that answers every GET with `status` and `body`, remembering the request line and Authorization header.
struct Mock {
    port: u16,
    seen: Arc<Mutex<Vec<(String, String)>>>,
}

impl Mock {
    fn start(status: u16, body: &'static str) -> R<Mock> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut c) = conn else { break };
                if let Some(req) = read_head(&mut c) {
                    s2.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(req);
                }
                let out = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                if c.write_all(out.as_bytes()).is_err() {
                    break;
                }
            }
        });
        Ok(Mock { port, seen })
    }
}

fn read_head(s: &mut TcpStream) -> Option<(String, String)> {
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = s.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf).into_owned();
    let mut lines = head.split("\r\n");
    let line = lines.next()?.to_string();
    let auth = lines.find(|l| l.to_ascii_lowercase().starts_with("authorization:")).unwrap_or("").to_ascii_lowercase();
    Some((line, auth))
}

fn credit_case(body: &'static str, status: u16) -> R {
    let mock = Mock::start(status, body)?;
    let url = format!("http://127.0.0.1:{}/v1/credits", mock.port);
    let mut c = case("credit balance over loopback", vec![(".anti-hall/settings.json", settings_enabled())], vec!["status"]);
    c.env = vec![("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "test-key-only"), ("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", Box::leak(url.into_boxed_str()))];
    let out = jev_setup_same(&c)?;
    let seen = mock.seen.lock().map_err(|_| "mock lock")?.clone();
    assert_eq!(seen.len(), 2, "one request from each side: {seen:?}");
    assert_eq!(seen[0], seen[1], "both sides send the same request line and Authorization header");
    assert!(seen[0].0.starts_with("GET /v1/credits "), "{:?}", seen[0]);
    assert!(out.stdout.contains("credit balance (vercel)"), "{}", out.stdout);
    Ok(())
}

#[test]
fn the_credit_balance_request_and_its_cache_match_node() -> R {
    credit_case(r#"{"balance":"5.5","total_used":1.25}"#, 200)?;
    credit_case(r#"{"balance":0.125}"#, 200)?;
    credit_case(r#"{"nothing":1}"#, 200)?;
    credit_case("not json", 200)?;
    credit_case("{}", 500)?;
    Ok(())
}

#[test]
fn a_fresh_credit_cache_is_served_without_a_request() -> R {
    let now = ah_engine::checks::jsport::date::now_ms() as u64;
    let fresh = format!(r#"{{"fetchedAt":{now},"vendor":"vercel","result":{{"ok":true,"vendor":"vercel","balanceUsd":12.345,"ms":3}}}}"#);
    let stale = format!(r#"{{"fetchedAt":{},"vendor":"vercel","result":{{"ok":true,"balanceUsd":1}}}}"#, now - 3_600_000);
    let other = format!(r#"{{"fetchedAt":{now},"vendor":"typesafe","result":{{"ok":true,"balanceUsd":1}}}}"#);
    let failed = format!(r#"{{"fetchedAt":{now},"vendor":"vercel","result":{{"ok":false,"reason":"timeout"}}}}"#);
    for (name, body, key) in [("fresh", fresh, true), ("failed", failed, true), ("other vendor", other, false), ("stale", stale, false)] {
        // without a key the stale and other-vendor entries end in "no key" and no request is made
        let mut c =
            case("cached credit", vec![(".anti-hall/settings.json", settings_enabled()), (".anti-hall/cache/jev-credits.json", body.as_str())], vec!["status"]);
        c.name = name;
        if key {
            c.env = vec![("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "test-key-only")];
        }
        jev_setup_same(&c)?;
    }
    Ok(())
}

// ---- capability-scan ----------------------------------------------------------------------------------------------------

/// A copy of the real plugin tree, so that Node's script (which finds its root from its own location) and the engine read
/// the same files while the fixture adds its own. Copies, not links: a write into the fixture must never reach the source.
fn link_tree(src: &Path, dst: &Path) -> R {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let (from, to) = (e.path(), dst.join(e.file_name()));
        let ft = e.file_type()?;
        if ft.is_dir() {
            link_tree(&from, &to)?;
        } else if ft.is_symlink() {
            let target = fs::read_link(&from)?;
            std::os::unix::fs::symlink(target, to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Replace a file of a fixture tree.
fn replace(root: &Path, rel: &str, content: &str) -> R {
    let p = root.join(rel);
    if p.exists() {
        fs::remove_file(&p)?;
    }
    write(root, rel, content)
}

/// A plugin fixture: `<tmp>/plugins/anti-hall` (a linked copy of the real plugin) with `<tmp>/docs` beside the `plugins` dir.
fn plugin_fixture(tag: &str) -> R<(Scratch, PathBuf)> {
    let s = Scratch::new(tag)?;
    let root = s.path().join("plugins").join("anti-hall");
    link_tree(&plugin_src(), &root)?;
    Ok((s, root))
}

fn installer(label: &str, unit: &str) -> String {
    format!("'use strict';\nconst LABEL = '{label}';\nconst UNIT = '{unit}';\nmodule.exports = {{ LABEL, UNIT }};\n")
}

fn capability_same(name: &str, root: &Path, home_seed: &[(&str, &str)], cwd_seed: &[(&str, &str)], json: bool) -> R<Out> {
    let (nh, rh, nc, rc) = (Scratch::new("cn")?, Scratch::new("cr")?, Scratch::new("cnc")?, Scratch::new("crc")?);
    for (h, c) in [(nh.path(), nc.path()), (rh.path(), rc.path())] {
        for (p, content) in home_seed {
            write(h, p, content)?;
        }
        for (p, content) in cwd_seed {
            write(c, p, content)?;
        }
    }
    let flags: &[&str] = if json { &["--json"] } else { &[] };
    let n = run(node(&root.join("scripts").join("capability-scan.js"), flags), nh.path(), nc.path(), &[], "")?;
    let mut args: Vec<&str> = vec!["--root", root.to_str().ok_or("root path")?];
    args.extend(flags);
    let r = run(engine("capability-scan", &args), rh.path(), rc.path(), &[], "")?;
    assert_out(name, &n, &r);
    assert_tree(name, "home tree", &snapshot(nh.path())?, &snapshot(rh.path())?);
    assert_tree(name, "cwd tree", &snapshot(nc.path())?, &snapshot(rc.path())?);
    Ok(r)
}

#[test]
fn capability_scan_agrees_with_node() -> R {
    let (_keep, root) = plugin_fixture("cap")?;
    replace(&root, "companion/install-zz-extra.js", &installer("com.anti-hall.zz", "anti-hall-zz"))?;
    replace(&root, "companion/install-Alpha.js", &installer("com.anti-hall.alpha", "anti-hall-alpha"))?;
    replace(&root, "companion/not-an-installer.js", &installer("x", "y"))?;
    let plist = "<plist/>";
    let home_all: &[(&str, &str)] = &[
        ("Library/LaunchAgents/com.anti-hall.zz.plist", plist),
        ("Library/LaunchAgents/com.anti-hall.devswarm-ingest.0123abcd.plist", plist),
        ("Library/LaunchAgents/com.anti-hall.devswarm-ingest.not-valid.plist", plist),
        (".config/systemd/user/anti-hall-zz.timer", ""),
        (".config/systemd/user/anti-hall-devswarm-ingest-0123abcd.service", ""),
        (".config/systemd/user/anti-hall-devswarm-ingest-bogus.service", ""),
        (".config/systemd/user/default.target.wants/anti-hall-alpha.service", ""),
    ];
    capability_same("no home state", &root, &[], &[], false)?;
    capability_same("no home state, json", &root, &[], &[], true)?;
    capability_same("units installed", &root, home_all, &[], false)?;
    capability_same(
        "only the unsuffixed ingest unit",
        &root,
        &[("Library/LaunchAgents/com.anti-hall.devswarm-ingest.plist", plist), (".config/systemd/user/anti-hall-devswarm-ingest.service", "")],
        &[],
        false,
    )?;
    capability_same(
        "only ingest units with a suffix that is neither a hash nor a project key",
        &root,
        &[("Library/LaunchAgents/com.anti-hall.devswarm-ingest.nope.plist", plist), (".config/systemd/user/anti-hall-devswarm-ingest-nope.service", "")],
        &[],
        false,
    )?;
    capability_same(
        "a project-keyed ingest unit",
        &root,
        &[
            ("Library/LaunchAgents/com.anti-hall.devswarm-ingest.my-repo-0a1b2c.plist", plist),
            (".config/systemd/user/anti-hall-devswarm-ingest-my-repo-0a1b2c.service", ""),
        ],
        &[],
        false,
    )?;
    let status = r#"{"statusLine":{"type":"command","command":"node /x/statusline.js"}}"#;
    capability_same("statusline from the user scope", &root, &[(".claude/settings.json", status)], &[], false)?;
    capability_same("statusline from another command", &root, &[(".claude/settings.json", r#"{"statusLine":{"command":"echo hi"}}"#)], &[], false)?;
    capability_same(
        "the project-local scope wins over the user scope",
        &root,
        &[(".claude/settings.json", status)],
        &[(".claude/settings.local.json", r#"{"statusLine":{"command":"other"}}"#)],
        false,
    )?;
    capability_same(
        "a project scope without a command falls through",
        &root,
        &[(".claude/settings.json", status)],
        &[(".claude/settings.json", r#"{"statusLine":{}}"#)],
        false,
    )?;
    capability_same(
        "an array command reads as its joined text",
        &root,
        &[],
        &[(".claude/settings.json", r#"{"statusLine":{"command":["a","statusline.js"]}}"#)],
        false,
    )?;
    capability_same("a legacy progress file with no copy is a pending migration", &root, &[], &[(".anti-hall-progress.md", "# progress\n")], false)?;
    capability_same(
        "an identical copy is not pending",
        &root,
        &[],
        &[(".anti-hall-history.md", "h\n"), (".anti-hall/history/legacy/.anti-hall-history.md", "h\n")],
        false,
    )?;
    capability_same(
        "a different copy is pending",
        &root,
        &[],
        &[(".anti-hall-history.md", "h\n"), (".anti-hall/history/legacy/.anti-hall-history.md", "other\n")],
        false,
    )?;
    Ok(())
}

#[test]
fn capability_scan_compares_legacy_files_as_decoded_text() -> R {
    let (_keep, root) = plugin_fixture("cap2")?;
    // two different invalid bytes both decode to U+FFFD: the same text for Node, so not a pending migration
    let (nc, rc) = (Scratch::new("d1")?, Scratch::new("d2")?);
    for c in [nc.path(), rc.path()] {
        fs::write(c.join(".anti-hall-progress.md"), [b'a', 0xff, b'b'])?;
        fs::create_dir_all(c.join(".anti-hall/history/legacy"))?;
        fs::write(c.join(".anti-hall/history/legacy/.anti-hall-progress.md"), [b'a', 0xfe, b'b'])?;
    }
    let home = Scratch::new("dh")?;
    let n = run(node(&root.join("scripts").join("capability-scan.js"), &["--json"]), home.path(), nc.path(), &[], "")?;
    let r = run(engine("capability-scan", &["--root", root.to_str().ok_or("root")?, "--json"]), home.path(), rc.path(), &[], "")?;
    assert_out("decoded comparison", &n, &r);
    assert!(n.stdout.contains(r#""name":"state-migrations","available":true,"active":true"#), "{}", n.stdout);
    Ok(())
}

// ---- harvest --------------------------------------------------------------------------------------------------------------

fn harvest_same(name: &str, tree: &Path, cwd: &Path, args: &[&str]) -> R<Out> {
    let home = Scratch::new("hh")?;
    let mut a = vec!["--dir", tree.to_str().ok_or("tree path")?];
    a.extend(args);
    let n = run(node(&script("harvest-debt.js"), &a), home.path(), cwd, &[], "")?;
    let r = run(engine("harvest", &a), home.path(), cwd, &[], "")?;
    assert_out(name, &n, &r);
    Ok(r)
}

fn marker_tree(s: &Scratch) -> R<PathBuf> {
    let t = s.path().join("tree");
    write(&t, "a/f.js", "// anti-hall: no cache, when load>10\nx\n# anti-hall: hack\n/* anti-hall: c , d */ y\r\n<!-- anti-hall: a, b --> \n")?;
    write(&t, "b/g.sql", "x -- anti-hall: one, two -- anti-hall: three, four\n")?;
    write(&t, "a/.hidden/h.js", "// anti-hall: skipped\n")?;
    write(&t, "node_modules/m.js", "// anti-hall: skipped\n")?;
    write(&t, "c/crlf.js", "// anti-hall: one, two\r\n// anti-hall: three, four\n")?;
    write(&t, "c/closers.js", "/* anti-hall: only a ceiling */\n<!--anti-hall:  x ,  y  -->\n// anti-hall:\n// anti-hall: ,\n// anti-hall: a,b,c\n")?;
    write(
        &t,
        "c/long-name-that-needs-to-be-cut-down-because-it-is-longer-than-the-column.js",
        "// anti-hall: a very long ceiling that is longer than eighteen, and a very long trigger that goes past twenty four characters\n",
    )?;
    write(
        &t,
        "c/\u{1F600}-emoji-\u{e9}.js",
        "// anti-hall: \u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}, \u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\n",
    )?;
    write(&t, "c/binary.bin", "// anti-hall: nope\n\u{0}\n")?;
    fs::write(t.join("c/invalid.js"), b"// anti-hall: caf\xe9, bad \xff byte\n")?;
    write(&t, "c/empty.js", "")?;
    Ok(t)
}

#[test]
fn harvest_agrees_with_node_in_text_and_json() -> R {
    let s = Scratch::new("hv")?;
    let tree = marker_tree(&s)?;
    let cwd = Scratch::new("hvc")?;
    harvest_same("text", &tree, cwd.path(), &[])?;
    harvest_same("json", &tree, cwd.path(), &["--json"])?;
    harvest_same("stale days", &tree, cwd.path(), &["--stale-days", "3"])?;
    harvest_same("stale days zero falls back", &tree, cwd.path(), &["--stale-days", "0", "--json"])?;
    harvest_same("stale days junk", &tree, cwd.path(), &["--stale-days", "junk"])?;
    let empty = s.path().join("empty-tree");
    fs::create_dir_all(&empty)?;
    let out = harvest_same("no markers", &empty, cwd.path(), &[])?;
    assert_eq!(out.stdout, "No anti-hall debt markers found.\n");
    harvest_same("no markers, json", &empty, cwd.path(), &["--json"])?;
    harvest_same("a single file as the root", &tree.join("b/g.sql"), cwd.path(), &[])?;
    Ok(())
}

#[test]
fn harvest_flags_files_git_says_are_old() -> R {
    let s = Scratch::new("hg")?;
    let repo = s.path().join("repo");
    write(&repo, "old.js", "// anti-hall: old, someday\n")?;
    write(&repo, "new.js", "// anti-hall: new, someday\n")?;
    let git = |args: &[&str], date: Option<&str>| -> R {
        let mut cmd = Command::new("git");
        cmd.args(args)
            .current_dir(&repo)
            .env_clear()
            .env("PATH", std::env::var("PATH")?)
            .env("HOME", s.path())
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(d) = date {
            cmd.env("GIT_AUTHOR_DATE", d).env("GIT_COMMITTER_DATE", d);
        }
        let out = cmd.output()?;
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        Ok(())
    };
    let old = Some("2020-01-01T00:00:00+0000");
    git(&["init", "-q"], old)?;
    git(&["add", "old.js"], old)?;
    git(&["commit", "-q", "-m", "old"], old)?;
    git(&["add", "new.js"], None)?;
    git(&["commit", "-q", "-m", "new"], None)?;
    let out = harvest_same("git ages", &repo, &repo, &["--json"])?;
    assert!(out.stdout.contains("file not touched in >90 days"), "{}", out.stdout);
    harvest_same("git ages, text", &repo, &repo, &[])?;
    harvest_same("git ages, narrow window", &repo, &repo, &["--stale-days", "1"])?;
    Ok(())
}

// ---- briefing -------------------------------------------------------------------------------------------------------------

fn briefing_same(name: &str, root: &Path, cwd: &Path, json: bool) -> R<Out> {
    let home = Scratch::new("bh")?;
    let flags: &[&str] = if json { &["--json"] } else { &[] };
    let n = run(node(&root.join("scripts").join("briefing.js"), flags), home.path(), cwd, &[], "")?;
    let mut a = vec!["--root", root.to_str().ok_or("root")?];
    a.extend(flags);
    let r = run(engine("briefing", &a), home.path(), cwd, &[], "")?;
    assert_out(name, &n, &r);
    Ok(r)
}

#[test]
fn briefing_of_the_real_plugin_tree_agrees_with_node() -> R {
    let cwd = Scratch::new("brc")?;
    let root = plugin_src().canonicalize()?;
    let t = briefing_same("real tree, text", &root, cwd.path(), false)?;
    assert!(t.stdout.starts_with("anti-hall system briefing v"), "{}", t.stdout.lines().next().unwrap_or(""));
    briefing_same("real tree, json", &root, cwd.path(), true)?;
    Ok(())
}

#[test]
fn briefing_header_and_frontmatter_scans_agree_with_node() -> R {
    let (s, root) = plugin_fixture("br")?;
    let cwd = Scratch::new("brc2")?;
    let hooks: &[(&str, &str)] = &[
        ("hooks/zz-plain.js", "'use strict';\n// anti-hall :: zz-plain \u{2014} does the plain thing\nconst x = 1;\n"),
        ("hooks/zz-bare.js", "#!/usr/bin/env node\n'use strict';\n// zz-bare.js\n//\n// ======\n// ALLCAPS SECTION\n// The real prose of the bare header.\n"),
        ("hooks/zz-scope.js", "// zz-scope \u{2014} (PreToolUse, matcher Bash)\n//\n// Scoped prose here.\n"),
        ("hooks/zz-noheader.js", "const a = 1;\n// late comment\n"),
        ("hooks/zz-empty.js", ""),
        ("hooks/zz-crlf.js", "// anti-hall :: zz-crlf \u{2014} crlf header\r\n// second line\r\nconst a = 1;\r\n"),
        ("hooks/zz-long.js", &format!("// zz-long \u{2014} {}\n", "long words ".repeat(40))),
        ("hooks/zz-enc.js", "// zz-enc.js \u{2013} en dash and \u{1F600} emoji, tabs\tand  spaces\n"),
        ("hooks/zz-use.js", "\"use strict\"\n// zz-use: colon after the name\n"),
        ("hooks/zz-unreg.js", "// An unregistered helper.\n"),
        ("hooks/lib/zz-lib.js", "// lib helper \u{2014} shared\n"),
    ];
    for (p, c) in hooks {
        write(&root, p, c)?;
    }
    replace(
        &root,
        "hooks/hooks.registry.json",
        r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node \"${CLAUDE_PLUGIN_ROOT}/hooks/zz-plain.js\""},{"command":"no js here"},{"command":"sh \"${CLAUDE_PLUGIN_ROOT}/hooks/zz-bare.js\" --x"}]}],
"PreToolUse":[{"matcher":"Bash|Edit","hooks":[{"command":"node a/zz-scope.js"},{"command":"node a/zz-noheader.js"},{"command":"node a/zz-empty.js"},{"command":"node a/zz-missing.js"}]},{"matcher":"","hooks":[{"command":"x zz-crlf.js"},{"command":"zz-long.js"},{"command":"zz-enc.js"},{"command":"zz-use.js"}]}],
"Stop":"not an array","Odd":[{"hooks":"nope"}]}}"#,
    )?;
    let skills: &[(&str, &str)] = &[
        ("skills/zz-quoted/SKILL.md", "---\nname: zz-quoted\ndescription: \"A \\\"quoted\\\" description\\nwith an escape\"\n---\nbody\n"),
        ("skills/zz-plain/SKILL.md", "---\nname: zz-plain\ndescription: Plain description with   extra   spaces\n---\n"),
        ("skills/zz-long/SKILL.md", &format!("---\nname: zz-long\ndescription: {}\n---\n", "word ".repeat(80))),
        ("skills/zz-crlf/SKILL.md", "---\r\nname: zz-crlf\r\ndescription: crlf description\r\n---\r\nbody\r\n"),
        ("skills/zz-nofront/SKILL.md", "no frontmatter here\nname: ignored\n"),
        ("skills/zz-blank-name/SKILL.md", "---\nname:\n\ndescription: after a blank name\n---\n"),
        ("skills/zz-bad-quote/SKILL.md", "---\nname: zz-bad-quote\ndescription: \"unterminated\n---\n"),
        ("skills/zz-unicode/SKILL.md", "---\nname: zz-unicode\ndescription: caf\u{e9} \u{1F600} \u{2014} dash\n---\n"),
        ("skills/zz-empty-file/SKILL.md", ""),
        ("skills/zz-not-a-skill/README.md", "x\n"),
    ];
    for (p, c) in skills {
        write(&root, p, c)?;
    }
    let docs = s.path().join("docs");
    write(&docs, "KB-one.md", "# First KB \u{2014} title\n\ntext\n")?;
    write(&docs, "KB-two.md", "intro\n#   Spaced   heading  \n")?;
    write(&docs, "KB-three.md", "no heading at all\n")?;
    write(&docs, "KB-four.md", "#\nnext line heading\n")?;
    write(&docs, "KB-five.md", &format!("# {}\n", "h".repeat(300)))?;
    write(&docs, "README.md", "# not a KB\n")?;
    write(&docs, "KB-six.txt", "# wrong extension\n")?;
    briefing_same("fixture, text", &root, cwd.path(), false)?;
    briefing_same("fixture, json", &root, cwd.path(), true)?;
    // devswarm substrate pieces and a plugin.json without a version
    replace(
        &root,
        "scripts/devswarm.js",
        "#!/usr/bin/env node\n// devswarm \u{2014} the cli\n//\n// SUBCOMMANDS\n//   list   all\n//   sync- x\n//    four spaces\n//   list again\n//   status-now  thing\n// not a subcommand\n//   after\n",
    )?;
    replace(&root, ".claude-plugin/plugin.json", r#"{"name":"x"}"#)?;
    briefing_same("no version, with a devswarm cli", &root, cwd.path(), false)?;
    briefing_same("no version, with a devswarm cli, json", &root, cwd.path(), true)?;
    replace(&root, ".claude-plugin/plugin.json", "{broken")?;
    briefing_same("broken plugin.json", &root, cwd.path(), true)?;
    fs::remove_dir_all(&docs)?;
    briefing_same("no docs directory", &root, cwd.path(), false)?;
    briefing_same("no docs directory, json", &root, cwd.path(), true)?;
    Ok(())
}
