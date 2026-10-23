//! The Node backup end to end (owner decision 2026-10-22): stage 1, the shadow (the engine's verdict and latency are unchanged, both
//! sides write ledger rows, `shadow-compare` reports a seeded disagreement, the end date and the load/CPU gates switch it off and
//! are counted), and stage 2, the fallback switch (`ah-engine fallback`, and the shell wrapper running the original Node hooks).
//! Every run has its own HOME and state directory; the real plugin's Node hooks are the ones shadowed.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall").canonicalize().unwrap()
}

struct Env {
    dir: PathBuf,
    plugin: PathBuf,
}

impl Env {
    fn new(name: &str, config: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ahd-nb-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::create_dir_all(dir.join("state")).unwrap();
        std::fs::write(dir.join("state/config.toml"), config).unwrap();
        Env { plugin: plugin(), dir }
    }

    /// An environment whose plugin is a copy WITHOUT the Node backup directory (the published plugin alone, as the directory ships it).
    fn without_node(name: &str, config: &str) -> Env {
        let mut e = Env::new(name, config);
        let root = e.dir.join("pub");
        std::fs::create_dir_all(&root).unwrap();
        let copied = Command::new("cp").arg("-R").arg(plugin()).arg(root.join("anti-hall")).status().unwrap();
        assert!(copied.success());
        e.plugin = root.join("anti-hall");
        e
    }

    fn state(&self) -> PathBuf {
        self.dir.join("state")
    }

    fn cmd(&self, bin: &Path) -> Command {
        let mut c = Command::new(bin);
        c.env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "nodeback-e2e")
            .env("AH_ENGINE_PLUGIN_ROOT", &self.plugin)
            .env("CLAUDE_PLUGIN_ROOT", &self.plugin)
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("ANTIHALL_PROCWATCH", "0")
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }

    fn run(&self, c: &mut Command, payload: &str) -> (i32, String, String, Duration) {
        let t = Instant::now();
        let mut ch = c.spawn().unwrap();
        if let Some(mut s) = ch.stdin.take() {
            ah_engine::discard::harmless(s.write_all(payload.as_bytes()));
        }
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into(), String::from_utf8_lossy(&o.stderr).into(), t.elapsed())
    }

    fn engine(&self, args: &[&str], payload: &str) -> (i32, String, String, Duration) {
        let mut c = self.cmd(Path::new(env!("CARGO_BIN_EXE_ah-engine")));
        c.args(args);
        self.run(&mut c, payload)
    }

    fn payload(&self, command: &str) -> String {
        serde_json::json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command}, "cwd": self.dir, "session_id": "nb-e2e"})
            .to_string()
    }

    fn ledger(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(self.state().join("shadow.ndjson")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    /// Wait until the ledger holds `n` rows (the detached run is asynchronous).
    fn wait_ledger(&self, n: usize) -> Vec<serde_json::Value> {
        let end = Instant::now() + Duration::from_secs(60);
        loop {
            let rows = self.ledger();
            if rows.len() >= n || Instant::now() > end {
                return rows;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn counters(&self) -> String {
        std::fs::read_to_string(self.state().join("obs-counters.log")).unwrap_or_default()
    }
}

const ON: &str = "[nodeback]\nshadow_mode = \"all\"\nshadow_load_max_pct = 0\nshadow_end_date = \"2999-01-01\"\n";
const FORCE: &str = "git push --force origin main";

fn row<'a>(rows: &'a [serde_json::Value], src: &str, chk: &str) -> Option<&'a serde_json::Value> {
    rows.iter().find(|r| r["src"] == src && r["chk"] == chk)
}

#[test]
fn shadow_on_keeps_the_engine_verdict_and_latency_and_records_both_sides() {
    let off = Env::new("off", "[nodeback]\nshadow_mode = \"off\"\n");
    let on = Env::new("on", ON);
    let p = off.payload(FORCE);
    let args = ["hook", "--event", "PreToolUse", "--tool", "Bash"];
    // warm both (first run builds caches), then take the best of three of each
    off.engine(&args, &p);
    on.engine(&args, &p);
    let best = |e: &Env| (0..3).map(|_| e.engine(&args, &p)).min_by_key(|r| r.3).unwrap();
    let (c_off, o_off, e_off, t_off) = best(&off);
    let (c_on, o_on, e_on, t_on) = best(&on);
    assert_eq!(c_off, 2, "the engine blocks a force push: {e_off}");
    assert_eq!((c_on, &o_on, &e_on), (c_off, &o_off, &e_off), "shadow on changes nothing the host sees");
    assert!(t_on < t_off + Duration::from_millis(250), "shadow on must not delay the hook: on {t_on:?} vs off {t_off:?}");
    assert!(off.ledger().is_empty(), "shadow off writes no ledger row");

    let rows = on.wait_ledger(2);
    let (e, n) = (row(&rows, "engine", "git-guard"), row(&rows, "node", "git-guard"));
    assert_eq!(e.map(|r| r["v"].clone()), Some("block".into()), "engine row: {rows:?}");
    assert_eq!(n.map(|r| r["v"].clone()), Some("block".into()), "node row: {rows:?}");
    assert_eq!(e.unwrap()["inv"], n.unwrap()["inv"], "both sides carry the same call id");

    let (code, out, _, _) = on.engine(&["shadow-compare", "--json"], "");
    assert_eq!(code, 0);
    let rep: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(rep["checks"]["git-guard"]["agree"].as_u64().unwrap() >= 1, "{rep}");
    assert_eq!(rep["total"]["engine_weaker"], 0, "{rep}");
}

#[test]
fn shadow_compare_reports_a_seeded_disagreement() {
    let e = Env::new("seed", ON);
    let mk = |inv: &str, src: &str, chk: &str, v: &str| {
        serde_json::json!({"ts": ah_engine::health::now_ms(), "inv": inv, "src": src, "host": "claude", "ev": "PreToolUse", "tool": "Bash", "chk": chk, "v": v, "ms": 3, "err": ""}).to_string()
    };
    let lines = [
        mk("a", "engine", "same", "allow"),
        mk("a", "node", "same", "allow"),
        mk("b", "engine", "weak", "allow"),
        mk("b", "node", "weak", "block"),
        mk("c", "engine", "strict", "block"),
        mk("c", "node", "strict", "advise"),
        mk("d", "engine", "nerr", "allow"),
        mk("d", "node", "nerr", "timeout"),
        mk("e", "engine", "lonely", "allow"),
    ];
    std::fs::write(e.state().join("shadow.ndjson"), lines.join("\n") + "\n").unwrap();
    let (_, out, _, _) = e.engine(&["shadow-compare", "--json"], "");
    let rep: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(rep["total"]["n"], 4, "{rep}");
    assert_eq!(rep["checks"]["same"]["agree"], 1);
    assert_eq!(rep["checks"]["weak"]["engine_weaker"], 1);
    assert_eq!(rep["checks"]["strict"]["engine_stricter"], 1);
    assert_eq!(rep["checks"]["nerr"]["node_errors"], 1);
    assert!(rep["checks"].get("lonely").is_none(), "an unpaired row is not a comparison");
    let (_, text, _, _) = e.engine(&["shadow-compare", "--daily"], "");
    assert!(text.contains("weak: n=1") && text.contains("engine-weaker=1") && text.contains("TOTAL: n=4"), "{text}");
}

#[test]
fn the_shadow_turns_itself_off_after_its_end_date_and_says_so_once() {
    let e = Env::new("ended", "[nodeback]\nshadow_mode = \"all\"\nshadow_load_max_pct = 0\nshadow_end_date = \"2020-01-01\"\n");
    let p = e.payload(FORCE);
    let args = ["hook", "--event", "PreToolUse", "--tool", "Bash"];
    let (c1, _, err1, _) = e.engine(&args, &p);
    let (c2, _, err2, _) = e.engine(&args, &p);
    assert_eq!((c1, c2), (2, 2), "the engine still blocks");
    assert_eq!(err1.matches("the Node shadow ended on 2020-01-01").count(), 1, "first call prints the notice: {err1}");
    assert!(!err2.contains("the Node shadow ended"), "and only once: {err2}");
    std::thread::sleep(Duration::from_millis(1500));
    assert!(e.ledger().is_empty(), "nothing was shadowed");
}

#[test]
fn a_loaded_machine_or_a_breached_cpu_budget_skips_the_shadow_and_counts_it() {
    let load = Env::new("load", "[nodeback]\nshadow_mode = \"all\"\nshadow_load_max_pct = 1\nshadow_end_date = \"2999-01-01\"\n");
    let args = ["hook", "--event", "PreToolUse", "--tool", "Bash"];
    let (c, ..) = load.engine(&args, &load.payload(FORCE));
    assert_eq!(c, 2);
    assert!(load.counters().contains("shadow\tskip_load"), "load skip counted: {}", load.counters());

    let cpu = Env::new("cpu", ON);
    std::fs::write(cpu.state().join("shadow.hold"), b"").unwrap();
    let (c, ..) = cpu.engine(&args, &cpu.payload(FORCE));
    assert_eq!(c, 2);
    assert!(cpu.counters().contains("shadow\tskip_cpu"), "cpu skip counted: {}", cpu.counters());
    std::thread::sleep(Duration::from_millis(1000));
    assert!(load.ledger().is_empty() && cpu.ledger().is_empty(), "skipped means no Node run");
}

#[test]
fn the_fallback_command_writes_and_removes_the_marker() {
    let e = Env::new("fbcmd", "");
    let marker = e.state().join("fallback.node");
    assert_eq!(e.engine(&["fallback", "status"], "").1.trim(), "fallback: off (marker: no, shipped default: off)");
    assert_eq!(e.engine(&["fallback", "node"], "").0, 0);
    assert!(marker.exists());
    assert!(e.engine(&["fallback", "status"], "").1.contains("fallback: node (marker: yes"));
    assert_eq!(e.engine(&["fallback", "off"], "").0, 0);
    assert!(!marker.exists());
    assert_eq!(e.engine(&["fallback", "bogus"], "").0, 64);
}

#[test]
fn the_fallback_switch_makes_the_wrapper_run_the_node_hooks_and_off_returns_to_the_engine() {
    let e = Env::new("fbwrap", "");
    let wrapper = plugin().join("hooks/ah-hook.sh");
    let p = e.payload(FORCE);
    let run = |e: &Env| {
        let mut c = e.cmd(Path::new("/bin/sh"));
        c.arg(&wrapper).arg("PreToolUse").env("AH_WRAPPER_TEST", "1").env("AH_ENGINE_BIN", env!("CARGO_BIN_EXE_ah-engine")).env("AH_HOOK_TIMEOUT_S", "30");
        e.run(&mut c, &p)
    };
    // switch on: the Node git-guard answers, and its verdict is in the ledger as source node (no engine row)
    assert_eq!(e.engine(&["fallback", "node"], "").0, 0);
    let (code, out, err, _) = run(&e);
    assert_eq!(code, 2, "Node blocks the force push: {out} {err}");
    assert!(format!("{out}{err}").contains("force push"), "{out} {err}");
    let rows = e.ledger();
    assert_eq!(row(&rows, "node", "git-guard").map(|r| r["v"].clone()), Some("block".into()), "{rows:?}");
    assert!(rows.iter().all(|r| r["src"] == "node"), "the engine was not asked: {rows:?}");
    // switch off: the engine answers again (no new node row)
    assert_eq!(e.engine(&["fallback", "off"], "").0, 0);
    let before = e.ledger().len();
    let (code, ..) = run(&e);
    assert_eq!(code, 2, "the engine blocks too");
    assert_eq!(e.ledger().len(), before, "Node was not run");
}

#[test]
fn without_the_node_directory_the_shadow_is_a_counted_no_op() {
    let e = Env::without_node("nonode-shadow", ON);
    let (c, ..) = e.engine(&["hook", "--event", "PreToolUse", "--tool", "Bash"], &e.payload(FORCE));
    assert_eq!(c, 2, "the engine still decides alone");
    assert!(e.counters().contains("shadow\tskip_no_node"), "skip counted: {}", e.counters());
    std::thread::sleep(Duration::from_millis(1000));
    assert!(e.ledger().is_empty(), "no Node run was started");
}

#[test]
fn without_the_node_directory_the_fallback_switch_is_a_logged_no_op_and_the_engine_decides() {
    let e = Env::without_node("nonode-fb", "");
    let (code, _, err, _) = e.engine(&["fallback", "node"], "");
    assert_eq!(code, 0);
    assert!(err.contains("missing") || e.engine(&["fallback", "status"], "").1.contains("marker: yes"));
    let wrapper = e.plugin.join("hooks/ah-hook.sh");
    let mut c = e.cmd(Path::new("/bin/sh"));
    c.arg(&wrapper).arg("PreToolUse").env("AH_WRAPPER_TEST", "1").env("AH_ENGINE_BIN", env!("CARGO_BIN_EXE_ah-engine")).env("AH_HOOK_TIMEOUT_S", "30");
    let (code, out, err, _) = e.run(&mut c, &e.payload(FORCE));
    assert_eq!(code, 2, "the engine blocks the force push: {out} {err}");
    assert!(err.contains("Node backup directory"), "the no-op is logged: {err}");
    assert!(e.ledger().iter().all(|r| r["src"] != "node"), "no Node row: {:?}", e.ledger());
}
