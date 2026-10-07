//! The write spool (D24): nothing a client writes is lost while the engine is down or busy.
//!
//! Client side ([`write()`]): a project write gets a write id, then is sent to the daemon, retried with exponential
//! backoff and jitter while the daemon is absent (the client starts it), busy or failing transiently. If it still has
//! no answer, the write is appended to the spool file in the state directory: framed, checksummed, under an exclusive
//! lock, and fsync'd before the client reports it as spooled. The spool is capped; a full spool refuses the write.
//!
//! Daemon side ([`drain()`]): on start, every `spool.drain_ms` and before every direct project write, the daemon applies
//! the spooled records in file order (so each session's writes keep their order), each with its write id, so a record
//! applied twice (a crash between applying and truncating) changes nothing. A record that cannot be parsed, or that
//! the store refuses for good (a cap), goes to the quarantine file with its reason; nothing is ever dropped. A
//! transient failure stops the drain and keeps the rest for the next one.
//!
//! Record format: `AHS1 <body-len> <crc32-hex>\n<JSON body>\n`, where the body is
//! `{"id", "session", "cwd", "verb", "args", "ts_ms"}`.
use crate::client::{self, Exch};
use crate::defaults;
use crate::frame::{Kind, crc32};
use serde_json::{Value, json};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Wire magic of a spool record (part of the file format, like the reply frame magic).
const MAGIC: &str = "AHS1";

/// One spooled write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    /// The write id (idempotency key).
    pub id: String,
    /// The session that wrote it (order is kept per session).
    pub session: String,
    /// The cwd the write was made from; the daemon derives the project from it.
    pub cwd: String,
    /// The verb (`put`, `set`, `setex`).
    pub verb: String,
    /// The verb's arguments.
    pub args: String,
    /// When the client spooled it.
    pub ts_ms: u64,
}

impl Record {
    fn to_json(&self) -> String {
        json!({"id": self.id, "session": self.session, "cwd": self.cwd, "verb": self.verb, "args": self.args, "ts_ms": self.ts_ms}).to_string()
    }

    fn from_json(v: &Value) -> Option<Record> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(String::from);
        Some(Record { id: s("id")?, session: s("session")?, cwd: s("cwd")?, verb: s("verb")?, args: s("args")?, ts_ms: v.get("ts_ms")?.as_u64()? })
    }

    /// The framed bytes written to the spool.
    pub fn encode(&self) -> Vec<u8> {
        let body = self.to_json();
        let mut out = format!("{MAGIC} {} {:08x}\n", body.len(), crc32(body.as_bytes())).into_bytes();
        out.extend_from_slice(body.as_bytes());
        out.push(b'\n');
        out
    }
}

/// The spool file.
pub fn path() -> PathBuf {
    crate::paths::dir().join(defaults::text("files.spool"))
}

/// The quarantine file, next to the spool.
pub fn quarantine_path(spool: &Path) -> PathBuf {
    spool.with_file_name(defaults::text("files.spool_quarantine"))
}

/// Verbs a client may spool: writes whose answer the client does not need (a `take` must be answered).
pub fn spoolable(verb: &str) -> bool {
    defaults::list("spool.verbs").contains(&verb)
}

/// A new write id: unique per process and call, sortable by time.
pub fn new_write_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{nanos:x}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst))
}

/// Open (creating, mode 0600) and exclusively lock a spool-side file.
fn open_locked(p: &Path) -> std::io::Result<File> {
    let f = OpenOptions::new().read(true).append(true).create(true).mode(0o600).open(p)?;
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(f)
}

/// Why a record could not be spooled.
#[derive(Debug, PartialEq, Eq)]
pub enum SpoolError {
    /// The spool already holds `spool.max_bytes`.
    Full,
    /// The file could not be written (the OS error text).
    Io(String),
}

/// Append `rec` to the spool at `p` and fsync it; returns only once the record is on disk.
pub fn append(p: &Path, rec: &Record) -> Result<(), SpoolError> {
    let io = |e: std::io::Error| SpoolError::Io(e.to_string());
    if let Some(d) = p.parent() {
        crate::limits::ensure_private_dir(d).map_err(|e| SpoolError::Io(e.to_string()))?;
    }
    let mut f = open_locked(p).map_err(io)?;
    let bytes = rec.encode();
    let len = f.metadata().map_err(io)?.len();
    if len + bytes.len() as u64 > defaults::num("spool.max_bytes") {
        return Err(SpoolError::Full);
    }
    f.write_all(&bytes).map_err(io)?;
    f.sync_all().map_err(io)
}

/// What applying one record came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    /// Applied (or already applied under its write id).
    Done,
    /// Refused for good (the reason); the record goes to quarantine.
    Refused(String),
    /// Not now (storage busy or failing); stop and keep this record and the rest.
    Later,
}

/// What a drain did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Drained {
    /// Records applied.
    pub applied: usize,
    /// Records moved to quarantine (unparseable or refused).
    pub quarantined: usize,
    /// Records left for a later drain.
    pub left: usize,
}

/// Parse one record at the start of `b`: `Ok((record, bytes used))`, or `Err(bytes to skip)` for damage.
fn parse(b: &[u8]) -> Result<(Record, usize), usize> {
    let skip = || b.iter().skip(1).position(|&c| c == b'\n').map(|i| i + 2).unwrap_or(b.len()).max(1);
    let Some(nl) = b.iter().position(|&c| c == b'\n') else { return Err(b.len()) };
    let head = String::from_utf8_lossy(&b[..nl]);
    let parts: Vec<&str> = head.split(' ').collect();
    let (Some(&MAGIC), Some(len), Some(crc)) = (parts.first(), parts.get(1).and_then(|l| l.parse::<usize>().ok()), parts.get(2)) else {
        return Err(skip());
    };
    let end = nl + 1 + len;
    if b.len() < end + 1 || b[end] != b'\n' {
        return Err(skip());
    }
    let body = &b[nl + 1..end];
    if format!("{:08x}", crc32(body)) != *crc {
        return Err(end + 1);
    }
    let rec = serde_json::from_slice::<Value>(body).ok().and_then(|v| Record::from_json(&v)).ok_or(end + 1)?;
    Ok((rec, end + 1))
}

fn quarantine(spool: &Path, bytes: &[u8], why: &str) {
    let written = open_locked(&quarantine_path(spool)).and_then(|mut q| {
        q.write_all(format!("# {} {why}\n", crate::health::now_ms()).as_bytes())?;
        q.write_all(bytes)?;
        if !bytes.ends_with(b"\n") {
            q.write_all(b"\n")?;
        }
        q.sync_all()
    });
    match written {
        Ok(()) => crate::health::log_event("spool", "quarantine", why),
        // the record could not be kept anywhere: say so, with the reason it was being quarantined for
        Err(e) => crate::health::log_event("spool", "quarantine_write_failed", &format!("{why}: {e}")),
    }
}

/// Apply the spool at `p` in order with `apply`, then keep only what was not applied. Safe to run concurrently with
/// clients appending (both hold the file lock) and to repeat after a crash (records carry write ids).
pub fn drain(p: &Path, apply: &mut dyn FnMut(&Record) -> Applied) -> Drained {
    let mut out = Drained::default();
    if std::fs::metadata(p).map(|m| m.len() == 0).unwrap_or(true) {
        return out;
    }
    let Ok(mut f) = open_locked(p) else { return out };
    let mut b = Vec::new();
    if f.seek(SeekFrom::Start(0)).and_then(|_| f.read_to_end(&mut b)).is_err() {
        return out;
    }
    let mut at = 0;
    while at < b.len() {
        match parse(&b[at..]) {
            Ok((rec, used)) => match apply(&rec) {
                Applied::Done => {
                    out.applied += 1;
                    at += used;
                }
                Applied::Refused(why) => {
                    quarantine(p, &b[at..at + used], &why);
                    out.quarantined += 1;
                    at += used;
                }
                Applied::Later => break,
            },
            Err(skip) => {
                quarantine(p, &b[at..at + skip], defaults::text("msg.spool_damaged"));
                out.quarantined += 1;
                at += skip;
            }
        }
    }
    let rest = &b[at..];
    let mut r = rest;
    while !r.is_empty() {
        let n = match parse(r) {
            Ok((_, n)) => {
                out.left += 1;
                n
            }
            Err(n) => n,
        };
        r = &r[n..];
    }
    // Rewrite with only the unapplied tail (the file is still locked, so no client appends in between). The file is opened for
    // appending, so the cut has to come first; a failure after it loses the unapplied records, which is logged with their count
    // rather than passing in silence.
    let rewritten = f.set_len(0).and_then(|_| f.write_all(rest)).and_then(|_| f.sync_all());
    if let Err(e) = rewritten {
        crate::health::log_event("spool", "rewrite_failed", &format!("{e}; {} unapplied record(s) may be lost", out.left));
    }
    out
}

/// What a client write came to, for the command line.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The daemon answered (the value).
    Answered(String),
    /// The daemon refused it (the reason).
    Refused(String),
    /// The daemon could not be reached in time; the write is in the spool (its id).
    Spooled(String),
    /// Neither the daemon nor the spool took it (why).
    Failed(String),
}

/// Backoff before retry `n` (0-based): exponential from `spool.backoff_ms`, capped at `spool.backoff_max_ms`, with
/// jitter of up to half the delay so concurrent clients do not retry in step.
fn backoff(n: u32) -> Duration {
    let base = defaults::num("spool.backoff_ms").saturating_mul(1u64 << n.min(16));
    let capped = base.min(defaults::num("spool.backoff_max_ms"));
    let jitter = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos() as u64).unwrap_or(0) % (capped / 2 + 1);
    Duration::from_millis(capped / 2 + jitter)
}

/// A project operation from the command line. A spoolable write is retried and then spooled (D24); any other verb
/// is tried the same way but fails when the daemon cannot answer.
pub fn write(cwd: &str, verb: &str, args: &str, session: &str) -> Outcome {
    let id = new_write_id();
    let req = format!("P {cwd}\nW {id}\n{verb} {args}");
    let sock = crate::paths::socket();
    let deadline = defaults::millis("client.ctl_timeout_ms");
    let retries = defaults::num("spool.retries") as u32;
    let mut spawned = false;
    for n in 0..=retries {
        match client::exchange(&sock, req.as_bytes(), deadline) {
            Exch::Reply(Kind::Ok, body) => return Outcome::Answered(body),
            Exch::Reply(Kind::Err, why) => return Outcome::Refused(why),
            Exch::Absent if !spawned => spawned = client::spawn_daemon().is_some(),
            _ => {}
        }
        if n < retries {
            std::thread::sleep(backoff(n));
        }
    }
    if !spoolable(verb) {
        return Outcome::Failed(defaults::text("msg.cli_no_daemon").to_string());
    }
    let rec = Record {
        id: id.clone(),
        session: session.to_string(),
        cwd: cwd.to_string(),
        verb: verb.to_string(),
        args: args.to_string(),
        ts_ms: crate::health::now_ms(),
    };
    match append(&path(), &rec) {
        Ok(()) => Outcome::Spooled(id),
        Err(SpoolError::Full) => Outcome::Failed(defaults::text("msg.spool_full").to_string()),
        Err(SpoolError::Io(e)) => Outcome::Failed(defaults::render("msg.spool_io", &[("err", &e)])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::TempDir;

    fn rec(i: usize, session: &str) -> Record {
        Record { id: format!("w{i}"), session: session.into(), cwd: "/p".into(), verb: "put".into(), args: format!("m{i}"), ts_ms: 1 }
    }

    #[test]
    fn records_round_trip_and_damage_is_quarantined_not_dropped() {
        let d = TempDir::new("spool");
        let p = d.0.join("spool.log");
        append(&p, &rec(0, "a")).unwrap();
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"garbage line\nAHS1 5 00000000\nhello\n").unwrap();
        append(&p, &rec(1, "a")).unwrap();
        let mut seen = vec![];
        let r = drain(&p, &mut |r| {
            seen.push(r.args.clone());
            Applied::Done
        });
        assert_eq!(seen, vec!["m0", "m1"], "valid records are applied in order around the damage");
        assert_eq!(r.applied, 2);
        assert!(r.quarantined >= 1);
        assert_eq!(std::fs::metadata(&p).unwrap().len(), 0, "a drained spool is empty");
        let q = std::fs::read_to_string(quarantine_path(&p)).unwrap();
        assert!(q.contains("garbage line") && q.contains("hello"), "damaged bytes are kept: {q}");
    }

    #[test]
    fn a_transient_failure_keeps_the_rest_in_order() {
        let d = TempDir::new("later");
        let p = d.0.join("spool.log");
        for i in 0..5 {
            append(&p, &rec(i, "s")).unwrap();
        }
        let mut n = 0;
        let r = drain(&p, &mut |_| {
            n += 1;
            if n <= 2 { Applied::Done } else { Applied::Later }
        });
        assert_eq!((r.applied, r.left), (2, 3));
        let mut rest = vec![];
        drain(&p, &mut |r| {
            rest.push(r.args.clone());
            Applied::Done
        });
        assert_eq!(rest, vec!["m2", "m3", "m4"]);
    }

    #[test]
    fn a_refused_record_is_quarantined_with_its_reason() {
        let d = TempDir::new("refused");
        let p = d.0.join("spool.log");
        append(&p, &rec(0, "s")).unwrap();
        let r = drain(&p, &mut |_| Applied::Refused("mailbox full".into()));
        assert_eq!(r.quarantined, 1);
        let q = std::fs::read_to_string(quarantine_path(&p)).unwrap();
        assert!(q.contains("mailbox full") && q.contains("\"m0\""));
    }

    #[test]
    fn write_ids_are_unique() {
        let a: std::collections::HashSet<String> = (0..1000).map(|_| new_write_id()).collect();
        assert_eq!(a.len(), 1000);
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        let max = defaults::num("spool.backoff_max_ms");
        for n in 0..20 {
            assert!(backoff(n).as_millis() as u64 <= max);
        }
        assert!(backoff(0).as_millis() as u64 <= defaults::num("spool.backoff_ms"));
    }
}
