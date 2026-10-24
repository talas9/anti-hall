//! The legacy sweep: what an older install left behind is moved aside when a newer one is installed.
//!
//! Runs at the end of every install routine run (first install, GitHub update, `--from-local`, `scripts/engine-deploy.sh`) and in
//! `doctor --repair`, so a machine that still has an old install (0.100, the Node era) ends up with the new installation only:
//!
//! 1. every file of a plugin root that the new plugin tree does not hold ([`stale_files`]);
//! 2. the artefacts of the old installers outside the plugin roots: launcher shims in the base directory, crontab blocks
//!    ([`legacy`]), and (through `units heal`) their launchd and systemd units, which are unloaded before their files move;
//! 3. the state migrations (`migrate::run`), which repair the data earlier versions broke.
//!
//! Nothing is deleted: every file goes to `<state>/retired/<ts>-<label>/<relative path>`; a crontab is saved there before it is
//! rewritten. Every step is idempotent and fail-open (a failure is a line in the report, never an abort), and `dry` changes nothing.
//! Every name, list and text is in `engine/defaults/routine.toml`.
use crate::{defaults, migrate, paths};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn t(key: &str) -> &'static str {
    defaults::text(key)
}

/// What one sweep did (or, on a dry run, would do).
#[derive(Default)]
pub struct Outcome {
    /// Every move: `{from, to}`.
    pub moved: Vec<Value>,
    /// Files retired out of plugin roots.
    pub files: usize,
    /// Legacy items (shims, crontab blocks) retired.
    pub legacy: usize,
    /// State items the migrations repaired.
    pub migrated: usize,
}

impl Outcome {
    /// The outcome as the JSON of the install report and the deploy manifest.
    pub fn to_json(&self) -> Value {
        json!({"files": self.files, "legacy": self.legacy, "migrated": self.migrated, "moved": self.moved})
    }
}

fn retired_root(state: &Path, ts: u64, label: &str) -> PathBuf {
    state.join(t("routine.retired_dir")).join(defaults::fill(t("routine.retired_name"), &[("ts", &ts), ("label", &label)]))
}

/// A readable, filesystem-safe label of a plugin root: its last two path components.
fn root_label(root: &Path) -> String {
    let parts: Vec<String> = root.components().rev().take(2).map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    let mut p = parts;
    p.reverse();
    p.join("_").chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// Move `from` to `to` (creating the parents). A rename when it can be one, else a copy followed by removing the source.
fn move_aside(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut dst = to.to_path_buf();
    let mut n = 1;
    while std::fs::symlink_metadata(&dst).is_ok() {
        dst = to.with_file_name(format!("{}.{n}", to.file_name().unwrap_or_default().to_string_lossy()));
        n += 1;
    }
    if std::fs::rename(from, &dst).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, &dst)?;
    std::fs::remove_file(from)
}

/// Every file (and symbolic link) below `dir`, relative to `base`, not entering `routine.tree_skip_dirs`.
fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let skip = defaults::list("routine.tree_skip_dirs");
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !skip.contains(&name.as_str()) {
                walk(base, &p, out);
            }
        } else if let Ok(rel) = p.strip_prefix(base) {
            out.push(rel.to_string_lossy().into_owned());
        }
    }
}

fn kept(rel: &str) -> bool {
    defaults::list("routine.sweep_keep").iter().any(|k| rel == *k || rel.starts_with(&format!("{k}/")))
        || defaults::list("routine.tree_skip_substrings").iter().any(|s| rel.contains(s))
}

/// Move every file of `root` that the plugin tree `tree` does not hold into the retired directory; remove the directories this
/// leaves empty. Returns the moves (`from`, `to`).
pub fn stale_files(tree: &Path, root: &Path, state: &Path, ts: u64, dry: bool) -> Vec<(PathBuf, PathBuf)> {
    let same = std::fs::canonicalize(tree).ok().zip(std::fs::canonicalize(root).ok()).is_some_and(|(a, b)| a == b);
    if same || !tree.join(t("routine.tree_marker")).is_file() {
        return Vec::new();
    }
    let (mut new_tree, mut here) = (Vec::new(), Vec::new());
    walk(tree, tree, &mut new_tree);
    walk(root, root, &mut here);
    let new_tree: HashSet<String> = new_tree.into_iter().collect();
    let dst_root = retired_root(state, ts, &root_label(root));
    let mut moves = Vec::new();
    for rel in here.into_iter().filter(|r| !new_tree.contains(r) && !kept(r)) {
        let (from, to) = (root.join(&rel), dst_root.join(&rel));
        if dry || move_aside(&from, &to).is_ok() {
            if !dry {
                let mut dir = from.parent();
                while let Some(d) = dir.filter(|d| *d != root && d.starts_with(root)) {
                    if std::fs::remove_dir(d).is_err() {
                        break;
                    }
                    dir = d.parent();
                }
            }
            moves.push((from, to));
        }
    }
    moves
}

/// The crontab text without the managed blocks of the old installers (a marker line and the line after it), and how many blocks went.
fn strip_cron(text: &str) -> (String, usize) {
    let markers = defaults::list("routine.sweep_cron_markers");
    let sep = t("routine.sweep_cron_sep");
    let is_marker = |l: &str| {
        let l = l.trim();
        markers.iter().any(|m| l == *m || l.strip_prefix(m).and_then(|r| r.strip_prefix(sep)).is_some_and(|s| !s.is_empty()))
    };
    let (mut out, mut n) = (Vec::new(), 0);
    let mut lines = text.lines().peekable();
    while let Some(l) = lines.next() {
        if is_marker(l) {
            n += 1;
            if lines.peek().is_some_and(|nx| !nx.trim_start().starts_with('#')) {
                lines.next();
            }
        } else {
            out.push(l);
        }
    }
    let mut s = out.join("\n");
    if !s.is_empty() {
        s.push('\n');
    }
    (s, n)
}

fn command(key: &str) -> Option<Command> {
    let argv = defaults::list(key);
    let (prog, args) = argv.split_first()?;
    let mut c = Command::new(prog);
    c.args(args);
    Some(c)
}

/// Move the launcher shims of the old installers aside and rewrite the crontab without their blocks (the crontab as it was is saved
/// first). `guarded` (a test marker or a temporary home) leaves the crontab alone.
pub fn legacy(home: &Path, state: &Path, ts: u64, dry: bool, guarded: bool, out: &mut Outcome, notes: &mut Vec<String>) {
    let dst_root = retired_root(state, ts, t("routine.sweep_legacy_label"));
    let base = home.join(t("paths.base_dir"));
    for rel in defaults::list("routine.sweep_legacy_shims") {
        let from = base.join(rel);
        if std::fs::symlink_metadata(&from).is_err() {
            continue;
        }
        let to = dst_root.join(rel);
        match if dry { Ok(()) } else { move_aside(&from, &to) } {
            Ok(()) => {
                out.legacy += 1;
                out.moved.push(json!({"from": from.display().to_string(), "to": to.display().to_string()}));
            }
            Err(e) => notes.push(defaults::render(
                "routine.line_sweep_failed",
                &[("step", &t("routine.sweep_step_legacy")), ("why", &format!("{}: {e}", from.display()))],
            )),
        }
    }
    if guarded {
        return;
    }
    let Some(listing) =
        command("routine.sweep_cron_list").and_then(|mut c| c.stdin(Stdio::null()).stderr(Stdio::null()).output().ok()).filter(|o| o.status.success())
    else {
        return;
    };
    let (next, n) = strip_cron(&String::from_utf8_lossy(&listing.stdout));
    if n == 0 {
        return;
    }
    let backup = dst_root.join(t("routine.sweep_cron_backup"));
    if !dry {
        let step = t("routine.sweep_step_legacy");
        let saved = backup.parent().is_none_or(|d| std::fs::create_dir_all(d).is_ok()) && std::fs::write(&backup, &listing.stdout).is_ok();
        let wrote = saved
            && command("routine.sweep_cron_write")
                .and_then(|mut c| c.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok())
                .is_some_and(|mut ch| {
                    let fed = ch.stdin.take().is_some_and(|mut i| i.write_all(next.as_bytes()).is_ok());
                    ch.wait().is_ok_and(|s| s.success()) && fed
                });
        if !wrote {
            notes.push(defaults::render("routine.line_sweep_failed", &[("step", &step), ("why", &backup.display())]));
            return;
        }
    }
    out.legacy += n;
    out.moved.push(json!({"from": "crontab", "to": backup.display().to_string()}));
}

/// Run the whole sweep. `tree` is the new plugin tree (none: the file step is skipped), `roots` the plugin roots that were just
/// brought up to it. `units` also runs `units heal` (the install routine; `doctor --repair` runs it on its own). Every line to show goes to `say`.
pub fn run(tree: Option<&Path>, roots: &[PathBuf], dry: bool, units: bool, say: &mut dyn FnMut(String)) -> Outcome {
    let mut out = Outcome::default();
    let state = paths::dir();
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    if let Some(tree) = tree {
        for root in roots {
            let moves = stale_files(tree, root, &state, ts, dry);
            if moves.is_empty() {
                continue;
            }
            let dir = retired_root(&state, ts, &root_label(root));
            say(defaults::render(if dry { "routine.line_retired_would" } else { "routine.line_retired" }, &[("n", &moves.len()), ("dir", &dir.display())]));
            out.files += moves.len();
            out.moved.extend(moves.iter().map(|(f, to)| json!({"from": f.display().to_string(), "to": to.display().to_string()})));
        }
    }
    let Some(home) = defaults::env_var("home").filter(|h| !h.is_empty()).map(PathBuf::from) else { return out };
    let env = crate::reqenv::RequestEnv::capture();
    let sys = crate::setup::units::RealSys::new(&home, &env);
    let mut notes = Vec::new();
    let before = out.legacy;
    legacy(&home, &state, ts, dry, crate::setup::units::Sys::guarded(&sys), &mut out, &mut notes);
    if out.legacy > before {
        let dir = retired_root(&state, ts, t("routine.sweep_legacy_label"));
        say(defaults::render(
            if dry { "routine.line_retired_legacy_would" } else { "routine.line_retired_legacy" },
            &[("n", &(out.legacy - before)), ("dir", &dir.display())],
        ));
    }
    // the launchd / systemd units of the old installers: unloaded first, then their files move (the engine's own `units heal`)
    if let Some(report) = units.then(|| crate::setup::units::heal_changes(dry)).flatten() {
        say(defaults::render("routine.line_units", &[("text", &report.to_text())]));
    }
    // the stamped state migrations (idempotent)
    let env_map: std::collections::BTreeMap<String, String> = std::env::vars().collect();
    let cwd = std::env::current_dir().map_or_else(|_| home.display().to_string(), |d| d.display().to_string());
    let root = roots.first().map(|r| r.display().to_string());
    let ctx = migrate::Ctx::new(home.display().to_string(), cwd, env_map, dry, None, root);
    let fixed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| migrate::run(&ctx))).map(|rows| rows.iter().filter(|r| r.status == "fixed").count());
    match fixed {
        Ok(n) => {
            out.migrated = n;
            if n > 0 {
                say(defaults::render("routine.line_migrated", &[("n", &n)]));
            }
        }
        Err(_) => notes.push(defaults::render("routine.line_sweep_failed", &[("step", &t("routine.sweep_step_migrate")), ("why", &"panic")])),
    }
    for n in notes {
        say(n);
    }
    out
}

/// `doctor --repair`'s share: the legacy artefacts and the state migrations, plus the stale files of the other installed plugin roots
/// that are at the same version as the plugin root the engine runs from (a different version is another install's tree, not a newer
/// copy of this one).
pub fn for_doctor(dry: bool, say: &mut dyn FnMut(String)) -> Outcome {
    let tree = defaults::root();
    let version_of = |r: &Path| {
        std::fs::read_to_string(r.join(t("migrate.plugin_manifest")))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("version").and_then(Value::as_str).map(str::to_string))
    };
    let mine = tree.as_deref().and_then(version_of);
    let roots: Vec<PathBuf> = super::routine::plugin_roots().into_iter().filter(|r| mine.is_some() && version_of(r) == mine).collect();
    run(tree.as_deref(), &roots, dry, false, say)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cron_block_is_a_marker_and_the_line_after_it() {
        let text = "0 * * * * keep\n# anti-hall-devswarm-ingest-abc123\n* * * * * run it\n# anti-hall-devswarm-ingestx\n5 * * * * other\n";
        let (next, n) = strip_cron(text);
        assert_eq!(n, 1);
        assert_eq!(next, "0 * * * * keep\n# anti-hall-devswarm-ingestx\n5 * * * * other\n");
    }
}
