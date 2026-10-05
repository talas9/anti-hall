//! The incremental transcript reader.
//!
//! One [`Index`] follows one transcript file. A [`Index::refresh`] reads only the bytes appended since the last one,
//! turns each complete line into a [`Record`] and folds it into bounded facts. The first refresh reads the last
//! `transcript.initial_window_bytes` of the file, dropping the possibly-partial first line, which is what
//! `hooks/lib/transcript-tail.js` `readTail` does, so a hook sees the same window it saw before.
//!
//! Crash and rewrite safety: nothing here is the source of truth. The index remembers where it stopped (a byte offset
//! at a line boundary), the file's device and inode, a hash of the file's first bytes and a hash of the bytes just
//! before the offset. If the file got smaller, was replaced, or no longer starts or continues the way it did, the
//! index discards its facts and rebuilds from the file ([`Rebuild`]).
//!
//! A last line without a trailing newline is not consumed: it is parsed on its own into a one-record overlay, so a
//! reader sees it the way `readTail` (which splits on newlines and parses every piece) does, and the next refresh
//! re-reads it once it is complete, so it is never counted twice.
use super::record::{cap_text, parse_line, Assistant, Notification, Prompt, Record, TaskEvent, TaskStatus, ToolUse};
use super::TranscriptError;
use crate::defaults;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::File;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::{Path, PathBuf};

/// Caps of one index; [`Limits::from_defaults`] reads them from `defaults/transcript.toml`.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Bytes read from the end of a file the first time.
    pub initial_window: u64,
    /// Most appended bytes one refresh reads.
    pub max_update: u64,
    /// Leading bytes hashed to notice a rewrite.
    pub fingerprint: usize,
    /// Newest tool uses kept.
    pub recent_tool_uses: usize,
    /// Largest tool input kept.
    pub tool_input_max: usize,
    /// Largest task-tool input kept.
    pub task_input_max: usize,
    /// Longest task-tool result kept.
    pub task_result_max: usize,
    /// Newest task events kept.
    pub task_events: usize,
    /// Newest notifications kept.
    pub notifications: usize,
    /// Newest `task_status` attachments kept.
    pub task_statuses: usize,
    /// Longest assistant text kept.
    pub assistant_text_max: usize,
    /// Longest prompt kept.
    pub prompt_max: usize,
    /// Most distinct kinds counted separately.
    pub max_kinds: usize,
}

impl Limits {
    /// The shipped limits.
    pub fn from_defaults() -> Limits {
        Limits {
            initial_window: defaults::num("transcript.initial_window_bytes"),
            max_update: defaults::num("transcript.max_update_bytes"),
            fingerprint: defaults::num("transcript.fingerprint_bytes") as usize,
            recent_tool_uses: defaults::num("transcript.recent_tool_uses") as usize,
            tool_input_max: defaults::num("transcript.tool_input_max_bytes") as usize,
            task_input_max: defaults::num("transcript.task_input_max_bytes") as usize,
            task_result_max: defaults::num("transcript.task_result_max_bytes") as usize,
            task_events: defaults::num("transcript.task_events") as usize,
            notifications: defaults::num("transcript.notifications_kept") as usize,
            task_statuses: defaults::num("transcript.task_statuses_kept") as usize,
            assistant_text_max: defaults::num("transcript.assistant_text_max_bytes") as usize,
            prompt_max: defaults::num("transcript.prompt_max_bytes") as usize,
            max_kinds: defaults::num("transcript.max_kinds") as usize,
        }
    }
}

/// Why an index threw its facts away and read the file again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rebuild {
    /// The file is smaller than where the index had read to.
    Truncated,
    /// A different file now sits at the path (device or inode changed).
    Rotated,
    /// The file no longer starts, or no longer continues at the offset, the way it did.
    Rewritten,
}

/// What a refresh found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refresh {
    /// Nothing was appended.
    Unchanged,
    /// New bytes were read.
    Appended {
        /// Bytes read.
        bytes: u64,
        /// Complete records they held.
        records: u64,
    },
    /// The facts were discarded and rebuilt from the file.
    Rebuilt(Rebuild),
    /// The file is missing or empty (its facts, if any, were dropped).
    Missing,
}

/// Facts folded from records: the committed part of an index, and the one-record overlay for a final unterminated
/// line.
#[derive(Debug, Default, Clone)]
struct Acc {
    records: u64,
    kinds: BTreeMap<String, u64>,
    sidechain: u64,
    meta: u64,
    compact_summary: u64,
    compact_boundaries: u64,
    last_compact_boundary: Option<u64>,
    assistant: Option<Assistant>,
    assistant_legacy: Option<Assistant>,
    prompt: Option<Prompt>,
    tool_uses: VecDeque<ToolUse>,
    task_events: VecDeque<TaskEvent>,
    task_ids: HashMap<String, String>,
    notifications: VecDeque<Notification>,
    task_statuses: VecDeque<TaskStatus>,
}

fn push_capped<T>(q: &mut VecDeque<T>, v: T, cap: usize) {
    q.push_back(v);
    while q.len() > cap {
        q.pop_front();
    }
}

impl Acc {
    /// Fold one record in. `outer_ids` lets the overlay resolve the tool-use ids the committed part already knows.
    fn ingest(&mut self, rec: Record, seq: u64, lim: &Limits, outer_ids: Option<&HashMap<String, String>>) {
        self.records += 1;
        let overflow = defaults::text("transcript.overflow_kind");
        let kind = if self.kinds.contains_key(&rec.kind) || self.kinds.len() < lim.max_kinds { rec.kind.clone() } else { overflow.to_string() };
        *self.kinds.entry(kind).or_insert(0) += 1;
        self.sidechain += u64::from(rec.sidechain);
        self.meta += u64::from(rec.meta);
        self.compact_summary += u64::from(rec.compact_summary);
        if rec.compact_boundary {
            self.compact_boundaries += 1;
            self.last_compact_boundary = Some(seq);
        }
        let keep = |text: Option<String>| -> Option<Assistant> {
            let mut text = text?;
            let truncated = cap_text(&mut text, lim.assistant_text_max);
            Some(Assistant { text, sidechain: rec.sidechain, seq, ts_ms: rec.ts_ms, truncated })
        };
        if let Some(a) = keep(rec.assistant_dedup) {
            self.assistant = Some(a);
        }
        if let Some(a) = keep(rec.assistant_legacy) {
            self.assistant_legacy = Some(a);
        }
        if let Some(mut text) = rec.prompt {
            let truncated = cap_text(&mut text, lim.prompt_max);
            self.prompt = Some(Prompt { text, seq, truncated });
        }
        let task_tools = defaults::list("transcript.task_tools");
        for tu in rec.tool_uses {
            if task_tools.contains(&tu.name.as_str()) {
                if let Some(id) = &tu.id {
                    self.task_ids.insert(id.clone(), tu.name.clone());
                }
                push_capped(&mut self.task_events, TaskEvent::Use(tu.clone()), lim.task_events);
            }
            push_capped(&mut self.tool_uses, tu, lim.recent_tool_uses);
        }
        for (id, mut text) in rec.tool_results {
            if self.task_ids.contains_key(&id) || outer_ids.is_some_and(|m| m.contains_key(&id)) {
                let truncated = cap_text(&mut text, lim.task_result_max);
                push_capped(&mut self.task_events, TaskEvent::Result { tool_use_id: id, text, truncated, seq }, lim.task_events);
            }
        }
        for n in rec.notifications {
            push_capped(&mut self.notifications, n, lim.notifications);
        }
        if let Some(t) = rec.task_status {
            push_capped(&mut self.task_statuses, t, lim.task_statuses);
        }
        // the ids of evicted task events are forgotten with them, so the map stays bounded by the same cap
        if self.task_ids.len() > lim.task_events {
            let live: std::collections::HashSet<&str> =
                self.task_events.iter().filter_map(|e| if let TaskEvent::Use(u) = e { u.id.as_deref() } else { None }).collect();
            self.task_ids.retain(|k, _| live.contains(k.as_str()));
        }
    }
}

/// FNV-1a over bytes: a cheap change detector, not a security hash.
fn fnv(b: &[u8]) -> u64 {
    b.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, x| (h ^ u64::from(*x)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// Bytes hashed just before the offset to notice an in-place rewrite that keeps the file's start (a structural
/// constant of the change detector, not a tunable).
fn tail_probe_len() -> u64 {
    64
}

/// Follows one transcript file and answers questions about it.
#[derive(Debug)]
pub struct Index {
    path: PathBuf,
    lim: Limits,
    id: Option<(u64, u64)>,
    started: bool,
    /// Byte offset just after the last complete line folded in.
    offset: u64,
    /// The bytes from `offset` are the middle of a line (a window started inside one); drop through the next newline.
    resync: bool,
    /// Bytes after `offset` that the overlay was parsed from (an unterminated last line).
    pending_len: u64,
    head: Option<(usize, u64)>,
    tail: Option<(u64, u64)>,
    generation: u64,
    gaps: u64,
    gap_bytes: u64,
    committed: Acc,
    pending: Acc,
}

impl Index {
    /// An index of `path` with the shipped limits. Nothing is read until [`Index::refresh`].
    pub fn new(path: impl Into<PathBuf>) -> Index {
        Index::with_limits(path, Limits::from_defaults())
    }

    /// An index with explicit limits (tests use small ones).
    pub fn with_limits(path: impl Into<PathBuf>, lim: Limits) -> Index {
        Index {
            path: path.into(),
            lim,
            id: None,
            started: false,
            offset: 0,
            resync: false,
            pending_len: 0,
            head: None,
            tail: None,
            generation: 0,
            gaps: 0,
            gap_bytes: 0,
            committed: Acc::default(),
            pending: Acc::default(),
        }
    }

    fn reset(&mut self) {
        let (path, lim, generation, gaps, gap_bytes) = (self.path.clone(), self.lim.clone(), self.generation, self.gaps, self.gap_bytes);
        *self = Index::with_limits(path, lim);
        self.generation = generation;
        self.gaps = gaps;
        self.gap_bytes = gap_bytes;
    }

    fn io(&self, source: std::io::Error) -> TranscriptError {
        TranscriptError::Io { path: self.path.clone(), source }
    }

    /// Bring the index up to date with the file, reading only what was appended since the last call.
    pub fn refresh(&mut self) -> Result<Refresh, TranscriptError> {
        let file = match File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(self.missing()),
            Err(e) => return Err(self.io(e)),
        };
        let meta = file.metadata().map_err(|e| self.io(e))?;
        let size = meta.len();
        if size == 0 {
            return Ok(self.missing());
        }
        let mut rebuilt: Option<Rebuild> = None;
        if self.started {
            let read_to = self.offset + self.pending_len;
            if self.id.is_some_and(|i| i != (meta.dev(), meta.ino())) {
                rebuilt = Some(Rebuild::Rotated);
            } else if size < read_to {
                rebuilt = Some(Rebuild::Truncated);
            } else if !self.prefix_intact(&file, size).map_err(|e| self.io(e))? {
                rebuilt = Some(Rebuild::Rewritten);
            }
            if rebuilt.is_some() {
                self.reset();
            }
        }
        if self.started && rebuilt.is_none() && size == self.offset + self.pending_len {
            return Ok(Refresh::Unchanged);
        }
        let (start, windowed) = if !self.started {
            let s = size.saturating_sub(self.lim.initial_window);
            (s, s > 0)
        } else if size - self.offset > self.lim.max_update {
            self.gaps += 1;
            self.gap_bytes += size - self.offset - self.lim.max_update;
            (size - self.lim.max_update, true)
        } else {
            (self.offset, false)
        };
        if windowed {
            // a window starts inside a line (or at a boundary it cannot know about): drop the first piece, as readTail does
            self.committed = Acc { records: 0, ..Acc::default() };
            self.resync = true;
            self.pending = Acc::default();
        }
        let mut buf = vec![0u8; (size - start) as usize];
        let mut got = 0usize;
        while got < buf.len() {
            let n = file.read_at(&mut buf[got..], start + got as u64).map_err(|e| self.io(e))?;
            if n == 0 {
                break;
            }
            got += n;
        }
        buf.truncate(got);
        let (mut from, mut base) = (0usize, start);
        if self.resync || windowed {
            match buf.iter().position(|b| *b == b'\n') {
                Some(p) => {
                    from = p + 1;
                    base = start + from as u64;
                    self.resync = false;
                }
                None => {
                    // still inside the first line: nothing to fold, and the offset stays at the window start
                    self.offset = start;
                    self.resync = true;
                    self.pending_len = 0;
                    self.pending = Acc::default();
                    self.finish(&file, size).map_err(|e| self.io(e))?;
                    return Ok(self.outcome(rebuilt, got as u64, 0));
                }
            }
        }
        if !self.started {
            self.generation += 1;
        }
        self.started = true;
        self.id = Some((meta.dev(), meta.ino()));
        let mut records = 0u64;
        let mut consumed = from;
        let data = &buf[from..];
        let mut line_start = 0usize;
        while let Some(rel) = data[line_start..].iter().position(|b| *b == b'\n') {
            let end = line_start + rel;
            let line = String::from_utf8_lossy(&data[line_start..end]);
            if !super::record::js_trim(&line).is_empty() {
                self.fold(&line);
                records += 1;
            }
            line_start = end + 1;
            consumed = from + line_start;
        }
        self.offset = base + (consumed - from) as u64;
        let rest = &buf[consumed..];
        self.pending = Acc::default();
        self.pending_len = rest.len() as u64;
        if !rest.is_empty() {
            let line = String::from_utf8_lossy(rest);
            if !super::record::js_trim(&line).is_empty() {
                let seq = self.committed.records + 1;
                let rec = parse_line(&line, seq, self.lim.tool_input_max, self.lim.task_input_max);
                // a line that does not parse is most likely half written: it is not a record until it is complete
                if rec.kind != defaults::text("transcript.malformed_kind") {
                    self.pending.ingest(rec, seq, &self.lim, Some(&self.committed.task_ids));
                }
            }
        }
        self.finish(&file, size).map_err(|e| self.io(e))?;
        Ok(self.outcome(rebuilt, got as u64, records))
    }

    fn outcome(&self, rebuilt: Option<Rebuild>, bytes: u64, records: u64) -> Refresh {
        match rebuilt {
            Some(r) => Refresh::Rebuilt(r),
            None => Refresh::Appended { bytes, records },
        }
    }

    fn missing(&mut self) -> Refresh {
        if self.started || self.offset > 0 {
            self.reset();
        }
        Refresh::Missing
    }

    fn fold(&mut self, line: &str) {
        let seq = self.committed.records + 1;
        let rec = parse_line(line, seq, self.lim.tool_input_max, self.lim.task_input_max);
        self.committed.ingest(rec, seq, &self.lim, None);
    }

    /// True when the file still begins and continues at the offset the way it did when the index read it.
    fn prefix_intact(&self, file: &File, size: u64) -> std::io::Result<bool> {
        if let Some((len, h)) = self.head {
            if size < len as u64 {
                return Ok(false);
            }
            let mut b = vec![0u8; len];
            file.read_exact_at(&mut b, 0)?;
            if fnv(&b) != h {
                return Ok(false);
            }
        }
        if let Some((len, h)) = self.tail {
            let mut b = vec![0u8; len as usize];
            file.read_exact_at(&mut b, self.offset - len)?;
            if fnv(&b) != h {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Record the change detectors for the state just reached.
    fn finish(&mut self, file: &File, size: u64) -> std::io::Result<()> {
        let want = (self.lim.fingerprint as u64).min(size) as usize;
        if self.head.is_none_or(|(len, _)| len < want) {
            let mut b = vec![0u8; want];
            file.read_exact_at(&mut b, 0)?;
            self.head = Some((want, fnv(&b)));
        }
        let len = tail_probe_len().min(self.offset);
        self.tail = if len == 0 {
            None
        } else {
            let mut b = vec![0u8; len as usize];
            file.read_exact_at(&mut b, self.offset - len)?;
            Some((len, fnv(&b)))
        };
        Ok(())
    }

    // ---- facts ----------------------------------------------------------------------------------------------

    /// The path being followed.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Byte offset just after the last complete line folded in.
    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// How many times the facts were built from the file: 1 after the first read, one more for each rebuild.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// How many times more than `transcript.max_update_bytes` was appended between refreshes (the index skipped ahead).
    pub fn gaps(&self) -> u64 {
        self.gaps
    }

    /// Bytes skipped by those gaps.
    pub fn gap_bytes(&self) -> u64 {
        self.gap_bytes
    }

    /// Records folded in, counting the overlay (non-empty lines, malformed ones included).
    pub fn records(&self) -> u64 {
        self.committed.records + self.pending.records
    }

    /// Records per kind (the `type` field, `malformed` for a line that is not a JSON object, `other` for the rest).
    pub fn kind_counts(&self) -> BTreeMap<String, u64> {
        let mut m = self.committed.kinds.clone();
        for (k, v) in &self.pending.kinds {
            *m.entry(k.clone()).or_insert(0) += v;
        }
        m
    }

    /// Entries with `isSidechain: true`.
    pub fn sidechain_rows(&self) -> u64 {
        self.committed.sidechain + self.pending.sidechain
    }

    /// Entries with a truthy `isMeta`.
    pub fn meta_rows(&self) -> u64 {
        self.committed.meta + self.pending.meta
    }

    /// Entries with a truthy `isCompactSummary`.
    pub fn compact_summary_rows(&self) -> u64 {
        self.committed.compact_summary + self.pending.compact_summary
    }

    /// `system` entries with subtype `compact_boundary`.
    pub fn compact_boundaries(&self) -> u64 {
        self.committed.compact_boundaries + self.pending.compact_boundaries
    }

    /// Record number of the newest compaction boundary.
    pub fn last_compact_boundary(&self) -> Option<u64> {
        self.pending.last_compact_boundary.or(self.committed.last_compact_boundary)
    }

    /// The newest assistant reply, extracted without repeating text (`collectTextFromEntryDedup`).
    pub fn last_assistant(&self) -> Option<&Assistant> {
        self.pending.assistant.as_ref().or(self.committed.assistant.as_ref())
    }

    /// The newest assistant reply as the legacy extraction returns it (`collectTextFromEntryLegacy`).
    pub fn last_assistant_legacy(&self) -> Option<&Assistant> {
        self.pending.assistant_legacy.as_ref().or(self.committed.assistant_legacy.as_ref())
    }

    /// The newest typed user prompt (`lastUserPrompt`).
    pub fn last_prompt(&self) -> Option<&Prompt> {
        self.pending.prompt.as_ref().or(self.committed.prompt.as_ref())
    }

    /// The newest `n` tool uses of any tool, oldest first.
    pub fn recent_tool_uses(&self, n: usize) -> Vec<&ToolUse> {
        let all: Vec<&ToolUse> = self.committed.tool_uses.iter().chain(self.pending.tool_uses.iter()).collect();
        all[all.len().saturating_sub(n)..].to_vec()
    }

    /// The task-tool uses and results kept, oldest first.
    pub fn task_events(&self) -> Vec<&TaskEvent> {
        self.committed.task_events.iter().chain(self.pending.task_events.iter()).collect()
    }

    /// The task-notification blocks kept, oldest first.
    pub fn notifications(&self) -> Vec<&Notification> {
        self.committed.notifications.iter().chain(self.pending.notifications.iter()).collect()
    }

    /// The `task_status` attachments kept, oldest first.
    pub fn task_statuses(&self) -> Vec<&TaskStatus> {
        self.committed.task_statuses.iter().chain(self.pending.task_statuses.iter()).collect()
    }

    /// Agent ids `hooks/lib/agent-scan.js` would mark terminal from the notifications kept.
    pub fn terminal_agents(&self) -> Vec<&str> {
        self.notifications().into_iter().filter_map(Notification::terminal_agent).collect()
    }

    /// Keys `companion/lib/devswarm-idle.js` `finishedTaskKeys` would return for the notifications kept.
    pub fn finished_task_keys(&self) -> Vec<&str> {
        self.notifications().into_iter().flat_map(Notification::finished_keys).collect()
    }
}

impl Index {
    /// The facts the parity harness compares with the Node readers, as JSON (`parity/transcript-facts.js` prints the
    /// same shape): record count, counts by kind, both last-assistant texts, the last prompt, the agent ids and
    /// notification keys the two Node readers derive, and every kept tool use as `[id, name]`.
    pub fn facts_json(&self) -> serde_json::Value {
        use serde_json::json;
        let mut terminal: Vec<&str> = self.terminal_agents();
        terminal.sort_unstable();
        terminal.dedup();
        json!({
            "records": self.records(),
            "kinds": self.kind_counts(),
            "last_assistant": self.last_assistant().map(|a| a.text.as_str()),
            "last_assistant_legacy": self.last_assistant_legacy().map(|a| a.text.as_str()),
            "last_prompt": self.last_prompt().map(|p| p.text.as_str()).filter(|t| !t.is_empty()),
            "terminal": terminal,
            "finished_keys": self.finished_task_keys(),
            "tool_uses": self.recent_tool_uses(usize::MAX).iter().map(|u| json!([u.id, u.name])).collect::<Vec<_>>(),
        })
    }
}
