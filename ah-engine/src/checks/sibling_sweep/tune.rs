//! The check's settings as they are on disk NOW, not as they were compiled.
//!
//! Every `sibling_sweep.*` setting (trigger phrases, hedge lists, reminder text, limits, the follow-through window) is
//! resolved through the engine's config layers (`cfgstore`): `<home>/.anti-hall/settings.json` (section `sibling_sweep`),
//! then the engine's own `config.toml`, then the shipped default in the plugin's `engine/defaults/sibling_sweep.toml`. Editing either file
//! changes the next call; nothing is rebuilt. The resolved settings and the compiled patterns are cached per pair of
//! files and rebuilt only when one of them changes (modification time and size) or a defaults reload is applied, so a call
//! costs two `stat`s.
//!
//! A pattern that the user's file makes invalid is not fatal: the shipped pattern of that key is used and the problem is
//! reported once per process.
use crate::cfgstore::{self, Effective, Layers, Paths};
use crate::checks::guardkit::jsre;
use crate::defaults;
use regex::Regex;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

/// The compiled patterns of the matcher and the tool classifier.
pub struct Pats {
    /// Cause cues.
    pub cues: Vec<Regex>,
    /// Hedge words that void the whole sentence.
    pub hedge_any: Regex,
    /// Hedge or negation just before a cue.
    pub hedge_before: Regex,
    /// Mentions of the root-cause machinery itself.
    pub meta: Regex,
    /// A fenced code block.
    pub fence: Regex,
    /// A quoted line.
    pub quote: Regex,
    /// Fix words.
    pub fix: Regex,
    /// Statements that other occurrences were searched for.
    pub sweep: Vec<Regex>,
    /// An injected (non-human) user block.
    pub injected: Regex,
    /// A shell command that searches the codebase.
    pub bash_search: Regex,
    /// A tool name that is a search by its name.
    pub search_name: Regex,
}

/// The resolved settings and compiled patterns of one moment.
pub struct Tune {
    eff: Effective,
    /// The compiled patterns.
    pub pats: Pats,
    /// Problems found while building (an invalid pattern, a rejected file), for the one-time report.
    pub problems: Vec<String>,
}

impl Tune {
    /// A numeric setting.
    pub fn num(&self, key: &str) -> u64 {
        self.eff.num(key)
    }

    /// A string setting.
    pub fn text(&self, key: &str) -> String {
        self.eff.text(key)
    }

    /// A list-of-strings setting; an entry that is not a string is left out.
    pub fn list(&self, key: &str) -> Vec<String> {
        match self.eff.get(key).and_then(|r| r.value.as_array()) {
            Some(a) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
            None => defaults::list(key).into_iter().map(String::from).collect(),
        }
    }

    fn build(layers: &Layers, mut problems: Vec<String>) -> Tune {
        let eff = Effective::resolve(layers, &|_| None);
        let mut t = Tune { eff, pats: placeholder(), problems: Vec::new() };
        let pats = Pats {
            cues: t.regex_list("sibling_sweep.cause_cues", &mut problems),
            hedge_any: t.one("sibling_sweep.hedge_any_re", true, &mut problems),
            hedge_before: t.one("sibling_sweep.hedge_before_re", true, &mut problems),
            meta: t.one("sibling_sweep.meta_re", true, &mut problems),
            fence: t.one("sibling_sweep.fence_re", false, &mut problems),
            quote: t.one_multiline("sibling_sweep.quote_line_re", &mut problems),
            fix: t.one("sibling_sweep.fix_context_re", true, &mut problems),
            sweep: t.regex_list("sibling_sweep.sweep_statement_re", &mut problems),
            injected: t.one("sibling_sweep.injected_re", true, &mut problems),
            bash_search: t.one("sibling_sweep.bash_search_re", false, &mut problems),
            search_name: t.one("sibling_sweep.search_tool_re", false, &mut problems),
        };
        t.pats = pats;
        t.problems = problems;
        t
    }

    /// Compile `src` (the value of `key`); an invalid one is replaced by the shipped value of the key and reported.
    fn regex(&self, key: &str, src: &str, ci: bool, problems: &mut Vec<String>) -> Regex {
        if let Some(r) = jsre::try_compile(src, ci) {
            return r;
        }
        problems.push(key.to_string());
        jsre::compile(defaults::text(key), ci)
    }

    /// Compile every entry of the list `key` (case-insensitive); when any entry is invalid the whole shipped list is used
    /// and the key is reported, so a typo never leaves the matcher with half a list.
    fn regex_list(&self, key: &str, problems: &mut Vec<String>) -> Vec<Regex> {
        let compiled: Option<Vec<Regex>> = self.list(key).iter().map(|s| jsre::try_compile(s, true)).collect();
        compiled.unwrap_or_else(|| {
            problems.push(key.to_string());
            defaults::list(key).into_iter().map(|s| jsre::compile(s, true)).collect()
        })
    }

    fn one(&self, key: &str, ci: bool, problems: &mut Vec<String>) -> Regex {
        self.regex(key, &self.text(key), ci, problems)
    }

    fn one_multiline(&self, key: &str, problems: &mut Vec<String>) -> Regex {
        let src = self.text(key);
        if jsre::try_compile(&src, false).is_some() {
            return jsre::compile_multiline(&src, false);
        }
        problems.push(key.to_string());
        jsre::compile_multiline(defaults::text(key), false)
    }
}

fn placeholder() -> Pats {
    let never = || jsre::compile(defaults::text("sibling_sweep.fence_re"), false);
    Pats {
        cues: Vec::new(),
        hedge_any: never(),
        hedge_before: never(),
        meta: never(),
        fence: never(),
        quote: never(),
        fix: never(),
        sweep: Vec::new(),
        injected: never(),
        bash_search: never(),
        search_name: never(),
    }
}

/// What identifies the on-disk state of the two files.
type Stamp = Vec<(PathBuf, Option<(SystemTime, u64)>)>;

fn stamp(paths: &Paths) -> Stamp {
    let one = |p: &PathBuf| (p.clone(), std::fs::metadata(p).ok().map(|m| (m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len())));
    let mut v = vec![one(&paths.user)];
    if let Some(s) = &paths.settings {
        v.push(one(s));
    }
    v
}

/// The settings for `paths`, from the cache when neither file changed and no defaults reload was applied since the cached
/// build (the shipped defaults are the last layer, so a reload changes what an unset setting resolves to).
pub fn load(paths: &Paths) -> Arc<Tune> {
    static CACHE: Mutex<Option<(Stamp, u64, Arc<Tune>)>> = Mutex::new(None);
    let (now, generation) = (stamp(paths), defaults::generation());
    let mut g = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((s, gen_at, t)) = g.as_ref()
        && *s == now
        && *gen_at == generation
    {
        return Arc::clone(t);
    }
    let (layers, errs) = cfgstore::load_layers_cold(paths);
    let t = Arc::new(Tune::build(&layers, errs.iter().map(ToString::to_string).collect()));
    *g = Some((now, generation, Arc::clone(&t)));
    t
}
