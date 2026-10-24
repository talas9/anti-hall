//! The `wake-monitor` stage (`wakeMonitorPostUpdate`): report whether the mailbox wake watcher is shipped and live, and how to arm it.
//!
//! Read-only apart from making sure the watcher's private state directory exists (create-only, idempotent). It arms nothing, spawns
//! nothing, takes no lock and removes nothing: liveness is a read of the watcher lock and a signal-0 probe of its pid.
//!
//! The watcher is the engine's own `devswarm wake-watch` verb, so `shipped` is always true: no script file is looked for.
use super::Run;
use crate::checks::jsport::json::J;
use crate::defaults;
use crate::meshw::idlock::devswarm_root;
use crate::wakew::arch::{IdleSkip, idle_skip};
use crate::wakew::read::{parse_json, read_text};
use crate::wakew::who::{Proc, resolve_identity};
use std::path::Path;

fn text(key: &str) -> &'static str {
    defaults::text(key)
}

fn answer(shipped: bool, live: bool, ensured: Option<bool>, idle_skip: bool, detail: String) -> J {
    let mut o = vec![("attempted".to_string(), J::Bool(true)), ("shipped".into(), J::Bool(shipped)), ("live".into(), J::Bool(live))];
    if idle_skip {
        o.push(("idleSkip".into(), J::Bool(true)));
    }
    if let Some(e) = ensured {
        o.push(("stateDirEnsured".into(), J::Bool(e)));
    }
    o.push(("detail".into(), J::Str(detail)));
    J::Obj(o)
}

/// `process.kill(pid, 0)`: alive unless the probe fails with anything but EPERM; a pid Node refuses (not an integer) is not alive.
fn probe(pid: f64) -> bool {
    if !pid.is_finite() || pid.fract() != 0.0 || pid < f64::from(i32::MIN) || pid > f64::from(i32::MAX) {
        return false;
    }
    // SAFETY: signal 0 only probes for the process (or process group); nothing is sent.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

impl Run<'_> {
    /// `None` when the engine cannot reproduce the script's answer (a checkout nested in another one, an undecidable setting): the
    /// script answers then.
    pub(super) fn wake_monitor_stage(&self, _row: &'static defaults::V) -> Option<J> {
        // the watcher is the engine itself (`ah-engine devswarm wake-watch`): nothing on disk to check for
        let home = Path::new(self.home);
        let root = devswarm_root(home);
        let ensured = std::fs::create_dir_all(root.join(text("update_post.wake_state_dir"))).is_ok();
        let engine_watcher = crate::checks::devswarm_role::text::engine_watcher(self.home);
        let arm = defaults::fill(text("update_post.wake_arm_cmd"), &[("watcher", &engine_watcher)]);
        let cwd = std::env::current_dir().ok()?.to_string_lossy().into_owned();
        let st = crate::checks::git::util::Settings { home: self.home.to_string(), env: self.env.to_map() };
        let p = Proc { home: home.to_path_buf(), cwd: cwd.clone(), env: self.env.to_map().into_iter().collect(), st, root: self.paths.plugin_src.clone() };
        let Some(identity) = resolve_identity(&p).ok()? else {
            let state = if ensured { text("update_post.wake_state_ready") } else { text("update_post.wake_state_missing") };
            return Some(answer(
                true,
                false,
                Some(ensured),
                false,
                defaults::fill(text("update_post.wake_no_identity"), &[("state", &state), ("cwd", &cwd), ("arm", &arm)]),
            ));
        };
        let lock = root.join(text("mesh_write.dir_locks")).join(format!("{}{}{}", text("wake_watch.lock_prefix"), identity.id, text("wake_watch.lock_suffix")));
        let pid = read_text(&lock).and_then(|t| parse_json(&t)).and_then(|h| match h.get("pid") {
            Some(J::Num(n)) if n.is_finite() => Some(*n),
            _ => None,
        });
        let role = identity.role();
        if let Some(pid) = pid.filter(|p| probe(*p)) {
            let shown_pid = crate::setup::jsfmt::js_string(&J::Num(pid));
            return Some(answer(
                true,
                true,
                Some(ensured),
                false,
                defaults::fill(text("update_post.wake_live"), &[("role", &role), ("id", &identity.id), ("pid", &shown_pid)]),
            ));
        }
        if identity.primary {
            match idle_skip(&p) {
                Ok(IdleSkip::Applies) => {
                    return Some(answer(
                        true,
                        false,
                        Some(ensured),
                        true,
                        defaults::fill(text("update_post.wake_idle"), &[("role", &role), ("id", &identity.id)]),
                    ));
                }
                Ok(IdleSkip::NotApplicable) => {}
                Err(_) => return None,
            }
        }
        Some(answer(
            true,
            false,
            Some(ensured),
            false,
            defaults::fill(text("update_post.wake_not_live"), &[("role", &role), ("id", &identity.id), ("arm", &arm)]),
        ))
    }
}
