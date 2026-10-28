//! Per-thread CPU time of this process and the cheap work counters next to it: the `ah-engine status --threads` report.
//!
//! The daemon answers the control request `diagnostics.threads_ctl` with one snapshot: every thread's id, name and CPU time
//! (user + system) so far, plus the work counters. The client asks twice, `diagnostics.threads_window_ms` apart, and reports the
//! difference: CPU % of one core per thread (and per thread name, since the workers share one), and the counters per second.
//! The daemon never sleeps for it, so no worker is held while the window runs.
//!
//! * macOS: `task_threads` and `thread_info` (`THREAD_BASIC_INFO` for the times, `THREAD_IDENTIFIER_INFO` for a stable id), the
//!   name through `pthread_from_mach_thread_np` and `pthread_getname_np`.
//! * Linux: `/proc/self/task/<tid>/stat` (utime and stime in clock ticks) and its `comm` name.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - a thread that exits between the listing and the read is simply not in the snapshot
use serde_json::{Value, json};

/// One thread's CPU time so far.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadCpu {
    /// The OS thread id (stable for the thread's life).
    pub tid: u64,
    /// The thread's name (empty when it has none).
    pub name: String,
    /// User plus system CPU time, microseconds.
    pub cpu_us: u64,
}

fn lk<T>(m: &'static std::sync::Mutex<T>) -> std::sync::MutexGuard<'static, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Per thread name: how many threads of that name ended, and the CPU they used over their whole life (microseconds).
static EXITED: std::sync::Mutex<std::collections::BTreeMap<String, (u64, u64)>> = std::sync::Mutex::new(std::collections::BTreeMap::new());
/// Labelled work counters (`site.cause.cached`-style keys) the subsystems add to; they surface in [`work`].
static TALLY: std::sync::Mutex<std::collections::BTreeMap<String, u64>> = std::sync::Mutex::new(std::collections::BTreeMap::new());

/// Add `n` to the work counter `key` (a few counters per reconcile, never one per event).
pub fn tally(key: &str, n: u64) {
    let mut t = lk(&TALLY);
    if let Some(v) = t.get_mut(key) {
        *v += n;
        return;
    }
    let (soft, hard) = (crate::defaults::num("diagnostics.tally_soft_keys") as usize, crate::defaults::num("diagnostics.tally_hard_keys") as usize);
    if t.len() >= hard {
        *t.entry("tally_dropped".to_string()).or_insert(0) += 1; // the hard limit: the key is not kept, the loss is counted
        return;
    }
    if t.len() >= soft {
        *t.entry("tally_soft_hits".to_string()).or_insert(0) += 1; // the soft limit: kept, and counted
    }
    t.insert(key.to_string(), n);
}

/// Spawn a named thread that records its CPU time under its name when `f` returns: short-lived threads are gone from [`snapshot`]
/// by the time a window ends, so without this their CPU is invisible.
pub fn spawn_named<F, T>(name: String, f: F) -> std::io::Result<std::thread::JoinHandle<T>>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let key = name.clone();
    std::thread::Builder::new().name(name).spawn(move || {
        let out = f();
        let e = &mut *lk(&EXITED);
        // bounded like the work counters: past the hard limit a new name is not kept (its CPU stays in the process total)
        if e.contains_key(&key) || e.len() < crate::defaults::num("diagnostics.tally_hard_keys") as usize {
            let row = e.entry(key).or_insert((0, 0));
            row.0 += 1;
            row.1 += crate::limits::thread_cpu_us();
        }
        out
    })
}

/// The exited-thread totals so far, by thread name: `(threads ended, CPU microseconds)`.
pub fn exited() -> std::collections::BTreeMap<String, (u64, u64)> {
    lk(&EXITED).clone()
}

/// Every thread of this process now.
pub fn snapshot() -> Vec<ThreadCpu> {
    os::snapshot()
}

#[cfg(target_os = "macos")]
mod os {
    use super::ThreadCpu;

    unsafe extern "C" {
        fn mach_port_deallocate(task: libc::mach_port_t, name: libc::mach_port_t) -> libc::kern_return_t;
    }

    pub fn snapshot() -> Vec<ThreadCpu> {
        let mut out = Vec::new();
        let mut list: libc::thread_act_array_t = std::ptr::null_mut();
        let mut count: libc::mach_msg_type_number_t = 0;
        #[allow(deprecated)] // libc marks the mach calls deprecated for the mach2 crate; a few calls are not worth a dependency
        // SAFETY: reads this process's own task port (a global the runtime set up).
        let task = unsafe { libc::mach_task_self() };
        // SAFETY: task_threads fills `list` with `count` thread ports it allocated in our address space; both are read below
        // and released (each port, then the array) before returning.
        if unsafe { libc::task_threads(task, &mut list, &mut count) } != libc::KERN_SUCCESS || list.is_null() {
            return out;
        }
        for i in 0..count as usize {
            // SAFETY: `i < count`, the length task_threads returned.
            let th = unsafe { *list.add(i) };
            // SAFETY: a plain C struct, for which all-zero is a valid value.
            let mut basic: libc::thread_basic_info = unsafe { std::mem::zeroed() };
            let mut n = libc::THREAD_BASIC_INFO_COUNT;
            // SAFETY: `basic` is a THREAD_BASIC_INFO buffer of `n` words.
            let ok = unsafe { libc::thread_info(th, libc::THREAD_BASIC_INFO as u32, (&mut basic as *mut libc::thread_basic_info).cast(), &mut n) };
            // SAFETY: a plain C struct, for which all-zero is a valid value.
            let mut ident: libc::thread_identifier_info = unsafe { std::mem::zeroed() };
            let mut m = (std::mem::size_of::<libc::thread_identifier_info>() / std::mem::size_of::<libc::natural_t>()) as libc::mach_msg_type_number_t;
            // SAFETY: `ident` is a THREAD_IDENTIFIER_INFO buffer of `m` words.
            let id_ok = unsafe { libc::thread_info(th, libc::THREAD_IDENTIFIER_INFO as u32, (&mut ident as *mut libc::thread_identifier_info).cast(), &mut m) };
            let mut name = vec![0 as libc::c_char; crate::defaults::num("diagnostics.threads_name_max") as usize];
            // SAFETY: the pthread handle of a live thread port of this task; `name` has room for the `name.len()` bytes asked for.
            unsafe {
                let pt = libc::pthread_from_mach_thread_np(th);
                if pt != 0 {
                    libc::pthread_getname_np(pt, name.as_mut_ptr(), name.len());
                }
            }
            if ok == libc::KERN_SUCCESS {
                let us = |t: libc::time_value_t| t.seconds as u64 * 1_000_000 + t.microseconds as u64;
                // SAFETY: pthread_getname_np NUL-terminates within the buffer (it was zeroed).
                let name = unsafe { std::ffi::CStr::from_ptr(name.as_ptr()) }.to_string_lossy().into_owned();
                out.push(ThreadCpu {
                    tid: if id_ok == libc::KERN_SUCCESS { ident.thread_id } else { th as u64 },
                    name,
                    cpu_us: us(basic.user_time) + us(basic.system_time),
                });
            }
            // SAFETY: each port from task_threads holds one send right that we own.
            unsafe { mach_port_deallocate(task, th) };
        }
        let bytes = count as usize * std::mem::size_of::<libc::thread_act_t>();
        // SAFETY: the array task_threads allocated, released once.
        unsafe { libc::vm_deallocate(task, list as libc::vm_address_t, bytes as libc::vm_size_t) };
        out
    }
}

#[cfg(not(target_os = "macos"))]
mod os {
    use super::ThreadCpu;

    /// utime and stime of one `/proc/<pid>/task/<tid>/stat` line, in clock ticks, and the name: the fields after the
    /// parenthesised name are state(3) ... utime(14) stime(15), so 11 and 12 counted from the state.
    pub fn parse_stat(line: &str) -> Option<(String, u64)> {
        let (head, rest) = line.rsplit_once(')')?;
        let name = head.split_once('(')?.1.to_string();
        let f: Vec<&str> = rest.split_whitespace().collect();
        Some((name, f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?))
    }

    pub fn snapshot() -> Vec<ThreadCpu> {
        // SAFETY: sysconf reads a constant.
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u64;
        let Ok(rd) = std::fs::read_dir(crate::defaults::text("diagnostics.threads_proc_dir")) else { return Vec::new() };
        rd.flatten()
            .filter_map(|e| {
                let tid = e.file_name().to_str()?.parse::<u64>().ok()?;
                let (name, ticks) = parse_stat(&std::fs::read_to_string(e.path().join(crate::defaults::text("diagnostics.threads_proc_stat"))).ok()?)?;
                Some(ThreadCpu { tid, name, cpu_us: ticks * 1_000_000 / hz })
            })
            .collect()
    }
}

#[cfg(not(target_os = "macos"))]
pub use os::parse_stat;

/// The work counters: what the subsystems did since the process started (cumulative; the report turns them into rates).
pub fn work() -> Value {
    use std::sync::atomic::Ordering::Relaxed;
    let mut m = serde_json::Map::new();
    for (k, v) in crate::dswire::watching::work::snapshot() {
        m.insert(format!("dswire_{k}"), json!(v));
    }
    for (k, v) in lk(&TALLY).iter() {
        m.insert(k.clone(), json!(v));
    }
    m.insert("dswire_reconciles".into(), json!(crate::dswire::global().map_or(0, |w| w.reconciles())));
    m.insert("probe_files_read".into(), json!(crate::devswarm_rt::sources::PROBE_FILES_READ.load(Relaxed)));
    m.insert("probe_cache_hits".into(), json!(crate::devswarm_rt::sources::PROBE_CACHE_HITS.load(Relaxed)));
    m.insert("probe_bytes_read".into(), json!(crate::devswarm_rt::sources::PROBE_BYTES_READ.load(Relaxed)));
    m.insert("git_runs".into(), json!(crate::dswire::facts::GIT_RUNS.load(Relaxed)));
    m.insert("git_cache_hits".into(), json!(crate::dswire::facts::GIT_CACHE_HITS.load(Relaxed)));
    Value::Object(m)
}

/// The daemon's answer: the time, every thread's CPU so far, and the work counters.
pub fn snapshot_json() -> Value {
    let threads: Vec<Value> = snapshot().into_iter().map(|t| json!({"tid": t.tid, "name": t.name, "cpu_us": t.cpu_us})).collect();
    let exited: serde_json::Map<String, Value> = exited().into_iter().map(|(n, (c, us))| (n, json!({"exits": c, "cpu_us": us}))).collect();
    json!({"pid": std::process::id(), "at_ms": crate::health::now_ms(), "threads": threads, "exited": exited, "work": work()})
}

/// The report from two snapshots `a` (earlier) and `b`: per thread and per thread name the CPU % of one core over the window,
/// busiest first, and every work counter per second. A thread born inside the window counts from zero.
pub fn report(a: &Value, b: &Value, wall_us: u64) -> Value {
    let wall = wall_us.max(1) as f64;
    let before = |tid: u64| {
        a.get("threads")
            .and_then(Value::as_array)
            .and_then(|v| v.iter().find(|t| t.get("tid") == Some(&json!(tid))))
            .and_then(|t| t.get("cpu_us")?.as_u64())
            .unwrap_or(0)
    };
    let mut rows: Vec<(String, u64, f64, u64)> = Vec::new();
    for t in b.get("threads").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        let (tid, cpu) = (t.get("tid").and_then(Value::as_u64).unwrap_or(0), t.get("cpu_us").and_then(Value::as_u64).unwrap_or(0));
        let d = cpu.saturating_sub(before(tid));
        rows.push((t.get("name").and_then(Value::as_str).unwrap_or_default().to_string(), tid, 100.0 * d as f64 / wall, cpu));
    }
    rows.sort_by(|x, y| y.2.total_cmp(&x.2));
    let round = |p: f64| (p * 100.0).round() / 100.0;
    let mut by_name: Vec<(String, f64, usize)> = Vec::new();
    for (n, _, p, _) in &rows {
        match by_name.iter_mut().find(|(m, _, _)| m == n) {
            Some(e) => {
                e.1 += p;
                e.2 += 1;
            }
            None => by_name.push((n.clone(), *p, 1)),
        }
    }
    by_name.sort_by(|x, y| y.1.total_cmp(&x.1));
    let rate = |k: &str, v: &Value| {
        let d = v.as_u64().unwrap_or(0).saturating_sub(a["work"][k].as_u64().unwrap_or(0));
        (k.to_string(), json!(round(d as f64 * 1e6 / wall)))
    };
    let work: serde_json::Map<String, Value> = b["work"].as_object().map(|m| m.iter().map(|(k, v)| rate(k, v)).collect()).unwrap_or_default();
    // threads that ended: their CPU is the difference of the totals (a live thread's CPU is in `by_name`)
    let gone = |v: &Value, n: &str, k: &str| v.get("exited").and_then(|e| e.get(n)).and_then(|e| e.get(k)).and_then(Value::as_u64).unwrap_or(0);
    let mut exited_by_name: Vec<(String, u64, f64, u64)> = b["exited"]
        .as_object()
        .map(|m| {
            m.keys()
                .map(|n| {
                    let us = gone(b, n, "cpu_us").saturating_sub(gone(a, n, "cpu_us"));
                    (n.clone(), gone(b, n, "exits").saturating_sub(gone(a, n, "exits")), 100.0 * us as f64 / wall, us / 1000)
                })
                .collect()
        })
        .unwrap_or_default();
    exited_by_name.sort_by(|x, y| y.2.total_cmp(&x.2));
    json!({
        "running": true,
        "pid": b["pid"],
        "window_ms": wall_us / 1000,
        "cpu_pct_total": round(rows.iter().map(|r| r.2).sum()),
        "by_name": by_name.iter().map(|(n, p, c)| json!({"name": n, "threads": c, "cpu_pct": round(*p)})).collect::<Vec<_>>(),
        "exited_by_name": exited_by_name.iter().map(|(n, c, p, ms)| json!({"name": n, "exits": c, "cpu_pct": round(*p), "cpu_ms": ms, "cpu_total_ms": gone(b, n, "cpu_us") / 1000})).collect::<Vec<_>>(),
        "threads": rows.iter().map(|(n, t, p, c)| json!({"name": n, "tid": t, "cpu_pct": round(*p), "cpu_total_ms": c / 1000})).collect::<Vec<_>>(),
        "work_per_s": work,
        "work_total": b["work"],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_busy_named_thread_shows_up_with_its_cpu() {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let s = stop.clone();
        let h = std::thread::Builder::new()
            .name("ah-test-spin".into())
            .spawn(move || {
                let mut x = 0u64;
                while !s.load(std::sync::atomic::Ordering::Relaxed) {
                    x = std::hint::black_box(x.wrapping_add(1));
                }
            })
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let a = snapshot_json();
        let t0 = std::time::Instant::now();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let b = snapshot_json();
        let r = report(&a, &b, t0.elapsed().as_micros() as u64);
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        h.join().unwrap();
        let spin = r["by_name"].as_array().unwrap().iter().find(|t| t["name"] == "ah-test-spin").cloned().unwrap_or(Value::Null);
        assert!(spin["cpu_pct"].as_f64().unwrap_or(0.0) > 30.0, "the spinning thread is busy: {r}");
        assert!(r["work_per_s"].is_object());
    }

    #[test]
    fn an_exited_thread_keeps_its_cpu_under_its_name() {
        let a = snapshot_json();
        let t0 = std::time::Instant::now();
        for _ in 0..3 {
            spawn_named("ah-test-brief".into(), || {
                let mut x = 0u64;
                let t = std::time::Instant::now();
                while t.elapsed() < std::time::Duration::from_millis(40) {
                    x = std::hint::black_box(x.wrapping_add(1));
                }
            })
            .unwrap()
            .join()
            .unwrap();
        }
        let b = snapshot_json();
        let r = report(&a, &b, t0.elapsed().as_micros() as u64);
        let row = r["exited_by_name"].as_array().unwrap().iter().find(|t| t["name"] == "ah-test-brief").cloned().unwrap_or(Value::Null);
        assert_eq!(row["exits"], json!(3), "{r}");
        assert!(row["cpu_pct"].as_f64().unwrap_or(0.0) > 30.0, "three 40 ms spinners over ~120 ms of wall are mostly CPU: {r}");
        assert!(row["cpu_ms"].as_u64().unwrap_or(0) > 0, "the exited threads' cumulative CPU is reported in ms, not only as a window percentage: {r}");
        tally("test_tally", 2);
        assert_eq!(work()["test_tally"], json!(2));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_proc_stat_line_with_spaces_in_the_name_parses() {
        let l = "123 (ah dswire) S 1 1 1 0 -1 4194560 10 0 0 0 250 50 0 0 20 0 17 0 100 0 0";
        assert_eq!(parse_stat(l), Some(("ah dswire".to_string(), 300)));
    }
}
