//! `ah-engine statusline`: the two-line status line the host runs after each turn. Port of `statusline/statusline.js` and the
//! renderers it owns (`statusline-rich.js`, `-simple.js`, `-monorepo.js`, `phase-bar.js`).
//!
//! Line 1 is the configured base command's output, else the rich renderer (the simple or monorepo one when it prints
//! nothing); line 2 is the phase bar, the swarm activity or the context gauge. The whole run is bounded by the same budget as
//! the Node dispatcher (stdin 3 s, base command 2.5 s, git 1.5 s per question) and fails open: a problem prints nothing and
//! exits 0, never a crash in the host.
pub(crate) mod phasebar;
pub(crate) mod rich;
pub(crate) mod simple;
pub(crate) mod util;

use super::{env_snapshot, home, out, plugin_root};
use crate::checks::guardkit::jsre;
use crate::checks::jsport::ident;
use crate::checks::jsport::json::{self, J};
use crate::cli::Parsed;
use crate::defaults;
use crate::ops::js::Defer;
use crate::reqenv::RequestEnv;
use phasebar::Ctx;
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use util::{run_with_input, trim};

fn parse(text: &str) -> Option<J> {
    json::parse(text, defaults::num("setup.json_max_depth") as usize).ok()
}

/// `readBaseCommand()`
fn read_base_command(home: &str) -> Option<String> {
    let t = std::fs::read(Path::new(home).join(defaults::text("paths.base_dir")).join(defaults::text("statusline.base_file"))).ok()?;
    match parse(&String::from_utf8_lossy(&t))?.get("command") {
        Some(J::Str(s)) if !trim(s).is_empty() => Some(trim(s).to_string()),
        _ => None,
    }
}

/// `matchOwnRendererCommand(baseCmd)`: `node "<path>.js"` naming one of the plugin's own renderers.
fn own_renderer(base: &str, root: &str) -> Option<&'static str> {
    let m = jsre::compile(defaults::text("statusline.own_re"), false).captures(trim(base))?;
    let candidate = trim(m.get(1)?.as_str()).to_string();
    let resolved = std::fs::canonicalize(&candidate).ok()?;
    for (key, name) in [("rich", "statusline.rich_file"), ("phase", "statusline.phase_file")] {
        let own = Path::new(root).join(defaults::text("statusline.dir")).join(defaults::text(name));
        if std::fs::canonicalize(own).ok().as_deref() == Some(resolved.as_path()) {
            return Some(if key == "rich" { "rich" } else { "phase" });
        }
    }
    None
}

fn trim_nl(s: &str) -> String {
    s.trim_end_matches(['\r', '\n']).to_string()
}

/// `ownLine1(input)`. A relative directory from the payload is resolved against the process working directory, as
/// `path.resolve` does; where the context resolver is unsure of a layout its answer is used as it stands (it only picks the
/// fallback renderer when the rich one prints nothing).
fn own_line1(cx: &Ctx, env: &std::collections::BTreeMap<String, String>, root: &str, cwd: &str, input: &str) -> String {
    let mut dir = cwd.to_string();
    if let Some(d) = parse(input) {
        let ws = d.get("workspace").and_then(|w| w.get("current_dir")).filter(|v| util::truthy(Some(v)));
        if let Some(v) = ws.or_else(|| d.get("cwd").filter(|v| util::truthy(Some(v)))) {
            dir = crate::migrate::j_string(v);
        }
    }
    if !dir.starts_with('/') {
        dir = Path::new(cwd).join(&dir).to_string_lossy().into_owned();
    }
    let ctx = ident::resolve_context(&dir, true, &RequestEnv::from_pairs(env.clone()));
    let top = ctx.toplevel.unwrap_or_else(|| dir.clone());
    let mono_file = defaults::text("statusline.gitmodules");
    let monorepo = Path::new(&top).join(mono_file).exists() || Path::new(&dir).join(mono_file).exists();
    if let rich::Rich::Line(l) = rich::render(cx, env, root, cwd, input) {
        let l = trim_nl(&l);
        if !l.is_empty() {
            return l;
        }
    }
    let fallback = if monorepo { simple::monorepo(input, cwd, cx, env) } else { simple::simple(input, cwd, env) };
    fallback.map(|s| trim_nl(&s)).unwrap_or_default()
}

/// Read all of stdin, giving up (silently) after `statusline.stdin_watchdog_ms`.
fn read_stdin() -> Option<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let ok = std::io::stdin().lock().read_to_end(&mut b).is_ok();
        crate::discard::harmless(tx.send((b, ok))); // keep: the main thread gave up at the watchdog
    });
    rx.recv_timeout(defaults::millis("statusline.stdin_watchdog_ms")).ok().map(|(b, _)| b)
}

/// The first line, once it is known: what a run that is cut at its overall deadline still prints.
static PARTIAL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// `statusline` (the host pipes its session JSON on stdin). The whole run, input wait included, is bounded by
/// `statusline.total_deadline_ms`: past it the line already rendered is printed and the process ends (a host that stopped waiting
/// has already dropped the output), and every step's own limit is cut to what is left.
pub fn run(p: &Parsed) -> i32 {
    let started = std::time::Instant::now();
    let total = defaults::millis("statusline.total_deadline_ms");
    util::set_end(Some(started + total));
    let Some(stdin) = read_stdin() else { return 0 };
    let plan = super::shadow::begin(defaults::text("ops.verb_statusline"), defaults::text("ops.script_statusline"), &p.raw, Some(&stdin));
    let (tx, rx) = std::sync::mpsc::channel();
    let input = stdin.clone();
    std::thread::spawn(move || {
        crate::discard::harmless(tx.send(render_all(&input))); // keep: the main thread gave up at the deadline
    });
    let wait = (started + total).saturating_duration_since(std::time::Instant::now()) + defaults::millis("statusline.cut_grace_ms");
    match rx.recv_timeout(wait) {
        Ok(()) => {}
        Err(_) => {
            // cut: the part already rendered is the answer; the Node witness is not compared (it ran to completion)
            if let Some(line) = PARTIAL.lock().ok().and_then(|g| g.clone()) {
                out(&line);
            }
            crate::discard::note("statusline_cut", &format!("{} ms", started.elapsed().as_millis()));
            return 0;
        }
    }
    super::shadow::end(plan, 0);
    0
}

fn render_all(stdin: &[u8]) {
    let env = env_snapshot();
    let home = home(&env);
    let Some(root) = plugin_root(&env) else { return };
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let text = render(stdin, &env, &home, &root, &cwd);
    if !text.is_empty() {
        out(&text);
    }
}

/// The statusline text for a session payload (what [`run`] prints), rendered in this process. Always `Ok` since the renderer
/// answers every input itself; the `Result` stays for the doctor's render check, which calls this with its own home, so it
/// spawns nothing and writes nothing.
pub(crate) fn render_text(stdin: &[u8], env: &std::collections::BTreeMap<String, String>, home: &str, root: &str, cwd: &str) -> Result<String, Defer> {
    Ok(render(stdin, env, home, root, cwd))
}

fn render(stdin: &[u8], env: &std::collections::BTreeMap<String, String>, home: &str, root: &str, cwd: &str) -> String {
    let (home, root, cwd, env) = (home.to_string(), root.to_string(), cwd.to_string(), env.clone());
    let cx = Ctx { home: home.clone(), tmpdir: phasebar::tmpdir(&env), now: crate::checks::jsport::date::now_ms() };
    let input = String::from_utf8_lossy(stdin).into_owned();
    let run_own = |kind: &str| -> Option<String> {
        if kind == "rich" {
            match rich::render(&cx, &env, &root, &cwd, &input) {
                rich::Rich::Line(l) => Some(trim_nl(&l)),
                rich::Rich::Threw => None,
            }
        } else {
            phasebar::run(&cx, &input).map(|l| trim_nl(&l))
        }
    };
    let line1 = if let Some(base) = read_base_command(&home) {
        let out = match own_renderer(&base, &root) {
            Some(kind) => run_own(kind),
            None => {
                let mut c = Command::new(defaults::text("statusline.shell"));
                c.arg(defaults::text("statusline.shell_flag")).arg(&base);
                run_with_input(
                    c,
                    stdin,
                    Duration::from_millis(defaults::num("statusline.inner_timeout_ms")),
                    defaults::num("statusline.base_max_buffer") as usize,
                )
                .filter(|r| r.ok && !r.stdout.is_empty())
                .map(|r| trim_nl(&String::from_utf8_lossy(&r.stdout)))
            }
        };
        match out {
            Some(o) if !o.is_empty() => o,
            _ => own_line1(&cx, &env, &root, &cwd, &input),
        }
    } else {
        own_line1(&cx, &env, &root, &cwd, &input)
    };
    if let Ok(mut g) = PARTIAL.lock() {
        *g = Some(line1.clone());
    }
    let line2 = phasebar::run(&cx, &input).map(|l| trim_nl(&l)).filter(|l| !l.is_empty());
    let mut text = line1.clone();
    if let Some(l2) = line2 {
        if !line1.is_empty() {
            text.push('\n');
        }
        text.push_str(&l2);
    }
    text
}
