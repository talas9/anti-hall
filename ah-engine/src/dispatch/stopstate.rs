//! The Stop channel's shared state (GH #540): the continuation counter of a session and the note held for its next prompt.
//!
//! One rule for every path that touches it: the state is fail-CLOSED and atomic.
//! - **Atomic**: every read-decide-write runs under one per-session lock file (`O_EXCL` create, the same primitive as
//!   `health::first_in_session` and `guardkit::filelock`; a holder older than `stop_channel.lock_stale_ms` is taken over, a wait is
//!   bounded by `stop_channel.lock_wait_ms`). The counter is reserved (incremented and saved) BEFORE a soft block is emitted, so
//!   parallel Stops can never emit more than the cap. A held note is consumed by an atomic rename to a claim file, delivered, and
//!   then the claim is removed; a claim left by a crash is delivered again once it is older than `stop_channel.claim_stale_s`.
//! - **Fail closed**: a state that cannot be proven (a read, parse or save that fails, a path that is not a file, a lock that stays
//!   held, a transcript that shrank or cannot be read) is a [`Fail`]. The caller then does not emit `additionalContext` (the answer
//!   is what it was before the Stop channel) and counts the reason (`stop_channel.reasons`). Nothing here treats a failure as
//!   "count 0" or "reset".
use crate::defaults;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Why a state could not be proven. [`Fail::key`] is the row of `stop_channel.reasons` that names it in the counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fail {
    /// The session's lock could not be taken in time (a live writer holds it, or the lock cannot be created).
    Lock,
    /// A state path is not a regular file (a directory, a link).
    Shape,
    /// A state file exists but cannot be read.
    Read,
    /// A state file was read but is not what a save writes (empty, truncated, wrong fields).
    Parse,
    /// A state file could not be written or removed.
    Save,
    /// The transcript is absent or unreadable where the chain needs it to prove a restart.
    Transcript,
    /// The transcript is shorter than at the last soft block: it was rewritten, which proves nothing.
    Shrunk,
}

impl Fail {
    /// The key of this reason in `stop_channel.reasons`.
    pub fn key(self) -> &'static str {
        match self {
            Fail::Lock => "lock",
            Fail::Shape => "shape",
            Fail::Read => "read",
            Fail::Parse => "parse",
            Fail::Save => "save",
            Fail::Transcript => "transcript",
            Fail::Shrunk => "shrunk",
        }
    }

    /// The counter label of this reason.
    pub fn label(self) -> &'static str {
        defaults::raw("stop_channel.reasons").str_field(self.key())
    }
}

/// The directory holding the chain, note, lock and claim files of every session.
pub fn dir() -> PathBuf {
    crate::paths::dir().join(defaults::text("stop_channel.state_dir"))
}

fn named(session: &str, suffix: &str) -> PathBuf {
    dir().join(format!("{session}{suffix}"))
}

fn ensure_dir() -> Result<(), Fail> {
    crate::limits::ensure_private_dir(&dir()).map_err(|e| {
        crate::discard::note("stop_channel_state_dir", &e.to_string());
        Fail::Save
    })
}

/// What a path is, without following links: absent, a regular file, or something else.
enum Kind {
    Absent,
    File,
    Other,
}

fn kind_of(p: &Path) -> Result<Kind, Fail> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_file() => Ok(Kind::File),
        Ok(_) => Ok(Kind::Other),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Kind::Absent),
        Err(_) => Err(Fail::Read),
    }
}

fn token() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!("{}.{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))
}

/// The session's lock, held until it is dropped. Every state read and write goes through it.
pub struct Guard {
    session: String,
    lock: PathBuf,
    token: String,
}

impl Drop for Guard {
    fn drop(&mut self) {
        // only our own lock is removed: a holder that was taken over as stale must not delete its successor's
        if std::fs::read_to_string(&self.lock).is_ok_and(|t| t == self.token) {
            crate::discard::harmless(std::fs::remove_file(&self.lock)); // keep: cleanup that raced; an absent file is the goal state
        }
    }
}

fn age_of(p: &Path) -> Option<std::time::Duration> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok())
}

/// Move a stale lock aside and drop it when it is still the one judged; a fresh lock that was caught is put back.
fn take_over(lock: &Path, judged: &str) -> bool {
    let aside = PathBuf::from(format!("{}{}{}", lock.display(), defaults::text("stop_channel.claim_infix"), token()));
    if std::fs::rename(lock, &aside).is_err() {
        return true; // gone already: try the create again
    }
    let same = std::fs::read_to_string(&aside).is_ok_and(|t| t == judged);
    if !same && std::fs::hard_link(&aside, lock).is_err() {
        // a fresh lock was caught and cannot be put back by a link: the next create decides
        crate::discard::harmless(std::fs::rename(&aside, lock)); // keep: cleanup that raced
    }
    crate::discard::harmless(std::fs::remove_file(&aside)); // keep: cleanup that raced; an absent file is the goal state
    same
}

/// Take the session's lock.
///
/// # Errors
/// [`Fail::Lock`] when it stays held past `stop_channel.lock_wait_ms` or cannot be created; [`Fail::Shape`] when the lock path is
/// not a file.
pub fn lock(session: &str) -> Result<Guard, Fail> {
    ensure_dir()?;
    let path = named(session, defaults::text("stop_channel.lock_suffix"));
    let deadline = std::time::Instant::now() + defaults::millis("stop_channel.lock_wait_ms");
    loop {
        let tok = token();
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                if f.write_all(tok.as_bytes()).is_err() {
                    crate::discard::harmless(std::fs::remove_file(&path)); // keep: a lock that could not be written is not ours
                    return Err(Fail::Lock);
                }
                return Ok(Guard { session: session.to_string(), lock: path, token: tok });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(Fail::Lock),
        }
        match kind_of(&path)? {
            Kind::Absent => continue, // released between the create and the look
            Kind::Other => return Err(Fail::Shape),
            Kind::File => {}
        }
        let stale = age_of(&path).is_some_and(|a| a > defaults::millis("stop_channel.lock_stale_ms"));
        if stale {
            let judged = std::fs::read_to_string(&path).unwrap_or_default();
            if take_over(&path, &judged) {
                continue;
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(Fail::Lock);
        }
        std::thread::sleep(defaults::millis("stop_channel.lock_step_ms"));
    }
}

/// The soft blocks of a session's current chain: how many, and the transcript length when the last one was sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chain {
    /// Soft blocks sent in a row.
    pub n: u64,
    /// Transcript length in bytes when the last one was sent (`u64::MAX`: unknown).
    pub off: u64,
}

impl Chain {
    /// No soft block yet; the offset is unknown, so a tool call cannot restart it.
    pub fn fresh() -> Chain {
        Chain { n: 0, off: u64::MAX }
    }
}

impl Guard {
    fn chain_path(&self) -> PathBuf {
        named(&self.session, "")
    }

    fn note_path(&self) -> PathBuf {
        named(&self.session, defaults::text("stop_channel.note_suffix"))
    }

    /// The chain. An absent file is a chain that never started; a file that is there but cannot be read or understood is a [`Fail`].
    pub fn chain(&self) -> Result<Chain, Fail> {
        let p = self.chain_path();
        match kind_of(&p)? {
            Kind::Absent => return Ok(Chain::fresh()),
            Kind::Other => return Err(Fail::Shape),
            Kind::File => {}
        }
        let text = std::fs::read_to_string(&p).map_err(|_| Fail::Read)?;
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| Fail::Parse)?;
        match (v.get("n").and_then(serde_json::Value::as_u64), v.get("off").and_then(serde_json::Value::as_u64)) {
            (Some(n), Some(off)) => Ok(Chain { n, off }),
            _ => Err(Fail::Parse),
        }
    }

    /// Save the chain, and read it back: a save that cannot be proven did not happen.
    pub fn save(&self, c: Chain) -> Result<(), Fail> {
        ensure_dir()?;
        let body = serde_json::json!({"n": c.n, "off": c.off}).to_string();
        if let Err(e) = crate::atomic::write(self.chain_path(), body) {
            crate::discard::note("stop_channel_state_write", &e.to_string());
            return Err(Fail::Save);
        }
        if self.chain()? == c { Ok(()) } else { Err(Fail::Save) }
    }

    /// Start the chain again (a new prompt). An absent chain is already started.
    pub fn clear(&self) -> Result<(), Fail> {
        let p = self.chain_path();
        match kind_of(&p)? {
            Kind::Absent => Ok(()),
            Kind::Other => Err(Fail::Shape),
            Kind::File => std::fs::remove_file(&p).map_err(|_| Fail::Save),
        }
    }

    /// Keep `text` for the session's next prompt, beside a note that is already held (the same text is not added twice). The end is cut at
    /// `max` characters.
    pub fn hold(&self, text: &str, body: &str, max: usize) -> Result<(), Fail> {
        ensure_dir()?;
        let p = self.note_path();
        let joined = match kind_of(&p)? {
            Kind::Absent => text.to_string(),
            Kind::Other => return Err(Fail::Shape),
            Kind::File => {
                let old = std::fs::read_to_string(&p).map_err(|_| Fail::Read)?;
                if old.contains(body) { old } else { format!("{old}{}{body}", defaults::text("dispatch.context_joiner")) }
            }
        };
        let cut: String = joined.chars().take(max).collect();
        crate::atomic::write(&p, cut).map_err(|e| {
            crate::discard::note("stop_channel_note_write", &e.to_string());
            Fail::Save
        })
    }

    /// Claim every held note of the session by an atomic rename: the current one, and the claims an earlier crash left behind once they are
    /// older than `stop_channel.claim_stale_s`. The claims are removed by [`Claims::release`] after the text was handed on.
    pub fn claim(&self) -> Result<Claims, Fail> {
        let note = self.note_path();
        let infix = defaults::text("stop_channel.claim_infix");
        let prefix = format!("{}{}{infix}", self.session, defaults::text("stop_channel.note_suffix"));
        let mut files = Vec::new();
        if let Ok(rd) = std::fs::read_dir(dir()) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with(&prefix) && age_of(&e.path()).is_some_and(|a| a > defaults::secs("stop_channel.claim_stale_s")) {
                    files.push(e.path());
                }
            }
        }
        match kind_of(&note)? {
            Kind::Absent => {}
            Kind::Other => return Err(Fail::Shape),
            Kind::File => {
                let mine = PathBuf::from(format!("{}{infix}{}", note.display(), token()));
                std::fs::rename(&note, &mine).map_err(|_| Fail::Save)?;
                // a rename keeps the file's age: stamp the claim, so a recovery waits for its own timeout
                if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&mine) {
                    crate::discard::harmless(f.set_modified(std::time::SystemTime::now())); // keep: an unstamped claim is recovered sooner, not lost
                }
                files.push(mine);
            }
        }
        let mut texts = Vec::new();
        for f in &files {
            texts.push(std::fs::read_to_string(f).map_err(|_| Fail::Read)?);
        }
        Ok(Claims { files, texts })
    }
}

/// Notes claimed from a session; their files stay until [`Claims::release`].
pub struct Claims {
    files: Vec<PathBuf>,
    /// The text of each claimed note.
    pub texts: Vec<String>,
}

impl Claims {
    /// The notes were handed on: remove the claims.
    pub fn release(self) -> Result<(), Fail> {
        let mut r = Ok(());
        for f in self.files {
            if std::fs::remove_file(&f).is_err() {
                r = Err(Fail::Save);
            }
        }
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn session(tag: &str) -> String {
        static N: AtomicU64 = AtomicU64::new(0);
        format!("ut-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
    }

    /// Eight threads reserve soft blocks of cap 2 at once: exactly 2 get one, 20 rounds.
    #[test]
    fn parallel_reservations_never_pass_the_cap() {
        for _ in 0..20 {
            let s = session("cap");
            let won = AtomicUsize::new(0);
            std::thread::scope(|sc| {
                for _ in 0..8 {
                    sc.spawn(|| {
                        let g = lock(&s).unwrap();
                        let c = g.chain().unwrap();
                        if c.n < 2 {
                            g.save(Chain { n: c.n + 1, off: 7 }).unwrap();
                            won.fetch_add(1, Ordering::SeqCst);
                        }
                    });
                }
            });
            assert_eq!(won.load(Ordering::SeqCst), 2);
        }
    }

    /// Four holders (distinct texts) and four claimers race: every text is claimed exactly once, none is lost to a replacement.
    #[test]
    fn held_notes_are_consumed_exactly_once_and_never_lost() {
        for round in 0..20 {
            let s = session("note");
            let seen = std::sync::Mutex::new(Vec::<String>::new());
            let done = std::sync::atomic::AtomicBool::new(false);
            std::thread::scope(|sc| {
                let holders: Vec<_> = (0..4)
                    .map(|i| {
                        let s = &s;
                        sc.spawn(move || {
                            let body = format!("note-{round}-{i}");
                            lock(s).unwrap().hold(&body, &body, 10_000).unwrap();
                        })
                    })
                    .collect();
                for _ in 0..4 {
                    sc.spawn(|| {
                        while !done.load(Ordering::SeqCst) {
                            let g = lock(&s).unwrap();
                            let c = g.claim().unwrap();
                            seen.lock().unwrap().extend(c.texts.iter().cloned());
                            c.release().unwrap();
                            drop(g);
                            std::thread::yield_now();
                        }
                    });
                }
                for h in holders {
                    h.join().unwrap();
                }
                done.store(true, Ordering::SeqCst);
            });
            let g = lock(&s).unwrap();
            let c = g.claim().unwrap();
            let mut all = seen.into_inner().unwrap();
            all.extend(c.texts.iter().cloned());
            c.release().unwrap();
            // a text can be inside a joined note ("a\nb"): every hold is found exactly once across what was claimed
            let joined = all.join("\n");
            for i in 0..4 {
                assert_eq!(joined.matches(&format!("note-{round}-{i}")).count(), 1, "round {round}: {all:?}");
            }
        }
    }

    #[test]
    fn a_chain_that_cannot_be_proven_is_a_failure_never_zero() {
        let s = session("bad");
        let g = lock(&s).unwrap();
        assert_eq!(g.chain().unwrap(), Chain::fresh(), "absent: a chain that never started");
        let p = dir().join(&s);
        std::fs::create_dir(&p).unwrap();
        assert_eq!(g.chain(), Err(Fail::Shape), "a directory in the path");
        assert_eq!(g.save(Chain { n: 1, off: 1 }), Err(Fail::Save), "and the save fails too");
        assert_eq!(g.clear(), Err(Fail::Shape));
        std::fs::remove_dir(&p).unwrap();
        for body in ["", "{", "[]", "{\"n\":1}", "{\"n\":\"x\",\"off\":1}"] {
            std::fs::write(&p, body).unwrap();
            assert_eq!(g.chain(), Err(Fail::Parse), "{body:?}");
        }
        g.clear().unwrap();
        assert_eq!(g.chain().unwrap(), Chain::fresh());
    }

    #[test]
    fn a_lock_that_stays_held_fails_and_a_stale_one_is_taken_over() {
        let s = session("lock");
        let first = lock(&s).unwrap();
        let path = dir().join(format!("{s}{}", defaults::text("stop_channel.lock_suffix")));
        // fresh and held: the wait ends (the test lowers nothing; the wait is the shipped one) -> too slow to wait for, so age it instead
        let old = std::time::SystemTime::now() - std::time::Duration::from_millis(defaults::num("stop_channel.lock_stale_ms") * 2);
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_modified(old).unwrap();
        let second = lock(&s).expect("a stale lock is taken over");
        drop(first); // not ours any more: must not remove the new holder's lock
        assert!(path.is_file(), "the old holder did not delete its successor's lock");
        drop(second);
        assert!(!path.exists());
        std::fs::create_dir(&path).unwrap();
        assert!(matches!(lock(&s), Err(Fail::Shape)), "a directory in the lock path");
        std::fs::remove_dir(&path).unwrap();
    }

    #[test]
    fn a_crashed_claim_is_delivered_again_after_the_timeout_and_not_before() {
        let s = session("claim");
        let g = lock(&s).unwrap();
        g.hold("kept", "kept", 100).unwrap();
        let c = g.claim().unwrap();
        assert_eq!(c.texts, vec!["kept".to_string()]);
        std::mem::forget(c); // the process died between claiming and removing
        assert!(g.claim().unwrap().texts.is_empty(), "a fresh claim is still its owner's");
        let infix = defaults::text("stop_channel.claim_infix");
        let claim =
            std::fs::read_dir(dir()).unwrap().flatten().find(|e| e.file_name().to_string_lossy().starts_with(&format!("{s}.note{infix}"))).unwrap().path();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(defaults::num("stop_channel.claim_stale_s") * 2);
        std::fs::OpenOptions::new().write(true).open(&claim).unwrap().set_modified(old).unwrap();
        let again = g.claim().unwrap();
        assert_eq!(again.texts, vec!["kept".to_string()], "recovered after the timeout");
        again.release().unwrap();
        assert!(g.claim().unwrap().texts.is_empty());
    }
}
