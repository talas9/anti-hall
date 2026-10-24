//! `ah-hook doctor [--builtin] [--check] [--quiet] [--repair [--dry-run]]`: the thin client's own diagnosis, the one that needs neither
//! the engine nor Node. The port of `hooks/ah-doctor.sh` and the no-engine fallback of `ah-engine doctor`: it prints the engine
//! doctor's format and, for every check both make, the engine doctor's exact finding text (both read the templates of
//! `engine/defaults/doctor.toml`; `ah-engine/tests/it/doctor_scenarios.rs` compares them).
//!
//! When the installed engine runs, `ah-hook doctor` hands over to `ah-engine doctor` (its checks are a superset) unless `--builtin` is
//! given; when it does not, this runs. What it checks: the engine binary (kind, mode, header, OS, architecture, Rosetta, quarantine,
//! digest vs the installer's marker, version vs the plugin's lock, whether `version` runs), the state directory, the daemon's files, the
//! plugin's defaults, the hooks files, HOME, PATH, the tools and git, and the install health of the thin client itself: the client is
//! installed and executable, every hook command of the hooks files found is the direct form (the retired `sh .../ah-hook.sh` wrapper and
//! Node on an entry path are flagged), the plugin ships no shell file besides `hooks/install.sh`, the `~/.anti-hall/bin` launchers
//! are sh shims. `--repair` makes safe repairs only, each with a backup, never deleting: the execute bit, the state directory, and
//! hook commands rewritten to the direct form. It never signals a process.
//!
//! Every text comes from `doctor.toml` (`doctor_msg.*`), every name and number from `doctor.*` / `hooks_form.*` there and in `engine.toml`.

use crate::cfg::Settings;
use crate::install::{find_on_path, host_uname, is_apple_silicon, on_path, path_env, run_limited, sha256_file, Ran};
use crate::rec::epoch_s;
use crate::util::{env_nonempty, fill};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

struct Doc<'a> {
    s: &'a Settings,
    root: Option<PathBuf>,
    home: String,
    eng_dir: PathBuf,
    out: String,
    pass: u32,
    fail: u32,
    warn: u32,
    host_os: String,
    host_arch: String,
    os_name: String,
    arch_name: String,
    release: String,
    test: bool,
    limit: Duration,
    engine_usable: bool,
    bin: PathBuf,
    client: PathBuf,
}

fn first_line(t: &str, max: usize) -> String {
    t.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(max).collect()
}

fn mode_octal(p: &Path) -> String {
    fs::metadata(p).map(|m| format!("{:03o}", m.permissions().mode() & 0o777)).unwrap_or_default()
}

impl Doc<'_> {
    /// A finding text: `doctor_msg.<key>` (the engine doctor's own, shared), or `doctor_l.msg_<key>` for a key written `x.<key>`
    /// (checks only the thin client makes).
    fn m(&self, key: &str, subs: &[(&str, &str)]) -> String {
        match key.strip_prefix("x.") {
            Some(k) => self.s.msg(&format!("doctor_l.msg_{k}"), subs),
            None => self.s.msg(&format!("doctor_msg.{key}"), subs),
        }
    }

    fn put(&mut self, sym: &str, text: String) {
        self.out.push_str(&format!("  {sym} {text}\n"));
    }

    fn ok(&mut self, key: &str, subs: &[(&str, &str)]) {
        self.pass += 1;
        let (sym, t) = (self.m("row_ok", &[]), self.m(key, subs));
        self.put(&sym, t);
    }

    fn bad(&mut self, key: &str, subs: &[(&str, &str)]) {
        self.fail += 1;
        let (sym, t) = (self.m("row_bad", &[]), self.m(key, subs));
        self.put(&sym, t);
    }

    fn warnl(&mut self, key: &str, subs: &[(&str, &str)]) {
        self.warn += 1;
        let (sym, t) = (self.m("row_warn", &[]), self.m(key, subs));
        self.put(&sym, t);
    }

    fn infol(&mut self, key: &str, subs: &[(&str, &str)]) {
        let (sym, t) = (self.m("row_prefix_info", &[]), self.m(key, subs));
        self.put(&sym, t);
    }

    fn head(&mut self, key: &str) {
        let h = self.m(key, &[]);
        self.out.push_str(&format!("\n{h}\n"));
    }

    fn run(&self, argv: &[String], envs: &[(&str, &Path)], limit: Duration) -> (Ran, String) {
        let tmp = std::env::temp_dir().join(format!("ah-doctor-{}-{}", std::process::id(), epoch_s()));
        let r = run_limited(argv, envs, Some(&tmp), limit, Duration::from_secs(self.s.num("doctor_l.kill_grace_s")), Duration::from_millis(self.s.num("doctor_l.poll_ms").max(1)));
        let out = fs::read_to_string(&tmp).unwrap_or_default();
        let _ = fs::remove_file(&tmp);
        (r, out)
    }

    fn line_chars(&self) -> usize {
        self.s.num("doctor_l.line_chars") as usize
    }

    fn cmd_chars(&self) -> usize {
        self.s.num("doctor_l.excerpt_chars") as usize
    }

    fn knob(&self, key: &str) -> Option<String> {
        if self.test { env_nonempty(&self.s.text(&format!("launcher.knob_{key}"))) } else { None }
    }

    fn install_cmd(&self) -> String {
        self.root.as_ref().map(|r| r.join(self.s.text("doctor.bootstrap_script")).display().to_string()).unwrap_or_else(|| self.s.text("doctor.bootstrap_script"))
    }

    // ---- facts ------------------------------------------------------------------------------------------------------------------
    fn version(&self) -> String {
        let Some(r) = &self.root else { return self.m("unknown_version", &[]) };
        fs::read_to_string(r.join(".claude-plugin/plugin.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(str::to_string))
            .unwrap_or_else(|| self.m("unknown_version", &[]))
    }

    // ---- Environment ------------------------------------------------------------------------------------------------------------
    fn environment(&mut self) {
        self.head("head_environment");
        let (p, a) = (self.os_name.clone(), self.arch_name.clone());
        self.ok("platform", &[("platform", &p), ("arch", &a)]);
        let has_json = self.root.as_ref().is_some_and(|r| r.join(".claude-plugin/plugin.json").is_file());
        if has_json {
            let v = self.version();
            self.ok("plugin_version", &[("version", &v)]);
        } else {
            self.warnl("no_plugin_root", &[]);
        }
    }

    // ---- Engine (the daemon's files; no process is contacted or signalled) ---------------------------------------------------------
    fn socket_path(&self) -> PathBuf {
        let plain = self.eng_dir.join(self.s.text("paths.socket_file"));
        let max = self.s.num("paths.socket_max_len") as usize;
        if plain.as_os_str().len() <= max {
            return plain;
        }
        // inside a private per-user directory named by the FNV-1a hash of the state directory
        // FNV-1a 64: the hash the engine names the private socket by (ah-engine/src/health.rs); both must agree
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in self.eng_dir.as_os_str().as_encoded_bytes() {
            h = (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3);
        }
        let name = format!("{:012x}{}", h & 0xffff_ffff_ffff, self.s.text("paths.short_socket_ext"));
        let uid = crate::util::uid();
        let tmp = env_nonempty(&self.s.text("env.tmpdir")).unwrap_or_else(|| self.s.text("paths.fallback_tmp"));
        let dir = format!("{}{uid}", self.s.text("paths.private_dir_prefix"));
        let p = Path::new(&tmp).join(&dir).join(&name);
        if p.as_os_str().len() <= max { p } else { Path::new(&self.s.text("paths.fallback_tmp")).join(dir).join(name) }
    }

    fn stale_pid(&mut self, file: &Path) {
        let Some(pid) = fs::read_to_string(file).ok().map(|t| t.chars().filter(char::is_ascii_digit).collect::<String>()).filter(|p| !p.is_empty() && p != "0") else { return };
        let f = file.display().to_string();
        let alive = pid.parse::<i32>().is_ok_and(|p| {
            // SAFETY: signal 0 only checks that the process exists.
            unsafe { libc::kill(p, 0) == 0 }
        });
        if !alive {
            return self.infol("pid_gone", &[("file", &f), ("pid", &pid)]);
        }
        let argv: Vec<String> = self.s.list("doctor_l.ps_cmd").into_iter().map(|a| fill(&a, &[("pid", &pid)])).collect();
        let (_, out) = self.run(&argv, &[], self.limit);
        let cmd = first_line(&out, self.line_chars());
        let serve = self.s.text("doctor_l.engine_serve_word");
        let eng = self.s.text("doctor.bin_name");
        if !(cmd.is_empty() || (cmd.contains(&eng) && cmd.contains(&serve))) {
            self.warnl("pid_reused", &[("file", &f), ("pid", &pid), ("cmd", &cmd)]);
        }
    }

    fn cooldown(&self, name: &str) -> Option<u64> {
        let until: u64 = fs::read_to_string(self.eng_dir.join(name)).ok()?.chars().filter(char::is_ascii_digit).collect::<String>().parse().ok()?;
        let now = epoch_s();
        (until / 1000 > now).then(|| until / 1000 - now + 1)
    }

    fn engine(&mut self) {
        self.head("head_engine");
        let sock = self.socket_path();
        let lockf = {
            let mut o = sock.as_os_str().to_os_string();
            o.push(self.s.text("paths.lock_suffix"));
            PathBuf::from(o)
        };
        if let Ok(md) = fs::symlink_metadata(&sock)
            && !std::os::unix::fs::FileTypeExt::is_socket(&md.file_type())
        {
            let kind = if md.is_dir() { self.m("kind_dir", &[]) } else { self.m("kind_file", &[]) };
            let sk = sock.display().to_string();
            self.bad("sock_not_socket", &[("sock", &sk), ("kind", &kind)]);
        }
        self.infol("x.builtin_daemon_note", &[]);
        self.stale_pid(&lockf);
        self.stale_pid(&self.eng_dir.join(self.s.text("files.run_marker")));
        let reason = fs::read_to_string(self.eng_dir.join(self.s.text("files.failure")))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("reason").and_then(|x| x.as_str()).map(str::to_string))
            .unwrap_or_default();
        if let Some(left) = self.cooldown(&self.s.text("files.crashloop_until")) {
            self.bad("crashloop", &[("secs", &left.to_string()), ("reason", &reason)]);
        }
        if let Some(left) = self.cooldown(&self.s.text("files.breaker_until")) {
            self.warnl("breaker", &[("secs", &left.to_string()), ("reason", &reason)]);
        }
    }

    // ---- Engine install -----------------------------------------------------------------------------------------------------------
    fn header(&self, bytes: &[u8], size: u64) -> Result<(String, Vec<String>), String> {
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let (script, elf, macho, fat) = (self.s.text("doctor.exe_magic_script"), self.s.text("doctor.exe_magic_elf"), self.s.text("doctor.exe_magic_macho64"), self.s.text("doctor.exe_magic_fat"));
        let (arm, x86) = (self.s.text("doctor.apple_silicon_name"), self.s.text("doctor.intel_name"));
        let (macos, linux) = (self.s.text("doctor.macos_name"), self.s.text("doctor.linux_name"));
        let trunc = || self.m("why_truncated", &[]);
        if hex.is_empty() {
            return Err(self.m("why_empty", &[]));
        }
        if hex.starts_with(&script) {
            return Ok((String::new(), vec![]));
        }
        let other = || self.s.text("doctor_l.other_arch_name");
        if hex.starts_with(&elf) {
            if hex.len() < 40 {
                return Err(trunc());
            }
            let a = match &hex[36..40] {
                "3e00" => x86,
                "b700" => arm,
                _ => other(),
            };
            return Ok((linux, vec![a]));
        }
        if hex.starts_with(&macho) {
            if hex.len() < 16 {
                return Err(trunc());
            }
            let a = match &hex[8..16] {
                "0c000001" => arm,
                "07000001" => x86,
                _ => other(),
            };
            return Ok((macos, vec![a]));
        }
        if hex.starts_with(&fat) {
            if hex.len() < 16 {
                return Err(trunc());
            }
            let n = usize::try_from(u32::from_str_radix(&hex[8..16], 16).unwrap_or(0)).unwrap_or(0).min(8);
            let mut archs = vec![];
            for i in 0..n {
                let off = 16 + i * 40;
                let Some(cpu) = hex.get(off..off + 8) else { return Err(trunc()) };
                archs.push(match cpu {
                    "0100000c" => arm.clone(),
                    "01000007" => x86.clone(),
                    _ => other(),
                });
            }
            return Ok((macos, archs));
        }
        Err(if size < 32 { trunc() } else { self.m("why_unknown", &[]) })
    }

    fn lock_text(&self) -> Option<(serde_json::Value, PathBuf)> {
        let p = self.root.as_ref()?.join(self.s.text("doctor.lock_file"));
        let v = serde_json::from_str(&fs::read_to_string(&p).ok()?).ok()?;
        Some((v, p))
    }

    fn engine_install(&mut self) {
        self.head("head_install");
        let bin = self.bin.clone();
        let b = bin.display().to_string();
        let install = self.install_cmd();
        let sub_pb = |b: &str, i: &str| -> Vec<(String, String)> { vec![("path".into(), b.into()), ("bootstrap".into(), i.into())] };
        let _ = sub_pb;
        let md = fs::symlink_metadata(&bin);
        let mut halted = false;
        if md.is_err() {
            self.warnl("bin_missing", &[("path", &b), ("bootstrap", &install)]);
        } else if !fs::metadata(&bin).is_ok_and(|m| m.is_file()) {
            let kind = if fs::metadata(&bin).is_ok_and(|m| m.is_dir()) {
                self.m("kind_dir", &[])
            } else if md.as_ref().is_ok_and(|m| m.file_type().is_symlink()) && !bin.exists() {
                self.m("kind_dangling", &[])
            } else {
                self.m("kind_other", &[])
            };
            self.bad("bin_not_file", &[("path", &b), ("kind", &kind), ("bootstrap", &install)]);
        } else {
            let size = fs::metadata(&bin).map(|m| m.len()).unwrap_or(0);
            let head = fs::File::open(&bin).ok().map(|mut f| {
                let mut buf = vec![0u8; self.s.num("doctor_l.header_bytes") as usize];
                let n = std::io::Read::read(&mut f, &mut buf).unwrap_or(0);
                buf.truncate(n);
                buf
            });
            let hdr = match head {
                Some(h) => self.header(&h, size),
                None => Err(self.m("why_empty", &[])),
            };
            let (bin_os, archs) = match hdr {
                Err(why) => {
                    halted = true;
                    self.bad("bin_corrupt", &[("path", &b), ("why", &why), ("bootstrap", &install)]);
                    (String::new(), vec![])
                }
                Ok(x) => x,
            };
            if !halted && !bin_os.is_empty() && bin_os != self.host_os {
                halted = true;
                let h = self.host_os.clone();
                self.bad("bin_wrong_os", &[("path", &b), ("bin_os", &bin_os), ("host_os", &h), ("bootstrap", &install)]);
            } else if !halted {
                self.engine_usable = true;
                if !archs.is_empty() && !archs.contains(&self.host_arch) {
                    let shown = archs.join("/");
                    let (ha, ho) = (self.host_arch.clone(), self.host_os.clone());
                    let subs = [("path", b.as_str()), ("bin_arch", shown.as_str()), ("host_arch", ha.as_str()), ("host_os", ho.as_str()), ("bootstrap", install.as_str())];
                    let rosetta = self.rosetta();
                    if self.host_os == self.s.text("doctor.macos_name") && ha == self.s.text("doctor.apple_silicon_name") && shown == self.s.text("doctor.intel_name") && rosetta {
                        self.warnl("bin_rosetta", &subs);
                    } else if self.host_os == self.s.text("doctor.macos_name") && ha == self.s.text("doctor.apple_silicon_name") && shown == self.s.text("doctor.intel_name") {
                        halted = true;
                        self.engine_usable = false;
                        self.bad("bin_no_rosetta", &subs);
                    } else {
                        halted = true;
                        self.engine_usable = false;
                        self.bad("bin_wrong_arch", &subs);
                    }
                }
                if self.engine_usable {
                    if self.host_os == self.s.text("doctor.macos_name") && self.s.list("doctor_l.xattr_cmd").first().is_some_and(|p| on_path(p)) {
                        let argv: Vec<String> = self.s.list("doctor_l.xattr_cmd").into_iter().map(|a| fill(&a, &[("attr", &self.s.text("doctor.quarantine_attr")), ("path", &b)])).collect();
                        if matches!(self.run(&argv, &[], self.limit).0, Ran::Done(0)) {
                            self.bad("bin_quarantined", &[("path", &b)]);
                            self.engine_usable = false;
                        }
                    }
                    if fs::metadata(&bin).map_or(true, |m| m.permissions().mode() & 0o111 == 0) {
                        let mode = mode_octal(&bin);
                        self.bad("bin_not_exec", &[("path", &b), ("mode", &mode)]);
                        self.engine_usable = false;
                    }
                }
            }
            // the lock and the installer's marker
            let (mut pinned, mut m_ver, mut m_bin) = (String::new(), String::new(), String::new());
            match self.lock_text() {
                Some((v, _)) => {
                    pinned = v.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let want = if self.host_os == self.s.text("doctor.macos_name") {
                        fill(&self.s.text("install.triple_macos"), &[("cpu", &self.host_arch)])
                    } else {
                        fill(&self.s.text("install.triple_linux"), &[("cpu", &self.host_arch), ("libc", "")])
                    };
                    let has = v.get("assets").and_then(|a| a.as_object()).is_some_and(|a| a.keys().any(|k| k.contains(&want)));
                    if !pinned.is_empty() && !has {
                        self.warnl("lock_no_asset", &[("triple", &want)]);
                    }
                }
                None => {
                    let p = self.root.as_ref().map(|r| r.join(self.s.text("doctor.lock_file"))).unwrap_or_default();
                    let err = if p.exists() { self.m("x.err_eacces", &[]) } else { self.m("x.err_enoent", &[]) };
                    self.warnl("lock_unreadable", &[("path", &p.display().to_string()), ("err", &err)]);
                }
            }
            let marker = self.eng_dir.join(self.s.text("doctor.marker_file"));
            if halted {
                // nothing is compared with a binary that cannot run
            } else if marker.is_file() {
                let f: Vec<String> = fs::read_to_string(&marker).unwrap_or_default().split_whitespace().map(str::to_string).collect();
                m_ver = f.first().cloned().unwrap_or_default();
                m_bin = f.get(2).cloned().unwrap_or_default();
            } else {
                self.infol("bin_not_bootstrapped", &[("path", &b)]);
            }
            if !m_bin.is_empty() && !halted {
                let have = sha256_file(&bin).unwrap_or_default();
                if !have.is_empty() && have != m_bin {
                    let shown = self.s.num("doctor.hash_shown") as usize;
                    self.warnl("bin_hash_differs", &[("path", &b), ("have", &have[..shown.min(have.len())]), ("want", &m_bin[..shown.min(m_bin.len())]), ("bootstrap", &install)]);
                }
            }
            // does it run
            let mut reported = String::new();
            if self.engine_usable {
                let root_env = self.s.text("env.plugin_root");
                let root = self.root.clone().unwrap_or_default();
                let envs = [(root_env.as_str(), root.as_path())];
                let (r, out) = self.run(&[b.clone(), self.s.text("doctor.version_arg")], &envs, Duration::from_secs(self.s.num("doctor_l.run_s").max(1)));
                let first = first_line(&out, self.line_chars());
                match r {
                    Ran::Done(0) => reported = first,
                    other => {
                        self.engine_usable = false;
                        let why = match other {
                            Ran::TimedOut => self.m("why_timeout", &[]),
                            Ran::Done(c) if c > 128 => self.m("why_signal", &[("sig", &(c - 128).to_string()), ("err", &first)]),
                            Ran::Done(c) => self.m("why_exit", &[("code", &c.to_string()), ("err", &first)]),
                            Ran::CannotStart => self.m("why_exit", &[("code", "126"), ("err", &first)]),
                        };
                        self.bad("bin_no_run", &[("path", &b), ("why", &why), ("bootstrap", &install)]);
                    }
                }
            }
            if !reported.is_empty() {
                if !pinned.is_empty() && older_than(&self.s.text("launcher.legacy_scheme_floor"), &reported, &pinned) {
                    self.warnl("bin_version_differs", &[("have", &reported), ("want", &pinned), ("bootstrap", &install)]);
                } else {
                    let triple = format!("{}-{}", self.host_arch, self.host_os);
                    self.ok("bin_ok", &[("path", &b), ("triple", &triple), ("ver", &reported)]);
                }
            } else if !m_ver.is_empty() && !pinned.is_empty() && older_than(&self.s.text("launcher.legacy_scheme_floor"), &m_ver, &pinned) {
                self.warnl("bin_version_differs", &[("have", &m_ver), ("want", &pinned), ("bootstrap", &install)]);
            }
        }
        // the hooks run ah-engine from PATH when the home install is not executable: that engine counts
        if !self.engine_usable && !fs::metadata(&bin).is_ok_and(|m| m.permissions().mode() & 0o111 != 0) && on_path(&self.s.text("doctor.bin_name")) {
            self.engine_usable = true;
            let p = find_on_path(&self.s.text("doctor.bin_name")).map(|f| f.display().to_string()).unwrap_or_default();
            self.infol("engine_on_path", &[("path", &p)]);
        }
    }

    fn rosetta(&self) -> bool {
        let marker = self.knob("doctor_rosetta").unwrap_or_else(|| self.s.text("doctor.rosetta_marker"));
        self.host_os == self.s.text("doctor.macos_name") && self.host_arch == self.s.text("doctor.apple_silicon_name") && Path::new(&marker).exists()
    }

    // ---- State directory -------------------------------------------------------------------------------------------------------------
    fn state(&mut self) {
        self.head("head_state");
        let dir = self.eng_dir.clone();
        let d = dir.display().to_string();
        let md = fs::metadata(&dir);
        if md.as_ref().is_ok_and(|m| !m.is_dir()) {
            let err = self.m("enotdir", &[]);
            return self.bad("state_not_dir", &[("path", &d), ("err", &err)]);
        }
        if let Ok(m) = md {
            let me = crate::util::uid();
            if m.uid() != me {
                return self.bad("state_owner", &[("dir", &d), ("owner", &m.uid().to_string()), ("uid", &me.to_string())]);
            }
            let writable = {
                let probe = dir.join(format!("{}{}", self.s.text("doctor_l.probe_prefix"), std::process::id()));
                let ok = fs::write(&probe, b"").is_ok();
                let _ = fs::remove_file(&probe);
                ok
            };
            if !writable {
                let err = self.m("no_write", &[]);
                return self.bad("state_unwritable", &[("dir", &d), ("err", &err)]);
            }
            if m.permissions().mode() & 0o077 != 0 {
                self.warnl("state_open", &[("dir", &d), ("mode", &mode_octal(&dir))]);
            }
            return self.ok("state_ok", &[("dir", &d)]);
        }
        // missing: find the first existing ancestor
        let mut p = dir.clone();
        let mut blocker: Option<PathBuf> = None;
        let mut parent = dir.clone();
        while let Some(up) = p.parent().map(Path::to_path_buf) {
            p = up;
            if p.exists() && !p.is_dir() {
                blocker = Some(p.clone());
                break;
            }
            if p.is_dir() {
                parent = p.clone();
                break;
            }
        }
        if let Some(bl) = blocker {
            let (b, err) = (bl.display().to_string(), self.m("enotdir", &[]));
            return self.bad("state_not_dir", &[("path", &b), ("err", &err)]);
        }
        let writable = fs::metadata(&parent).is_ok_and(|m| m.permissions().mode() & 0o200 != 0) && {
            let probe = parent.join(format!("{}{}", self.s.text("doctor_l.probe_prefix"), std::process::id()));
            let ok = fs::write(&probe, b"").is_ok();
            let _ = fs::remove_file(&probe);
            ok
        };
        if writable {
            self.infol("state_missing", &[("dir", &d)]);
        } else {
            let err = self.m("no_write_in", &[("parent", &parent.display().to_string())]);
            self.bad("state_uncreatable", &[("dir", &d), ("err", &err)]);
        }
    }

    // ---- Configuration ---------------------------------------------------------------------------------------------------------------
    fn configuration(&mut self) {
        self.head("head_config");
        let Some(root) = self.root.clone() else { return };
        let idx = self.s.text("doctor_l.defaults_index");
        let (def, pri) = (root.join(self.s.text("doctor_l.defaults_dir")), root.join(self.s.text("doctor_l.pristine_dir")));
        if !def.join(&idx).is_file() {
            self.bad("x.builtin_defaults_missing", &[("path", &def.join(&idx).display().to_string())]);
        } else if !pri.join(&idx).is_file() {
            self.warnl("config_no_pristine", &[("dir", &pri.display().to_string())]);
        } else {
            self.ok("x.builtin_defaults_ok", &[]);
        }
    }

    // ---- Hooks wiring (thin form) ------------------------------------------------------------------------------------------------------
    fn thin_check(&mut self, rel: &str, host: &str) {
        let Some(root) = self.root.clone() else { return };
        let f = root.join(rel);
        let Ok(text) = fs::read_to_string(&f) else {
            if host == self.s.text("hooks_form.host_claude") {
                self.bad("thin_missing", &[("file", &f.display().to_string())]);
            }
            return;
        };
        let cmds: Vec<(String, String)> = serde_json::from_str::<serde_json::Value>(&text).map(|v| Self::commands(&v)).unwrap_or_default();
        let thin = |ev: &str, c: &str| self.is_direct_form(host, ev, c);
        let thin_n = cmds.iter().filter(|(ev, c)| thin(ev, c)).count();
        let first = cmds
            .iter()
            .find(|(ev, c)| !thin(ev, c))
            .map(|(ev, c)| format!("{ev}: {}", c.chars().take(self.cmd_chars()).collect::<String>()))
            .unwrap_or_else(|| self.m("no_entry", &[]));
        if !cmds.is_empty() && thin_n == cmds.len() {
            self.ok("thin_ok", &[("file", rel)]);
        } else {
            self.bad("thin_not", &[("file", rel), ("n", &(cmds.len() - thin_n).to_string()), ("first", &first), ("host", host)]);
        }
    }

    /// Whether `cmd` is exactly the direct form (`hooks_form.template`) of `event` for `host`: the installer's path in it is the only
    /// part that varies (the host's plugin-root variable, or a literal path in a copy the host keeps).
    fn is_direct_form(&self, host: &str, event: &str, cmd: &str) -> bool {
        let installer = self.s.text("doctor.bootstrap_script");
        let Some(at) = cmd.find(&installer) else { return false };
        let Some(q) = cmd[..at].rfind('"') else { return false };
        let prefix = cmd[q + 1..at].trim_end_matches('/');
        let host_args = if host == self.s.text("hooks_form.host_codex") { self.s.text("hooks_form.host_args_codex") } else { String::new() };
        cmd == fill(&self.s.text("hooks_form.template"), &[("event", event), ("host_args", &host_args), ("prefix", prefix)])
    }

    fn hooks_wiring(&mut self) {
        self.head("head_thin");
        let Some(root) = self.root.clone() else { return };
        let wrapper = root.join(self.s.text("doctor.wrapper_file"));
        if !wrapper.is_file() {
            self.bad("wrapper_missing", &[("file", &wrapper.display().to_string())]);
        }
        self.thin_check(&self.s.text("doctor_l.hooks_claude_rel"), &self.s.text("hooks_form.host_claude"));
        self.thin_check(&self.s.text("doctor_l.hooks_codex_rel"), &self.s.text("hooks_form.host_codex"));
    }

    // ---- Install health (the thin client's own wiring) -----------------------------------------------------------------------------------
    fn health_fail(&mut self, key: &str, subs: &[(&str, &str)]) {
        if self.s.num("doctor_l.install_health_fail") == 1 { self.bad(key, subs) } else { self.warnl(key, subs) }
    }

    fn glob(&self, pattern: &str) -> Vec<PathBuf> {
        let mut cur: Vec<PathBuf> = vec![PathBuf::new()];
        for (i, seg) in pattern.split('/').enumerate() {
            let mut next = Vec::new();
            for base in &cur {
                if seg.contains('*') {
                    let dir = if base.as_os_str().is_empty() { PathBuf::from("/") } else { base.clone() };
                    if let Ok(rd) = fs::read_dir(&dir) {
                        let mut names: Vec<_> = rd.flatten().map(|e| e.file_name()).collect();
                        names.sort();
                        next.extend(names.into_iter().map(|n| dir.join(n)));
                    }
                } else if i == 0 && seg.is_empty() {
                    next.push(PathBuf::from("/"));
                } else {
                    next.push(base.join(seg));
                }
            }
            cur = next;
        }
        cur.into_iter().filter(|p| p.is_file()).collect()
    }

    /// The hooks files to look at: the plugin's own and the copies the hosts keep (`doctor.hook_files`, `{root}` and `{home}` filled).
    fn hook_files(&self) -> Vec<PathBuf> {
        let root = self.root.as_ref().map(|r| r.display().to_string()).unwrap_or_default();
        let mut v = Vec::new();
        for pat in self.s.list("doctor_l.hook_files") {
            let p = fill(&pat, &[("root", &root), ("home", &self.home)]);
            if pat.contains("{root}") && root.is_empty() {
                continue;
            }
            for f in self.glob(&p) {
                if !v.contains(&f) {
                    v.push(f);
                }
            }
        }
        v
    }

    /// Every `command` of a hooks.json value, with the event it belongs to.
    fn commands(v: &serde_json::Value) -> Vec<(String, String)> {
        let mut out = Vec::new();
        if let Some(h) = v.get("hooks").and_then(|h| h.as_object()) {
            for (ev, groups) in h {
                for g in groups.as_array().into_iter().flatten() {
                    for c in g.get("hooks").and_then(|x| x.as_array()).into_iter().flatten() {
                        if let Some(cmd) = c.get("command").and_then(|x| x.as_str()) {
                            out.push((ev.clone(), cmd.to_string()));
                        }
                    }
                }
            }
        }
        out
    }

    fn old_marker(&self, cmd: &str) -> bool {
        self.s.list("hooks_form.old_markers").iter().any(|m| cmd.contains(m.as_str()))
    }

    fn node_entry(&self, cmd: &str) -> bool {
        let w = self.s.text("hooks_form.node_word");
        cmd.split_whitespace().any(|t| t == w || t.ends_with(&format!("/{w}")))
    }

    fn install_health(&mut self) {
        self.head("x.head_health");
        let install = self.install_cmd();
        // the thin client itself
        let c = self.client.clone();
        let cs = c.display().to_string();
        if !c.is_file() {
            self.health_fail("x.health_client_missing", &[("path", &cs), ("install", &install)]);
        } else if fs::metadata(&c).map_or(true, |m| m.permissions().mode() & 0o111 == 0) {
            let mode = mode_octal(&c);
            self.health_fail("x.health_client_not_exec", &[("path", &cs), ("mode", &mode)]);
        } else {
            let want = fs::read_to_string(self.eng_dir.join(self.s.text("doctor.marker_file"))).ok().and_then(|t| t.split_whitespace().nth(3).map(str::to_string)).unwrap_or_default();
            let have = sha256_file(&c).unwrap_or_default();
            if want.len() == 64 && have != want {
                let n = self.s.num("doctor.hash_shown") as usize;
                self.health_fail("x.health_client_differs", &[("path", &cs), ("have", &have[..n.min(have.len())]), ("want", &want[..n.min(want.len())]), ("install", &install)]);
            } else {
                self.ok("x.health_client_ok", &[("path", &cs)]);
            }
        }
        // the hooks files
        let files = self.hook_files();
        for f in &files {
            let Some(v) = fs::read_to_string(f).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else { continue };
            let cmds = Self::commands(&v);
            if cmds.is_empty() {
                continue;
            }
            let shown = f.display().to_string();
            let old: Vec<&(String, String)> = cmds.iter().filter(|(_, c)| self.old_marker(c)).collect();
            let node: Vec<&(String, String)> = cmds.iter().filter(|(_, c)| self.node_entry(c)).collect();
            if !old.is_empty() {
                let first: String = old[0].1.chars().take(self.cmd_chars()).collect();
                self.health_fail("x.health_hooks_old", &[("file", &shown), ("n", &old.len().to_string()), ("first", &first)]);
            }
            if !node.is_empty() {
                let first: String = node[0].1.chars().take(self.cmd_chars()).collect();
                self.health_fail("x.health_node_entry", &[("file", &shown), ("n", &node.len().to_string()), ("first", &first)]);
            }
            if old.is_empty() && node.is_empty() {
                self.ok("x.health_hooks_ok", &[("file", &shown)]);
            }
        }
        // the shell files the plugin ships
        if let Some(root) = self.root.clone() {
            let mut sh = Vec::new();
            self.scan_sh(&root, &mut sh, 0);
            let keep = root.join(self.s.text("doctor.bootstrap_script"));
            sh.retain(|p| *p != keep);
            sh.sort();
            if sh.is_empty() {
                self.ok("x.health_shipped_sh_ok", &[]);
            } else {
                let first = sh[0].strip_prefix(&root).unwrap_or(&sh[0]).display().to_string();
                self.health_fail("x.health_shipped_sh", &[("n", &sh.len().to_string()), ("first", &first)]);
            }
        }
        // the launchers in ~/.anti-hall/bin
        let bindir = Path::new(&self.home).join(self.s.text("paths.base_dir")).join(self.s.text("doctor_l.shim_dir"));
        if let Ok(rd) = fs::read_dir(&bindir) {
            let (mut n, mut bad) = (0, 0);
            let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
            entries.sort();
            let shebang = self.s.text("doctor_l.shim_shebang");
            for p in entries {
                let text = fs::read_to_string(&p).unwrap_or_default();
                let first = text.lines().next().unwrap_or("").to_string();
                if first.trim() == shebang && !text.lines().skip(1).any(|l| self.node_entry(l)) {
                    n += 1;
                } else {
                    bad += 1;
                    self.health_fail("x.health_shim_bad", &[("path", &p.display().to_string()), ("first", &first.chars().take(self.cmd_chars()).collect::<String>())]);
                }
            }
            if bad == 0 && n > 0 {
                self.ok("x.health_shims_ok", &[("n", &n.to_string()), ("dir", &bindir.display().to_string())]);
            }
        }
        // a statusLine that still runs the retired wrapper
        let settings = Path::new(&self.home).join(self.s.text("doctor_l.claude_settings_rel"));
        if let Some(v) = fs::read_to_string(&settings).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            && let Some(cmd) = v.get("statusLine").and_then(|s| s.get("command")).and_then(|c| c.as_str())
            && self.old_marker(cmd)
        {
            let shown: String = cmd.chars().take(self.cmd_chars()).collect();
            self.health_fail("x.health_statusline_old", &[("file", &settings.display().to_string()), ("command", &shown)]);
        }
    }

    fn scan_sh(&self, dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
        if depth > 8 {
            return;
        }
        let skip = self.s.list("doctor_l.scan_skip_dirs");
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if p.is_dir() && !e.file_type().is_ok_and(|t| t.is_symlink()) {
                if !skip.contains(&name) {
                    self.scan_sh(&p, out, depth + 1);
                }
            } else if p.extension().is_some_and(|x| x == self.s.text("doctor_l.shell_ext").as_str()) {
                out.push(p);
            }
        }
    }

    // ---- Toolchain and environment --------------------------------------------------------------------------------------------------------
    fn toolchain(&mut self) {
        self.head("head_toolchain");
        let home = self.home.clone();
        if home.is_empty() {
            self.bad("home_unset", &[]);
        } else if home.starts_with('/') {
            if !Path::new(&home).is_dir() {
                self.bad("home_not_dir", &[("home", &home)]);
            }
        } else {
            self.bad("home_relative", &[("home", &home)]);
        }
        let path = path_env();
        if path.is_empty() {
            self.bad("path_empty", &[]);
        } else {
            for e in path.split(':') {
                if e.is_empty() {
                    let w = self.m("path_empty_entry", &[]);
                    self.warnl("path_relative", &[("entry", &w)]);
                } else if !e.starts_with('/') {
                    self.warnl("path_relative", &[("entry", e)]);
                }
            }
            let want = self.s.list("doctor_l.path_wanted");
            if !want.iter().any(|d| path.split(':').any(|e| e == d)) {
                self.warnl("path_lacks", &[("dirs", &want.join(", "))]);
            }
        }
        let missing: Vec<String> = self.s.list("doctor.required_tools").into_iter().filter(|t| !on_path(t)).collect();
        if !missing.is_empty() {
            self.warnl("tools_missing", &[("tools", &missing.join(", "))]);
        }
        if self.release.to_lowercase().contains(&self.s.text("install.wsl_word").to_lowercase()) || self.release.contains(&self.s.text("doctor_l.wsl_word_upper")) {
            let r = self.release.clone();
            self.infol("wsl", &[("release", &r)]);
        }
        if !on_path(&self.s.text("doctor_l.git_name")) {
            self.warnl("git_missing", &[]);
        } else {
            let (r, out) = self.run(&[self.s.text("doctor_l.git_name"), self.s.text("doctor_l.version_flag")], &[], self.limit);
            if !matches!(r, Ran::Done(0)) {
                let code = match r { Ran::Done(c) => c.to_string(), _ => "-1".into() };
                let why = format!("exit {code} {}", first_line(&out, self.line_chars()));
                self.warnl("git_broken", &[("why", &why)]);
            }
        }
        if !on_path(&self.s.text("doctor_l.gh_name")) {
            self.infol("gh_missing", &[]);
        }
        if !self.engine_usable {
            self.bad("no_engine", &[]);
        }
    }

    fn verdict(&mut self) -> i32 {
        self.out.push('\n');
        if self.fail == 0 {
            let mut v = self.m("verdict_ok", &[("pass", &self.pass.to_string())]);
            if self.warn > 0 {
                v.push_str(&self.m("verdict_warn", &[("warn", &self.warn.to_string())]));
            }
            self.out.push_str(&format!("{v}\n"));
            0
        } else {
            let v = self.m("verdict_fail", &[("fail", &self.fail.to_string()), ("pass", &self.pass.to_string()), ("warn", &self.warn.to_string())]);
            self.out.push_str(&format!("{v}\n"));
            1
        }
    }

    // ---- repairs --------------------------------------------------------------------------------------------------------------------------
    fn row_repair(&mut self, kind: &str, id: &str, msg: &str) {
        let line = self.m(kind, &[("id", id), ("msg", msg)]);
        self.out.push_str(&format!("  {line}\n"));
    }

    fn backup(&self, p: &Path) -> Option<PathBuf> {
        let mut n = 0;
        loop {
            let mut o = p.as_os_str().to_os_string();
            o.push(format!("{}{}{}", self.s.text("doctor_l.backup_infix"), crate::rec::stamp_name(epoch_s()), if n == 0 { String::new() } else { format!("-{n}") }));
            let b = PathBuf::from(o);
            if !b.exists() {
                return fs::copy(p, &b).ok().map(|_| b);
            }
            n += 1;
            if n > 50 {
                return None;
            }
        }
    }

    /// Rewrite the old-form commands of a hooks file to the direct form; returns how many were rewritten.
    fn rewrite_hooks(&self, v: &mut serde_json::Value) -> usize {
        let mut n = 0;
        let tpl = self.s.text("hooks_form.template");
        let wrapper = self.s.text("doctor_l.wrapper_name");
        let host_codex = self.s.text("hooks_form.host_codex");
        let host_args_codex = self.s.text("hooks_form.host_args_codex");
        let Some(h) = v.get_mut("hooks").and_then(|h| h.as_object_mut()) else { return 0 };
        for groups in h.values_mut() {
            for g in groups.as_array_mut().into_iter().flatten() {
                for c in g.get_mut("hooks").and_then(|x| x.as_array_mut()).into_iter().flatten() {
                    let Some(cmd) = c.get("command").and_then(|x| x.as_str()).map(str::to_string) else { continue };
                    let Some(at) = cmd.find(&wrapper) else { continue };
                    // sh "<prefix>/hooks/ah-hook.sh" <Event> [--host codex]
                    let Some(q) = cmd[..at].rfind('"') else { continue };
                    let hooks_dir = cmd[q + 1..at].trim_end_matches('/');
                    let prefix = hooks_dir.strip_suffix(&self.s.text("hooks_form.hooks_dir_word")).unwrap_or(hooks_dir).trim_end_matches('/');
                    let tail = cmd[at + wrapper.len()..].trim_start_matches('"').trim();
                    let mut words = tail.split_whitespace();
                    let Some(event) = words.next().filter(|e| e.chars().all(|ch| ch.is_ascii_alphanumeric())) else { continue };
                    let host_args = if tail.contains(&format!("--host {host_codex}")) { host_args_codex.clone() } else { String::new() };
                    let new = fill(&tpl, &[("event", event), ("host_args", &host_args), ("prefix", prefix)]);
                    c["command"] = serde_json::Value::String(new);
                    n += 1;
                }
            }
        }
        n
    }

    /// Whether a statusLine command still runs the retired shell wrapper (`sh "<…/scripts/ah-run.sh>" --stdin statusline …`).
    fn statusline_retired(&self, cmd: &str) -> bool {
        let parts = self.s.list("hooks_form.statusline_old_form");
        !parts.is_empty() && cmd.starts_with(&self.s.text("hooks_form.statusline_old_prefix")) && parts.iter().all(|p| cmd.contains(p.as_str()))
    }

    /// Rewrite a statusLine that still runs the retired wrapper to the thin client's command, in place in the file's own text (one
    /// string changes), after a backup; idempotent, nothing is deleted. Returns whether there was anything to do.
    fn repair_statusline(&mut self, dry: bool) -> bool {
        let settings = Path::new(&self.home).join(self.s.text("doctor_l.claude_settings_rel"));
        let Ok(text) = fs::read_to_string(&settings) else { return false };
        let Some(old) = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("statusLine").and_then(|s| s.get("command")).and_then(|c| c.as_str()).map(str::to_string))
        else {
            return false;
        };
        if !self.statusline_retired(&old) || !self.client.is_file() {
            return false;
        }
        let shown = settings.display().to_string();
        let new = fill(&self.s.text("hooks_form.statusline_template"), &[("client", &self.client.display().to_string())]);
        let (old_lit, new_lit) = (serde_json::to_string(&old).unwrap_or_default(), serde_json::to_string(&new).unwrap_or_default());
        let next = text.replacen(&old_lit, &new_lit, 1);
        let reads_back = serde_json::from_str::<serde_json::Value>(&next)
            .ok()
            .and_then(|v| v.get("statusLine").and_then(|s| s.get("command")).and_then(|c| c.as_str()).map(|c| c == new))
            .unwrap_or(false);
        if old_lit.is_empty() || text.matches(&old_lit).count() != 1 || !reads_back {
            let msg = self.m("x.repair_statusline_ambiguous", &[("file", &shown)]);
            self.row_repair("repair_skipped", "statusline", &msg);
            return true;
        }
        if dry {
            let msg = self.m("x.repair_statusline_would", &[("file", &shown), ("command", &new)]);
            self.row_repair("repair_skipped", "statusline", &msg);
            return true;
        }
        let Some(backup) = self.backup(&settings) else {
            let msg = self.m("x.repair_statusline_nobackup", &[("file", &shown)]);
            self.row_repair("repair_failed", "statusline", &msg);
            return true;
        };
        if fs::write(&settings, next).is_ok() {
            let msg = self.m("x.repair_statusline_form", &[("file", &shown), ("command", &new), ("backup", &backup.display().to_string())]);
            self.row_repair("repair_fixed", "statusline", &msg);
        } else {
            let msg = self.m("x.repair_statusline_nowrite", &[("file", &shown)]);
            self.row_repair("repair_failed", "statusline", &msg);
        }
        true
    }

    fn repair(&mut self, dry: bool) {
        let heading = self.m(if dry { "repair_heading_dry" } else { "repair_heading" }, &[]);
        self.out.push_str(&format!("\n{heading}\n"));
        let mut did = false;
        // the execute bit of the binaries
        for p in [self.bin.clone(), self.client.clone()] {
            if p.is_file() && fs::metadata(&p).is_ok_and(|m| m.permissions().mode() & 0o100 == 0) {
                did = true;
                let msg = self.m("x.repair_exec", &[("path", &p.display().to_string())]);
                if dry {
                    self.row_repair("repair_skipped", "exec-bit", &msg);
                } else if fs::set_permissions(&p, fs::Permissions::from_mode(fs::metadata(&p).map_or(0o755, |m| m.permissions().mode() | 0o755))).is_ok() {
                    self.row_repair("repair_fixed", "exec-bit", &msg);
                } else {
                    self.row_repair("repair_failed", "exec-bit", &msg);
                }
            }
        }
        // the state directory
        if !self.eng_dir.exists() {
            did = true;
            let msg = self.m("x.repair_state_dir", &[("dir", &self.eng_dir.display().to_string())]);
            if dry {
                self.row_repair("repair_skipped", "state-dir", &msg);
            } else if fs::create_dir_all(&self.eng_dir).is_ok() && fs::set_permissions(&self.eng_dir, fs::Permissions::from_mode(0o700)).is_ok() {
                self.row_repair("repair_fixed", "state-dir", &msg);
            } else {
                self.row_repair("repair_failed", "state-dir", &msg);
            }
        }
        // hook commands still through the retired wrapper
        for f in self.hook_files() {
            let Some(mut v) = fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else { continue };
            let todo = Self::commands(&v).iter().filter(|(_, c)| c.contains(&self.s.text("doctor_l.wrapper_name"))).count();
            if todo == 0 {
                continue;
            }
            did = true;
            let fs_ = f.display().to_string();
            if dry {
                let msg = self.m("x.repair_hooks_would", &[("n", &todo.to_string()), ("file", &fs_)]);
                self.row_repair("repair_skipped", "hooks-form", &msg);
                continue;
            }
            let n = self.rewrite_hooks(&mut v);
            let Some(backup) = self.backup(&f) else {
                let msg = self.m("x.repair_hooks_nobackup", &[("file", &fs_)]);
                self.row_repair("repair_failed", "hooks-form", &msg);
                continue;
            };
            let body = serde_json::to_string_pretty(&v).unwrap_or_default();
            if fs::write(&f, format!("{body}\n")).is_ok() {
                let msg = self.m("x.repair_hooks_form", &[("n", &n.to_string()), ("file", &fs_), ("backup", &backup.display().to_string())]);
                self.row_repair("repair_fixed", "hooks-form", &msg);
            } else {
                let msg = self.m("x.repair_hooks_nowrite", &[("file", &fs_)]);
                self.row_repair("repair_failed", "hooks-form", &msg);
            }
        }
        // a statusLine that still runs the retired wrapper
        did |= self.repair_statusline(dry);
        if !did {
            let none = self.m("repair_none", &[]);
            self.out.push_str(&format!("  {none}\n"));
        }
    }
}

/// `ah-hook doctor ...`. Exit 0 healthy, 1 failures. When the engine runs and `--builtin` is not given, hands over to `ah-engine doctor`.
pub fn run(s: Settings, cfg_dir: &Path, state: &Path, plugin_root: Option<&Path>, args: &[String]) -> i32 {
    crate::limits::restore_cpu_limit();
    let s = s.with_doctor(cfg_dir);
    let test = env_nonempty(&s.text("launcher.test_flag_env")).is_some_and(|v| v == "1");
    let flag = |f: &str| args.iter().any(|a| a == f);
    let (repair, dry, builtin) = (flag("--repair"), flag("--dry-run"), flag(&s.text("launcher.arg_builtin")));
    let home = std::env::var(s.text("env.home")).unwrap_or_default();
    let eng_dir = if state.as_os_str().is_empty() { PathBuf::from(&home).join(s.text("paths.base_dir")).join(s.text("paths.state_dir")) } else { state.to_path_buf() };
    let bin_dir = eng_dir.join(s.text("rollback.bin_dir"));
    let (bin, client) = (bin_dir.join(s.text("install.member_engine")), bin_dir.join(s.text("install.member_hook")));
    let (hs, hm, hr) = host_uname();
    let knob = |k: &str| if test { env_nonempty(&s.text(&format!("launcher.knob_{k}"))) } else { None };
    let sysname = knob("uname_s").unwrap_or(hs);
    let machine = knob("uname_m").unwrap_or(hm);
    let release = knob("uname_r").unwrap_or(hr);
    let (macos, linux) = (s.text("doctor.macos_name"), s.text("doctor.linux_name"));
    let (host_os, os_name) = if sysname == s.text("install.os_macos") { (macos.clone(), s.text("doctor_l.os_label_macos")) } else if sysname == s.text("install.os_linux") { (linux, s.text("doctor_l.os_label_linux")) } else { (sysname.clone(), sysname.clone()) };
    let (mut host_arch, mut arch_name) = if s.list("install.cpu_arm").contains(&machine) {
        (s.text("doctor.apple_silicon_name"), s.text("doctor_l.arch_label_arm"))
    } else if s.list("install.cpu_x86").contains(&machine) {
        (s.text("doctor.intel_name"), s.text("doctor_l.arch_label_x86"))
    } else {
        (machine.clone(), machine.clone())
    };
    if host_os == macos && host_arch == s.text("doctor.intel_name") && knob("uname_m").is_none() && is_apple_silicon(&s.text("doctor.rosetta_sysctl")) {
        host_arch = s.text("doctor.apple_silicon_name");
        arch_name = s.text("doctor_l.arch_label_arm");
    }
    let limit = Duration::from_secs(s.num("doctor_l.run_s").max(1));
    let mut d = Doc {
        s: &s,
        root: plugin_root.map(Path::to_path_buf),
        home,
        eng_dir,
        out: String::new(),
        pass: 0,
        fail: 0,
        warn: 0,
        host_os,
        host_arch,
        os_name,
        arch_name,
        release,
        test,
        limit,
        engine_usable: false,
        bin: bin.clone(),
        client,
    };
    // the engine runs: its doctor has every check this one makes and more
    if !builtin {
        let ok = fs::metadata(&bin).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0) && {
            let root_env = s.text("env.plugin_root");
            let root = d.root.clone().unwrap_or_default();
            let envs = [(root_env.as_str(), root.as_path())];
            matches!(d.run(&[bin.display().to_string(), s.text("doctor.version_arg")], &envs, limit).0, Ran::Done(0))
        };
        if ok {
            if repair {
                // the repairs only the thin client can make (its own files), then the engine's
                d.repair(dry);
                print_out(&d.out);
                d.out.clear();
            }
            let mut cmd = Command::new(&bin);
            if let Some(r) = &d.root {
                cmd.env(s.text("env.plugin_root"), r);
            }
            crate::launcher::unblock_signals();
            let err = std::os::unix::process::CommandExt::exec(cmd.arg(s.text("doctor_l.cmd_word")).args(args));
            crate::util::say(&err.to_string());
            return 1;
        }
    }
    let title = d.m("title", &[("version", &d.version())]);
    d.out.push_str(&format!("{title}\n"));
    d.environment();
    d.engine();
    d.engine_install();
    d.state();
    d.configuration();
    d.hooks_wiring();
    d.install_health();
    d.toolchain();
    let code = d.verdict();
    if repair {
        d.repair(dry);
    }
    print_out(&d.out);
    code
}

fn print_out(t: &str) {
    use std::io::Write;
    let mut o = std::io::stdout();
    let _ = o.write_all(t.as_bytes());
    let _ = o.flush();
}

/// Whether the engine version `have` is lower than the lock's `want`. The lock names the release the plugin was published with; an
/// engine at or above it (a newer release, a local build) is compatible, since each part has its own version. Unparsable text counts as
/// not older.
fn older_than(floor: &str, have: &str, want: &str) -> bool {
    crate::compat::component_cmp(floor, have, want) == Some(std::cmp::Ordering::Less)
}
