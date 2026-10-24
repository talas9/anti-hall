//! `ah-hook update ...`: move the local ah-engine binary (and the thin client itself, when the archive ships it) to an offline file, the
//! latest stable release or the latest dev pre-release, in one command. The port of `hooks/ah-update.sh`, and the one updater: the
//! engine's `engine-update` verb hands off to it, so a broken engine stays fixable and the engine has no network code.
//!
//!   --from FILE [--sha256 X] [--yes]   offline: FILE is a release .tar.gz or a bare binary. Expected sha256 = --sha256, else the
//!                                      SHA256SUMS next to FILE, else the plugin's ah-engine.lock; with none of them the sha is
//!                                      printed and --yes is required (exit 3)
//!   --channel stable|dev               latest ah-engine-v* release / ah-engine-dev-<sha8> pre-release (the dev channel also syncs the
//!                                      matching plugin files when the live kit is installed)
//!   --rollback                         restore the previous binaries (bin/ah-engine.prev, bin/ah-hook.prev); run twice to toggle
//!   --auto                             honour the engine.autoUpdate setting (off|stable|dev) and the daily limit
//! options: --launcher FILE, --dry-run, --extract-to PATH, --no-restart, --no-plugin, --live-select LIST, -v, --json (ignored), --help
//!
//! Steps: verify -> smoke test (`<new> version`) -> launcher self-test -> atomic swap into bin/ (previous kept as `.prev`) -> the thin
//! client swapped too when the archive holds one (and put back at once when it fails its own self-test) -> restart the daemon.
//! Nothing is deleted; a failure at any step keeps the old binaries. Every failure says three things (what failed, what is installed
//! now, one exact next step). Exit: 0 done / already current / nothing to do, 1 failed (old binary kept), 2 usage, 3 --yes needed.
//!
//! Every URL, timeout, channel name, command line and text comes from `[updater.*]` / `msg.updater_*` in the plugin's
//! `engine/defaults`; a file that lacks one makes the command exit 1 with the missing key named.

use crate::cfg::Settings;
use crate::install::{Ran, make_exec, run_limited, sha256_file, subst};
use crate::integrity::Integ;
use crate::rec::{self, epoch_s};
use crate::util::{env_nonempty, fill};
use std::fs;
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Every `[updater.*]` setting, read once.
struct Uc {
    repo: String,
    api_base: String,
    download_base: String,
    git_url: String,
    ch_stable: String,
    ch_dev: String,
    pre_stable: String,
    pre_dev: String,
    default_channel: String,
    sums_asset: String,
    commit_asset: String,
    per_page: u64,
    connect_s: u64,
    download_s: u64,
    run_s: u64,
    git_s: u64,
    live_s: u64,
    max_bytes: u64,
    auto_interval_s: u64,
    selftest_s: u64,
    stale_lock_s: u64,
    kill_grace: Duration,
    poll: Duration,
    restart_pause: Duration,
    status_tries: u64,
    log_max: u64,
    log_keep: usize,
    excerpt_chars: usize,
    lock_dir: String,
    log_file: String,
    checked_file: String,
    installed_file: String,
    tmp_prefix: String,
    prev_suffix: String,
    kit_dir: String,
    kit_state: String,
    kit_script: String,
    kit_bundle: String,
    kit_plugin: String,
    kit_shell: String,
    sums_file: String,
    lock_file: String,
    tar_list: Vec<String>,
    tar_cat: Vec<String>,
    tar_unpack: Vec<String>,
    curl_cmd: Vec<String>,
    curl_cmd_test: Vec<String>,
    wget_cmd: Vec<String>,
    attest_cmd: Vec<String>,
    attest_auth: Vec<String>,
    git_init: Vec<String>,
    git_fetch: Vec<String>,
    git_archive: Vec<String>,
    engine_stop: String,
    engine_serve: String,
    engine_serve_args: Vec<String>,
    engine_status: String,
    engine_version: String,
    member_engine: String,
    member_hook: String,
    plugin_dir_in_repo: String,
    setting_section: String,
    setting_auto: Vec<String>,
    words_on: Vec<String>,
    arg_finish_restart: String,
    engine_verb_update: String,
    flag_from_local: String,
    flag_source: String,
    flag_yes: String,
    flag_force: String,
    source_release: String,
    source_file: String,
    stage_dir: String,
    asset_name: String,
    routine_feature: String,
    record_file: String,
    engine_version_json: Vec<String>,
}

fn text(s: &Settings, k: &str) -> Result<String, String> {
    s.shipped(k)
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .ok_or_else(|| k.to_string())
}

fn num(s: &Settings, k: &str) -> Result<u64, String> {
    s.shipped(k)
        .and_then(|v| v.as_integer())
        .ok_or_else(|| k.to_string())?;
    Ok(s.num(k))
}

fn list(s: &Settings, k: &str) -> Result<Vec<String>, String> {
    let v: Vec<String> = s
        .shipped(k)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if v.is_empty() {
        Err(k.to_string())
    } else {
        Ok(v)
    }
}

impl Uc {
    fn load(s: &Settings) -> Result<Uc, String> {
        let t = |k: &str| text(s, &format!("updater.{k}"));
        let n = |k: &str| num(s, &format!("updater.{k}"));
        let l = |k: &str| list(s, &format!("updater.{k}"));
        Ok(Uc {
            repo: t("repo")?,
            api_base: t("api_base")?,
            download_base: t("download_base")?,
            git_url: t("git_url")?,
            ch_stable: t("channel_stable")?,
            ch_dev: t("channel_dev")?,
            pre_stable: t("tag_prefix_stable")?,
            pre_dev: t("tag_prefix_dev")?,
            default_channel: t("default_channel")?,
            sums_asset: t("sums_asset")?,
            commit_asset: t("commit_asset")?,
            per_page: n("list_per_page")?,
            connect_s: n("connect_timeout_s")?,
            download_s: n("download_timeout_s")?,
            run_s: n("run_timeout_s")?.max(1),
            git_s: n("git_timeout_s")?,
            live_s: n("go_live_timeout_s")?,
            max_bytes: n("max_download_bytes")?,
            auto_interval_s: n("auto_interval_s")?,
            selftest_s: n("launcher_selftest_timeout_s")?.max(1),
            stale_lock_s: n("stale_lock_s")?,
            kill_grace: Duration::from_secs(n("kill_grace_s")?),
            poll: Duration::from_millis(n("poll_ms")?.max(1)),
            restart_pause: Duration::from_millis(n("restart_pause_ms")?),
            status_tries: n("status_tries")?,
            log_max: n("log_max_bytes")?,
            log_keep: n("log_keep_lines")? as usize,
            excerpt_chars: n("excerpt_chars")? as usize,
            lock_dir: t("file_lock")?,
            log_file: t("file_log")?,
            checked_file: t("file_checked")?,
            installed_file: t("file_installed")?,
            tmp_prefix: t("tmp_prefix")?,
            prev_suffix: t("prev_suffix")?,
            kit_dir: t("kit_dir")?,
            kit_state: t("kit_state_file")?,
            kit_script: t("kit_script")?,
            kit_bundle: t("kit_bundle")?,
            kit_plugin: t("kit_bundle_plugin")?,
            kit_shell: t("kit_shell")?,
            sums_file: t("sums_file")?,
            lock_file: t("plugin_lock_file")?,
            tar_list: l("tar_list_cmd")?,
            tar_cat: l("tar_cat_cmd")?,
            tar_unpack: l("tar_unpack_cmd")?,
            curl_cmd: l("curl_cmd")?,
            curl_cmd_test: l("curl_cmd_test")?,
            wget_cmd: l("wget_cmd")?,
            attest_cmd: l("attest_cmd")?,
            attest_auth: l("attest_auth_cmd")?,
            git_init: l("git_init_cmd")?,
            git_fetch: l("git_fetch_cmd")?,
            git_archive: l("git_archive_cmd")?,
            engine_stop: t("engine_verb_stop")?,
            engine_serve: t("engine_verb_serve")?,
            engine_serve_args: l("engine_serve_args")?,
            engine_status: t("engine_verb_status")?,
            engine_version: t("engine_verb_version")?,
            member_engine: text(s, "install.member_engine")?,
            member_hook: text(s, "install.member_hook")?,
            plugin_dir_in_repo: t("plugin_dir_in_repo")?,
            setting_section: t("setting_section")?,
            setting_auto: l("setting_auto_words")?,
            words_on: l("words_on")?,
            arg_finish_restart: t("arg_finish_restart")?,
            engine_verb_update: t("engine_verb_update")?,
            flag_from_local: t("engine_flag_from_local")?,
            flag_source: t("engine_flag_source")?,
            flag_yes: t("engine_flag_yes")?,
            flag_force: t("engine_flag_force")?,
            source_release: t("install_source_release")?,
            source_file: t("install_source_file")?,
            stage_dir: t("stage_dir")?,
            asset_name: t("asset_name")?,
            routine_feature: t("routine_feature")?,
            record_file: t("install_record_file")?,
            engine_version_json: l("engine_version_json_args")?,
        })
    }
}

// ---- command line -------------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Opt {
    from: Option<PathBuf>,
    sha: Option<String>,
    channel: Option<String>,
    rollback: bool,
    auto: bool,
    yes: bool,
    dry: bool,
    extract_to: Option<PathBuf>,
    no_restart: bool,
    no_plugin: bool,
    verbose: bool,
    help: bool,
    live_select: Option<String>,
    launcher: Option<PathBuf>,
    finish_restart: bool,
    check_release: bool,
    force: bool,
}

fn parse(c: &Uc, args: &[String]) -> Result<Opt, String> {
    let mut o = Opt::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = || it.next().cloned().unwrap_or_default();
        match a.as_str() {
            "--from" => o.from = Some(PathBuf::from(val())),
            "--sha256" => o.sha = Some(val()),
            "--channel" => o.channel = Some(val()),
            "--rollback" => o.rollback = true,
            "--auto" => o.auto = true,
            "--yes" | "-y" => o.yes = true,
            "--dry-run" => o.dry = true,
            "--extract-to" => o.extract_to = Some(PathBuf::from(val())),
            "--no-restart" => o.no_restart = true,
            "--no-plugin" => o.no_plugin = true,
            "--check-release" => o.check_release = true,
            "--force" => o.force = true,
            "--live-select" => o.live_select = Some(val()),
            "--launcher" => o.launcher = Some(PathBuf::from(val())),
            "--config" => {
                val();
            }
            "-v" => o.verbose = true,
            "--json" => {}
            "-h" | "--help" => o.help = true,
            x if x == c.arg_finish_restart => o.finish_restart = true,
            other => return Err(other.to_string()),
        }
    }
    Ok(o)
}

fn is_sha(x: &str) -> bool {
    x.len() == 64 && x.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// The entry for `name` in a SHA256SUMS text (`<sha>  name` or `<sha> *name`).
fn sums_entry(t: &str, name: &str) -> Option<String> {
    t.lines().find_map(|l| {
        let mut f = l.split_whitespace();
        let (sha, file) = (f.next()?, f.next()?);
        (file == name || file.strip_prefix('*') == Some(name)).then(|| sha.to_string())
    })
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for e in fs::read_dir(from)? {
            let e = e?;
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

fn same_tree(a: &Path, b: &Path) -> bool {
    let names = |d: &Path| -> Option<Vec<std::ffi::OsString>> {
        let mut v: Vec<_> = fs::read_dir(d)
            .ok()?
            .flatten()
            .map(|e| e.file_name())
            .collect();
        v.sort();
        Some(v)
    };
    if a.is_dir() && b.is_dir() {
        let (Some(x), Some(y)) = (names(a), names(b)) else {
            return false;
        };
        return x == y && x.iter().all(|n| same_tree(&a.join(n), &b.join(n)));
    }
    a.is_file() && b.is_file() && fs::read(a).ok() == fs::read(b).ok()
}

fn stamp_dash(t: u64) -> String {
    let s = rec::stamp_name(t); // 20261130T005320Z
    format!("{}-{}", &s[..8], &s[9..15])
}

// ---- the run ---------------------------------------------------------------------------------------------------------------------

struct U<'a> {
    s: &'a Settings,
    c: Uc,
    o: Opt,
    test: bool,
    dir: PathBuf,
    bin: PathBuf,
    hook_bin: PathBuf,
    log: PathBuf,
    tmp: PathBuf,
    lockdir: PathBuf,
    have_lock: bool,
    proot: PathBuf,
    live: bool,
    kit: PathBuf,
    integ: Option<Integ>,
    itok: String,
    ilocked: bool,
    smoke_version: String,
    limit: Duration,
}

impl Drop for U<'_> {
    fn drop(&mut self) {
        self.install_unlock();
        if !self.tmp.as_os_str().is_empty() {
            let _ = fs::remove_dir_all(&self.tmp); // keep: the updater's own scratch directory
        }
        if self.have_lock {
            let _ = fs::remove_dir(&self.lockdir);
        }
    }
}

impl U<'_> {
    fn m(&self, key: &str, subs: &[(&str, &str)]) -> String {
        self.s.msg(key, subs)
    }

    /// One line to stdout (a closed pipe is ignored) and to the update log.
    fn say(&self, line: &str) {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
        rec::append_line(&self.log, self.c.log_max, self.c.log_keep, line);
    }

    fn vsay(&self, line: &str) {
        if self.o.verbose {
            self.say(line);
        }
    }

    fn run_in(
        &self,
        argv: &[String],
        envs: &[(&str, &Path)],
        out: Option<&Path>,
        limit: Duration,
    ) -> Ran {
        run_limited(argv, envs, out, limit, self.c.kill_grace, self.c.poll)
    }

    /// The state line of a failure that touched nothing.
    fn unchanged(&self) -> String {
        let kit_engine = self
            .kit
            .join(&self.c.kit_bundle)
            .join(&self.c.member_engine);
        let ub = if self.live && kit_engine.exists() {
            kit_engine
        } else {
            self.bin.clone()
        };
        let mut ver = String::new();
        if ub.exists() && self.tmp.is_dir() {
            let out = self.tmp.join("cur.out");
            let st = self.tmp.join("state");
            let root = self.s.text("env.plugin_root");
            let dirk = self.s.text("env.dir");
            let envs = [
                (root.as_str(), self.proot.as_path()),
                (dirk.as_str(), st.as_path()),
            ];
            let argv = vec![ub.display().to_string(), self.c.engine_version.clone()];
            if matches!(
                self.run_in(&argv, &envs, Some(&out), self.limit),
                Ran::Done(0)
            ) {
                ver = fs::read_to_string(&out)
                    .ok()
                    .and_then(|t| t.lines().next().map(str::to_string))
                    .unwrap_or_default();
            }
        }
        if ver.starts_with(|ch: char| ch.is_ascii_digit()) {
            self.m("msg.updater_unchanged_known", &[("version", &ver)])
        } else {
            self.m("msg.updater_unchanged_unknown", &[])
        }
    }

    /// A failure: what failed, what is installed now, one next step. Returns the exit code.
    fn fail(&mut self, key: &str, subs: &[(&str, &str)]) -> i32 {
        let body = self.m(key, subs);
        let mut parts = body.splitn(3, '\n').map(str::to_string);
        let (what, state, next) = (
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default(),
        );
        let un = if state.contains("{unchanged}") {
            self.unchanged()
        } else {
            String::new()
        };
        let state = fill(&state, &[("unchanged", &un)]);
        let line = self.m(
            "msg.updater_fail_frame",
            &[("what", &what), ("state", &state), ("next", &next)],
        );
        for l in line.lines() {
            self.say(l);
        }
        self.install_unlock();
        1
    }

    fn usage_err(&self, key: &str, subs: &[(&str, &str)]) -> i32 {
        let what = self.m(key, subs);
        let usage = self.m(
            "msg.updater_usage_hint",
            &[("stable", &self.c.ch_stable), ("dev", &self.c.ch_dev)],
        );
        crate::util::say(&self.m(
            "msg.updater_usage_frame",
            &[("what", &what), ("usage", &usage)],
        ));
        2
    }

    fn install_unlock(&mut self) {
        if self.ilocked {
            if let Some(i) = &self.integ {
                i.lock_give(&self.itok);
            }
            self.ilocked = false;
        }
    }

    /// Hold the shared install lock before bin/ is touched; a held lock fails the update with the old binary kept.
    fn install_lock(&mut self) -> bool {
        let Some(i) = &self.integ else { return true };
        if !i.lock_take(&self.itok, i.lock_wait) {
            let holder = fs::read_to_string(&i.owner_f).unwrap_or_default();
            let log = self.dir.join(self.s.text("files.integrity_log"));
            self.fail(
                "msg.updater_install_lock_held",
                &[
                    ("holder", holder.trim()),
                    ("log", &log.display().to_string()),
                ],
            );
            return false;
        }
        self.ilocked = true;
        true
    }

    fn record(&self) {
        if let Some(i) = &self.integ {
            i.record(); // under this update's hold: no check can run between the swap and the record
        }
    }

    /// `<binary> version` must answer within the limit with a version (and the expected one, if known).
    fn smoke(&mut self, binary: &Path, expected: &str) -> bool {
        let out = self.tmp.join("version.out");
        let st = self.tmp.join("state");
        let (root, dirk) = (self.s.text("env.plugin_root"), self.s.text("env.dir"));
        let envs = [
            (root.as_str(), self.proot.as_path()),
            (dirk.as_str(), st.as_path()),
        ];
        let b = binary.display().to_string();
        let argv = vec![b.clone(), self.c.engine_version.clone()];
        let r = self.run_in(&argv, &envs, Some(&out), self.limit);
        let first = fs::read_to_string(&out).unwrap_or_default();
        let head: String = first
            .chars()
            .take(self.c.excerpt_chars)
            .collect::<String>()
            .replace('\n', " ");
        match r {
            Ran::TimedOut => {
                self.say(&self.m(
                    "msg.updater_smoke_timeout",
                    &[
                        ("binary", &b),
                        ("seconds", &self.limit.as_secs().to_string()),
                    ],
                ));
                return false;
            }
            Ran::CannotStart => {
                self.say(&self.m(
                    "msg.updater_smoke_failed",
                    &[("binary", &b), ("code", "-1"), ("output", &head)],
                ));
                return false;
            }
            Ran::Done(code) if code != 0 => {
                self.say(&self.m(
                    "msg.updater_smoke_failed",
                    &[
                        ("binary", &b),
                        ("code", &code.to_string()),
                        ("output", &head),
                    ],
                ));
                return false;
            }
            Ran::Done(_) => {}
        }
        let reported = first.lines().next().unwrap_or("").to_string();
        if !reported.starts_with(|ch: char| ch.is_ascii_digit()) {
            self.say(&self.m(
                "msg.updater_smoke_not_version",
                &[("binary", &b), ("reported", &reported)],
            ));
            return false;
        }
        if !expected.is_empty() && !reported.contains(expected) {
            self.say(&self.m(
                "msg.updater_smoke_wrong_version",
                &[("reported", &reported), ("expected", expected)],
            ));
            return false;
        }
        self.smoke_version = reported;
        true
    }

    fn fetch(&self, url: &str, out: &Path) -> bool {
        let (conn, dl, max) = (
            self.c.connect_s.to_string(),
            self.c.download_s.to_string(),
            self.c.max_bytes.to_string(),
        );
        let o = out.display().to_string();
        let subs = [
            ("connect", conn.as_str()),
            ("max_time", dl.as_str()),
            ("max_size", max.as_str()),
            ("out", o.as_str()),
            ("url", url),
        ];
        let have = crate::install::on_path;
        let cmd = if self.test {
            &self.c.curl_cmd_test
        } else {
            &self.c.curl_cmd
        };
        let argv = if cmd.first().is_some_and(|p| have(p)) {
            subst(cmd, &subs)
        } else if self.c.wget_cmd.first().is_some_and(|p| have(p)) {
            subst(&self.c.wget_cmd, &subs)
        } else {
            return false;
        };
        matches!(
            self.run_in(
                &argv,
                &[],
                None,
                Duration::from_secs(self.c.download_s + self.c.connect_s)
            ),
            Ran::Done(0)
        )
    }

    fn have_downloader(&self) -> bool {
        let have = crate::install::on_path;
        self.c.curl_cmd.first().is_some_and(|p| have(p))
            || self.c.wget_cmd.first().is_some_and(|p| have(p))
    }

    /// The plugin root the daemon should load while the kit is live (the installed live plugin), else this plugin.
    fn kit_plugin_root(&self) -> PathBuf {
        let p = self.kit.join(&self.c.kit_bundle).join(&self.c.kit_plugin);
        if self.live && p.join("engine/defaults").is_dir() {
            p
        } else {
            self.proot.clone()
        }
    }

    fn engine_cmd(&self, verb: &str) -> Command {
        let mut cmd = Command::new(&self.bin);
        cmd.arg(verb)
            .env(self.s.text("env.plugin_root"), self.kit_plugin_root())
            .env(
                self.s.text("env.dir"),
                std::env::var(self.s.text("env.dir"))
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| self.dir.clone()),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd
    }

    /// The engine's own verbs: `stop` tells a running daemon to exit (no daemon is fine), `serve` starts the new one.
    fn restart_daemon(&self) {
        if self.o.no_restart {
            return self.say(&self.m("msg.updater_restart_skipped", &[]));
        }
        if self.o.auto {
            // the job runs under the daemon being replaced: finish the restart detached
            if let Ok(me) = std::env::current_exe() {
                let _ = Command::new(me)
                    .arg("--plugin-root")
                    .arg(self.kit_plugin_root())
                    .arg(self.s.text("launcher.cli_update_verb"))
                    .arg(&self.c.arg_finish_restart)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .process_group(0)
                    .spawn();
            }
            return self.say(&self.m("msg.updater_restart_scheduled", &[]));
        }
        let stop = self.tmp.join("stop.out");
        let (root, dirk) = (self.s.text("env.plugin_root"), self.s.text("env.dir"));
        let edir = std::env::var(&dirk)
            .map(PathBuf::from)
            .unwrap_or_else(|_| self.dir.clone());
        let kpr = self.kit_plugin_root();
        let envs = [
            (root.as_str(), kpr.as_path()),
            (dirk.as_str(), edir.as_path()),
        ];
        let b = self.bin.display().to_string();
        if !matches!(
            self.run_in(
                &[b.clone(), self.c.engine_stop.clone()],
                &envs,
                Some(&stop),
                self.limit
            ),
            Ran::Done(0)
        ) {
            self.vsay(&self.m("msg.updater_stop_nothing", &[]));
        }
        std::thread::sleep(self.c.restart_pause);
        let _ = self
            .engine_cmd(&self.c.engine_serve)
            .args(&self.c.engine_serve_args)
            .process_group(0)
            .spawn();
        for _ in 0..self.c.status_tries {
            let st = self.tmp.join("status.out");
            if matches!(
                self.run_in(
                    &[b.clone(), self.c.engine_status.clone()],
                    &envs,
                    Some(&st),
                    self.limit
                ),
                Ran::Done(0)
            ) {
                return self.say(&self.m("msg.updater_restarted", &[("binary", &b)]));
            }
            std::thread::sleep(self.c.restart_pause);
        }
        self.say(&self.m("msg.updater_restart_unconfirmed", &[]));
    }

    /// The detached tail of an automatic update: stop the old daemon, start the new one.
    fn finish_restart(&self) -> i32 {
        std::thread::sleep(self.c.restart_pause);
        let _ = self.engine_cmd(&self.c.engine_stop).status();
        std::thread::sleep(self.c.restart_pause);
        let _ = self
            .engine_cmd(&self.c.engine_serve)
            .args(&self.c.engine_serve_args)
            .process_group(0)
            .spawn();
        0
    }

    fn lock_field(&self, key: &str) -> String {
        let lock = self.proot.join(&self.c.lock_file);
        let v: Option<serde_json::Value> = fs::read_to_string(lock)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok());
        let Some(v) = v else { return String::new() };
        v.get(key)
            .or_else(|| v.get("assets").and_then(|a| a.get(key)))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    }

    /// The engine.autoUpdate setting: the environment first, then the settings file.
    fn auto_setting(&self, base: &Path) -> String {
        if let Some(v) = env_nonempty(&self.s.text("env.auto_update"))
            .filter(|v| v.chars().all(|c| c.is_ascii_alphanumeric()))
        {
            return v;
        }
        let Ok(t) = fs::read_to_string(base.join(self.s.text("install.settings_file"))) else {
            return String::new();
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
            return String::new();
        };
        let sec = v.get(&self.c.setting_section);
        self.c
            .setting_auto
            .iter()
            .find_map(|k| sec.and_then(|s| s.get(k)))
            .map(|x| match x {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .unwrap_or_default()
    }
}

/// `ah-hook update ...`. Exit 0 done / current / nothing to do, 1 failed, 2 usage, 3 --yes needed.
pub fn run(
    s: &Settings,
    state: &Path,
    base: &Path,
    plugin_root: Option<&Path>,
    args: &[String],
) -> i32 {
    crate::limits::restore_cpu_limit(); // a maintenance verb, not a hook call
    let c = match Uc::load(s) {
        Ok(c) => c,
        Err(key) => {
            crate::util::say(&s.msg("msg.launcher_update_no_settings", &[("key", &key)]));
            return 1;
        }
    };
    let test = env_nonempty(&s.text("launcher.test_flag_env")).is_some_and(|v| v == "1");
    let o = match parse(&c, args) {
        Ok(o) => o,
        Err(bad) => {
            let u = s.msg(
                "msg.updater_usage_hint",
                &[("stable", &c.ch_stable), ("dev", &c.ch_dev)],
            );
            let w = s.msg("msg.updater_unknown_arg", &[("arg", &bad)]);
            crate::util::say(&s.msg("msg.updater_usage_frame", &[("what", &w), ("usage", &u)]));
            return 2;
        }
    };
    if o.help {
        let _ = writeln!(std::io::stdout(), "{}", s.text("msg.updater_help"));
        return 0;
    }
    let knob = |k: &str| -> Option<String> {
        if test {
            env_nonempty(&s.text(&format!("launcher.knob_{k}")))
        } else {
            None
        }
    };
    let mut c = c;
    if let Some(v) = knob("update_api_base") {
        c.api_base = v;
    }
    if let Some(v) = knob("update_download_base") {
        c.download_base = v;
    }
    if let Some(v) = knob("update_git_url") {
        c.git_url = v;
    }
    let kit = env_nonempty(&s.text("env.live_kit"))
        .map(PathBuf::from)
        .unwrap_or_else(|| base.join(&c.kit_dir));
    let proot = plugin_root.map(Path::to_path_buf).unwrap_or_default();
    let limit = Duration::from_secs(c.run_s);
    let mut u = U {
        s,
        test,
        dir: state.to_path_buf(),
        bin: state.join("bin").join(&c.member_engine),
        hook_bin: state.join("bin").join(&c.member_hook),
        log: state.join(&c.log_file),
        tmp: PathBuf::new(),
        lockdir: state.join(&c.lock_dir),
        have_lock: false,
        proot,
        live: false,
        kit,
        integ: Integ::new(s, state),
        itok: format!("{} {}", std::process::id(), epoch_s()),
        ilocked: false,
        smoke_version: String::new(),
        limit,
        c,
        o,
    };
    if u.o.finish_restart {
        return u.finish_restart();
    }
    if state.as_os_str().is_empty() {
        crate::util::say(&u.m("msg.updater_no_home", &[]));
        return 1;
    }
    if fs::create_dir_all(state.join("bin")).is_err() {
        crate::util::say(&u.m(
            "msg.updater_cannot_create_bin",
            &[("path", &state.join("bin").display().to_string())],
        ));
        return 1;
    }
    u.main(base)
}

impl U<'_> {
    fn main(&mut self, base: &Path) -> i32 {
        // ---- auto mode: setting + daily limit
        if self.o.auto {
            let setting = self.auto_setting(base);
            if setting == self.c.ch_stable || setting == self.c.ch_dev {
                self.o.channel = Some(setting);
            } else if self.c.words_on.contains(&setting.to_lowercase()) {
                self.o.channel = Some(self.c.default_channel.clone());
            } else {
                return 0;
            }
            let now = epoch_s();
            let last: u64 = fs::read_to_string(self.dir.join(&self.c.checked_file))
                .ok()
                .and_then(|t| t.trim().parse().ok())
                .unwrap_or(0);
            if now > 0 && now.saturating_sub(last) < self.c.auto_interval_s {
                return 0;
            }
            let _ = fs::write(self.dir.join(&self.c.checked_file), format!("{now}\n"));
            self.o.yes = true;
        }
        // ---- argument sanity
        let n = usize::from(self.o.from.is_some())
            + usize::from(self.o.channel.is_some())
            + usize::from(self.o.rollback);
        if n == 0 && !self.o.check_release {
            return self.usage_err("msg.updater_usage_nothing", &[]);
        }
        if n > 1 {
            return self.usage_err("msg.updater_usage_several", &[]);
        }
        if let Some(ch) = &self.o.channel
            && *ch != self.c.ch_stable
            && *ch != self.c.ch_dev
        {
            let ch = ch.clone();
            return self.usage_err(
                "msg.updater_usage_channel",
                &[
                    ("channel", &ch),
                    ("stable", &self.c.ch_stable.clone()),
                    ("dev", &self.c.ch_dev.clone()),
                ],
            );
        }
        if let Some(sh) = &self.o.sha
            && !is_sha(sh)
        {
            return self.usage_err("msg.updater_usage_sha", &[]);
        }
        if let Some(f) = &self.o.from
            && !f.is_file()
        {
            let f = f.display().to_string();
            return self.usage_err("msg.updater_usage_nofile", &[("path", &f)]);
        }
        // ---- one update at a time; a lock older than stale_lock_s is stale
        if fs::create_dir(&self.lockdir).is_err() {
            let old = fs::metadata(&self.lockdir)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|a| a.as_secs() > self.c.stale_lock_s);
            if !(old
                && fs::remove_dir(&self.lockdir).is_ok()
                && fs::create_dir(&self.lockdir).is_ok())
            {
                let l = self.lockdir.display().to_string();
                return self.fail("msg.updater_another_running", &[("lock", &l)]);
            }
        }
        self.have_lock = true;
        self.tmp = self
            .dir
            .join(format!("{}{}", self.c.tmp_prefix, std::process::id()));
        let _ = fs::remove_dir_all(&self.tmp);
        if fs::create_dir_all(&self.tmp).is_err() {
            let (t, d) = (
                self.tmp.display().to_string(),
                self.dir.display().to_string(),
            );
            return self.fail("msg.updater_cannot_create_tmp", &[("tmp", &t), ("dir", &d)]);
        }
        // ---- environment
        self.live = self.kit.join(&self.c.kit_state).is_file()
            && self.kit.join(&self.c.kit_script).is_file();
        if self.o.check_release {
            return self.check_release();
        }
        if self.o.rollback {
            return self.rollback();
        }
        self.update()
    }

    fn live_select(&self) -> String {
        self.o
            .live_select
            .clone()
            .unwrap_or_else(|| self.s.text("updater.live_select_default"))
    }

    /// Run the kit's go-live script.
    fn go_live(&self, out: &Path) -> bool {
        let script = self.kit.join(&self.c.kit_script).display().to_string();
        let argv = vec![self.c.kit_shell.clone(), script, self.live_select()];
        matches!(
            self.run_in(&argv, &[], Some(out), Duration::from_secs(self.c.live_s)),
            Ran::Done(0)
        )
    }

    fn tail_to_stderr(&self, p: &Path, n: usize) {
        if let Ok(t) = fs::read_to_string(p) {
            let lines: Vec<&str> = t.lines().collect();
            for l in &lines[lines.len().saturating_sub(n)..] {
                crate::util::say(l);
            }
        }
    }

    fn rollback(&mut self) -> i32 {
        let bin = self.bin.clone();
        let (kit, log) = (
            self.kit.display().to_string(),
            self.log.display().to_string(),
        );
        if self.live {
            let pre = format!(
                "{}{}",
                self.c.kit_bundle,
                self.s.text("updater.kit_pre_update")
            );
            let mut prevs: Vec<PathBuf> = fs::read_dir(&self.kit)
                .map(|rd| {
                    rd.flatten()
                        .map(|e| e.path())
                        .filter(|p| {
                            p.file_name()
                                .is_some_and(|n| n.to_string_lossy().starts_with(&pre))
                        })
                        .collect()
                })
                .unwrap_or_default();
            prevs.sort();
            let Some(prev) = prevs
                .pop()
                .filter(|p| p.join(&self.c.member_engine).exists())
            else {
                return self.fail("msg.updater_rb_live_none", &[("kit", &kit)]);
            };
            let pe = prev.join(&self.c.member_engine);
            if !self.smoke(&pe, "") {
                return self.fail(
                    "msg.updater_rb_live_prev_broken",
                    &[("path", &pe.display().to_string())],
                );
            }
            if self.o.dry {
                return {
                    self.say(&self.m(
                        "msg.updater_dry_rb_live",
                        &[
                            ("prev", &prev.display().to_string()),
                            ("version", &self.smoke_version.clone()),
                        ],
                    ));
                    0
                };
            }
            let ts = stamp_dash(epoch_s());
            if !self.install_lock() {
                return 1;
            }
            let bundle = self.kit.join(&self.c.kit_bundle);
            let aside = self.kit.join(format!(
                "{}{}{ts}",
                self.c.kit_bundle,
                self.s.text("updater.kit_pre_rollback")
            ));
            if fs::rename(&bundle, &aside).is_err() {
                return self.fail(
                    "msg.updater_rb_live_cannot_aside",
                    &[("bundle", &bundle.display().to_string()), ("kit", &kit)],
                );
            }
            if fs::rename(&prev, &bundle).is_err() {
                let _ = fs::rename(&aside, &bundle);
                return self.fail(
                    "msg.updater_rb_live_cannot_restore",
                    &[
                        ("prev", &prev.display().to_string()),
                        ("bundle", &bundle.display().to_string()),
                        ("kit", &kit),
                    ],
                );
            }
            let out = self.tmp.join("golive.out");
            if !self.go_live(&out) {
                self.tail_to_stderr(&out, 5);
                let failed = self.kit.join(format!(
                    "{}{}{ts}",
                    self.c.kit_bundle,
                    self.s.text("updater.kit_failed")
                ));
                let _ = fs::rename(&bundle, &failed);
                let _ = fs::rename(&aside, &bundle);
                return self.fail(
                    "msg.updater_rb_live_golive",
                    &[
                        ("bundle", &bundle.display().to_string()),
                        ("failed", &failed.display().to_string()),
                        ("log", &log),
                        ("kit", &kit),
                        ("select", &self.live_select()),
                    ],
                );
            }
            self.record();
            self.install_unlock();
            self.say(&self.m(
                "msg.updater_rolled_back_live",
                &[
                    ("version", &self.smoke_version.clone()),
                    ("aside", &aside.display().to_string()),
                ],
            ));
            return 0;
        }
        let prev = self.prev_of(&bin);
        if !prev.exists() {
            return self.fail(
                "msg.updater_rb_none",
                &[("prev", &prev.display().to_string())],
            );
        }
        if !self.smoke(&prev, "") {
            return self.fail(
                "msg.updater_rb_prev_broken",
                &[("prev", &prev.display().to_string())],
            );
        }
        if self.o.dry {
            self.say(&self.m(
                "msg.updater_dry_rb",
                &[
                    ("prev", &prev.display().to_string()),
                    ("version", &self.smoke_version.clone()),
                ],
            ));
            return 0;
        }
        if !self.install_lock() {
            return 1;
        }
        let swap = bin.with_extension(format!("swap.{}", std::process::id()));
        if bin.is_file() && fs::copy(&bin, &swap).is_err() {
            return self.fail(
                "msg.updater_rb_cannot_copy",
                &[
                    ("bin", &bin.display().to_string()),
                    ("bindir", &self.dir.join("bin").display().to_string()),
                ],
            );
        }
        if fs::rename(&prev, &bin).is_err() {
            return self.fail(
                "msg.updater_rb_cannot_move",
                &[
                    ("prev", &prev.display().to_string()),
                    ("bin", &bin.display().to_string()),
                    ("bindir", &self.dir.join("bin").display().to_string()),
                ],
            );
        }
        if swap.is_file() {
            let _ = fs::rename(&swap, &prev);
        }
        self.rollback_hook();
        self.record();
        self.install_unlock();
        self.say(&self.m(
            "msg.updater_rolled_back",
            &[
                ("bin", &bin.display().to_string()),
                ("version", &self.smoke_version.clone()),
            ],
        ));
        self.restart_daemon();
        0
    }

    fn prev_of(&self, p: &Path) -> PathBuf {
        let mut o = p.as_os_str().to_os_string();
        o.push(&self.c.prev_suffix);
        PathBuf::from(o)
    }

    /// The thin client goes back with the engine when an update left a `.prev` of it and that one passes its own self-test.
    fn rollback_hook(&mut self) {
        let prev = self.prev_of(&self.hook_bin);
        if !prev.is_file() {
            return;
        }
        if !self.selftest(&prev, &self.bin.clone()) {
            return self.say(&self.m(
                "msg.updater_hook_rb_skipped",
                &[("prev", &prev.display().to_string())],
            ));
        }
        let swap = self
            .hook_bin
            .with_extension(format!("swap.{}", std::process::id()));
        if self.hook_bin.is_file() && fs::copy(&self.hook_bin, &swap).is_err() {
            return;
        }
        if fs::rename(&prev, &self.hook_bin).is_ok() && swap.is_file() {
            let _ = fs::rename(&swap, &prev);
            self.say(&self.m(
                "msg.updater_hook_rolled_back",
                &[("path", &self.hook_bin.display().to_string())],
            ));
        }
    }

    /// `<launcher> --selftest --engine <engine>`: the launcher must accept the engine.
    fn selftest(&self, launcher: &Path, engine: &Path) -> bool {
        let out = self.tmp.join("selftest.out");
        let st = self.tmp.join("state");
        let (root, dirk) = (self.s.text("env.plugin_root"), self.s.text("env.dir"));
        let envs = [
            (root.as_str(), self.proot.as_path()),
            (dirk.as_str(), st.as_path()),
        ];
        let argv = vec![
            launcher.display().to_string(),
            self.s.text("updater.selftest_flag"),
            self.s.text("updater.selftest_engine_flag"),
            engine.display().to_string(),
        ];
        let r = self.run_in(
            &argv,
            &envs,
            Some(&out),
            Duration::from_secs(self.c.selftest_s),
        );
        matches!(r, Ran::Done(0))
    }

    fn update(&mut self) -> i32 {
        let (bin, dir) = (self.bin.clone(), self.dir.clone());
        let bindir = dir.join("bin");
        // ---- target
        let triple = if let Some(t) = if self.test {
            env_nonempty(&self.s.text("launcher.knob_update_triple"))
        } else {
            None
        } {
            t
        } else {
            crate::install::platform_triple(self.s, self.test)
        };
        if (triple.is_empty() || triple == self.s.text("msg.install_unsupported"))
            && self.o.from.is_none()
        {
            return self.fail("msg.updater_unsupported", &[]);
        }
        // ---- obtain the candidate: tmp/asset (the file whose sha256 is verified)
        let asset_path = self.tmp.join("asset");
        let mut want_version = String::new();
        let mut commit = String::new();
        let mut tag = String::new();
        let src_label;
        let channel = self.o.channel.clone();
        if let Some(from) = self.o.from.clone() {
            let base = from
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if fs::copy(&from, &asset_path).is_err() {
                return self.fail(
                    "msg.updater_cannot_read",
                    &[("path", &from.display().to_string())],
                );
            }
            let got = sha256_file(&asset_path).unwrap_or_default();
            let (mut expected, mut expect_src) = (String::new(), String::new());
            if let Some(x) = self.o.sha.clone() {
                expected = x;
                expect_src = self.s.text("updater.src_sha_arg");
            } else {
                let sums = from
                    .parent()
                    .map(|p| p.join(&self.c.sums_file))
                    .unwrap_or_default();
                if let Some(e) = fs::read_to_string(&sums)
                    .ok()
                    .and_then(|t| sums_entry(&t, &base))
                    .filter(|e| is_sha(e))
                {
                    expected = e;
                    expect_src = sums.display().to_string();
                }
                if expected.is_empty() {
                    let e = self.lock_field(&base);
                    if is_sha(&e) {
                        expected = e;
                        expect_src = self.proot.join(&self.c.lock_file).display().to_string();
                    }
                }
            }
            if !expected.is_empty() {
                if got != expected {
                    return self.fail(
                        "msg.updater_sha_mismatch_file",
                        &[
                            ("name", &base),
                            ("expected", &expected),
                            ("src", &expect_src),
                            ("got", &got),
                        ],
                    );
                }
                self.say(&self.m(
                    "msg.updater_verified_file",
                    &[("name", &base), ("src", &expect_src)],
                ));
            } else {
                self.say(&self.m("msg.updater_no_expected", &[("name", &base)]));
                self.say(&self.m("msg.updater_sha_is", &[("name", &base), ("sha", &got)]));
                if !self.o.yes {
                    self.say(&self.m("msg.updater_unverifiable_what", &[("name", &base)]));
                    let un = self.unchanged();
                    self.say(&self.m("msg.updater_unverifiable_state", &[("unchanged", &un)]));
                    self.say(&self.m("msg.updater_unverifiable_next", &[("sha", &got)]));
                    return 3;
                }
                self.say(&self.m("msg.updater_accepted_yes", &[]));
            }
            src_label = self.m(
                "msg.updater_label_file",
                &[("path", &from.display().to_string())],
            );
        } else {
            let channel = channel.unwrap_or_default();
            let prefix = if channel == self.c.ch_dev {
                self.c.pre_dev.clone()
            } else {
                self.c.pre_stable.clone()
            };
            if !self.have_downloader() {
                return self.fail("msg.updater_no_downloader", &[]);
            }
            let list = self.tmp.join("releases.out");
            let url = fill(
                &self.s.text("updater.releases_url"),
                &[
                    ("api", &self.c.api_base),
                    ("repo", &self.c.repo),
                    ("per_page", &self.c.per_page.to_string()),
                ],
            );
            if !self.fetch(&url, &list) {
                return self.fail(
                    "msg.updater_cannot_reach",
                    &[
                        ("api", &self.c.api_base.clone()),
                        ("repo", &self.c.repo.clone()),
                        ("channel", &channel),
                    ],
                );
            }
            let found = fs::read_to_string(&list)
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|v| {
                    v.as_array()?
                        .iter()
                        .filter_map(|r| r.get("tag_name").and_then(|t| t.as_str()))
                        .find(|t| {
                            t.starts_with(&prefix)
                                && t.len() > prefix.len()
                                && t[prefix.len()..].chars().all(|ch| {
                                    ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')
                                })
                        })
                        .map(str::to_string)
                });
            let Some(t) = found else {
                let other = if channel == self.c.ch_dev {
                    self.c.ch_stable.clone()
                } else {
                    self.c.ch_dev.clone()
                };
                return self.fail(
                    "msg.updater_no_build",
                    &[
                        ("channel", &channel),
                        ("prefix", &prefix),
                        ("per_page", &self.c.per_page.to_string()),
                        ("repo", &self.c.repo.clone()),
                        ("other", &other),
                    ],
                );
            };
            tag = t;
            if channel == self.c.ch_stable {
                want_version = tag[self.c.pre_stable.len()..].to_string();
            }
            // an automatic update never replaces a local or hand-installed build with a release that is not strictly newer
            if self.o.auto && self.auto_not_newer(&channel, &want_version, &tag) {
                return 0;
            }
            let asset = fill(
                &self.s.text("updater.asset_name"),
                &[("tag", &tag), ("triple", &triple)],
            );
            self.say(&self.m(
                "msg.updater_channel_latest",
                &[("channel", &channel), ("tag", &tag), ("asset", &asset)],
            ));
            let dl = |name: &str| {
                fill(
                    &self.s.text("updater.download_url"),
                    &[
                        ("base", &self.c.download_base),
                        ("tag", &tag),
                        ("name", name),
                    ],
                )
            };
            if !self.fetch(&dl(&self.c.sums_asset), &self.tmp.join("SUMS")) {
                return self.fail(
                    "msg.updater_no_sums",
                    &[
                        ("sums", &self.c.sums_asset.clone()),
                        ("tag", &tag),
                        ("channel", &channel),
                    ],
                );
            }
            if !self.fetch(&dl(&asset), &asset_path) {
                return self.fail(
                    "msg.updater_no_asset",
                    &[
                        ("asset", &asset),
                        ("tag", &tag),
                        ("triple", &triple),
                        ("channel", &channel),
                    ],
                );
            }
            let expected = fs::read_to_string(self.tmp.join("SUMS"))
                .ok()
                .and_then(|t| sums_entry(&t, &asset))
                .unwrap_or_default();
            if !is_sha(&expected) {
                return self.fail(
                    "msg.updater_sums_no_entry",
                    &[
                        ("sums", &self.c.sums_asset.clone()),
                        ("tag", &tag),
                        ("asset", &asset),
                        ("channel", &channel),
                    ],
                );
            }
            let got = sha256_file(&asset_path).unwrap_or_default();
            if got != expected {
                return self.fail(
                    "msg.updater_sha_mismatch_dl",
                    &[
                        ("asset", &asset),
                        ("sums", &self.c.sums_asset.clone()),
                        ("expected", &expected),
                        ("got", &got),
                        ("repo", &self.c.repo.clone()),
                    ],
                );
            }
            self.say(&self.m(
                "msg.updater_verified_dl",
                &[("asset", &asset), ("sums", &self.c.sums_asset.clone())],
            ));
            if channel == self.c.ch_stable && self.lock_field("version") == want_version {
                let lk = self.lock_field(&asset);
                if is_sha(&lk) {
                    if lk != got {
                        return self.fail(
                            "msg.updater_differs_from_lock",
                            &[("asset", &asset), ("lock", &lk)],
                        );
                    }
                    self.say(&self.m("msg.updater_verified_lock", &[]));
                }
            }
            // build attestation
            let a_asset = asset_path.display().to_string();
            let asub = [("asset", a_asset.as_str()), ("repo", self.c.repo.as_str())];
            let have = crate::install::on_path;
            if self.test
                && env_nonempty(&self.s.text("launcher.knob_update_no_attest"))
                    .is_some_and(|v| v == "1")
            {
                self.say(&self.m("msg.updater_attest_test", &[]));
            } else if self.c.attest_cmd.first().is_some_and(|p| have(p)) {
                let out = self.tmp.join("attest.out");
                if matches!(
                    self.run_in(
                        &subst(&self.c.attest_cmd, &asub),
                        &[],
                        Some(&out),
                        Duration::from_secs(self.c.download_s)
                    ),
                    Ran::Done(0)
                ) {
                    self.say(&self.m(
                        "msg.updater_verified_attest",
                        &[("asset", &asset), ("repo", &self.c.repo.clone())],
                    ));
                } else if !matches!(
                    self.run_in(&self.c.attest_auth, &[], None, self.limit),
                    Ran::Done(0)
                ) {
                    self.say(&self.m("msg.updater_attest_not_logged_in", &[]));
                } else {
                    self.tail_to_stderr(&out, 3);
                    return self.fail(
                        "msg.updater_attest_failed",
                        &[("asset", &asset), ("repo", &self.c.repo.clone())],
                    );
                }
            } else {
                self.say(&self.m("msg.updater_attest_no_gh", &[]));
            }
            if channel == self.c.ch_dev
                && self.fetch(&dl(&self.c.commit_asset), &self.tmp.join("COMMIT"))
            {
                let c: String = fs::read_to_string(self.tmp.join("COMMIT"))
                    .unwrap_or_default()
                    .chars()
                    .filter(|ch| !ch.is_whitespace())
                    .collect();
                if c.len() == 40 && c.chars().all(|ch| matches!(ch, '0'..='9' | 'a'..='f')) {
                    commit = c;
                }
            }
            src_label = self.m(
                "msg.updater_label_channel",
                &[("channel", &channel), ("tag", &tag)],
            );
        }
        let channel = self.o.channel.clone().unwrap_or_default();

        // ---- extract the binaries: <top>/ah-engine (and <top>/ah-hook) of a release archive, or the file itself when it is not one
        let new_engine = self.tmp.join("new");
        let new_hook = self.tmp.join("new-hook");
        let a = asset_path.display().to_string();
        let list_out = self.tmp.join("members.out");
        let is_archive = matches!(
            self.run_in(
                &subst(&self.c.tar_list, &[("archive", &a)]),
                &[],
                Some(&list_out),
                self.limit
            ),
            Ran::Done(0)
        );
        let mut have_hook = false;
        if is_archive {
            let members = fs::read_to_string(&list_out).unwrap_or_default();
            let find = |name: &str| {
                members
                    .lines()
                    .find(|l| {
                        l.split('/').count() == 2
                            && l.ends_with(&format!("/{name}"))
                            && !l.starts_with('/')
                    })
                    .map(str::to_string)
            };
            let Some(me) = find(&self.c.member_engine) else {
                return self.fail("msg.updater_no_member", &[]);
            };
            let ex = |member: &str, dest: &Path| {
                matches!(
                    self.run_in(
                        &subst(&self.c.tar_cat, &[("archive", &a), ("member", member)]),
                        &[],
                        Some(dest),
                        self.limit
                    ),
                    Ran::Done(0)
                )
            };
            if !ex(&me, &new_engine) {
                return self.fail("msg.updater_cannot_extract", &[("member", &me)]);
            }
            if let Some(mh) = find(&self.c.member_hook)
                && ex(&mh, &new_hook)
                && fs::metadata(&new_hook).is_ok_and(|m| m.len() > 0)
            {
                have_hook = true;
                make_exec(&new_hook);
            }
        } else if fs::copy(&asset_path, &new_engine).is_err() {
            return self.fail(
                "msg.updater_cannot_stage",
                &[
                    ("tmp", &self.tmp.display().to_string()),
                    ("dir", &dir.display().to_string()),
                ],
            );
        }
        if fs::metadata(&new_engine).map_or(true, |m| m.len() == 0) {
            return self.fail("msg.updater_empty", &[]);
        }
        make_exec(&new_engine);

        // ---- smoke test
        if !self.smoke(&new_engine, &want_version) {
            return self.fail(
                "msg.updater_smoke_rejected",
                &[
                    ("bin", &bin.display().to_string()),
                    ("stable", &self.c.ch_stable.clone()),
                    ("repo", &self.c.repo.clone()),
                ],
            );
        }
        self.say(&self.m(
            "msg.updater_smoke_ok",
            &[("version", &self.smoke_version.clone())],
        ));

        // ---- launcher self-test: the launcher (the candidate's own when the archive ships one) must accept the candidate engine
        let launcher = self
            .o
            .launcher
            .clone()
            .or_else(|| have_hook.then(|| new_hook.clone()))
            .or_else(|| std::env::current_exe().ok());
        match &launcher {
            Some(l) if l.is_file() => {
                let out = self.tmp.join("selftest.out");
                let st = self.tmp.join("state");
                let (root, dirk) = (self.s.text("env.plugin_root"), self.s.text("env.dir"));
                let envs = [
                    (root.as_str(), self.proot.as_path()),
                    (dirk.as_str(), st.as_path()),
                ];
                let argv = vec![
                    l.display().to_string(),
                    self.s.text("updater.selftest_flag"),
                    self.s.text("updater.selftest_engine_flag"),
                    new_engine.display().to_string(),
                ];
                let r = self.run_in(
                    &argv,
                    &envs,
                    Some(&out),
                    Duration::from_secs(self.c.selftest_s),
                );
                if !matches!(r, Ran::Done(0)) {
                    let code = match r {
                        Ran::Done(c) => c.to_string(),
                        Ran::TimedOut => self.m(
                            "msg.updater_selftest_timeout",
                            &[("seconds", &self.c.selftest_s.to_string())],
                        ),
                        Ran::CannotStart => "-1".into(),
                    };
                    let head: String = fs::read_to_string(&out)
                        .unwrap_or_default()
                        .chars()
                        .take(self.c.excerpt_chars)
                        .collect::<String>()
                        .replace('\n', " ");
                    self.say(&self.m("msg.updater_selftest_line", &[("output", &head)]));
                    return self.fail(
                        "msg.updater_selftest_rejected",
                        &[
                            ("code", &code),
                            ("bin", &bin.display().to_string()),
                            ("launcher", &l.display().to_string()),
                            ("stable", &self.c.ch_stable.clone()),
                        ],
                    );
                }
                self.say(&self.m(
                    "msg.updater_selftest_ok",
                    &[("launcher", &l.display().to_string())],
                ));
            }
            Some(l) if self.o.launcher.is_some() => {
                return self.fail(
                    "msg.updater_launcher_not_exec",
                    &[
                        ("launcher", &l.display().to_string()),
                        ("bin", &bin.display().to_string()),
                    ],
                );
            }
            _ => self.say(&self.m("msg.updater_selftest_skipped", &[])),
        }
        let newsha = sha256_file(&new_engine).unwrap_or_default();
        let cursha = if bin.is_file() {
            sha256_file(&bin).unwrap_or_default()
        } else {
            String::new()
        };

        if let Some(to) = self.o.extract_to.clone() {
            if fs::copy(&new_engine, &to).is_err() {
                return self.fail(
                    "msg.updater_cannot_extract_to",
                    &[("path", &to.display().to_string())],
                );
            }
            make_exec(&to);
            if !commit.is_empty() {
                let mut c = to.as_os_str().to_os_string();
                c.push(self.s.text("updater.commit_suffix"));
                let _ = fs::write(PathBuf::from(c), format!("{commit}\n"));
            }
            let c_note = if commit.is_empty() {
                String::new()
            } else {
                self.m("msg.updater_commit_note", &[("commit", &commit)])
            };
            self.say(&self.m(
                "msg.updater_extracted",
                &[
                    ("version", &self.smoke_version.clone()),
                    ("label", &src_label),
                    ("sha", &newsha),
                    ("path", &to.display().to_string()),
                    ("commit_note", &c_note),
                ],
            ));
            return 0;
        }

        // ---- dev channel on a live kit: the matching plugin files (the commit recorded in the pre-release)
        let mut newplug: Option<PathBuf> = None;
        if channel == self.c.ch_dev && !self.o.no_plugin {
            if self.live {
                if commit.is_empty() {
                    return self.fail(
                        "msg.updater_no_commit",
                        &[
                            ("tag", &tag),
                            ("commit_asset", &self.c.commit_asset.clone()),
                            ("channel", &channel),
                        ],
                    );
                }
                let have = crate::install::on_path;
                if !self.c.git_init.first().is_some_and(|p| have(p)) {
                    return self.fail("msg.updater_no_git", &[("channel", &channel)]);
                }
                if !self.c.tar_unpack.first().is_some_and(|p| have(p)) {
                    return self.fail("msg.updater_no_tar", &[]);
                }
                let g = self.tmp.join("git");
                let srcdir = self.tmp.join("src");
                let _ = fs::create_dir_all(&g);
                let _ = fs::create_dir_all(&srcdir);
                let gs = g.display().to_string();
                if !matches!(
                    self.run_in(
                        &subst(&self.c.git_init, &[("dir", &gs)]),
                        &[],
                        None,
                        self.limit
                    ),
                    Ran::Done(0)
                ) {
                    return self.fail(
                        "msg.updater_git_init",
                        &[("dir", &gs), ("state", &dir.display().to_string())],
                    );
                }
                let out = self.tmp.join("git.out");
                let prompt = self.s.text("updater.git_noprompt_env");
                let envs = [(prompt.as_str(), Path::new("0"))];
                if !matches!(
                    self.run_in(
                        &subst(
                            &self.c.git_fetch,
                            &[("dir", &gs), ("url", &self.c.git_url), ("commit", &commit)]
                        ),
                        &envs,
                        Some(&out),
                        Duration::from_secs(self.c.git_s)
                    ),
                    Ran::Done(0)
                ) {
                    self.tail_to_stderr(&out, 3);
                    return self.fail(
                        "msg.updater_git_fetch",
                        &[
                            ("commit", &commit),
                            ("url", &self.c.git_url.clone()),
                            ("channel", &channel),
                        ],
                    );
                }
                let tarf = self.tmp.join("plugin.tar");
                let (ts, ss) = (tarf.display().to_string(), srcdir.display().to_string());
                let ok = matches!(
                    self.run_in(
                        &subst(
                            &self.c.git_archive,
                            &[
                                ("dir", &gs),
                                ("out", &ts),
                                ("path", &self.c.plugin_dir_in_repo)
                            ]
                        ),
                        &[],
                        None,
                        self.limit
                    ),
                    Ran::Done(0)
                ) && matches!(
                    self.run_in(
                        &subst(&self.c.tar_unpack, &[("archive", &ts), ("dest", &ss)]),
                        &[],
                        None,
                        self.limit
                    ),
                    Ran::Done(0)
                );
                if !ok {
                    return self.fail(
                        "msg.updater_git_archive",
                        &[
                            ("path", &self.c.plugin_dir_in_repo.clone()),
                            ("commit", &commit),
                            ("channel", &channel),
                        ],
                    );
                }
                let np = srcdir.join(&self.c.plugin_dir_in_repo);
                if !np.join("engine/defaults/index.toml").is_file() {
                    return self.fail(
                        "msg.updater_plugin_incomplete",
                        &[("commit", &commit), ("channel", &channel)],
                    );
                }
                self.say(&self.m(
                    "msg.updater_plugin_fetched",
                    &[
                        ("commit", &commit),
                        ("path", &self.c.plugin_dir_in_repo.clone()),
                    ],
                ));
                newplug = Some(np);
            } else {
                self.say(&self.m("msg.updater_plugin_not_synced", &[]));
            }
        }

        if self.o.dry {
            self.say(&self.m(
                "msg.updater_dry_run",
                &[
                    ("version", &self.smoke_version.clone()),
                    ("label", &src_label),
                    ("sha", &newsha),
                ],
            ));
            return 0;
        }

        // ---- install
        if self.live {
            return self.install_live(&new_engine, &newsha, &src_label, newplug, &commit);
        }
        if !cursha.is_empty() && cursha == newsha && !(have_hook && self.hook_differs(&new_hook)) {
            self.say(&self.m(
                "msg.updater_already_current",
                &[("bin", &bin.display().to_string()), ("sha", &newsha)],
            ));
            return 0;
        }
        // the ONE install routine (the engine's `update --from-local`): it keeps a rollback copy, validates the running result and rolls
        // back by itself. This client only fetched and verified; it installs by itself only when the routine cannot be started.
        let source = if channel.is_empty() {
            self.c.source_file.clone()
        } else {
            self.c.source_release.clone()
        };
        if let Some(code) = self.delegate_install(
            &new_engine,
            have_hook.then_some(new_hook.as_path()),
            &source,
        ) {
            return code;
        }
        let staged = bin.with_extension(format!("new.{}", std::process::id()));
        if fs::copy(&new_engine, &staged).is_err() {
            return self.fail(
                "msg.updater_cannot_copy_new",
                &[
                    ("bin", &bin.display().to_string()),
                    ("bindir", &bindir.display().to_string()),
                ],
            );
        }
        make_exec(&staged);
        if !self.install_lock() {
            let _ = fs::remove_file(&staged);
            return 1;
        }
        if !self.keep_prev(&bin) {
            let _ = fs::remove_file(&staged);
            return self.fail(
                "msg.updater_cannot_keep_prev",
                &[
                    ("bin", &bin.display().to_string()),
                    ("bindir", &bindir.display().to_string()),
                ],
            );
        }
        if fs::rename(&staged, &bin).is_err() {
            let _ = fs::remove_file(&staged);
            return self.fail(
                "msg.updater_cannot_move_new",
                &[
                    ("bin", &bin.display().to_string()),
                    ("bindir", &bindir.display().to_string()),
                ],
            );
        }
        let _ = fs::write(
            dir.join(&self.c.installed_file),
            format!("{} {} {}\n", epoch_s(), src_label, newsha),
        );
        // the thin client, when the archive ships one: swapped atomically, kept as .prev, put back at once if it fails its self-test
        if have_hook {
            self.swap_hook(&new_hook, &bin);
        }
        self.record(); // under this update's hold: no check can run between the swap and the record
        self.install_unlock();
        let prev_note = if cursha.is_empty() {
            String::new()
        } else {
            self.m(
                "msg.updater_prev_note",
                &[("bin", &bin.display().to_string())],
            )
        };
        self.say(&self.m(
            "msg.updater_updated",
            &[
                ("bin", &bin.display().to_string()),
                ("version", &self.smoke_version.clone()),
                ("label", &src_label),
                ("sha", &newsha),
                ("prev_note", &prev_note),
            ],
        ));
        self.restart_daemon();
        0
    }

    /// Hand the verified binaries to the NEW engine's install routine in a staging directory. `None`: the routine could not be started
    /// (the caller then installs the old way); `Some(code)`: it ran, and its exit code is the update's.
    fn delegate_install(
        &mut self,
        engine: &Path,
        hook: Option<&Path>,
        source: &str,
    ) -> Option<i32> {
        let stage = self.tmp.join(&self.c.stage_dir);
        fs::create_dir_all(&stage).ok()?;
        let staged_engine = stage.join(&self.c.member_engine);
        fs::copy(engine, &staged_engine).ok()?;
        make_exec(&staged_engine);
        if let Some(h) = hook {
            let sh = stage.join(&self.c.member_hook);
            fs::copy(h, &sh).ok()?;
            make_exec(&sh);
        }
        // the engine that runs the routine: the new one when it has it, else the installed one; with neither, the caller installs itself
        let runner = [staged_engine.clone(), self.bin.clone()]
            .into_iter()
            .find(|e| self.has_routine(e))?;
        let mut cmd = Command::new(&runner);
        cmd.arg(&self.c.engine_verb_update)
            .arg(&self.c.flag_from_local)
            .arg(&stage)
            .arg(&self.c.flag_source)
            .arg(source)
            .arg(&self.c.flag_yes)
            .env(self.s.text("env.dir"), &self.dir)
            .env(self.s.text("env.plugin_root"), self.kit_plugin_root());
        if self.o.force {
            cmd.arg(&self.c.flag_force);
        }
        if self.o.auto {
            // the job runs under the daemon being replaced: the routine finishes detached, its output goes to the update log
            let log = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.log)
                .ok();
            cmd.stdin(Stdio::null()).process_group(0);
            match log.and_then(|f| f.try_clone().ok().map(|g| (f, g))) {
                Some((out, err)) => cmd.stdout(out).stderr(err),
                None => cmd.stdout(Stdio::null()).stderr(Stdio::null()),
            };
            cmd.spawn().ok()?;
            self.say(&self.m(
                "msg.updater_routine_scheduled",
                &[("log", &self.log.display().to_string())],
            ));
            return Some(0);
        }
        // the routine's own lines are the report; the update lock and scratch stay ours until it is done
        let status = cmd.status().ok()?;
        status.code().or(Some(1))
    }

    /// Automatic updates only: true (after saying why) when the release is not strictly newer than what runs, and what runs is a
    /// local/manual build (the install record says so, or its version carries `+branch.sha` build metadata).
    fn auto_not_newer(&mut self, channel: &str, want: &str, tag: &str) -> bool {
        let rec = fs::read_to_string(self.dir.join(&self.c.record_file))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .unwrap_or_default();
        let out = self.tmp.join("running.out");
        let argv = vec![
            self.bin.display().to_string(),
            self.c.engine_version.clone(),
        ];
        let envs = [
            (self.s.text("env.plugin_root"), self.proot.clone()),
            (self.s.text("env.dir"), self.tmp.join("state")),
        ];
        let envs: Vec<(&str, &Path)> = envs
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_path()))
            .collect();
        let _ = self.run_in(&argv, &envs, Some(&out), self.limit);
        let running = fs::read_to_string(&out)
            .unwrap_or_default()
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        let src = rec["source"].as_str().unwrap_or_default();
        let local = running.contains('+') || src == self.c.source_file || src == "local";
        if !local {
            return false;
        }
        // a stable release must have a strictly higher component version; a dev pre-release carries none, so it cannot be newer
        let floor = self.s.text("launcher.legacy_scheme_floor");
        if channel == self.c.ch_stable
            && crate::compat::component_cmp(&floor, want, &running)
                == Some(std::cmp::Ordering::Greater)
        {
            return false;
        }
        self.say(&self.m(
            "msg.updater_auto_not_newer",
            &[
                ("running", &running),
                ("release", if want.is_empty() { tag } else { want }),
            ],
        ));
        true
    }

    /// Does this engine binary advertise the install routine (`version --json` lists `routine_feature`)? An older build does not, and
    /// its `update` verb is a different command that must never be handed these arguments.
    fn has_routine(&self, engine: &Path) -> bool {
        if !engine.is_file() {
            return false;
        }
        let out = self.tmp.join("features.out");
        let st = self.tmp.join("state");
        let (root, dirk) = (self.s.text("env.plugin_root"), self.s.text("env.dir"));
        let envs = [
            (root.as_str(), self.proot.as_path()),
            (dirk.as_str(), st.as_path()),
        ];
        let mut argv = vec![engine.display().to_string()];
        argv.extend(self.c.engine_version_json.iter().cloned());
        matches!(
            self.run_in(&argv, &envs, Some(&out), self.limit),
            Ran::Done(0)
        ) && fs::read_to_string(&out)
            .ok()
            .and_then(|t| {
                serde_json::from_str::<serde_json::Value>(t.lines().next().unwrap_or_default()).ok()
            })
            .is_some_and(|v| {
                v["features"].as_array().is_some_and(|f| {
                    f.iter()
                        .any(|x| x.as_str() == Some(self.c.routine_feature.as_str()))
                })
            })
    }

    /// `--check-release`: one JSON line about the latest release of the channel (the engine has no network code, so `update --check
    /// --json` asks this). Changes nothing.
    fn check_release(&mut self) -> i32 {
        let channel = self
            .o
            .channel
            .clone()
            .unwrap_or_else(|| self.c.default_channel.clone());
        let prefix = if channel == self.c.ch_dev {
            self.c.pre_dev.clone()
        } else {
            self.c.pre_stable.clone()
        };
        let out = |v: serde_json::Value| {
            let _ = writeln!(std::io::stdout(), "{v}");
        };
        if !self.have_downloader() {
            out(
                serde_json::json!({"channel": channel, "error": self.m("msg.updater_no_downloader", &[]).lines().next().unwrap_or_default()}),
            );
            return 1;
        }
        let list = self.tmp.join("releases.out");
        let url = fill(
            &self.s.text("updater.releases_url"),
            &[
                ("api", &self.c.api_base),
                ("repo", &self.c.repo),
                ("per_page", &self.c.per_page.to_string()),
            ],
        );
        if !self.fetch(&url, &list) {
            let what = self.m(
                "msg.updater_cannot_reach",
                &[
                    ("api", &self.c.api_base.clone()),
                    ("repo", &self.c.repo.clone()),
                    ("channel", &channel),
                    ("unchanged", ""),
                ],
            );
            out(
                serde_json::json!({"channel": channel, "error": what.lines().next().unwrap_or_default()}),
            );
            return 1;
        }
        let triple = crate::install::platform_triple(self.s, self.test);
        let releases = fs::read_to_string(&list)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .unwrap_or_default();
        let found = releases.as_array().into_iter().flatten().find(|r| {
            r.get("tag_name").and_then(|t| t.as_str()).is_some_and(|t| {
                t.starts_with(&prefix)
                    && t.len() > prefix.len()
                    && t[prefix.len()..]
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
            })
        });
        let Some(r) = found else {
            out(serde_json::json!({"channel": channel, "tag": null, "asset_available": false}));
            return 0;
        };
        let tag = r
            .get("tag_name")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string();
        let asset = fill(&self.c.asset_name, &[("tag", &tag), ("triple", &triple)]);
        let assets: Vec<&str> = r
            .get("assets")
            .and_then(|a| a.as_array())
            .into_iter()
            .flatten()
            .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
            .collect();
        out(serde_json::json!({
            "channel": channel, "tag": tag,
            "version": (channel == self.c.ch_stable).then(|| tag[self.c.pre_stable.len()..].to_string()),
            "published": r.get("published_at"), "prerelease": r.get("prerelease"),
            "asset": asset, "asset_available": assets.contains(&asset.as_str()),
            "sums_available": assets.contains(&self.c.sums_asset.as_str()), "assets": assets,
        }));
        0
    }

    fn hook_differs(&self, new_hook: &Path) -> bool {
        sha256_file(new_hook) != sha256_file(&self.hook_bin)
    }

    /// Keep the current `bin` as `bin.prev` (copy, then rename); false when that is not possible.
    fn keep_prev(&self, bin: &Path) -> bool {
        if !bin.is_file() {
            return true;
        }
        let prev = self.prev_of(bin);
        let tmp = bin.with_extension(format!("prev.{}", std::process::id()));
        if fs::copy(bin, &tmp).is_ok() && fs::rename(&tmp, prev).is_ok() {
            return true;
        }
        let _ = fs::remove_file(&tmp);
        false
    }

    fn swap_hook(&mut self, new_hook: &Path, engine: &Path) {
        let hb = self.hook_bin.clone();
        if sha256_file(new_hook) == sha256_file(&hb) && hb.is_file() {
            return;
        }
        let staged = hb.with_extension(format!("new.{}", std::process::id()));
        if fs::copy(new_hook, &staged).is_err() {
            return self.say(&self.m(
                "msg.updater_hook_skipped",
                &[("path", &hb.display().to_string())],
            ));
        }
        make_exec(&staged);
        if !self.keep_prev(&hb) || fs::rename(&staged, &hb).is_err() {
            let _ = fs::remove_file(&staged);
            return self.say(&self.m(
                "msg.updater_hook_skipped",
                &[("path", &hb.display().to_string())],
            ));
        }
        if self.selftest(&hb, engine) {
            return self.say(&self.m(
                "msg.updater_hook_updated",
                &[("path", &hb.display().to_string())],
            ));
        }
        let prev = self.prev_of(&hb);
        if prev.is_file() && fs::rename(&prev, &hb).is_ok() {
            self.say(&self.m(
                "msg.updater_hook_auto_rolled_back",
                &[("path", &hb.display().to_string())],
            ));
        }
    }

    fn install_live(
        &mut self,
        new_engine: &Path,
        newsha: &str,
        src_label: &str,
        newplug: Option<PathBuf>,
        commit: &str,
    ) -> i32 {
        let (kit, bundle, bin, dir) = (
            self.kit.clone(),
            self.kit.join(&self.c.kit_bundle),
            self.bin.clone(),
            self.dir.clone(),
        );
        let kit_s = kit.display().to_string();
        let log_s = self.log.display().to_string();
        let kb_engine = bundle.join(&self.c.member_engine);
        if sha256_file(new_engine).as_deref() == sha256_file(&kb_engine).as_deref()
            && kb_engine.exists()
        {
            let same = match &newplug {
                None => true,
                Some(np) => {
                    let cmp = self.tmp.join("cmp/plugin");
                    let _ = fs::create_dir_all(cmp.parent().unwrap_or(&self.tmp));
                    copy_tree(np, &cmp).is_ok() && {
                        let _ = fs::remove_file(cmp.join(&self.c.lock_file));
                        same_tree(&cmp, &bundle.join(&self.c.kit_plugin))
                    }
                }
            };
            if same {
                let plug_note = if newplug.is_some() {
                    self.s.text("updater.and_plugin")
                } else {
                    String::new()
                };
                self.say(&self.m(
                    "msg.updater_live_current",
                    &[("plugin", &plug_note), ("sha", newsha)],
                ));
                return 0;
            }
        }
        let ts = stamp_dash(epoch_s());
        let stage = kit.join(format!(
            "{}{}{ts}",
            self.c.kit_bundle,
            self.s.text("updater.kit_new")
        ));
        if fs::create_dir_all(&stage).is_err() {
            return self.fail(
                "msg.updater_live_cannot_stage",
                &[("stage", &stage.display().to_string()), ("kit", &kit_s)],
            );
        }
        if fs::copy(new_engine, stage.join(&self.c.member_engine)).is_err() {
            return self.fail(
                "msg.updater_live_cannot_copy_engine",
                &[("stage", &stage.display().to_string())],
            );
        }
        let plugin_src = newplug
            .clone()
            .unwrap_or_else(|| bundle.join(&self.c.kit_plugin));
        if copy_tree(&plugin_src, &stage.join(&self.c.kit_plugin)).is_err() {
            let key = if newplug.is_some() {
                "msg.updater_live_cannot_copy_plugin"
            } else {
                "msg.updater_live_cannot_copy_cur_plugin"
            };
            return self.fail(key, &[("stage", &stage.display().to_string())]);
        }
        // a plugin-shipped lock would make the installer replace the bundled engine (go-live refuses it)
        let shipped = stage.join(&self.c.kit_plugin).join(&self.c.lock_file);
        if shipped.exists() {
            let _ = fs::rename(
                &shipped,
                stage.join(self.s.text("updater.lock_not_shipped")),
            );
        }
        let c_note = if commit.is_empty() {
            String::new()
        } else {
            self.m("msg.updater_commit_paren", &[("commit", commit)])
        };
        let _ = fs::write(
            stage.join(self.s.text("updater.provenance_file")),
            self.m(
                "msg.updater_provenance",
                &[
                    ("label", src_label),
                    ("commit_note", &c_note),
                    ("version", &self.smoke_version.clone()),
                    ("sha", newsha),
                    ("when", &rec::stamp_log(epoch_s())),
                ],
            ),
        );
        if !self.install_lock() {
            return 1;
        }
        if !self.keep_prev(&bin) {
            return self.fail(
                "msg.updater_cannot_keep_prev",
                &[
                    ("bin", &bin.display().to_string()),
                    ("bindir", &dir.join("bin").display().to_string()),
                ],
            );
        }
        let aside = kit.join(format!(
            "{}{}{ts}",
            self.c.kit_bundle,
            self.s.text("updater.kit_pre_update")
        ));
        if fs::rename(&bundle, &aside).is_err() {
            return self.fail(
                "msg.updater_live_cannot_aside",
                &[("bundle", &bundle.display().to_string()), ("kit", &kit_s)],
            );
        }
        if fs::rename(&stage, &bundle).is_err() {
            let _ = fs::rename(&aside, &bundle);
            return self.fail(
                "msg.updater_live_cannot_put",
                &[
                    ("stage", &stage.display().to_string()),
                    ("bundle", &bundle.display().to_string()),
                    ("kit", &kit_s),
                ],
            );
        }
        let out = self.tmp.join("golive.out");
        if !self.go_live(&out) {
            self.tail_to_stderr(&out, 8);
            let failed = kit.join(format!(
                "{}{}{ts}",
                self.c.kit_bundle,
                self.s.text("updater.kit_failed")
            ));
            let _ = fs::rename(&bundle, &failed);
            let _ = fs::rename(&aside, &bundle);
            return self.fail(
                "msg.updater_live_golive",
                &[
                    ("bundle", &bundle.display().to_string()),
                    ("failed", &failed.display().to_string()),
                    ("log", &log_s),
                    ("kit", &kit_s),
                    ("select", &self.live_select()),
                ],
            );
        }
        let _ = fs::write(
            dir.join(&self.c.installed_file),
            format!(
                "{} {} {} {}\n",
                epoch_s(),
                self.s.text("updater.installed_live"),
                src_label,
                newsha
            ),
        );
        self.record();
        self.install_unlock();
        let plug_note = if commit.is_empty() {
            String::new()
        } else {
            self.m("msg.updater_plugin_note", &[("commit", commit)])
        };
        self.say(&self.m(
            "msg.updater_live_updated",
            &[
                ("version", &self.smoke_version.clone()),
                ("plugin_note", &plug_note),
                ("aside", &aside.display().to_string()),
            ],
        ));
        self.restart_daemon();
        0
    }
}
