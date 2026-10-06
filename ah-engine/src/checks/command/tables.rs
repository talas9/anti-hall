//! The command check's tables, patterns and limits, loaded once from `defaults/command.toml` (D17, D30).
//!
//! Why a struct built once: the scans consult these sets and compiled patterns for every segment, so each table is
//! turned into a set or a compiled regex on first use and shared for the life of the process. The text of the tables
//! lives only in the TOML file.
use crate::defaults;
use crate::defaults::V;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// A `LIGHT_EXCEPTIONS` entry with a trailing negative lookahead, split into the parts a Rust regex can run.
pub struct NegLight {
    /// The pattern up to (not including) the trailing word boundary, anchored with `$` so it can test a prefix.
    pub head: Regex,
    /// The literal text every match of `head` ends with (lower-case), used to enumerate the candidate end points.
    pub end: String,
    /// The text that must not follow the match on the same line.
    pub not_after: Regex,
}

/// Every table of the command check.
pub struct Tables {
    /// One-line summary for the generated reference.
    pub summary: String,
    /// Longest command the engine judges.
    pub max_len: usize,
    /// Inline-shell / substitution depth the scans follow.
    pub max_depth: usize,
    /// Substrings that make the engine defer.
    pub defer_substrings: Vec<String>,
    /// DevSwarm CLI verbs.
    pub devswarm_verbs: std::collections::HashSet<String>,
    /// Path parts that make the engine defer.
    pub defer_path_parts: Vec<String>,
    /// Wrapper words.
    pub wrappers: HashSet<String>,
    /// sudo value options.
    pub sudo_value: HashSet<String>,
    /// timeout value options.
    pub timeout_value: HashSet<String>,
    /// nice value options.
    pub nice_value: HashSet<String>,
    /// taskpolicy value options.
    pub taskpolicy_value: HashSet<String>,
    /// Shell programs.
    pub shell_verbs: HashSet<String>,
    /// Keywords that put a test at command position.
    pub test_keywords: HashSet<String>,
    /// Verbs whose first operand is a pattern.
    pub pattern_first_verbs: HashSet<String>,
    /// Always-heavy verbs.
    pub heavy_verbs: HashSet<String>,
    /// Heavy patterns.
    pub heavy_patterns: Vec<Regex>,
    /// Light-exception patterns.
    pub light: Vec<Regex>,
    /// Light-exception patterns with a negative lookahead.
    pub light_neg: Vec<NegLight>,
    /// Leading control keywords.
    pub control_prefix: Regex,
    /// Leading `timeout N`.
    pub timeout_prefix: Regex,
    /// Interpreters for the flagged-script test.
    pub script_interp: Regex,
    /// node script extensions.
    pub node_ext: Regex,
    /// python (and other) script extension.
    pub py_ext: Regex,
    /// node inline-code flags.
    pub node_eval_flags: HashSet<String>,
    /// Unsafe `node -e` payload patterns.
    pub node_eval_deny: Vec<Regex>,
    /// An fs method call in a payload.
    pub node_fs_call: Regex,
    /// Allowed fs read methods.
    pub node_fs_read: HashSet<String>,
    /// git global value options.
    pub git_global_value: HashSet<String>,
    /// Dangerous git fetch flags.
    pub git_fetch_dangerous: HashSet<String>,
    /// Always-heavy git subcommands.
    pub git_heavy_subs: HashSet<String>,
    /// sqlite3 write escapes.
    pub sqlite_dangerous: Regex,
    /// Cloud CLIs with an inspect exemption.
    pub cloud_binaries: HashSet<String>,
    /// Read-only first words for gh/kubectl.
    pub cloud_readonly: HashSet<String>,
    /// Mutating words for gh/kubectl.
    pub cloud_mutating: HashSet<String>,
    /// gcloud read verbs.
    pub gcloud_inspect: HashSet<String>,
    /// gcloud refused path words.
    pub gcloud_refused: Regex,
    /// gcloud boolean flags.
    pub gcloud_bool: HashSet<String>,
    /// gcloud value flags.
    pub gcloud_value: HashSet<String>,
    /// The gcloud group whose `read` is read-only.
    pub gcloud_logging: String,
    /// CLIs of the whole-command read-only form.
    pub whole_clis: Vec<String>,
    /// gh heavy group -> subcommands.
    pub gh_mutating: HashMap<String, HashSet<String>>,
    /// gh api heavy methods.
    pub gh_api_methods: HashSet<String>,
    /// gh api body options.
    pub gh_field_flags: HashSet<String>,
    /// gh graphql value options.
    pub gh_gql_value: HashSet<String>,
    /// gh graphql boolean options.
    pub gh_gql_bool: HashSet<String>,
    /// Inline-code interpreters.
    pub inline_verbs: HashSet<String>,
    /// python inline flags.
    pub inline_python_flags: Vec<String>,
    /// perl/ruby/node inline flags.
    pub inline_other_flags: Vec<String>,
    /// Markers of a possible inline write.
    pub inline_write_markers: Vec<String>,
    /// Characters that make a write target unknowable.
    pub unknowable: Vec<char>,
}

fn strings(key: &str) -> Vec<String> {
    defaults::list(key).into_iter().map(str::to_string).collect()
}

fn set(key: &str) -> HashSet<String> {
    strings(key).into_iter().collect()
}

fn text(key: &str) -> String {
    defaults::text(key).to_string()
}

fn re(src: &str) -> Regex {
    crate::checks::lit_re(src)
}

fn build() -> Tables {
    let neg = defaults::raw("command.light_exceptions_neg")
        .as_array()
        .unwrap_or(&[])
        .iter()
        .map(|v: &V| NegLight {
            head: re(&format!("{}$", v.str_field("head"))),
            end: v.str_field("end").to_ascii_lowercase(),
            not_after: re(v.str_field("not_after")),
        })
        .collect();
    let gh = defaults::raw("command.gh_mutating_subcommands")
        .as_table()
        .map(|t| t.iter().map(|(k, v)| (k.to_string(), v.strings().into_iter().map(str::to_string).collect())).collect())
        .unwrap_or_default();
    Tables {
        summary: text("command.check_summary"),
        max_len: defaults::num("command.max_classify_len") as usize,
        max_depth: defaults::num("command.max_depth") as usize,
        defer_substrings: strings("command.defer_substrings"),
        devswarm_verbs: set("command.devswarm_cli_verbs"),
        defer_path_parts: strings("command.defer_path_parts"),
        wrappers: set("command.wrappers"),
        sudo_value: set("command.sudo_value_flags"),
        timeout_value: set("command.timeout_value_flags"),
        nice_value: set("command.nice_value_flags"),
        taskpolicy_value: set("command.taskpolicy_value_flags"),
        shell_verbs: set("command.shell_verbs"),
        test_keywords: set("command.test_keywords"),
        pattern_first_verbs: set("command.pattern_first_verbs"),
        heavy_verbs: set("command.heavy_verbs"),
        heavy_patterns: strings("command.heavy_patterns").iter().map(|s| re(s)).collect(),
        light: strings("command.light_exceptions").iter().map(|s| re(s)).collect(),
        light_neg: neg,
        control_prefix: re(&text("command.control_keyword_prefix")),
        timeout_prefix: re(&text("command.timeout_prefix")),
        script_interp: re(&text("command.script_check_interpreter")),
        node_ext: re(&text("command.node_script_ext")),
        py_ext: re(&text("command.python_script_ext")),
        node_eval_flags: set("command.node_eval_flags"),
        node_eval_deny: strings("command.node_eval_deny").iter().map(|s| re(s)).collect(),
        node_fs_call: re(&text("command.node_fs_method_call")),
        node_fs_read: set("command.node_fs_read_allowlist"),
        git_global_value: set("command.git_global_value_opts"),
        git_fetch_dangerous: set("command.git_fetch_dangerous_flags"),
        git_heavy_subs: set("command.git_heavy_subs"),
        sqlite_dangerous: re(&text("command.sqlite_dangerous")),
        cloud_binaries: set("command.cloud_binaries"),
        cloud_readonly: set("command.cloud_readonly_verbs"),
        cloud_mutating: set("command.cloud_mutating_verbs"),
        gcloud_inspect: set("command.gcloud_inspect_verbs"),
        gcloud_refused: re(&text("command.gcloud_refused_path")),
        gcloud_bool: set("command.gcloud_boolean_flags"),
        gcloud_value: set("command.gcloud_value_flags"),
        gcloud_logging: text("command.gcloud_logging_group"),
        whole_clis: strings("command.whole_command_clis"),
        gh_mutating: gh,
        gh_api_methods: set("command.gh_api_mutating_methods"),
        gh_field_flags: set("command.gh_api_field_flags"),
        gh_gql_value: set("command.gh_gql_value_flags"),
        gh_gql_bool: set("command.gh_gql_bool_flags"),
        inline_verbs: set("command.inline_verbs"),
        inline_python_flags: strings("command.inline_python_flags"),
        inline_other_flags: strings("command.inline_other_flags"),
        inline_write_markers: strings("command.inline_write_markers"),
        unknowable: text("command.write_target_unknowable").chars().collect(),
    }
}

/// The command check's tables (built on first use).
pub fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(build)
}
