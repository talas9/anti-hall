//! The action ledger: what makes every action idempotent. Append-only NDJSON in the engine state directory, written under an
//! exclusive `flock` so two engine processes cannot both claim one key.
//!
//! Per key the file holds one `started` line before a process is spawned and one finishing line after it. A key that
//! finished `done`, or that started and never finished (the engine died mid-action: the effect is in doubt), is never run
//! again. A key that failed may be tried again up to `devswarm_act.max_attempts` times, `devswarm_act.retry_backoff_ms`
//! apart. The file is never rewritten or pruned by the engine.
use crate::defaults;
use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

/// The outcome words, by position in `devswarm_act.words`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Word {
    /// The Started.
    Started = 0,
    /// The Done.
    Done = 1,
    /// The Failed.
    Failed = 2,
    /// The Timeout.
    Timeout = 3,
    /// The Skipped.
    Skipped = 4,
    /// The Unavailable.
    Unavailable = 5,
    /// The Deferred.
    Deferred = 6,
    /// The InDoubt.
    InDoubt = 7,
    /// The Inert.
    Inert = 8,
    /// The Refused.
    Refused = 9,
    /// The Stale.
    Stale = 10,
    /// The Planned.
    Planned = 11,
}

impl Word {
    /// The configured word.
    pub fn text(self) -> &'static str {
        defaults::list("devswarm_act.words").get(self as usize).copied().unwrap_or_default()
    }
}

/// Where a key stands.
#[derive(Debug, Clone, PartialEq)]
pub enum KeyState {
    /// Never started.
    Fresh,
    /// Finished `done`.
    Done,
    /// Started and never finished.
    InDoubt,
    /// Failed `attempts` times, the last one at `last_ms`.
    Failed {
        /** The attempts. */
        attempts: u64,
        /** The last ms. */
        last_ms: i64,
    },
}

/// The ledger file.
pub struct Ledger {
    path: PathBuf,
}

/// The answer of [`Ledger::begin`].
#[derive(Debug, PartialEq)]
pub enum Begin {
    /// The key is claimed (attempt number `n`); run the action.
    Claimed(u64),
    /// Not claimed: the key is done, in doubt, out of attempts or backing off.
    Refused(KeyState),
    /// The ledger cannot be written: nothing may run (an unrecorded action could run twice).
    Unwritable(String),
}

fn lines(path: &Path) -> Vec<Value> {
    let mut s = String::new();
    if let Ok(mut f) = std::fs::File::open(path) {
        crate::discard::harmless(f.read_to_string(&mut s).map(|_| ())); // keep: an unreadable ledger reads as empty and begin() then fails to write
    }
    s.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect()
}

fn state_of(rows: &[Value], key: &str) -> KeyState {
    let started = Word::Started.text();
    let done = Word::Done.text();
    let (mut starts, mut fails, mut last, mut finished_all, mut was_done) = (0u64, 0u64, 0i64, true, false);
    for r in rows.iter().filter(|r| r.get("key").and_then(Value::as_str) == Some(key)) {
        let w = r.get("outcome").and_then(Value::as_str).unwrap_or_default();
        let ts = r.get("ts").and_then(Value::as_i64).unwrap_or(0);
        if w == started {
            starts += 1;
            finished_all = false;
        } else {
            finished_all = true;
            if w == done {
                was_done = true;
            } else {
                fails += 1;
                last = ts;
            }
        }
    }
    if was_done {
        KeyState::Done
    } else if starts == 0 {
        KeyState::Fresh
    } else if !finished_all {
        KeyState::InDoubt
    } else {
        KeyState::Failed { attempts: fails, last_ms: last }
    }
}

impl Ledger {
    /// The ledger file of the state directory `dir`.
    pub fn open(dir: &Path) -> Ledger {
        Ledger { path: dir.join(defaults::text("devswarm_act.ledger_file")) }
    }

    /// Where a key stands now.
    pub fn state(&self, key: &str) -> KeyState {
        state_of(&lines(&self.path), key)
    }

    /// Every key beginning with `prefix` that is done or in doubt (these count as "already acted").
    pub fn acted_keys(&self, prefix: &str) -> Vec<String> {
        let rows = lines(&self.path);
        let mut keys: Vec<String> =
            rows.iter().filter_map(|r| r.get("key").and_then(Value::as_str)).filter(|k| k.starts_with(prefix)).map(str::to_string).collect();
        keys.sort();
        keys.dedup();
        keys.retain(|k| matches!(state_of(&rows, k), KeyState::Done | KeyState::InDoubt));
        keys
    }

    /// `(key, id, finish time)` of every key beginning with `prefix` that finished `done`.
    pub fn done_rows(&self, prefix: &str) -> Vec<(String, String, i64)> {
        let done = Word::Done.text();
        lines(&self.path)
            .iter()
            .filter(|r| r.get("outcome").and_then(Value::as_str) == Some(done))
            .filter_map(|r| {
                let k = r.get("key").and_then(Value::as_str).filter(|k| k.starts_with(prefix))?;
                Some((k.to_string(), r.get("id").and_then(Value::as_str)?.to_string(), r.get("ts").and_then(Value::as_i64).unwrap_or(0)))
            })
            .collect()
    }

    /// Claim `key` for one attempt: under the lock, re-read the file, refuse a key that is done, in doubt, out of attempts or
    /// backing off, else append its `started` line.
    pub fn begin(&self, key: &str, kind: &str, id: &str, now_ms: i64) -> Begin {
        if let Some(d) = self.path.parent() {
            crate::discard::harmless(std::fs::create_dir_all(d)); // keep: a failure to create is reported by the open below
        }
        let mut f = match OpenOptions::new().create(true).read(true).append(true).open(&self.path) {
            Ok(f) => f,
            Err(e) => return Begin::Unwritable(e.to_string()),
        };
        // SAFETY: flock on a descriptor this function owns for its whole life.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Begin::Unwritable(std::io::Error::last_os_error().to_string());
        }
        let rows = lines(&self.path);
        let st = state_of(&rows, key);
        let attempt = match &st {
            KeyState::Fresh => 1,
            KeyState::Failed { attempts, last_ms } => {
                let backoff = defaults::num("devswarm_act.retry_backoff_ms") as i64;
                if *attempts >= defaults::num("devswarm_act.max_attempts") || now_ms - last_ms < backoff {
                    return Begin::Refused(st);
                }
                attempts + 1
            }
            _ => return Begin::Refused(st),
        };
        let line = json!({"ts": now_ms, "key": key, "kind": kind, "id": id, "outcome": Word::Started.text(), "attempt": attempt});
        match writeln!(f, "{line}").and_then(|_| f.sync_data()) {
            Ok(()) => Begin::Claimed(attempt),
            Err(e) => Begin::Unwritable(e.to_string()),
        }
    }

    /// Record how an attempt ended. Best effort by necessity: if this write is lost the key stays `started`, which reads as
    /// in doubt, the safe side (it is never run twice).
    pub fn finish(&self, key: &str, kind: &str, id: &str, now_ms: i64, outcome: Word, error: Option<&str>) {
        let line = json!({"ts": now_ms, "key": key, "kind": kind, "id": id, "outcome": outcome.text(), "error": error});
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.path) {
            // SAFETY: as in begin().
            let locked = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } == 0;
            crate::discard::harmless(writeln!(f, "{line}").and_then(|_| f.sync_data())); // keep: see the doc comment
            let _ = locked; // the lock is released when `f` is dropped
        }
    }
}
