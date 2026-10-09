//! Typed errors of the Jev lane (D39).
//!
//! A Jev failure never reaches a caller as an error: every call degrades to the caller's own baseline (D35), and the
//! reason is recorded as [`Reason`]. These types cover the places where a failure is reported rather than absorbed:
//! loading and validating configuration, writing the decision log, and parsing a request from the command line.
use std::fmt;

/// An error of the Jev lane.
#[derive(Debug)]
pub enum JevError {
    /// Reading or writing a file failed (the path is part of the message, never a key or a prompt).
    Io {
        /// What was being done and to which file.
        what: String,
        /// The underlying error.
        source: std::io::Error,
    },
    /// A shipped or user setting is unusable.
    Config(String),
    /// A request could not be understood (bad JSON, a missing field).
    Request(String),
}

impl fmt::Display for JevError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JevError::Io { what, source } => write!(f, "{what}: {source}"),
            JevError::Config(m) => write!(f, "jev config: {m}"),
            JevError::Request(m) => write!(f, "jev request: {m}"),
        }
    }
}

impl std::error::Error for JevError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            JevError::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// Why a Jev call produced no usable answer. Written to the decision log's `reason` field as text, in the spelling the
/// Node client uses, so `jev report` reads both sources alike (Node: the `reason` of every `{ok:false}` result).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    /// Jev is disabled.
    Disabled,
    /// No key resolved for the vendor.
    NoKey,
    /// The call ran out of its time budget.
    Timeout,
    /// The connection failed, or the server answered with a redirect (which is never followed).
    NetworkError,
    /// The server answered with this non-success status.
    Http(u16),
    /// The body was not JSON.
    ParseError,
    /// The JSON did not carry a usable answer.
    BadResponse,
    /// The question was not a Noul or Choice question.
    BadQuestion,
    /// The state text was empty.
    BadState,
    /// Both vendors' breakers are open, so no call was made.
    CircuitOpen,
    /// The asynchronous queue was full, so no call was made.
    Busy,
    /// Only the fallback was asked for, and none is configured.
    NoFallback,
    /// An unexpected failure inside the call.
    Error,
}

impl fmt::Display for Reason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Reason::Disabled => f.write_str("disabled"),
            Reason::NoKey => f.write_str("no-key"),
            Reason::Timeout => f.write_str("timeout"),
            Reason::NetworkError => f.write_str("network-error"),
            Reason::Http(s) => write!(f, "http-{s}"),
            Reason::ParseError => f.write_str("parse-error"),
            Reason::BadResponse => f.write_str("bad-response"),
            Reason::BadQuestion => f.write_str("bad-question"),
            Reason::BadState => f.write_str("bad-state"),
            Reason::CircuitOpen => f.write_str("circuit-open"),
            Reason::Busy => f.write_str("busy"),
            Reason::NoFallback => f.write_str("no-fallback"),
            Reason::Error => f.write_str("error"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_use_the_node_spelling() {
        assert_eq!(Reason::Http(429).to_string(), "http-429");
        assert_eq!(Reason::NetworkError.to_string(), "network-error");
        assert_eq!(Reason::CircuitOpen.to_string(), "circuit-open");
    }

    #[test]
    fn io_errors_name_the_action_and_expose_the_source() {
        let e = JevError::Io { what: "append the decision log".into(), source: std::io::Error::other("disk full") };
        assert!(e.to_string().contains("append the decision log: disk full"));
        assert!(std::error::Error::source(&e).is_some());
    }
}
