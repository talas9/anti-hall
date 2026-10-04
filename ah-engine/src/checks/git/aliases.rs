//! git-guard's alias and reused-message checks (lib/git-alias-scan.js).
use super::gitcmd::*;
use super::segments::scan_command;
use super::tokenize::*;
use super::util::*;
use super::Ctx;
use crate::checks::lit_re;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Duration;

/// Mirrors `lib/git-alias-scan.js` `GIT_BUILTINS`.
const GIT_BUILTINS: &str = "add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential describe diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook index-pack init instaweb interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes p4 pack-objects pack-redundant pack-refs prune prune-packed pull push range-diff read-tree rebase receive-pack reflog remote repack replace request-pull rerere reset restore rev-list rev-parse revert rm send-email send-pack shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree";

const MAX_CHAIN: usize = 10;

/// Environment assignments (`NAME=value`) that prefix a command, keyed by name.
pub type Env = HashMap<String, String>;

/// Mirrors `lib/git-alias-scan.js` `repoArgs`.
fn repo_args(args: &[Tok]) -> Vec<String> {
    let mut out = Vec::new();
    let mut k = 0;
    while k < args.len() {
        let t = args[k].text.as_str();
        if (t == "-C" || t == "--git-dir" || t == "--work-tree") && k + 1 < args.len() {
            out.push(t.to_string());
            out.push(args[k + 1].text.clone());
            k += 2;
            continue;
        }
        if t.starts_with("--git-dir=") || t.starts_with("--work-tree=") {
            out.push(t.to_string());
            k += 1;
            continue;
        }
        if t == "-c" || t == "--namespace" || t == "--exec-path" || t == "--config-env" {
            k += 2;
            continue;
        }
        if t.starts_with('-') {
            k += 1;
            continue;
        }
        break;
    }
    out
}

fn forward_env_name(n: &str) -> bool {
    if matches!(n, "GIT_DIR" | "GIT_WORK_TREE" | "HOME" | "XDG_CONFIG_HOME") {
        return true;
    }
    if let Some(r) = n.strip_prefix("GIT_CONFIG_") {
        if matches!(r, "GLOBAL" | "SYSTEM" | "NOSYSTEM" | "COUNT" | "PARAMETERS") {
            return true;
        }
        for p in ["KEY_", "VALUE_"] {
            if let Some(d) = r.strip_prefix(p) {
                return !d.is_empty() && d.chars().all(|c| c.is_ascii_digit());
            }
        }
    }
    false
}

fn split_assign(s: &str) -> Option<(&str, &str)> {
    if !is_assign(s) {
        return None;
    }
    let eq = s.find('=')?;
    Some((&s[..eq], &s[eq + 1..]))
}

/// The leading assignments of a command that a wrapper forwards to what it runs; quoted-only words are skipped because the shell would not treat them as assignments.
///
/// Mirrors `lib/git-alias-scan.js` `forwardable`.
pub fn forwardable(tokens: &[Tok]) -> Env {
    let mut out = Env::new();
    for t in tokens {
        if t.quoted_only {
            continue;
        }
        let Some((name, val)) = split_assign(&t.text) else { continue };
        if !forward_env_name(name) {
            continue;
        }
        if val.contains('$') || val.contains('`') || val.contains(CMDSUBST) {
            continue;
        }
        out.insert(name.to_string(), val.to_string());
    }
    out
}

/// (inline, persist) environment of one segment.
///
/// Mirrors `lib/git-alias-scan.js` `segmentEnv`.
pub fn segment_env(tokens: &[Tok]) -> (Env, Env) {
    if let Some(gi) = tokens.iter().position(|t| !t.quoted_only && t.text == "git") {
        return (forwardable(&tokens[..gi]), Env::new());
    }
    let first = if !tokens.is_empty() && !tokens[0].quoted_only { tokens[0].text.as_str() } else { "" };
    let all_assign = tokens.iter().all(|t| !t.quoted_only && is_assign(&t.text));
    if first == "export" || first == "declare" || all_assign {
        return (Env::new(), forwardable(tokens));
    }
    (Env::new(), Env::new())
}

/// Mirrors `lib/git-alias-scan.js` `spawnCwd`.
fn spawn_cwd(ctx: &Ctx, dir: Option<&str>) -> String {
    if let Some(d) = dir {
        if !d.is_empty() && std::fs::metadata(d).map(|m| m.is_dir()).unwrap_or(false) {
            return d.to_string();
        }
    }
    ctx.proc_cwd.clone()
}

fn git_run(ctx: &mut Ctx, argv: &[String], dir: Option<&str>, env: &Env) -> Option<String> {
    let cwd = spawn_cwd(ctx, dir);
    let mut keys: Vec<(&String, &String)> = env.iter().collect();
    keys.sort();
    let key = format!("{:?}|{}|{:?}", argv, cwd, keys);
    if let Some(v) = ctx.git_cache.get(&key) {
        return v.clone();
    }
    let r = run_capture("git", argv, if cwd.is_empty() { None } else { Some(&cwd) }, env, Duration::from_millis(1500));
    ctx.git_cache.insert(key, r.clone());
    r
}

/// Mirrors `lib/git-alias-scan.js` `aliasesFor`.
fn aliases_for(ctx: &mut Ctx, args: &[Tok], dir: Option<&str>, env: &Env) -> HashMap<String, String> {
    let ra = repo_args(args);
    let cwd = spawn_cwd(ctx, dir);
    let mut keys: Vec<(&String, &String)> = env.iter().collect();
    keys.sort();
    let key = format!("{:?}|{}|{:?}", ra, cwd, keys);
    if let Some(m) = ctx.alias_cache.get(&key) {
        return m.clone();
    }
    let mut map: HashMap<String, String> = HashMap::new();
    let mut argv = ra.clone();
    argv.extend(["config", "-z", "--get-regexp", "^alias\\."].iter().map(|s| s.to_string()));
    if let Some(out) = git_run(ctx, &argv, dir, env) {
        for rec in out.split('\0') {
            let Some(nl) = rec.find('\n') else { continue };
            if nl == 0 {
                continue;
            }
            let mut name = rec[..nl].to_string();
            if name.len() >= 6 && name[..6].eq_ignore_ascii_case("alias.") {
                name = name[6..].to_string();
            }
            let name = name.to_lowercase();
            if !name.is_empty() && !map.contains_key(&name) {
                map.insert(name, rec[nl + 1..].to_string());
            }
        }
    }
    ctx.alias_cache.insert(key, map.clone());
    map
}

/// Mirrors `lib/git-alias-scan.js` `shellWords`.
fn shell_words(tokens: &[Tok]) -> String {
    tokens
        .iter()
        .map(|t| {
            if t.text.contains(CMDSUBST) {
                "\"$(:)\"".to_string()
            } else if !t.text.is_empty() && t.text.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c)) {
                t.text.clone()
            } else {
                format!("'{}'", t.text.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Mirrors `lib/git-alias-scan.js` `firstWord`.
fn first_word(v: &str) -> (String, String) {
    let t = v.trim_start_matches(is_js_space);
    if t.is_empty() {
        return (String::new(), String::new());
    }
    for q in ['"', '\''] {
        if let Some(rest) = t.strip_prefix(q) {
            if let Some(p) = rest.find(q) {
                return (rest[..p].to_string(), rest[p + 1..].to_string());
            }
        }
    }
    let end = t.find(is_js_space).unwrap_or(t.len());
    (t[..end].to_string(), t[end..].to_string())
}

/// Mirrors `lib/git-alias-scan.js` `aliasable`.
fn aliasable(sub: &str) -> bool {
    let mut cs = sub.chars();
    let ok_first = cs.next().is_some_and(|c| c.is_ascii_alphanumeric());
    ok_first && sub.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-') && !GIT_BUILTINS.split(' ').any(|b| b == sub)
}

struct Expansion {
    chain: Vec<String>,
    verb: String,
    command: String,
}

/// Mirrors `lib/git-alias-scan.js` `expandAlias`.
fn expand_alias(ctx: &mut Ctx, args: &[Tok], sub: Option<&str>, rest: &[Tok], dir: Option<&str>, env: &Env) -> Option<Expansion> {
    let sub = sub?;
    if !ctx.alias_enabled() || !aliasable(sub) {
        return None;
    }
    let map = aliases_for(ctx, args, dir, env);
    if map.is_empty() {
        return None;
    }
    let mut name = sub.to_lowercase();
    if !map.contains_key(&name) {
        return None;
    }
    let mut chain: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut suffix = shell_words(rest);
    while chain.len() < MAX_CHAIN {
        if seen.contains(&name) {
            return None;
        }
        seen.insert(name.clone());
        let v = map.get(&name).cloned().unwrap_or_default();
        chain.push(name.clone());
        let vt = v.trim_start_matches(is_js_space);
        if let Some(body) = vt.strip_prefix('!') {
            return Some(Expansion {
                chain,
                verb: "!".into(),
                command: format!("{}{}", body, if suffix.is_empty() { String::new() } else { format!(" {suffix}") }),
            });
        }
        let (word, tail) = first_word(&v);
        if aliasable(&word) && map.contains_key(&word.to_lowercase()) {
            let t = js_trim(&tail).to_string();
            suffix = format!("{}{}", t, if suffix.is_empty() { String::new() } else { format!(" {suffix}") });
            name = word.to_lowercase();
            continue;
        }
        let prefix_toks: Vec<Tok> = repo_args(args).iter().map(|w| Tok::plain(w)).collect();
        let prefix = shell_words(&prefix_toks);
        let command = format!(
            "git {}{}{}",
            if prefix.is_empty() { String::new() } else { format!("{prefix} ") },
            js_trim(&v),
            if suffix.is_empty() { String::new() } else { format!(" {suffix}") }
        );
        return Some(Expansion { chain, verb: word, command });
    }
    None
}

/// Mirrors `lib/git-alias-scan.js` `annotate`.
fn annotate(m: &str, note: &str) -> String {
    const MARK: &str = " anti-hall \u{b7} git-guard: ";
    if let Some(sp) = m.find(|c: char| is_js_space(c)) {
        if sp > 0 && m[sp..].starts_with(MARK) {
            let cut = sp + MARK.len();
            return format!("{}{} {}", &m[..cut], note, &m[cut..]);
        }
    }
    m.to_string()
}

/// Mirrors `lib/git-alias-scan.js` `aliasBodyCommand`.
fn alias_body_command(v: &str) -> Option<String> {
    let s = js_trim(v);
    if s.is_empty() {
        return None;
    }
    Some(if let Some(r) = s.strip_prefix('!') { r.to_string() } else { format!("git {s}") })
}

/// Mirrors `lib/git-alias-scan.js` `scanBody`.
fn scan_body(ctx: &mut Ctx, body: Option<String>, note: &str, d: usize, dir: Option<&str>) -> Option<String> {
    let body = body?;
    if body.is_empty() {
        return None;
    }
    let hit = scan_command(ctx, &body, d + 1, dir)?;
    Some(annotate(&hit, note))
}

/// Mirrors `lib/git-alias-scan.js` `gitDefinitionVerdict`.
fn git_definition_verdict(ctx: &mut Ctx, args: &[Tok], sub: Option<&str>, rest: &[Tok], d: usize, dir: Option<&str>) -> Option<String> {
    let mut k = 0;
    while k + 1 < args.len() {
        if args[k].text == "-c" {
            let v = args[k + 1].text.as_str();
            // /^alias\.([^=]+)=([\s\S]*)$/i
            if v.get(..6).is_some_and(|x| x.eq_ignore_ascii_case("alias.")) {
                let rest_v = &v[6..];
                if let Some(eq) = rest_v.find('=') {
                    if eq >= 1 {
                        let name = &rest_v[..eq];
                        let body = &rest_v[eq + 1..];
                        let note = format!("defining git alias `{name}` to run a blocked command:");
                        if let Some(h) = scan_body(ctx, alias_body_command(body), &note, d, dir) {
                            return Some(h);
                        }
                    }
                }
            }
        }
        k += 1;
    }
    if sub != Some("config") {
        return None;
    }
    let mut k = 0;
    while k + 1 < rest.len() {
        let v = rest[k].text.as_str();
        // /^alias\.(\S+)$/i
        if v.get(..6).is_some_and(|x| x.eq_ignore_ascii_case("alias.")) {
            let name = &v[6..];
            if !name.is_empty() && !name.chars().any(is_js_space) {
                let note = format!("defining git alias `{name}` to run a blocked command:");
                if let Some(h) = scan_body(ctx, alias_body_command(&rest[k + 1].text), &note, d, dir) {
                    return Some(h);
                }
            }
        }
        k += 1;
    }
    None
}

// ---- reused commit messages --------------------------------------------------------------------------

/// Mirrors `lib/git-alias-scan.js` `COMMIT_LONG`.
const COMMIT_LONG: &str = "ahead-behind all allow-empty allow-empty-message amend author branch cleanup date dry-run edit file fixup gpg-sign include inter-hunk-context interactive long message no-post-rewrite no-verify null only patch pathspec-file-nul pathspec-from-file porcelain post-rewrite quiet reedit-message reset-author reuse-message short signoff squash status template trailer unified untracked-files verbose verify no-edit no-status no-signoff no-gpg-sign no-allow-empty no-amend";
/// Mirrors `lib/git-alias-scan.js` `COMMIT_LONG_VALUE`.
const COMMIT_LONG_VALUE: &[&str] = &[
    "author",
    "date",
    "message",
    "file",
    "reuse-message",
    "reedit-message",
    "fixup",
    "squash",
    "trailer",
    "cleanup",
    "template",
    "pathspec-from-file",
    "unified",
    "inter-hunk-context",
];

/// Mirrors `lib/git-alias-scan.js` `commitLong`.
fn commit_long(n: &str) -> Option<String> {
    let all: Vec<&str> = COMMIT_LONG.split(' ').collect();
    if all.contains(&n) {
        return Some(n.to_string());
    }
    let c: Vec<&&str> = all.iter().filter(|k| k.starts_with(n)).collect();
    if c.len() == 1 {
        Some(c[0].to_string())
    } else {
        None
    }
}

#[derive(Default)]
struct Sources {
    message: bool,
    reuse: Option<String>,
    reedit: bool,
    amend: bool,
    no_edit: bool,
    edit: bool,
    template: Option<String>,
}

/// Mirrors `lib/git-alias-scan.js` `commitSources`.
fn commit_sources(rest: &[Tok]) -> Sources {
    let mut o = Sources::default();
    let mut k = 0usize;
    while k < rest.len() {
        let t = rest[k].text.clone();
        if t == "--" {
            break;
        }
        // /^--([a-z-]+)(?:=([\s\S]*))?$/
        let long = t.strip_prefix("--").and_then(|r| {
            let name_len = r.chars().take_while(|c| c.is_ascii_lowercase() || *c == '-').count();
            if name_len == 0 {
                return None;
            }
            let name = &r[..name_len];
            let tail = &r[name_len..];
            if tail.is_empty() {
                Some((name.to_string(), None))
            } else {
                tail.strip_prefix('=').map(|v| (name.to_string(), Some(v.to_string())))
            }
        });
        if let Some((raw_name, val0)) = long {
            let n = commit_long(&raw_name);
            let val: Option<String> = match val0 {
                Some(v) => Some(v),
                None => {
                    if n.as_deref().is_some_and(|x| COMMIT_LONG_VALUE.contains(&x)) {
                        k += 1;
                        Some(if k < rest.len() { rest[k].text.clone() } else { String::new() })
                    } else {
                        None
                    }
                }
            };
            match n.as_deref() {
                Some("message") | Some("file") | Some("fixup") | Some("squash") => o.message = true,
                Some("reuse-message") => o.reuse = val,
                Some("reedit-message") => {
                    o.reuse = val;
                    o.reedit = true;
                }
                Some("template") => o.template = val,
                Some("amend") => o.amend = true,
                Some("no-edit") => o.no_edit = true,
                Some("edit") => o.edit = true,
                _ => {}
            }
            k += 1;
            continue;
        }
        let tc: Vec<char> = t.chars().collect();
        if !(tc.len() >= 2 && tc[0] == '-' && tc[1].is_ascii_alphabetic()) {
            k += 1;
            continue;
        }
        let mut j = 1;
        while j < tc.len() {
            let ch = tc[j];
            if ch == 'e' {
                o.edit = true;
                j += 1;
                continue;
            }
            if ch == 'S' || ch == 'u' {
                break;
            }
            if !matches!(ch, 'm' | 'F' | 'C' | 'c' | 't') {
                j += 1;
                continue;
            }
            let val: String = if j + 1 < tc.len() {
                tc[j + 1..].iter().collect()
            } else {
                k += 1;
                if k < rest.len() {
                    rest[k].text.clone()
                } else {
                    String::new()
                }
            };
            match ch {
                'm' | 'F' => o.message = true,
                'C' => o.reuse = Some(val),
                'c' => {
                    o.reuse = Some(val);
                    o.reedit = true;
                }
                't' => o.template = Some(val),
                _ => {}
            }
            break;
        }
        k += 1;
    }
    o
}

fn editor_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        lit_re(r#"(?:^|[\s;&|(])(?:(?i-u:export)\s+)?(?i-u:GIT_EDITOR|EDITOR|VISUAL)=('[^']*'|"[^"]*"|\S*)|(?i-u:core\.editor)[\s=]+('[^']*'|"[^"]*"|\S*)"#)
    })
}

fn noop_editor(v: &str) -> bool {
    // ^(?:\S*\/)?(?:true|:|cat)$
    let base = match v.rfind('/') {
        Some(p) if !v[..p].chars().any(is_js_space) => &v[p + 1..],
        Some(_) => return false,
        None => v,
    };
    matches!(base, "true" | ":" | "cat")
}

/// Mirrors `lib/git-alias-scan.js` `setsRealEditor`.
fn sets_real_editor(raw: &str) -> bool {
    for m in editor_re().captures_iter(raw) {
        let g = m.get(1).map(|x| x.as_str()).or_else(|| m.get(2).map(|x| x.as_str())).unwrap_or("");
        let mut v = g.to_string();
        let cs: Vec<char> = v.chars().collect();
        if cs.len() >= 2 && (cs[0] == '\'' || cs[0] == '"') && cs[cs.len() - 1] == cs[0] {
            v = cs[1..cs.len() - 1].iter().collect();
        }
        let v = js_trim(&v).to_string();
        if !noop_editor(&v) {
            return true;
        }
    }
    false
}

/// Mirrors `lib/git-alias-scan.js` `readTemplate`.
fn read_template(ctx: &mut Ctx, args: &[Tok], dir: Option<&str>, explicit: Option<&str>, env: &Env) -> Option<String> {
    let mut p: String = explicit.unwrap_or("").to_string();
    if p.is_empty() {
        let mut argv = repo_args(args);
        argv.extend(["config", "--path", "--get", "commit.template"].iter().map(|s| s.to_string()));
        let out = git_run(ctx, &argv, dir, env);
        p = out.map(|o| js_trim(&o).to_string()).unwrap_or_default();
    }
    if p.is_empty() {
        return None;
    }
    if p == "~" || p.starts_with("~/") {
        let home = env.get("HOME").cloned().filter(|h| !h.is_empty()).unwrap_or_else(|| ctx.home.clone());
        p = path_join(&home, &p[1..]);
    }
    let base = spawn_cwd(ctx, dir);
    let abs = resolve(&base, &p, &ctx.proc_cwd);
    read_file_lossy(&abs)
}

/// Mirrors `lib/git-alias-scan.js` `reusedMessageVerdict`.
fn reused_message_verdict(ctx: &mut Ctx, args: &[Tok], rest: &[Tok], dir: Option<&str>, env: &Env) -> Option<String> {
    if !ctx.reuse_enabled() {
        return None;
    }
    let o = commit_sources(rest);
    if o.message {
        return None;
    }
    let text: Option<String>;
    let origin: String;
    let mut verbatim = false;
    let reuse = o.reuse.clone().filter(|r| !r.is_empty());
    if let Some(r) = reuse.as_ref().filter(|r| !r.starts_with('-')) {
        let mut argv = repo_args(args);
        argv.extend(["log", "-1", "--format=%B", r.as_str(), "--"].iter().map(|s| s.to_string()));
        text = git_run(ctx, &argv, dir, env);
        let hex = r.len() >= 40 && r.chars().all(|c| c.is_ascii_hexdigit());
        origin = format!("commit `{}`", if hex { &r[..12] } else { r.as_str() });
        verbatim = !o.reedit && !o.edit;
        if o.no_edit {
            verbatim = true;
        }
    } else if o.amend {
        let mut argv = repo_args(args);
        argv.extend(["log", "-1", "--format=%B", "HEAD", "--"].iter().map(|s| s.to_string()));
        text = git_run(ctx, &argv, dir, env);
        origin = "HEAD (`--amend` reuses it)".to_string();
        verbatim = o.no_edit;
    } else if !o.no_edit {
        text = read_template(ctx, args, dir, o.template.as_deref(), env);
        origin = "the commit template".to_string();
    } else {
        text = None;
        origin = String::new();
    }
    let text = text.filter(|t| !t.is_empty())?;
    if !has_self_credit(ctx, &text) {
        return None;
    }
    let raw = ctx.raw_cmd.clone();
    if !verbatim && sets_real_editor(&raw) {
        return None;
    }
    Some(msg(
        &format!("a commit whose message is taken from {origin} and carries an AI/assistant self-credit trailer is blocked."),
        "Commits carry no AI co-author credit, even when the message is reused rather than typed.",
        "commit with an explicit clean message (`-m \"<msg>\"` or `-F <file>`) instead of reusing that one.",
    ))
}

/// gitVerdict hook: alias definitions, alias use, reused commit messages.
///
/// Mirrors `lib/git-alias-scan.js` `gitVerdict`.
pub fn alias_git_verdict(ctx: &mut Ctx, args: &[Tok], sub: &str, rest: &[Tok], dir: Option<&str>, depth: usize, env: &Env) -> Option<String> {
    if ctx.alias_enabled() {
        if let Some(def) = git_definition_verdict(ctx, args, Some(sub), rest, depth, dir) {
            return Some(def);
        }
        if depth < 3 {
            if let Some(ex) = expand_alias(ctx, args, Some(sub), rest, dir, env) {
                if let Some(hit) = scan_command(ctx, &ex.command, depth + 1, dir) {
                    let note = format!("via git alias `{}`:", ex.chain.join("` -> `"));
                    return Some(annotate(&hit, &note));
                }
            }
        }
    }
    if sub == "commit" {
        return reused_message_verdict(ctx, args, rest, dir, env);
    }
    None
}

// ---- shell aliases / functions defined in the same command ---------------------------------------------

/// A shell alias or function defined earlier in the same command text, kept so a later use of it is scanned as the command it expands to.
#[derive(Clone)]
pub struct ShellDef {
    is_alias: bool,
    body: String,
}

/// Mirrors `lib/git-alias-scan.js` `matchingClose`.
fn matching_close(text: &str, open: usize) -> Option<usize> {
    let b = text.as_bytes();
    let openc = b[open];
    let want = if openc == b'{' { b'}' } else { b')' };
    let mut depth = 0i32;
    for (k, &c) in b.iter().enumerate().skip(open) {
        if c == openc {
            depth += 1;
        } else if c == want {
            depth -= 1;
            if depth == 0 {
                return Some(k);
            }
        }
    }
    None
}

/// Mirrors `lib/git-alias-scan.js` `unquote`.
fn unquote(v: &str) -> String {
    let mut s = v.to_string();
    if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        s = s[1..s.len() - 1].to_string();
    }
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s = s[1..s.len() - 1].to_string();
    }
    s
}

/// Mirrors `lib/git-alias-scan.js` `shellDefs`.
fn shell_defs(ctx: &mut Ctx) -> std::rc::Rc<HashMap<String, ShellDef>> {
    if let Some(d) = &ctx.shell_defs {
        return d.clone();
    }
    let raw_owned = ctx.raw_cmd.clone();
    let raw = raw_owned.as_str();
    static ALIAS_RE: OnceLock<Regex> = OnceLock::new();
    static FN_RE: OnceLock<Regex> = OnceLock::new();
    static FN_PAREN: OnceLock<Regex> = OnceLock::new();
    static FN_KW: OnceLock<Regex> = OnceLock::new();
    let alias_re = ALIAS_RE.get_or_init(|| lit_re(r#"(?:^|[\s;&|(])alias[ \t]+([A-Za-z_][A-Za-z0-9_.-]*)=('[^']*'|"(?:[^"\\]|\\.)*"|[^\s;&|]*)"#));
    let fn_re = FN_RE.get_or_init(|| lit_re(r#"(?:^|[\s;&|('"`]|(?-u:\b)function[ \t]+)[ \t]*([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*(?:\([ \t]*\))?[ \t\n]*([{(])"#));
    let fn_paren = FN_PAREN.get_or_init(|| lit_re(r"\(\s*\)\s*[{(]$"));
    let fn_kw = FN_KW.get_or_init(|| lit_re(r"(?-u:\b)function[ \t]"));
    let mut defs: HashMap<String, ShellDef> = HashMap::new();
    for m in alias_re.captures_iter(raw) {
        defs.insert(m[1].to_string(), ShellDef { is_alias: true, body: unquote(&m[2]) });
    }
    for m in fn_re.captures_iter(raw) {
        let whole = m.get(0).expect("group 0 is the whole match");
        let open = whole.end() - 1;
        if !fn_paren.is_match(whole.as_str()) && !fn_kw.is_match(whole.as_str()) {
            continue;
        }
        if let Some(close) = matching_close(raw, open) {
            if close > open {
                defs.insert(m[1].to_string(), ShellDef { is_alias: false, body: raw[open + 1..close].to_string() });
            }
        }
    }
    let rc = std::rc::Rc::new(defs);
    ctx.shell_defs = Some(rc.clone());
    rc
}

/// Mirrors `lib/git-alias-scan.js` `varRef`.
fn var_ref(n: &str) -> Regex {
    lit_re(&format!(r"\$(?:\{{{n}(?-u:\b)|{n}(?-u:\b))"))
}

/// Mirrors `lib/git-alias-scan.js` `varIsExecuted`.
fn var_is_executed(body: &str, name: &str, names: &mut HashSet<String>) -> bool {
    static PIPE_SH: OnceLock<Regex> = OnceLock::new();
    static SHELL_WORD: OnceLock<Regex> = OnceLock::new();
    static DERIVED: OnceLock<Regex> = OnceLock::new();
    let pipe_sh = PIPE_SH.get_or_init(|| lit_re(r"\|[ \t]*(?:\S*/)?(?:(?:ba|z|da|k|c)?sh)(?-u:\b)"));
    let shell_word =
        SHELL_WORD.get_or_init(|| lit_re(r"(?:^|[\s(])(?:eval|exec|source|\.|(?:ba|z|da|k|c)?sh|xargs|env|command|builtin|nohup|sudo|time)(?:\s|$)"));
    let derived = DERIVED.get_or_init(|| lit_re(r"(?:^|[\s;&|({])(?:local[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=([^;\n]*)"));
    let pipe_to_shell = pipe_sh.is_match(body);
    let cmd_pos = lit_re(&format!(
        r#"(?:^|[;&|(\n{{]|(?-u:\b)(?:then|do|else)(?-u:\b))[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*"?\$(?:\{{{name}\}}(?:[^A-Za-z0-9_]|$)|{name}(?-u:\b))"#
    ));
    if cmd_pos.is_match(body) || pipe_to_shell {
        return true;
    }
    let rf = var_ref(name);
    for seg in body.split([';', '&', '|', '\n']) {
        if rf.is_match(seg) && shell_word.is_match(seg) {
            return true;
        }
    }
    for m in derived.captures_iter(body) {
        let v = m[1].to_string();
        if v == name || names.contains(&v) || !rf.is_match(&m[2]) {
            continue;
        }
        names.insert(v.clone());
        if var_is_executed(body, &v, names) {
            return true;
        }
    }
    false
}

/// Mirrors `lib/git-alias-scan.js` `neutraliseDataArgAssignments`.
fn neutralise_data_arg_assignments(body: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        lit_re(r#"(^|[\s;&|({])((?:(?:local|declare|typeset|readonly|export)[ \t]+(?:-[A-Za-z]+[ \t]+)?)?([A-Za-z_][A-Za-z0-9_]*)=)("\$(?:[1-9]|\{[1-9]\})"|\$(?:[1-9]|\{[1-9]\}))"#)
    });
    let mut out = String::new();
    let mut last = 0usize;
    let mut pos = 0usize;
    while pos <= body.len() {
        let Some(c) = re.captures_at(body, pos) else { break };
        let whole = c.get(0).expect("group 0 is the whole match");
        let next = body[whole.end()..].chars().next();
        let ok = next.is_none_or(|ch| is_js_space(ch) || matches!(ch, ';' | '&' | '|' | ')' | '}'));
        if !ok {
            // lookahead failed: JS keeps scanning from the next start position
            pos = whole.start() + body[whole.start()..].chars().next().map_or(1, |ch| ch.len_utf8());
            continue;
        }
        let name = c.get(3).expect("group 3 is mandatory in the pattern").as_str().to_string();
        out.push_str(&body[last..whole.start()]);
        let mut names = HashSet::new();
        names.insert(name.clone());
        if var_is_executed(body, &name, &mut names) {
            out.push_str(whole.as_str());
        } else {
            out.push_str(c.get(1).map_or("", |g| g.as_str()));
            out.push_str(c.get(2).expect("group 2 is mandatory in the pattern").as_str());
            out.push_str("\"\"");
        }
        last = whole.end();
        pos = whole.end();
        if whole.end() == whole.start() {
            pos += 1;
        }
    }
    out.push_str(&body[last..]);
    out
}

/// Mirrors `lib/git-alias-scan.js` `wrapperExpansion`.
fn wrapper_expansion(def: &ShellDef, args: &[Tok]) -> String {
    let words = shell_words(args);
    if def.is_alias {
        return format!("{}{}", def.body, if words.is_empty() { String::new() } else { format!(" {words}") });
    }
    static ALL: OnceLock<Regex> = OnceLock::new();
    static NTH: OnceLock<Regex> = OnceLock::new();
    let all = ALL.get_or_init(|| lit_re(r#""\$[@*]"|\$[@*]|"\$\{[@*]\}"|\$\{[@*]\}"#));
    let nth = NTH.get_or_init(|| lit_re(r#""?\$\{?([1-9])\}?"?"#));
    let b = neutralise_data_arg_assignments(&def.body);
    let r1 = all.replace_all(&b, |_: &regex::Captures| words.clone()).to_string();
    nth.replace_all(&r1, |c: &regex::Captures| {
        let n: usize = c[1].parse().unwrap_or(1);
        let lo = (n - 1).min(args.len());
        let hi = n.min(args.len());
        shell_words(&args[lo..hi])
    })
    .to_string()
}

/// Segment hook: shell `alias name='<body>'`, `GIT_CONFIG_VALUE_<n>=<body>`, and calls to a wrapper defined earlier.
///
/// Mirrors `lib/git-alias-scan.js` `shellDefinitionVerdict`.
pub fn shell_definition_verdict(ctx: &mut Ctx, tokens: &[Tok], ev: &Ev, depth: usize, last_cd: Option<&str>) -> Option<String> {
    if !ctx.alias_enabled() {
        return None;
    }
    if ev.verb == "alias" {
        for t in &ev.args {
            // /^([^=\s]+)=([\s\S]+)$/
            let Some(eq) = t.text.find('=') else { continue };
            let name = &t.text[..eq];
            let val = &t.text[eq + 1..];
            if name.is_empty() || name.chars().any(is_js_space) || val.is_empty() {
                continue;
            }
            let note = format!("defining shell alias `{name}` to run a blocked command:");
            if let Some(h) = scan_body(ctx, Some(val.to_string()), &note, depth, last_cd) {
                return Some(h);
            }
        }
    }
    for t in tokens {
        if t.quoted_only {
            continue;
        }
        // /^(GIT_CONFIG_VALUE_\d+)=([\s\S]+)$/
        let Some(eq) = t.text.find('=') else { continue };
        let name = &t.text[..eq];
        let val = &t.text[eq + 1..];
        let ok_name = name.strip_prefix("GIT_CONFIG_VALUE_").is_some_and(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit()));
        if !ok_name || val.is_empty() {
            continue;
        }
        let note = format!("defining a git alias via `{name}` to run a blocked command:");
        if let Some(h) = scan_body(ctx, alias_body_command(val), &note, depth, last_cd) {
            return Some(h);
        }
    }
    if depth < 3 && !ev.args.is_empty() {
        let defs = shell_defs(ctx);
        if let Some(def) = defs.get(&ev.verb) {
            let note = format!("via shell {} `{}`:", if def.is_alias { "alias" } else { "function" }, ev.verb);
            let body = wrapper_expansion(def, &ev.args);
            if let Some(h) = scan_body(ctx, Some(body), &note, depth, last_cd) {
                return Some(h);
            }
        }
    }
    None
}

/// PostToolUse audit: does `git <sub>` resolve (through aliases) to a commit-creating verb, or to a `!shell` alias?
///
/// Mirrors `lib/git-alias-scan.js` `aliasCreatesCommit`.
pub fn alias_creates_commit(ctx: &mut Ctx, args: &[Tok], sub: Option<&str>, rest: &[Tok], dir: Option<&str>) -> bool {
    let env = Env::new();
    match expand_alias(ctx, args, sub, rest, dir, &env) {
        None => false,
        Some(ex) => ex.verb == "!" || ex.verb.starts_with('-') || COMMIT_CREATING.contains(&ex.verb.as_str()),
    }
}
