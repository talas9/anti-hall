//! The settings the judge reads: the model alias, the backend, the per-integration backend switches and whether an
//! Anthropic key is visible. Each is read with the same precedence chain as the Node hooks (`hooks/lib/settings.js`).
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, get_enum, get_string};
use crate::checks::guardkit::text::js_trim;
use crate::defaults;

/// `jev.judgeModel`: an alias (Node: `String(settings.get('jev', 'judgeModel') || '').trim() || 'haiku'`).
pub fn model(st: &Settings) -> String {
    let entry = defaults::raw("judge.model_setting");
    let m = js_trim(&get_string(st, entry)).to_string();
    if m.is_empty() { entry.str_field("default").to_string() } else { m }
}

/// Whether the Anthropic key the Node judge would use is visible (Node: `credentials.js` `resolveKey('anthropic')`, then
/// `key.trim()`): the plugin option, else `ANTHROPIC_API_KEY` when the home-only opt-in is on. Only presence is read.
/// `None` when it cannot be told: the opt-in is on but `st.env` is a request's allowlisted environment, which never
/// carries `ANTHROPIC_API_KEY` (`env_complete` false); the caller then leaves the decision to Node.
pub fn anthropic_key_visible(st: &Settings, env_complete: bool) -> Option<bool> {
    let non_empty = |name: &str| st.env.get(name).is_some_and(|v| !js_trim(v).is_empty());
    if non_empty(defaults::text("judge.anthropic_key_env")) {
        return Some(true);
    }
    if !get_bool(st, defaults::raw("judge.anthropic_env_optin")) {
        return Some(false);
    }
    let legacy = defaults::text("judge.anthropic_legacy_env");
    if env_complete || st.env.contains_key(legacy) { Some(non_empty(legacy)) } else { None }
}

/// How a judge call reaches the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// The local Claude CLI: the engine runs it.
    Cli,
    /// The Anthropic Messages API with a visible key: left to Node.
    Api,
    /// The API without a key: Node makes no call at all.
    NoKey,
    /// The answer depends on a key this environment cannot show: left to Node.
    Unknown,
}

/// `jev.judgeBackend` resolved the way speculation-judge.js does: `auto` is api with a key, else cli; api without a key is
/// no call.
pub fn route(st: &Settings, env_complete: bool) -> Route {
    let b = get_enum(st, defaults::raw("judge.backend_setting"));
    if b == defaults::text("judge.backend_cli") {
        return Route::Cli;
    }
    match (anthropic_key_visible(st, env_complete), b == defaults::text("judge.backend_auto")) {
        (None, _) => Route::Unknown,
        (Some(true), _) => Route::Api,
        (Some(false), true) => Route::Cli,
        (Some(false), false) => Route::NoKey,
    }
}

/// The value of a per-integration backend switch (`jev.speculationBackend`, `jev.triageBackend`).
pub fn integration_backend(st: &Settings, setting: &defaults::V) -> String {
    get_enum(st, setting)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn st(pairs: &[(&str, &str)]) -> Settings {
        Settings { home: "/nonexistent-ah-home".into(), env: pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>() }
    }

    #[test]
    fn the_route_follows_the_backend_and_the_key() {
        let route = |s: &Settings| route(s, false);
        assert_eq!(route(&st(&[])), Route::NoKey);
        assert_eq!(route(&st(&[("CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY", "k")])), Route::Api);
        assert_eq!(route(&st(&[("ANTIHALL_JUDGE_BACKEND", "cli"), ("CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY", "k")])), Route::Cli);
        assert_eq!(route(&st(&[("ANTIHALL_JUDGE_BACKEND", " AUTO ")])), Route::Cli);
        assert_eq!(route(&st(&[("ANTIHALL_JUDGE_BACKEND", "auto"), ("CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY", " k ")])), Route::Api);
        assert_eq!(route(&st(&[("ANTIHALL_JUDGE_BACKEND", "auto"), ("CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY", "  ")])), Route::Cli);
        // the legacy variable counts only with the home-file opt-in, never by itself
        assert_eq!(route(&st(&[("ANTHROPIC_API_KEY", "k")])), Route::NoKey);
    }

    #[test]
    fn the_legacy_key_opt_in_cannot_be_judged_from_a_request_environment() {
        let home = std::env::temp_dir().join(format!("ah-judge-optin-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
        std::fs::write(home.join(".anti-hall/settings.json"), r#"{"guards":{"allowAnthropicEnvKey":true}}"#).unwrap();
        let s = |pairs: &[(&str, &str)]| Settings { home: home.to_string_lossy().into_owned(), ..st(pairs) };
        assert_eq!(route(&s(&[]), false), Route::Unknown, "the request never carries ANTHROPIC_API_KEY");
        assert_eq!(route(&s(&[]), true), Route::NoKey);
        assert_eq!(route(&s(&[("ANTHROPIC_API_KEY", "k")]), true), Route::Api);
        assert_eq!(route(&s(&[("ANTIHALL_JUDGE_BACKEND", "cli")]), false), Route::Cli);
        assert_eq!(route(&s(&[("ANTIHALL_JUDGE_BACKEND", "auto")]), false), Route::Unknown);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn the_model_is_an_alias_from_settings() {
        assert_eq!(model(&st(&[])), "haiku");
        assert_eq!(model(&st(&[("ANTIHALL_JUDGE_MODEL", " sonnet ")])), "sonnet");
        assert_eq!(model(&st(&[("ANTIHALL_JUDGE_MODEL", "  ")])), "haiku");
    }
}
