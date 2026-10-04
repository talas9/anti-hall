//! The loopback rule for a test endpoint override: which URLs may receive an API key, and in what canonical form.
//!
//! Mirrors `loopbackEndpointOrNull` in `hooks/lib/jev-client.js`, which accepts a URL when `new URL(val).hostname` is
//! exactly `127.0.0.1`, `localhost` or `[::1]`, the scheme is http(s) and there are no credentials. The WHATWG URL parser
//! normalises hosts before that comparison, so `127.1`, `2130706433`, `0x7f.1` and `[0:0:0:0:0:0:0:1]` all pass in Node,
//! and `localhost.` and `[::ffff:7f00:1]` do not. This module implements the parts of that parser the comparison depends
//! on (IPv4 number forms, trailing dot, percent-encoded host, IPv6 text) so the two agree.
//!
//! The accepted URL is returned in a CANONICAL form: the host is rewritten to the literal `127.0.0.1` or `[::1]`, so a
//! name is never resolved through DNS or a hosts file (a key can never follow a poisoned `localhost` entry), and the
//! transport can recognise a loopback target from the URL alone. [`endpoint`] is the only entry point.
//!
//! Deliberately stricter than Node (the URL is refused, never accepted): a non-ASCII host (Node's IDNA mapping would turn
//! full-width digits or letters into `127.0.0.1` or `localhost`), a special-scheme URL without the two slashes after the
//! scheme, and more than two slashes. A refusal only ever costs a test override, so strictness is the safe side.
use super::js_trim;
use std::net::Ipv6Addr;

/// The host a loopback URL was rewritten to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Host {
    V4,
    V6,
}

/// The canonical URL for a loopback `raw`, or `None` when it is not one. See the module docs.
pub fn endpoint(raw: &str) -> Option<String> {
    // The WHATWG parser drops ASCII tab and newline anywhere and trims C0 controls and spaces at both ends.
    let cleaned: String = js_trim(raw).chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let url = cleaned.trim_matches(|c: char| c <= ' ');
    let (scheme, rest) = url.split_once(':')?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let rest = rest.strip_prefix("//")?;
    let end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let hostport = match authority.rsplit_once('@') {
        Some((userinfo, hp)) => {
            if !(userinfo.is_empty() || userinfo == ":") {
                return None; // credentials: the key must not follow a URL that carries its own
            }
            hp
        }
        None => authority,
    };
    let (host_text, port) = split_host_port(hostport)?;
    let host = classify(host_text)?;
    let literal = match host {
        Host::V4 => "127.0.0.1",
        Host::V6 => "[::1]",
    };
    let mut out = format!("{scheme}://{literal}");
    if let Some(p) = port {
        out.push(':');
        out.push_str(&p.to_string());
    }
    out.push_str(&tail.replace('\\', "/"));
    Some(out)
}

/// Split `host[:port]` (a bracketed IPv6 host keeps its brackets). The port must be digits that fit in 16 bits.
fn split_host_port(hp: &str) -> Option<(&str, Option<u16>)> {
    let (host, port) = if hp.starts_with('[') {
        let close = hp.find(']')?;
        let (host, tail) = hp.split_at(close + 1);
        match tail {
            "" => (host, ""),
            t => (host, t.strip_prefix(':')?),
        }
    } else {
        hp.split_once(':').unwrap_or((hp, ""))
    };
    if port.is_empty() {
        return Some((host, None));
    }
    if !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let digits = port.trim_start_matches('0');
    let value = if digits.is_empty() { 0 } else { digits.parse::<u16>().ok()? };
    Some((host, Some(value)))
}

/// Which loopback address `host` names, after the WHATWG host normalisation, or `None`.
fn classify(host: &str) -> Option<Host> {
    if let Some(inner) = host.strip_prefix('[') {
        let addr: Ipv6Addr = inner.strip_suffix(']')?.parse().ok()?;
        return (addr == Ipv6Addr::LOCALHOST).then_some(Host::V6);
    }
    let decoded = percent_decode(host)?;
    if !decoded.is_ascii() {
        return None;
    }
    let lower = decoded.to_ascii_lowercase();
    let mut parts: Vec<&str> = lower.split('.').collect();
    if parts.len() > 1 && parts.last() == Some(&"") {
        parts.pop(); // one trailing dot is allowed on an address
    }
    let last = parts.last().copied().unwrap_or("");
    let ends_in_number = (!last.is_empty() && last.bytes().all(|b| b.is_ascii_digit())) || ipv4_number(last).is_some();
    if ends_in_number {
        return (ipv4(&parts)? == 0x7f00_0001).then_some(Host::V4);
    }
    // A name is only ever the exact word, never `localhost.` and never a longer name that starts with an address.
    (lower == "localhost").then_some(Host::V4)
}

/// Percent-decode a host (`%31` is `1`); `None` for a bad escape or non-UTF-8 bytes.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// One IPv4 part: decimal, `0x` hex or leading-zero octal. `None` when it is not a number.
fn ipv4_number(part: &str) -> Option<u64> {
    if part.is_empty() {
        return None;
    }
    let (digits, radix) = if let Some(h) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
        (h, 16)
    } else if part.len() > 1 && part.starts_with('0') {
        (&part[1..], 8)
    } else {
        (part, 10)
    };
    if digits.is_empty() {
        return Some(0);
    }
    let mut n: u64 = 0;
    for c in digits.chars() {
        n = n.checked_mul(radix)?.checked_add(u64::from(c.to_digit(radix as u32)?))?;
        if n > u64::from(u32::MAX) * 256 {
            return None;
        }
    }
    Some(n)
}

/// The IPv4 address of the dotted parts, by the WHATWG rules: every part but the last is one byte, the last fills the rest.
fn ipv4(parts: &[&str]) -> Option<u32> {
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let nums: Vec<u64> = parts.iter().map(|p| ipv4_number(p)).collect::<Option<_>>()?;
    let (last, head) = nums.split_last()?;
    if head.iter().any(|n| *n > 255) || *last >= 256u64.pow(5 - parts.len() as u32) {
        return None;
    }
    let mut addr = *last;
    for (i, n) in head.iter().enumerate() {
        addr += n * 256u64.pow(3 - i as u32);
    }
    u32::try_from(addr).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_node_accepted_forms_are_canonicalised_to_the_literal() {
        let v4 = |u: &str| endpoint(u).unwrap_or_default();
        assert_eq!(v4("http://127.0.0.1:8080/x?y#z"), "http://127.0.0.1:8080/x?y#z");
        assert_eq!(v4("HTTPS://LOCALHOST/p"), "https://127.0.0.1/p");
        assert_eq!(v4("http://127.1:9/"), "http://127.0.0.1:9/");
        assert_eq!(v4("http://2130706433/"), "http://127.0.0.1/");
        assert_eq!(v4("http://0x7f.1/"), "http://127.0.0.1/");
        assert_eq!(v4("http://0177.0.0.1/"), "http://127.0.0.1/");
        assert_eq!(v4("http://127.0.0.1./"), "http://127.0.0.1/");
        assert_eq!(v4("http://%31%32%37.0.0.1/"), "http://127.0.0.1/");
        assert_eq!(v4("http://@127.0.0.1:0009/a\\b"), "http://127.0.0.1:9/a/b");
        assert_eq!(v4(" \t http://localhost:1/ \n"), "http://127.0.0.1:1/");
        assert_eq!(v4("https://[::1]:9/"), "https://[::1]:9/");
        assert_eq!(v4("http://[0:0:0:0:0:0:0:1]/"), "http://[::1]/");
    }

    #[test]
    fn everything_else_is_refused() {
        for bad in [
            "http://127.0.0.1.evil.com/",
            "http://localhost.evil.com/",
            "http://evil.com/127.0.0.1",
            "http://127.0.0.1@evil.com/",
            "http://user:pw@127.0.0.1/",
            "http://127.0.0.1:80@evil.com/",
            "http://[::ffff:7f00:1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::2]/",
            "http://localhost./",
            "http://127.0.0.2/",
            "http://127.0.0.1:99999/",
            "http://127.0.0.1:80x/",
            "http://0.0.0.0/",
            "http://1.1.1.1/",
            "http://256.0.0.1/",
            "http://127.0.0.1.0/",
            "ftp://127.0.0.1/",
            "file:///etc/passwd",
            "127.0.0.1",
            "http:127.0.0.1",
            "http:///127.0.0.1",
            "http://",
            "http://:80/",
            "http://１２７.０.０.１/",
            "javascript:http://127.0.0.1/",
        ] {
            assert_eq!(endpoint(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_hosts_file_cannot_move_localhost() {
        // The rewrite is what protects the key: the URL that is used never names localhost, so no resolver is asked.
        assert!(!endpoint("http://localhost:1/x").unwrap_or_default().contains("localhost"));
    }
}
