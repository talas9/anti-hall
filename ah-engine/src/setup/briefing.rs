//! `ah-engine briefing`: a derived (never hardcoded) system briefing for the agent that installs or operates anti-hall.
//! It enumerates the real files of a plugin tree: every hook the registry lists, grouped by event with the one-line
//! purpose from the hook's own header comment, the shipped skills (name and description from each `SKILL.md`), the
//! DevSwarm substrate, and a map of the `docs/KB*.md` files when the repository docs are present. Port of
//! `scripts/briefing.js`.
//!
//! The header-comment and frontmatter scans reproduce the JavaScript regular expressions they replace by hand (their
//! backtracking included), because a briefing that differs from the Node one by a space is a parity failure.
use super::jsfmt::{js_string, len16, obj, pretty, slice16};
use super::{SetupError, cwd, list_dir, out, out_raw, read_prefix, read_text_or_warn, take_root, text_of, warn, what};
use crate::checks::guardkit::paths::{join, resolve};
use crate::checks::jsport::json::{self, J};
use crate::checks::jsport::text::cmp16;
use crate::cli::Parsed;
use crate::defaults;
use crate::jev::is_js_whitespace;
use crate::jev::settings::Env;
use std::path::Path;

/// A whole small text file (bounded by `setup.read_max_bytes`), lossy UTF-8; absent or unreadable is `None`.
fn read_text(p: &str) -> Option<String> {
    read_text_or_warn(Path::new(p))
}

/// Entry names of a directory, filtered and sorted as `listFiles` does (a missing directory is empty).
fn list_files(dir: &str, keep: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut v: Vec<String> = list_dir(Path::new(dir)).into_iter().map(|(name, _, _)| name).filter(|f| keep(f)).collect();
    v.sort_by(|a, b| cmp16(a, b));
    v
}

fn is_dir(p: &str) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_dir())
}

fn is_file(p: &str) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file())
}

fn js_trim(s: &str) -> &str {
    crate::jev::js_trim(s)
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `s.replace(/\s+/g, ' ')`.
fn collapse_ws(s: &str) -> String {
    let mut out = String::new();
    let mut in_ws = false;
    for c in s.chars() {
        if is_js_whitespace(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            in_ws = false;
            out.push(c);
        }
    }
    out
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `l.replace(/^\/\/\s?/, '').trim()` for a line that starts with the comment leader.
fn comment_text(l: &str) -> String {
    let rest = &l[defaults::text("setup.brief_comment").len()..];
    let rest = match rest.chars().next() {
        Some(c) if is_js_whitespace(c) => &rest[c.len_utf8()..],
        _ => rest,
    };
    js_trim(rest).to_string()
}

/// `s.replace(/^anti-hall\s*::\s*/i, '')`.
fn strip_project_lead(s: &str) -> String {
    let tag = defaults::text("setup.brief_project_tag");
    if s.len() >= tag.len() && s.is_char_boundary(tag.len()) && s[..tag.len()].eq_ignore_ascii_case(tag) {
        let rest = s[tag.len()..].trim_start_matches(is_js_whitespace);
        if let Some(r) = rest.strip_prefix(defaults::text("setup.brief_lead_sep")) {
            return r.trim_start_matches(is_js_whitespace).to_string();
        }
    }
    s.to_string()
}

/// `s.replace(/^[\w.-]+\.js\s*[\u2014\u2013]\s*/, '')`: a leading file name, then a dash.
fn strip_file_lead(s: &str) -> String {
    let run: String = s.chars().take_while(|c| is_word(*c) || *c == '.' || *c == '-').collect();
    if run.len() >= defaults::num("setup.brief_file_min") as usize && run.ends_with(defaults::text("setup.brief_js_suffix")) {
        let rest = s[run.len()..].trim_start_matches(is_js_whitespace);
        if let Some(c) = rest.chars().next()
            && defaults::text("setup.brief_dashes").contains(c)
        {
            return rest[c.len_utf8()..].trim_start_matches(is_js_whitespace).to_string();
        }
    }
    s.to_string()
}

/// `s.replace(new RegExp('^' + base + '\\b[\\s\u2014\u2013:]*'), '')`.
fn strip_name_lead(s: &str, base: &str) -> String {
    let Some(rest) = s.strip_prefix(base) else { return s.to_string() };
    let last_word = base.chars().next_back().is_some_and(is_word);
    let next_word = rest.chars().next().is_some_and(is_word);
    if last_word == next_word {
        return s.to_string(); // no word boundary after the name
    }
    let (dashes, seps) = (defaults::text("setup.brief_dashes"), defaults::text("setup.brief_name_seps"));
    rest.trim_start_matches(|c: char| is_js_whitespace(c) || dashes.contains(c) || seps.contains(c)).to_string()
}

/// True for `/^[\w.-]+$/`.
fn is_plain_token(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| is_word(c) || c == '.' || c == '-')
}

/// True for `/^\([^)]*\)$/`.
fn is_scope_only(s: &str) -> bool {
    s.len() >= 2 && s.starts_with('(') && s.ends_with(')') && !s[1..s.len() - 1].contains(')')
}

/// True when the line starts with one of the keywords that mean "code, not a header" followed by a word boundary.
fn starts_like_code(l: &str) -> bool {
    defaults::list("setup.brief_code_words").into_iter().any(|w| l.strip_prefix(w).is_some_and(|r| !r.chars().next().is_some_and(is_word)))
}

/// True for the strict-mode directive line: the word in matching or mixed quotes, with an optional semicolon.
fn is_strict_directive(l: &str) -> bool {
    let word = defaults::text("setup.brief_strict_word");
    let body = l.strip_suffix(';').unwrap_or(l);
    let quote = |c: Option<char>| matches!(c, Some('\'' | '"'));
    body.len() == word.len() + 2 && quote(body.chars().next()) && quote(body.chars().next_back()) && body.get(1..=word.len()) == Some(word)
}

/// True for a rule line of a header comment (a few dashes, equals signs or asterisks).
fn is_rule_line(t: &str) -> bool {
    let chars = defaults::text("setup.brief_rule_chars");
    t.len() >= defaults::num("setup.brief_rule_min") as usize && t.chars().all(|c| chars.contains(c))
}

/// `purposeOf(file)`: the one-line purpose from a JS file's header comment.
fn purpose_of(file: &str) -> String {
    // only the start of the file is looked at, so only the start is read
    let head = match read_prefix(Path::new(file), defaults::num("setup.brief_scan_bytes")) {
        Ok(h) => h,
        Err(e) => {
            warn(&defaults::render("setup.msg_treated_absent", &[("error", &e)]));
            None
        }
    };
    let Some(txt) = head.map(text_of).filter(|t| !t.is_empty()) else { return defaults::text("setup.brief_unreadable").to_string() };
    let lines: Vec<&str> = txt.split('\n').collect();
    let base = Path::new(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let base = base.strip_suffix(defaults::text("setup.brief_js_suffix")).unwrap_or(&base).to_string();
    let leader = defaults::text("setup.brief_comment");
    for i in 0..lines.len().min(defaults::num("setup.brief_header_lines") as usize) {
        let l = js_trim(lines[i]);
        if l.is_empty() || l.starts_with(defaults::text("setup.brief_shebang")) || is_strict_directive(l) {
            continue;
        }
        if !l.starts_with(leader) {
            if starts_like_code(l) {
                break;
            }
            continue;
        }
        let mut out = comment_text(l);
        if out.is_empty() {
            continue;
        }
        out = strip_project_lead(&out);
        out = strip_file_lead(&out);
        out = strip_name_lead(&out, &base);
        out = js_trim(&out).to_string();
        let scope_only = is_scope_only(&out);
        if out.is_empty() || is_plain_token(&out) || scope_only {
            let scope = if scope_only { out.clone() } else { String::new() };
            for next in lines.iter().take(lines.len().min(i + 1 + defaults::num("setup.brief_lookahead_lines") as usize)).skip(i + 1) {
                let c = js_trim(next);
                if !c.starts_with(leader) {
                    break;
                }
                let t = comment_text(c);
                if t.is_empty() || is_rule_line(&t) {
                    continue;
                }
                if !t.chars().any(|ch| ch.is_ascii_lowercase()) && len16(&t) <= defaults::num("setup.brief_caps_header_max") as usize {
                    continue;
                }
                out = if scope.is_empty() { t } else { format!("{scope}{}{t}", defaults::text("setup.brief_scope_sep")) };
                break;
            }
        }
        return slice16(&collapse_ws(&out), 0, defaults::num("setup.brief_purpose_max") as usize);
    }
    defaults::text("setup.brief_no_header").to_string()
}

/// `text.match(/^<prefix>\s*(.+)$/m)` (or `\s+` when `min_ws` is 1): the first capture. `\s` can run over line breaks,
/// and when the text ends inside the white space the engine backtracks one character to give `.+` something to match.
fn line_capture(text: &str, prefix: &str, min_ws: usize) -> Option<String> {
    let c: Vec<char> = text.chars().collect();
    let pre: Vec<char> = prefix.chars().collect();
    let mut starts = vec![0usize];
    starts.extend(c.iter().enumerate().filter(|(_, ch)| is_line_terminator(**ch)).map(|(i, _)| i + 1));
    for s in starts {
        if s > c.len() || !c[s..].starts_with(&pre) {
            continue;
        }
        let ws_start = s + pre.len();
        let mut ws_end = ws_start;
        while ws_end < c.len() && is_js_whitespace(c[ws_end]) {
            ws_end += 1;
        }
        if ws_end - ws_start < min_ws {
            continue;
        }
        let capture_from = |k: usize| -> String { c[k..].iter().take_while(|ch| !is_line_terminator(**ch)).collect() };
        if ws_end < c.len() {
            return Some(capture_from(ws_end));
        }
        for k in (ws_start + min_ws..ws_end).rev() {
            if !is_line_terminator(c[k]) {
                return Some(capture_from(k));
            }
        }
    }
    None
}

/// The frontmatter body: `text.match(/^---\s*\n([\s\S]*?)\n---/)`.
fn frontmatter(text: &str) -> String {
    let c: Vec<char> = text.chars().collect();
    let fence = defaults::text("setup.brief_fence");
    if !text.starts_with(fence) {
        return String::new();
    }
    let fence_len = fence.chars().count();
    let mut w_end = fence_len;
    while w_end < c.len() && is_js_whitespace(c[w_end]) {
        w_end += 1;
    }
    let Some(k) = (fence_len..w_end).rev().find(|k| c[*k] == '\n') else { return String::new() };
    let close: Vec<char> = format!("\n{fence}").chars().collect();
    match (k + 1..c.len()).find(|m| c[*m..].starts_with(&close)) {
        Some(m) => c[k + 1..m].iter().collect(),
        None => String::new(),
    }
}

struct Skill {
    name: String,
    description: String,
}

/// `skillMeta(skillMd)`.
fn skill_meta(path: &str) -> Option<Skill> {
    let txt = read_text(path).filter(|t| !t.is_empty())?;
    let body = frontmatter(&txt);
    let name = line_capture(&body, defaults::text("setup.brief_key_name"), 0).unwrap_or_default();
    let mut desc = line_capture(&body, defaults::text("setup.brief_key_desc"), 0).unwrap_or_default();
    // a double-quoted YAML scalar (the escapes are JSON-compatible)
    let tail = desc.trim_end_matches(is_js_whitespace);
    if desc.starts_with('"') && tail.len() >= 2 && tail.ends_with('"') {
        let max_depth = defaults::num("setup.json_max_depth") as usize;
        if let Ok(J::Str(s)) = json::parse(js_trim(&desc), max_depth) {
            desc = s;
        }
    }
    let mut desc = js_trim(&collapse_ws(&desc)).to_string();
    let max = defaults::num("setup.brief_skill_desc_max") as usize;
    if len16(&desc) > max {
        desc =
            format!("{}{}", slice16(&desc, 0, max.saturating_sub(defaults::num("setup.brief_ellipsis_cut") as usize)), defaults::text("setup.brief_ellipsis"));
    }
    Some(Skill { name: js_trim(&name).to_string(), description: desc })
}

/// `firstHeading(mdPath)`.
fn first_heading(path: &str) -> String {
    let Some(txt) = read_text(path).filter(|t| !t.is_empty()) else { return String::new() };
    match line_capture(&txt, defaults::text("setup.brief_heading_mark"), 1) {
        Some(h) => slice16(js_trim(&collapse_ws(&h)), 0, defaults::num("setup.brief_heading_max") as usize),
        None => String::new(),
    }
}

/// The first `[\w-]+\.js` in a command string.
fn first_js_file(cmd: &str) -> Option<String> {
    let c: Vec<char> = cmd.chars().collect();
    let mut i = 0;
    while i < c.len() {
        if is_word(c[i]) || c[i] == '-' {
            let start = i;
            while i < c.len() && (is_word(c[i]) || c[i] == '-') {
                i += 1;
            }
            let suffix: Vec<char> = defaults::text("setup.brief_js_suffix").chars().collect();
            if c[i..].starts_with(&suffix) {
                return Some(c[start..i].iter().collect::<String>() + defaults::text("setup.brief_js_suffix"));
            }
        } else {
            i += 1;
        }
    }
    None
}

fn truthy(v: Option<&J>) -> bool {
    match v {
        None | Some(J::Null) => false,
        Some(J::Bool(b)) => *b,
        Some(J::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(J::Str(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

struct Entry {
    file: String,
    matcher: Option<String>,
    purpose: String,
}

struct Briefing {
    /// `None` is JavaScript `undefined` (the key is then left out of the JSON).
    version: Option<J>,
    hooks_by_event: Vec<(String, Vec<Entry>)>,
    shared: Vec<Entry>,
    skills: Vec<Skill>,
    mechanical: Vec<Entry>,
    store: Option<Entry>,
    cli: Option<(Entry, Vec<String>)>,
    migration: Vec<Entry>,
    supervisor: Vec<Entry>,
    docs_dir: String,
    kb: Option<Vec<(String, String)>>,
}

/// The documented subcommands of `scripts/devswarm.js`: the first word of each indented comment line under the marker.
fn subcommands(txt: &str) -> Vec<String> {
    let mut cmds: Vec<String> = Vec::new();
    let Some(start) = txt.find(defaults::text("setup.brief_sub_marker")) else { return cmds };
    let indent = defaults::num("setup.brief_sub_indent") as usize;
    for l in txt[start..].split('\n').skip(1) {
        let Some(rest) = l.strip_prefix(defaults::text("setup.brief_comment")) else { break };
        let cs: Vec<char> = rest.chars().collect();
        if cs.len() <= indent || !cs[..indent].iter().all(|c| is_js_whitespace(*c)) || !cs[indent].is_ascii_lowercase() {
            continue;
        }
        let first = indent + 1;
        let mut end = first;
        while end < cs.len() && (is_word(cs[end]) || cs[end] == '-') {
            end += 1;
        }
        // `\b` after the greedy run: give back trailing characters until a word boundary
        while end > first && is_word(cs[end - 1]) == cs.get(end).copied().is_some_and(is_word) {
            end -= 1;
        }
        let tok: String = cs[indent..end].iter().collect();
        if !cmds.contains(&tok) {
            cmds.push(tok);
        }
    }
    cmds
}

fn gather(root: &str) -> Briefing {
    let hooks_dir = join(root, defaults::text("setup.brief_hooks_dir"));
    let depth = defaults::num("setup.json_max_depth") as usize;
    // `JSON.parse(...).version`: a non-object that is not null has no such member (undefined); null throws, and so does a
    // missing or unparsable file, which leaves the placeholder.
    let version = match read_text(&join(root, defaults::text("setup.brief_plugin_json"))).and_then(|t| json::parse(&t, depth).ok()) {
        Some(j @ J::Obj(_)) => j.get(defaults::text("setup.brief_version_key")).cloned(),
        Some(J::Null) | None => Some(J::Str(defaults::text("setup.brief_unknown_version").to_string())),
        Some(_) => None,
    };
    let mut hooks_by_event: Vec<(String, Vec<Entry>)> = Vec::new();
    let mut registered: Vec<String> = Vec::new();
    let cfg = read_text(&join(&hooks_dir, defaults::text("setup.brief_registry_file"))).and_then(|t| json::parse(&t, depth).ok());
    if let Some(J::Obj(top)) = &cfg
        && let Some((_, J::Obj(events))) = top.iter().find(|(k, _)| k == defaults::text("setup.brief_hooks_key"))
    {
        for (event, groups) in events {
            let mut seen = Vec::new();
            if let J::Arr(groups) = groups {
                for g in groups {
                    let matcher = g.get(defaults::text("setup.brief_matcher_key")).filter(|m| truthy(Some(m))).map(js_string).unwrap_or_default();
                    if let Some(J::Arr(hs)) = g.get(defaults::text("setup.brief_hooks_key")) {
                        for h in hs {
                            let cmd = h.get(defaults::text("setup.brief_command_key")).filter(|c| truthy(Some(c))).map(js_string).unwrap_or_default();
                            let Some(file) = first_js_file(&cmd) else { continue };
                            registered.push(file.clone());
                            let purpose = purpose_of(&join(&hooks_dir, &file));
                            seen.push(Entry { file, matcher: Some(matcher.clone()), purpose });
                        }
                    }
                }
            }
            hooks_by_event.push((event.clone(), seen));
        }
    }
    let js = defaults::text("setup.brief_js_suffix");
    let mut shared = Vec::new();
    for f in list_files(&hooks_dir, &|f| f.ends_with(js)) {
        if !registered.contains(&f) {
            let purpose = purpose_of(&join(&hooks_dir, &f));
            shared.push(Entry { file: f, matcher: None, purpose });
        }
    }
    let lib_name = defaults::text("setup.brief_lib_dir");
    let lib = join(&hooks_dir, lib_name);
    for f in list_files(&lib, &|f| f.ends_with(js)) {
        let purpose = purpose_of(&join(&lib, &f));
        shared.push(Entry { file: format!("{lib_name}/{f}"), matcher: None, purpose });
    }
    let skills_dir = defaults::text("setup.brief_skills_dir");
    let mut skills = Vec::new();
    for d in list_files(&join(root, skills_dir), &|_| true) {
        let sm = join(root, &format!("{skills_dir}/{d}/{}", defaults::text("setup.brief_skill_file")));
        if !is_file(&sm) {
            continue;
        }
        if let Some(m) = skill_meta(&sm) {
            skills.push(m);
        }
    }
    let entry_of = |rel: String| Entry { purpose: purpose_of(&join(root, &rel)), file: rel, matcher: None };
    let mechanical = defaults::list("setup.brief_mechanical_hooks")
        .into_iter()
        .filter(|f| is_file(&join(&hooks_dir, f)))
        .map(|f| Entry { file: f.to_string(), matcher: None, purpose: purpose_of(&join(&hooks_dir, f)) })
        .collect();
    let store_rel = defaults::text("setup.brief_store_file");
    let store = is_file(&join(root, store_rel)).then(|| entry_of(store_rel.to_string()));
    let cli_rel = defaults::text("setup.brief_cli_file");
    let cli_path = join(root, cli_rel);
    let cli = is_file(&cli_path).then(|| {
        let cmds = subcommands(&read_text(&cli_path).unwrap_or_default());
        (entry_of(cli_rel.to_string()), cmds)
    });
    let companion_dir = defaults::text("setup.brief_companion_dir");
    let companion = |key: &str| -> Vec<Entry> {
        defaults::list(key)
            .into_iter()
            .filter(|f| is_file(&join(root, &format!("{companion_dir}{f}"))))
            .map(|f| entry_of(format!("{companion_dir}{f}")))
            .collect()
    };
    let migration = companion("setup.brief_migration_files");
    let supervisor = companion("setup.brief_supervisor_files");
    let docs_dir = resolve(root, defaults::text("setup.brief_docs_rel"));
    let kb = is_dir(&docs_dir).then(|| {
        list_files(&docs_dir, &|f| f.starts_with(defaults::text("setup.brief_kb_prefix")) && f.ends_with(defaults::text("setup.brief_kb_suffix")))
            .into_iter()
            .map(|f| (format!("{}{f}", defaults::text("setup.brief_docs_prefix")), first_heading(&join(&docs_dir, &f))))
            .collect()
    });
    Briefing { version, hooks_by_event, shared, skills, mechanical, store, cli, migration, supervisor, docs_dir, kb }
}

fn entry_json(e: &Entry) -> J {
    obj(vec![("file", J::Str(e.file.clone())), ("purpose", J::Str(e.purpose.clone()))])
}

fn briefing_json(b: &Briefing) -> J {
    let mut top: Vec<(String, J)> = Vec::new();
    if let Some(v) = &b.version {
        top.push(("version".into(), v.clone()));
    }
    let events = b
        .hooks_by_event
        .iter()
        .map(|(ev, hs)| {
            let items = hs
                .iter()
                .map(|h| {
                    obj(vec![
                        ("file", J::Str(h.file.clone())),
                        ("matcher", J::Str(h.matcher.clone().unwrap_or_default())),
                        ("purpose", J::Str(h.purpose.clone())),
                    ])
                })
                .collect();
            (ev.clone(), J::Arr(items))
        })
        .collect();
    top.push(("hooksByEvent".into(), J::Obj(events)));
    top.push(("sharedHelpers".into(), J::Arr(b.shared.iter().map(entry_json).collect())));
    top.push((
        "skills".into(),
        J::Arr(b.skills.iter().map(|s| obj(vec![("name", J::Str(s.name.clone())), ("description", J::Str(s.description.clone()))])).collect()),
    ));
    let cli = match &b.cli {
        Some((e, cmds)) => obj(vec![
            ("file", J::Str(e.file.clone())),
            ("purpose", J::Str(e.purpose.clone())),
            ("subcommands", J::Arr(cmds.iter().map(|c| J::Str(c.clone())).collect())),
        ]),
        None => J::Null,
    };
    let substrate = obj(vec![
        ("mechanicalHooks", J::Arr(b.mechanical.iter().map(entry_json).collect())),
        ("store", b.store.as_ref().map_or(J::Null, entry_json)),
        ("cli", cli),
        ("migration", J::Arr(b.migration.iter().map(entry_json).collect())),
        ("supervisor", J::Arr(b.supervisor.iter().map(entry_json).collect())),
    ]);
    top.push(("devswarm".into(), substrate));
    let docs = match &b.kb {
        Some(kb) => obj(vec![
            ("present", J::Bool(true)),
            ("dir", J::Str(b.docs_dir.clone())),
            ("kb", J::Arr(kb.iter().map(|(f, t)| obj(vec![("file", J::Str(f.clone())), ("title", J::Str(t.clone()))])).collect())),
        ]),
        None => obj(vec![("present", J::Bool(false)), ("note", J::Str(defaults::text("setup.brief_docs_note").to_string()))]),
    };
    top.push(("docs".into(), docs));
    J::Obj(top)
}

/// The colour codes (all empty when the output is not a terminal).
struct Colors {
    codes: Vec<(&'static str, String)>,
}

fn colors(on: bool) -> Colors {
    let codes = defaults::raw("setup.brief_colors")
        .as_table()
        .unwrap_or(&[])
        .iter()
        .map(|(name, code)| (*name, if on { code.as_str().unwrap_or("").to_string() } else { String::new() }))
        .collect();
    Colors { codes }
}

/// A line template with the colour placeholders filled in, and the `extra` ones.
fn tpl(key: &str, k: &Colors, extra: &[(&str, &dyn std::fmt::Display)]) -> String {
    let mut args: Vec<(&str, &dyn std::fmt::Display)> = k.codes.iter().map(|(n, v)| (*n, v as &dyn std::fmt::Display)).collect();
    args.extend_from_slice(extra);
    defaults::render(key, &args)
}

fn render(b: &Briefing, k: &Colors) -> String {
    let mut out: Vec<String> = Vec::new();
    let item = |e: &Entry, key: &str| tpl(key, k, &[("file", &e.file), ("purpose", &e.purpose)]);
    let ver = b.version.as_ref().map_or_else(|| defaults::text("setup.word_undefined").to_string(), js_string);
    out.push(tpl("setup.fmt_brief_title", k, &[("version", &ver)]));
    out.push(tpl("setup.fmt_brief_derived", k, &[("line", &defaults::text("setup.brief_derived_line"))]));
    out.push(tpl("setup.fmt_brief_hooks_h", k, &[]));
    for (event, arr) in &b.hooks_by_event {
        out.push(tpl("setup.fmt_brief_event", k, &[("event", event)]));
        for h in arr {
            let matcher = match h.matcher.as_deref() {
                Some(m) if !m.is_empty() => tpl("setup.fmt_brief_matcher", k, &[("matcher", &m)]),
                _ => String::new(),
            };
            out.push(tpl("setup.fmt_brief_hook", k, &[("file", &h.file), ("matcher", &matcher), ("purpose", &h.purpose)]));
        }
    }
    if !b.shared.is_empty() {
        out.push(tpl("setup.fmt_brief_shared_h", k, &[]));
        for h in &b.shared {
            out.push(item(h, "setup.fmt_brief_shared"));
        }
    }
    out.push(tpl("setup.fmt_brief_skills_h", k, &[]));
    for s in &b.skills {
        out.push(tpl("setup.fmt_brief_skill", k, &[("name", &s.name), ("description", &s.description)]));
    }
    out.push(tpl("setup.fmt_brief_dev_h", k, &[]));
    let group = |title: &str| tpl("setup.fmt_brief_group", k, &[("title", &title)]);
    if !b.mechanical.is_empty() {
        out.push(group(defaults::text("setup.brief_group_mechanical")));
        for h in &b.mechanical {
            out.push(item(h, "setup.fmt_brief_item"));
        }
    }
    if let Some(s) = &b.store {
        out.push(format!("{}\n{}", group(defaults::text("setup.brief_group_store")), item(s, "setup.fmt_brief_item")));
    }
    if let Some((c, cmds)) = &b.cli {
        out.push(format!("{}\n{}", group(defaults::text("setup.brief_group_cli")), item(c, "setup.fmt_brief_item")));
        if !cmds.is_empty() {
            out.push(tpl("setup.fmt_brief_subs", k, &[("list", &cmds.join(defaults::text("setup.brief_sub_sep")))]));
        }
    }
    if !b.migration.is_empty() {
        out.push(group(defaults::text("setup.brief_migration_title")));
        for h in &b.migration {
            out.push(item(h, "setup.fmt_brief_item"));
        }
    }
    if !b.supervisor.is_empty() {
        out.push(group(defaults::text("setup.brief_group_supervisor")));
        for h in &b.supervisor {
            out.push(item(h, "setup.fmt_brief_item"));
        }
    }
    out.push(tpl("setup.fmt_brief_docs_h", k, &[]));
    match &b.kb {
        Some(kb) => {
            for (f, t) in kb {
                out.push(tpl("setup.fmt_brief_doc", k, &[("file", f), ("title", t)]));
            }
        }
        None => out.push(tpl("setup.fmt_brief_note", k, &[("note", &defaults::text("setup.brief_docs_note"))])),
    }
    out.push(tpl("setup.fmt_brief_last", k, &[("line", &defaults::text("setup.brief_doctor_line"))]));
    out.join("\n") + "\n"
}

/// The command: `briefing [--root <plugin>] [--json]`.
pub fn run(p: &Parsed) -> Result<i32, SetupError> {
    let env = Env::process();
    let (root, _) = take_root(&p.rest, &env);
    let Some(root) = root else {
        warn(defaults::text("setup.msg_no_plugin_root"));
        return Ok(64);
    };
    // Node finds the plugin from its script's real path, so the docs directory it reports is under the real path too
    let given = resolve(&cwd()?, &root);
    let root = std::fs::canonicalize(&given).map_err(super::io_err(what("setup.what_resolve", &given)))?.to_string_lossy().into_owned();
    let b = gather(&root);
    if p.json {
        out(&pretty(&briefing_json(&b)))?;
        return Ok(0);
    }
    // SAFETY: isatty only inspects a file descriptor.
    let tty = unsafe { libc::isatty(1) } == 1;
    out_raw(&render(&b, &colors(tty)))?;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subcommand_tokens_follow_the_word_boundary_rule() {
        let src = "// SUBCOMMANDS\n//   list  all\n//   sync- x\n//    four spaces\n//   list again\nrest";
        assert_eq!(subcommands(src), vec!["list".to_string(), "sync".to_string()]);
    }

    #[test]
    fn a_name_line_can_start_after_white_space_that_spans_lines() {
        assert_eq!(line_capture("name:\nfoo\n", "name:", 0).as_deref(), Some("foo"));
        assert_eq!(line_capture("name:   ", "name:", 0).as_deref(), Some(" "));
        assert_eq!(line_capture("#x\n# T\n", "#", 1).as_deref(), Some("T"));
    }

    #[test]
    fn frontmatter_is_the_text_between_the_dashes() {
        assert_eq!(frontmatter("---\nname: a\n---\nbody"), "name: a");
        assert_eq!(frontmatter("no"), "");
    }

    #[test]
    fn a_header_lead_is_stripped_in_the_documented_order() {
        assert_eq!(strip_project_lead("anti-hall :: x"), "x");
        assert_eq!(strip_file_lead("merge-gate.js \u{2014} gate"), "gate");
        assert_eq!(strip_name_lead("merge-gate \u{2014} gate", "merge-gate"), "gate");
        assert_eq!(strip_name_lead("merge-gates x", "merge-gate"), "merge-gates x");
    }
}
