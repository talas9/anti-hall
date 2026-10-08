//! `scripts/devswarm-lib/core.js` argument parsing (`parseArgs`, `one`, `many`, `hasFlag`), so an `ah-engine mesh` verb
//! reads its argv exactly as `devswarm.js` does.
use crate::defaults;
use std::collections::HashMap;

/// One flag value: a string, or `true` for a bare flag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlagVal {
    /// `--name value` or `--name=value`.
    S(String),
    /// A bare `--name`.
    True,
}

/// Parsed argv: positionals in order and every flag's values in order.
#[derive(Debug, Clone, Default)]
pub struct Args {
    /// Words that are not flags.
    pub positionals: Vec<String>,
    /// Flag name -> values.
    pub flags: HashMap<String, Vec<FlagVal>>,
}

/// `parseArgs(argv)`.
pub fn parse(argv: &[String]) -> Args {
    let value_required = defaults::list("mesh_write.value_required_flags");
    let boolean_only = defaults::list("mesh_write.boolean_only_flags");
    let mut a = Args::default();
    let mut i = 0;
    while i < argv.len() {
        let tok = &argv[i];
        if let Some(name) = tok.strip_prefix("--") {
            let (name, val) = if let Some(eq) = name.find('=') {
                (name[..eq].to_string(), FlagVal::S(name[eq + 1..].to_string()))
            } else if boolean_only.contains(&name) {
                (name.to_string(), FlagVal::True)
            } else if i + 1 < argv.len() && (value_required.contains(&name) || !argv[i + 1].starts_with("--")) {
                i += 1;
                (name.to_string(), FlagVal::S(argv[i].clone()))
            } else {
                (name.to_string(), FlagVal::True)
            };
            a.flags.entry(name).or_default().push(val);
        } else {
            a.positionals.push(tok.clone());
        }
        i += 1;
    }
    a
}

impl Args {
    /// `one(flags, name)`: the last value, `None` when absent or when the last is a bare flag.
    pub fn one(&self, name: &str) -> Option<&str> {
        match self.flags.get(name)?.last()? {
            FlagVal::S(s) => Some(s),
            FlagVal::True => None,
        }
    }

    /// `many(flags, name)`: every string value.
    pub fn many(&self, name: &str) -> Vec<&str> {
        self.flags.get(name).map(|v| v.iter().filter_map(|x| if let FlagVal::S(s) = x { Some(s.as_str()) } else { None }).collect()).unwrap_or_default()
    }

    /// `hasFlag(flags, name)`: passed at all.
    pub fn has(&self, name: &str) -> bool {
        self.flags.get(name).is_some_and(|v| !v.is_empty())
    }

    /// `isHelpRequest(positionals, flags)`.
    pub fn is_help(&self) -> bool {
        // `flags.help || flags.h`: present at all
        self.has(defaults::text("mesh_write.flag_help"))
            || self.has(defaults::text("mesh_write.flag_h"))
            || self
                .positionals
                .iter()
                .enumerate()
                .any(|(i, p)| (i == 0 && p == defaults::text("mesh_write.verb_help")) || p == defaults::text("mesh_write.flag_dash_h"))
    }
}
