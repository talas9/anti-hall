//! The ack protocol between the hook client and the daemon (GitHub #199, #201).
//!
//! ```text
//! client -> daemon   V <ver>-w1.<n>\n<n body bytes>          (n = byte length of everything after the head line)
//! daemon -> client   AHK1 REQ <queue_wait_us>\n               (the request is read and parsed; the daemon will judge it)
//! daemon -> client   AHR2 <OK|BUSY|ERR> <len> <crc>\n...      (the reply frame, see `frame`)
//! client -> daemon   AHK1 RES <connect_us> <req_ack_us> <ack_response_us> <retries> <launcher stats|->\n
//! ```
//!
//! The head-line suffix is the whole opt-in: a daemon that predates the protocol compares versions up to the first `-` and
//! ignores the rest, and the client only opts in when the daemon announced the protocol (`wire.caps_file`). The length replaces the
//! end-of-stream the original exchange used to find the end of the request, which is what leaves the client's side open for ACK(res).
//!
//! No ACK(req) within the client's short timeout means the daemon has not started on the request. The client closes that connection and
//! resends; the daemon that eventually reads the closed connection finds its ACK(req) write refused and does not judge it, so the
//! resend is never a second judging. Once ACK(req) arrives the client never resends and waits for the reply up to its hard deadline.
//! A reply with no ACK(res) afterwards is an `undelivered_verdict` fail-open on the daemon. ACK(res) follows the hand-over of the
//! reply (printed by a hook call, taken in by the dispatcher), never the dispatcher's own work after it, which can take seconds.
use crate::defaults;

/// Opt a request in: add the body length to the head line. `None` for requests that do not take part (control verbs).
pub fn tag_request(payload: &[u8]) -> Option<Vec<u8>> {
    let nl = payload.iter().position(|&b| b == b'\n')?;
    if !(payload.starts_with(b"V ") || payload.starts_with(b"D ")) {
        return None;
    }
    let suffix = format!("{}{}", defaults::text("wire.head_tag"), payload.len() - nl - 1);
    let mut out = Vec::with_capacity(payload.len() + suffix.len());
    let (head, tail) = payload.split_at(nl);
    out.extend_from_slice(head);
    out.extend_from_slice(suffix.as_bytes());
    out.extend_from_slice(tail);
    Some(out)
}

/// The body length an ack-mode head line announces (`None` = an ordinary request, read to end-of-stream).
pub fn announced_len(head: &str) -> Option<usize> {
    if !(head.starts_with("V ") || head.starts_with("D ")) {
        return None; // only hook and dispatch requests take part; a control line that merely contains the tag is an ordinary one
    }
    let tag = defaults::text("wire.head_tag");
    let i = head.rfind(tag)?;
    head.get(i + tag.len()..)?.trim().parse().ok()
}

/// ACK(req): the request is read and parsed. `wait_us` is how long it queued.
pub fn ack_req(wait_us: u64) -> Vec<u8> {
    format!("{} {} {wait_us}\n", defaults::text("wire.ack_magic"), defaults::text("wire.req_word")).into_bytes()
}

/// The line that carries an engine-level fail-open to an ack-mode client, just before the reply frame (GitHub #201). `reason` and
/// `check` are single words: anything else becomes `_`.
pub fn fail_open_line(reason: &str, check: &str) -> Vec<u8> {
    let word = |t: &str| -> String { t.chars().map(|c| if c.is_whitespace() || c.is_control() { '_' } else { c }).collect() };
    format!("{} {} {} {}\n", defaults::text("wire.ack_magic"), defaults::text("wire.fo_word"), word(reason), word(check)).into_bytes()
}

/// What the start of a read buffer says about a fail-open line.
#[derive(Debug, PartialEq, Eq)]
pub enum FoSeen {
    /// Not enough bytes yet to tell.
    Need,
    /// The buffer does not start with a fail-open line.
    No,
    /// A fail-open line.
    Fo {
        /// Its length in bytes, newline included.
        len: usize,
        /// Why the engine failed open.
        reason: String,
        /// The check it concerned.
        check: String,
    },
}

/// Look for a fail-open line at the start of `buf`.
pub fn parse_fail_open(buf: &[u8]) -> FoSeen {
    let prefix = format!("{} {} ", defaults::text("wire.ack_magic"), defaults::text("wire.fo_word"));
    let p = prefix.as_bytes();
    if buf.iter().zip(p).any(|(a, b)| a != b) {
        // the bytes seen so far differ from the prefix (a shorter buffer is compared over its own length)
        return FoSeen::No;
    }
    let Some(nl) = buf.iter().position(|&b| b == b'\n') else { return FoSeen::Need };
    let rest = String::from_utf8_lossy(buf.get(p.len().min(nl)..nl).unwrap_or_default()).into_owned();
    match rest.split_once(' ') {
        Some((reason, check)) if buf.len() >= p.len() => FoSeen::Fo { len: nl + 1, reason: reason.to_string(), check: check.to_string() },
        _ => FoSeen::No,
    }
}

/// What the start of a read buffer says about ACK(req).
#[derive(Debug, PartialEq, Eq)]
pub enum AckSeen {
    /// Not enough bytes yet to tell.
    Need,
    /// The buffer does not start with an ACK(req) (for example the daemon answered with an error frame instead).
    No,
    /// An ACK(req).
    Req {
        /// Its length in bytes, newline included.
        len: usize,
        /// How long the daemon queued the request, in microseconds.
        wait_us: u64,
    },
}

/// Look for ACK(req) at the start of `buf`.
pub fn parse_ack_req(buf: &[u8]) -> AckSeen {
    let prefix = format!("{} {} ", defaults::text("wire.ack_magic"), defaults::text("wire.req_word"));
    let p = prefix.as_bytes();
    if buf.iter().zip(p).any(|(a, b)| a != b) {
        // the bytes seen so far differ from the prefix (a shorter buffer is compared over its own length)
        return AckSeen::No;
    }
    let Some(nl) = buf.iter().position(|&b| b == b'\n') else { return AckSeen::Need };
    match std::str::from_utf8(buf.get(p.len().min(nl)..nl).unwrap_or_default()).ok().and_then(|t| t.trim().parse().ok()) {
        Some(wait_us) if buf.len() >= p.len() => AckSeen::Req { len: nl + 1, wait_us },
        _ => AckSeen::No,
    }
}

/// What the client measured, sent back inside ACK(res).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClientPhases {
    /// Connect to the daemon socket.
    pub connect_us: u64,
    /// Request written to ACK(req) received.
    pub req_ack_us: u64,
    /// ACK(req) received to the complete reply.
    pub ack_response_us: u64,
    /// Resends after a missing ACK(req).
    pub retries: u64,
    /// The launcher's counters (`launcher.stats_env`), forwarded as they came; empty when the client was not started by the launcher.
    pub launcher: String,
}

/// ACK(res).
pub fn ack_res(p: &ClientPhases) -> Vec<u8> {
    let stats: String = p.launcher.chars().filter(|c| !c.is_whitespace() && !c.is_control()).collect();
    let stats = if stats.is_empty() { "-".to_string() } else { stats };
    format!(
        "{} {} {} {} {} {} {stats}\n",
        defaults::text("wire.ack_magic"),
        defaults::text("wire.res_word"),
        p.connect_us,
        p.req_ack_us,
        p.ack_response_us,
        p.retries
    )
    .into_bytes()
}

/// Read one ACK(res) line; `None` when it is not one.
pub fn parse_ack_res(line: &str) -> Option<ClientPhases> {
    let mut it = line.trim_end().split(' ');
    if it.next()? != defaults::text("wire.ack_magic") || it.next()? != defaults::text("wire.res_word") {
        return None;
    }
    let mut n = || it.next()?.parse::<u64>().ok();
    let (connect_us, req_ack_us, ack_response_us, retries) = (n()?, n()?, n()?, n()?);
    let launcher = it.next().filter(|s| *s != "-").unwrap_or_default().to_string();
    Some(ClientPhases { connect_us, req_ack_us, ack_response_us, retries, launcher })
}

/// Where the daemon announces the protocol.
pub fn caps_path() -> std::path::PathBuf {
    crate::paths::dir().join(defaults::text("wire.caps_file"))
}

/// The daemon speaks the protocol: say so (best effort; without the file clients use the original exchange).
pub fn announce() {
    if let Err(e) = crate::atomic::write(caps_path(), std::process::id().to_string()) {
        crate::health::log_event("wire", "announce_failed", &e.to_string());
    }
}

/// The daemon is going away: withdraw the announcement, unless a successor has already replaced it with its own.
pub fn withdraw() {
    if std::fs::read_to_string(caps_path()).is_ok_and(|t| t.trim() != std::process::id().to_string()) {
        return;
    }
    if let Err(e) = std::fs::remove_file(caps_path())
        && e.kind() != std::io::ErrorKind::NotFound
    {
        crate::health::log_event("wire", "withdraw_failed", &e.to_string());
    }
}

/// The launcher's counters as (name, value) pairs; `v=` and the non-counter `host=` are dropped, `startup_us` is returned apart.
pub fn launcher_counters(stats: &str) -> (Option<u64>, Vec<(String, u64)>) {
    let (mut startup, mut counters) = (None, Vec::new());
    for kv in stats.split(';') {
        let Some((k, v)) = kv.split_once('=') else { continue };
        match (k, v.parse::<u64>()) {
            ("startup_us", Ok(n)) => startup = Some(n),
            ("v" | "host" | "prefix", _) | (_, Err(_)) => {}
            (k, Ok(n)) => counters.push((k.to_string(), n)),
        }
    }
    (startup, counters)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tagged_head_announces_the_body_length_and_leaves_the_rest_alone() {
        let t = tag_request(b"V 0.300.3\nE {}\n{\"a\":1}").unwrap();
        let s = String::from_utf8(t).unwrap();
        let (head, body) = s.split_once('\n').unwrap();
        assert_eq!(body, "E {}\n{\"a\":1}");
        assert_eq!(announced_len(head), Some(body.len()));
        assert_eq!(announced_len("V 0.300.3"), None, "an ordinary head has no length");
        assert_eq!(announced_len("CTL telemetry x-w1.5"), None, "only V and D heads take part");
        assert!(tag_request(b"CTL ping\n").is_none() && tag_request(b"no newline").is_none());
    }

    #[test]
    fn a_pre_release_version_keeps_working_with_the_tag() {
        let s = String::from_utf8(tag_request(b"D 1.0.0-rc1\nxy").unwrap()).unwrap();
        assert_eq!(announced_len(s.lines().next().unwrap()), Some(2));
        assert_eq!(
            crate::version_cmp(s.lines().next().unwrap().strip_prefix("D ").unwrap(), "1.0.0"),
            std::cmp::Ordering::Equal,
            "an older daemon still reads the version"
        );
    }

    #[test]
    fn ack_req_is_found_at_the_start_and_partial_prefixes_wait() {
        let a = ack_req(1234);
        assert_eq!(parse_ack_req(&a), AckSeen::Req { len: a.len(), wait_us: 1234 });
        let mut with_reply = a.clone();
        with_reply.extend_from_slice(b"AHR2 OK 0 00000000\n\nAHEND\n");
        assert_eq!(parse_ack_req(&with_reply), AckSeen::Req { len: a.len(), wait_us: 1234 });
        for cut in 0..a.len() - 1 {
            assert_eq!(parse_ack_req(&a[..cut]), AckSeen::Need, "cut {cut}");
        }
        assert_eq!(parse_ack_req(b"AHR2 OK 0 00000000\n"), AckSeen::No, "a reply frame is not an ack");
        assert_eq!(parse_ack_req(b"AHK1 REQ x\n"), AckSeen::No);
    }

    #[test]
    fn a_fail_open_line_round_trips_and_partial_prefixes_wait() {
        let l = fail_open_line("deadline cut", "agent scan");
        assert_eq!(parse_fail_open(&l), FoSeen::Fo { len: l.len(), reason: "deadline_cut".into(), check: "agent_scan".into() });
        for cut in 0..l.len() - 1 {
            assert_eq!(parse_fail_open(&l[..cut]), FoSeen::Need, "cut {cut}");
        }
        assert_eq!(parse_fail_open(b"AHR2 OK 0 00000000\n"), FoSeen::No);
        assert_eq!(parse_fail_open(&ack_req(5)), FoSeen::No, "an ACK(req) is not a fail-open line");
    }

    #[test]
    fn ack_res_round_trips_with_and_without_launcher_stats() {
        let p = ClientPhases {
            connect_us: 5,
            req_ack_us: 70,
            ack_response_us: 900,
            retries: 1,
            launcher: "v=1;startup_us=300;prefix=2;host=claude;soft_wall=1".into(),
        };
        assert_eq!(parse_ack_res(std::str::from_utf8(&ack_res(&p)).unwrap()), Some(p));
        let bare = ClientPhases { connect_us: 1, req_ack_us: 2, ack_response_us: 3, retries: 0, launcher: String::new() };
        assert_eq!(parse_ack_res(std::str::from_utf8(&ack_res(&bare)).unwrap()), Some(bare));
        assert_eq!(parse_ack_res("AHK1 RES 1 2\n"), None);
        assert_eq!(parse_ack_res("garbage"), None);
    }

    #[test]
    fn launcher_stats_split_into_startup_and_counters() {
        let (startup, c) = launcher_counters("v=1;startup_us=321;prefix=10;host=codex;soft_wall=2;fail_open=1;bogus;x=notnum");
        assert_eq!(startup, Some(321));
        assert_eq!(c, vec![("soft_wall".to_string(), 2), ("fail_open".to_string(), 1)]);
    }
}
