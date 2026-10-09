//! One conditional GitHub API call through the GitHub CLI.
//!
//! `gh api -i` prints the HTTP status line, the headers and the body to stdout, and exits 1 for every non-2xx answer, a 304
//! included (gh 2.102 prints `gh: HTTP 304` on stderr). So the answer is read from the status line, never from the exit code.
use super::cfg::Cfg;
use serde_json::Value;
use std::collections::BTreeMap;
use std::process::Command;
use std::time::Duration;

/// A parsed answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resp {
    /// The HTTP status code.
    pub status: u16,
    /// The headers, names in lower case.
    pub headers: BTreeMap<String, String>,
    /// The body (empty for a 304).
    pub body: String,
}

/// Why a call produced no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fail {
    /// The command could not be started (gh is not installed).
    Missing,
    /// It did not finish in time.
    Timeout,
    /// It ran but printed no HTTP status line; the text it wrote to stderr says why (not logged in, no network).
    NoResponse(String),
}

/// Something that can make a conditional GET: the real `gh`, or a stub in a test.
pub trait Runner {
    /// GET `path` (relative to the API root) with `If-None-Match: etag` when one is given.
    fn call(&self, path: &str, etag: Option<&str>) -> Result<Resp, Fail>;
}

/// Parse the stdout of `gh api -i`: status line, headers, a blank line, the body.
pub fn parse(stdout: &str) -> Option<Resp> {
    let (head, body) = match stdout.find("\r\n\r\n") {
        Some(i) => (&stdout[..i], &stdout[i + 4..]),
        None => match stdout.find("\n\n") {
            Some(i) => (&stdout[..i], &stdout[i + 2..]),
            None => (stdout, ""),
        },
    };
    let mut lines = head.lines();
    let first = lines.next()?.trim();
    let mut words = first.split_whitespace();
    if !words.next()?.starts_with("HTTP/") {
        return None;
    }
    let status: u16 = words.next()?.parse().ok()?;
    let headers = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    Some(Resp { status, headers, body: body.to_string() })
}

impl Resp {
    /// A numeric header (by its `github_rt.headers` name), if present and numeric.
    pub fn num_header(&self, cfg: &Cfg, name: &str) -> Option<u64> {
        self.headers.get(&cfg.txt("github_rt.headers", name)).and_then(|v| v.trim().parse().ok())
    }

    /// The body as JSON, `Null` when it is not.
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

/// The real runner: the configured `gh` command.
pub struct GhRunner {
    argv: Vec<String>,
    etag_header: String,
    accept: String,
    timeout: Duration,
}

impl GhRunner {
    /// A runner built from `github_rt.gh` and `github_rt.call_timeout_ms`.
    pub fn new(cfg: &Cfg) -> GhRunner {
        GhRunner {
            argv: cfg.list_field("github_rt.gh", "argv"),
            etag_header: cfg.txt("github_rt.gh", "etag_header"),
            accept: cfg.txt("github_rt.gh", "accept"),
            timeout: Duration::from_millis(cfg.int("github_rt.call_timeout_ms")),
        }
    }
}

impl Runner for GhRunner {
    fn call(&self, path: &str, etag: Option<&str>) -> Result<Resp, Fail> {
        let Some((prog, rest)) = self.argv.split_first() else { return Err(Fail::Missing) };
        let mut cmd = Command::new(prog);
        cmd.args(rest);
        if !self.accept.is_empty() {
            cmd.arg("-H").arg(&self.accept);
        }
        if let Some(e) = etag.filter(|e| !e.is_empty()) {
            cmd.arg("-H").arg(self.etag_header.replace("{etag}", e));
        }
        cmd.arg(path);
        let poll = crate::defaults::millis("client.fallback_poll_ms");
        match crate::proc::run(cmd, "gh", self.timeout, poll) {
            Ok(o) => {
                let out = String::from_utf8_lossy(&o.stdout);
                parse(&out).ok_or_else(|| Fail::NoResponse(String::from_utf8_lossy(&o.stderr).into_owned()))
            }
            Err(crate::proc::Error::Spawn(e)) if e.kind() == std::io::ErrorKind::NotFound => Err(Fail::Missing),
            Err(crate::proc::Error::Spawn(e)) => Err(Fail::NoResponse(e.to_string())),
            Err(crate::proc::Error::Timeout) => Err(Fail::Timeout),
            Err(e) => Err(Fail::NoResponse(format!("{e:?}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_headers_and_body() {
        let r = parse("HTTP/2.0 200 OK\r\nEtag: W/\"a\"\r\nX-Ratelimit-Used: 7\r\n\r\n{\"a\":1}").unwrap();
        assert_eq!((r.status, r.headers["etag"].as_str(), r.headers["x-ratelimit-used"].as_str(), r.body.as_str()), (200, "W/\"a\"", "7", "{\"a\":1}"));
        let r = parse("HTTP/2.0 304 Not Modified\nEtag: \"a\"\n\n").unwrap();
        assert_eq!((r.status, r.body.as_str()), (304, ""));
    }

    #[test]
    fn rejects_text_that_is_not_an_http_answer() {
        assert!(parse("").is_none());
        assert!(parse("gh: To use GitHub CLI, run: gh auth login").is_none());
        assert!(parse("HTTP/2.0 abc\n\n").is_none());
    }
}
