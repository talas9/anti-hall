//! The git check's tables, limits and setting names, loaded once from `defaults/git.toml` (D17, D30).
//!
//! Why a struct built once instead of reading the defaults at each use: the parsers consult these tables in inner
//! loops (is this word a wrapper? is this option a value option?), so each table is turned into a set or a typed
//! value on first use and shared for the life of the process. The text of the tables lives only in the TOML file.
use crate::defaults;
use crate::defaults::V;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// An ordered list of words with constant-time membership tests.
#[derive(Debug, Default, Clone)]
pub struct Words {
    list: Vec<String>,
    set: HashSet<String>,
}

impl Words {
    fn new(list: Vec<String>) -> Words {
        let set = list.iter().cloned().collect();
        Words { list, set }
    }

    /// True when `w` is in the list.
    pub fn has(&self, w: &str) -> bool {
        self.set.contains(w)
    }

    /// The words in their shipped order.
    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.list.iter().map(String::as_str)
    }
}

/// Option grammar of one git or gh command in a heredoc-fed context (`hd_specs` / `hd_gh_spec`).
#[derive(Debug, Default, Clone)]
pub struct Spec {
    /// Short flags without a value.
    pub s: String,
    /// Short flags with a value.
    pub v: String,
    /// Short flags with an optional value.
    pub o: String,
    /// Long flags without a value.
    pub l: HashSet<String>,
    /// Long flags with a value.
    pub big_l: HashSet<String>,
    /// Long flags with an optional value.
    pub big_o: HashSet<String>,
    /// A numeric `-<n>` option is allowed.
    pub num: bool,
    /// Unknown options are not data.
    pub strict: bool,
}

/// Option grammar of a wrapper command that has options (`opt_wrappers`).
#[derive(Debug, Default, Clone)]
pub struct OptWrapper {
    /// Short flags without a value.
    pub s: String,
    /// Short flags with a value.
    pub v: String,
    /// Long flags without a value.
    pub l: Vec<String>,
    /// Long flags with a value.
    pub big_l: Vec<String>,
    /// Operands consumed before the wrapped command.
    pub ops: usize,
}

/// Where one on/off switch is read from: settings.json section and key, environment variable, plugin option.
#[derive(Debug, Default, Clone)]
pub struct Switch {
    /// settings.json section.
    pub section: String,
    /// settings.json key.
    pub key: String,
    /// Environment variable.
    pub env: String,
    /// Plugin-option name (empty when the switch has none).
    pub option: String,
}

/// Every table, limit and name of the git check.
#[derive(Debug, Default)]
pub struct Tables {
    /// Words looked through when finding the real command.
    pub wrappers: Words,
    /// Options that take a value, per wrapper (sudo, timeout, nice).
    pub wrapper_value_opts: HashMap<String, Words>,
    /// Shell programs whose `-c` is a script.
    pub shell_verbs: Words,
    /// Wrapper commands with their own option grammar.
    pub opt_wrappers: HashMap<String, OptWrapper>,
    /// xargs short options with a value.
    pub xargs_short_req: String,
    /// xargs short options with an optional value.
    pub xargs_short_opt: String,
    /// xargs long options with a value.
    pub xargs_long_req: Words,
    /// xargs long options without a value.
    pub xargs_long_other: Words,
    /// find actions that run a command.
    pub find_exec_flags: Words,
    /// parallel argument-source separators.
    pub parallel_separators: Words,
    /// Shell redirection operators.
    pub redirect_words: Words,
    /// File copy, move and link commands.
    pub copy_verbs: Words,
    /// git subcommands.
    pub git_builtins: Words,
    /// git global options with a value.
    pub git_opts_with_value: Words,
    /// Long options of push.
    pub push_long_opts: Words,
    /// Subcommands that create a commit.
    pub commit_creating: Words,
    /// Long options of commit.
    pub commit_long: Words,
    /// Long options of commit with a value.
    pub commit_long_value: Words,
    /// Options of commit-style commands with a value.
    pub add_commit_value_opts: Words,
    /// Short commit flags that take a value in a cluster.
    pub commit_cluster_value_flags: String,
    /// Subcommands the backstop checks for credit.
    pub backstop_commit_subs: Words,
    /// The git program.
    pub git_binary: String,
    /// Environment names forwarded to git.
    pub forward_env_names: Words,
    /// `GIT_CONFIG_<name>` names forwarded.
    pub forward_config_names: Words,
    /// `GIT_CONFIG_<prefix><n>` families forwarded.
    pub forward_config_indexed: Vec<String>,
    /// Editors that leave a message untouched.
    pub noop_editors: Words,
    /// Names after Co-Authored-By that count as AI tools.
    pub credit_coauthor_alts: Vec<String>,
    /// `gpt-` prefix.
    pub credit_gpt_prefix: String,
    /// Version digits after the prefix that count.
    pub credit_gpt_versions: String,
    /// Names after "Generated with" that count as AI tools.
    pub credit_generated_alts: Vec<String>,
    /// gh body markers that credit an AI tool.
    pub gh_body_markers: Vec<String>,
    /// gh subcommands whose bodies are checked.
    pub gh_subs: Words,
    /// gh actions whose bodies are checked.
    pub gh_actions: Words,
    /// gh options carrying text as the next word.
    pub gh_value_opts: Words,
    /// gh options carrying text after `=`.
    pub gh_value_prefixes: Vec<String>,
    /// gh options naming a file as the next word.
    pub gh_file_opts: Words,
    /// gh options naming a file after `=`.
    pub gh_file_prefixes: Vec<String>,
    /// Commands a data heredoc may feed.
    pub heredoc_safe_verbs: Words,
    /// Subcommands taking a heredoc message.
    pub heredoc_git_msg_subs: Words,
    /// `git notes` subcommands a heredoc may feed.
    pub hd_notes_subs: Words,
    /// gh subcommands a heredoc may feed.
    pub hd_gh_subs: Words,
    /// gh actions a heredoc may feed.
    pub hd_gh_actions: Words,
    /// First words of script runners.
    pub hd_deny_first: Words,
    /// Directories a heredoc must not be written into.
    pub hd_bad_dirs: Words,
    /// git hook file names.
    pub git_hook_names: Words,
    /// Data file extensions.
    pub hd_data_ext: Words,
    /// Device paths accepted as data sinks.
    pub hd_sinks_basic: Words,
    /// Descriptor paths accepted as extra data sinks.
    pub hd_sinks_fd: Words,
    /// Per-subcommand option grammar for heredoc-fed commands.
    pub hd_specs: HashMap<String, Spec>,
    /// Option grammar of gh heredoc-fed commands.
    pub hd_gh_spec: Spec,
    /// Longest alias chain.
    pub max_chain: usize,
    /// Deepest alias expansion rescanned.
    pub alias_depth: usize,
    /// Nesting limit of the substitution scanners.
    pub max_nest: usize,
    /// Symlink hops followed.
    pub launcher_hops: usize,
    /// Longest tracked cd directory.
    pub cd_max_chars: usize,
    /// Most segments of a tracked cd directory.
    pub cd_max_segments: usize,
    /// Full commit hash length.
    pub commit_hash_len: usize,
    /// Shortened commit hash length.
    pub commit_hash_short: usize,
    /// Launcher filesystem budget per command.
    pub budget_launcher_fs: i32,
    /// Handover query budget per command.
    pub budget_handover_queries: i32,
    /// Handover evaluation budget per command.
    pub budget_handover_evals: i32,
    /// Alias query timeout.
    pub git_timeout: std::time::Duration,
    /// Handover query timeout.
    pub handover_git_timeout: std::time::Duration,
    /// Child poll interval.
    pub child_poll: std::time::Duration,
    /// Child output read allowance.
    pub child_read: std::time::Duration,
    /// Check thread stack size in bytes.
    pub stack_bytes: usize,
    /// Guard id.
    pub guard_name: String,
    /// Settings file, relative to home.
    pub settings_file: String,
    /// Skip file, relative to home.
    pub skip_file: String,
    /// Plugin option variable prefix.
    pub plugin_option_prefix: String,
    /// Master switch.
    pub setting_git_guard: Switch,
    /// Heredoc masking switch.
    pub setting_heredoc_data: Switch,
    /// Alias resolution switch.
    pub setting_alias_resolve: Switch,
    /// Reused message switch.
    pub setting_reused_message: Switch,
    /// Handover guard switch.
    pub setting_handover_guard: Switch,
    /// Launcher directory pattern.
    pub launcher_dir_pattern: String,
    /// Skip command template.
    pub skip_command: String,
    /// Handover directory prefix.
    pub handover_dir_prefix: String,
    /// Block message symbol.
    pub block_emoji: String,
    /// Block message label (also the alias-note insertion marker).
    pub block_mark: String,
    /// Reason label.
    pub label_why: String,
    /// Remedy label.
    pub label_instead: String,
    /// Allowed-here label.
    pub label_allowed: String,
    /// Override label.
    pub label_override: String,
    /// Tip appended to a file-write block.
    pub file_write_tip: String,
    /// Chain separator in notes.
    pub chain_joiner: String,
    /// Ellipsis for a cut list.
    pub more_marker: String,
}

fn key(name: &str) -> String {
    format!("git.{name}")
}

fn words(name: &str) -> Words {
    Words::new(defaults::list(&key(name)).into_iter().map(str::to_string).collect())
}

fn strings(name: &str) -> Vec<String> {
    defaults::list(&key(name)).into_iter().map(str::to_string).collect()
}

fn text(name: &str) -> String {
    defaults::text(&key(name)).to_string()
}

fn num(name: &str) -> u64 {
    defaults::num(&key(name))
}

fn set(s: &str) -> HashSet<String> {
    s.split_whitespace().map(str::to_string).collect()
}

fn field(t: &V, k: &str) -> String {
    t.str_field(k).to_string()
}

fn str_list(t: &V, k: &str) -> Vec<String> {
    t.get(k).map(|v| v.strings().into_iter().map(str::to_string).collect()).unwrap_or_default()
}

fn switch(name: &str) -> Switch {
    let t = defaults::raw(&key(name));
    Switch { section: field(t, "section"), key: field(t, "key"), env: field(t, "env"), option: field(t, "option") }
}

/// Build a `Spec` from a `hd_specs` entry, adding the shared read-only option sets when it asks for them.
fn spec_from(t: &V, read: &(String, String, String)) -> Spec {
    let wants_read = t.get("read").and_then(V::as_bool).unwrap_or(false);
    let mut l = field(t, "l");
    let (mut big_l, mut big_o) = (field(t, "big_l"), field(t, "big_o"));
    if wants_read {
        l = format!("{} {}", read.0, l);
        big_l = format!("{} {}", read.1, big_l);
        big_o = format!("{} {}", read.2, big_o);
    }
    let extra = field(t, "l_extra");
    if !extra.is_empty() {
        l = format!("{l} {extra}");
    }
    Spec {
        s: field(t, "s"),
        v: field(t, "v"),
        o: field(t, "o"),
        l: set(&l),
        big_l: set(&big_l),
        big_o: set(&big_o),
        num: t.get("num").and_then(V::as_bool).unwrap_or(false),
        strict: t.get("strict").and_then(V::as_bool).unwrap_or(false),
    }
}

fn build() -> Tables {
    let read = (strings("hd_read_long").join(" "), strings("hd_read_val").join(" "), strings("hd_read_opt").join(" "));
    let hd_specs =
        defaults::raw(&key("hd_specs")).as_table().map(|t| t.iter().map(|(k, v)| (k.to_string(), spec_from(v, &read))).collect()).unwrap_or_default();
    let opt_wrappers = defaults::raw(&key("opt_wrappers"))
        .as_table()
        .map(|t| {
            t.iter()
                .map(|(k, v)| {
                    (
                        k.to_string(),
                        OptWrapper {
                            s: field(v, "s"),
                            v: field(v, "v"),
                            l: str_list(v, "l"),
                            big_l: str_list(v, "big_l"),
                            ops: v.get("ops").and_then(V::as_integer).unwrap_or(0) as usize,
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let gpt = defaults::raw(&key("credit_gpt"));
    Tables {
        wrappers: words("wrappers"),
        wrapper_value_opts: defaults::raw(&key("wrapper_value_opts"))
            .as_table()
            .map(|t| t.iter().map(|(k, v)| (k.to_string(), Words::new(v.strings().into_iter().map(str::to_string).collect()))).collect())
            .unwrap_or_default(),
        shell_verbs: words("shell_verbs"),
        opt_wrappers,
        xargs_short_req: text("xargs_short_req"),
        xargs_short_opt: text("xargs_short_opt"),
        xargs_long_req: words("xargs_long_req"),
        xargs_long_other: words("xargs_long_other"),
        find_exec_flags: words("find_exec_flags"),
        parallel_separators: words("parallel_separators"),
        redirect_words: words("redirect_words"),
        copy_verbs: words("copy_verbs"),
        git_builtins: words("git_builtins"),
        git_opts_with_value: words("git_opts_with_value"),
        push_long_opts: words("push_long_opts"),
        commit_creating: words("commit_creating"),
        commit_long: words("commit_long"),
        commit_long_value: words("commit_long_value"),
        add_commit_value_opts: words("add_commit_value_opts"),
        commit_cluster_value_flags: text("commit_cluster_value_flags"),
        backstop_commit_subs: words("backstop_commit_subs"),
        git_binary: text("git_binary"),
        forward_env_names: words("forward_env_names"),
        forward_config_names: words("forward_config_names"),
        forward_config_indexed: strings("forward_config_indexed"),
        noop_editors: words("noop_editors"),
        credit_coauthor_alts: strings("credit_coauthor_alts"),
        credit_gpt_prefix: field(gpt, "prefix"),
        credit_gpt_versions: field(gpt, "versions"),
        credit_generated_alts: strings("credit_generated_alts"),
        gh_body_markers: strings("gh_body_markers"),
        gh_subs: words("gh_subs"),
        gh_actions: words("gh_actions"),
        gh_value_opts: words("gh_value_opts"),
        gh_value_prefixes: strings("gh_value_prefixes"),
        gh_file_opts: words("gh_file_opts"),
        gh_file_prefixes: strings("gh_file_prefixes"),
        heredoc_safe_verbs: words("heredoc_safe_verbs"),
        heredoc_git_msg_subs: words("heredoc_git_msg_subs"),
        hd_notes_subs: words("hd_notes_subs"),
        hd_gh_subs: words("hd_gh_subs"),
        hd_gh_actions: words("hd_gh_actions"),
        hd_deny_first: words("hd_deny_first"),
        hd_bad_dirs: words("hd_bad_dirs"),
        git_hook_names: words("git_hook_names"),
        hd_data_ext: words("hd_data_ext"),
        hd_sinks_basic: words("hd_sinks_basic"),
        hd_sinks_fd: words("hd_sinks_fd"),
        hd_specs,
        hd_gh_spec: spec_from(defaults::raw(&key("hd_gh_spec")), &read),
        max_chain: num("max_chain") as usize,
        alias_depth: num("alias_depth") as usize,
        max_nest: num("max_nest") as usize,
        launcher_hops: num("launcher_hops") as usize,
        cd_max_chars: num("cd_max_chars") as usize,
        cd_max_segments: num("cd_max_segments") as usize,
        commit_hash_len: num("commit_hash_len") as usize,
        commit_hash_short: num("commit_hash_short") as usize,
        budget_launcher_fs: num("budget_launcher_fs") as i32,
        budget_handover_queries: num("budget_handover_queries") as i32,
        budget_handover_evals: num("budget_handover_evals") as i32,
        git_timeout: std::time::Duration::from_millis(num("git_timeout_ms")),
        handover_git_timeout: std::time::Duration::from_millis(num("handover_git_timeout_ms")),
        child_poll: std::time::Duration::from_millis(num("child_poll_ms")),
        child_read: std::time::Duration::from_millis(num("child_read_ms")),
        stack_bytes: (num("stack_mb") as usize) << 20,
        guard_name: text("guard_name"),
        settings_file: text("settings_file"),
        skip_file: text("skip_file"),
        plugin_option_prefix: text("plugin_option_prefix"),
        setting_git_guard: switch("setting_git_guard"),
        setting_heredoc_data: switch("setting_heredoc_data"),
        setting_alias_resolve: switch("setting_alias_resolve"),
        setting_reused_message: switch("setting_reused_message"),
        setting_handover_guard: switch("setting_handover_guard"),
        launcher_dir_pattern: text("launcher_dir_pattern"),
        skip_command: text("skip_command"),
        handover_dir_prefix: text("handover_dir_prefix"),
        block_emoji: text("block_emoji"),
        block_mark: text("block_mark"),
        label_why: text("label_why"),
        label_instead: text("label_instead"),
        label_allowed: text("label_allowed"),
        label_override: text("label_override"),
        file_write_tip: text("file_write_tip"),
        chain_joiner: text("chain_joiner"),
        more_marker: text("more_marker"),
    }
}

/// The tables, built on first use and shared for the life of the process.
pub fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(build)
}

/// A git argument list from the defaults (`git.argv_*`), with `{rev}` replaced by `rev`.
pub fn argv_template(name: &str, rev: &str) -> Vec<String> {
    defaults::list(&key(name)).into_iter().map(|a| a.replace("{rev}", rev)).collect()
}

/// A shipped text with `{name}` placeholders filled.
pub fn note(name: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    defaults::render(&key(name), args)
}

/// A shipped text without placeholders.
pub fn plain(name: &str) -> &'static str {
    defaults::text(&key(name))
}

/// The block message `git.<name>` rendered with `args`, laid out like the Node guard's block message
/// (what, why, do instead, allowed, override).
pub fn block(name: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    let t = defaults::raw(&key(name));
    let get = |k: &str| defaults::fill(t.str_field(k), args);
    super::util::gm(super::util::Msg { what: &get("what"), why: &get("why"), instead: &get("instead"), allowed: "", override_: &get("override") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_load_and_hold_the_node_values() {
        let t = tables();
        assert!(t.wrappers.has("sudo") && t.wrappers.has("!"));
        assert_eq!(t.git_builtins.iter().count(), 129);
        assert_eq!(t.push_long_opts.iter().count(), 27);
        assert_eq!(t.hd_specs.len(), 10);
        assert!(t.hd_specs["show"].l.contains("no-patch") && t.hd_specs["show"].l.contains("stat"), "read sets are merged into show");
        assert!(t.hd_specs["log"].num && t.hd_specs["log"].strict);
        assert_eq!(t.opt_wrappers["flock"].ops, 1);
        assert_eq!(t.stack_bytes, 64 << 20);
        assert_eq!(t.setting_handover_guard.option, "guards_handover_commit_guard");
    }

    #[test]
    fn every_block_message_has_a_what_why_and_instead() {
        for e in defaults::all().iter().filter(|e| e.key.starts_with("git.msg_")) {
            assert!(e.value.as_table().is_some(), "{} is not a table", e.key);
            for k in ["what", "why", "instead"] {
                assert!(!e.value.str_field(k).is_empty(), "{} lacks {k}", e.key);
            }
        }
    }
}
