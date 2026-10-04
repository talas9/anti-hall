//! Reply framing. A reply is trusted only if it is complete and intact:
//!
//! ```text
//! AHR2 <OK|BUSY|ERR> <body-len> <crc32-hex>\n<body bytes>\nAHEND\n
//! ```
//!
//! Anything else (empty, truncated, wrong length, bad checksum, trailing bytes, wrong magic) is a
//! `FrameErr`, and the client treats it as an engine failure: it runs the Node hook, never "allow".
//! The magic carries the protocol version: it is bumped whenever the request or reply format changes (AHR2: the request
//! carries the client's environment, D76), so a client and a daemon of different protocols never read each other's
//! frames as answers; the client treats the mismatch as an engine failure and runs the Node hook.
//! An empty BODY inside a valid OK frame is the engine's real "nothing to say" answer.

const MAGIC: &str = "AHR2";
const END: &[u8] = b"\nAHEND\n";

/// Reply kind carried in a frame header.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Kind {
    /// The request was served.
    Ok,
    /// Load shedding (queue full / rate limited): the client must fall back.
    Busy,
    /// The engine could not evaluate this request: the client must fall back.
    Err,
}

/// Why a byte string is not a valid frame.
#[derive(Debug, PartialEq, Eq)]
pub enum FrameErr {
    /// No bytes at all.
    Empty,
    /// Fewer bytes than the header promises.
    Truncated,
    /// The header or trailer is not in the expected shape.
    Malformed,
    /// The body does not match its checksum.
    BadChecksum,
}

/// CRC-32 (IEEE) of `data`, bitwise so no table is needed.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// Frame `body` with its kind, length and checksum.
pub fn encode(kind: Kind, body: &str) -> Vec<u8> {
    let k = match kind {
        Kind::Ok => "OK",
        Kind::Busy => "BUSY",
        Kind::Err => "ERR",
    };
    let mut out = format!("{MAGIC} {k} {} {:08x}\n", body.len(), crc32(body.as_bytes())).into_bytes();
    out.extend_from_slice(body.as_bytes());
    out.extend_from_slice(END);
    out
}

/// Validate and unpack a frame; any damage is an error, never a partial answer.
pub fn decode(buf: &[u8]) -> Result<(Kind, String), FrameErr> {
    if buf.is_empty() {
        return Err(FrameErr::Empty);
    }
    let Some(nl) = buf.iter().take(64).position(|&b| b == b'\n') else {
        // no header line yet: either cut short or not a frame at all
        return Err(if MAGIC.as_bytes().starts_with(&buf[..buf.len().min(4)]) { FrameErr::Truncated } else { FrameErr::Malformed });
    };
    let head = std::str::from_utf8(&buf[..nl]).map_err(|_| FrameErr::Malformed)?;
    let mut it = head.split(' ');
    if it.next() != Some(MAGIC) {
        return Err(FrameErr::Malformed);
    }
    let kind = match it.next() {
        Some("OK") => Kind::Ok,
        Some("BUSY") => Kind::Busy,
        Some("ERR") => Kind::Err,
        _ => return Err(FrameErr::Malformed),
    };
    let len: usize = it.next().and_then(|v| v.parse().ok()).ok_or(FrameErr::Malformed)?;
    let crc = it.next().and_then(|v| u32::from_str_radix(v, 16).ok()).ok_or(FrameErr::Malformed)?;
    if it.next().is_some() {
        return Err(FrameErr::Malformed);
    }
    let body_start = nl + 1;
    let total = body_start.checked_add(len).and_then(|n| n.checked_add(END.len())).ok_or(FrameErr::Malformed)?;
    if buf.len() < total {
        return Err(FrameErr::Truncated);
    }
    if buf.len() > total {
        return Err(FrameErr::Malformed);
    }
    let body = &buf[body_start..body_start + len];
    if &buf[body_start + len..] != END {
        return Err(FrameErr::Malformed);
    }
    if crc32(body) != crc {
        return Err(FrameErr::BadChecksum);
    }
    String::from_utf8(body.to_vec()).map(|s| (kind, s)).map_err(|_| FrameErr::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_all_kinds_including_empty_and_multiline_bodies() {
        for (k, b) in [(Kind::Ok, ""), (Kind::Ok, "{\"a\":1}"), (Kind::Busy, ""), (Kind::Err, "x\nAHEND\ny"), (Kind::Ok, "héllo \u{1F600}")] {
            assert_eq!(decode(&encode(k, b)), Ok((k, b.to_string())), "{b:?}");
        }
    }

    #[test]
    fn known_crc32() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn every_truncation_of_a_frame_is_rejected() {
        let f = encode(Kind::Ok, r#"{"decision":"block","reason":"nope"}"#);
        for cut in 0..f.len() {
            assert!(decode(&f[..cut]).is_err(), "prefix of {cut}/{} bytes was accepted", f.len());
        }
        assert!(decode(&f).is_ok());
    }

    #[test]
    fn corruption_and_trailing_bytes_are_rejected() {
        let f = encode(Kind::Ok, "hello world");
        for i in 0..f.len() {
            let mut g = f.clone();
            g[i] ^= 0x01;
            assert!(decode(&g).is_err(), "flip at {i} accepted");
        }
        let mut g = f.clone();
        g.extend_from_slice(b"junk");
        assert_eq!(decode(&g), Err(FrameErr::Malformed));
        assert_eq!(decode(b""), Err(FrameErr::Empty));
        assert_eq!(decode(b"{\"decision\":\"allow\"}"), Err(FrameErr::Malformed));
        assert_eq!(decode(b"AHR2 OK 99999999999999999999 00000000\n"), Err(FrameErr::Malformed));
    }
}
