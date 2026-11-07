//! The supervised engine unit's runtime side: the switch, the client's ask to the service manager for the daemon, and the doctor's
//! check for an older interval-only unit. The unit text itself is rendered by [`super::units::engine_files`]; every name,
//! command, limit and word is in the plugin's `engine/defaults/units.toml`.
//!
//! A hook that finds no daemon used to start one itself, detached, so a daemon started that way was outside the service manager
//! and a kill of it was not supervised. With the unit installed and current, the client asks the manager to start the unit
//! instead; the daemon is then the unit's child. The ask is skipped (the client starts the daemon itself) whenever the manager
//! would start it differently from the client: another home, a test or temporary home, an `AH_ENGINE_*` override the unit does
//! not carry, or a unit file that is not what this engine would write now.
use super::units::{self, Manager, Sys};
use crate::defaults;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Whether the engine unit is the supervised one: `maintenance.unitsSupervise`, on unless it says off.
pub fn enabled() -> bool {
    let env = crate::reqenv::RequestEnv::capture();
    let st = crate::checks::git::util::Settings::from_env(&env);
    crate::checks::guardkit::settings::get_enum(&st, defaults::raw("units.supervise_setting")) != defaults::text("units.supervise_word_off")
}

/// True when `start_reason` names a start by the service manager (launchd or systemd).
pub fn supervised_reason(start_reason: &str) -> bool {
    start_reason == crate::health::starts::reason("launchd") || start_reason == crate::health::starts::reason("systemd")
}

fn engine_exe(home: &Path) -> String {
    home.join(defaults::text("units.engine_bin_rel")).display().to_string()
}

/// The command that starts the engine unit now, for `m`.
fn kickstart_argv(m: Manager) -> Vec<String> {
    let uid = crate::limits::uid().to_string();
    let unit = format!("{}{}", defaults::text("units.unit_name"), defaults::text("units.service_suffix"));
    match m {
        Manager::Launchd => units::argv("units.kickstart_launchd", &[("uid", &uid), ("label", defaults::text("units.label"))]),
        Manager::Systemd => units::argv("units.kickstart_systemd", &[("unit", &unit)]),
    }
}

/// True when the unit on disk is the one this engine writes now and the client's environment adds nothing the unit lacks.
fn unit_matches_client(home: &Path, m: Manager) -> bool {
    let prefix = defaults::text("units.kickstart_env_prefix");
    let keep = defaults::list("units.kickstart_env_keep");
    if std::env::vars().any(|(k, _)| k.starts_with(prefix) && !keep.contains(&k.as_str())) {
        return false;
    }
    let files = units::engine_files_with(m, home, &engine_exe(home), true);
    !files.is_empty() && files.iter().all(|(p, text)| std::fs::read(p).is_ok_and(|b| b == text.as_bytes()))
}

/// Ask the service manager to start the engine unit and wait for a daemon to answer on `sock`, all within `units.kickstart_budget_ms`
/// (the command and the wait together, so a miss costs the hook no more than that).
/// True when one answered. False means the caller starts the daemon itself (the singleton lock keeps it single); every false
/// is also false when nothing was asked (switch off, no unit, a mismatch, a test home).
pub fn kickstart(sock: &Path) -> bool {
    if defaults::env_var("nospawn").is_some() || !enabled() {
        return false;
    }
    let Some(home) = defaults::env_var("home").filter(|h| !h.is_empty()).map(PathBuf::from) else { return false };
    let Some(m) = units::manager(std::env::consts::OS) else { return false };
    let env = crate::reqenv::RequestEnv::capture();
    if units::RealSys::new(&home, &env).guarded() || !unit_matches_client(&home, m) {
        return false;
    }
    let began = Instant::now();
    let budget = defaults::millis("units.kickstart_budget_ms");
    let argv = kickstart_argv(m);
    let Some((prog, rest)) = argv.split_first() else { return false };
    let mut cmd = std::process::Command::new(prog);
    cmd.args(rest);
    let kind = defaults::text("units.kickstart_log_kind");
    let ran = crate::proc::run(
        cmd,
        defaults::text("units.cmd_what"),
        defaults::millis("units.kickstart_timeout_ms").min(budget),
        defaults::millis("units.kickstart_poll_ms"),
    )
    .ok()
    .is_some_and(|o| o.status.code() == Some(0));
    if !ran {
        crate::health::log_event(kind, defaults::text("units.kickstart_failed"), &argv.join(" "));
        return false;
    }
    let poll = defaults::millis("units.kickstart_poll_ms");
    loop {
        if crate::client::ping(sock).is_some() {
            crate::health::log_event(kind, defaults::text("units.kickstart_ok"), &argv.join(" "));
            return true;
        }
        if began.elapsed() >= budget {
            crate::health::log_event(kind, defaults::text("units.kickstart_miss"), &argv.join(" "));
            return false;
        }
        std::thread::sleep(poll);
    }
}

/// The engine unit file under `home` when it exists, supervision is on, and the file is not supervised (an older interval-only
/// unit). Files only: no service-manager command runs.
pub fn unsupervised_unit(home: &Path) -> Option<PathBuf> {
    if !enabled() {
        return None;
    }
    unsupervised_file(units::manager(std::env::consts::OS)?, home)
}

/// [`unsupervised_unit`] for the manager `m`, whatever the switch says.
pub(super) fn unsupervised_file(m: Manager, home: &Path) -> Option<PathBuf> {
    let marker = defaults::text(match m {
        Manager::Launchd => "units.supervise_marker_launchd",
        Manager::Systemd => "units.supervise_marker_systemd",
    });
    let (path, _) = units::engine_files_with(m, home, &engine_exe(home), true).into_iter().next()?;
    let text = std::fs::read_to_string(&path).ok()?;
    (!text.contains(marker)).then_some(path)
}

/// The supervised engine unit on disk that is not what this engine would write now (a client then starts the daemon itself).
fn unit_differs(m: Manager, home: &Path) -> Option<PathBuf> {
    if unsupervised_file(m, home).is_some() {
        return None; // the interval-only unit has its own finding
    }
    units::engine_files_with(m, home, &engine_exe(home), true)
        .into_iter()
        .find(|(p, text)| p.exists() && std::fs::read(p).is_ok_and(|b| b != text.as_bytes()))
        .map(|(p, _)| p)
}

#[cfg(test)]
pub(super) fn unit_differs_for_tests(m: Manager, home: &Path) -> Option<PathBuf> {
    unit_differs(m, home)
}

#[cfg(test)]
pub(super) fn engine_exe_for_tests(home: &Path) -> String {
    engine_exe(home)
}

/// Whether the service manager has the engine unit loaded: `None` when that cannot be asked (a test or temporary home, no manager here,
/// the command did not run).
fn unit_loaded(m: Manager, home: &Path) -> Option<bool> {
    let env = crate::reqenv::RequestEnv::capture();
    if units::RealSys::new(home, &env).guarded() {
        return None;
    }
    let uid = crate::limits::uid().to_string();
    let timer = units::timer_name(defaults::text("units.unit_name"));
    let argv = match m {
        Manager::Launchd => units::argv("units.loaded_launchd", &[("uid", &uid), ("label", defaults::text("units.label"))]),
        Manager::Systemd => units::argv("units.loaded_systemd", &[("timer", &timer)]),
    };
    let (prog, rest) = argv.split_first()?;
    let mut cmd = std::process::Command::new(prog);
    cmd.args(rest);
    let out = crate::proc::run(cmd, defaults::text("units.cmd_what"), defaults::millis("units.cmd_timeout_ms"), defaults::millis("units.cmd_poll_ms")).ok()?;
    Some(out.status.code() == Some(0))
}

/// The doctor's findings about the engine unit under `home`: an interval-only unit, a supervised unit that differs from what this
/// engine writes, a unit file the service manager has not loaded. Empty when supervision is off or there is no unit.
pub fn doctor_findings(home: &Path) -> Vec<String> {
    let Some(m) = (enabled()).then(|| units::manager(std::env::consts::OS)).flatten() else { return Vec::new() };
    let shown = |p: &Path| p.display().to_string();
    if let Some(p) = unsupervised_file(m, home) {
        return vec![defaults::render("units.finding_interval_only", &[("path", &shown(&p))])];
    }
    let mut out = Vec::new();
    if let Some(p) = unit_differs(m, home) {
        out.push(defaults::render("units.finding_unit_differs", &[("path", &shown(&p))]));
    }
    if let Some((p, _)) = units::engine_files_with(m, home, &engine_exe(home), true).into_iter().next().filter(|(p, _)| p.exists())
        && unit_loaded(m, home) == Some(false)
    {
        out.push(defaults::render("units.finding_not_loaded", &[("path", &shown(&p))]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_start_by_the_service_manager_is_supervised() {
        for r in ["launchd", "systemd"] {
            assert!(supervised_reason(r));
        }
        for r in ["hook-client", "manual", "after-crash", "deploy/routine", ""] {
            assert!(!supervised_reason(r), "{r}");
        }
    }

    #[test]
    fn the_start_commands_name_the_unit_and_the_user() {
        let ld = kickstart_argv(Manager::Launchd);
        assert_eq!(ld[..2], ["launchctl", "kickstart"]);
        assert_eq!(ld[2], format!("gui/{}/com.anti-hall.engine", crate::limits::uid()));
        assert_eq!(kickstart_argv(Manager::Systemd), ["systemctl", "--user", "start", "anti-hall-engine.service"]);
    }
}
