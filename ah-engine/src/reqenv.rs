//! The environment of one request (D76).
//!
//! A hook runs in its host's environment, and the Node guards read switches, the home directory and the entry point
//! from it. The daemon's own environment is a different thing (it was started once, by whichever client came first), so a
//! check evaluated with it would answer for the wrong session. The client therefore forwards the variables the checks
//! read (`request_env.allow`) with each request, and every check runs against that [`RequestEnv`], never the process's.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::defaults;

/// Whether `name` is on the forwarding allowlist (`request_env.allow`; a trailing `*` matches a prefix).
pub fn allowed(name: &str) -> bool {
    defaults::list("request_env.allow").into_iter().any(|a| a.strip_suffix('*').map_or(a == name, |prefix| name.starts_with(prefix)))
}

/// The allowlisted environment of one request.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "BTreeMap<String, String>")]
pub struct RequestEnv(BTreeMap<String, String>);

impl From<BTreeMap<String, String>> for RequestEnv {
    /// Keep only the allowlisted names (whatever sent the map, the daemon never evaluates with more), and none at all
    /// when the rest would exceed `request_env.max_bytes`.
    fn from(m: BTreeMap<String, String>) -> Self {
        let kept: BTreeMap<String, String> = m.into_iter().filter(|(k, _)| allowed(k)).collect();
        let size: usize = kept.iter().map(|(k, v)| k.len() + v.len()).sum();
        if size as u64 > defaults::num("request_env.max_bytes") {
            return RequestEnv::default();
        }
        RequestEnv(kept)
    }
}

impl RequestEnv {
    /// The current process's allowlisted variables: what a client forwards, and what an in-process check sees.
    pub fn capture() -> RequestEnv {
        RequestEnv::from(std::env::vars().collect::<BTreeMap<_, _>>())
    }

    /// An environment from explicit pairs (tests, `ah-engine check`); filtered like any other.
    pub fn from_pairs<K: Into<String>, V: Into<String>>(pairs: impl IntoIterator<Item = (K, V)>) -> RequestEnv {
        RequestEnv::from(pairs.into_iter().map(|(k, v)| (k.into(), v.into())).collect::<BTreeMap<_, _>>())
    }

    /// The value of `name`.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }

    /// The variables as an owned map.
    pub fn to_map(&self) -> std::collections::HashMap<String, String> {
        self.0.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// The request line that carries this environment (without the trailing newline).
    pub fn to_line(&self) -> String {
        format!("{}{}", defaults::text("request_env.line_prefix"), serde_json::to_string(self).unwrap_or_else(|_| "{}".into()))
    }
}

/// Split a hook request body into its environment and the payload. A body without the environment line has an empty
/// environment: the daemon never fills the gap from its own.
pub fn split_request(body: &str) -> (RequestEnv, &str) {
    let Some(rest) = body.strip_prefix(defaults::text("request_env.line_prefix")) else { return (RequestEnv::default(), body) };
    let (line, payload) = rest.split_once('\n').unwrap_or((rest, ""));
    (serde_json::from_str(line).unwrap_or_default(), payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allowlisted_names_survive() {
        let e = RequestEnv::from_pairs([("HOME", "/h"), ("ANTIHALL_X", "1"), ("CLAUDE_PLUGIN_OPTION_A", "b"), ("SECRET_TOKEN", "no"), ("AWS_KEY", "no")]);
        assert_eq!(e.get("HOME"), Some("/h"));
        assert_eq!(e.get("ANTIHALL_X"), Some("1"));
        assert_eq!(e.get("CLAUDE_PLUGIN_OPTION_A"), Some("b"));
        assert_eq!(e.get("SECRET_TOKEN"), None);
        assert_eq!(e.get("AWS_KEY"), None);
    }

    #[test]
    fn the_request_line_round_trips_and_a_bare_body_has_no_environment() {
        let e = RequestEnv::from_pairs([("HOME", "/h\nx"), ("ANTIHALL_X", "é\"")]);
        let body = format!("{}\n{{\"a\":1}}", e.to_line());
        let (back, payload) = split_request(&body);
        assert_eq!((back, payload), (e, "{\"a\":1}"));
        let (none, payload) = split_request("{\"a\":1}");
        assert_eq!((none, payload), (RequestEnv::default(), "{\"a\":1}"));
    }

    #[test]
    fn an_oversized_environment_is_dropped_whole() {
        let big = "x".repeat(defaults::num("request_env.max_bytes") as usize);
        assert_eq!(RequestEnv::from_pairs([("HOME", big)]), RequestEnv::default());
    }

    #[test]
    fn a_daemon_side_filter_applies_to_whatever_the_wire_carried() {
        let (e, _) = split_request("E {\"HOME\":\"/h\",\"LD_PRELOAD\":\"/evil\"}\n{}");
        assert_eq!((e.get("HOME"), e.get("LD_PRELOAD")), (Some("/h"), None));
    }
}
