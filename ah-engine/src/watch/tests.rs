use super::*;
use std::fs;
use std::io::Write;

const MS: Duration = Duration::from_millis(1);

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

fn cfg(poll_ms: u64) -> Config {
    Config {
        backend: "auto".into(),
        poll: ms(poll_ms),
        debounce: ms(40),
        max_delay: ms(400),
        queue_cap: 64,
        max_entries: 256,
        fs_poll_types: vec!["9p".into(), "drvfs".into(), "nfs".into(), "smbfs".into(), "fuse*".into()],
        sqlite_suffixes: vec!["-wal".into(), "-shm".into(), "-journal".into()],
        latency_target: ms(1000),
        cpu_budget_permille: 5,
    }
}

fn bk(backend: &str, poll_ms: u64) -> Config {
    let mut c = cfg(poll_ms);
    c.backend = backend.into();
    c
}

/// Run a test body once with the poll backend forced and once with `auto` (OS events on a local filesystem).
macro_rules! both {
    ($name:ident, |$b:ident| $body:block) => {
        mod $name {
            use super::*;
            fn run($b: &str) $body
            #[test]
            fn with_poll() {
                run("poll")
            }
            #[test]
            fn with_events() {
                run("auto")
            }
        }
    };
}

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Tmp {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("ah-watch-{tag}-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        crate::discard::harmless(fs::remove_dir_all(&p));
        fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        crate::discard::harmless(fs::remove_dir_all(&self.0)); // our own tempdir
    }
}

fn drain(w: &Watcher, quiet: Duration) -> Vec<Batch> {
    let mut out = Vec::new();
    while let Some(b) = w.next(quiet) {
        out.push(b);
    }
    out
}

/// FSEvents replays changes made just before a stream starts; those are legitimate hints (a consumer reconciles at start), so a
/// test that creates fixtures right before `add` lets them pass first.
fn settle(w: &Watcher) {
    drain(w, ms(250));
}

fn paths(bs: &[Batch]) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = bs.iter().flat_map(|b| b.paths.clone()).collect();
    v.sort();
    v.dedup();
    v
}

// ---- coalescer, synthetic clock ------------------------------------------------------------------------------------

#[test]
fn a_burst_on_one_file_is_one_report_after_it_goes_quiet() {
    let t0 = Instant::now();
    let mut c = Coalescer::new(8, ms(100), ms(1000));
    for i in 0..50 {
        c.push(PathBuf::from("/d/a"), t0 + i * ms(2));
    }
    assert_eq!(c.held(), 1);
    assert!(c.take_ready(t0 + ms(150)).is_none(), "still inside the debounce of the last write");
    let b = c.take_ready(t0 + ms(200)).unwrap();
    assert_eq!(b, Batch { rescan: false, paths: vec![PathBuf::from("/d/a")] });
    assert!(c.take_ready(t0 + ms(5000)).is_none());
}

#[test]
fn a_file_that_never_goes_quiet_is_still_reported_at_the_ceiling() {
    let t0 = Instant::now();
    let mut c = Coalescer::new(8, ms(100), ms(500));
    for i in 0..100 {
        c.push(PathBuf::from("/d/a"), t0 + i * ms(10));
    }
    assert!(c.take_ready(t0 + ms(499)).is_none());
    assert_eq!(c.take_ready(t0 + ms(500)).unwrap().paths.len(), 1);
}

#[test]
fn overflow_drops_the_held_files_and_yields_exactly_one_rescan() {
    let t0 = Instant::now();
    let mut c = Coalescer::new(4, ms(50), ms(500));
    for i in 0..1000 {
        c.push(PathBuf::from(format!("/d/f{i}")), t0 + (i as u32) * MS);
        assert!(c.held() <= 4, "the queue never exceeds its cap");
    }
    assert_eq!(c.held(), 0);
    let b = c.take_ready(t0 + ms(2000)).unwrap();
    assert_eq!(b, Batch { rescan: true, paths: vec![] });
    assert!(c.take_ready(t0 + ms(9000)).is_none(), "one signal, not one per overflowing push");
}

#[test]
fn next_due_names_the_earliest_ready_time() {
    let t0 = Instant::now();
    let mut c = Coalescer::new(8, ms(100), ms(1000));
    assert_eq!(c.next_due(), None);
    c.push("/a".into(), t0);
    c.push("/b".into(), t0 + ms(30));
    assert_eq!(c.next_due(), Some(t0 + ms(100)));
}

// ---- real directories ----------------------------------------------------------------------------------------------

both!(create_modify_and_delete_are_reported_for_the_watched_names, |b| {
    let t = Tmp::new("cmd");
    let w = Watcher::start(bk(b, 20));
    w.add(&t.0, Filter::All);
    let f = t.0.join("a.json");
    fs::write(&f, "1").unwrap();
    assert_eq!(paths(&drain(&w, ms(300))), vec![f.clone()], "create");
    fs::write(&f, "22").unwrap();
    assert_eq!(paths(&drain(&w, ms(300))), vec![f.clone()], "modify");
    fs::remove_file(&f).unwrap();
    assert_eq!(paths(&drain(&w, ms(300))), vec![f.clone()], "delete");
    assert!(w.next(ms(150)).is_none(), "quiet when nothing changes");
});

both!(only_the_named_files_are_watched, |b| {
    let t = Tmp::new("names");
    let w = Watcher::start(bk(b, 20));
    w.add(&t.0, Filter::names(["want.json"]));
    fs::write(t.0.join("other.json"), "x").unwrap();
    fs::write(t.0.join("want.json"), "x").unwrap();
    assert_eq!(paths(&drain(&w, ms(300))), vec![t.0.join("want.json")]);
});

both!(an_editors_atomic_rename_save_is_one_modify_of_the_target, |b| {
    let t = Tmp::new("rename");
    let target = t.0.join("plan.json");
    fs::write(&target, "old").unwrap();
    let w = Watcher::start(bk(b, 20));
    w.add(&t.0, Filter::names(["plan.json"]));
    settle(&w);
    // write a temp file, then rename it onto the target (same size on purpose: only the inode tells)
    let tmp = t.0.join(".plan.json.swp");
    fs::write(&tmp, "new").unwrap();
    fs::rename(&tmp, &target).unwrap();
    assert_eq!(paths(&drain(&w, ms(300))), vec![target.clone()]);
    // the vim way: move the original aside, write a fresh file under the name, delete the backup
    fs::rename(&target, t.0.join("plan.json~")).unwrap();
    fs::write(&target, "again").unwrap();
    fs::remove_file(t.0.join("plan.json~")).unwrap();
    assert_eq!(paths(&drain(&w, ms(300))), vec![target]);
});

both!(a_rename_save_is_seen_even_when_the_directory_is_watched_whole, |b| {
    let t = Tmp::new("rename-all");
    let target = t.0.join("a.txt");
    fs::write(&target, "old").unwrap();
    let w = Watcher::start(bk(b, 20));
    w.add(&t.0, Filter::All);
    settle(&w);
    fs::write(t.0.join("a.tmp"), "new").unwrap();
    fs::rename(t.0.join("a.tmp"), &target).unwrap();
    let got = paths(&drain(&w, ms(300)));
    assert!(got.contains(&target), "{got:?}");
});

both!(a_sqlite_wal_commit_and_checkpoint_are_both_seen, |b| {
    let t = Tmp::new("wal");
    let c = bk(b, 20);
    let (db, wal) = (t.0.join("app.db"), t.0.join("app.db-wal"));
    fs::write(&db, vec![0u8; 4096]).unwrap();
    fs::write(&wal, vec![0u8; 8192]).unwrap();
    let w = Watcher::start(c.clone());
    w.add(&t.0, c.sqlite_filter("app.db"));
    settle(&w);
    fs::write(t.0.join("unrelated.log"), "x").unwrap();
    let mut f = fs::OpenOptions::new().append(true).open(&wal).unwrap();
    f.write_all(&[1u8; 4096]).unwrap(); // a commit: only the -wal grows
    drop(f);
    assert_eq!(paths(&drain(&w, ms(300))), vec![wal.clone()], "commit");
    fs::OpenOptions::new().write(true).truncate(true).open(&wal).unwrap(); // a checkpoint truncates the log
    assert_eq!(paths(&drain(&w, ms(300))), vec![wal.clone()], "truncate");
    fs::remove_file(&wal).unwrap(); // the last connection closed: the log is deleted
    assert_eq!(paths(&drain(&w, ms(300))), vec![wal], "delete");
});

both!(a_ten_thousand_write_storm_produces_a_bounded_output, |b| {
    let t = Tmp::new("storm");
    let w = Watcher::start(bk(b, 10));
    w.add(&t.0, Filter::All);
    let files: Vec<PathBuf> = (0..3).map(|i| t.0.join(format!("f{i}.log"))).collect();
    // The files stay open: an open and a close per write would triple the kernel's event count and overflow its queue on a slow
    // machine, which is reported (correctly) as a rescan and is not what this test measures.
    let mut handles: Vec<fs::File> = files.iter().map(|p| fs::OpenOptions::new().create(true).append(true).open(p).unwrap()).collect();
    let started = Instant::now();
    for i in 0..10_000 {
        handles[i % 3].write_all(b"line\n").unwrap();
    }
    let writing = started.elapsed();
    drop(handles);
    let batches = drain(&w, ms(400));
    let total: usize = batches.iter().map(|b| b.paths.len()).sum();
    assert!(batches.iter().all(|b| !b.rescan), "3 files never overflow a cap of 64");
    assert_eq!(paths(&batches), files);
    // upper bound: every file at most once per max_delay window while the storm lasted, plus the final report
    let windows = (writing.as_millis() / w.config().max_delay.as_millis()) as usize + 2;
    assert!(total <= 3 * windows, "{total} reports for 10000 writes over {writing:?}");
    assert!(total < 100, "output is a tiny fraction of the 10000 writes: {total}");
});

both!(a_flood_of_distinct_files_overflows_into_one_rescan, |b| {
    let t = Tmp::new("flood");
    let w = Watcher::start(bk(b, 10)); // queue_cap 64, max_entries 256
    w.add(&t.0, Filter::All);
    for i in 0..2000 {
        fs::write(t.0.join(format!("n{i}")), "x").unwrap();
    }
    let batches = drain(&w, ms(500));
    assert!(batches.iter().any(|b| b.rescan), "{batches:?}");
    let listed: usize = batches.iter().map(|b| b.paths.len()).sum();
    assert!(listed <= 64 * batches.len(), "no batch carries more than the cap");
    assert!(batches.len() <= 40, "bounded signals: {}", batches.len());
});

#[test]
fn a_directory_past_the_entry_cap_asks_for_a_rescan_when_its_listing_changes() {
    let t = Tmp::new("big");
    for i in 0..20 {
        fs::write(t.0.join(format!("e{i}")), "x").unwrap();
    }
    let mut c = bk("poll", 10);
    c.max_entries = 8;
    let w = Watcher::start(c);
    w.add(&t.0, Filter::All);
    assert!(w.next(ms(150)).is_none(), "an unchanged oversized directory is quiet");
    fs::write(t.0.join("late"), "x").unwrap();
    let batches = drain(&w, ms(300));
    assert!(batches.iter().any(|b| b.rescan), "{batches:?}");
}

both!(a_requested_rescan_is_delivered_once, |b| {
    let w = Watcher::start(bk(b, 20));
    w.request_rescan();
    assert_eq!(w.next(ms(500)), Some(Batch { rescan: true, paths: vec![] }));
    assert_eq!(w.next(ms(150)), None);
});

#[test]
fn a_directory_that_does_not_exist_yet_is_polled_and_picked_up_when_it_appears() {
    let t = Tmp::new("late-dir");
    let dir = t.0.join("later");
    let w = Watcher::start(bk("auto", 20));
    let d = w.add(&dir, Filter::names(["x.json"]));
    assert_eq!(d.backend, Backend::Poll);
    assert!(matches!(d.reason, Reason::EventsFailed(_)), "{:?}", d.reason);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("x.json"), "1").unwrap();
    assert_eq!(paths(&drain(&w, ms(300))), vec![dir.join("x.json")]);
}

both!(dropping_the_watcher_stops_its_thread_promptly, |b| {
    let t0 = Instant::now();
    let mut c = bk(b, 5000);
    c.poll = ms(5000);
    drop(Watcher::start(c));
    assert!(t0.elapsed() < ms(2000), "drop returned after {:?}", t0.elapsed());
});

// ---- backend choice ------------------------------------------------------------------------------------------------

#[test]
fn forced_poll_wins_and_network_and_wsl_filesystems_are_named() {
    let d = Path::new("/x");
    let mut c = cfg(100);
    for (ty, want) in [
        ("9p", Reason::FsType("9p".into())),
        ("drvfs", Reason::FsType("drvfs".into())),
        ("nfs", Reason::FsType("nfs".into())),
        ("smbfs", Reason::FsType("smbfs".into())),
        ("fuseblk", Reason::FsType("fuseblk".into())),
    ] {
        let got = decide_with(&c, d, Some(ty.into()));
        assert_eq!((got.backend, got.reason), (Backend::Poll, want), "{ty}");
    }
    for ty in ["apfs", "ext4", "xfs", "btrfs", "tmpfs", "overlay", "hfs"] {
        let got = decide_with(&c, d, Some(ty.into()));
        assert_eq!((got.backend, got.reason), (Backend::Events, Reason::LocalFs), "{ty}");
    }
    assert_eq!(decide_with(&c, d, None).backend, Backend::Events, "an unknown type is trusted; a refused watch falls back to polling");
    c.backend = "poll".into();
    let got = decide_with(&c, d, Some("apfs".into()));
    assert_eq!((got.backend, got.reason), (Backend::Poll, Reason::Forced));
    c.backend = "nonsense".into();
    assert_eq!(decide_with(&c, d, Some("apfs".into())).backend, Backend::Events, "an unknown word is auto");
}

#[test]
fn the_shipped_settings_load_and_agree_with_each_other() {
    defaults::init().expect("defaults load in a test");
    let c = Config::load();
    assert!(matches!(c.backend.as_str(), "auto" | "poll"));
    assert!(c.poll >= ms(20) && c.debounce <= c.max_delay);
    assert!(c.poll + c.debounce <= c.latency_target, "worst-case detection (poll + debounce) must fit the latency target");
    for ty in ["9p", "drvfs", "nfs", "nfs4", "smbfs", "cifs", "fuseblk", "macfuse"] {
        assert!(fstype::matches_any(ty, &c.fs_poll_types.iter().map(String::as_str).collect::<Vec<_>>()), "{ty}");
    }
    assert_eq!(c.sqlite_suffixes, ["-wal", "-shm", "-journal"]);
}

#[test]
fn auto_uses_os_events_on_a_local_directory_and_forced_poll_does_not() {
    let t = Tmp::new("which");
    let w = Watcher::start(bk("auto", 20));
    let d = w.add(&t.0, Filter::All);
    assert_eq!((d.backend, d.reason), (Backend::Events, Reason::LocalFs), "fs type {:?}", d.fstype);
    let p = Watcher::start(bk("poll", 20));
    assert_eq!(p.add(&t.0, Filter::All).backend, Backend::Poll);
}

#[test]
fn reading_a_watched_file_does_not_wake_the_watcher() {
    // inotify reports opens and reads; a consumer that re-reads its source on every report would otherwise loop forever
    let t = Tmp::new("reads");
    let f = t.0.join("db.json");
    fs::write(&f, "{}").unwrap();
    let w = Watcher::start(bk("auto", 20));
    w.add(&t.0, Filter::names(["db.json"]));
    settle(&w);
    for _ in 0..50 {
        fs::read(&f).unwrap();
    }
    assert!(w.next(ms(400)).is_none());
}

#[test]
fn a_removed_directory_is_no_longer_reported() {
    let t = Tmp::new("remove");
    let w = Watcher::start(bk("auto", 20));
    w.add(&t.0, Filter::All);
    w.remove(&t.0);
    fs::write(t.0.join("a"), "x").unwrap();
    assert!(w.next(ms(300)).is_none());
}
