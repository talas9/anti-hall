//! One reconstruction per state of a transcript file, shared by every check that asks for it (the Stop checks task-guard,
//! task-pair-guard and tasklist-guard each rebuild the same task list from the same tail; task-guard asks twice).
//!
//! A reconstruction is a pure function of the file's bytes, the window sizes and the plugin defaults, so its answer is memoized
//! under exactly those: the file's device, inode, size and modification time, the variant and windows, and the defaults
//! generation. A file that changed by one byte has another key and is read afresh; nothing here is the source of truth.
//! The slot of a key is filled once: a check that asks while another is still computing the same key waits for that answer
//! instead of computing it again (the Stop checks of one request may run on different workers).
//!
//! Bounded by `taskstate.memo_entries` (the most keys kept, the least recently used dropped first; 0 turns the memo off and
//! every call reconstructs).
use crate::defaults;
use std::any::{Any, TypeId};
use std::collections::VecDeque;
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Which reconstruction an answer is: the guard, state and scan task lists, and the backward scan that completes a cut tail.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tag {
    /// `task-guard.js` `parseTasksFromFile`.
    Guard,
    /// `lib/task-state.js` `reconstructTasks`.
    State,
    /// The tasklist gate's transcript pass.
    Scan,
    /// The backward scan for tasks whose records sit before the window.
    Backfill,
}

#[derive(Clone, PartialEq, Eq)]
struct Key {
    path: String,
    dev: u64,
    ino: u64,
    size: u64,
    mtime: (i64, i64),
    ends: u64,
    tag: Tag,
    window: u64,
    sig: String,
    generation: u64,
    ty: TypeId,
}

type Slot = Arc<OnceLock<Box<dyn Any + Send + Sync>>>;

type Memo = Mutex<VecDeque<(Key, Slot)>>;

fn memo() -> &'static Memo {
    static MEMO: Memo = Mutex::new(VecDeque::new());
    &MEMO
}

static COMPUTES: AtomicU64 = AtomicU64::new(0);

/// How many reconstructions this process has computed (not served from the memo): what a test counts to prove a request
/// reconstructs each variant once.
pub fn computes() -> u64 {
    COMPUTES.load(Ordering::Relaxed)
}

/// A digest of the first and last bytes of the file (`transcript.evidence_fingerprint_bytes` each): a file rewritten in place to
/// the same size within one tick of a coarse clock still differs here.
fn ends_of(f: &std::fs::File, size: u64) -> Option<u64> {
    use std::hash::Hasher;
    use std::os::unix::fs::FileExt;
    let n = defaults::num("transcript.evidence_fingerprint_bytes").min(size) as usize;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let mut buf = vec![0u8; n];
    f.read_exact_at(&mut buf, 0).ok()?;
    h.write(&buf);
    f.read_exact_at(&mut buf, size - n as u64).ok()?;
    h.write(&buf);
    Some(h.finish())
}

fn key_of(path: &str, tag: Tag, window: u64, sig: &str, ty: TypeId) -> Option<Key> {
    let f = std::fs::File::open(path).ok()?;
    let m = f.metadata().ok()?;
    Some(Key {
        path: path.to_string(),
        dev: m.dev(),
        ino: m.ino(),
        size: m.len(),
        mtime: (m.mtime(), m.mtime_nsec()),
        ends: ends_of(&f, m.len())?,
        tag,
        window,
        sig: sig.to_string(),
        generation: defaults::generation(),
        ty,
    })
}

/// The answer of `compute` for this state of the file at `path`: the memoized one when this state was computed before (or is being
/// computed by another caller), else a fresh one. `tag` names the reconstruction (a variant), `window` its window and `sig` whatever else the answer depends on besides the file.
/// An answer `keep` rejects is returned but not remembered. A file that cannot be read is never memoized.
pub fn memoized<V: Clone + Send + Sync + 'static>(path: &str, tag: Tag, window: u64, sig: &str, compute: impl Fn() -> V, keep: impl Fn(&V) -> bool) -> V {
    memoized_in(memo(), defaults::num("taskstate.memo_entries") as usize, path, tag, window, sig, compute, keep)
}

/// [`memoized`] over a given memo of at most `cap` keys (the process-wide one in production; a test's own, so that parallel tests
/// cannot evict each other's keys).
#[allow(clippy::too_many_arguments)]
fn memoized_in<V: Clone + Send + Sync + 'static>(
    memo: &Memo,
    cap: usize,
    path: &str,
    tag: Tag,
    window: u64,
    sig: &str,
    compute: impl Fn() -> V,
    keep: impl Fn(&V) -> bool,
) -> V {
    if cap == 0 {
        crate::load::note_count("taskstate_memo", "result", "off");
        return compute();
    }
    let ty = TypeId::of::<V>();
    let Some(key) = key_of(path, tag, window, sig, ty) else { return compute() };
    let slot: Slot = {
        let mut m = memo.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(i) = m.iter().position(|(k, _)| *k == key) {
            let hit = m.remove(i).unwrap_or_else(|| (key.clone(), Slot::default()));
            let s = hit.1.clone();
            m.push_back(hit);
            s
        } else {
            let s = Slot::default();
            m.push_back((key.clone(), s.clone()));
            while m.len() > cap {
                m.pop_front();
            }
            s
        }
    };
    let mut ran = false;
    let boxed = slot.get_or_init(|| {
        ran = true;
        COMPUTES.fetch_add(1, Ordering::Relaxed);
        Box::new(compute())
    });
    let Some(v) = boxed.downcast_ref::<V>().cloned() else { return compute() };
    crate::load::note_count("taskstate_memo", "result", if ran { "miss" } else { "hit" });
    // an answer not worth remembering, or computed while the file changed under it, is dropped from the memo
    if ran && (!keep(&v) || key_of(path, tag, window, sig, ty).as_ref() != Some(&key)) {
        let mut m = memo.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        m.retain(|(_, s)| !Arc::ptr_eq(s, &slot));
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch file removed on drop, so a test leaves nothing in the temp dir.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(tag: &str, body: &str) -> Scratch {
            let p = std::env::temp_dir().join(format!("ah-memo-{tag}-{}", std::process::id()));
            std::fs::write(&p, body).unwrap();
            Scratch(p)
        }
        fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            crate::discard::harmless(std::fs::remove_file(&self.0)); // keep: cleanup of a scratch file
        }
    }

    /// Each test asks its own memo, so a parallel test cannot evict its keys.
    fn own() -> Memo {
        Mutex::new(VecDeque::new())
    }

    #[test]
    fn taskstate_memo_serves_an_unchanged_file_once_and_a_changed_one_afresh() {
        let f = Scratch::new("a", "one");
        let (p, m) = (f.path(), own());
        let n = std::cell::Cell::new(0u32);
        let ask = |tag: u8| {
            memoized_in(
                &m,
                8,
                &p,
                if tag == 1 { Tag::Guard } else { Tag::State },
                10,
                "",
                || {
                    n.set(n.get() + 1);
                    n.get()
                },
                |_| true,
            )
        };
        assert_eq!(ask(1), 1);
        assert_eq!(ask(1), 1, "same file state, same variant: served");
        assert_eq!(ask(2), 2, "another variant is its own key");
        std::fs::write(&p, "one two").unwrap();
        assert_eq!(ask(1), 3, "a changed file is read afresh");
    }

    #[test]
    fn taskstate_memo_does_not_remember_a_rejected_answer() {
        let f = Scratch::new("b", "x");
        let (p, m) = (f.path(), own());
        let n = std::cell::Cell::new(0u32);
        let ask = || {
            memoized_in(
                &m,
                8,
                &p,
                Tag::Scan,
                10,
                "",
                || {
                    n.set(n.get() + 1);
                    n.get()
                },
                |_| false,
            )
        };
        assert_eq!(ask(), 1);
        assert_eq!(ask(), 2);
    }

    #[test]
    fn taskstate_memo_does_not_remember_an_error_and_recovers_when_the_read_works() {
        let f = Scratch::new("c", "x");
        let (p, m) = (f.path(), own());
        let fail = std::cell::Cell::new(true);
        let n = std::cell::Cell::new(0u32);
        let ask = || {
            memoized_in(
                &m,
                8,
                &p,
                Tag::Backfill,
                10,
                "",
                || {
                    n.set(n.get() + 1);
                    if fail.get() { Err(n.get()) } else { Ok(n.get()) }
                },
                |r: &Result<u32, u32>| r.is_ok(),
            )
        };
        assert_eq!(ask(), Err(1));
        assert_eq!(ask(), Err(2), "an error is computed afresh each time");
        fail.set(false);
        assert_eq!(ask(), Ok(3), "the first good answer is computed, not the old error served");
        assert_eq!(ask(), Ok(3), "and is then kept");
    }
}
