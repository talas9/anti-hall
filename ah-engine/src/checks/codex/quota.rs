//! The Codex quota record of `hooks/lib/codex-quota.js`, layered onto `~/.anti-hall/codex-availability.json`.
//!
//! One file holds two things: the PATH-probe facts `codex-availability` writes and a `quota` outage record the quota
//! detection writes. Every write merges into what the file already holds and keeps its key order, as the Node module does.
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::{collapse_ws, js_trim};
use crate::checks::jsport::date::{self, Parsed};
use crate::checks::jsport::json::{self, Fail, J};
use crate::checks::jsport::text::slice16_lossy;
use crate::checks::jsport::{fsx, text as jstext};
use crate::defaults;
use regex::Regex;
use std::sync::OnceLock;

/// What the port cannot decide exactly; the check then answers "defer" and Node decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsure;

/// A recorded outage that has not expired.
#[derive(Debug, Clone, PartialEq)]
pub struct Quota {
    /// Epoch milliseconds the outage lasts until.
    pub until: f64,
    /// The recorded reason.
    pub reason: String,
}

/// A quota message found in some text.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    /// The matched text and what follows, cleaned up.
    pub reason: String,
    /// When the message says Codex is back, if it says and the date parses.
    pub until: Option<f64>,
}

/// `<home>/.anti-hall/codex-availability.json`.
pub fn state_path(home: &str) -> String {
    format!("{home}/{}", defaults::text("codex_handover.availability_file"))
}

/// `readRaw`: the file as an object, `{}` when it is missing, unreadable, not JSON or not an object.
pub fn read_raw(home: &str) -> Result<J, Unsure> {
    let empty = J::Obj(Vec::new());
    let Some(text) = fsx::read_utf8(&state_path(home)) else { return Ok(empty) };
    match json::parse(&text, defaults::num("codex_handover.json_max_depth") as usize) {
        Ok(v @ J::Obj(_)) => Ok(v),
        Ok(_) | Err(Fail::Invalid) => Ok(empty),
        Err(Fail::Unsupported) => Err(Unsure),
    }
}

/// `readQuota`: the live outage record, if any. An expired or malformed record reads as none.
pub fn read_quota(home: &str, now: f64) -> Result<Option<Quota>, Unsure> {
    let raw = read_raw(home)?;
    let Some(q) = raw.get("quota") else { return Ok(None) };
    let until = match q.get("until") {
        Some(J::Num(n)) if n.is_finite() => *n,
        _ => return Ok(None),
    };
    if until <= now {
        return Ok(None);
    }
    let reason = match q.get("reason") {
        Some(J::Str(s)) => s.clone(),
        _ => defaults::text("codex_handover.quota_default_reason").to_string(),
    };
    Ok(Some(Quota { until, reason }))
}

/// `writeMerged`: merge `patch` into the file (replacing a key in place, appending a new one) and write it atomically.
/// `Ok(false)` when the write failed, which the Node module also swallows.
pub fn write_merged(home: &str, patch: &[(&str, J)]) -> Result<bool, Unsure> {
    let p = state_path(home);
    let dir = crate::checks::git::util::posix_dirname(&p);
    let mut merged = read_raw_for_write(home)?;
    if !fsx::mkdir_p(&dir) {
        return Ok(false);
    }
    for (k, v) in patch {
        merged.set(k, v.clone());
    }
    let tmp = format!("{p}.{}.{:08x}.tmp", std::process::id(), tmp_nonce());
    Ok(std::fs::write(&tmp, json::stringify(&merged)).is_ok() && std::fs::rename(&tmp, &p).is_ok())
}

/// The existing file for a merge: `Object.assign` would invoke the `__proto__` setter for such a key, which this port
/// does not reproduce.
pub fn read_raw_for_write(home: &str) -> Result<J, Unsure> {
    let raw = read_raw(home)?;
    if raw.get(defaults::text("codex_handover.proto_key")).is_some() {
        return Err(Unsure);
    }
    Ok(raw)
}

fn tmp_nonce() -> u32 {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    t ^ std::process::id().rotate_left(16)
}

/// `recordQuota`: record an outage lasting until `until` (epoch ms, or `None`/unparseable for the default cooldown).
pub fn record_quota(home: &str, until: Option<f64>, reason: &str, now: f64) -> Result<bool, Unsure> {
    let cooldown = defaults::num("codex_handover.default_cooldown_ms") as f64;
    let until = match until {
        Some(u) if u.is_finite() && u > now => u,
        _ => now + cooldown,
    };
    let r = js_trim(reason);
    let reason = if r.is_empty() {
        defaults::text("codex_handover.quota_default_reason").to_string()
    } else {
        slice16_lossy(r, defaults::num("codex_handover.quota_reason_max") as usize)
    };
    let q = J::Obj(vec![
        ("available".into(), J::Bool(false)),
        ("until".into(), J::Num(until)),
        ("reason".into(), J::Str(reason)),
        ("recordedAt".into(), J::Num(now)),
    ]);
    write_merged(home, &[("quota", q)])
}

fn re_quota() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| jsre::compile(defaults::text("codex_handover.quota_re"), true))
}
fn re_try_again() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| jsre::compile(defaults::text("codex_handover.try_again_re"), true))
}
fn re_until() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| jsre::compile(defaults::text("codex_handover.until_re"), true))
}
fn re_ordinal() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| jsre::compile(defaults::text("codex_handover.ordinal_re"), true))
}

/// True when `text` mentions none of the words a quota message needs, so no match is possible whatever else it says.
pub fn cannot_match(text: &str) -> bool {
    let l = text.to_ascii_lowercase();
    !defaults::list("codex_handover.quota_target_words").iter().any(|w| l.contains(w))
}

/// `parseWhen`: strip ordinals and trailing punctuation, then parse the longest word prefix that is a date.
fn parse_when(s: &str) -> Result<Option<f64>, Unsure> {
    let stripped = re_ordinal().replace_all(s, "${1}");
    let trimmed = stripped.trim_end_matches(|c: char| matches!(c, '.' | ',' | ';') || crate::checks::guardkit::text::is_js_space(c));
    let mut words: Vec<&str> = split_ws(trimmed);
    while !words.is_empty() {
        match date::parse(&words.join(" ")) {
            Parsed::Ms(t) => return Ok(Some(t)),
            Parsed::Nan => {}
            Parsed::Unknown => return Err(Unsure),
        }
        words.pop();
    }
    Ok(None)
}

/// `s.split(/\s+/)`: runs of JavaScript white space separate; a leading or trailing run leaves an empty piece.
fn split_ws(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut in_run = false;
    for (i, c) in s.char_indices() {
        let w = crate::checks::guardkit::text::is_js_space(c);
        if w && !in_run {
            out.push(&s[start..i]);
            in_run = true;
        } else if !w && in_run {
            in_run = false;
            start = i;
        }
    }
    if in_run {
        out.push("")
    } else {
        out.push(&s[start..])
    }
    out
}

/// `detectQuotaMessage(text)`.
pub fn detect(text: &str) -> Result<Option<Hit>, Unsure> {
    if text.is_empty() || cannot_match(text) {
        return Ok(None);
    }
    if text.chars().any(|c| c as u32 > 0xFFFF) {
        return Err(Unsure); // the regex limits count UTF-16 units; this port counts characters
    }
    let Some(m) = re_quota().find(text) else { return Ok(None) };
    let from = &text[m.start()..];
    let cut = jstext::len16(from).min(defaults::num("codex_handover.quota_reason_chars") as usize);
    let head = slice16_lossy(from, cut);
    let reason = js_trim(&collapse_ws(&head)).to_string();
    let mut until: Option<f64> = None;
    if let Some(c) = re_try_again().captures(from) {
        until = parse_when(&c[1])?;
    }
    if until.is_none()
        && let Some(c) = re_until().captures(from)
    {
        match date::parse(js_trim(&c[1])) {
            Parsed::Ms(t) => until = Some(t),
            Parsed::Nan => {}
            Parsed::Unknown => return Err(Unsure),
        }
    }
    Ok(Some(Hit { reason, until }))
}

/// The modification time of an entry and its path, for the newest-first scans.
struct Entry {
    full: String,
    mtime: f64,
}

fn newest(dir: &str, filter: &dyn Fn(&str) -> bool, limit: usize, min_mtime: f64) -> Option<Vec<Entry>> {
    let mut out: Vec<Entry> = Vec::new();
    for (name, _) in fsx::read_dir_names(dir)? {
        if !filter(&name) {
            continue;
        }
        let full = format!("{dir}/{name}");
        if let Ok(md) = std::fs::metadata(&full) {
            let m = fsx::mtime_ms(&md);
            if m >= min_mtime {
                out.push(Entry { full, mtime: m });
            }
        }
    }
    out.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(limit);
    Some(out)
}

/// `scanJobLogs`: fold a usage-limit error found in a background Codex job log into the quota record.
pub fn scan_job_logs(home: &str, now: f64) -> Result<(), Unsure> {
    let root = format!("{home}/{}", defaults::text("codex_handover.job_state_dir"));
    let (max_dirs, max_files) = (defaults::num("codex_handover.job_max_dirs") as usize, defaults::num("codex_handover.job_max_files") as usize);
    let min_mtime = now - defaults::num("codex_handover.job_max_age_ms") as f64;
    let Some(repos) = newest(&root, &|_| true, max_dirs, min_mtime) else { return Ok(()) };
    let suffix = defaults::text("codex_handover.job_log_suffix");
    let mut logs: Vec<Entry> = Vec::new();
    for repo in repos {
        let jobs = format!("{}/{}", repo.full, defaults::text("codex_handover.job_logs_dir"));
        if let Some(mut l) = newest(&jobs, &|n| n.ends_with(suffix), max_files, min_mtime) {
            logs.append(&mut l);
        }
    }
    logs.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap_or(std::cmp::Ordering::Equal));
    for log in logs.into_iter().take(max_files) {
        let Some(text) = read_tail(&log.full, defaults::num("codex_handover.job_tail_bytes")) else { continue };
        let Some(hit) = detect(&text)? else { continue };
        let until = hit.until.unwrap_or(log.mtime + defaults::num("codex_handover.default_cooldown_ms") as f64);
        if until <= now {
            continue;
        }
        let cur = read_quota(home, now)?;
        if !cur.is_some_and(|c| c.until >= until) {
            record_quota(home, Some(until), &hit.reason, now)?;
        }
        return Ok(());
    }
    Ok(())
}

fn read_tail(path: &str, n: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let len = size.min(n);
    f.seek(SeekFrom::Start(size - len)).ok()?;
    let mut buf = vec![0u8; len as usize];
    f.read_exact(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}
