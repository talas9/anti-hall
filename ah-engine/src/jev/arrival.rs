//! Arrival labelling: a freshly sent direct message is labelled by Jev (urgency, kind) soon after it arrives, and the label is
//! written to the cache the mesh summary reads (`jevQuestionCandidates`).
//!
//! Mirrors `hooks/lib/jev-triage.js`:
//! * [`enqueue`] is `enqueueArrival`: append `{h, t}` to the capped queue file. Nothing is spawned; the scheduled job
//!   `jev_arrival` (`ah-engine jev arrival`) drains the queue, so no hook ever waits for Jev.
//! * [`run_worker`] is `runArrivalWorker`: one worker per home (the drain lock), batches of `batch_size`, capped by
//!   `max_batches`, `max_wall_ms` and `max_attempts`.
//! * [`triage_sync`] is `triageMessagesSync` / `runWorkerAndCache`: per-hash in-flight claims so a message is paid for once,
//!   the labeller call, and the `jev-triage.json` writer (`_seq`, `nl`, the bound) in Node's file format, which
//!   `meshw/summary.rs` reads.
//!
//! One deliberate difference from Node, for loss-freedom: a worker's private copy of the queue (`<queue>.work.<pid>.<n>`) is
//! deleted only when its messages are handled (or the run ends cleanly, as Node drops what its caps leave over). A worker that
//! dies in between leaves the copy; the next worker, which holds the drain lock and so is the only one, adopts it. A message
//! is never lost and, because a label already in the cache is never asked for again, never labelled twice.
//!
//! Every cap, interval, file name and word is in `engine/defaults/jev_arrival.toml`. Pruning of stale claims, locks and an
//! old queue (`state-prune.js` `pruneJevTriage`) is not ported: a stale claim or lock is taken over by age, and the engine
//! deletes no queued message.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - text that does not parse is the absent value (Node JSON.parse catch parity)
// - the queue is advisory: a message that cannot be queued is labelled when a reader asks
// A failure that must be seen goes through `crate::discard` instead.

use super::settings::{Env, JevSettings, Mode, Sources};
use crate::checks::guardkit::nodelock::{self, Held, Params, Refresh};
use crate::checks::jsport::json::{self, J};
use crate::defaults;
use crate::judge::triage::Label;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// The caps and lock parameters, from the shipped defaults (tests build their own).
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Over this size the queue takes no more arrivals.
    pub queue_max_bytes: u64,
    /// A longer body (UTF-16 units) is not queued.
    pub text_max_chars: usize,
    /// Messages per triage call.
    pub batch_size: usize,
    /// The most batches one worker run does.
    pub max_batches: u64,
    /// The longest one worker run takes.
    pub max_wall_ms: u128,
    /// How often a skipped message is retried within one run.
    pub max_attempts: u64,
    /// Labels the cache keeps.
    pub cache_max_entries: usize,
    /// The drain lock.
    pub drain: Params,
    /// A per-hash claim.
    pub claim: Params,
}

impl Limits {
    /// The shipped values.
    pub fn shipped() -> Limits {
        let l = defaults::raw("jev_arrival.limits");
        let n = |k: &str| l.get(k).and_then(|v| v.as_integer()).unwrap_or(0).max(0) as u64;
        Limits {
            queue_max_bytes: n("queue_max_bytes"),
            text_max_chars: n("text_max_chars") as usize,
            batch_size: (n("batch_size") as usize).max(1),
            max_batches: n("max_batches"),
            max_wall_ms: n("max_wall_ms") as u128,
            max_attempts: n("max_attempts"),
            cache_max_entries: (n("cache_max_entries") as usize).max(1),
            drain: Params {
                stale_ms: defaults::num("jev_arrival_drain.lock_stale_ms"),
                wait_ms: defaults::num("jev_arrival_drain.lock_wait_ms"),
                step_ms: defaults::num("jev_arrival_drain.lock_step_ms"),
                reclaim_stale_ms: defaults::num("jev_arrival_drain.lock_reclaim_stale_ms"),
                release_tries: defaults::num("jev_arrival_drain.lock_release_tries"),
                release_step_ms: defaults::num("jev_arrival_drain.lock_release_step_ms"),
                boot_slop_s: defaults::num("jev_arrival_drain.lock_boot_slop_s"),
                steal_dead: false,
            },
            claim: Params {
                stale_ms: defaults::num("jev_arrival_claim.lock_stale_ms"),
                wait_ms: defaults::num("jev_arrival_claim.lock_wait_ms"),
                step_ms: defaults::num("jev_arrival_claim.lock_step_ms"),
                reclaim_stale_ms: defaults::num("jev_arrival_claim.lock_reclaim_stale_ms"),
                release_tries: defaults::num("jev_arrival_claim.lock_release_tries"),
                release_step_ms: defaults::num("jev_arrival_claim.lock_release_step_ms"),
                boot_slop_s: defaults::num("jev_arrival_claim.lock_boot_slop_s"),
                steal_dead: false,
            },
        }
    }
}

/// What labelling is configured to do (Node: `loadTriageConfig`).
#[derive(Debug, Clone, PartialEq)]
pub struct Cfg {
    /// Jev is on and its triage integration is not switched off.
    pub enabled: bool,
    /// The wall budget of one triage call.
    pub budget_ms: u64,
    /// The confidence an urgent label needs.
    pub urgent_threshold: f64,
    /// Rotated log generations kept.
    pub log_keep: u64,
}

/// `loadTriageConfig(home)`: never fails; settings that cannot be read leave labelling off.
pub fn load_cfg(home: &Path, env: Env) -> Cfg {
    let sources = Sources::load(home, env);
    let jev = JevSettings::resolve(home, sources.clone());
    // Node merges jev.json under settings.json's jev section, the latter winning key by key
    let merged = |key: &str| sources.settings.get("jev").and_then(|j| j.get(key)).or_else(|| sources.legacy.get(key));
    let switched_off = merged("triage") == Some(&serde_json::Value::Bool(false));
    let enabled = jev.mode(defaults::text("triage.integration"), false) != Mode::Off && !switched_off;
    let budget_ms = merged("triageBudgetMs")
        .and_then(serde_json::Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map_or(defaults::num("triage.default_timeout_ms"), |n| n as u64);
    let urgent_threshold = merged("triageUrgentThreshold")
        .and_then(serde_json::Value::as_f64)
        .filter(|n| (0.0..=1.0).contains(n))
        .unwrap_or_else(|| defaults::text("triage.default_urgent_threshold").parse().unwrap_or(0.9));
    Cfg { enabled, budget_ms, urgent_threshold, log_keep: jev.log_rotated_files }
}

/// A message to label: `key` is the caller's own identity for it.
#[derive(Debug, Clone)]
pub struct Item {
    /// The caller's identity for the message.
    pub key: usize,
    /// The body.
    pub text: String,
}

/// Who decides a label (the engine's triage worker; a stub in tests).
pub trait Labeler {
    /// One result per (hash, text) reached within `budget_ms`; `None` is "classified, no confident label"; an item left out
    /// was not attempted.
    fn label(&self, items: &[(String, String)], budget_ms: u64, urgent_threshold: f64) -> Vec<(String, Option<Label>)>;
}

/// The production labeler: Jev, through [`crate::judge::triage::label_items`].
pub struct EngineLabeler<'a> {
    /// The home the settings and keys are read from.
    pub home: &'a Path,
}

impl Labeler for EngineLabeler<'_> {
    fn label(&self, items: &[(String, String)], budget_ms: u64, urgent_threshold: f64) -> Vec<(String, Option<Label>)> {
        crate::judge::triage::label_items(self.home, items, budget_ms, urgent_threshold)
    }
}

fn outcome(name: &str) {
    crate::metrics::bump(defaults::text("jev_arrival.metric"), &[("outcome", defaults::raw("jev_arrival.outcomes").str_field(name))]);
}

struct Paths {
    cache_dir: PathBuf,
    queue: PathBuf,
    lock: PathBuf,
    cache: PathBuf,
    claims: PathBuf,
    log: PathBuf,
}

fn paths(home: &Path) -> Paths {
    let base = home.join(defaults::text("paths.base_dir"));
    let cache_dir = base.join(defaults::text("mesh_write.dir_cache"));
    let files = defaults::raw("jev_arrival.files");
    Paths {
        queue: cache_dir.join(files.str_field("queue")),
        lock: cache_dir.join(files.str_field("lock")),
        claims: cache_dir.join(files.str_field("claims")),
        cache: cache_dir.join(defaults::text("mesh_write.jev_cache_file")),
        log: base.join(defaults::text("mesh_write.dir_logs")).join(defaults::text("mesh_write.jev_triage_log_file")),
        cache_dir,
    }
}

/// `hashMessage(text)`: the first `mesh_write.jev_hash_hex` hex digits of the SHA-256 of the text.
pub fn hash_message(text: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, text.as_bytes());
    crate::meshw::store::hex(d.as_ref()).chars().take(defaults::num("mesh_write.jev_hash_hex") as usize).collect()
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

// ---- the label cache (Node: readCache, writeCache, nextCacheSeq) ----------------------------------------------------------

/// The cache as Node's `readCache` sees it: a missing, unparsable or non-object file is empty. `None` for JSON only
/// JavaScript reads, which is left alone.
fn read_cache(path: &Path) -> Option<Vec<(String, J)>> {
    let Ok(raw) = std::fs::read_to_string(path) else { return Some(Vec::new()) };
    match json::parse(&raw, defaults::num("jev.cache_max_depth") as usize) {
        Ok(J::Obj(o)) => Some(o),
        Ok(_) | Err(json::Fail::Invalid) => Some(Vec::new()),
        Err(json::Fail::Unsupported) => None,
    }
}

fn truthy(v: &J) -> bool {
    match v {
        J::Null => false,
        J::Bool(b) => *b,
        J::Num(n) => *n != 0.0 && !n.is_nan(),
        J::Str(s) => !s.is_empty(),
        J::Arr(_) | J::Obj(_) => true,
    }
}

fn is_cached(cache: &[(String, J)], hash: &str) -> bool {
    cache.iter().rev().find(|(k, _)| k == hash).is_some_and(|(_, v)| truthy(v))
}

fn seq_of(v: &J) -> f64 {
    match v.get("_seq") {
        Some(J::Num(n)) if n.is_finite() => *n,
        _ => 0.0,
    }
}

/// One past the highest `_seq` stored: monotonic across processes, so a new label is never the first evicted.
fn next_seq(cache: &[(String, J)]) -> f64 {
    cache.iter().map(|(_, v)| seq_of(v)).fold(0.0, f64::max) + 1.0
}

fn label_of(v: &J) -> Option<(Option<String>, Option<String>)> {
    let s = |k: &str| match v.get(k) {
        Some(J::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    };
    let (urgency, kind) = (s("urgency"), s("kind"));
    (urgency.is_some() || kind.is_some()).then_some((urgency, kind))
}

/// `writeCache`: bounded to `cap` entries, the lowest `_seq` going first; atomic, so a reader never sees a torn file.
fn write_cache(path: &Path, mut entries: Vec<(String, J)>, cap: usize) {
    if entries.len() > cap {
        entries.sort_by(|a, b| seq_of(&a.1).total_cmp(&seq_of(&b.1)));
        let drop = entries.len() - cap;
        entries.drain(..drop);
    }
    if let Some(dir) = path.parent()
        && std::fs::create_dir_all(dir).is_err()
    {
        return;
    }
    // best effort: a lost write only means the labels are asked again
    crate::discard::logged("jev_triage_cache_write", crate::atomic::write(path, json::stringify(&J::Obj(entries))));
}

fn entry(label: Option<&Label>, seq: f64) -> J {
    let mut o: Vec<(String, J)> = Vec::new();
    match label {
        Some(l) => {
            if let Some(u) = l.urgency.as_ref().filter(|u| !u.is_empty()) {
                o.push(("urgency".into(), J::Str(u.clone())));
            }
            if let Some(k) = l.kind.as_ref().filter(|k| !k.is_empty()) {
                o.push(("kind".into(), J::Str(k.clone())));
            }
            o.push(("_seq".into(), J::Num(seq)));
        }
        // a real "no label" verdict; `nl` tells it from the bare {_seq} that migrate repairs
        None => {
            o.push(("_seq".into(), J::Num(seq)));
            o.push(("nl".into(), J::Bool(true)));
        }
    }
    J::Obj(o)
}

fn append_log(p: &Paths, keep: u64, hash: &str, l: &Label) {
    let opt = |s: &Option<String>| s.clone().map_or(J::Null, J::Str);
    let mut row = vec![
        ("ts".to_string(), J::Str(crate::checks::jsport::date::to_iso(crate::checks::replykit::io::now_ms() as f64).unwrap_or_default())),
        ("hash".into(), J::Str(hash.to_string())),
        ("urgency".into(), opt(&l.urgency)),
        ("kind".into(), opt(&l.kind)),
        ("backend".into(), if l.backend.is_empty() { J::Null } else { J::Str(l.backend.clone()) }),
        ("ms".into(), J::Num(l.ms as f64)),
    ];
    if let Some(t) = l.transport.as_ref().filter(|t| defaults::list("jev_arrival.transports").contains(&t.as_str())) {
        row.push(("transport".into(), J::Str(t.clone())));
    }
    if l.fell_back {
        row.push(("fellBack".into(), J::Bool(true)));
    }
    if let Some(dir) = p.log.parent() {
        crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: the triage log is advisory
    }
    crate::meshw::common::rotate_if_over(&p.log, defaults::num("mesh_write.jev_triage_log_max_bytes"), keep);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p.log) {
        use std::io::Write;
        crate::discard::harmless(f.write_all(format!("{}\n", json::stringify(&J::Obj(row))).as_bytes())); // keep: the triage log is advisory
    }
}

// ---- claims ---------------------------------------------------------------------------------------------------------------

enum Claim {
    Held(Held),
    /// Another process is labelling this message.
    Busy,
    /// The claim directory is unusable: claims are best effort, so labelling goes on without one.
    Unmanaged,
}

fn claim(p: &Paths, lim: &Limits, hash: &str) -> Claim {
    if std::fs::create_dir_all(&p.claims).is_err() {
        return Claim::Unmanaged;
    }
    match nodelock::acquire(&p.claims.join(hash).to_string_lossy(), lim.claim) {
        Some(h) => Claim::Held(h),
        None => Claim::Busy,
    }
}

// ---- triageMessagesSync ---------------------------------------------------------------------------------------------------

/// `triageMessagesSync(items, {home})` for the arrival path and for a reader that wants labels now: the labels the items have
/// or get, keyed by the caller's identity. A message another process is labelling is skipped (its label lands in the shared
/// cache); one the budget cut off stays uncached and is retried on a later call. Never panics, never blocks past the budget.
pub fn triage_sync(home: &Path, items: &[Item], lim: &Limits, labeler: &dyn Labeler) -> Vec<(usize, (Option<String>, Option<String>))> {
    let mut results: Vec<(usize, (Option<String>, Option<String>))> = Vec::new();
    let cfg = load_cfg(home, Env::process());
    if !cfg.enabled {
        return results; // the default: no fs, no network
    }
    let p = paths(home);
    let Some(cache) = read_cache(&p.cache) else { return results };
    let hashed: Vec<(usize, String, &str)> =
        items.iter().filter(|i| !crate::jev::js_trim(&i.text).is_empty()).map(|i| (i.key, hash_message(&i.text), i.text.as_str())).collect();
    let mut uncached: Vec<(usize, String, &str)> = Vec::new();
    for (key, hash, text) in hashed {
        match cache.iter().rev().find(|(k, _)| *k == hash).map(|(_, v)| v) {
            Some(v) if truthy(v) => {
                if let Some(l) = label_of(v) {
                    results.push((key, l));
                } // else a prior "no label" verdict: honoured, not asked again
            }
            _ => uncached.push((key, hash, text)),
        }
    }
    if uncached.is_empty() {
        return results;
    }
    // claim each uncached hash, then re-read the cache so a label a concurrent process just wrote is not paid for twice
    let mut claims: Vec<(String, Claim)> = Vec::new();
    let mut mine: Vec<(usize, String, &str)> = Vec::new();
    let fresh = read_cache(&p.cache).unwrap_or_default();
    for (key, hash, text) in uncached {
        if mine.iter().any(|(_, h, _)| *h == hash) {
            mine.push((key, hash, text)); // the same text twice in one call: one Jev call, both keys labelled
            continue;
        }
        let c = claim(&p, lim, &hash);
        if matches!(c, Claim::Busy) {
            outcome("skipped");
            continue;
        }
        if let Some(v) = fresh.iter().rev().find(|(k, _)| *k == hash).map(|(_, v)| v).filter(|v| truthy(v)) {
            if let Claim::Held(h) = c {
                h.release();
            }
            if let Some(l) = label_of(v) {
                results.push((key, l));
            }
            continue;
        }
        claims.push((hash.clone(), c));
        mine.push((key, hash, text));
    }
    if !mine.is_empty() {
        label_and_cache(&p, &cfg, lim, labeler, &mine, &mut results);
    }
    for (_, c) in claims {
        if let Claim::Held(h) = c {
            h.release();
        }
    }
    results
}

fn label_and_cache(
    p: &Paths,
    cfg: &Cfg,
    lim: &Limits,
    labeler: &dyn Labeler,
    mine: &[(usize, String, &str)],
    results: &mut Vec<(usize, (Option<String>, Option<String>))>,
) {
    let mut asked: Vec<(String, String)> = Vec::new();
    for (_, hash, text) in mine {
        if !asked.iter().any(|(h, _)| h == hash) {
            asked.push((hash.clone(), (*text).to_string()));
        }
    }
    let out = labeler.label(&asked, cfg.budget_ms, cfg.urgent_threshold);
    let mut fresh_entries: Vec<(String, Option<Label>)> = Vec::new(); // hash -> verdict, in the order asked
    for (hash, _) in &asked {
        match out.iter().find(|(h, _)| h == hash) {
            Some((_, Some(l))) if l.urgency.as_ref().is_some_and(|u| !u.is_empty()) || l.kind.as_ref().is_some_and(|k| !k.is_empty()) => {
                for (key, _, _) in mine.iter().filter(|(_, h, _)| h == hash) {
                    results.push((*key, (l.urgency.clone().filter(|u| !u.is_empty()), l.kind.clone().filter(|k| !k.is_empty()))));
                }
                append_log(p, cfg.log_keep, hash, l);
                outcome("labelled");
                fresh_entries.push((hash.clone(), Some(l.clone())));
            }
            // attempted, no confident label: cache the verdict so it is not asked every turn
            Some(_) => {
                outcome("no_label");
                fresh_entries.push((hash.clone(), None));
            }
            // never attempted (the budget ran out first): left uncached, retried later
            None => outcome("skipped"),
        }
    }
    if fresh_entries.is_empty() {
        return;
    }
    // re-read right before writing: a concurrent writer may have added entries since; fresh _seq values go on the re-read max
    let Some(mut latest) = read_cache(&p.cache) else { return };
    let mut cache = J::Obj(std::mem::take(&mut latest));
    let mut seq = match &cache {
        J::Obj(o) => next_seq(o),
        _ => 1.0,
    };
    for (hash, label) in &fresh_entries {
        cache.set(hash, entry(label.as_ref(), seq));
        seq += 1.0;
    }
    if let J::Obj(o) = cache {
        write_cache(&p.cache, o, lim.cache_max_entries);
    }
}

// ---- the queue ------------------------------------------------------------------------------------------------------------

/// What [`enqueue`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enqueued {
    /// Appended to the queue.
    Queued,
    /// Triage is off: nothing was written.
    Disabled,
    /// The text already has a label (or a no-label verdict).
    Cached,
    /// The queue is over its size cap.
    Full,
    /// The body is longer than the cap.
    TooLong,
    /// The queue could not be written.
    Failed,
}

/// `enqueueArrival({home, text})`. Never waits on Jev, never panics. Disabled and already-cached texts cost no write.
pub fn enqueue(home: &Path, text: &str, lim: &Limits) -> Enqueued {
    let r = enqueue_inner(home, text, lim);
    outcome(match r {
        Enqueued::Queued => "queued",
        Enqueued::Disabled => "disabled",
        Enqueued::Cached => "cached",
        Enqueued::Full => "full",
        Enqueued::TooLong => "too_long",
        Enqueued::Failed => "failed",
    });
    r
}

fn enqueue_inner(home: &Path, text: &str, lim: &Limits) -> Enqueued {
    if crate::jev::js_trim(text).is_empty() || !load_cfg(home, Env::process()).enabled {
        return Enqueued::Disabled;
    }
    let p = paths(home);
    if read_cache(&p.cache).is_some_and(|c| is_cached(&c, &hash_message(text))) {
        return Enqueued::Cached;
    }
    if js_len(text) > lim.text_max_chars {
        return Enqueued::TooLong;
    }
    if std::fs::create_dir_all(&p.cache_dir).is_err() {
        return Enqueued::Failed;
    }
    if std::fs::metadata(&p.queue).is_ok_and(|m| m.len() > lim.queue_max_bytes) {
        return Enqueued::Full;
    }
    let line = format!("{}\n", json::stringify(&J::Obj(vec![("h".into(), J::Str(hash_message(text))), ("t".into(), J::Str(text.to_string()))])));
    use std::io::Write;
    // one append of the whole line: concurrent senders interleave whole lines, never halves
    match std::fs::OpenOptions::new().create(true).append(true).open(&p.queue).and_then(|mut f| f.write_all(line.as_bytes())) {
        Ok(()) => Enqueued::Queued,
        Err(_) => Enqueued::Failed,
    }
}

/// True when a worker has something to do: a queued message, or a dead worker's private copy of the queue.
pub fn has_pending(home: &Path) -> bool {
    let p = paths(home);
    if std::fs::metadata(&p.queue).is_ok_and(|m| m.len() > 0) {
        return true;
    }
    !work_files(&p, &[]).is_empty()
}

fn work_files(p: &Paths, own: &[PathBuf]) -> Vec<PathBuf> {
    let prefix = format!("{}{}", defaults::raw("jev_arrival.files").str_field("queue"), defaults::raw("jev_arrival.files").str_field("work_infix"));
    let Ok(rd) = std::fs::read_dir(&p.cache_dir) else { return Vec::new() };
    let mut v: Vec<PathBuf> =
        rd.filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().starts_with(&prefix)).map(|e| e.path()).filter(|f| !own.contains(f)).collect();
    v.sort();
    v
}

struct Entry {
    hash: String,
    text: String,
}

fn read_entries(file: &Path, out: &mut Vec<Entry>) {
    let Ok(raw) = std::fs::read_to_string(file) else { return };
    for line in raw.split('\n').filter(|l| !l.is_empty()) {
        // a torn line is skipped; the hash is recomputed, so a line another writer stamped with another hash still lands
        if let Ok(J::Obj(o)) = json::parse(line, defaults::num("jev.cache_max_depth") as usize)
            && let Some((_, J::Str(t))) = o.iter().rev().find(|(k, _)| k == "t")
            && !crate::jev::js_trim(t).is_empty()
        {
            out.push(Entry { hash: hash_message(t), text: t.clone() });
        }
    }
}

static WORK_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// `takeQueue`: claim the whole queue by rename (a concurrent append starts a fresh file; nothing is read twice or lost), and
/// adopt every other private copy left by a worker that died (this one holds the drain lock, so none is live). The copies are
/// kept in `held` and deleted by [`finish_work`].
fn take_queue(p: &Paths, held: &mut Vec<PathBuf>) -> Vec<Entry> {
    let mut out = Vec::new();
    for orphan in work_files(p, held) {
        read_entries(&orphan, &mut out);
        held.push(orphan);
    }
    let infix = defaults::raw("jev_arrival.files").str_field("work_infix");
    let work = PathBuf::from(format!("{}{infix}{}.{}", p.queue.display(), std::process::id(), WORK_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    if std::fs::rename(&p.queue, &work).is_ok() {
        read_entries(&work, &mut out);
        held.push(work);
    }
    out
}

/// Delete the private copies whose messages are handled.
fn finish_work(held: &mut Vec<PathBuf>) {
    for f in held.drain(..) {
        crate::discard::harmless(std::fs::remove_file(&f)); // keep: our own disposable copy of messages that are cached or dropped
    }
}

// ---- the worker -----------------------------------------------------------------------------------------------------------

/// How a worker run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// The queue was empty at the end.
    Drained,
    /// Another worker holds the drain lock.
    Busy,
    /// Triage is off.
    Off,
    /// A batch or wall-time cap stopped the run; what was left is labelled when a reader asks.
    Capped,
    /// The drain lock was taken over by someone else; this worker stopped without touching the queue.
    LostLock,
}

/// What a run did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    /// How it ended.
    pub ended: Ended,
    /// Triage calls made.
    pub batches: u64,
    /// Messages that got a label.
    pub labelled: u64,
    /// Messages classified with no confident label.
    pub no_label: u64,
    /// Messages left unlabelled (skipped by the budget or a claim, then dropped after `max_attempts`, or left by a cap).
    pub skipped: u64,
}

impl Ended {
    /// The outcome word (the key in `jev_arrival.outcomes`).
    pub fn word(self) -> &'static str {
        defaults::raw("jev_arrival.outcomes").str_field(match self {
            Ended::Drained => "drained",
            Ended::Busy => "busy",
            Ended::Off => "off",
            Ended::Capped => "capped",
            Ended::LostLock => "lost_lock",
        })
    }
}

/// `runArrivalWorker(home)`: drain the queue under the drain lock, in batches, within the caps.
pub fn run_worker(home: &Path, lim: &Limits, labeler: &dyn Labeler) -> Summary {
    let mut sum = Summary { ended: Ended::Drained, batches: 0, labelled: 0, no_label: 0, skipped: 0 };
    if !load_cfg(home, Env::process()).enabled {
        sum.ended = Ended::Off;
        outcome("off");
        return sum;
    }
    let p = paths(home);
    let lock = || nodelock::acquire(&p.lock.to_string_lossy(), lim.drain);
    let Some(mut held) = lock() else {
        sum.ended = Ended::Busy;
        outcome("busy");
        return sum;
    };
    let t0 = Instant::now();
    let mut work: Vec<PathBuf> = Vec::new();
    let mut attempts: Vec<(String, u64)> = Vec::new();
    let mut pending: Vec<Entry> = Vec::new();
    sum.ended = 'run: loop {
        pending.extend(take_queue(&p, &mut work));
        // dedupe by hash and drop what is already cached
        let cache = read_cache(&p.cache).unwrap_or_default();
        let mut seen: Vec<String> = Vec::new();
        pending.retain(|e| {
            if seen.contains(&e.hash) || is_cached(&cache, &e.hash) {
                return false;
            }
            seen.push(e.hash.clone());
            true
        });
        if pending.is_empty() {
            finish_work(&mut work);
            held.release();
            // an arrival that landed between the last drain and the release has no lock: take it again rather than strand it
            if std::fs::metadata(&p.queue).is_ok_and(|m| m.len() > 0)
                && let Some(again) = lock()
            {
                held = again;
                continue;
            }
            break 'run Ended::Drained;
        }
        if sum.batches >= lim.max_batches || t0.elapsed().as_millis() > lim.max_wall_ms {
            // the total cap: the leftovers are labelled when a reader asks, as before
            sum.skipped += pending.len() as u64;
            finish_work(&mut work);
            held.release();
            break 'run Ended::Capped;
        }
        if matches!(held.refresh(), Refresh::Lost) {
            // fail closed: the lock was reclaimed, so a new owner may be draining; the private copies are left for it to adopt
            outcome("lost_lock");
            break 'run Ended::LostLock;
        }
        let take = lim.batch_size.min(pending.len());
        let batch: Vec<Entry> = pending.drain(..take).collect();
        sum.batches += 1;
        let items: Vec<Item> = batch.iter().enumerate().map(|(i, e)| Item { key: i, text: e.text.clone() }).collect();
        let before = read_cache(&p.cache).unwrap_or_default();
        triage_sync(home, &items, lim, labeler);
        let after = read_cache(&p.cache).unwrap_or_default();
        for e in batch {
            match after.iter().rev().find(|(k, _)| *k == e.hash).map(|(_, v)| v).filter(|v| truthy(v)) {
                Some(v) => {
                    if label_of(v).is_some() && !is_cached(&before, &e.hash) {
                        sum.labelled += 1;
                    } else if !is_cached(&before, &e.hash) {
                        sum.no_label += 1;
                    }
                }
                None => {
                    let n = match attempts.iter_mut().find(|(h, _)| *h == e.hash) {
                        Some((_, n)) => {
                            *n += 1;
                            *n
                        }
                        None => {
                            attempts.push((e.hash.clone(), 1));
                            1
                        }
                    };
                    if n < lim.max_attempts {
                        pending.push(e); // skipped by the budget or a claim: retry
                    } else {
                        sum.skipped += 1;
                    }
                }
            }
        }
    };
    sum
}

/// The `ah-engine jev arrival` command: one worker run; returns the exit code (0: the run ended in any way).
pub fn run_cmd(home: &Path) -> i32 {
    crate::judge::allow_blocking_calls();
    let s = run_worker(home, &Limits::shipped(), &EngineLabeler { home });
    println!(
        "{}",
        defaults::render(
            "msg.jev_arrival_done",
            &[("outcome", &s.ended.word()), ("batches", &s.batches), ("labelled", &s.labelled), ("no_label", &s.no_label), ("skipped", &s.skipped)]
        )
    );
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn home(enabled: bool) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let h = std::env::temp_dir().join(format!("ah-arrival-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(h.join(".anti-hall")).unwrap();
        if enabled {
            std::fs::write(h.join(".anti-hall/jev.json"), r#"{"enabled":true}"#).unwrap();
        }
        h
    }

    fn lim() -> Limits {
        Limits {
            queue_max_bytes: 1 << 20,
            text_max_chars: 1000,
            batch_size: 2,
            max_batches: 50,
            max_wall_ms: 60_000,
            max_attempts: 3,
            cache_max_entries: 500,
            ..Limits::shipped()
        }
    }

    fn label(kind: &str, urgency: &str) -> Label {
        Label { kind: Some(kind.into()), urgency: Some(urgency.into()), backend: "jev".into(), ms: 7, transport: Some("vercel".into()), fell_back: false }
    }

    /// Never calls Jev: a text with a question mark is a question, anything else an fyi.
    #[derive(Default)]
    struct Stub {
        calls: Mutex<Vec<Vec<String>>>,
        skip: AtomicBool,
        no_label: AtomicBool,
        panic_once: AtomicBool,
    }

    impl Labeler for Stub {
        fn label(&self, items: &[(String, String)], _: u64, _: f64) -> Vec<(String, Option<Label>)> {
            self.calls.lock().unwrap().push(items.iter().map(|(_, t)| t.clone()).collect());
            if self.panic_once.swap(false, Ordering::SeqCst) {
                panic!("the worker died after claiming, before writing");
            }
            if self.skip.load(Ordering::SeqCst) {
                return Vec::new(); // the budget cut everything off
            }
            items
                .iter()
                .map(|(h, t)| {
                    let l = if self.no_label.load(Ordering::SeqCst) {
                        None
                    } else if t.contains('?') {
                        Some(label("question-needs-answer", "urgent"))
                    } else {
                        Some(label("fyi", "normal"))
                    };
                    (h.clone(), l)
                })
                .collect()
        }
    }

    impl Stub {
        fn asked(&self) -> usize {
            self.calls.lock().unwrap().iter().map(Vec::len).sum()
        }
    }

    fn cache_of(h: &Path) -> Vec<(String, J)> {
        read_cache(&paths(h).cache).unwrap_or_default()
    }

    #[test]
    fn a_queued_arrival_is_labelled_into_the_cache_the_reader_uses() {
        let h = home(true);
        let (l, s) = (lim(), Stub::default());
        assert_eq!(enqueue(&h, "can you review the diff?", &l), Enqueued::Queued);
        assert_eq!(enqueue(&h, "all green", &l), Enqueued::Queued);
        let sum = run_worker(&h, &l, &s);
        assert_eq!((sum.ended, sum.labelled, sum.batches), (Ended::Drained, 2, 1));
        let p = paths(&h);
        assert!(!p.queue.exists() && !p.lock.exists() && work_files(&p, &[]).is_empty(), "queue, lock and private copies are gone");
        // the reader (meshw/summary.rs): the cache is keyed by its hash, and a question carries kind question-needs-answer
        let q = "can you review the diff?";
        assert_eq!(hash_message(q), crate::meshw::summary::jev_hash(q), "the writer and the reader hash alike");
        let file = std::fs::read_to_string(&p.cache).unwrap();
        let v: serde_json::Value = serde_json::from_str(&file).unwrap();
        assert_eq!(v[hash_message(q)]["kind"], defaults::text("mesh_write.jev_question_kind"));
        assert_eq!(v[hash_message(q)]["urgency"], "urgent");
        assert_eq!(v[hash_message("all green")]["kind"], "fyi");
        assert!(v[hash_message(q)]["_seq"].is_number());
        // the entry has Node's field order, and a labelled text is not queued again
        assert!(file.contains(&format!("\"{}\":{{\"urgency\":\"urgent\",\"kind\":\"question-needs-answer\",\"_seq\":", hash_message(q))), "{file}");
        assert_eq!(enqueue(&h, q, &l), Enqueued::Cached);
        // and the log row carries no body
        let log = std::fs::read_to_string(&p.log).unwrap();
        assert_eq!(log.lines().count(), 2);
        assert!(!log.contains("review the diff") && log.contains(r#""backend":"jev""#) && log.contains(r#""transport":"vercel""#));
    }

    #[test]
    fn nothing_is_written_while_triage_is_off_or_the_text_cannot_be_queued() {
        let off = home(false);
        assert_eq!(enqueue(&off, "hello?", &lim()), Enqueued::Disabled);
        assert!(!paths(&off).cache_dir.exists(), "no write at all while off");
        let s = Stub::default();
        assert_eq!(run_worker(&off, &lim(), &s).ended, Ended::Off);
        let on = home(true);
        let small = Limits { queue_max_bytes: 10, text_max_chars: 5, ..lim() };
        assert_eq!(enqueue(&on, "far too long a body", &small), Enqueued::TooLong);
        assert_eq!(enqueue(&on, "short", &small), Enqueued::Queued);
        assert_eq!(enqueue(&on, "next", &small), Enqueued::Full, "over the queue cap: labelled when a reader asks");
        // jev.json switched triage off while Jev is on
        std::fs::write(on.join(".anti-hall/jev.json"), r#"{"enabled":true,"triage":false}"#).unwrap();
        assert_eq!(enqueue(&on, "again", &lim()), Enqueued::Disabled);
    }

    #[test]
    fn the_batch_and_attempt_caps_bound_a_run() {
        let h = home(true);
        let s = Stub::default();
        for i in 0..5 {
            enqueue(&h, &format!("message {i}"), &lim());
        }
        let capped = Limits { batch_size: 1, max_batches: 2, ..lim() };
        let sum = run_worker(&h, &capped, &s);
        assert_eq!((sum.ended, sum.batches, sum.labelled, sum.skipped), (Ended::Capped, 2, 2, 3));
        assert!(!paths(&h).lock.exists(), "the lock is released at the cap");
        // the budget cuts every call off: each message is tried max_attempts times, then dropped, uncached
        let h2 = home(true);
        let s2 = Stub::default();
        s2.skip.store(true, Ordering::SeqCst);
        enqueue(&h2, "never reached", &lim());
        let sum = run_worker(&h2, &lim(), &s2);
        assert_eq!((sum.ended, sum.skipped, s2.asked()), (Ended::Drained, 1, lim().max_attempts as usize));
        assert!(cache_of(&h2).is_empty(), "an unattempted message earns no permanent no-label verdict");
        // the wall-time cap
        let h3 = home(true);
        struct Slow(Stub);
        impl Labeler for Slow {
            fn label(&self, i: &[(String, String)], b: u64, u: f64) -> Vec<(String, Option<Label>)> {
                std::thread::sleep(std::time::Duration::from_millis(20));
                self.0.label(i, b, u)
            }
        }
        for i in 0..4 {
            enqueue(&h3, &format!("slow {i}"), &lim());
        }
        let sum = run_worker(&h3, &Limits { batch_size: 1, max_wall_ms: 5, ..lim() }, &Slow(Stub::default()));
        assert_eq!(sum.ended, Ended::Capped);
        assert!(sum.batches >= 1 && sum.batches < 4);
    }

    #[test]
    fn an_attempted_message_with_no_confident_label_is_cached_as_a_verdict() {
        let h = home(true);
        let s = Stub::default();
        s.no_label.store(true, Ordering::SeqCst);
        enqueue(&h, "meh", &lim());
        let sum = run_worker(&h, &lim(), &s);
        assert_eq!((sum.no_label, sum.labelled), (1, 0));
        let c = std::fs::read_to_string(paths(&h).cache).unwrap();
        assert!(c.contains(r#""nl":true"#), "{c}");
        // honoured: never asked again
        assert_eq!(enqueue(&h, "meh", &lim()), Enqueued::Cached);
    }

    #[test]
    fn a_second_worker_yields_to_the_drain_lock_and_a_held_claim_skips_the_message() {
        let h = home(true);
        let (l, s) = (lim(), Stub::default());
        enqueue(&h, "wait for me?", &l);
        let p = paths(&h);
        let held = nodelock::acquire(&p.lock.to_string_lossy(), l.drain).expect("take the drain lock");
        let sum = run_worker(&h, &l, &s);
        assert_eq!(sum.ended, Ended::Busy);
        assert!(p.queue.exists() && s.asked() == 0, "the queue is untouched while another worker drains");
        assert!(held.release());
        // another process is labelling this text: the item is skipped, nothing is cached or asked
        std::fs::create_dir_all(&p.claims).unwrap();
        let claim_held = nodelock::acquire(&p.claims.join(hash_message("wait for me?")).to_string_lossy(), l.claim).expect("claim");
        let got = triage_sync(&h, &[Item { key: 0, text: "wait for me?".into() }], &l, &s);
        assert!(got.is_empty() && s.asked() == 0 && cache_of(&h).is_empty());
        assert!(claim_held.release());
        let sum = run_worker(&h, &l, &s);
        assert_eq!((sum.ended, sum.labelled, s.asked()), (Ended::Drained, 1, 1));
    }

    #[test]
    fn a_worker_that_dies_between_the_claim_and_the_write_loses_nothing_and_labels_nothing_twice() {
        let h = home(true);
        let s = Stub::default();
        enqueue(&h, "first?", &lim());
        enqueue(&h, "second", &lim());
        s.panic_once.store(true, Ordering::SeqCst);
        // the first run dies inside the labeller: the lock, the claims and the private copy of the queue stay behind
        let died = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_worker(&h, &lim(), &s)));
        assert!(died.is_err());
        let p = paths(&h);
        assert!(p.lock.exists() && !work_files(&p, &[]).is_empty() && !p.queue.exists() && cache_of(&h).is_empty());
        assert!(has_pending(&h), "the dead worker's copy still counts as work");
        // while the dead worker's lock is fresh, nobody else drains
        assert_eq!(run_worker(&h, &lim(), &s).ended, Ended::Busy);
        // once its lock and claims go stale, the next worker adopts the copy and labels each message exactly once
        std::thread::sleep(std::time::Duration::from_millis(30));
        let stale = |mut p: Params| {
            p.stale_ms = 1;
            p
        };
        let l = Limits { drain: stale(lim().drain), claim: stale(lim().claim), ..lim() };
        let before = s.asked();
        let sum = run_worker(&h, &l, &s);
        assert_eq!((sum.ended, sum.labelled), (Ended::Drained, 2));
        assert_eq!(s.asked() - before, 2, "each message is asked for once after the crash");
        assert_eq!(cache_of(&h).len(), 2);
        assert!(work_files(&p, &[]).is_empty() && !p.lock.exists());
        // nothing left to do, and a rerun asks nothing
        assert!(!has_pending(&h));
        let again = s.asked();
        run_worker(&h, &l, &s);
        assert_eq!(s.asked(), again);
    }

    #[test]
    fn the_cache_stays_bounded_with_a_sequence_that_only_grows() {
        let h = home(true);
        let s = Stub::default();
        let p = paths(&h);
        std::fs::create_dir_all(&p.cache_dir).unwrap();
        // an older cache whose highest _seq is 40: new labels must sort above it, whatever process wrote them
        std::fs::write(&p.cache, r#"{"old":{"kind":"fyi","_seq":40},"other":{"kind":"fyi","_seq":2}}"#).unwrap();
        let l = Limits { cache_max_entries: 3, ..lim() };
        for i in 0..4 {
            enqueue(&h, &format!("msg {i}"), &l);
        }
        run_worker(&h, &l, &s);
        let c = cache_of(&h);
        assert_eq!(c.len(), 3, "bounded");
        let seqs: Vec<f64> = c.iter().map(|(_, v)| seq_of(v)).collect();
        assert!(seqs.iter().all(|q| *q > 2.0), "the lowest _seq went first: {seqs:?}");
        assert!(c.iter().any(|(k, _)| *k == hash_message("msg 3")), "the newest label survives");
        assert!(next_seq(&c) > 40.0);
    }

    #[test]
    fn the_shipped_limits_are_read_from_the_defaults() {
        let l = Limits::shipped();
        assert_eq!(
            (l.queue_max_bytes, l.text_max_chars, l.batch_size, l.max_batches, l.max_wall_ms, l.max_attempts, l.cache_max_entries),
            (262144, 16000, 3, 60, 120000, 3, 500)
        );
        assert_eq!((l.drain.stale_ms, l.claim.stale_ms), (30000, 15000));
        for k in
            ["queued", "disabled", "cached", "full", "too_long", "failed", "drained", "busy", "off", "capped", "lost_lock", "labelled", "no_label", "skipped"]
        {
            assert!(!defaults::raw("jev_arrival.outcomes").str_field(k).is_empty(), "{k}");
        }
        assert!(crate::metrics::is_registered(defaults::text("jev_arrival.metric")));
    }
}
