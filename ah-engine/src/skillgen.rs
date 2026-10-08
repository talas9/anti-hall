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

/// The area a switch belongs to (`section.key`): the first whose `settings_prefixes` it starts with, else `guards`.
pub fn setting_area(key: &str) -> &'static str {
    for a in areas() {
        if area(a).get("settings_prefixes").is_some_and(|p| p.strings().iter().any(|x| key.starts_with(x))) {
            return a;
        }
    }
    "guards"
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
    let _ = writeln!(o, "# anti-hall engine\n\n{}\n", m.str_field("intro")); // keep: formatting into a String cannot fail
    let _ = writeln!(o, "## {}\n", label("areas_head")); // keep: formatting into a String cannot fail
    for a in sub_areas() {
        let g = area(a);
        let _ = writeln!(o, "- {} (`{}`): {}", g.str_field("title"), skill_ref(host, g.str_field("skill")), esc(g.str_field("brief"))); // keep: formatting into a String cannot fail
    }
    let _ = writeln!(o, "\n## {}\n", label("roles_head")); // keep: formatting into a String cannot fail
    let desc = defaults::raw("roles.describe");
    for n in roles::names().iter().rev() {
        let _ = writeln!(o, "- `{n}`: {}", desc.str_field(n)); // keep: formatting into a String cannot fail
    }
    let _ = writeln!(o, "\n{}\n\n{}", label("roles_note"), label("more")); // keep: formatting into a String cannot fail
    let _ = writeln!(o, "\n_{}_", label("generated")); // keep: formatting into a String cannot fail
    Skill { name: skill_name(host, m.str_field("name")), path: skill_path(host, m.str_field("name")), text: o, main: true }
}

/// Areas that have at least one verb, guard or switch (an empty area gets no skill).
fn sub_areas() -> Vec<&'static str> {
    areas().into_iter().filter(|a| !area_verbs(a).is_empty() || !area_checks(a).is_empty() || !area_settings(a).is_empty()).collect()
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

fn sub_skill(host: &str, a: &str) -> Skill {
    let g = area(a);
    let sub = g.str_field("skill");
    let name = skill_name(host, sub);
    let mut o = frontmatter(&name, &format!("Use when {}.", g.str_field("use_when")));
    let _ = writeln!(o, "# {}\n\n{}\n", g.str_field("title"), g.str_field("brief")); // keep: formatting into a String cannot fail
    let verbs = area_verbs(a);
    if !verbs.is_empty() {
        let _ = writeln!(o, "## {}\n\n{}", label("verbs_head"), label("table_head")); // keep: formatting into a String cannot fail
        for (c, r) in &verbs {
            let owner = if r.owner_args.is_empty() { String::new() } else { format!(" ({}: {})", label("owner"), r.owner_args.join(", ")) };
            let _ = writeln!( // keep: formatting into a String cannot fail
                o,
                "| `{}` | `{}` {} | {}{} |",
                defaults::render("roles.cli_cmd", &[("verb", &c.name)]),
                esc(&c.args),
                short(&c.doc),
                role_cell(r),
                owner
            );
        }
        o.push('\n');
    }
    let cs = area_checks(a);
    if !cs.is_empty() {
        let _ = writeln!(o, "## {}\n", label("guards_head")); // keep: formatting into a String cannot fail
        for (n, s) in cs {
            let _ = writeln!(o, "- `{n}`: {}", short(s)); // keep: formatting into a String cannot fail
        }
        o.push('\n');
    }
    let ss = area_settings(a);
    if !ss.is_empty() {
        let _ = writeln!(o, "## {}\n", label("settings_head")); // keep: formatting into a String cannot fail
        for e in ss {
            let (sec, key) = (e.value.str_field("section"), e.value.str_field("key"));
            let d = e.value.get("default").map(|v| v.to_json().to_string()).unwrap_or_default();
            let _ = writeln!(o, "- `{sec}.{key}` = {d}: {}", short(e.doc)); // keep: formatting into a String cannot fail
        }
        o.push('\n');
    }
    let _ = writeln!(o, "_{}_", label("generated")); // keep: formatting into a String cannot fail
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
    defaults::raw("roles.skill_budget").get(if s.main { "main" } else { "sub" }).and_then(V::as_integer).unwrap_or(0) as usize
}

/// The names of the engine skills a role's note points at: the main skill only.
pub fn main_ref(host: &str) -> String {
    skill_ref(host, defaults::raw("roles.main_skill").str_field("name"))
}
