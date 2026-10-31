//! The generated `anti-hall:engine` skill family (owner feature 22): one tiny main skill and one sub-skill per feature area.
//!
//! Everything is read from the registries and the plugin's defaults, never written by hand: the verbs from the command
//! registry, who may run each from `roles.matrix`, the guards from the check registry, the switches from the settings
//! entries, the areas, texts and size budgets from `roles.toml`. A test compares the output with the committed files, so a
//! new verb, guard or switch has to land in the skills in the same commit, and another test holds each skill to its budget.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults::{self, V};
use crate::{checks, cli, roles};
use std::fmt::Write;

/// One generated skill file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    /// The skill name as the host knows it (`engine`, `anti-hall-engine-mesh`, ...).
    pub name: String,
    /// Path relative to the plugin root.
    pub path: String,
    /// The file's text.
    pub text: String,
    /// True for the main skill.
    pub main: bool,
}

/// The hosts a family is generated for.
pub fn hosts() -> Vec<&'static str> {
    defaults::raw("roles.skill_host").as_table().map(|t| t.iter().map(|(k, _)| *k).collect()).unwrap_or_default()
}

fn esc(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

/// The first sentence of `s`, cut at a word to at most `roles.line_max` characters.
fn short(s: &str) -> String {
    let max = defaults::num("roles.line_max") as usize;
    let first = s.split_once(". ").map_or(s, |(a, _)| a).trim_end_matches('.');
    if first.chars().count() <= max {
        return first.to_string();
    }
    let cut: String = first.chars().take(max.saturating_sub(3)).collect();
    format!("{}...", cut.rsplit_once(' ').map_or(cut.as_str(), |(a, _)| a))
}

/// Area keys in skill order.
fn areas() -> Vec<&'static str> {
    defaults::raw("roles.groups").as_table().map(|t| t.iter().map(|(k, _)| *k).collect()).unwrap_or_default()
}

fn area(key: &str) -> &'static V {
    defaults::raw("roles.groups").get(key).unwrap_or_else(|| defaults::raw("roles.groups"))
}

/// The area a guard belongs to: the first whose prefix its name starts with, else `guards`.
pub fn check_area(name: &str) -> &'static str {
    for a in areas() {
        if area(a).get("prefixes").is_some_and(|p| p.strings().iter().any(|x| name.starts_with(x))) {
            return a;
        }
    }
    "guards"
}

/// The area a switch belongs to (`section.key`): the one with the longest of its `settings_prefixes` the key starts with (so a
/// narrower area such as the DevSwarm supervisor's wins over `devswarm.`; the areas are a sorted table), else `guards`.
pub fn setting_area(key: &str) -> &'static str {
    let mut best: Option<(usize, &'static str)> = None;
    for a in areas() {
        let len = area(a).get("settings_prefixes").map_or(0, |p| p.strings().iter().filter(|x| key.starts_with(*x)).map(|x| x.len()).max().unwrap_or(0));
        if len > 0 && best.is_none_or(|(l, _)| len > l) {
            best = Some((len, a));
        }
    }
    best.map_or("guards", |(_, a)| a)
}

fn skill_name(host: &str, sub: &str) -> String {
    let h = defaults::raw("roles.skill_host").get(host);
    format!("{}{}", h.map_or("", |h| h.str_field("name_prefix")), sub)
}

fn skill_ref(host: &str, sub: &str) -> String {
    defaults::raw("roles.skill_host").get(host).map_or(String::new(), |h| h.str_field("ref").replace("{skill}", sub))
}

fn skill_path(host: &str, sub: &str) -> String {
    let h = defaults::raw("roles.skill_host").get(host);
    let (dir, prefix) = h.map_or(("", ""), |h| (h.str_field("dir"), h.str_field("prefix")));
    format!("{dir}/{prefix}{sub}/SKILL.md")
}

fn label(k: &str) -> &'static str {
    defaults::raw("roles.skill_labels").str_field(k)
}

fn frontmatter(name: &str, description: &str) -> String {
    defaults::render("roles.skill_frontmatter", &[("name", &name), ("description", &description.replace('"', "'"))])
}

/// A verb's roles in one cell: the role names, `*` after a self-only one.
fn role_cell(r: &roles::Row) -> String {
    let order = roles::names();
    let mut v: Vec<String> = Vec::new();
    for n in order.iter().rev() {
        if r.roles.contains(n) {
            v.push(if r.self_only.contains(n) { format!("{n}*") } else { n.to_string() });
        }
    }
    v.join(", ")
}

fn main_skill(host: &str) -> Skill {
    let m = defaults::raw("roles.main_skill");
    let mut o = frontmatter(&skill_name(host, m.str_field("name")), m.str_field("description"));
    crate::discard::harmless(writeln!(o, "# anti-hall engine\n\n{}\n", m.str_field("intro"))); // keep: formatting into a String cannot fail
    crate::discard::harmless(writeln!(o, "## {}\n", label("areas_head"))); // keep: formatting into a String cannot fail
    for a in sub_areas() {
        let g = area(a);
        crate::discard::harmless(writeln!(o, "- {} (`{}`): {}", g.str_field("title"), skill_ref(host, g.str_field("skill")), esc(g.str_field("brief")))); // keep: formatting into a String cannot fail
    }
    crate::discard::harmless(writeln!(o, "\n## {}\n", label("roles_head"))); // keep: formatting into a String cannot fail
    let desc = defaults::raw("roles.describe");
    for n in roles::names().iter().rev() {
        crate::discard::harmless(writeln!(o, "- `{n}`: {}", desc.str_field(n))); // keep: formatting into a String cannot fail
    }
    crate::discard::harmless(writeln!(o, "\n{}\n\n{}", label("roles_note"), label("more"))); // keep: formatting into a String cannot fail
    crate::discard::harmless(writeln!(o, "\n_{}_", label("generated"))); // keep: formatting into a String cannot fail
    Skill { name: skill_name(host, m.str_field("name")), path: skill_path(host, m.str_field("name")), text: o, main: true }
}

/// Areas that have at least one verb, guard or switch (an empty area gets no skill).
fn sub_areas() -> Vec<&'static str> {
    areas()
        .into_iter()
        .filter(|a| *a == defaults::text("guard_rules.area") || !area_verbs(a).is_empty() || !area_checks(a).is_empty() || !area_settings(a).is_empty())
        .collect()
}

fn area_verbs(a: &str) -> Vec<(cli::CommandInfo, roles::Row)> {
    cli::commands().into_iter().filter(|c| c.status == "implemented").filter_map(|c| roles::row(&c.name).filter(|r| r.group == a).map(|r| (c, r))).collect()
}

fn area_checks(a: &str) -> Vec<(&'static str, &'static str)> {
    checks::registry().iter().filter(|c| check_area(c.name()) == a).map(|c| (c.name(), c.summary())).collect()
}

fn area_settings(a: &str) -> Vec<&'static defaults::Entry> {
    let mut seen = std::collections::BTreeSet::new();
    defaults::all()
        .iter()
        .copied()
        .filter(|e| e.value.get("section").is_some() && e.value.get("key").is_some() && e.value.get("default").is_some())
        .filter(|e| seen.insert(format!("{}.{}", e.value.str_field("section"), e.value.str_field("key"))))
        .filter(|e| setting_area(&format!("{}.{}", e.value.str_field("section"), e.value.str_field("key"))) == a)
        .collect()
}

/// One row of the rule registry (`guard_rules.rules`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    /// Stable rule id.
    pub id: &'static str,
    /// The switch that turns the rule off, or empty.
    pub setting: &'static str,
    /// `essential`, `skill` or `off`.
    pub tier: &'static str,
    /// The defaults key of the rule's `what` text.
    pub source: &'static str,
    /// The hosts that run the rule; empty: every digest host.
    pub hosts: Vec<&'static str>,
    /// The rule is enforced while its switch is off (an allow-style switch).
    pub inverted: bool,
}

impl Rule {
    /// Whether `host` runs this rule (no `hosts` listed: every host).
    pub fn applies(&self, host: &str) -> bool {
        self.hosts.is_empty() || self.hosts.contains(&host)
    }

    /// The `section.key` settings keys of the rule's switches (`guard_rules.setting_sep` joined), empty when it has none.
    pub fn settings(&self) -> Vec<&'static str> {
        self.setting.split(defaults::text("guard_rules.setting_sep")).map(str::trim).filter(|s| !s.is_empty()).collect()
    }

    /// The digest gate of the rule: the defaults keys of its switches, comma-joined, each with `guard_rules.digest_gate_not` in
    /// front for an inverted row. Empty when the rule has no switch.
    pub fn gate(&self) -> String {
        let not = if self.inverted { defaults::text("guard_rules.digest_gate_not") } else { "" };
        self.settings().into_iter().filter_map(setting_entry).map(|k| format!("{not}{k}")).collect::<Vec<_>>().join(",")
    }
}

/// The defaults key of the settings entry for `section.key` (an entry whose value names that section and key; the first in file
/// order), or None.
pub fn setting_entry(setting: &str) -> Option<&'static str> {
    let (sec, key) = setting.split_once('.')?;
    defaults::all()
        .iter()
        .find(|e| e.value.get("section").and_then(V::as_str) == Some(sec) && e.value.get("key").and_then(V::as_str) == Some(key))
        .map(|e| e.key)
}

/// `{cfg:<key>}` placeholders of a digest field (`guard_rules.digest_cfg_ref`) replaced by that entry's value, or a settings entry's
/// default, at generation time. An unknown key stays a placeholder (a registry problem).
fn expand_cfg(t: &str) -> String {
    let open = format!("{{{}", defaults::text("guard_rules.digest_cfg_ref"));
    let mut out = String::new();
    let mut rest = t;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        let Some(j) = after.find('}') else { break };
        let key = &after[..j];
        let v = if defaults::has(key) { Some(defaults::raw(key)) } else { None };
        let v = v.map(|v| v.get("default").unwrap_or(v));
        let txt = v.and_then(|v| v.as_str().map(str::to_string).or_else(|| v.as_integer().map(|n| n.to_string())));
        out.push_str(&rest[..i]);
        match txt {
            Some(x) => out.push_str(&x),
            None => out.push_str(&rest[i..i + open.len() + j + 1]),
        }
        rest = &after[j + 1..];
    }
    out.push_str(rest);
    out
}

/// Every row of the rule registry, in file order.
pub fn rules() -> Vec<Rule> {
    defaults::raw("guard_rules.rules")
        .as_array()
        .map(|a| {
            a.iter()
                .map(|r| Rule {
                    id: r.str_field("id"),
                    setting: r.str_field("setting"),
                    tier: r.str_field("tier"),
                    source: r.str_field("source"),
                    hosts: r.get("hosts").map(V::strings).unwrap_or_default(),
                    inverted: r.get("inverted").and_then(V::as_bool).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A text with its `{name}` placeholders replaced by the configured filler.
fn plain(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        match rest[i..].find('}') {
            Some(j) => {
                out.push_str(defaults::text("guard_rules.placeholder"));
                rest = &rest[i + j + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// The `(what, why, instead)` texts of a rule: an inline table, or a `what` key with `why` and `instead` siblings (the word
/// `what` in the key replaced). A part that does not exist is empty.
pub fn rule_parts(source: &str) -> (String, String, String) {
    if !defaults::has(source) {
        return (String::new(), String::new(), String::new());
    }
    let v = defaults::raw(source);
    if let Some(w) = v.get("what") {
        let f = |k: &str| v.get(k).and_then(V::as_str).map(plain).unwrap_or_default();
        return (w.as_str().map(plain).unwrap_or_default(), f("why"), f("instead"));
    }
    let sib = |word: &str| {
        let (sec, key) = source.split_once('.').unwrap_or(("", source));
        let k = format!("{sec}.{}", key.replacen("what", word, 1));
        if defaults::has(&k) { defaults::raw(&k).as_str().map(plain).unwrap_or_default() } else { String::new() }
    };
    (v.as_str().map(plain).unwrap_or_default(), sib("why"), sib("instead"))
}

/// The text the engine shows for a rule whose action is `action` (deny, warn, context), composed from its defaults entries (what,
/// why, instead) with that action's template (`guard_rules.msg_compose`). An action without a template composes nothing.
pub fn compose(action: &str, source: &str) -> String {
    let Some(tpl) = defaults::raw("guard_rules.msg_compose").get(action).and_then(V::as_str) else { return String::new() };
    let (what, why, instead) = rule_parts(source);
    let mut t = tpl.to_string();
    for (k, v) in [("what", &what), ("why", &why), ("instead", &instead)] {
        t = t.replace(&format!("{{{k}}}"), v);
    }
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The `digest` field of a rule for `host`: a `digest` key inside an inline what/why/instead table, or the sibling key with `what`
/// replaced by `digest` (the same place `why` and `instead` live); a string for every host, or a table by host. Empty when absent.
pub fn digest_field(source: &str, host: &str) -> String {
    if !defaults::has(source) {
        return String::new();
    }
    let v = defaults::raw(source);
    let d = if v.get("what").is_some() {
        v.get("digest")
    } else {
        let (sec, key) = source.split_once('.').unwrap_or(("", source));
        let k = format!("{sec}.{}", key.replacen("what", "digest", 1));
        if defaults::has(&k) { Some(defaults::raw(&k)) } else { None }
    };
    d.and_then(|d| d.as_str().or_else(|| d.get(host).and_then(V::as_str))).map(|t| plain(&expand_cfg(t))).unwrap_or_default()
}

/// The digest text of an essential rule for `host`: its own short `digest` field (one line: the rule and what to do), rendered by
/// `guard_rules.digest_entry`. Empty when the rule has no digest field for that host.
pub fn digest_entry(source: &str, host: &str) -> String {
    let digest = digest_field(source, host);
    if digest.is_empty() {
        return String::new();
    }
    let (what, _, instead) = rule_parts(source);
    defaults::render("guard_rules.digest_entry", &[("digest", &digest), ("what", &what), ("instead", &instead)])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The hosts a digest is generated for (`guard_rules.digest_hosts`).
pub fn digest_hosts() -> Vec<&'static str> {
    defaults::list("guard_rules.digest_hosts")
}

/// The plugin-relative path of `host`'s generated digest: `guard_rules.digest_file_<host>`, else the default `guard_rules.digest_file`.
pub fn digest_rel(host: &str) -> &'static str {
    let k = format!("guard_rules.digest_file_{host}");
    if defaults::has(&k) { defaults::text(&k) } else { defaults::text("guard_rules.digest_file") }
}

/// The generated digest file of the default host (`dispatch.default_host`): see [`digest_file_for`].
pub fn digest_file() -> String {
    digest_file_for(defaults::text("dispatch.default_host"))
}

/// The generated digest file of `host`, from the rules the host runs (a row's `hosts`): the essential lines (the injected part), the
/// separator, one extra line per other listed rule (tier skill), the separator, then (default host only) each
/// essential rule's full enforced text, which the session never reads but which makes the committed digest stale when an enforced
/// message changes, so its digest line is reviewed with it. Each essential and extra line starts with the rule's gate (its switches,
/// [`Rule::gate`]) and `guard_rules.digest_gate_sep`; the session script leaves out a line whose switch is off and strips the gate.
pub fn digest_file_for(host: &str) -> String {
    let mut ess = Vec::new();
    let mut extra = Vec::new();
    let mut src = Vec::new();
    let default_host = host == defaults::text("dispatch.default_host");
    let gsep = defaults::text("guard_rules.digest_gate_sep");
    for r in rules() {
        if !r.applies(host) {
            continue;
        }
        if r.tier == "essential" {
            let line = digest_entry(r.source, host);
            if !line.is_empty() {
                ess.push(format!("{}{gsep}{}", r.gate(), defaults::render("guard_rules.digest_line", &[("line", &line)])));
            }
            let (what, why, instead) = rule_parts(r.source);
            let full = defaults::render("guard_rules.source_line", &[("id", &r.id), ("what", &what), ("why", &why), ("instead", &instead)]);
            if default_host {
                src.push(full.split_whitespace().collect::<Vec<_>>().join(" "));
            }
        } else if r.tier != "off" {
            let (what, _, _) = rule_parts(r.source);
            if !what.is_empty() {
                extra.push(format!("{}{gsep}{}", r.gate(), defaults::render("guard_rules.extra_line", &[("id", &r.id), ("what", &what)])));
            }
        }
    }
    let sep = defaults::text("guard_rules.digest_sep");
    format!("{}\n{sep}\n{}\n{sep}\n{}\n", ess.join("\n"), extra.join("\n"), src.join("\n"))
}

/// The digest as the session shows it at the default tier: head, the essential lines, foot.
pub fn digest_text() -> String {
    let f = digest_file();
    let ess = f.split(&format!("\n{}\n", defaults::text("guard_rules.digest_sep"))).next().unwrap_or("");
    let gsep = defaults::text("guard_rules.digest_gate_sep");
    let ess = ess.lines().map(|l| l.split_once(gsep).map_or(l, |(_, t)| t)).collect::<Vec<_>>().join("\n");
    format!("{}\n{}\n{}", defaults::text("guard_rules.digest_head"), ess, defaults::text("guard_rules.digest_foot"))
}

/// Problems in the rule registry: a rule without a valid tier, a source that does not exist, a duplicate id, an essential rule
/// without a line, a non-off rule that is missing from the generated output, a block text neither registered nor exempt.
pub fn rule_problems() -> Vec<String> {
    let mut p = Vec::new();
    let tiers = defaults::list("guard_rules.tiers");
    let mut ids = std::collections::BTreeSet::new();
    let mut sources = std::collections::BTreeSet::new();
    let digests: Vec<(&str, String)> = digest_hosts().into_iter().map(|h| (h, digest_file_for(h))).collect();
    let filler = defaults::text("guard_rules.placeholder");
    let skill = rules_section();
    for r in rules() {
        if r.id.is_empty() || !ids.insert(r.id) {
            p.push(defaults::render("guard_rules.problem_id", &[("id", &r.id)]));
        }
        if !tiers.contains(&r.tier) {
            p.push(defaults::render("guard_rules.problem_tier", &[("id", &r.id), ("tier", &r.tier), ("tiers", &tiers.join(", "))]));
        }
        if !defaults::has(r.source) {
            p.push(defaults::render("guard_rules.problem_source", &[("id", &r.id), ("source", &r.source)]));
        }
        for s in r.settings() {
            if setting_entry(s).is_none() {
                p.push(defaults::render("guard_rules.problem_setting", &[("id", &r.id), ("setting", &s)]));
            }
        }
        for (h, digest) in digests.iter().filter(|(h, _)| r.tier == "essential" && r.applies(h)) {
            let line = digest_entry(r.source, h);
            if line.is_empty() || line.contains(filler) {
                p.push(defaults::render("guard_rules.problem_line", &[("id", &r.id), ("host", h)]));
            } else if !digest.contains(&line) {
                p.push(defaults::render("guard_rules.problem_digest", &[("id", &r.id)]));
            }
        }
        sources.insert(r.source);
        if r.tier != "off" && !skill.contains(&format!("`{}`", r.id)) {
            p.push(defaults::render("guard_rules.problem_skill", &[("id", &r.id)]));
        }
    }
    let exempt: std::collections::BTreeSet<&str> = defaults::list("guard_rules.exempt").into_iter().collect();
    for e in defaults::all().iter() {
        let (sec, key) = e.key.split_once('.').unwrap_or(("", e.key));
        let inline = e.value.get("what").is_some();
        let split = e.value.as_str().is_some() && key.split('_').any(|w| w == "what");
        if (inline || split) && !sources.contains(e.key) && !exempt.contains(e.key) && sec != "guard_rules" {
            p.push(defaults::render("guard_rules.problem_unregistered", &[("key", &e.key)]));
        }
    }
    p
}

/// The rules section of the rules skill: every non-off rule with its full what, why and instead.
pub fn rules_section() -> String {
    let mut o = String::new();
    for r in rules().into_iter().filter(|r| r.tier != "off") {
        let (what, why, instead) = rule_parts(r.source);
        let setting = if r.setting.is_empty() { String::new() } else { defaults::render("guard_rules.skill_setting", &[("setting", &r.setting)]) };
        let why = if why.is_empty() { String::new() } else { defaults::render("guard_rules.skill_why", &[("why", &why)]) };
        let instead = if instead.is_empty() { String::new() } else { defaults::render("guard_rules.skill_instead", &[("instead", &instead)]) };
        let line = defaults::render(
            "guard_rules.skill_rule",
            &[("id", &r.id), ("tier", &format!("{}{}", r.tier, setting)), ("setting", &""), ("what", &what), ("why", &why), ("instead", &instead)],
        );
        crate::discard::harmless(writeln!(o, "{}", line.split_whitespace().collect::<Vec<_>>().join(" "))); // keep: formatting into a String cannot fail
    }
    o
}

fn rules_skill(host: &str, a: &str) -> Skill {
    let g = area(a);
    let sub = g.str_field("skill");
    let name = skill_name(host, sub);
    let mut o = frontmatter(&name, &defaults::render("guard_rules.skill_use_when", &[("use_when", &g.str_field("use_when"))]));
    crate::discard::harmless(writeln!(o, "# {}\n\n{}\n", g.str_field("title"), g.str_field("brief"))); // keep: formatting into a String cannot fail
    crate::discard::harmless(writeln!(o, "## {}\n\n{}\n", defaults::text("guard_rules.skill_head"), defaults::text("guard_rules.skill_intro"))); // keep: formatting into a String cannot fail
    o.push_str(&rules_section());
    crate::discard::harmless(writeln!(o, "\n_{}_", label("generated"))); // keep: formatting into a String cannot fail
    Skill { name, path: skill_path(host, sub), text: o, main: false }
}

fn sub_skill(host: &str, a: &str) -> Skill {
    if a == defaults::text("guard_rules.area") {
        return rules_skill(host, a);
    }
    let g = area(a);
    let sub = g.str_field("skill");
    let name = skill_name(host, sub);
    let mut o = frontmatter(&name, &defaults::render("guard_rules.skill_use_when", &[("use_when", &g.str_field("use_when"))]));
    crate::discard::harmless(writeln!(o, "# {}\n\n{}\n", g.str_field("title"), g.str_field("brief"))); // keep: formatting into a String cannot fail
    let verbs = area_verbs(a);
    if !verbs.is_empty() {
        crate::discard::harmless(writeln!(o, "## {}\n\n{}", label("verbs_head"), label("table_head"))); // keep: formatting into a String cannot fail
        for (c, r) in &verbs {
            let owner = if r.owner_args.is_empty() { String::new() } else { format!(" ({}: {})", label("owner"), r.owner_args.join(", ")) };
            crate::discard::harmless(writeln!(
                // keep: formatting into a String cannot fail
                o,
                "| `{}` | `{}` {} | {}{} |",
                defaults::render("roles.cli_cmd", &[("verb", &c.name)]),
                esc(&c.args),
                short(&c.doc),
                role_cell(r),
                owner
            ));
        }
        o.push('\n');
    }
    let cs = area_checks(a);
    if !cs.is_empty() {
        crate::discard::harmless(writeln!(o, "## {}\n", label("guards_head"))); // keep: formatting into a String cannot fail
        for (n, s) in cs {
            crate::discard::harmless(writeln!(o, "- `{n}`: {}", short(s))); // keep: formatting into a String cannot fail
        }
        o.push('\n');
    }
    let ss = area_settings(a);
    if !ss.is_empty() {
        crate::discard::harmless(writeln!(o, "## {}\n", label("settings_head"))); // keep: formatting into a String cannot fail
        for e in ss {
            let (sec, key) = (e.value.str_field("section"), e.value.str_field("key"));
            let d = e.value.get("default").map(|v| v.to_json().to_string()).unwrap_or_default();
            crate::discard::harmless(writeln!(o, "- `{sec}.{key}` = {d}: {}", short(e.doc))); // keep: formatting into a String cannot fail
        }
        o.push('\n');
    }
    crate::discard::harmless(writeln!(o, "_{}_", label("generated"))); // keep: formatting into a String cannot fail
    Skill { name, path: skill_path(host, sub), text: o, main: false }
}

/// The whole family for one host: the main skill first, then one skill per non-empty area.
pub fn family(host: &str) -> Vec<Skill> {
    let mut v = vec![main_skill(host)];
    v.extend(sub_areas().into_iter().map(|a| sub_skill(host, a)));
    v
}

/// The skill whose name or path matches `which`, for one host.
pub fn find(host: &str, which: &str) -> Option<Skill> {
    family(host).into_iter().find(|s| s.name == which || s.path == which)
}

/// The size limit of a skill in bytes.
pub fn budget(s: &Skill) -> usize {
    defaults::raw("roles.skill_budget")
        .get(if s.main {
            "main"
        } else if s.name.ends_with(area(defaults::text("guard_rules.area")).str_field("skill")) {
            defaults::text("guard_rules.area")
        } else {
            "sub"
        })
        .and_then(V::as_integer)
        .unwrap_or(0) as usize
}

/// The names of the engine skills a role's note points at: the main skill only.
pub fn main_ref(host: &str) -> String {
    skill_ref(host, defaults::raw("roles.main_skill").str_field("name"))
}
