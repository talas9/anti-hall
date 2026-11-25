//! The confirmed owner-named holds of a session (GH #959): ONE small JSON file per session, task id -> [`Entry`], that the agent
//! tracker and the Stop task-guard both read and write (the Node fallback only reads it), so they cannot disagree about whose a lapsed
//! owner hold is. An entry is tied to the reason it confirmed (a rewritten reason is a new blocker) and is self-bounding: it is good
//! until [`Entry::u`], one `nudges.hold.hold_max_ms` past the confirmation or past the tracker's last owner notice plus
//! `owner_notice_ms`, whichever is later. A session the tracker does not notify (an unwatched kind, reminders off) is therefore asked
//! again every hold_max; nothing is silent for ever. Every write is a read-modify-write under an exclusive lock on a sibling lock file
//! (bounded wait `nudges.hold.lock_wait_ms`); a write that cannot take the lock is skipped and logged (the Stop asks again, the tracker
//! retries next tick).
use super::{lim, pth};
use crate::defaults::{self, V};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// One confirmed owner hold.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    /// [`reason_hash`] of the `blockedOn` reason that was confirmed.
    #[serde(default)]
    pub r: String,
    /// When it was confirmed (asked, by the Stop or the tracker).
    #[serde(default)]
    pub c: u64,
    /// When the tracker last told the owner about it (0 = never).
    #[serde(default)]
    pub n: u64,
    /// Good until (ms): see [`until`].
    #[serde(default)]
    pub u: u64,
}

fn hold(k: &str) -> u64 {
    defaults::raw("nudges.hold").get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}

/// The bound of an entry: one hold_max past the later of its confirmation and its last owner notice's interval.
pub(crate) fn until(c: u64, n: u64) -> u64 {
    let max = hold("hold_max_ms");
    let by_notice = if n > 0 { n + hold("owner_notice_ms") + max } else { 0 };
    (c + max).max(by_notice)
}

/// The hash a confirmation is tied to: SHA-1 hex of the reason with only its outer white space trimmed (the Stop and Node hash the
/// same text the same way).
pub(crate) fn reason_hash(reason: &str) -> String {
    crate::checks::replykit::io::sha1_hex(reason.trim())
}

/// The session's file, relative to the home directory, named by the SHA-1 of the full session id (no cut, no collision).
pub(crate) fn rel(sid: &str) -> String {
    [pth("base"), pth("dir"), pth("owner_holds"), &format!("{}{}", crate::checks::replykit::io::sha1_hex(sid), pth("json_ext"))].join("/")
}

/// The entries of the file; an absent, oversized or unreadable file is empty, and an entry of another shape is left out (unconfirmed).
pub(crate) fn read(home: &Path, sid: &str) -> BTreeMap<String, Entry> {
    let p = home.join(rel(sid));
    if std::fs::metadata(&p).map_or(true, |m| m.len() > lim("state_max_bytes")) {
        return BTreeMap::new();
    }
    let raw: BTreeMap<String, serde_json::Value> = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    raw.into_iter().filter_map(|(k, v)| v.is_object().then(|| serde_json::from_value::<Entry>(v).ok()).flatten().map(|e| (k, e))).collect()
}

/// Whether task `id` with this `reason` is confirmed now: an entry for exactly that reason, still within its bound.
pub(crate) fn confirmed(entries: &BTreeMap<String, Entry>, id: &str, reason: &str, now: u64) -> bool {
    entries.get(id).is_some_and(|e| e.r == reason_hash(reason) && now < e.u)
}

/// Read-modify-write the file under its lock: `f` sees the entries as they are now and edits them; the file is written only when
/// they changed. `false`: the lock was not taken in time or the write failed (logged).
pub(crate) fn update(home: &Path, sid: &str, f: impl FnOnce(&mut BTreeMap<String, Entry>)) -> bool {
    let p = home.join(rel(sid));
    if let Some(d) = p.parent()
        && let Err(e) = std::fs::create_dir_all(d)
    {
        crate::health::log_event("agents", "owner_holds_write", &e.to_string());
        return false;
    }
    let Ok(lock) = std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(crate::paths::lock_for(&p)) else {
        crate::health::log_event("agents", "owner_holds_lock", "open");
        return false;
    };
    let (wait, step) = (hold("lock_wait_ms"), hold("lock_step_ms").max(1));
    let start = std::time::Instant::now();
    while !crate::health::flock(&lock, libc::LOCK_EX | libc::LOCK_NB) {
        if start.elapsed().as_millis() as u64 >= wait {
            crate::health::log_event("agents", "owner_holds_lock", "busy");
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(step));
    }
    let before = read(home, sid);
    let mut after = before.clone();
    f(&mut after);
    let ok = after == before
        || crate::atomic::write(&p, serde_json::to_string(&after).unwrap_or_default())
            .map_err(|e| crate::health::log_event("agents", "owner_holds_write", &e.to_string()))
            .is_ok();
    crate::health::flock(&lock, libc::LOCK_UN);
    ok
}

/// The Stop asked about these lapsed owner holds (task id, its reason) in a delivered block: each is confirmed now (a re-ask restarts
/// the confirmation; a changed reason also forgets the last owner notice).
pub(crate) fn confirm(home: &Path, sid: &str, asked: &[(String, String)], now: u64) -> bool {
    update(home, sid, |m| {
        for (id, reason) in asked {
            let r = reason_hash(reason);
            let n = m.get(id).filter(|e| e.r == r).map_or(0, |e| e.n);
            m.insert(id.clone(), Entry { u: until(now, n), r, c: now, n });
        }
    })
}
