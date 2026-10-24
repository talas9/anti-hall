//! `ah-engine web` (GH #266): start the Command Center server when it is not running and say where it is.
//!
//! The server is the separate binary `ah-web`, installed next to this one. Nothing runs until this command starts it; it
//! exits by itself when idle (`web.idle_exit_s`). The engine only starts it, finds it again through its state file and
//! prints the address: every number and text comes from `web.toml` in the plugin.
use crate::cli::Parsed;
use crate::{defaults, paths};
use serde_json::{Value, json};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Instant;

/// Exit code when the server binary is missing or did not come up (`web.exit_unavailable`).
fn unavailable() -> i32 {
    defaults::num("web.exit_unavailable") as i32
}

/// What the server published in its state file.
struct Running {
    pid: i64,
    url: String,
}

fn say(p: &Parsed, text: String, extra: Value) {
    if p.json {
        let mut v = json!({ "message": text });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            o.extend(e.clone());
        }
        crate::discard::harmless(writeln!(std::io::stdout(), "{v}")); // keep: a closed stdout leaves nobody to tell
    } else {
        crate::discard::harmless(writeln!(std::io::stdout(), "{text}")); // keep: a closed stdout leaves nobody to tell
    }
}

/// The server that is up now, if any: its state file names a live process that accepts connections.
fn running() -> Option<Running> {
    let text = std::fs::read_to_string(paths::dir().join(defaults::text("web.state_file"))).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let pid = v.get("pid")?.as_i64()?;
    let port = u16::try_from(v.get("port")?.as_u64()?).ok()?;
    let url = v.get("url")?.as_str()?.to_string();
    // SAFETY: signal 0 only probes whether the process exists
    if unsafe { libc::kill(pid as libc::pid_t, 0) } != 0 {
        return None;
    }
    let host = defaults::text("web.bind_host").parse().ok()?;
    TcpStream::connect_timeout(&SocketAddr::new(host, port), defaults::millis("web.probe_connect_ms")).ok()?;
    Some(Running { pid, url })
}

/// Start `ah-web serve` detached from this terminal and wait for its state file.
fn start() -> Result<Running, String> {
    let bin_name = defaults::text("web.bin_name");
    let bin: PathBuf = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join(bin_name)))
        .filter(|b| b.is_file())
        .ok_or_else(|| defaults::render("web.msg_no_bin", &[("bin", &bin_name)]))?;
    let root = defaults::root().ok_or_else(|| defaults::render("web.msg_start_failed", &[("bin", &bin_name)]))?;
    let engine = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&bin);
    cmd.arg("serve")
        .arg("--config")
        .arg(root.join(defaults::text("web.config_rel")))
        .arg("--root")
        .arg(&root)
        .arg("--state")
        .arg(paths::dir())
        .arg("--engine")
        .arg(engine)
        .arg("--socket")
        .arg(paths::socket())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0); // its own group: closing this terminal must not stop the dashboard
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    // make the server manageable: `proc status|stop|restart <pid>` finds it by this record (and restarts it with the same arguments)
    let argv: Vec<String> = std::iter::once(&bin).map(|b| b.display().to_string()).chain(cmd.get_args().map(|a| a.to_string_lossy().into_owned())).collect();
    crate::web::actions::register_pid(defaults::text("web.proc_name"), defaults::text("web.proc_kind"), child.id(), &argv);
    let until = Instant::now() + defaults::millis("web.start_wait_ms");
    while Instant::now() < until {
        if let Some(r) = running() {
            return Ok(r);
        }
        std::thread::sleep(defaults::millis("web.start_poll_ms"));
    }
    Err(defaults::render("web.msg_start_failed", &[("bin", &bin_name)]))
}

/// Open `url` in the default browser; best effort, the address is printed either way.
fn open_in_browser(url: &str) {
    let argv = defaults::list("web.open_cmd");
    let Some((prog, args)) = argv.split_first() else { return };
    crate::discard::harmless(Command::new(prog).args(args).arg(url).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()); // keep: no opener installed is not an error
}

/// The `web` command: `open` (default) and `status`.
pub fn run_cmd(p: &Parsed) -> i32 {
    let sub = p.rest.iter().find(|a| !a.starts_with("--")).map_or("open", String::as_str);
    if !defaults::raw("web.enabled").as_bool().unwrap_or(false) {
        say(p, defaults::text("web.msg_disabled").to_string(), json!({ "enabled": false }));
        return 0;
    }
    match sub {
        "status" => {
            match running() {
                Some(r) => say(
                    p,
                    defaults::render("web.msg_status_running", &[("pid", &r.pid), ("url", &r.url)]),
                    json!({ "running": true, "pid": r.pid, "url": r.url }),
                ),
                None => say(p, defaults::text("web.msg_status_stopped").to_string(), json!({ "running": false })),
            }
            0
        }
        "open" => {
            let started = match running() {
                Some(r) => Ok(r),
                None => start(),
            };
            match started {
                Ok(r) => {
                    say(p, defaults::render("web.msg_url", &[("url", &r.url)]), json!({ "running": true, "pid": r.pid, "url": r.url }));
                    if defaults::raw("web.open_browser").as_bool().unwrap_or(false) && !p.rest.iter().any(|a| a == "--no-open") {
                        open_in_browser(&r.url);
                    }
                    0
                }
                Err(msg) => {
                    say(p, msg, json!({ "running": false }));
                    unavailable()
                }
            }
        }
        _ => {
            say(p, defaults::text("web.msg_usage").to_string(), json!({}));
            64
        }
    }
}
