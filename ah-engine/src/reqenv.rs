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
///
/// It is *incomplete* when the checks cannot trust it to say what the Node guards would read: the client's variables
/// were dropped (over `request_env.max_bytes`), the request carried no environment line, or the client had no usable
/// `HOME`. An incomplete environment makes every check that reads the environment defer to Node (see
/// [`crate::checks::run_env_guarded`]), because evaluating with no home and default switches would answer for a
/// different session (a gate that is on would read as off, and the engine would allow what Node blocks).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(from = "BTreeMap<String, String>")]
pub struct RequestEnv {
    vars: BTreeMap<String, String>,
    incomplete: bool,
}

impl Serialize for RequestEnv {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let mut m = self.vars.clone();
        if self.incomplete {
            m.insert(defaults::text("request_env.incomplete_key").into(), "1".into());
        }
        m.serialize(ser)
    }
}

impl From<BTreeMap<String, String>> for RequestEnv {
    /// Keep only the allowlisted names (whatever sent the map, the daemon never evaluates with more), and none at all
    /// (flagged incomplete) when the rest would exceed `request_env.max_bytes`.
    fn from(m: BTreeMap<String, String>) -> Self {
        let flagged = m.contains_key(defaults::text("request_env.incomplete_key"));
        let kept: BTreeMap<String, String> = m.into_iter().filter(|(k, _)| allowed(k)).collect();
        let size: usize = kept.iter().map(|(k, v)| k.len() + v.len()).sum();
        if size as u64 > defaults::num("request_env.max_bytes") {
            return RequestEnv { vars: BTreeMap::new(), incomplete: true };
        }
        RequestEnv { vars: kept, incomplete: flagged }
    }
}

impl RequestEnv {
    /// The current process's allowlisted variables: what a client forwards, and what an in-process check sees.
    ///
    /// A process with no usable `HOME` (unset or empty) is incomplete too: Node falls back to the account's home
    /// directory there, which the engine does not read, so the checks must not evaluate against "no home".
    pub fn capture() -> RequestEnv {
        RequestEnv::from_process_vars(std::env::vars().collect())
    }

    fn from_process_vars(vars: BTreeMap<String, String>) -> RequestEnv {
        let no_home = vars.get("HOME").is_none_or(|h| h.is_empty());
        let mut e = RequestEnv::from(vars);
        e.incomplete |= no_home;
        e
    }

    /// An environment the checks must not evaluate with (see the type's docs): they defer to Node instead.
    pub fn incomplete() -> RequestEnv {
        RequestEnv { vars: BTreeMap::new(), incomplete: true }
    }

    /// True when the checks that read the environment must defer to Node.
    pub fn is_incomplete(&self) -> bool {
        self.incomplete
    }

    /// An environment from explicit pairs (tests, `ah-engine check`); filtered like any other.
    pub fn from_pairs<K: Into<String>, V: Into<String>>(pairs: impl IntoIterator<Item = (K, V)>) -> RequestEnv {
        RequestEnv::from(pairs.into_iter().map(|(k, v)| (k.into(), v.into())).collect::<BTreeMap<_, _>>())
    }

    /// The value of `name`.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(String::as_str)
    }

    /// The variables as an owned map.
    pub fn to_map(&self) -> std::collections::HashMap<String, String> {
        self.vars.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// The request line that carries this environment (without the trailing newline).
    pub fn to_line(&self) -> String {
        format!("{}{}", defaults::text("request_env.line_prefix"), serde_json::to_string(self).unwrap_or_else(|_| "{}".into()))
    }
}

/// Split a hook request body into its environment and the payload. A body without the environment line (or with one
/// that does not parse) has an incomplete, empty environment: the daemon never fills the gap from its own, and its
/// checks defer.
pub fn split_request(body: &str) -> (RequestEnv, &str) {
    let Some(rest) = body.strip_prefix(defaults::text("request_env.line_prefix")) else { return (RequestEnv::incomplete(), body) };
    let (line, payload) = rest.split_once('\n').unwrap_or((rest, ""));
    (serde_json::from_str(line).unwrap_or_else(|_| RequestEnv::incomplete()), payload)
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
    fn the_git_object_store_variables_are_forwarded() {
        for name in ["GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NO_REPLACE_OBJECTS"] {
            assert!(allowed(name), "{name} changes what git reads, so the git check must see the client's value");
            assert_eq!(RequestEnv::from_pairs([(name, "v")]).get(name), Some("v"));
        }
        assert!(!allowed("GIT_AUTHOR_NAME") && !allowed("GIT_TRACE"), "and nothing else under GIT_ rides along");
    }

    #[test]
    fn the_request_line_round_trips_and_a_bare_body_has_no_environment() {
        let e = RequestEnv::from_pairs([("HOME", "/h\nx"), ("ANTIHALL_X", "é\"")]);
        let body = format!("{}\n{{\"a\":1}}", e.to_line());
        let (back, payload) = split_request(&body);
        assert_eq!((back, payload), (e, "{\"a\":1}"));
        let (none, payload) = split_request("{\"a\":1}");
        assert_eq!((none, payload), (RequestEnv::incomplete(), "{\"a\":1}"));
    }

    #[test]
    fn an_oversized_environment_is_dropped_whole() {
        let big = "x".repeat(defaults::num("request_env.max_bytes") as usize);
        let e = RequestEnv::from_pairs([("HOME", big)]);
        assert_eq!((e.get("HOME"), e.is_incomplete()), (None, true), "dropped whole, and flagged so the checks defer");
    }

    #[test]
    fn the_incomplete_flag_survives_the_wire() {
        let big = "x".repeat(defaults::num("request_env.max_bytes") as usize);
        let dropped = RequestEnv::from_pairs([("HOME", big)]);
        let (back, _) = split_request(&format!("{}\n{{}}", dropped.to_line()));
        assert!(back.is_incomplete(), "the daemon must see that the client's environment was dropped");
        let (ok, _) = split_request(&format!("{}\n{{}}", RequestEnv::from_pairs([("HOME", "/h")]).to_line()));
        assert!(!ok.is_incomplete());
        assert!(!allowed(defaults::text("request_env.incomplete_key")), "the flag is not a forwardable variable");
    }

    #[test]
    fn a_bare_or_garbled_request_line_is_incomplete() {
        assert!(split_request("{}").0.is_incomplete());
        assert!(split_request("E not-json\n{}").0.is_incomplete());
    }

    #[test]
    fn a_missing_or_empty_home_makes_the_captured_environment_incomplete() {
        let vars = |h: Option<&str>| h.map(|h| ("HOME".to_string(), h.to_string())).into_iter().collect::<BTreeMap<_, _>>();
        assert!(RequestEnv::from_process_vars(vars(None)).is_incomplete());
        assert!(RequestEnv::from_process_vars(vars(Some(""))).is_incomplete());
        assert!(!RequestEnv::from_process_vars(vars(Some("/h"))).is_incomplete());
    }

    #[test]
    fn a_daemon_side_filter_applies_to_whatever_the_wire_carried() {
        let (e, _) = split_request("E {\"HOME\":\"/h\",\"LD_PRELOAD\":\"/evil\"}\n{}");
        assert_eq!((e.get("HOME"), e.get("LD_PRELOAD")), (Some("/h"), None));
    }
}
