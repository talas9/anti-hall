//! git argument analysis ported from git-guard.js: subcommand resolution (with inline aliases), push force /
//! delete detection, command-substitution args, self-credit matching and commit-message extraction.
use super::tables::{block, tables};
use super::tokenize::*;
use super::util::*;
use super::Ctx;
use std::collections::HashMap;

fn is_sep_char(c: char) -> bool {
    is_js_space(c) || ";&|()\"'{}`".contains(c)
}

/// JS `val.split(/[\s;&|()"'{}`]+/)`: pieces including a possibly empty first and last one.
fn js_split_seps(val: &str) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut cur = String::new();
    let mut in_sep = false;
    for c in val.chars() {
        if is_sep_char(c) {
            if !in_sep {
                pieces.push(std::mem::take(&mut cur));
                in_sep = true;
            }
        } else {
            in_sep = false;
            cur.push(c);
        }
    }
    pieces.push(cur);
    pieces
}

/// Split `git [global options] <sub> ...` into the subcommand name and the tokens after it, skipping global options (and their values) such as `-C <dir>`.
///
/// Mirrors `git-guard.js` `gitSubcommand`.
pub fn git_subcommand(args: &[Tok]) -> (Option<String>, Vec<Tok>) {
    for j in 0..args.len() {
        let a = args[j].text.as_str();
        let cfg_val: Option<String> = if a == "--config-env" {
            Some(if j + 1 < args.len() { args[j + 1].text.clone() } else { String::new() })
        } else {
            a.strip_prefix("--config-env=").map(|s| s.to_string())
        };
        if let Some(v) = cfg_val {
            if v.get(..6).is_some_and(|x| x.eq_ignore_ascii_case("alias.")) {
                return (Some("push".into()), vec![Tok::plain("--force")]);
            }
        }
    }
    let mut alias_map: HashMap<String, String> = HashMap::new();
    let mut alias_body: HashMap<String, Vec<Tok>> = HashMap::new();
    let mut j = 0;
    while j + 1 < args.len() {
        if args[j].text == "-c" {
            let cfg = &args[j + 1].text;
            if let Some(rest) = cfg.strip_prefix("alias.") {
                if let Some(eq) = rest.find('=') {
                    if eq >= 1 {
                        let name = &rest[..eq];
                        let val = js_trim(&rest[eq + 1..]);
                        let first_word: String = if val.starts_with('!') { "!".into() } else { val.split(is_js_space).next().unwrap_or("").to_string() };
                        alias_map.insert(name.to_string(), first_word.clone());
                        let mut parts: Vec<String> = js_split_seps(val).into_iter().skip(1).filter(|p| !p.is_empty()).collect();
                        if first_word == "!" {
                            parts.retain(|p| p != "--");
                        }
                        alias_body.insert(name.to_string(), parts.iter().map(|p| Tok::plain(p)).collect());
                    }
                }
            }
        }
        j += 1;
    }
    let mut i = 0;
    while i < args.len() {
        let w = args[i].text.as_str();
        if tables().git_opts_with_value.has(w) {
            i += 2;
            continue;
        }
        if w.starts_with('-') {
            i += 1;
            continue;
        }
        let rest: Vec<Tok> = args[i + 1..].to_vec();
        if let Some(expanded) = alias_map.get(w) {
            if expanded == "push" || expanded == "!" {
                let mut body = alias_body.get(w).cloned().unwrap_or_default();
                body.extend(rest);
                return (Some("push".into()), body);
            }
            let sub = if expanded.is_empty() { w.to_string() } else { expanded.clone() };
            return (Some(sub), rest);
        }
        return (Some(w.to_string()), rest);
    }
    (None, Vec::new())
}

/// Mirrors `git-guard.js` `expandPushOptions`.
fn expand_push_options(rest: &[Tok]) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut end_of_options = false;
    for t in rest {
        let w = t.text.as_str();
        if end_of_options || !w.starts_with("--") || w.starts_with("--no-") {
            if w == "--" {
                end_of_options = true;
            }
            out.push(t.clone());
            continue;
        }
        let (name, val) = match w.find('=') {
            None => (&w[2..], ""),
            Some(eq) => (&w[2..eq], &w[eq..]),
        };
        if name.is_empty() || tables().push_long_opts.has(name) {
            out.push(t.clone());
            continue;
        }
        let cands: Vec<&str> = tables().push_long_opts.iter().filter(|o| o.starts_with(name)).collect();
        if cands.is_empty() {
            out.push(t.clone());
            continue;
        }
        for c in cands {
            let mut nt = t.clone();
            nt.text = format!("--{c}{val}");
            out.push(nt);
        }
    }
    out
}

fn is_short_cluster(w: &str) -> bool {
    w.len() >= 2 && w.starts_with('-') && w[1..].chars().all(|c| c.is_ascii_alphanumeric())
}

/// True when the tokens after `push` ask for a force push (`--force`, `-f`, a `+refspec`, but not `--force-with-lease` forms the guard allows).
///
/// Mirrors `git-guard.js` `isForcePush`.
pub fn is_force_push(rest: &[Tok]) -> bool {
    let rest = expand_push_options(rest);
    let mut end_of_options = false;
    for t in &rest {
        let w = t.text.as_str();
        if !end_of_options && w == "--" {
            end_of_options = true;
            continue;
        }
        if end_of_options {
            if w.starts_with('+') && w.chars().count() > 1 {
                return true;
            }
            continue;
        }
        if w == "--force" || w == "--force-with-lease" {
            return true;
        }
        if w.starts_with("--force-with-lease=") {
            return true;
        }
        if w == "--mirror" {
            return true;
        }
        if is_short_cluster(w) && w.contains('f') {
            return true;
        }
        if w.starts_with('+') && w.chars().count() > 1 {
            return true;
        }
    }
    false
}

/// True when a push deletes a remote ref (`--delete`, `-d` or a `:ref` refspec).
///
/// Mirrors `git-guard.js` `isDeleteRefPush`.
pub fn is_delete_ref_push(rest: &[Tok]) -> bool {
    let rest = expand_push_options(rest);
    let mut end_of_options = false;
    for t in &rest {
        let w = t.text.as_str();
        if !end_of_options && w == "--" {
            end_of_options = true;
            continue;
        }
        if !end_of_options {
            if w == "--delete" || w == "--prune" {
                return true;
            }
            if is_short_cluster(w) && w.contains('d') {
                return true;
            }
        }
        if w.chars().count() > 1 && w.starts_with(':') {
            return true;
        }
    }
    false
}

/// True when any argument still contains a command substitution, whose value cannot be known statically.
///
/// Mirrors `git-guard.js` `hasCmdSubstArg`.
pub fn has_cmd_subst_arg(rest: &[Tok]) -> bool {
    rest.iter().any(|t| t.text.contains(CMDSUBST))
}

// ---------------------------------------------------------------------------------------------------
// self-credit

fn line_starts(t: &[char]) -> Vec<usize> {
    let mut v = vec![0usize];
    for (i, &c) in t.iter().enumerate() {
        if c == '\n' || c == '\r' || c == '\u{2028}' || c == '\u{2029}' {
            v.push(i + 1);
        }
    }
    v
}

fn skip_ht(t: &[char], mut p: usize) -> usize {
    while p < t.len() && (t[p] == ' ' || t[p] == '\t') {
        p += 1;
    }
    p
}

fn coauthor_at(t: &[char], s: usize) -> bool {
    let mut p = skip_ht(t, s);
    if !ci_starts_with(t, p, "co-authored-by") {
        return false;
    }
    p += "co-authored-by".len();
    p = skip_ht(t, p);
    if p >= t.len() || (t[p] != ':' && t[p] != '=') {
        return false;
    }
    p += 1;
    let eol = t[p..].iter().position(|&c| c == '\n').map_or(t.len(), |x| x + p);
    for q in p..eol {
        for alt in &tables().credit_coauthor_alts {
            if ci_starts_with(t, q, alt) {
                return true;
            }
        }
        // a `gpt-<n>` model name: the prefix, then a listed version digit, then no further alphanumeric
        let (prefix, versions) = (&tables().credit_gpt_prefix, &tables().credit_gpt_versions);
        let plen = prefix.chars().count();
        if ci_starts_with(t, q, prefix)
            && t.get(q + plen).is_some_and(|c| versions.contains(*c))
            && t.get(q + plen + 1).is_none_or(|c| !c.is_ascii_alphanumeric())
        {
            return true;
        }
    }
    false
}

fn generated_at(t: &[char], s: usize) -> bool {
    let mut p = skip_ht(t, s);
    let mut units = 0usize;
    while p < t.len() {
        let c = t[p];
        if c.is_ascii_alphanumeric() || c == ' ' || c == '\t' {
            break;
        }
        if units + c.len_utf16() > 2 {
            break;
        }
        units += c.len_utf16();
        p += 1;
    }
    p = skip_ht(t, p);
    if !ci_starts_with(t, p, "generated with ") {
        return false;
    }
    p += "generated with ".len();
    if t.get(p) == Some(&'[') {
        p += 1;
    }
    for alt in &tables().credit_generated_alts {
        if ci_starts_with(t, p, alt) {
            let e = p + alt.len();
            let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
            if t.get(e).is_none_or(|&c| !word(c)) {
                return true;
            }
        }
    }
    false
}

/// SELF_CREDIT_COAUTHOR or SELF_CREDIT_GENERATED matches somewhere in `text` (line-anchored, like /im).
pub fn credit_regexes(text: &str) -> bool {
    let t: Vec<char> = text.chars().collect();
    line_starts(&t).into_iter().any(|s| coauthor_at(&t, s) || generated_at(&t, s))
}

fn gh_body_marker(text: &str) -> bool {
    tables().gh_body_markers.iter().any(|m| ci_contains(text, m))
}

/// Undo the shell escapes a commit message can carry (`\n`, `\t`, `\\`, ...) so credit lines hidden behind them are still seen.
pub fn norm_escapes(s: &str) -> String {
    s.replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t")
}

/// `has_self_credit(currentRawCommand)`, computed once per request.
pub fn raw_has_credit(ctx: &mut Ctx) -> bool {
    if let Some(v) = ctx.raw_credit {
        return v;
    }
    let raw = std::mem::take(&mut ctx.raw_cmd);
    let v = has_self_credit(ctx, &raw);
    ctx.raw_cmd = raw;
    ctx.raw_credit = Some(v);
    v
}

/// True when `text` credits an AI tool (a `Co-Authored-By` trailer, a "Generated with" line or a tool link); results are cached per text on the context.
///
/// Mirrors `git-guard.js` `hasSelfCredit`.
pub fn has_self_credit(ctx: &mut Ctx, text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    if let Some(&v) = ctx.self_credit_cache.get(text) {
        return v;
    }
    let normalized = norm_escapes(text);
    let result = credit_regexes(text) || credit_regexes(&normalized);
    ctx.self_credit_cache.insert(text.to_string(), result);
    result
}

/// Git subcommands that create a commit, which is where self-credit and handover checks apply.
///
/// True when `-c trailer.<key>.key=...` style config remaps a trailer key so a credit trailer would be written under another name.
///
/// Mirrors `git-guard.js` `hasSelfCreditTrailerKeyRemap`.
pub fn has_self_credit_trailer_key_remap(args: &[Tok]) -> bool {
    let key_ok = |v: &str| {
        let l = js_trim(v).to_lowercase();
        l == "co-authored-by" || l == "generated-with" || l == "generated with"
    };
    for j in 0..args.len() {
        if args[j].text != "-c" {
            continue;
        }
        let cfg = if j + 1 < args.len() { args[j + 1].text.as_str() } else { "" };
        // Form A: ^trailer\.[^=]*\.key=(.*)$  (is: case-insensitive, dotall)
        let lc = cfg.to_ascii_lowercase();
        if let Some(rest) = lc.strip_prefix("trailer.") {
            if let Some(eq) = rest.find('=') {
                let name_part = &rest[..eq];
                if name_part.ends_with(".key") {
                    let val_start = "trailer.".len() + eq + 1;
                    if key_ok(&cfg[val_start..]) {
                        return true;
                    }
                    continue;
                }
            }
            // Form B: ^trailer\.[^=]*\.key$
            if !rest.contains('=') && rest.ends_with(".key") {
                let val = if j + 2 < args.len() { args[j + 2].text.as_str() } else { "" };
                if key_ok(val) {
                    return true;
                }
            }
        }
    }
    false
}

fn is_line_term(c: char) -> bool {
    c == '\n' || c == '\r' || c == '\u{2028}' || c == '\u{2029}'
}

/// `^-[A-Za-z]*X$` / `^-[A-Za-z]*X.`: returns (ends_with_x, inline_value_after_first_x).
fn short_cluster_flag(w: &str, flag: char) -> (bool, Option<String>) {
    let c: Vec<char> = w.chars().collect();
    if c.first() != Some(&'-') {
        return (false, None);
    }
    let mut exact = false;
    let mut k = 1;
    // letters run
    let mut run_end = 1;
    while run_end < c.len() && c[run_end].is_ascii_alphabetic() {
        run_end += 1;
    }
    if run_end == c.len() && c.len() >= 2 && c[c.len() - 1] == flag {
        exact = true;
    }
    let mut inline = None;
    while k < run_end {
        if c[k] == flag && k + 1 < c.len() && !is_line_term(c[k + 1]) {
            let first = c[1..].iter().position(|&x| x == flag).map_or(k, |p| p + 1); // always found: c[k] == flag with k >= 1
            inline = Some(c[first + 1..].iter().collect());
            break;
        }
        k += 1;
    }
    (exact, inline)
}

/// The messages given inline to a commit-like command (`-m`, `--message`, `-m<text>` and cluster forms).
///
/// Mirrors `git-guard.js` `inlineCommitMessages`.
pub fn inline_commit_messages(rest: &[Tok]) -> Vec<String> {
    let mut msgs = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        let w = rest[i].text.as_str();
        if w == "--message" {
            if i + 1 < rest.len() {
                msgs.push(rest[i + 1].text.clone());
                i += 1;
            }
        } else if let Some(v) = w.strip_prefix("--message=") {
            msgs.push(v.to_string());
        } else {
            let (exact, inline) = short_cluster_flag(w, 'm');
            if exact {
                if i + 1 < rest.len() {
                    msgs.push(rest[i + 1].text.clone());
                    i += 1;
                }
            } else if let Some(v) = inline {
                msgs.push(v);
            } else if w == "--trailer" {
                if i + 1 < rest.len() {
                    msgs.push(rest[i + 1].text.clone());
                    i += 1;
                }
            } else if let Some(v) = w.strip_prefix("--trailer=") {
                msgs.push(v.to_string());
            }
        }
        i += 1;
    }
    msgs
}

/// The messages a commit-like command reads from files (`-F`, `--file`, `--template`-style options), read from disk.
///
/// Mirrors `git-guard.js` `fileCommitMessages`.
pub fn file_commit_messages(rest: &[Tok]) -> Vec<String> {
    let mut specs = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        let w = rest[i].text.as_str();
        if w == "--file" {
            if i + 1 < rest.len() {
                specs.push(rest[i + 1].text.clone());
                i += 1;
            }
        } else if let Some(v) = w.strip_prefix("--file=") {
            specs.push(v.to_string());
        } else {
            let (exact, inline) = short_cluster_flag(w, 'F');
            if exact {
                if i + 1 < rest.len() {
                    specs.push(rest[i + 1].text.clone());
                    i += 1;
                }
            } else if let Some(v) = inline {
                specs.push(v);
            }
        }
        i += 1;
    }
    specs
}

/// Read a file the way Node `readFileSync(path, "utf8")` does (invalid UTF-8 becomes U+FFFD); `None` when it cannot be read.
pub fn read_file_lossy(path: &str) -> Option<String> {
    std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).to_string())
}

/// For `gh pr|issue|release ... --body/--title`, the message text that credits an AI tool, if any.
///
/// Mirrors `git-guard.js` `ghSelfCreditMessage`.
pub fn gh_self_credit_message(ctx: &mut Ctx, args: &[Tok]) -> Option<String> {
    let words: Vec<&str> = args.iter().map(|a| a.text.as_str()).collect();
    let guarded_sub = words.iter().any(|w| tables().gh_subs.has(w));
    let guarded_act = words.iter().any(|w| tables().gh_actions.has(w));
    if !guarded_sub || !guarded_act {
        return None;
    }
    let mut vals: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let w = args[i].text.as_str();
        if tables().gh_value_opts.has(w) {
            if i + 1 < args.len() {
                vals.push(args[i + 1].text.clone());
                i += 1;
            }
            i += 1;
            continue;
        }
        let mut handled = false;
        for p in &tables().gh_value_prefixes {
            if let Some(v) = w.strip_prefix(p) {
                vals.push(v.to_string());
                handled = true;
                break;
            }
        }
        if handled {
            i += 1;
            continue;
        }
        let mut file_spec: Option<String> = None;
        if tables().gh_file_opts.has(w) {
            if i + 1 < args.len() {
                file_spec = Some(args[i + 1].text.clone());
                i += 1;
            }
        } else {
            for p in &tables().gh_file_prefixes {
                if let Some(v) = w.strip_prefix(p) {
                    if !v.chars().any(is_line_term) {
                        file_spec = Some(v.to_string());
                    }
                    break;
                }
            }
        }
        if let Some(fs_) = file_spec {
            if !fs_.is_empty() && fs_ != "-" {
                let p = ctx.abs_from_cwd(&fs_);
                if let Some(t) = read_file_lossy(&p) {
                    vals.push(t);
                }
            }
        }
        i += 1;
    }
    if raw_has_credit(ctx) {
        vals.push(ctx.raw_cmd.clone());
    }
    for v in &vals {
        let n = norm_escapes(v);
        for text in [v.as_str(), n.as_str()] {
            if credit_regexes(text) || gh_body_marker(text) {
                return Some(block("msg_gh_credit", &[]));
            }
        }
    }
    if vals.iter().any(|v| !v.is_empty()) {
        ctx.jev_wanted = true;
    }
    None
}

/// Heredoc bodies of one command text, plus a cache of the `-F -` stdin candidate text per command string
/// (the Node guard memoizes it on the (cmd, bodies) pair; without it a command made of N `-F -` segments is
/// quadratic). Cache keys are the address and length of a string that outlives the Hb (the scan frame owns both).
/// One memoized `-F -` stdin candidate: (address, length) of the command string, the text, and its flag.
type StdinCacheEntry = (usize, usize, Option<String>, bool);

/// Heredoc bodies of one command text, plus a memo of the `-F -` stdin candidate text per command string.
pub struct Hb {
    /// The heredoc bodies found in the command, in order of appearance.
    pub bodies: Vec<HeredocBody>,
    cache: std::cell::RefCell<Vec<StdinCacheEntry>>,
}

impl Hb {
    /// Wrap the extracted bodies with an empty memo.
    pub fn new(bodies: Vec<HeredocBody>) -> Hb {
        Hb { bodies, cache: Default::default() }
    }

    /// (joined heredoc bodies + quoted literals of `cmd` or None when there are no candidates, credit verdict).
    ///
    /// Mirrors `git-guard.js` `stdinCandidateTextCached`.
    pub fn stdin_candidate(&self, cmd: &str) -> (Option<String>, bool) {
        let key = (cmd.as_ptr() as usize, cmd.len());
        if let Some(e) = self.cache.borrow().iter().find(|e| (e.0, e.1) == key) {
            return (e.2.clone(), e.3);
        }
        let mut cands: Vec<String> = self.bodies.iter().map(|h| h.body.clone()).collect();
        cands.extend(extract_quoted_literals(cmd));
        let text = if cands.is_empty() { None } else { Some(cands.join("\n")) };
        let cred = text.as_deref().is_some_and(credit_regexes);
        self.cache.borrow_mut().push((key.0, key.1, text.clone(), cred));
        (text, cred)
    }
}

/// Every single- or double-quoted literal in `cmd`, used to look for a credit line anywhere in a command.
///
/// Mirrors `git-guard.js` `extractQuotedLiterals`.
pub fn extract_quoted_literals(cmd: &str) -> Vec<String> {
    let cs: Vec<char> = cmd.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c == '\'' || c == '"' {
            let Some(j) = cs[i + 1..].iter().position(|&x| x == c).map(|p| p + i + 1) else { break };
            out.push(cs[i + 1..j].iter().collect());
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}
