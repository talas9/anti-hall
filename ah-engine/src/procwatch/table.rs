//! The process table behind the watch, read straight from the operating system with `libc` (macOS: `proc_listallpids`, `proc_pidinfo`,
//! `KERN_PROCARGS2`, `vm.swapusage`; Linux: `/proc`), so the binary links nothing but libSystem on macOS: the `sysinfo` crate pulls
//! IOKit and CoreFoundation in, which cost every short-lived invocation (hook, version, statusline) about a millisecond of dyld work.
//!
//! One interface, [`Table`], two implementations behind `cfg(target_os)`. The text parsers (`/proc/<pid>/stat`, `/proc/meminfo`,
//! the `KERN_PROCARGS2` buffer) are pure and tested from fixtures on either operating system.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - a process that vanished, or whose data the system will not give (another user, a protected binary), is the absent value
//   (fail-safe: nothing is done to it)

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

/// What one pass over a process yields.
struct Raw {
    ppid: u32,
    start_s: u64,
    /// Cumulative CPU time (user + system), nanoseconds.
    cpu_ns: u64,
    /// Resident set, bytes (0 when the system will not say).
    rss: u64,
    /// The short program name.
    name: String,
}

/// One row of the table, before the physical-footprint upgrade [`super::host`] applies.
pub struct Row {
    /// Process id.
    pub pid: u32,
    /// Parent process id.
    pub ppid: u32,
    /// Start time, seconds since the epoch.
    pub start_s: u64,
    /// CPU use in per-core percent; 0 on the first reading of a process.
    pub cpu_pct: f32,
    /// Resident set, bytes (0 when the system will not say).
    pub rss: u64,
    /// The command line, or the program name when the system hides the arguments.
    pub cmd: String,
}

/// The process table with the history CPU percentages need.
pub struct Table {
    /// Per pid: cumulative CPU nanoseconds and when it was read.
    cpu: HashMap<u32, (u64, Instant)>,
    /// Per pid: (start time, command line), read once per process.
    cmds: HashMap<u32, (u64, String)>,
    sys: sys::State,
}

impl Default for Table {
    fn default() -> Table {
        Table::new()
    }
}

impl Table {
    /// An empty table; the first reading of a process has no CPU percentage.
    pub fn new() -> Table {
        Table { cpu: HashMap::new(), cmds: HashMap::new(), sys: sys::State::new() }
    }

    /// Every process the system lists; processes that are gone leave the history.
    pub fn list(&mut self) -> Vec<Row> {
        let now = Instant::now();
        let mut rows = Vec::new();
        let mut cpu = HashMap::new();
        let mut cmds = HashMap::new();
        for pid in self.sys.pids() {
            if let Some(r) = self.read(pid, now) {
                cpu.insert(pid, (self.cpu[&pid].0, now));
                cmds.insert(pid, self.cmds[&pid].clone());
                rows.push(r);
            }
        }
        self.cpu = cpu;
        self.cmds = cmds;
        rows
    }

    /// One process, `None` when it is gone.
    pub fn one(&mut self, pid: u32) -> Option<Row> {
        self.read(pid, Instant::now())
    }

    fn read(&mut self, pid: u32, now: Instant) -> Option<Row> {
        let raw = self.sys.sample(pid)?;
        let cpu_pct = match self.cpu.get(&pid) {
            Some((prev, at)) if raw.cpu_ns >= *prev => {
                let wall = now.duration_since(*at).as_nanos() as f64;
                if wall > 0.0 { ((raw.cpu_ns - prev) as f64 / wall * 100.0) as f32 } else { 0.0 }
            }
            _ => 0.0,
        };
        self.cpu.insert(pid, (raw.cpu_ns, now));
        let cmd = match self.cmds.get(&pid) {
            Some((start, c)) if *start == raw.start_s => c.clone(),
            _ => {
                let c = self.sys.cmdline(pid).filter(|c| !c.is_empty()).unwrap_or(raw.name);
                self.cmds.insert(pid, (raw.start_s, c.clone()));
                c
            }
        };
        Some(Row { pid, ppid: raw.ppid, start_s: raw.start_s, cpu_pct, rss: raw.rss, cmd })
    }

    /// The environment of a process (`KEY=value` entries), empty when the system will not show it.
    pub fn environ(&mut self, pid: u32) -> Vec<(String, String)> {
        self.sys.environ(pid)
    }

    /// The working directory of a process.
    pub fn cwd(&self, pid: u32) -> Option<PathBuf> {
        sys::cwd(pid)
    }

    /// Swap in use, bytes (0 when unknown).
    pub fn swap_used(&self) -> u64 {
        sys::swap_used()
    }
}

/// Split `KEY=value` strings; entries without `=` or with an empty key are skipped.
fn split_env<'a>(items: impl Iterator<Item = &'a [u8]>) -> Vec<(String, String)> {
    items
        .filter_map(|e| {
            let s = String::from_utf8_lossy(e);
            let (k, v) = s.split_once('=')?;
            (!k.is_empty()).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

/// The `KERN_PROCARGS2` buffer: `argc` (native i32), the executable path, NUL padding, `argc` argument strings, then the
/// environment strings. Returns (arguments, environment strings); `None` for a buffer too short to hold the count.
#[allow(clippy::type_complexity)]
pub fn parse_procargs2(buf: &[u8]) -> Option<(Vec<Vec<u8>>, Vec<Vec<u8>>)> {
    let argc = i32::from_ne_bytes(buf.get(..4)?.try_into().ok()?).max(0) as usize;
    let mut rest = &buf[4..];
    // the executable path, then the NUL padding up to the first argument
    rest = &rest[rest.iter().position(|b| *b == 0)?..];
    rest = &rest[rest.iter().position(|b| *b != 0).unwrap_or(rest.len())..];
    let mut args = Vec::with_capacity(argc);
    for _ in 0..argc {
        if rest.is_empty() {
            break;
        }
        let end = rest.iter().position(|b| *b == 0).unwrap_or(rest.len());
        args.push(rest[..end].to_vec());
        rest = &rest[(end + 1).min(rest.len())..];
    }
    let env = rest.split(|b| *b == 0).filter(|e| !e.is_empty()).map(<[u8]>::to_vec).collect();
    Some((args, env))
}

/// `/proc/<pid>/stat`: (name, ppid, utime ticks, stime ticks, start ticks, resident pages). The name is the text between the first
/// `(` and the last `)` (it may hold spaces and parentheses); the numeric fields follow it.
pub fn parse_proc_stat(text: &str) -> Option<(String, u32, u64, u64, u64, u64)> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    if close < open {
        return None;
    }
    let f: Vec<&str> = text[close + 1..].split_whitespace().collect();
    // fields after the name: 0 state, 1 ppid, 11 utime, 12 stime, 19 starttime, 21 rss
    let n = |i: usize| f.get(i)?.parse::<u64>().ok();
    Some((text[open + 1..close].to_string(), n(1)? as u32, n(11)?, n(12)?, n(19)?, n(21)?))
}

/// `/proc/meminfo`: swap in use in bytes (`SwapTotal` minus `SwapFree`, both in kB).
pub fn parse_swap_used(text: &str) -> u64 {
    let kb = |key: &str| text.lines().find_map(|l| l.strip_prefix(key)?.trim_start_matches(':').split_whitespace().next()?.parse::<u64>().ok());
    match (kb("SwapTotal"), kb("SwapFree")) {
        (Some(t), Some(f)) => t.saturating_sub(f).saturating_mul(1024),
        _ => 0,
    }
}

#[cfg(target_os = "macos")]
mod sys {
    use super::{Raw, parse_procargs2, split_env};
    use crate::defaults;
    use std::path::PathBuf;

    pub struct State {
        /// Nanoseconds per mach time unit, as numerator and denominator.
        timebase: (u64, u64),
        /// Reusable `KERN_PROCARGS2` buffer, `kern.argmax` bytes.
        buf: Vec<u8>,
    }

    fn cstr(a: &[libc::c_char]) -> String {
        let bytes: Vec<u8> = a.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    impl State {
        #[allow(deprecated)] // libc marks mach_timebase_info deprecated for the mach2 crate; one call is not worth a dependency
        pub fn new() -> State {
            let mut tb = libc::mach_timebase_info { numer: 0, denom: 0 };
            // SAFETY: `tb` is a live, writable mach_timebase_info.
            let ok = unsafe { libc::mach_timebase_info(&mut tb) } == 0 && tb.numer != 0 && tb.denom != 0;
            let timebase = if ok { (tb.numer as u64, tb.denom as u64) } else { (1, 1) };
            let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
            let mut argmax: libc::c_int = 0;
            let mut len = std::mem::size_of::<libc::c_int>();
            // SAFETY: a two-integer mib, an output slot of the size passed, no new value.
            let rc = unsafe { libc::sysctl(mib.as_mut_ptr(), 2, (&mut argmax as *mut libc::c_int).cast(), &mut len, std::ptr::null_mut(), 0) };
            // without the limit the buffer stays empty: every command line then falls back to the program name
            let size = if rc == 0 && argmax > 0 { argmax as usize } else { 0 };
            State { timebase, buf: vec![0; size] }
        }

        pub fn pids(&mut self) -> Vec<u32> {
            // SAFETY: with a null buffer proc_listallpids returns the number of processes (not bytes).
            let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
            if count <= 0 {
                return Vec::new();
            }
            // room for processes that start between the two calls
            let mut pids = vec![0 as libc::pid_t; count as usize + count as usize / 8 + 16];
            // SAFETY: the buffer is `pids.len() * 4` writable bytes and that size is what is passed.
            let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int) };
            if got <= 0 {
                return Vec::new();
            }
            pids.truncate(got as usize);
            pids.into_iter().filter(|p| *p > 0).map(|p| p as u32).collect()
        }

        pub fn sample(&mut self, pid: u32) -> Option<Raw> {
            // SAFETY: a zeroed proc_bsdinfo is a valid value of the plain C struct.
            let mut bsd: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
            // SAFETY: `bsd` is a live, writable struct of the flavour and size passed.
            let rc = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, (&mut bsd as *mut libc::proc_bsdinfo).cast(), size) };
            if rc < size {
                return self.short(pid);
            }
            // SAFETY: as above, for the task flavour; another user's process refuses it and the CPU and memory stay zero.
            let mut task: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
            let tsize = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
            // SAFETY: `task` is a live, writable struct of the flavour and size passed.
            let rc = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTASKINFO, 0, (&mut task as *mut libc::proc_taskinfo).cast(), tsize) };
            let (cpu_ns, rss) = if rc == tsize {
                let ticks = task.pti_total_user.saturating_add(task.pti_total_system);
                (ticks.saturating_mul(self.timebase.0) / self.timebase.1, task.pti_resident_size)
            } else {
                (0, 0)
            };
            let name = if bsd.pbi_name[0] != 0 { cstr(&bsd.pbi_name) } else { cstr(&bsd.pbi_comm) };
            Some(Raw { ppid: bsd.pbi_ppid, start_s: bsd.pbi_start_tvsec, cpu_ns, rss, name })
        }

        /// A process the full record is refused for (another user, a system daemon) still has a parent and a name; no start time,
        /// CPU or memory. `None` when even that is refused (the process is gone).
        fn short(&self, pid: u32) -> Option<Raw> {
            // SAFETY: a zeroed proc_bsdshortinfo is a valid value of the plain C struct.
            let mut b: libc::proc_bsdshortinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of::<libc::proc_bsdshortinfo>() as libc::c_int;
            // SAFETY: `b` is a live, writable struct of the flavour and size passed.
            let rc = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDT_SHORTBSDINFO, 0, (&mut b as *mut libc::proc_bsdshortinfo).cast(), size) };
            (rc == size).then(|| Raw { ppid: b.pbsi_ppid, start_s: 0, cpu_ns: 0, rss: 0, name: cstr(&b.pbsi_comm) })
        }

        /// The raw `KERN_PROCARGS2` buffer of a process (the first `n` bytes of `self.buf`).
        fn procargs(&mut self, pid: u32) -> Option<usize> {
            let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
            let mut len = self.buf.len();
            // SAFETY: a three-integer mib, an output buffer of `len` writable bytes, no new value; failure (gone, another user) is None.
            let rc = unsafe { libc::sysctl(mib.as_mut_ptr(), 3, self.buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) };
            (rc == 0 && len > 4).then_some(len)
        }

        pub fn cmdline(&mut self, pid: u32) -> Option<String> {
            let n = self.procargs(pid)?;
            let (args, _) = parse_procargs2(&self.buf[..n])?;
            Some(args.iter().map(|a| String::from_utf8_lossy(a).into_owned()).collect::<Vec<_>>().join(" "))
        }

        pub fn environ(&mut self, pid: u32) -> Vec<(String, String)> {
            let Some(n) = self.procargs(pid) else { return Vec::new() };
            let Some((_, env)) = parse_procargs2(&self.buf[..n]) else { return Vec::new() };
            split_env(env.iter().map(Vec::as_slice))
        }
    }

    pub fn cwd(pid: u32) -> Option<PathBuf> {
        // SAFETY: a zeroed proc_vnodepathinfo is a valid value of the plain C struct.
        let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
        // SAFETY: `info` is a live, writable struct of the flavour and size passed.
        let rc = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), size) };
        if rc < size {
            return None;
        }
        // SAFETY: vip_path is MAXPATHLEN bytes laid out as [[c_char; 32]; 32]; view it as one NUL-terminated byte string.
        let bytes: &[u8] = unsafe { std::slice::from_raw_parts(info.pvi_cdir.vip_path.as_ptr().cast::<u8>(), 1024) };
        let end = bytes.iter().position(|b| *b == 0)?;
        (end > 0).then(|| {
            use std::os::unix::ffi::OsStrExt;
            PathBuf::from(std::ffi::OsStr::from_bytes(&bytes[..end]))
        })
    }

    /// `xsw_usage` of `vm.swapusage`.
    #[repr(C)]
    struct Swap {
        total: u64,
        avail: u64,
        used: u64,
        pagesize: u32,
        encrypted: u8,
    }

    pub fn swap_used() -> u64 {
        let Ok(name) = std::ffi::CString::new(defaults::text("resource_watch.mac_swap_sysctl")) else { return 0 };
        let mut s = Swap { total: 0, avail: 0, used: 0, pagesize: 0, encrypted: 0 };
        let mut len = std::mem::size_of::<Swap>();
        // SAFETY: the name is NUL-terminated; `s` is a live repr(C) struct of the kernel's xsw_usage layout and `len` its size.
        let rc = unsafe { libc::sysctlbyname(name.as_ptr(), (&mut s as *mut Swap).cast(), &mut len, std::ptr::null_mut(), 0) };
        if rc == 0 { s.used } else { 0 }
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    use super::{Raw, parse_proc_stat, parse_swap_used, split_env};
    use crate::defaults;
    use std::path::PathBuf;

    pub struct State {
        clk_tck: u64,
        page: u64,
        boot_s: u64,
    }

    impl State {
        pub fn new() -> State {
            // SAFETY: sysconf takes a plain integer name.
            let clk = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
            // SAFETY: as above.
            let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
            let boot_s = std::fs::read_to_string("/proc/stat")
                .ok()
                .and_then(|t| t.lines().find_map(|l| l.strip_prefix("btime ")?.trim().parse::<u64>().ok()))
                .unwrap_or(0);
            State { clk_tck: clk.max(1) as u64, page: page.max(1) as u64, boot_s }
        }

        pub fn pids(&mut self) -> Vec<u32> {
            let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
            dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok()).collect()
        }

        pub fn sample(&mut self, pid: u32) -> Option<Raw> {
            let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let (name, ppid, ut, st, start, rss) = parse_proc_stat(&text)?;
            Some(Raw {
                ppid,
                start_s: self.boot_s + start / self.clk_tck,
                cpu_ns: (ut + st).saturating_mul(1_000_000_000) / self.clk_tck,
                rss: rss.saturating_mul(self.page),
                name,
            })
        }

        pub fn cmdline(&mut self, pid: u32) -> Option<String> {
            let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
            let parts: Vec<String> = bytes.split(|b| *b == 0).filter(|a| !a.is_empty()).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
            Some(parts.join(" "))
        }

        pub fn environ(&mut self, pid: u32) -> Vec<(String, String)> {
            let Ok(bytes) = std::fs::read(format!("/proc/{pid}/environ")) else { return Vec::new() };
            split_env(bytes.split(|b| *b == 0).filter(|e| !e.is_empty()))
        }
    }

    pub fn cwd(pid: u32) -> Option<PathBuf> {
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }

    pub fn swap_used() -> u64 {
        std::fs::read_to_string(defaults::text("resource_watch.meminfo_path")).map(|t| parse_swap_used(&t)).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn procargs(argc: i32, exe: &str, args: &[&str], env: &[&str]) -> Vec<u8> {
        let mut b = argc.to_ne_bytes().to_vec();
        b.extend(exe.as_bytes());
        b.extend([0, 0, 0]); // terminator plus padding
        for s in args.iter().chain(env) {
            b.extend(s.as_bytes());
            b.push(0);
        }
        b
    }

    #[test]
    fn procargs2_splits_arguments_from_environment() {
        let b = procargs(2, "/bin/sh", &["sh", "-c"], &["A=1", "B=two words", "NOEQ"]);
        let (args, env) = parse_procargs2(&b).unwrap();
        assert_eq!(args, vec![b"sh".to_vec(), b"-c".to_vec()]);
        assert_eq!(split_env(env.iter().map(Vec::as_slice)), vec![("A".into(), "1".into()), ("B".into(), "two words".into())]);
    }

    #[test]
    fn procargs2_tolerates_no_environment_an_empty_argument_and_short_buffers() {
        let (args, env) = parse_procargs2(&procargs(2, "/x", &["x", ""], &[])).unwrap();
        assert_eq!(args, vec![b"x".to_vec(), Vec::new()]);
        assert!(env.is_empty());
        assert!(parse_procargs2(&[1, 0]).is_none());
        assert!(parse_procargs2(&1i32.to_ne_bytes()).is_none());
        // argc larger than the strings present: take what is there
        assert_eq!(parse_procargs2(&procargs(5, "/x", &["x"], &[])).unwrap().0.len(), 1);
    }

    #[test]
    fn proc_stat_survives_spaces_and_parentheses_in_the_name() {
        let line = "4242 (my (odd) name) S 17 4242 4242 0 -1 4194560 100 0 0 0 33 44 0 0 20 0 1 0 98765 1000000 321 18446744073709551615";
        assert_eq!(parse_proc_stat(line), Some(("my (odd) name".to_string(), 17, 33, 44, 98765, 321)));
        assert_eq!(parse_proc_stat("garbage"), None);
        assert_eq!(parse_proc_stat("1 (x) S 1 2"), None);
    }

    #[test]
    fn swap_used_is_total_minus_free_in_bytes() {
        let t = "MemTotal:  1000 kB\nSwapCached: 0 kB\nSwapTotal:  4096 kB\nSwapFree:   1024 kB\n";
        assert_eq!(parse_swap_used(t), 3072 * 1024);
        assert_eq!(parse_swap_used("MemTotal: 1 kB\n"), 0);
        assert_eq!(parse_swap_used("SwapTotal: 0 kB\nSwapFree: 0 kB\n"), 0);
    }

    /// Only ever run as the child of the test below.
    #[test]
    #[ignore]
    fn parked_child_for_the_table_test() {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }

    /// The real table, on whichever system runs the test: this process and a child it spawned with a known environment.
    #[test]
    fn the_real_table_sees_this_process_and_a_child() {
        // a child that is not a protected system binary (macOS hides the environment of those): this test binary, parked in the
        // helper test below
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "procwatch::table::tests::parked_child_for_the_table_test", "--nocapture"])
            .env("AH_TABLE_TEST", "marker-7")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let me = std::process::id();
        let mut t = Table::new();
        let rows = t.list();
        let mine = rows.iter().find(|r| r.pid == me).expect("own process listed");
        assert_eq!(mine.ppid, std::os::unix::process::parent_id());
        assert!(mine.rss > 0 && !mine.cmd.is_empty());
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        assert!(mine.start_s <= now && now - mine.start_s < 86_400 * 7, "start {} now {now}", mine.start_s);
        let kid = t.one(pid).expect("child listed");
        assert_eq!(kid.ppid, me);
        assert!(kid.cmd.contains("parked_child_for_the_table_test"), "{}", kid.cmd);
        let env = t.environ(pid);
        assert_eq!(super::super::host::env_get(&env, "AH_TABLE_TEST"), Some("marker-7"), "{} entries", env.len());
        assert_eq!(t.cwd(me).map(|p| p.canonicalize().unwrap()), Some(std::env::current_dir().unwrap().canonicalize().unwrap()));
        // CPU: the first reading is 0, a busy second one is positive
        assert_eq!(mine.cpu_pct, 0.0);
        let t0 = std::time::Instant::now();
        let mut x = 0u64;
        while t0.elapsed() < std::time::Duration::from_millis(300) {
            x = std::hint::black_box(x.wrapping_add(1));
        }
        assert!(t.one(me).unwrap().cpu_pct > 0.0);
        assert!(t.one(u32::MAX - 1).is_none());
        let _ = t.swap_used();
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
