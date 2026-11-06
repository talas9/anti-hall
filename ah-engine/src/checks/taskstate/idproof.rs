//! Where a task id occurs in a whole transcript: the evidence a snapshot ghost is proven by (GH #438 repair).
//!
//! Replayed request rows (`api-request-blob` and kin, see [`super::is_conversation_row`]) carry copies of TaskCreate tool uses, so an
//! older rebuild saved their tool-use ids as tasks. Such an entry is a ghost only on positive proof: its id occurs in replayed rows and
//! in no conversation row at all. This reads facts only; the rule that uses them lives in the plugin's logic.
use std::io::{BufRead, BufReader};

use serde_json::{Value, json};

use crate::defaults;

/// What one id was found in: lines of replayed (non-conversation) rows and lines of conversation rows. A line that cannot be read as a
/// JSON row counts as a conversation line (no proof from text that cannot be understood).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Seen {
    /// Lines of replayed (non-conversation) rows that hold the id.
    pub skipped: u64,
    /// Lines of conversation rows (or text that is not a JSON row) that hold the id.
    pub conversation: u64,
}

/// The text searched for an id: the id itself, or for a non-string-id key the text after the U+0001 marker. `None` when it is shorter
/// than `taskstate.ghost_needle_min_len` (too short to say anything).
fn needle_of(id: &str) -> Option<&str> {
    let n = id.strip_prefix(super::parse::NON_STRING_ID).unwrap_or(id);
    (n.len() as u64 >= defaults::num("taskstate.ghost_needle_min_len")).then_some(n)
}

/// The transcript could not be read in full (or is over the cap): no proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unread;

/// Scans the whole transcript once for `ids`. `Err(Unread)` when the file cannot be read in full or is over `taskstate.ghost_scan_max_bytes`
/// (no proof then). An id with no usable needle is answered as seen nowhere.
pub fn scan_ids(path: &str, ids: &[String]) -> Result<Vec<(String, Seen)>, Unread> {
    let cap = defaults::num("taskstate.ghost_scan_max_bytes");
    let line_cap = defaults::num("taskstate.ghost_line_max_bytes");
    let f = std::fs::File::open(path).map_err(|_| Unread)?;
    let size = f.metadata().map_err(|_| Unread)?.len();
    if size > cap {
        return Err(Unread);
    }
    crate::load::note_scan(size);
    let finders: Vec<Option<memchr::memmem::Finder<'_>>> = ids.iter().map(|id| needle_of(id).map(|n| memchr::memmem::Finder::new(n.as_bytes()))).collect();
    let mut seen = vec![Seen::default(); ids.len()];
    let mut r = BufReader::new(f);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        let n = r.read_until(b'\n', &mut buf).map_err(|_| Unread)?;
        if n == 0 {
            break;
        }
        let hits: Vec<usize> = finders.iter().enumerate().filter(|(_, f)| f.as_ref().is_some_and(|f| f.find(&buf).is_some())).map(|(i, _)| i).collect();
        if hits.is_empty() {
            continue;
        }
        let conversation = if buf.len() as u64 > line_cap {
            true
        } else {
            match serde_json::from_slice::<Value>(&buf) {
                Ok(v) if v.is_object() => super::is_conversation_row(&v),
                _ => true,
            }
        };
        for i in hits {
            if conversation {
                seen[i].conversation += 1;
            } else {
                seen[i].skipped += 1;
            }
        }
    }
    Ok(ids.iter().cloned().zip(seen).collect())
}

/// `{"ids": {id: {"skipped": n, "conversation": n}}}`, or `{"unsure": true}` when the transcript cannot be read in full.
pub fn scan_json(path: &str, ids: &[String]) -> String {
    match scan_ids(path, ids) {
        Err(Unread) => json!({"unsure": true}).to_string(),
        Ok(v) => {
            let mut o = serde_json::Map::new();
            for (id, s) in v {
                o.insert(id, json!({"skipped": s.skipped, "conversation": s.conversation}));
            }
            json!({"ids": o}).to_string()
        }
    }
}
