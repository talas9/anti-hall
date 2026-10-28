//! A CLI verb whose reader leaves early (`ah-engine docs | head -c 1`) exits quietly, and neither that nor a CLI panic is ever
//! recorded as a crash of the daemon: `last-crash.json` stays absent, the restart tally stays at zero and `health.degraded`
//! stays false.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")
}

fn engine(home: &Path, state: &Path) -> Command {
    let mut c = Command::new(BIN);
    c.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("AH_ENGINE_DIR", state)
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .env("AH_ENGINE_NOSPAWN", "1")
        .current_dir(home);
    c
}

#[test]
fn a_closed_stdout_exits_quietly_and_leaves_the_daemon_health_alone() {
    let root = std::env::temp_dir().join(format!("ah-cli-pipe-{}", std::process::id()));
    std::fs::remove_dir_all(&root).ok();
    let (home, state) = (root.join("home"), root.join("state"));
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&state).unwrap();

    // `docs` prints far more than a pipe holds; read one byte and close the pipe
    let mut child = engine(&home, &state).arg("docs").stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut out = child.stdout.take().unwrap();
    let mut one = [0_u8; 1];
    out.read_exact(&mut one).unwrap();
    drop(out);
    let mut err = String::new();
    child.stderr.take().unwrap().read_to_string(&mut err).unwrap();
    let code = child.wait().unwrap().code();
    assert_eq!(code, Some(141), "a closed stdout is the SIGPIPE convention, not a panic (101); stderr: {err}");
    assert!(!err.contains("panicked"), "no panic text on stderr: {err}");
    assert!(!state.join("last-crash.json").exists(), "a CLI verb must not write the daemon's crash record");

    let st = engine(&home, &state).args(["status", "--json"]).output().unwrap();
    let v: serde_json::Value = serde_json::from_slice(&st.stdout).unwrap_or_else(|e| panic!("status --json: {e}: {}", String::from_utf8_lossy(&st.stdout)));
    assert_eq!(v["health"]["degraded"], false, "{v}");
    assert_eq!(v["health"]["restarts"]["total"], 0, "{v}");
    assert!(v["health"]["last_crash"].is_null(), "{v}");
    std::fs::remove_dir_all(&root).ok();
}
