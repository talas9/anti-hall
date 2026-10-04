//! Writes into the stable launcher directory (`~/.anti-hall/bin`) and call-literal command extraction.
use super::tables::{block, tables};
use super::tokenize::*;
use super::util::*;
use super::Ctx;
use crate::checks::lit_re;
use regex::Regex;
use std::sync::OnceLock;

/// The block message for writing into the plugin launcher directory.
///
/// Mirrors `git-guard.js` `LAUNCHER_BLOCK_MSG`.
pub fn launcher_block_msg() -> String {
    block("msg_launcher", &[])
}

fn launcher_dir_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| lit_re(&tables().launcher_dir_pattern))
}

fn expand_tilde(p: &str, home: &str) -> String {
    if p == "~" {
        return if home.is_empty() { p.to_string() } else { home.to_string() };
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if home.is_empty() {
            return p.to_string();
        }
        return format!("{}/{}", home.trim_end_matches(['/', '\\']), rest);
    }
    p.to_string()
}

/// Resolve `raw` the way the shell would at this point (tilde, `$HOME`, relative to the tracked `cd` directory) and normalize it lexically.
///
/// Mirrors `git-guard.js` `normalizeGuardPath`.
pub fn normalize_guard_path(ctx: &Ctx, raw: &str, cd_dir: Option<&str>) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let home = ctx.home.as_str();
    let mut base = expand_tilde(&raw.replace('\\', "/"), home);
    if !base.starts_with('/') {
        if let Some(cd) = cd_dir {
            if !cd.is_empty() {
                let dir = expand_tilde(&cd.replace('\\', "/"), home);
                base = format!("{}/{}", dir.trim_end_matches('/'), base);
            }
        }
    }
    posix_normalize(&base)
}

/// Mirrors `git-guard.js` `pathHasLauncherSegment`.
fn path_has_launcher_segment(normalized: &str) -> bool {
    if normalized.is_empty() {
        return false;
    }
    let segs: Vec<String> = normalized.split('/').filter(|s| !s.is_empty()).map(|s| s.to_lowercase()).collect();
    (0..segs.len()).any(|i| segs[i] == ".anti-hall" && segs.get(i + 1).map(|s| s.as_str()) == Some("bin"))
}

/// Mirrors `git-guard.js` `isLauncherDirRoot`.
fn is_launcher_dir_root(ctx: &Ctx, normalized: &str) -> bool {
    if normalized.is_empty() {
        return false;
    }
    if ctx.home.is_empty() {
        return false;
    }
    let want = posix_normalize(&format!("{}/.anti-hall", ctx.home.replace('\\', "/").trim_end_matches('/')));
    normalized.trim_end_matches('/').to_lowercase() == want.trim_end_matches('/').to_lowercase()
}

/// Mirrors `git-guard.js` `hasAntiHallBinSegment`.
fn has_anti_hall_bin_segment(ctx: &Ctx, p: &str, cd_dir: Option<&str>) -> bool {
    if p.is_empty() {
        return false;
    }
    path_has_launcher_segment(&normalize_guard_path(ctx, p, cd_dir))
}

fn realpath(p: &str) -> Option<String> {
    std::fs::canonicalize(p).ok().map(|x| x.to_string_lossy().to_string())
}

fn is_symlink(p: &str) -> Option<bool> {
    std::fs::symlink_metadata(p).ok().map(|m| m.file_type().is_symlink())
}

/// Mirrors `git-guard.js` `resolveDanglingLinkTarget`.
fn resolve_dangling_link_target(p: &str, hops: usize) -> Option<String> {
    if hops > tables().launcher_hops {
        return None;
    }
    let link = std::fs::read_link(p).ok()?.to_string_lossy().to_string();
    let l = link.replace('\\', "/");
    let target = if l.starts_with('/') { posix_normalize(&l) } else { posix_normalize(&format!("{}/{}", posix_dirname(p), l)) };
    if is_symlink(&target) == Some(true) {
        return resolve_dangling_link_target(&target, hops + 1);
    }
    Some(target)
}

/// Mirrors `git-guard.js` `targetResolvesIntoLauncherDir`.
fn target_resolves_into_launcher_dir(ctx: &mut Ctx, raw_path: &str, cd_dir: Option<&str>, delete_only: bool) -> bool {
    let normalized = normalize_guard_path(ctx, raw_path, cd_dir);
    if normalized.is_empty() || !normalized.starts_with('/') {
        return false;
    }
    if ctx.launcher_fs_budget <= 0 {
        return false;
    }
    ctx.launcher_fs_budget -= 1;
    if delete_only {
        if normalized.ends_with('/') {
            return match realpath(&normalized) {
                Some(r) => path_has_launcher_segment(&r),
                None => false,
            };
        }
        match is_symlink(&normalized) {
            Some(true) => {
                let Some(link) = std::fs::read_link(&normalized).ok().map(|x| x.to_string_lossy().to_string()) else { return false };
                let l = link.replace('\\', "/");
                let target = if l.starts_with('/') { posix_normalize(&l) } else { posix_normalize(&format!("{}/{}", posix_dirname(&normalized), l)) };
                return path_has_launcher_segment(&target);
            }
            Some(false) => {
                if let Some(r) = realpath(&normalized) {
                    return path_has_launcher_segment(&r);
                }
            }
            None => {}
        }
        let parent = posix_dirname(&normalized);
        let base = posix_basename(&normalized);
        return match realpath(&parent) {
            Some(rp) => path_has_launcher_segment(&format!("{}/{}", rp.trim_end_matches('/'), base)),
            None => false,
        };
    }
    if let Some(r) = realpath(&normalized) {
        return path_has_launcher_segment(&r);
    }
    if is_symlink(&normalized) == Some(true) {
        return match resolve_dangling_link_target(&normalized, 0) {
            None => true,
            Some(t) => path_has_launcher_segment(&t),
        };
    }
    let segs: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    let mut existing = String::new();
    let mut cur = String::new();
    for seg in segs.iter().take(segs.len().saturating_sub(1)) {
        cur.push('/');
        cur.push_str(seg);
        let Ok(st) = std::fs::symlink_metadata(&cur) else { break };
        existing = cur.clone();
        if st.file_type().is_symlink() {
            match realpath(&cur) {
                Some(real) => {
                    if path_has_launcher_segment(&real) {
                        return true;
                    }
                }
                None => return true,
            }
        }
    }
    if existing.is_empty() {
        return false;
    }
    let Some(resolved_existing) = realpath(&existing) else { return false };
    if resolved_existing == existing {
        return false;
    }
    let rejoined = posix_normalize(&format!("{}{}", resolved_existing, &normalized[existing.len()..]));
    path_has_launcher_segment(&rejoined)
}

/// The target words of every `>`/`>>` redirect in `raw`, so a redirect into the launcher directory can be spotted.
///
/// Mirrors `git-guard.js` `redirectWords`.
pub fn redirect_words(raw: &str) -> Vec<String> {
    let s: Vec<char> = raw.chars().collect();
    let n = s.len();
    let mut out = Vec::new();
    let mut k = s.iter().position(|&c| c == '>');
    while let Some(kk) = k {
        'one: {
            let mut i = kk + 1;
            if i < n && (s[i] == '>' || s[i] == '|') {
                i += 1;
            }
            if i < n && (s[i] == '&' || s[i] == '(') {
                break 'one;
            }
            while i < n && (s[i] == ' ' || s[i] == '\t') {
                i += 1;
            }
            let mut w = String::new();
            while i < n {
                let c = s[i];
                if c == '"' || c == '\'' {
                    let mut j = i + 1;
                    while j < n && s[j] != c {
                        j += if c == '"' && s[j] == '\\' { 2 } else { 1 };
                    }
                    if j >= n {
                        break;
                    }
                    w.extend(s[i + 1..j].iter());
                    i = j + 1;
                } else if is_js_space(c) || ";&|<>()".contains(c) {
                    break;
                } else if c == '\\' && i + 1 < n {
                    w.push(s[i + 1]);
                    i += 2;
                } else {
                    w.push(c);
                    i += 1;
                }
            }
            if !w.is_empty() {
                out.push(w);
            }
        }
        k = s[kk + 1..].iter().position(|&c| c == '>').map(|p| p + kk + 1);
    }
    out
}

/// Mirrors `git-guard.js` `globCouldHitLauncher`.
fn glob_could_hit_launcher(ctx: &Ctx, p: &str, cd_dir: Option<&str>) -> bool {
    if !p.chars().any(|c| matches!(c, '?' | '*' | '[')) {
        return false;
    }
    let home = ctx.home.as_str();
    if home.is_empty() {
        return false;
    }
    let p2 = if let Some(r) = p.strip_prefix("${HOME}") {
        format!("{home}{r}")
    } else if let Some(r) = p.strip_prefix("$HOME") {
        if r.chars().next().is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_')) {
            format!("{home}{r}")
        } else {
            p.to_string()
        }
    } else {
        p.to_string()
    };
    let norm = normalize_guard_path(ctx, &p2, cd_dir);
    if !norm.starts_with('/') {
        return false;
    }
    let want: Vec<String> =
        format!("{}/.anti-hall/bin", home.replace('\\', "/").trim_end_matches('/')).split('/').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();
    let segs: Vec<&str> = norm.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() <= want.len() {
        return false;
    }
    want.iter().enumerate().all(|(i, w)| {
        let g: Vec<char> = segs[i].chars().collect();
        let mut re = String::new();
        let mut k = 0;
        while k < g.len() {
            let c = g[k];
            if c == '*' {
                re.push_str("[^/]*");
            } else if c == '?' {
                re.push_str("[^/]");
            } else if c == '[' {
                let end = if k + 2 <= g.len() { g[k + 2..].iter().position(|&x| x == ']').map(|p| p + k + 2) } else { None };
                match end {
                    None => re.push_str("\\["),
                    Some(end) => {
                        let mut cls: String =
                            g[k + 1..end].iter().collect::<String>().replace('\\', "\\\\").replace('[', "\\[").replace('&', "\\&").replace('~', "\\~");
                        if cls.starts_with('!') {
                            cls = format!("^{}", &cls[1..]);
                        }
                        re.push('[');
                        re.push_str(&cls);
                        re.push(']');
                        k = end;
                    }
                }
            } else {
                re.push_str(&regex::escape(&c.to_string()));
            }
            k += 1;
        }
        match Regex::new(&format!("(?i)^{re}$")) {
            Ok(r) => r.is_match(w),
            Err(_) => true,
        }
    })
}

/// Mirrors `git-guard.js` `varTargetHitsLauncher`.
fn var_target_hits_launcher(ctx: &mut Ctx, p: &str, cd_dir: Option<&str>, hops: usize) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| lit_re(r"(?s)^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(.*)$"));
    let Some(m) = re.captures(p) else { return false };
    if ctx.launcher_cmd_text.is_empty() || hops > 4 {
        return false;
    }
    let name = m.get(1).or_else(|| m.get(2)).map(|x| x.as_str().to_string()).unwrap_or_default();
    let suffix = m.get(3).map(|x| x.as_str().to_string()).unwrap_or_default();
    let pat = format!(r#"(?:^|[\s;&|(])(?:(?:export|local|declare|typeset)[ \t]+(?:-[A-Za-z0-9_]+[ \t]+)*)?{name}=("[^"\n]*"|'[^'\n]*'|[^\s;&|)]*)"#);
    let Ok(are) = Regex::new(&pat) else { return false };
    let text = ctx.launcher_cmd_text.clone();
    for a in are.captures_iter(&text) {
        let g = a.get(1).map(|x| x.as_str()).unwrap_or("");
        // value.replace(/^["']|["']$/g, '')
        let mut value = g.to_string();
        if value.starts_with('"') || value.starts_with('\'') {
            value.remove(0);
        }
        if value.ends_with('"') || value.ends_with('\'') {
            value.pop();
        }
        let joined = format!("{value}{suffix}");
        let home_or = if ctx.home.is_empty() { "$HOME".to_string() } else { ctx.home.clone() };
        let c2 = if let Some(r) = joined.strip_prefix("${HOME}") {
            format!("{home_or}{r}")
        } else if let Some(r) = joined.strip_prefix("$HOME") {
            if r.chars().next().is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_')) {
                format!("{home_or}{r}")
            } else {
                joined.clone()
            }
        } else {
            joined.clone()
        };
        if c2.starts_with('$') {
            if var_target_hits_launcher(ctx, &c2, cd_dir, hops + 1) {
                return true;
            }
            continue;
        }
        if launcher_dir_re().is_match(&c2) || has_anti_hall_bin_segment(ctx, &c2, cd_dir) || glob_could_hit_launcher(ctx, &c2, cd_dir) {
            return true;
        }
    }
    false
}

/// True when `p` is, or lies under, a launcher directory (following symlinks when the filesystem budget allows); `delete_only` restricts it to delete verbs.
///
/// Mirrors `git-guard.js` `launcherTargetHit`.
pub fn launcher_target_hit(ctx: &mut Ctx, p: &str, cd_dir: Option<&str>, delete_only: bool) -> bool {
    launcher_dir_re().is_match(p)
        || has_anti_hall_bin_segment(ctx, p, cd_dir)
        || target_resolves_into_launcher_dir(ctx, p, cd_dir, delete_only)
        || glob_could_hit_launcher(ctx, p, cd_dir)
        || var_target_hits_launcher(ctx, p, cd_dir, 0)
}

fn is_inplace_flag(w: &str) -> bool {
    if w.starts_with("--in-place") {
        return true;
    }
    if !w.starts_with('-') {
        return false;
    }
    // -[a-zA-Z]*i : an 'i' inside the leading run of letters
    for c in w[1..].chars() {
        if c == 'i' {
            return true;
        }
        if !c.is_ascii_alphabetic() {
            return false;
        }
    }
    false
}

/// True when one command (verb plus arguments) writes, copies, moves or links into a launcher directory.
///
/// Mirrors `git-guard.js` `writesLauncherDir`.
pub fn writes_launcher_dir(ctx: &mut Ctx, tokens: &[Tok], ev: &Ev, cd_dir: Option<&str>) -> bool {
    static VAR_WORD: OnceLock<Regex> = OnceLock::new();
    let var_word = VAR_WORD.get_or_init(|| lit_re(r#"^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)(?:/[^`$(){}'"\\]*)?$"#));
    let mut targets: Vec<String> = Vec::new();
    for i in 0..tokens.len() {
        let t = &tokens[i];
        if t.quoted_only {
            continue;
        }
        let tc: Vec<char> = t.text.chars().collect();
        let mut k = tc.iter().position(|&c| c == '>');
        while let Some(kk) = k {
            let mut rest: String = tc[kk + 1..].iter().collect();
            let nl = rest.find('\n');
            if let Some(p) = nl {
                rest.truncate(p);
            }
            let mut after: String = rest.clone();
            if after.starts_with('>') {
                after.remove(0);
            }
            if after.starts_with('|') {
                after.remove(0);
            }
            if after.starts_with('&') || after.starts_with('(') {
                k = tc[kk + 1..].iter().position(|&c| c == '>').map(|p| p + kk + 1);
                continue;
            }
            let trimmed = after.trim_start_matches(is_js_space);
            let word = trimmed.split(is_js_space).next().unwrap_or("").to_string();
            if !word.is_empty() && (var_word.is_match(&word) || !word.chars().any(|c| matches!(c, '`' | '$' | '(' | ')' | '{' | '}' | '\'' | '"' | '\\'))) {
                after = word;
            }
            if !after.is_empty() {
                targets.push(after);
            } else if nl.is_none() {
                targets.push(tokens.get(i + 1).map(|x| x.text.clone()).unwrap_or_default());
            }
            k = tc[kk + 1..].iter().position(|&c| c == '>').map(|p| p + kk + 1);
        }
        if let Some(raw) = &t.raw {
            if raw.contains('>') {
                targets.extend(redirect_words(raw));
            }
        }
    }
    let ops: Vec<String> = ev.args.iter().map(|a| a.text.clone()).collect();
    let operands: Vec<String> = ops.iter().filter(|w| !w.starts_with('-')).cloned().collect();
    let verb = ev.verb.as_str();
    if verb == "tee" || verb == "truncate" {
        targets.extend(operands.iter().cloned());
    }
    if tables().copy_verbs.has(verb) {
        if let Some(l) = operands.last() {
            targets.push(l.clone());
        }
        for (j, w) in ops.iter().enumerate() {
            if w == "-t" || w == "--target-directory" {
                targets.push(ops.get(j + 1).cloned().unwrap_or_default());
            } else if let Some(v) = w.strip_prefix("--target-directory=") {
                targets.push(v.to_string());
            }
        }
    }
    if verb == "ln" && operands.len() >= 2 {
        targets.extend(operands[..operands.len() - 1].iter().cloned());
    }
    if verb == "mv" && operands.len() >= 2 {
        targets.extend(operands[..operands.len() - 1].iter().cloned());
    }
    let hardlink = verb == "cp"
        && ops.iter().any(|w| w == "--link" || (w.len() >= 2 && w.starts_with('-') && w[1..].chars().all(|c| c.is_ascii_alphabetic()) && w.contains('l')));
    if hardlink && operands.len() >= 2 {
        targets.extend(operands[..operands.len() - 1].iter().cloned());
    }
    if verb == "dd" {
        for w in &ops {
            if let Some(v) = w.strip_prefix("of=") {
                targets.push(v.to_string());
            }
        }
    }
    if (verb == "sed" || verb == "perl") && ops.iter().any(|w| is_inplace_flag(w)) {
        targets.extend(operands.iter().cloned());
    }
    if verb == "rm" && !operands.is_empty() {
        targets.extend(operands.iter().cloned());
    }
    let mut root_targets: Vec<String> = Vec::new();
    if verb == "mv" && operands.len() >= 2 {
        root_targets.extend(operands[..operands.len() - 1].iter().cloned());
    }
    if verb == "ln" && operands.len() >= 2 {
        root_targets.extend(operands[..operands.len() - 1].iter().cloned());
    }
    if verb == "rm" && !operands.is_empty() {
        root_targets.extend(operands.iter().cloned());
    }
    if tables().copy_verbs.has(verb) && operands.len() >= 2 {
        let dest_norm = normalize_guard_path(ctx, &operands[operands.len() - 1], cd_dir);
        let mut dest_is_dir = false;
        if !dest_norm.is_empty() && dest_norm.starts_with('/') {
            dest_is_dir = std::fs::metadata(&dest_norm).map(|m| m.is_dir()).unwrap_or(false);
        }
        if dest_is_dir {
            let dest_base = dest_norm.trim_end_matches('/').to_string();
            for src in &operands[..operands.len() - 1] {
                let s = src.replace('\\', "/");
                let src_base = posix_basename(&s);
                if !src_base.is_empty() {
                    targets.push(format!("{dest_base}/{src_base}"));
                }
            }
        }
    }
    let delete_only = verb == "rm";
    for p in &targets {
        if launcher_target_hit(ctx, p, cd_dir, delete_only) {
            return true;
        }
    }
    for p in &root_targets {
        let n = normalize_guard_path(ctx, p, cd_dir);
        if is_launcher_dir_root(ctx, &n) {
            return true;
        }
    }
    false
}

/// Quote-blind last look at the raw command for a write into a launcher directory that the tokenizer path missed.
///
/// Mirrors `git-guard.js` `launcherBackstop`.
pub fn launcher_backstop(ctx: &mut Ctx, raw_cmd: &str, base_cwd: Option<&str>) -> Option<String> {
    let stripped: String = raw_cmd.chars().filter(|&c| !(is_js_space(c) || matches!(c, '\'' | '"' | '\\' | '$'))).collect();
    if !stripped.contains("anti-hall") && !base_cwd.is_some_and(|b| b.contains("/.anti-hall")) {
        return None;
    }
    // Drop a backslash + newline continuation only when the backslash run is odd.
    let cs: Vec<char> = raw_cmd.chars().collect();
    let mut cmd = String::with_capacity(raw_cmd.len());
    let mut i = 0usize;
    while i < cs.len() {
        if cs[i] == '\\' && (i == 0 || cs[i - 1] != '\\') {
            let mut j = i;
            while j < cs.len() && cs[j] == '\\' {
                j += 1;
            }
            let nl_end = if cs.get(j) == Some(&'\n') {
                Some(j + 1)
            } else if cs.get(j) == Some(&'\r') && cs.get(j + 1) == Some(&'\n') {
                Some(j + 2)
            } else {
                None
            };
            if let Some(e) = nl_end {
                let run = j - i;
                if run % 2 == 1 {
                    for _ in 0..run - 1 {
                        cmd.push('\\');
                    }
                } else {
                    cmd.extend(cs[i..e].iter());
                }
                i = e;
                continue;
            }
            cmd.extend(cs[i..j].iter());
            i = j;
            continue;
        }
        cmd.push(cs[i]);
        i += 1;
    }
    let base_dir: Option<String> = base_cwd.filter(|b| !b.is_empty()).map(|b| b.to_string());
    let mut cd_dir: Option<String> = base_dir.clone();
    for raw in backstop_pieces(&cmd) {
        let trimmed = raw.trim_start_matches(is_js_space).to_string();
        let mut variants = vec![trimmed.clone()];
        if trimmed.starts_with('"') || trimmed.starts_with('\'') {
            variants.push(trimmed.trim_start_matches(['"', '\'']).to_string());
        }
        for v in variants {
            let tokens = tokenize(&v);
            if tokens.is_empty() {
                continue;
            }
            let Some(ev) = backstop_verb(&v) else { continue };
            if ev.verb == "cd" || ev.verb == "pushd" {
                if let Some(dt) = ev.args.iter().find(|t| !t.text.starts_with('-')) {
                    let too_long =
                        cd_dir.as_ref().is_some_and(|c| c.chars().count() > tables().cd_max_chars || c.split('/').count() > tables().cd_max_segments);
                    cd_dir = if too_long {
                        None
                    } else {
                        let nn = normalize_guard_path(ctx, &dt.text, cd_dir.as_deref());
                        Some(if nn.is_empty() { dt.text.clone() } else { nn })
                    };
                }
                continue;
            }
            if writes_launcher_dir(ctx, &tokens, &ev, cd_dir.as_deref()) {
                return Some(launcher_block_msg());
            }
        }
    }
    for w in redirect_words(&cmd) {
        if launcher_target_hit(ctx, &w, base_dir.as_deref(), false) || (cd_dir != base_dir && launcher_target_hit(ctx, &w, cd_dir.as_deref(), false)) {
            return Some(launcher_block_msg());
        }
    }
    None
}

/// Command strings that appear as literal arguments to `bash -c`, `eval` and similar, for the launcher backstop to rescan.
///
/// Mirrors `git-guard.js` `callLiteralCommands`.
pub fn call_literal_commands(cmd: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| lit_re(r#"(?:\(|(?-u:\b)(?:system|exec)[ \t]+)[ \t]*['"\[]"#));
    // src = cmd.replace(/\\(['"])/g, '$1')
    let mut src = String::with_capacity(cmd.len());
    let cs: Vec<char> = cmd.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        if cs[i] == '\\' && i + 1 < cs.len() && (cs[i + 1] == '\'' || cs[i + 1] == '"') {
            src.push(cs[i + 1]);
            i += 2;
        } else {
            src.push(cs[i]);
            i += 1;
        }
    }
    let b = src.as_bytes();
    let mut out = Vec::new();
    for m in re.find_iter(&src) {
        let mut parts: Vec<&str> = Vec::new();
        let mut i = m.end() - 1;
        while i < b.len() && b[i] != b')' && b[i] != b';' && b[i] != b'\n' {
            let q = b[i];
            if q == b'\'' || q == b'"' {
                let Some(j) = src[i + 1..].find(q as char).map(|p| p + i + 1) else { break };
                parts.push(&src[i + 1..j]);
                i = j + 1;
            } else {
                i += 1;
            }
        }
        let joined = parts.join(" ");
        if joined.contains("push") {
            out.push(joined);
        }
    }
    out
}
