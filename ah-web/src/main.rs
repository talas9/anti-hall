//! `ah-web serve --config <web.toml> --root <plugin root> --state <dir> --engine <ah-engine>`: the Command Center server.
//!
//! Started by `ah-engine web`, never at boot. It binds to a loopback address on a random free port, publishes its address
//! and per-session token in a state file, serves the page and the live agent list, and exits when nobody has used it for
//! `web.idle_exit_s`. Every number and text comes from the plugin's `web.toml`.
mod agents;
mod app;
mod cfg;
mod server;

use app::App;
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime};

fn arg(args: &[String], flag: &str) -> Option<PathBuf> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(PathBuf::from)
}

fn random_bytes(n: usize) -> std::io::Result<Vec<u8>> {
    let mut buf = vec![0u8; n];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf)
}

/// Write the state file atomically with mode 0600.
fn write_state(path: &std::path::Path, body: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    f.write_all(body.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

fn mtime(p: &std::path::Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

async fn bind(s: &cfg::Settings) -> Result<tokio::net::TcpListener, String> {
    let span = u32::from(s.port_max.saturating_sub(s.port_min)) + 1;
    for _ in 0..s.bind_attempts {
        let r = random_bytes(4).map_err(|e| e.to_string())?;
        let pick = u32::from_le_bytes([r[0], r[1], r[2], r[3]]) % span;
        let port = s.port_min + pick as u16;
        if let Ok(l) = tokio::net::TcpListener::bind((s.bind_host.as_str(), port)).await {
            return Ok(l);
        }
    }
    Err("no free port".into())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("serve") {
        eprintln!("usage: ah-web serve --config <web.toml> --root <plugin root> --state <dir> --engine <ah-engine>");
        std::process::exit(64);
    }
    let (Some(config), Some(root), Some(state), Some(engine)) = (arg(&args, "--config"), arg(&args, "--root"), arg(&args, "--state"), arg(&args, "--engine")) else {
        eprintln!("ah-web: --config, --root, --state and --engine are required");
        std::process::exit(64);
    };
    let settings = cfg::Settings::load(&config).unwrap_or_else(|e| {
        eprintln!("ah-web: {e}");
        std::process::exit(78);
    });
    if !settings.enabled {
        return;
    }
    let listener = bind(&settings).await.unwrap_or_else(|e| {
        eprintln!("ah-web: {e}");
        std::process::exit(75);
    });
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let token: String = random_bytes(settings.token_bytes).unwrap_or_default().iter().map(|b| format!("{b:02x}")).collect();
    let url = format!("http://{}:{port}/?t={token}", settings.bind_host);
    let state_path = state.join(&settings.state_file);
    let body = serde_json::json!({ "pid": std::process::id(), "port": port, "token": token, "url": url }).to_string();
    if let Err(e) = write_state(&state_path, &body) {
        eprintln!("ah-web: state file: {e}");
        std::process::exit(73);
    }

    let app = Arc::new(App::new(settings, config.clone(), root, engine, token, port));

    // idle exit and settings reload share one timer
    let watcher = {
        let app = app.clone();
        let state_path = state_path.clone();
        async move {
            let mut seen = mtime(&app.config_path);
            loop {
                tokio::time::sleep(Duration::from_secs(app.settings().idle_check_s)).await;
                let now = mtime(&app.config_path);
                if now != seen {
                    seen = now;
                    if let Ok(s) = cfg::Settings::load(&app.config_path) {
                        app.replace_settings(s); // a broken edit keeps the settings in force
                    }
                }
                let idle = app.started.elapsed().as_secs().saturating_sub(app.last_active_s.load(Ordering::Relaxed));
                if app.streams.load(Ordering::SeqCst) == 0 && idle >= app.settings().idle_exit_s {
                    break;
                }
            }
            let _ = state_path;
        }
    };
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
    let terminated = async {
        match term.as_mut() {
            Some(t) => {
                t.recv().await;
            }
            None => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        r = axum::serve(listener, server::router(app.clone())) => { if let Err(e) = r { eprintln!("ah-web: {e}"); } }
        () = watcher => {}
        () = terminated => {}
        _ = tokio::signal::ctrl_c() => {}
    }
    let _ = std::fs::remove_file(&state_path);
}
