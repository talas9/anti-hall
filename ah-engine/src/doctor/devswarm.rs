//! The DevSwarm liveness-supervisor section: do the supervisor's own files parse, do the four mechanical DevSwarm hooks still fire
//! (each is run on a fixture home with the DevSwarm role environment and must have its observable effect), is the background
//! supervisor installed, and, when a DevSwarm session is active, the counters of the wake-watch and mailbox-cron measurements.
//! Ported from the first half of the Node doctor's section 5c.
//!
//! Silent when DevSwarm is dormant, the supervisor is not installed, every file parses and every hook test passes. What the Node
//! doctor does beyond this for an active session (the per-workspace liveness verdicts, the app-database view, the delivery log, the
//! wake monitor and the other runtime checks of `doctor-devswarm.js` and `doctor-runtime.js`) the engine doctor does not do yet: it
//! says so and names the Node command, rather than staying quiet.
use super::Doc;
use super::selftest;
use crate::checks::git::util::Settings;
use crate::checks::jsport::json::J;
use crate::defaults;
use crate::migrate::{self, Ctx};
use crate::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// One hook self-test: `Pass`, `Fail`, or `Skip` (not applicable here; neither a pass nor a failure).
enum Verdict {
    Pass(String),
    Fail(String),
    Skip(String),
    /// The engine defers the check to its Node hook and Node could not run it: not exercised, reported as a warning.
    Deferred(String),
}

fn text(key: &str) -> &'static str {
    defaults::text(key)
}

fn devswarm_dir(home: &Path) -> PathBuf {
    home.join(text("migrate.base_dir")).join(text("migrate.devswarm_dir"))
}

/// A registered workspace in a fixture home: descriptor, inbox lines and cursor (`writeWorkspace`).
fn write_workspace(home: &Path, id: &str, inbox: &[&str], cursor: u32) -> std::io::Result<()> {
    let root = devswarm_dir(home);
    let (inbox_path, cursor_path) = (
        root.join(text("doctor.ds_inbox_dir")).join(format!("{id}{}", text("doctor.ds_inbox_ext"))),
        root.join(text("doctor.ds_cursor_dir")).join(format!("{id}{}", text("mesh_write.json_suffix"))),
    );
    for p in [&inbox_path, &cursor_path] {
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d)?;
        }
    }
    std::fs::write(&inbox_path, if inbox.is_empty() { String::new() } else { format!("{}\n", inbox.join("\n")) })?;
    std::fs::write(&cursor_path, cursor.to_string())?;
    let d = json!({"id": id, "worktreePath": root.join(text("doctor.ds_wt_dir")).join(id), "sessionId": format!("{}{id}", text("doctor.ds_session_prefix")), "inboxPath": inbox_path, "cursorPath": cursor_path});
    let ws = root.join(text("mesh_write.dir_workspaces"));
    std::fs::create_dir_all(&ws)?;
    std::fs::write(ws.join(format!("{id}{}", text("mesh_write.json_suffix"))), d.to_string())
}

fn payload(key: &str, pairs: &[(&str, String)]) -> Value {
    let mut v = serde_json::from_str(text(key)).unwrap_or(Value::Null);
    selftest::fill_value(&mut v, pairs);
    v
}

fn deferred(check: &str) -> Verdict {
    Verdict::Deferred(defaults::render("doctor_msg.deferred", &[("check", &check)]))
}

fn blocked(out: &str) -> bool {
    crate::checks::lit_re(text("doctor.decision_block_re")).is_match(out)
}

/// The four mechanical-hook self-tests, each on its own fixture home.
fn hook_tests(ctx: &Ctx, root: Option<&str>) -> Vec<Verdict> {
    let mut out = Vec::new();
    let child_env = defaults::list("doctor.ds_child_env");
    let primary_env = defaults::list("doctor.ds_primary_env");
    let env_for = |home: &Path, base: &[&str], extra: &[String]| {
        let mut all: Vec<&str> = base.to_vec();
        all.extend(extra.iter().map(String::as_str));
        selftest::test_env(ctx, home, root, &all)
    };
    let now = selftest::now_ms();

    // 1. a child's turn writes a heartbeat and injects the parent-update reminder
    if let Some(h) = selftest::Scratch::new(ctx, text("doctor.ds_label_turn")) {
        let env = env_for(&h.dir, &child_env, &[]);
        let r = selftest::run_check(ctx, root, "devswarm-child-turn", text("doctor.ds_script_turn"), &payload("doctor.ds_payload_turn", &[]), &env);
        if r.text().is_none() {
            out.push(deferred("devswarm-child-turn"));
        } else {
            let said = r.text().is_some_and(|t| crate::checks::lit_re(text("doctor.ds_turn_re")).is_match(t));
            let beat = std::fs::read_dir(devswarm_dir(&h.dir).join(text("doctor.ds_heartbeat_dir")))
                .is_ok_and(|mut d| d.any(|e| e.is_ok_and(|e| e.file_name().to_string_lossy().ends_with(text("mesh_write.json_suffix")))));
            out.push(if said && beat {
                Verdict::Pass(text("doctor_msg.ds_turn_ok").into())
            } else {
                Verdict::Fail(defaults::render("doctor_msg.ds_turn_bad", &[("said", &said), ("beat", &beat)]))
            });
        }
    }

    // 2. a child's Stop is blocked until it reports to its parent (it must be a registered workspace)
    if let Some(h) = selftest::Scratch::new(ctx, text("doctor.ds_label_cgate")) {
        let builder = text("doctor.ds_builder_id");
        let wrote = write_workspace(&h.dir, builder, &[], 0);
        let env = env_for(&h.dir, &child_env, &[format!("{}={builder}", text("doctor.ds_builder_env"))]);
        let r = selftest::run_check(
            ctx,
            root,
            "devswarm-child-gate",
            text("doctor.ds_script_cgate"),
            &payload("doctor.ds_payload_stop", &[("{SID}", format!("cg-{now}"))]),
            &env,
        );
        let ok = wrote.is_ok() && r.text().is_some_and(blocked);
        out.push(if r.text().is_none() {
            deferred("devswarm-child-gate")
        } else if ok {
            Verdict::Pass(text("doctor_msg.ds_cgate_ok").into())
        } else {
            Verdict::Fail(text("doctor_msg.ds_cgate_bad").into())
        });
    }

    // 3. the Primary is told about a workspace's unread backlog (read from the shared summary of this project)
    if let Some(h) = selftest::Scratch::new(ctx, text("doctor.ds_label_inbox")) {
        let key = crate::meshw::ident::repo_key_for_worktree(&ctx.cwd).ok().flatten();
        match key {
            None => out.push(Verdict::Skip(defaults::render("doctor_msg.ds_inbox_skip", &[("cwd", &ctx.cwd)]))),
            Some(key) => {
                let dir = devswarm_dir(&h.dir).join(text("doctor.ds_summaries_dir"));
                let wrote = std::fs::create_dir_all(&dir)
                    .and_then(|()| std::fs::write(dir.join(format!("{key}{}", text("mesh_write.json_suffix"))), text("doctor.ds_summary_json")));
                let env = env_for(&h.dir, &primary_env, &[]);
                let r = selftest::run_check(
                    ctx,
                    root,
                    "devswarm-parent-inbox",
                    text("doctor.ds_script_inbox"),
                    &payload("doctor.ds_payload_inbox", &[("{CWD}", ctx.cwd.clone())]),
                    &env,
                );
                let said = r.text().is_some_and(|t| {
                    crate::checks::lit_re(text("doctor.ds_inbox_re")).is_match(t) && crate::checks::lit_re(text("doctor.ds_inbox_re2")).is_match(t)
                });
                out.push(if wrote.is_ok() && said {
                    Verdict::Pass(text("doctor_msg.ds_inbox_ok").into())
                } else {
                    Verdict::Fail(text("doctor_msg.ds_inbox_bad").into())
                });
            }
        }
    }

    // 4. the Primary's Stop is blocked while a child's inbox is unread
    if let Some(h) = selftest::Scratch::new(ctx, text("doctor.ds_label_pgate")) {
        let lines = defaults::list("doctor.ds_inbox_lines");
        let wrote = write_workspace(&h.dir, text("doctor.ds_workspace_id"), &lines, 0);
        let env = env_for(&h.dir, &primary_env, &[]);
        let r = selftest::run_check(
            ctx,
            root,
            "devswarm-parent-gate",
            text("doctor.ds_script_pgate"),
            &payload("doctor.ds_payload_stop", &[("{SID}", format!("pg-{now}"))]),
            &env,
        );
        let ok = wrote.is_ok() && r.text().is_some_and(blocked);
        out.push(if r.text().is_none() {
            deferred("devswarm-parent-gate")
        } else if ok {
            Verdict::Pass(text("doctor_msg.ds_pgate_ok").into())
        } else {
            Verdict::Fail(text("doctor_msg.ds_pgate_bad").into())
        });
    }
    out
}

/// The supervisor files that do not parse (`node --check`): `(file name, first line of the error)`.
fn syntax_errors(ctx: &Ctx, root: &Path) -> Vec<(String, String)> {
    let Some(node) = super::system::which(text("doctor.node_default"), ctx.env.get("PATH").map(String::as_str).unwrap_or("")) else { return Vec::new() };
    let mut bad = Vec::new();
    for rel in defaults::list("doctor.ds_supervisor_files") {
        let file = root.join(rel);
        if !file.exists() {
            continue;
        }
        let mut cmd = std::process::Command::new(&node);
        cmd.arg(text("doctor.node_check_flag")).arg(&file).env_clear().envs(&ctx.env);
        match crate::proc::run(cmd, text("doctor.probe_label"), defaults::millis("doctor.probe_timeout_ms"), defaults::millis("doctor.probe_poll_ms")) {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                let first = String::from_utf8_lossy(&o.stderr).lines().next().unwrap_or("").to_string();
                bad.push((file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), first));
            }
            Err(e) => bad.push((file.display().to_string(), e.into_io().to_string())),
        }
    }
    bad
}

/// Whether the background supervisor is installed (a launchd agent or a systemd timer file; nothing is spawned).
fn installed(ctx: &Ctx) -> Option<&'static str> {
    let home = Path::new(&ctx.home);
    let (os, _) = super::node_platform();
    if os == text("doctor.os_darwin") {
        let p = home.join(defaults::list("doctor.launchd_dir").iter().collect::<PathBuf>()).join(format!(
            "{}{}",
            text("doctor.ds_label"),
            text("doctor.plist_ext")
        ));
        p.exists().then(|| text("doctor_msg.ds_scheduler_launchd"))
    } else if os == text("doctor.os_linux") {
        let p =
            home.join(defaults::list("doctor.systemd_dir").iter().collect::<PathBuf>()).join(format!("{}{}", text("doctor.ds_unit"), text("doctor.timer_ext")));
        p.exists().then(|| text("doctor_msg.ds_scheduler_systemd"))
    } else {
        None
    }
}

/// The workspace descriptors the supervisor sweeps (`readDescriptors`): readable JSON with a worktree, a session and a safe id.
fn descriptors(ctx: &Ctx) -> usize {
    let dir = devswarm_dir(Path::new(&ctx.home)).join(text("mesh_write.dir_workspaces"));
    migrate::read_dir_sorted(&dir)
        .unwrap_or_default()
        .iter()
        .filter(|n| n.ends_with(text("mesh_write.json_suffix")))
        .filter_map(|n| migrate::parse_json(&std::fs::read_to_string(dir.join(n)).ok()?))
        .filter(|d| {
            let has = |k: &str| migrate::j_truthy(d.get(k));
            has("worktreePath") && has("sessionId") && matches!(d.get("id"), Some(J::Str(id)) if crate::meshw::idlock::is_safe_id(id))
        })
        .count()
}

/// The number of non-empty lines of a measurement log (`filter` when only some lines count), 0 when it does not exist.
fn count_lines(path: &Path, trigger: Option<&str>) -> usize {
    let Ok(t) = std::fs::read_to_string(path) else { return 0 };
    t.lines()
        .filter(|l| !l.is_empty())
        .filter(|l| match trigger {
            None => true,
            Some(want) => serde_json::from_str::<Value>(l).ok().is_some_and(|v| v.get("trigger").and_then(Value::as_str) == Some(want)),
        })
        .count()
}

/// The section; nothing is printed when everything is quiet.
pub fn section(doc: &mut Doc, ctx: &Ctx, root: Option<&Path>) {
    let root_str = root.map(|r| r.to_string_lossy().into_owned());
    let syntax = root.map(|r| syntax_errors(ctx, r)).unwrap_or_default();
    let tests = hook_tests(ctx, root_str.as_deref());
    let any_fail = tests.iter().any(|t| matches!(t, Verdict::Fail(_)));
    let sched = installed(ctx);
    let n_desc = descriptors(ctx);
    let env_active = crate::checks::spawnctx::devswarm_active(&Settings::from_env(&RequestEnv::from(ctx.env.clone())));
    let active = env_active || n_desc > 0;
    if !active && sched.is_none() && syntax.is_empty() && !any_fail {
        return;
    }
    doc.head(text("doctor_msg.head_devswarm"));
    for (file, err) in syntax {
        doc.bad(defaults::render("doctor_msg.ds_syntax", &[("file", &file), ("error", &err)]));
    }
    for t in tests {
        match t {
            Verdict::Pass(m) => doc.ok(m),
            Verdict::Fail(m) => doc.bad(m),
            Verdict::Skip(m) => doc.infol(m),
            Verdict::Deferred(m) => doc.warnl(m),
        }
    }
    match sched {
        Some(kind) => doc.ok(defaults::render("doctor_msg.ds_installed", &[("kind", &kind)])),
        None => doc.infol(text("doctor_msg.ds_not_installed").to_string()),
    }
    if active {
        doc.infol(defaults::render("doctor_msg.ds_runtime_deferred", &[("n", &n_desc)]));
        let dir = devswarm_dir(Path::new(&ctx.home));
        for (file, trigger, key) in [
            ("doctor.ds_log_cron_found", None, "doctor_msg.ds_cron_found"),
            ("doctor.ds_log_not_draining", None, "doctor_msg.ds_not_draining"),
            ("doctor.ds_log_rearm", Some("doctor.ds_trigger_idle"), "doctor_msg.ds_idle_skips"),
            ("doctor.ds_log_rearm", Some("doctor.ds_trigger_limit"), "doctor_msg.ds_limit_skips"),
            ("doctor.ds_log_cron_missing", None, "doctor_msg.ds_cron_missing"),
        ] {
            let n = count_lines(&dir.join(text(file)), trigger.map(text));
            doc.infol(defaults::render(key, &[("n", &n)]));
        }
    }
}
