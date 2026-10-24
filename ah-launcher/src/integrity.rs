//! `ah-hook integrity <verb>`: remember which ah-engine binary ran healthy, and put it back when a different one that never did keeps
//! failing. The port of `hooks/ah-engine-integrity.sh` (now `plugins/anti-hall-node/legacy-sh/`): same verbs, same files, same lock
//! protocol, same log; the launcher is the one thing that has to work when the engine does not, so the repair lives here.
//!
//! verbs: `record` (an installer put this binary in place: remember its sha256 as the expected one), `accept` (the operator vouches
//! for it: record, and it is never rolled back on a mismatch alone), `check` (promote a healthy binary to the known-good copy;
//! roll back an unexpected, never-healthy, failing one), `fail` (the launcher saw the engine time out, die or answer nothing: count
//! it, then check), `status`, `lock TOKEN` and `unlock TOKEN` (the ONE install lock every writer of `bin/` shares).
//!
//! Every name, threshold and path comes from the plugin's `engine/defaults/engine.toml` (`[rollback.*]`, `[files.*]`); a file that
//! lacks one of them means there is nothing safe to do and the verb exits 0. Never fails a session: every verb but `lock` exits 0.
//! A roll-back renames the bad binary aside (never deleted) and restores the known-good copy.

use crate::cfg::Settings;
use crate::rec::{epoch_s, pairs, stamp_log, stamp_name};
use crate::util::env_nonempty;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The integrity log is cut back to its last lines once it passes this size, and the failure log likewise.
struct Keep {
    log_max: u64,
    log_lines: usize,
    fails_max: usize,
    fails_lines: usize,
}

pub struct Integ {
    pub bin: PathBuf,
    good: PathBuf,
    good_sha_f: PathBuf,
    exp_f: PathBuf,
    accepted_f: PathBuf,
    healthy: PathBuf,
    request: PathBuf,
    last: PathBuf,
    fails: PathBuf,
    log: PathBuf,
    lockdir: PathBuf,
    pub owner_f: PathBuf,
    aside_mid: String,
    token_env: String,
    chunk: usize,
    lock_poll: Duration,
    pub lock_wait: u64,
    hook_wait: u64,
    lock_stale: u64,
    fail_n: u64,
    fail_win: u64,
    on_mismatch: bool,
    keep: Keep,
    /// Test only: the path prefix of the race points (see `park`).
    park: Option<String>,
}

/// A numeric setting that must be in the file (the environment override only changes its value).
fn need_num(s: &Settings, key: &str) -> Option<u64> {
    s.shipped(key)?.as_integer()?;
    Some(s.num(key))
}

fn need_text(s: &Settings, key: &str) -> Option<String> {
    s.shipped(key)?
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn first_word(p: &Path) -> String {
    fs::read_to_string(p)
        .ok()
        .and_then(|t| {
            t.lines()
                .next()
                .and_then(|l| l.split_whitespace().next().map(str::to_string))
        })
        .unwrap_or_default()
}

fn read_trim(p: &Path) -> String {
    fs::read_to_string(p)
        .map(|t| t.trim_end_matches('\n').to_string())
        .unwrap_or_default()
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

fn with_suffix(p: &Path, sfx: &str) -> PathBuf {
    let mut o = p.as_os_str().to_os_string();
    o.push(sfx);
    p.with_file_name(PathBuf::from(o).file_name().unwrap_or_default())
}

impl Integ {
    /// None when the settings file lacks a key: nothing safe to do.
    pub fn new(s: &Settings, state: &Path) -> Option<Integ> {
        let bin_dir = need_text(s, "rollback.bin_dir")?;
        let bin_name = need_text(s, "rollback.bin_name")?;
        let good_sfx = need_text(s, "rollback.good_suffix")?;
        let exp_sfx = need_text(s, "rollback.expected_suffix")?;
        let accepted_sfx = need_text(s, "rollback.accepted_suffix")?;
        let sha_sfx = need_text(s, "rollback.sha_suffix")?;
        let aside_mid = need_text(s, "rollback.aside_infix")?;
        let lock_name = need_text(s, "rollback.install_lock")?;
        let file = |k: &str| need_text(s, k).map(|n| state.join(n));
        let (healthy, request, last) = (
            file("files.healthy_binary")?,
            file("files.rollback_request")?,
            file("files.rollback_last")?,
        );
        let (fails, log) = (
            file("files.wrapper_fail_log")?,
            file("files.integrity_log")?,
        );
        let bin = state.join(&bin_dir).join(&bin_name);
        let good = with_suffix(&bin, &good_sfx);
        let exp_f = with_suffix(&bin, &exp_sfx);
        let lockdir = state.join(lock_name);
        Some(Integ {
            good_sha_f: with_suffix(&good, &sha_sfx),
            accepted_f: with_suffix(&exp_f, &accepted_sfx),
            owner_f: lockdir.join(need_text(s, "rollback.lock_owner_file")?),
            lockdir,
            token_env: need_text(s, "env.install_lock_token")?,
            chunk: need_num(s, "rollback.hash_chunk")?.max(1) as usize,
            lock_poll: Duration::from_millis(need_num(s, "rollback.lock_poll_ms")?.max(1)),
            lock_wait: need_num(s, "rollback.lock_wait_s")?,
            hook_wait: need_num(s, "rollback.lock_hook_wait_s")?,
            lock_stale: need_num(s, "rollback.lock_stale_s")?,
            fail_n: need_num(s, "rollback.fail_n")?,
            fail_win: need_num(s, "rollback.fail_window_s")?,
            on_mismatch: need_num(s, "rollback.on_mismatch")? == 1,
            keep: Keep {
                log_max: need_num(s, "rollback.log_max_bytes")?,
                log_lines: need_num(s, "rollback.log_keep_lines")? as usize,
                fails_max: need_num(s, "rollback.fail_log_max_lines")? as usize,
                fails_lines: need_num(s, "rollback.fail_log_keep_lines")? as usize,
            },
            park: env_nonempty(&s.text("launcher.test_flag_env"))
                .is_some_and(|v| v == "1")
                .then(|| env_nonempty(&s.text("launcher.knob_integrity_park")))
                .flatten(),
            bin,
            good,
            exp_f,
            healthy,
            request,
            last,
            fails,
            log,
            aside_mid,
        })
    }

    /// Test only: stop here while the file `<prefix>.<point>` exists, and say so with `<prefix>.<point>.parked`.
    fn park(&self, point: &str) {
        let Some(base) = &self.park else { return };
        let gate = format!("{base}.{point}");
        if !Path::new(&gate).exists() {
            return;
        }
        let _ = fs::write(format!("{gate}.parked"), "");
        let t0 = Instant::now();
        while Path::new(&gate).exists() && t0.elapsed() < Duration::from_secs(self.lock_wait) {
            std::thread::sleep(self.lock_poll);
        }
    }

    /// One record of the integrity log: `<UTC time> event=<id> key=value ...`.
    fn rec(&self, event: &str, kv: &[(&str, &str)]) {
        let line = format!(
            "{} {}",
            stamp_log(epoch_s()),
            pairs(&[("event", event)], kv)
        );
        if let Ok(mut f) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log)
        {
            let _ = writeln!(f, "{line}");
        }
    }

    fn trim_log(&self) {
        if fs::metadata(&self.log).is_ok_and(|m| m.len() > self.keep.log_max) {
            self.tail(&self.log, self.keep.log_lines);
        }
    }

    /// Keep the last `n` lines of `p` (written aside, then renamed over it).
    fn tail(&self, p: &Path, n: usize) {
        let Ok(t) = fs::read_to_string(p) else { return };
        let lines: Vec<&str> = t.lines().collect();
        let from = lines.len().saturating_sub(n);
        self.write_atomic(p, &lines[from..].join("\n"));
    }

    pub fn sha256_of(&self, p: &Path) -> Option<String> {
        let mut f = fs::File::open(p).ok()?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; self.chunk];
        loop {
            let n = f.read(&mut buf).ok()?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        Some(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
    }

    pub fn sha(&self, p: &Path) -> String {
        self.sha256_of(p).unwrap_or_default()
    }

    fn write_atomic(&self, p: &Path, text: &str) -> bool {
        let tmp = with_suffix(p, &format!(".tmp.{}", std::process::id()));
        if fs::write(&tmp, format!("{text}\n")).is_ok() && fs::rename(&tmp, p).is_ok() {
            return true;
        }
        let _ = fs::remove_file(&tmp);
        false
    }

    // ---- the install lock --------------------------------------------------------------------------------------------------
    // The lock is the directory `lockdir`; its holder is the token in `lockdir/owner`. The owner file is only ever created with a
    // hard link (atomic, fails when it exists) and only ever taken away with a rename (atomic, one taker wins), so whoever moved
    // it away holds the only copy and can compare it: a breaker or a giver that finds another token in it links it straight back.

    fn own(&self, token: &str) -> bool {
        let tok = with_suffix(&self.lockdir, &format!(".tok.{}", std::process::id()));
        if fs::write(&tok, format!("{token}\n")).is_err() {
            let _ = fs::remove_file(&tok);
            return false;
        }
        let ok = fs::hard_link(&tok, &self.owner_f).is_ok();
        let _ = fs::remove_file(&tok);
        ok
    }

    /// The holder is gone (dead pid) or has held the lock longer than `lock_stale`: break it and let `token` take it over.
    fn lock_stale(&self, token: &str) -> bool {
        let owner = read_trim(&self.owner_f);
        let now = epoch_s();
        let mut brk = None;
        if !owner.is_empty() {
            let mut it = owner.split_whitespace();
            let (pid, at) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
            let (pid, at) = match (pid.parse::<u32>(), at.parse::<u64>()) {
                (Ok(p), Ok(a)) => (Some(p), a),
                _ => (None, 0),
            };
            if pid.is_some_and(alive) && now.saturating_sub(at) <= self.lock_stale {
                return false;
            }
            let aside = with_suffix(
                &self.lockdir,
                &format!(".stale.{}.{now}", std::process::id()),
            );
            self.park("before_break");
            if fs::rename(&self.owner_f, &aside).is_err() {
                return false;
            }
            self.park("after_break");
            if read_trim(&aside) != owner {
                if fs::hard_link(&aside, &self.owner_f).is_ok() {
                    let _ = fs::remove_file(&aside);
                } else {
                    self.rec(
                        "lock_put_back_failed",
                        &[
                            ("owner", &read_trim(&aside)),
                            ("kept", &aside.display().to_string()),
                        ],
                    );
                }
                return false;
            }
            brk = Some(aside);
        } else {
            // no owner yet: being taken right now, unless the taker died between mkdir and writing it
            let old = fs::metadata(&self.lockdir)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > self.lock_stale.div_ceil(60) * 60);
            if !old {
                return false;
            }
        }
        if !self.own(token) {
            return false;
        }
        let kept = brk.map(|b| b.display().to_string()).unwrap_or_default();
        self.rec("lock_broke_stale", &[("holder", &owner), ("kept", &kept)]);
        true
    }

    /// True once `token` holds the install lock (also when it already did); false when another holder kept it `wait` seconds.
    pub fn lock_take(&self, token: &str, wait: u64) -> bool {
        let t0 = Instant::now();
        let mut first = true;
        loop {
            if fs::create_dir(&self.lockdir).is_ok() {
                if self.own(token) {
                    return true;
                }
                if self.owner_f.is_file() {
                    continue; // a breaker took the fresh directory over: wait for it like any holder
                }
                let _ = fs::remove_dir(&self.lockdir);
                return false;
            }
            if read_trim(&self.owner_f) == token || self.lock_stale(token) {
                return true;
            }
            if t0.elapsed() >= Duration::from_secs(wait) {
                return false;
            }
            if first {
                first = false;
                self.rec(
                    "lock_waiting",
                    &[
                        ("wait_s", &wait.to_string()),
                        ("holder", &read_trim(&self.owner_f)),
                    ],
                );
            }
            std::thread::sleep(self.lock_poll);
        }
    }

    /// Release the lock when `token` holds it; the owner file is renamed away first, so a breaker that took the lock over
    /// meanwhile gets its own owner file linked straight back instead of losing it.
    pub fn lock_give(&self, token: &str) {
        if read_trim(&self.owner_f) != token {
            return;
        }
        let give = with_suffix(&self.lockdir, &format!(".give.{}", std::process::id()));
        if fs::rename(&self.owner_f, &give).is_err() {
            return;
        }
        if read_trim(&give) == token {
            let _ = fs::remove_file(&give);
            let _ = fs::remove_dir(&self.lockdir);
        } else if fs::hard_link(&give, &self.owner_f).is_ok() {
            let _ = fs::remove_file(&give);
        } else {
            self.rec(
                "lock_put_back_failed",
                &[
                    ("owner", &read_trim(&give)),
                    ("kept", &give.display().to_string()),
                ],
            );
        }
    }

    /// Hold the lock for the rest of a verb: an installer's own hold (the token variable naming the current holder) is used as is
    /// and left to the installer to release; otherwise the guard releases at the end of the verb.
    fn hold(&self, wait: u64) -> Option<Hold<'_>> {
        let theirs = std::env::var(&self.token_env).unwrap_or_default();
        if !theirs.is_empty() && read_trim(&self.owner_f) == theirs {
            return Some(Hold {
                integ: self,
                token: None,
            });
        }
        let mine = format!("{} {}", std::process::id(), epoch_s());
        self.lock_take(&mine, wait).then_some(Hold {
            integ: self,
            token: Some(mine),
        })
    }

    // ---- the verbs ---------------------------------------------------------------------------------------------------------

    /// Bless the binary now in place as the expected one.
    pub fn record(&self) {
        if !self.bin.is_file() {
            return self.rec(
                "record_no_binary",
                &[("path", &self.bin.display().to_string())],
            );
        }
        let cur = self.sha(&self.bin);
        if cur.is_empty() {
            return self.rec(
                "record_cannot_hash",
                &[("path", &self.bin.display().to_string())],
            );
        }
        if !self.write_atomic(&self.exp_f, &cur) {
            return self.rec(
                "record_cannot_write",
                &[("path", &self.exp_f.display().to_string())],
            );
        }
        self.rec("record", &[("sha256", &cur)]);
    }

    /// A binary that ran healthy becomes the known-good copy.
    fn promote(&self, cur: &str) {
        if cur.is_empty() || first_word(&self.healthy) != cur {
            return;
        }
        if first_word(&self.good_sha_f) == cur && self.sha(&self.good) == cur {
            return;
        }
        let tmp = with_suffix(&self.good, &format!(".tmp.{}", std::process::id()));
        if fs::copy(&self.bin, &tmp).is_ok()
            && self.sha(&tmp) == cur
            && fs::rename(&tmp, &self.good).is_ok()
        {
            if self.write_atomic(&self.good_sha_f, &cur) {
                self.rec("promote", &[("sha256", &cur)]);
            }
        } else {
            let _ = fs::remove_file(&tmp);
            self.rec(
                "promote_cannot_copy",
                &[
                    ("from", &self.bin.display().to_string()),
                    ("to", &self.good.display().to_string()),
                ],
            );
        }
    }

    /// The installed binary `cur` is failing: a roll-back request for it, or enough wrapper failures in the window.
    fn failing(&self, cur: &str) -> bool {
        if first_word(&self.request) == cur {
            return true;
        }
        let Ok(t) = fs::read_to_string(&self.fails) else {
            return false;
        };
        let floor = epoch_s().saturating_sub(self.fail_win);
        let n = t
            .lines()
            .filter(|l| {
                l.split_whitespace()
                    .next()
                    .and_then(|w| w.parse::<u64>().ok())
                    .is_some_and(|v| v >= floor)
            })
            .count() as u64;
        n >= self.fail_n
    }

    fn check(&self) {
        if !self.bin.is_file() {
            return;
        }
        let cur = self.sha(&self.bin);
        self.promote(&cur);
        if cur.is_empty() || !self.on_mismatch {
            return;
        }
        let want = first_word(&self.exp_f);
        if want.is_empty() || cur == want {
            return; // nothing was ever recorded, or it is the binary the installer put there
        }
        if first_word(&self.healthy) == cur {
            return; // it ran healthy once: whatever is failing, it is not a damaged copy
        }
        if self.accepted_f.is_file() && first_word(&self.accepted_f) == cur {
            return; // the operator vouched for exactly this binary
        }
        if !self.failing(&cur) {
            return self.rec("check_left_alone_not_failing", &[("sha256", &cur)]);
        }
        let gsha = first_word(&self.good_sha_f);
        if !(self.good.is_file() && !gsha.is_empty() && gsha == self.sha(&self.good)) {
            return self.rec("check_no_verified_good", &[("sha256", &cur)]);
        }
        if gsha == cur {
            return;
        }
        self.park("validated");
        let ts = stamp_name(epoch_s());
        let aside = with_suffix(
            &self.bin,
            &format!("{}{ts}-{}", self.aside_mid, &cur[..8.min(cur.len())]),
        );
        if fs::rename(&self.bin, &aside).is_err() {
            return self.rec(
                "rollback_cannot_move_aside",
                &[("path", &self.bin.display().to_string())],
            );
        }
        if self.sha(&aside) != cur {
            // replaced since it was checked: it is not the binary judged damaged
            if self.bin.exists() {
                self.rec(
                    "rollback_changed_twice",
                    &[
                        ("path", &self.bin.display().to_string()),
                        ("kept", &aside.display().to_string()),
                    ],
                );
            } else {
                let _ = fs::rename(&aside, &self.bin);
                self.rec(
                    "rollback_changed_after_check",
                    &[("path", &self.bin.display().to_string())],
                );
            }
            return;
        }
        let new = with_suffix(&self.bin, &format!(".new.{}", std::process::id()));
        let restored = fs::copy(&self.good, &new).is_ok()
            && fs::set_permissions(&new, fs::Permissions::from_mode(0o755)).is_ok()
            && self.sha(&new) == gsha
            && fs::rename(&new, &self.bin).is_ok();
        if restored {
            self.write_atomic(&self.exp_f, &gsha);
            self.write_atomic(
                &self.last,
                &pairs(
                    &[("at", &ts)],
                    &[
                        ("rolled_back", &cur),
                        ("aside", &aside.display().to_string()),
                        ("restored", &gsha),
                    ],
                ),
            );
            let _ = fs::remove_file(&self.request);
            let _ = fs::write(&self.fails, "");
            self.rec(
                "rollback",
                &[
                    ("sha256", &cur),
                    ("aside", &aside.display().to_string()),
                    ("restored", &gsha),
                ],
            );
        } else {
            let _ = fs::remove_file(&new);
            let _ = fs::rename(&aside, &self.bin);
            self.rec(
                "rollback_cannot_restore",
                &[("good", &self.good.display().to_string())],
            );
        }
    }

    fn status(&self, s: &Settings) -> String {
        s.msg(
            "msg.launcher_integrity_status",
            &[
                ("binary", &self.bin.display().to_string()),
                ("installed", &self.sha(&self.bin)),
                ("expected", &first_word(&self.exp_f)),
                ("healthy", &first_word(&self.healthy)),
                ("good", &first_word(&self.good_sha_f)),
                ("last", &read_trim(&self.last)),
            ],
        )
    }
}

/// The hold on the install lock for the rest of a verb: gives it back on drop, unless it is an installer's own hold.
struct Hold<'a> {
    integ: &'a Integ,
    token: Option<String>,
}

impl Drop for Hold<'_> {
    fn drop(&mut self) {
        if let Some(t) = &self.token {
            self.integ.lock_give(t);
        }
    }
}

/// Run one verb. Returns the exit code: 0 always, except `lock` that did not get the lock (1).
pub fn run(s: &Settings, state: &Path, args: &[String]) -> i32 {
    // a maintenance verb, not a hook call: hashing the whole engine binary is not bound by the hook's CPU budget
    crate::limits::restore_cpu_limit();
    let Some(i) = Integ::new(s, state) else {
        return 0;
    };
    if state.as_os_str().is_empty() || fs::create_dir_all(i.bin.parent().unwrap_or(state)).is_err()
    {
        return 0;
    }
    i.trim_log();
    let arg = |n: usize| args.get(n).map(String::as_str).filter(|a| !a.is_empty());
    match arg(0).unwrap_or("") {
        "lock" => {
            let Some(t) = arg(1) else { return 0 };
            if !i.lock_take(t, i.lock_wait) {
                i.rec(
                    "lock_refused",
                    &[
                        ("token", t),
                        ("wait_s", &i.lock_wait.to_string()),
                        ("holder", &read_trim(&i.owner_f)),
                    ],
                );
                return 1;
            }
        }
        "unlock" => {
            if let Some(t) = arg(1) {
                i.lock_give(t);
            }
        }
        "record" => match i.hold(i.lock_wait) {
            Some(_h) => i.record(),
            None => i.rec(
                "record_lock_held",
                &[
                    ("wait_s", &i.lock_wait.to_string()),
                    ("holder", &read_trim(&i.owner_f)),
                ],
            ),
        },
        "accept" => match i.hold(i.lock_wait) {
            Some(_h) => {
                i.record();
                if i.bin.is_file() && i.write_atomic(&i.accepted_f, &i.sha(&i.bin)) {
                    i.rec("accept", &[]);
                }
            }
            None => i.rec(
                "accept_lock_held",
                &[
                    ("wait_s", &i.lock_wait.to_string()),
                    ("holder", &read_trim(&i.owner_f)),
                ],
            ),
        },
        "fail" => {
            if let Ok(mut f) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&i.fails)
            {
                let _ = writeln!(f, "{}", epoch_s());
            }
            match i.hold(i.hook_wait) {
                Some(_h) => {
                    if fs::read_to_string(&i.fails)
                        .is_ok_and(|t| t.lines().count() > i.keep.fails_max)
                    {
                        i.tail(&i.fails, i.keep.fails_lines);
                    }
                    i.check();
                }
                None => i.rec("fail_counted_lock_held", &[]),
            }
        }
        "check" => match i.hold(i.hook_wait) {
            Some(_h) => i.check(),
            None => i.rec("check_lock_held", &[]),
        },
        "status" => {
            let _ = std::io::stdout().write_all(i.status(s).as_bytes());
        }
        _ => crate::util::say(&s.text("msg.launcher_integrity_usage")),
    }
    0
}
