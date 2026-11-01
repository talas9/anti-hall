//! The Stop channel's shared state (GH #540): the continuation counter of a session and the note held for its next prompt.
//!
//! One rule for every path that touches it: the state is fail-CLOSED and atomic.
//! - **Atomic**: every read-decide-write runs under one per-session lock file (`O_EXCL` create, the same primitive as
//!   `health::first_in_session` and `guardkit::filelock`; a holder older than `stop_channel.lock_stale_ms` is taken over, a wait is
//!   bounded by `stop_channel.lock_wait_ms`). The lock file carries the holder's pid and a nonce, and [`Guard::verify`] proves it is
//!   still the holder's own before EVERY save and before an emit: a lock that was deleted, or taken over as stale while its holder was
//!   suspended, is a [`Fail::LockLost`] (the save does not happen). The counter is reserved (incremented and saved) BEFORE a soft block
//!   is emitted, so parallel Stops can never emit more than the cap. A held note is consumed by an atomic rename to a claim file; the
//!   claim is removed only after the answer carrying the note was written ([`Claims::release`]) and put back when it was not
//!   ([`Claims::restore`]); a claim left by a crash is delivered again once it is older than `stop_channel.claim_stale_s`.
//! - **Never cut**: a held note is kept whole or not at all. A note that does not fit `stop_channel.note_max_chars` is not held (the
//!   caller sends it now on its old channel); the same note held twice is held once.
//! - **Fail closed**: a state that cannot be proven (a read, parse or save that fails, a path that is not a file, a lock that stays
//!   held or is lost, a transcript that shrank or cannot be read, a tracker that cannot be read) is a [`Fail`]. The caller then does
//!   not emit `additionalContext` (the answer is what it was before the Stop channel) and counts the reason
//!   (`stop_channel.reasons`). Nothing here treats a failure as "count 0" or "reset".
use crate::defaults;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Why a state could not be proven. [`Fail::key`] is the row of `stop_channel.reasons` that names it in the counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fail {
    /// The session's lock could not be taken in time (a live writer holds it, or the lock cannot be created).
    Lock,
    /// The lock this call took is no longer its own (deleted, or taken over as stale): nothing is saved or emitted under it.
    LockLost,
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
    /// The background-work tracker's state exists but cannot be read: whether work is pending is unknown.
    Tracker,
    /// A note does not fit the hold (`stop_channel.note_max_chars`): it is sent now on its old channel, never cut.
    NoteTooLarge,
    /// A claimed note did not appear in the answer that was written: it is put back for the next prompt.
    Undelivered,
}

impl Fail {
    /// The key of this reason in `stop_channel.reasons`.
    pub fn key(self) -> &'static str {
        match self {
            Fail::Lock => "lock",
            Fail::LockLost => "lock_lost",
            Fail::Shape => "shape",
            Fail::Read => "read",
            Fail::Parse => "parse",
            Fail::Save => "save",
            Fail::Transcript => "transcript",
            Fail::Shrunk => "shrunk",
            Fail::Tracker => "tracker",
            Fail::NoteTooLarge => "note_too_large",
            Fail::Undelivered => "undelivered",
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

/// A tag no other holder, claim or process uses: the pid, the clock in nanoseconds and a per-process sequence. It is the lock file's
/// content (pid + nonce), so a lock is proven to be one's own by reading it back.
fn token() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("{}.{nanos:x}.{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))
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

/// The soft blocks of a session since its last prompt: the consecutive ones (what `stop_channel.num_cap` bounds; a tool call in the
/// transcript restarts them), the total (what `stop_channel.num_ceiling` bounds; nothing but a prompt restarts it), and the transcript
/// length when the last one was sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chain {
    /// Soft blocks sent in a row.
    pub n: u64,
    /// Soft blocks sent since the last prompt (never less than `n`).
    pub t: u64,
    /// Transcript length in bytes when the last one was sent (`u64::MAX`: unknown).
    pub off: u64,
}

impl Chain {
    /// No soft block yet; the offset is unknown, so a tool call cannot restart it.
    pub fn fresh() -> Chain {
        Chain { n: 0, t: 0, off: u64::MAX }
    }

    /// The consecutive count starts again (a tool call); the total since the prompt stays.
    pub fn restarted(self) -> Chain {
        Chain { n: 0, t: self.t, off: u64::MAX }
    }
}

/// One held note: the check it came from and its text, exactly as the check said it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    /// The check id (for the counters and the duplicate test).
    pub check: String,
    /// The whole text.
    pub text: String,
}

/// What [`Guard::hold`] did with one note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Held1 {
    /// Kept for the next prompt.
    Kept,
    /// The same note (same check, same text) is already held: held once.
    Duplicate,
    /// It does not fit the hold: not kept, never cut; the caller sends it now.
    TooLarge,
}

/// The notes of a note file or a claim: `{"notes":[{"c":check,"t":text}]}`; a file that is plain text (an older save) is one note.
fn parse_notes(text: &str) -> Result<Vec<Held>, Fail> {
    if text.trim().is_empty() {
        return Err(Fail::Parse);
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Ok(vec![Held { check: String::new(), text: text.to_string() }]);
    };
    let rows = v.get("notes").and_then(serde_json::Value::as_array).ok_or(Fail::Parse)?;
    rows.iter()
        .map(|r| match (r.get("c").and_then(serde_json::Value::as_str), r.get("t").and_then(serde_json::Value::as_str)) {
            (Some(c), Some(t)) if !t.trim().is_empty() => Ok(Held { check: c.to_string(), text: t.to_string() }),
            _ => Err(Fail::Parse),
        })
        .collect()
}

fn notes_json(notes: &[Held]) -> String {
    serde_json::json!({"notes": notes.iter().map(|n| serde_json::json!({"c": n.check, "t": n.text})).collect::<Vec<_>>()}).to_string()
}

/// Add `from` to `into`, skipping a note that is there already (same check and text).
fn union(into: &mut Vec<Held>, from: impl IntoIterator<Item = Held>) {
    for n in from {
        if !into.contains(&n) {
            into.push(n);
        }
    }
}

/// The characters a delivery of `notes` takes: the prefix, the texts and the joiners between them.
fn delivery_chars(notes: &[Held]) -> usize {
    let joiner = defaults::text("dispatch.context_joiner").chars().count();
    let texts: usize = notes.iter().map(|n| n.text.chars().count()).sum();
    defaults::text("stop_channel.msg_held_prefix").chars().count() + texts + joiner * notes.len().saturating_sub(1)
}

impl Guard {
    fn chain_path(&self) -> PathBuf {
        named(&self.session, "")
    }

    fn note_path(&self) -> PathBuf {
        named(&self.session, defaults::text("stop_channel.note_suffix"))
    }

    /// Is the lock still this holder's own? The lock file must be there, be a regular file and hold this guard's token. Called before every
    /// save and before an emit: a lock that was deleted, or taken over as stale while its holder was suspended, makes the holder's
    /// writes unsafe, so it is a [`Fail::LockLost`] and nothing is written or emitted under it. A lock that is still ours is stamped
    /// fresh again, so a slow holder is not judged stale while it works.
    pub fn verify(&self) -> Result<(), Fail> {
        let ours = matches!(kind_of(&self.lock), Ok(Kind::File)) && std::fs::read_to_string(&self.lock).is_ok_and(|t| t == self.token);
        if !ours {
            return Err(Fail::LockLost);
        }
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&self.lock) {
            crate::discard::harmless(f.set_modified(std::time::SystemTime::now())); // keep: an unstamped lock is judged stale sooner, and verify() still proves it ours
        }
        Ok(())
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
        let num = |k: &str| v.get(k).and_then(serde_json::Value::as_u64);
        match (num("n"), num("off")) {
            // `t` is what a save writes; a file without it is one save of an earlier shape, whose total is no less than its run
            (Some(n), Some(off)) => Ok(Chain { n, t: num("t").unwrap_or(n).max(n), off }),
            _ => Err(Fail::Parse),
        }
    }

    /// Save the chain, and read it back: a save that cannot be proven did not happen. The lock is proven ours before and after.
    pub fn save(&self, c: Chain) -> Result<(), Fail> {
        self.verify()?;
        ensure_dir()?;
        let body = serde_json::json!({"n": c.n, "t": c.t, "off": c.off}).to_string();
        if let Err(e) = crate::atomic::write(self.chain_path(), body) {
            crate::discard::note("stop_channel_state_write", &e.to_string());
            return Err(Fail::Save);
        }
        if self.chain()? != c {
            return Err(Fail::Save);
        }
        self.verify()
    }

    /// Start the chain again (a new prompt). An absent chain is already started.
    pub fn clear(&self) -> Result<(), Fail> {
        self.verify()?;
        let p = self.chain_path();
        match kind_of(&p)? {
            Kind::Absent => Ok(()),
            Kind::Other => Err(Fail::Shape),
            Kind::File => std::fs::remove_file(&p).map_err(|_| Fail::Save),
        }
    }

    /// The notes held now. An absent file holds none; a file that cannot be read or understood is a [`Fail`] (a note is never replaced
    /// over a file that was not understood).
    fn held(&self) -> Result<Vec<Held>, Fail> {
        let p = self.note_path();
        match kind_of(&p)? {
            Kind::Absent => Ok(Vec::new()),
            Kind::Other => Err(Fail::Shape),
            Kind::File => parse_notes(&std::fs::read_to_string(&p).map_err(|_| Fail::Read)?),
        }
    }

    fn write_held(&self, notes: &[Held]) -> Result<(), Fail> {
        ensure_dir()?;
        crate::atomic::write(self.note_path(), notes_json(notes)).map_err(|e| {
            crate::discard::note("stop_channel_note_write", &e.to_string());
            Fail::Save
        })
    }

    /// Keep `notes` for the session's next prompt, beside the notes already held. A note is kept WHOLE or not at all: the same note (same
    /// check and text) is held once, checked before its size is measured; a note that would take the delivery past `max` characters
    /// (prefix, all texts and joiners) is not kept (`Held1::TooLarge`) and the caller sends it now. The notes already held are never
    /// cut or replaced. One answer per input note, in order.
    pub fn hold(&self, notes: &[(&str, &str)], max: usize) -> Result<Vec<Held1>, Fail> {
        self.verify()?;
        let mut held = self.held()?;
        let mut kept = false;
        let mut out = Vec::with_capacity(notes.len());
        for (check, text) in notes {
            let n = Held { check: (*check).to_string(), text: (*text).to_string() };
            if held.contains(&n) {
                out.push(Held1::Duplicate);
                continue;
            }
            held.push(n);
            if delivery_chars(&held) > max {
                held.pop();
                out.push(Held1::TooLarge);
            } else {
                kept = true;
                out.push(Held1::Kept);
            }
        }
        if kept {
            self.write_held(&held)?;
        }
        Ok(out)
    }

    /// Claim every held note of the session by an atomic rename: the current one, and the claims an earlier crash left behind once they are
    /// older than `stop_channel.claim_stale_s`. Every file is read and understood BEFORE the current note is renamed, so a note that
    /// cannot be understood stays where it is. The claims are removed by [`Claims::release`] after the answer carrying the notes was
    /// written, or put back by [`Claims::restore`].
    pub fn claim(&self) -> Result<Claims, Fail> {
        self.verify()?;
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
        files.sort();
        let mut notes = Vec::new();
        for f in &files {
            union(&mut notes, parse_notes(&std::fs::read_to_string(f).map_err(|_| Fail::Read)?)?);
        }
        match kind_of(&note)? {
            Kind::Absent => {}
            Kind::Other => return Err(Fail::Shape),
            Kind::File => {
                union(&mut notes, parse_notes(&std::fs::read_to_string(&note).map_err(|_| Fail::Read)?)?);
                let mine = PathBuf::from(format!("{}{infix}{}", note.display(), token()));
                std::fs::rename(&note, &mine).map_err(|_| Fail::Save)?;
                // a rename keeps the file's age: stamp the claim, so a recovery waits for its own timeout
                if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&mine) {
                    crate::discard::harmless(f.set_modified(std::time::SystemTime::now())); // keep: an unstamped claim is recovered sooner, not lost
                }
                files.push(mine);
            }
        }
        Ok(Claims { files, notes })
    }

    /// Put claimed notes back for the next prompt (their answer was blocked or did not carry them): they are merged with whatever was
    /// held meanwhile (a duplicate is kept once, nothing is cut), then the claim files are removed. A failure leaves the claims, which a
    /// later prompt delivers after `stop_channel.claim_stale_s`.
    pub fn restore(&self, claims: Claims) -> Result<(), Fail> {
        self.verify()?;
        let mut merged = claims.notes.clone();
        union(&mut merged, self.held()?);
        if !merged.is_empty() {
            self.write_held(&merged)?;
        }
        claims.release()
    }
}

/// Notes claimed from a session; their files stay until [`Claims::release`] or [`Guard::restore`].
pub struct Claims {
    files: Vec<PathBuf>,
    /// The claimed notes, a note held twice once.
    pub notes: Vec<Held>,
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

    fn lock_path(s: &str) -> PathBuf {
        dir().join(format!("{s}{}", defaults::text("stop_channel.lock_suffix")))
    }

    fn age(p: &Path, factor: u64) {
        let old = std::time::SystemTime::now() - std::time::Duration::from_millis(defaults::num("stop_channel.lock_stale_ms") * factor);
        std::fs::OpenOptions::new().write(true).open(p).unwrap().set_modified(old).unwrap();
    }

    fn texts(c: &Claims) -> Vec<String> {
        c.notes.iter().map(|n| n.text.clone()).collect()
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
                            g.save(Chain { n: c.n + 1, t: c.t + 1, off: 7 }).unwrap();
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
                            assert_eq!(lock(s).unwrap().hold(&[("c", &body)], 10_000).unwrap(), vec![Held1::Kept]);
                        })
                    })
                    .collect();
                for _ in 0..4 {
                    sc.spawn(|| {
                        while !done.load(Ordering::SeqCst) {
                            let g = lock(&s).unwrap();
                            let c = g.claim().unwrap();
                            seen.lock().unwrap().extend(texts(&c));
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
            all.extend(texts(&c));
            c.release().unwrap();
            for i in 0..4 {
                assert_eq!(all.iter().filter(|t| **t == format!("note-{round}-{i}")).count(), 1, "round {round}: {all:?}");
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
        assert_eq!(g.save(Chain { n: 1, t: 1, off: 1 }), Err(Fail::Save), "and the save fails too");
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
    fn the_total_since_the_prompt_survives_a_save_and_an_older_save_without_it_reads_as_its_run() {
        let s = session("total");
        let g = lock(&s).unwrap();
        g.save(Chain { n: 1, t: 4, off: 9 }).unwrap();
        assert_eq!(g.chain().unwrap(), Chain { n: 1, t: 4, off: 9 });
        assert_eq!(g.chain().unwrap().restarted(), Chain { n: 0, t: 4, off: u64::MAX }, "a tool call restarts the run, never the total");
        std::fs::write(dir().join(&s), "{\"n\":2,\"off\":5}").unwrap();
        assert_eq!(g.chain().unwrap(), Chain { n: 2, t: 2, off: 5 });
    }

    #[test]
    fn a_lock_that_stays_held_fails_and_a_stale_one_is_taken_over() {
        let s = session("lock");
        let first = lock(&s).unwrap();
        let path = lock_path(&s);
        // fresh and held: the wait ends (the test lowers nothing; the wait is the shipped one) -> too slow to wait for, so age it instead
        age(&path, 2);
        let second = lock(&s).expect("a stale lock is taken over");
        drop(first); // not ours any more: must not remove the new holder's lock
        assert!(path.is_file(), "the old holder did not delete its successor's lock");
        drop(second);
        assert!(!path.exists());
        std::fs::create_dir(&path).unwrap();
        assert!(matches!(lock(&s), Err(Fail::Shape)), "a directory in the lock path");
        std::fs::remove_dir(&path).unwrap();
    }

    /// Review P2 (a lock deleted while a Stop holds it let two Stops both proceed): the lock carries a nonce that is checked before every
    /// save; a deleted lock aborts the save and nothing is written.
    #[test]
    fn a_lock_that_was_deleted_under_its_holder_aborts_every_write() {
        let s = session("deleted");
        let g = lock(&s).unwrap();
        g.verify().unwrap();
        assert!(std::fs::read_to_string(lock_path(&s)).unwrap().starts_with(&format!("{}.", std::process::id())), "the lock carries the pid");
        std::fs::remove_file(lock_path(&s)).unwrap();
        assert_eq!(g.verify(), Err(Fail::LockLost));
        assert_eq!(g.save(Chain { n: 1, t: 1, off: 1 }), Err(Fail::LockLost));
        assert!(!dir().join(&s).exists(), "nothing was saved");
        assert_eq!(g.hold(&[("c", "kept")], 1000), Err(Fail::LockLost));
        assert_eq!(g.clear().err(), Some(Fail::LockLost));
        assert_eq!(g.claim().err(), Some(Fail::LockLost));
    }

    /// A holder suspended past the stale timeout loses its lock to a successor: its next save aborts, the successor's state stays.
    #[test]
    fn a_holder_suspended_past_the_stale_timeout_cannot_save_over_its_successor() {
        let s = session("stolen");
        let slow = lock(&s).unwrap();
        age(&lock_path(&s), 2); // suspended: its lock goes stale without a verify to stamp it fresh
        let quick = lock(&s).expect("taken over as stale");
        quick.save(Chain { n: 1, t: 1, off: 3 }).unwrap();
        assert_eq!(slow.save(Chain { n: 1, t: 1, off: 99 }), Err(Fail::LockLost), "the old holder's save aborts");
        assert_eq!(quick.chain().unwrap(), Chain { n: 1, t: 1, off: 3 }, "the successor's state is untouched");
        assert_eq!(slow.verify(), Err(Fail::LockLost));
        quick.verify().unwrap();
        drop(slow);
        assert!(lock_path(&s).is_file(), "and dropping the old holder leaves the successor's lock");
    }

    /// A holder that keeps working is stamped fresh by every verify, so it is not judged stale while it works.
    #[test]
    fn a_verified_lock_is_stamped_fresh() {
        let s = session("fresh");
        let g = lock(&s).unwrap();
        age(&lock_path(&s), 2);
        g.verify().unwrap();
        assert!(age_of(&lock_path(&s)).unwrap() < std::time::Duration::from_millis(defaults::num("stop_channel.lock_stale_ms")));
    }

    #[test]
    fn a_crashed_claim_is_delivered_again_after_the_timeout_and_not_before() {
        let s = session("claim");
        let g = lock(&s).unwrap();
        assert_eq!(g.hold(&[("c", "kept")], 1000).unwrap(), vec![Held1::Kept]);
        let c = g.claim().unwrap();
        assert_eq!(texts(&c), vec!["kept".to_string()]);
        std::mem::forget(c); // the process died between claiming and removing
        assert!(g.claim().unwrap().notes.is_empty(), "a fresh claim is still its owner's");
        let infix = defaults::text("stop_channel.claim_infix");
        let claim =
            std::fs::read_dir(dir()).unwrap().flatten().find(|e| e.file_name().to_string_lossy().starts_with(&format!("{s}.note{infix}"))).unwrap().path();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(defaults::num("stop_channel.claim_stale_s") * 2);
        std::fs::OpenOptions::new().write(true).open(&claim).unwrap().set_modified(old).unwrap();
        let again = g.claim().unwrap();
        assert_eq!(texts(&again), vec!["kept".to_string()], "recovered after the timeout");
        again.release().unwrap();
        assert!(g.claim().unwrap().notes.is_empty());
    }

    /// Review P1 (`joined.chars().take(max)`): a held note of 3990 characters plus a later hold cut the NEWEST text. Now a note is kept
    /// whole or not at all: the held one is untouched and the later one is reported as not kept (the caller sends it now).
    #[test]
    fn a_hold_never_cuts_a_note_and_one_that_does_not_fit_is_reported() {
        let s = session("big");
        let g = lock(&s).unwrap();
        let max = 4000;
        let big = "x".repeat(max - 10 - defaults::text("stop_channel.msg_held_prefix").chars().count()); // 3990 characters in all, as the review's case
        assert_eq!(g.hold(&[("a", &big)], max).unwrap(), vec![Held1::Kept]);
        let before = std::fs::read(dir().join(format!("{s}.note"))).unwrap();
        let newest = "PLAN MODE: track this work as tasks";
        assert_eq!(g.hold(&[("b", newest)], max).unwrap(), vec![Held1::TooLarge], "the newest does not fit: not held, not cut");
        assert_eq!(std::fs::read(dir().join(format!("{s}.note"))).unwrap(), before, "the held note is byte for byte what it was");
        let c = g.claim().unwrap();
        assert_eq!(texts(&c), vec![big], "the held note comes out in full");
        c.release().unwrap();
        // alone, a note over the limit is not held either
        assert_eq!(g.hold(&[("a", &"y".repeat(max + 1))], max).unwrap(), vec![Held1::TooLarge]);
        assert!(g.claim().unwrap().notes.is_empty());
    }

    /// An advisory repeated at every Stop of an unattended run is held once, and its repeats are measured against nothing: they do not
    /// fill the hold.
    #[test]
    fn the_same_note_held_again_is_held_once_and_does_not_fill_the_hold() {
        let s = session("dup");
        let g = lock(&s).unwrap();
        let note = "n".repeat(500);
        let max = defaults::text("stop_channel.msg_held_prefix").chars().count() + 600;
        assert_eq!(g.hold(&[("c", &note)], max).unwrap(), vec![Held1::Kept]);
        for _ in 0..50 {
            assert_eq!(g.hold(&[("c", &note)], max).unwrap(), vec![Held1::Duplicate]);
        }
        assert_eq!(g.hold(&[("other", &note)], max).unwrap(), vec![Held1::TooLarge], "another check's note of the same text is a different note");
        assert_eq!(g.hold(&[("c", "short")], max).unwrap(), vec![Held1::Kept], "and room is still there for a note that fits");
        let c = g.claim().unwrap();
        assert_eq!(c.notes.len(), 2, "{:?}", texts(&c));
    }

    /// A note file of an older save (plain text) is one note; a file that is neither is a failure, and nothing is written over it.
    #[test]
    fn an_older_plain_note_is_delivered_and_a_corrupt_one_is_never_overwritten() {
        let s = session("legacy");
        let g = lock(&s).unwrap();
        let p = dir().join(format!("{s}.note"));
        std::fs::write(&p, "Held from the end: old text").unwrap();
        assert_eq!(g.hold(&[("c", "new")], 1000).unwrap(), vec![Held1::Kept]);
        assert_eq!(g.claim().unwrap().notes.len(), 2);
        for body in ["", "   ", "{\"notes\":3}", "{\"notes\":[{\"c\":1}]}"] {
            std::fs::write(&p, body).unwrap();
            assert_eq!(g.hold(&[("c", "x")], 1000), Err(Fail::Parse), "{body:?}");
            assert_eq!(g.claim().err(), Some(Fail::Parse), "{body:?}");
            assert_eq!(std::fs::read_to_string(&p).unwrap(), body, "{body:?}: left as it was");
        }
    }

    /// A claim put back is merged with what was held meanwhile (a duplicate once, nothing cut), and its files are gone.
    #[test]
    fn a_claim_put_back_is_merged_with_what_was_held_meanwhile() {
        let s = session("restore");
        let g = lock(&s).unwrap();
        g.hold(&[("a", "first"), ("b", "second")], 1000).unwrap();
        let c = g.claim().unwrap();
        g.hold(&[("b", "second"), ("c", "third")], 1000).unwrap(); // held again while the first claim was out
        g.restore(c).unwrap();
        let again = g.claim().unwrap();
        assert_eq!(texts(&again), vec!["first".to_string(), "second".to_string(), "third".to_string()]);
        again.release().unwrap();
        let left: Vec<_> = std::fs::read_dir(dir()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(&s)).collect();
        assert_eq!(left.len(), 1, "only the lock is left: {left:?}");
    }
}
