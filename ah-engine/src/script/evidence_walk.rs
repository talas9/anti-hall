//! The evidence walk of a Stop check (issue #22): `ah.transcript.evidenceWalk` does inside the engine what a script used to do
//! with the whole window in QuickJS (parse the items, merge the assistant text of one message, join the evidence, skip the replies
//! the payload already holds), and hands the script only the small facts it decides on. The two big strings (the evidence, and the
//! evidence with the last reply) stay here, in a kept [`Walk`] the script asks questions of: `walkHas` (is this token in it) and
//! `walkNumbers` (the sorted numbers it spells). The items come from the same kept lines `ah.transcript.evidence` reads
//! ([`super::evidence_cache`]), so a Stop that follows the last one reads only the bytes appended since.
//!
//! The walk is the one the claim ledger's script wrote (`engine/logic/claim-ledger.js`, `clWalk`), kept exactly:
//! * `p` (a prompt) restarts the tool count of the turn; `i` (a tool call's input) counts one; `p`/`r`/`a`/`i` texts go into the evidence;
//! * `t` items of one message id (consecutive, id not null) are one reply (joined with `\n`; the tool count is the one of its last piece);
//!   a reply that the next `t` of another id (or no id) closes goes into the evidence unless, with a payload, its collapsed text is
//!   non-empty and sits inside the collapsed payload ([`collapse`]: NFC, every JS white-space run one space, trimmed);
//! * the evidence is the texts joined with `\n`; with a last reply the evidence-with-last is `evidence + "\n" + reply`, without one
//!   (a walk with a payload only) it is the evidence.
//!
//! A kept walk is one entry of a [`BoundedCache`] on the memory registry (`mem.evidence_walk_*`, `transcript.evidence_walk_*`),
//! named by a handle the walking thread remembers; a thread's next walk replaces its previous one, and an entry unused for
//! `transcript.evidence_walk_idle_ms` goes. A question about a walk that is gone throws, so the check fails open.
use super::evidence_cache::{Line, with_window};
use super::host_ts::{Item, unsure, window_bytes};
use crate::checks::guardkit::text::{collapse_ws, js_trim};
use crate::defaults;
use crate::mem::{BoundedCache, Spec};
use rquickjs::{Ctx, Function, Object};
use serde_json::json;
use std::cell::RefCell;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use unicode_normalization::UnicodeNormalization;

/// What a finished walk keeps: the evidence-with-last text, of which the evidence is the first `ev_len` bytes (so the two are one
/// string, not two), and the lengths a JavaScript `.length` would report.
struct Walk {
    text: String,
    ev_len: usize,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

thread_local! {
    /// The walk this thread made last, with its handle in the cache (none: no walk); the questions are about that one. The
    /// thread holds the walk itself, so a cache eviction between the walk and its questions cannot lose it (the cache only
    /// accounts for the bytes); at most one walk per worker thread stays alive, until that thread walks again.
    static MINE: RefCell<Option<(u64, Arc<Walk>)>> = const { RefCell::new(None) };
}

fn cache() -> &'static BoundedCache<u64, Arc<Walk>> {
    static CACHE: OnceLock<BoundedCache<u64, Arc<Walk>>> = OnceLock::new();
    CACHE.get_or_init(|| {
        BoundedCache::new(
            crate::mem::global(),
            Spec::new("evidence_walk", "mem.evidence_walk_soft_bytes", "mem.evidence_walk_hard_bytes", "mem.evidence_walk_low_water_pct")
                .with_entries("transcript.evidence_walk_max_entries"),
        )
    })
}

/// (entries kept, their estimated bytes) for the memory snapshot.
pub fn usage() -> (usize, u64) {
    let c = cache();
    (c.len(), c.bytes() as u64)
}

/// `clCollapse`: `s.normalize('NFC').replace(/\s+/g, ' ').trim()`.
pub(super) fn collapse(s: &str) -> String {
    let nfc: String = s.nfc().collect();
    js_trim(&collapse_ws(&nfc)).to_string()
}

/// UTF-16 length of `s`: what `s.length` is in JavaScript.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The reply being built: the merged `t` items of one message.
struct Last<'a> {
    id: Option<&'a str>,
    text: String,
    tools: usize,
    /// The tool calls since the last OWNER prompt (a notification or injected record does not start a new turn).
    owner_tools: usize,
}

/// The evidence being joined with `\n`.
struct Ev {
    s: String,
    parts: usize,
}

impl Ev {
    fn push(&mut self, text: &str) {
        if self.parts > 0 {
            self.s.push('\n');
        }
        self.s.push_str(text);
        self.parts += 1;
    }

    /// A finished reply: kept unless the payload (collapsed) already holds its collapsed text.
    fn push_reply(&mut self, text: &str, payload_norm: Option<&str>) {
        if let Some(p) = payload_norm {
            let n = collapse(text);
            if !n.is_empty() && p.contains(n.as_str()) {
                return;
            }
        }
        self.push(text);
    }
}

/// The result of walking `lines`.
struct Walked {
    walk: Walk,
    last_text: String,
    tools_this_turn: usize,
    tools_at_end: usize,
    owner_tools_this_turn: usize,
    owner_tools_at_end: usize,
}

/// `clWalk` over the items of `lines`; `None` when it has no reply and no payload to stand in for one.
fn walk_lines(lines: &[&Line], payload: Option<&str>) -> Option<Walked> {
    let payload_norm = payload.map(collapse);
    let pn = payload_norm.as_deref();
    let mut ev = Ev { s: String::new(), parts: 0 };
    let mut tools = 0usize;
    let mut owner_tools = 0usize;
    let mut last: Option<Last> = None;
    for l in lines {
        for Item { kind, text, id, cont } in &l.items {
            match kind {
                'p' => {
                    tools = 0;
                    if !*cont {
                        owner_tools = 0;
                    }
                    ev.push(text);
                }
                'r' | 'a' => ev.push(text),
                'i' => {
                    tools += 1;
                    owner_tools += 1;
                    ev.push(text);
                }
                't' => match last.as_mut() {
                    Some(cur) if id.is_some() && cur.id == id.as_deref() => {
                        cur.text.push('\n');
                        cur.text.push_str(text);
                        cur.tools = tools;
                        cur.owner_tools = owner_tools;
                    }
                    _ => {
                        if let Some(done) = last.take() {
                            ev.push_reply(&done.text, pn);
                        }
                        last = Some(Last { id: id.as_deref(), text: text.clone(), tools, owner_tools });
                    }
                },
                _ => {}
            }
        }
    }
    match last {
        None => {
            payload?;
            let ev_len = ev.s.len();
            Some(Walked {
                walk: Walk { text: ev.s, ev_len },
                last_text: String::new(),
                tools_this_turn: tools,
                tools_at_end: tools,
                owner_tools_this_turn: owner_tools,
                owner_tools_at_end: owner_tools,
            })
        }
        Some(l) => {
            let mut text = ev.s;
            let ev_len = text.len();
            text.push('\n');
            text.push_str(&l.text);
            Some(Walked {
                walk: Walk { text, ev_len },
                last_text: l.text,
                tools_this_turn: l.tools,
                tools_at_end: tools,
                owner_tools_this_turn: l.owner_tools,
                owner_tools_at_end: owner_tools,
            })
        }
    }
}

/// `evidence_walk(path, window, payload)`: JSON text. `null` when the transcript cannot be read; `{"unsure":true}` as
/// [`super::host_ts::evidence`]; `{"truncated":b,"walked":false}` when the
/// window holds no reply and there is no payload; else `{"truncated","walked":true,"lastText","toolsThisTurn","toolsAtEnd",
/// "evidenceChars","withLastChars","ownerToolsThisTurn","ownerToolsAtEnd"}` (the two lengths in UTF-16 units; the owner counts
/// restart only at an owner prompt, not at a task notification or an injected record: `transcript.ev_cont_*`) and the walk is kept for `walk_has` / `walk_numbers`.
pub fn evidence_walk(path: &str, window: f64, payload: Option<&str>) -> String {
    if !path.starts_with('/') {
        return unsure();
    }
    forget_mine();
    let w = window_bytes(window);
    let out = with_window(path, w, |lines, truncated, bad| {
        if bad {
            return Err(unsure());
        }
        Ok((walk_lines(lines, payload), truncated))
    });
    let (walked, truncated) = match out {
        None => return "null".into(),
        Some(Err(u)) => return u,
        Some(Ok(v)) => v,
    };
    let Some(Walked { walk, last_text, tools_this_turn, tools_at_end, owner_tools_this_turn, owner_tools_at_end }) = walked else {
        return json!({"truncated": truncated, "walked": false}).to_string();
    };
    let with_last_chars = js_len(&walk.text);
    let evidence_chars = js_len(walk.text.get(..walk.ev_len).unwrap_or_default());
    let weight = walk.text.len() + std::mem::size_of::<Walk>();
    let h = NEXT.fetch_add(1, Relaxed);
    let ttl = defaults::num("transcript.evidence_walk_idle_ms");
    let exp = (ttl > 0).then(|| crate::health::now_ms().saturating_add(ttl));
    let walk = Arc::new(walk);
    // A refusal (this holder or the process over its hard limit) only means the bytes are not accounted for: the thread still
    // holds its one walk (released on its next walk), so the check answers instead of deferring the whole Stop to Node.
    if !cache().insert_with_ttl(h, Arc::clone(&walk), weight, exp) {
        crate::load::note_count("evidence_walk", "result", "refused");
    }
    MINE.with(|m| *m.borrow_mut() = Some((h, walk)));
    json!({
        "truncated": truncated, "walked": true, "lastText": last_text, "toolsThisTurn": tools_this_turn, "toolsAtEnd": tools_at_end,
        "evidenceChars": evidence_chars, "withLastChars": with_last_chars,
        "ownerToolsThisTurn": owner_tools_this_turn, "ownerToolsAtEnd": owner_tools_at_end,
    })
    .to_string()
}

/// Drop this thread's previous walk.
fn forget_mine() {
    let old = MINE.with(|m| m.borrow_mut().take());
    if let Some((old, _)) = old {
        cache().remove(&old);
    }
}

/// The text `which` names (`evidence` or `withLast`) of this thread's last walk, run through `f`.
fn with_text<R>(which: &str, f: impl FnOnce(&str) -> rquickjs::Result<R>) -> rquickjs::Result<R> {
    let Some(walk) = MINE.with(|m| m.borrow().as_ref().map(|(_, w)| Arc::clone(w))) else {
        return Err(super::host::err("walkHas", defaults::text("transcript.msg_walk_lost")));
    };
    match which {
        "evidence" => f(walk.text.get(..walk.ev_len).unwrap_or_default()),
        "withLast" => f(&walk.text),
        other => Err(super::host::err("walkHas", defaults::render("transcript.msg_walk_which", &[("which", &other)]))),
    }
}

/// `walk_has(which, needle)`: `text.indexOf(needle) >= 0` on the evidence or the evidence-with-last of this thread's last walk.
pub fn walk_has(which: &str, needle: &str) -> rquickjs::Result<bool> {
    with_text(which, |t| Ok(t.contains(needle)))
}

/// `walk_numbers(which, src, flags, strip)`: what `reNumbers(src, flags, text, strip)` answers for that text.
pub fn walk_numbers(which: &str, src: &str, flags: &str, strip: &str) -> rquickjs::Result<String> {
    with_text(which, |t| super::host_ts::re_numbers(src, flags, t, strip))
}

/// Add the walk functions to `ahHost`.
pub fn install<'a>(c: &Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set("transcriptEvidenceWalk", Function::new(c.clone(), |p: String, w: f64, payload: Option<String>| evidence_walk(&p, w, payload.as_deref()))?)?;
    h.set("transcriptWalkHas", Function::new(c.clone(), |which: String, needle: String| walk_has(&which, &needle))?)?;
    h.set(
        "transcriptWalkNumbers",
        Function::new(c.clone(), |which: String, src: String, flags: String, strip: String| walk_numbers(&which, &src, &flags, &strip))?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::host_ts::evidence;
    use super::*;
    use serde_json::{Value, json};

    fn path(tag: &str) -> String {
        std::env::temp_dir().join(format!("ah-evwalk-{tag}-{}", std::process::id())).to_string_lossy().into_owned()
    }

    fn user(text: &str) -> Value {
        json!({"type": "user", "message": {"role": "user", "content": text}})
    }
    fn result(text: &str) -> Value {
        json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "x", "content": text}]}})
    }
    fn assistant(id: &str, text: &str, tools: usize) -> Value {
        let mut blocks: Vec<Value> =
            (0..tools).map(|i| json!({"type": "tool_use", "id": format!("u{i}"), "name": "Bash", "input": {"command": format!("echo {i}")}})).collect();
        blocks.push(json!({"type": "text", "text": text}));
        json!({"type": "assistant", "message": {"id": id, "role": "assistant", "content": blocks}})
    }
    fn write(tag: &str, lines: &[Value]) -> String {
        let p = path(tag);
        let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(&p, body).unwrap();
        p
    }

    /// `clWalk` of the claim ledger's script, item by item over what `ah.transcript.evidence` answers (arrays, `join`, `indexOf`):
    /// (lastText, evidence, toolsThisTurn, evidenceWithLast, toolsAtEnd) or None.
    fn js_walk(p: &str, payload: Option<&str>) -> Option<(String, String, usize, String, usize)> {
        let ev: Value = serde_json::from_str(&evidence(p, 1e9)).unwrap();
        let payload_norm = payload.map(collapse);
        let mut out: Vec<String> = Vec::new();
        let (mut tools, mut last): (usize, Option<(Value, String, usize)>) = (0, None);
        let push_ev = |out: &mut Vec<String>, text: &str| {
            if let Some(pn) = &payload_norm {
                let n = collapse(text);
                if !n.is_empty() && pn.contains(&n) {
                    return;
                }
            }
            out.push(text.to_string());
        };
        for it in ev["items"].as_array().unwrap() {
            let (kind, text) = (it[0].as_str().unwrap(), it[1].as_str().unwrap());
            match kind {
                "p" => {
                    tools = 0;
                    out.push(text.into());
                }
                "r" | "a" => out.push(text.into()),
                "i" => {
                    tools += 1;
                    out.push(text.into());
                }
                "t" => {
                    let id = it[2].clone();
                    match &mut last {
                        Some((lid, ltext, ltools)) if !id.is_null() && *lid == id => {
                            ltext.push('\n');
                            ltext.push_str(text);
                            *ltools = tools;
                        }
                        _ => {
                            if let Some((_, lt, _)) = last.take() {
                                push_ev(&mut out, &lt);
                            }
                            last = Some((id, text.to_string(), tools));
                        }
                    }
                }
                _ => {}
            }
        }
        match last {
            None => {
                payload?;
                let j = out.join("\n");
                Some((String::new(), j.clone(), tools, j, tools))
            }
            Some((_, lt, lt_tools)) => {
                let e = out.join("\n");
                Some((lt.clone(), e.clone(), lt_tools, format!("{e}\n{lt}"), tools))
            }
        }
    }

    /// The walk, read back through the questions a script can ask.
    fn rust_walk(p: &str, payload: Option<&str>) -> Option<(String, String, usize, String, usize)> {
        let r: Value = serde_json::from_str(&evidence_walk(p, 1e9, payload)).unwrap();
        if r["walked"] != json!(true) {
            return None;
        }
        let with_last = with_text("withLast", |t| Ok(t.to_string())).unwrap();
        let ev = with_text("evidence", |t| Ok(t.to_string())).unwrap();
        assert_eq!(r["evidenceChars"], json!(ev.encode_utf16().count()), "evidenceChars is the UTF-16 length");
        assert_eq!(r["withLastChars"], json!(with_last.encode_utf16().count()), "withLastChars is the UTF-16 length");
        Some((r["lastText"].as_str().unwrap().into(), ev, r["toolsThisTurn"].as_u64().unwrap() as usize, with_last, r["toolsAtEnd"].as_u64().unwrap() as usize))
    }

    fn same(tag: &str, lines: &[Value], payload: Option<&str>) -> Option<(String, String, usize, String, usize)> {
        let p = write(tag, lines);
        let a = rust_walk(&p, payload);
        let b = js_walk(&p, payload);
        std::fs::remove_file(&p).ok();
        assert_eq!(a, b, "{tag}: the host walk is clWalk");
        a
    }

    #[test]
    fn consecutive_text_of_one_message_id_is_one_reply_and_a_new_id_closes_it() {
        let r = same("merge", &[user("go"), assistant("m1", "part one", 1), assistant("m1", "part two", 2), result("ok"), assistant("m2", "final", 0)], None)
            .unwrap();
        assert_eq!(r.0, "final");
        assert!(r.1.contains("part one\npart two"), "the closed reply joins its pieces with a newline: {:?}", r.1);
        assert_eq!(r.2, 3, "tool count of the turn at the last piece");
        assert_eq!(r.3, format!("{}\nfinal", r.1));
        // a null id never merges
        let none = |t: &str| json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": t}]}});
        let r = same("noid", &[none("a"), none("b")], None).unwrap();
        assert_eq!((r.0.as_str(), r.1.as_str()), ("b", "a"));
    }

    #[test]
    fn a_prompt_restarts_the_tool_count_and_tools_after_the_reply_count_at_the_end_only() {
        let r = same("tools", &[user("a"), assistant("m1", "x", 3), user("b"), assistant("m2", "y", 1), result("late")], None).unwrap();
        assert_eq!((r.2, r.4), (1, 1));
        let r = same("tools2", &[user("a"), assistant("m1", "y", 1), assistant("m2", "z", 0)], None).unwrap();
        assert_eq!((r.0.as_str(), r.2, r.4), ("z", 1, 1));
        let p = write(
            "tools3",
            &[
                user("a"),
                assistant("m1", "y", 0),
                json!({"type": "assistant", "message": {"id": "m2", "role": "assistant", "content": [{"type": "tool_use", "id": "u", "name": "B", "input": {}}]}}),
            ],
        );
        let w: Value = serde_json::from_str(&evidence_walk(&p, 1e9, None)).unwrap();
        std::fs::remove_file(&p).ok();
        assert_eq!((w["toolsThisTurn"].as_u64(), w["toolsAtEnd"].as_u64()), (Some(0), Some(1)), "a tool call after the reply is counted at the end only");
    }

    #[test]
    fn the_owner_counts_restart_only_at_an_owner_prompt_and_the_plain_counts_are_unchanged() {
        let note = json!({"type": "user", "origin": {"kind": "task-notification"}, "message": {"role": "user", "content": "<task-notification>done</task-notification>"}});
        let injected = json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "Stop hook feedback: say it"}});
        let peer = json!({"type": "user", "origin": {"kind": "peer"}, "isMeta": true, "message": {"role": "user", "content": "from another session"}});
        let human = json!({"type": "user", "origin": {"kind": "human"}, "message": {"role": "user", "content": "next"}});
        let counts = |tag: &str, lines: &[Value]| {
            let p = write(tag, lines);
            let w: Value = serde_json::from_str(&evidence_walk(&p, 1e9, None)).unwrap();
            std::fs::remove_file(&p).ok();
            [
                w["toolsThisTurn"].as_u64().unwrap(),
                w["ownerToolsThisTurn"].as_u64().unwrap(),
                w["toolsAtEnd"].as_u64().unwrap(),
                w["ownerToolsAtEnd"].as_u64().unwrap(),
            ]
        };
        // two calls, a notification, an injected record and a peer record, one more call, the reply: the plain turn restarts at each
        // of them, the owner's turn does not
        let lines =
            [human.clone(), assistant("m1", "", 2), result("r"), note, assistant("m2", "", 1), result("r"), injected, peer, assistant("m3", "reply", 0)];
        assert_eq!(counts("owner1", &lines), [0, 3, 0, 3]);
        // a typed prompt (origin human, or no origin at all) restarts both
        let after = [human.clone(), assistant("m1", "", 2), human.clone(), assistant("m2", "reply", 1)];
        assert_eq!(counts("owner2", &after), [1, 1, 1, 1]);
        let plain = [user("go"), assistant("m1", "", 2), user("again"), assistant("m2", "reply", 0)];
        assert_eq!(counts("owner3", &plain), [0, 0, 0, 0]);
        // the evidence answer is unchanged: the same items, no new kind
        let p = write("owner4", &lines);
        let ev: Value = serde_json::from_str(&evidence(&p, 1e9)).unwrap();
        std::fs::remove_file(&p).ok();
        let kinds: std::collections::BTreeSet<&str> = ev["items"].as_array().unwrap().iter().map(|i| i[0].as_str().unwrap()).collect();
        assert_eq!(kinds, ["i", "p", "r", "t"].into_iter().collect());
    }

    #[test]
    fn a_reply_the_payload_holds_is_left_out_with_nfc_and_every_kind_of_white_space() {
        // "é" as e + U+0301 in the transcript, precomposed in the payload; NBSP, LINE SEPARATOR and a BOM-like U+FEFF for spaces
        let earlier = "caf\u{65}\u{301}\u{a0}ready\u{2028}now";
        let payload = "\u{feff}Result: caf\u{e9} ready now \u{feff} done";
        let r = same("payload", &[user("go"), assistant("m1", earlier, 0), assistant("m2", "later reply", 0)], Some(payload)).unwrap();
        assert_eq!(r.0, "later reply");
        assert!(!r.1.contains("ready"), "the earlier reply is inside the payload and is not evidence: {:?}", r.1);
        // the same reply without the payload stays
        let r = same("nopayload", &[user("go"), assistant("m1", earlier, 0), assistant("m2", "later reply", 0)], None).unwrap();
        assert!(r.1.contains("ready"));
        // an empty collapse is never "held"
        let r = same("blank", &[user("go"), assistant("m1", "\u{a0}\u{a0}x", 0), assistant("m2", "z", 0)], Some("anything")).unwrap();
        assert!(r.1.contains('x'));
    }

    #[test]
    fn without_a_reply_the_walk_exists_only_with_a_payload() {
        assert!(same("nolast", &[user("go"), result("r")], None).is_none());
        let p = write("nolast2", &[user("go"), result("r")]);
        let none: Value = serde_json::from_str(&evidence_walk(&p, 1e9, None)).unwrap();
        assert_eq!(none, json!({"truncated": false, "walked": false}));
        std::fs::remove_file(&p).ok();
        let r = same("nolast3", &[user("go"), assistant("m0", "x", 1)], None).unwrap();
        assert_eq!(r.4, 1);
        let r = same("nolast4", &[user("go"), result("r")], Some("a payload")).unwrap();
        assert_eq!((r.0.as_str(), r.1.as_str(), r.3.as_str()), ("", "go\nr", "go\nr"), "no reply: the evidence is its own with-last");
        let r = same("empty", &[json!({"type": "system", "content": "x"})], Some("p")).unwrap();
        assert_eq!((r.1.as_str(), r.2), ("", 0));
    }

    #[test]
    fn lengths_are_utf16_units_and_the_questions_read_the_same_text_javascript_would() {
        let p = write("utf16", &[user("go \u{1F600}\u{1F600} \u{e9}"), assistant("m1", "reply \u{1F680} 12,345 items abc1234", 0)]);
        let r: Value = serde_json::from_str(&evidence_walk(&p, 1e9, None)).unwrap();
        std::fs::remove_file(&p).ok();
        assert_eq!(r["evidenceChars"], json!("go \u{1F600}\u{1F600} \u{e9}".encode_utf16().count()), "two astral characters are four units");
        assert_eq!(r["withLastChars"], json!("go \u{1F600}\u{1F600} \u{e9}\nreply \u{1F680} 12,345 items abc1234".encode_utf16().count()));
        assert!(walk_has("withLast", "abc1234").unwrap());
        assert!(!walk_has("evidence", "abc1234").unwrap(), "the last reply is not in the evidence");
        assert!(walk_has("evidence", "").unwrap(), "indexOf('') is 0");
        assert!(walk_has("withLast", "\n").unwrap());
        // the numbers are what ah.re.numbers gives on the same text
        let text = with_text("withLast", |t| Ok(t.to_string())).unwrap();
        assert_eq!(
            walk_numbers("withLast", r"\d[\d,]*(?:\.\d+)?", "", ",").unwrap(),
            super::super::host_ts::re_numbers(r"\d[\d,]*(?:\.\d+)?", "", &text, ",").unwrap()
        );
        assert!(walk_has("nope", "x").is_err(), "an unknown text throws");
    }

    #[test]
    fn a_walk_the_memory_registry_refuses_still_answers_instead_of_deferring() {
        // replay l227: with the process over the global hard limit every insert is refused; claim-ledger deferred 22 of 61 Stops
        // to Node (evidence_walk|result=refused 22). The thread keeps its walk, so the answer is a walk, never {"unsure":true}.
        let _ = crate::mem::global().tick(u64::MAX / 2, crate::health::now_ms());
        let p = write("refused", &[user("go"), assistant("m1", "sha abc1234 here", 0)]);
        let out: Value = serde_json::from_str(&evidence_walk(&p, 1e9, Some("other"))).unwrap();
        assert_eq!(out["walked"], json!(true), "a refused insert must not defer: {out}");
        assert_eq!(walk_has("withLast", "abc1234").ok(), Some(true));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn an_evicted_walk_still_answers_its_questions() {
        // review finding: the shared cache may evict the walk (LRU, recycle, entry cap) between the walk and its questions
        let p = write("evict", &[user("go"), assistant("m1", "sha abc1234 here", 0)]);
        evidence_walk(&p, 1e9, Some("other"));
        let h = MINE.with(|m| m.borrow().as_ref().map(|(h, _)| *h)).unwrap();
        cache().remove(&h);
        assert!(cache().get(&h).is_none(), "evicted from the cache");
        assert_eq!(walk_has("withLast", "abc1234").ok(), Some(true), "the thread still holds its walk");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn a_dropped_or_never_made_walk_throws_and_the_next_walk_replaces_the_last() {
        std::thread::spawn(|| assert!(walk_has("evidence", "x").is_err(), "no walk on this thread yet")).join().unwrap();
        let p = write("replace", &[user("go"), assistant("m1", "one", 0)]);
        evidence_walk(&p, 1e9, None);
        let handle = || MINE.with(|m| m.borrow().as_ref().map(|(h, _)| *h)).unwrap();
        let first = handle();
        evidence_walk(&p, 1e9, None);
        assert_ne!(handle(), first);
        assert!(cache().get(&first).is_none(), "the thread's previous walk is gone");
        std::fs::remove_file(&p).ok();
        assert_eq!(evidence_walk("relative.jsonl", 1e9, None), r#"{"unsure":true}"#);
        assert_eq!(evidence_walk(&format!("{}/none", std::env::temp_dir().display()), 1e9, None), "null");
    }
}
