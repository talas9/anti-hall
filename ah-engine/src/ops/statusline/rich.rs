//! The rich status line (project, git, model, context, cost, duration, subagents, version, account). Port of
//! `statusline/statusline-rich.js` (`generateStatusline`). The git questions are asked concurrently; the answers are the same
//! `git` invocations the Node renderer makes.
use super::phasebar::Ctx;
use super::util::{floor_or, n, run_with_input, safe_label, text_of, trim, truthy};
use crate::checks::guardkit::jsre;
use crate::checks::jsport::fsx;
use crate::checks::jsport::json::{self, J};
use crate::defaults;
use crate::migrate::{j_number, str_number};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// What the renderer came to: a line, or "the JavaScript code throws here" (the dispatcher then tries the next renderer).
pub enum Rich {
    /// The line.
    Line(String),
    /// The Node renderer would have thrown.
    Threw,
}

struct Colors {
    on: bool,
}

impl Colors {
    fn c(&self, name: &str) -> &'static str {
        if self.on { defaults::raw("statusline.rich_colors").get(name).and_then(defaults::V::as_str).unwrap_or("") } else { "" }
    }
}

fn parse(text: &str) -> Option<J> {
    json::parse(text, defaults::num("setup.json_max_depth") as usize).ok()
}

fn read_json(p: &Path) -> Option<J> {
    parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))
}

/// `execFileSync('git', args, {cwd, timeout, maxBuffer})` with stdout trimmed, `""` on any failure.
fn git(args: &[&str], cwd: &str, env: &BTreeMap<String, String>) -> String {
    let mut c = Command::new(defaults::text("statusline.git_bin"));
    c.args(args).current_dir(cwd);
    for (k, v) in env {
        c.env(k, v);
    }
    crate::proc::apply_git_env(&mut c);
    match run_with_input(c, b"", Duration::from_millis(defaults::num("statusline.git_timeout_ms")), defaults::num("statusline.git_max_buffer") as usize) {
        Some(r) if r.ok => trim(&String::from_utf8_lossy(&r.stdout)).to_string(),
        _ => String::new(),
    }
}

struct GitInfo {
    name: String,
    branch: String,
    modified: u64,
    untracked: u64,
    staged: u64,
    ahead: u64,
    behind: u64,
    is_worktree: bool,
    worktree_name: String,
    stash: usize,
    toplevel: String,
}

fn git_info(cwd: &str, env: &BTreeMap<String, String>) -> GitInfo {
    // the five questions are independent: ask them at once
    let a = |key: &'static str| {
        let (cwd, env) = (cwd.to_string(), env.clone());
        std::thread::spawn(move || git(&defaults::list(key), &cwd, &env))
    };
    let h_name = a("statusline.git_name_args");
    let h_status = a("statusline.git_status_args");
    let h_stash = a("statusline.git_stash_args");
    let h_dir = a("statusline.git_dir_args");
    let h_top = a("statusline.git_top_args");
    let join = |h: std::thread::JoinHandle<String>| h.join().unwrap_or_default();
    let (name, v2, stash, git_dir, top) = (join(h_name), join(h_status), join(h_stash), join(h_dir), join(h_top));
    let mut g = GitInfo {
        name: if name.is_empty() { defaults::text("statusline.default_user").to_string() } else { name },
        branch: String::new(),
        modified: 0,
        untracked: 0,
        staged: 0,
        ahead: 0,
        behind: 0,
        is_worktree: false,
        worktree_name: String::new(),
        stash: 0,
        toplevel: if top.is_empty() { cwd.to_string() } else { top },
    };
    if !v2.is_empty() {
        let ab = jsre::compile(defaults::text("statusline.ahead_behind_re"), false);
        let mut count = 0;
        for line in v2.split('\n') {
            if line.is_empty() {
                continue;
            }
            if let Some(h) = line.strip_prefix(defaults::text("statusline.branch_head")) {
                g.branch = trim(h).to_string();
                if g.branch == defaults::text("statusline.detached") {
                    g.branch.clear();
                }
            } else if line.starts_with(defaults::text("statusline.branch_ab")) {
                if let Some(m) = ab.captures(line) {
                    g.ahead = m.get(1).and_then(|x| x.as_str().parse().ok()).unwrap_or(0);
                    g.behind = m.get(2).and_then(|x| x.as_str().parse().ok()).unwrap_or(0);
                }
            } else if line.starts_with("# ") {
                // other branch headers
            } else if line.starts_with('?') {
                g.untracked += 1;
            } else if matches!(line.chars().next(), Some('1' | '2' | 'u')) {
                let mut xy = line.chars().skip(defaults::num("statusline.xy_offset") as usize);
                let (x, y) = (xy.next(), xy.next());
                if x.is_some_and(|x| x != '.' && x != ' ') {
                    g.staged += 1;
                }
                if y.is_some_and(|y| y != '.' && y != ' ') {
                    g.modified += 1;
                }
            }
            count += 1;
            if count > defaults::num("statusline.porcelain_cap") {
                break;
            }
        }
    }
    if !stash.is_empty() {
        g.stash = stash.split('\n').filter(|l| !l.is_empty()).count();
    }
    if !git_dir.is_empty() && jsre::compile(defaults::text("statusline.worktree_re"), false).is_match(&git_dir) {
        g.is_worktree = true;
        g.worktree_name = crate::checks::git::util::posix_basename(&git_dir);
    }
    g
}

/// `path.basename` over a path that may end in a slash.
fn basename(p: &str) -> String {
    crate::checks::git::util::posix_basename(p.trim_end_matches('/'))
}

fn model_word(id: &str) -> Option<&'static str> {
    let low = id.to_lowercase();
    let segs: Vec<&str> = low.split('-').collect();
    defaults::raw("statusline.model_words").as_array().unwrap_or_default().iter().find(|w| segs.contains(&w.str_field("seg"))).map(|w| w.str_field("name"))
}

/// `getModelName()`: Err when the Node code would throw.
fn model_name(cwd: &str, cx: &Ctx, settings: &Option<J>) -> Result<String, ()> {
    let base = Path::new(&cx.home);
    if let Some(cfg) = read_json(&base.join(defaults::text("statusline.claude_json")))
        && let Some(J::Obj(projects)) = cfg.get("projects")
    {
        for (path, pc) in projects {
            if cwd == path || cwd.starts_with(&format!("{path}/")) {
                if let Some(J::Obj(usage)) = pc.get("lastModelUsage").filter(|u| truthy(Some(u)))
                    && let Some((id, _)) = usage.last()
                {
                    if let Some(w) = model_word(id) {
                        return Ok(w.to_string());
                    }
                    return Ok(id
                        .split('-')
                        .skip(defaults::num("statusline.model_id_skip") as usize)
                        .take(defaults::num("statusline.model_id_take") as usize)
                        .collect::<Vec<_>>()
                        .join(" "));
                }
                break;
            }
        }
    }
    if let Some(m) = settings.as_ref().and_then(|s| s.get("model")).filter(|m| truthy(Some(m))) {
        let J::Str(m) = m else { return Err(()) };
        if let Some(w) = model_word(m) {
            return Ok(w.to_string());
        }
    }
    Ok(defaults::text("statusline.default_model").to_string())
}

fn subagent_count(cx: &Ctx) -> usize {
    let list = |d: &Path| -> Vec<std::path::PathBuf> {
        std::fs::read_dir(d).map(|rd| rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()).collect()).unwrap_or_default()
    };
    let Ok(rd) = std::fs::read_dir(&cx.tmpdir) else { return 0 };
    let claude_dirs: Vec<_> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && e.file_name().to_string_lossy().starts_with(defaults::text("statusline.claude_dir_prefix")))
        .map(|e| e.path())
        .collect();
    let mut active = 0;
    for cdir in claude_dirs {
        for pdir in list(&cdir) {
            for sdir in list(&pdir) {
                let tasks = sdir.join(defaults::text("statusline.tasks_dir"));
                let Ok(rd) = std::fs::read_dir(&tasks) else { continue };
                for e in rd.flatten() {
                    if !e.file_name().to_string_lossy().ends_with(defaults::text("statusline.output_ext")) {
                        continue;
                    }
                    if let Ok(md) = std::fs::metadata(e.path())
                        && cx.now - fsx::mtime_ms(&md) <= defaults::num("statusline.active_ms") as f64
                    {
                        active += 1;
                    }
                }
            }
        }
    }
    active
}

fn level(running: &str, latest: &str) -> &'static str {
    let parse = |v: &str| -> Vec<f64> { v.strip_prefix('v').unwrap_or(v).split('.').map(str_number).collect() };
    let (r, l) = (parse(running), parse(latest));
    let get = |v: &[f64], i: usize| v.get(i).copied().unwrap_or(f64::NAN);
    let (rmaj, rmin, lmaj, lmin) = (get(&r, 0), get(&r, 1), get(&l, 0), get(&l, 1));
    if rmaj.is_nan() || rmin.is_nan() || lmaj.is_nan() || lmin.is_nan() {
        return "none";
    }
    if lmaj > rmaj {
        "major"
    } else if lmaj == rmaj && lmin > rmin {
        "minor"
    } else {
        "none"
    }
}

fn ah_chip(cx: &Ctx, root: &str, c: &Colors) -> String {
    let Some(version) = read_json(&Path::new(root).join(defaults::text("migrate.plugin_manifest"))).and_then(|o| match o.get("version") {
        Some(J::Str(s)) if !trim(s).is_empty() => Some(trim(s).to_string()),
        _ => None,
    }) else {
        return String::new();
    };
    let latest = read_json(&Path::new(&cx.home).join(defaults::text("paths.base_dir")).join(defaults::text("statusline.version_check"))).and_then(|o| match o
        .get("latest")
    {
        Some(J::Str(s)) => Some(s.clone()),
        _ => None,
    });
    let lv = latest.map_or("none", |l| level(&version, &l));
    let (col, prefix) = match lv {
        "major" => (c.c("red"), defaults::text("statusline.update_star")),
        "minor" => (c.c("yellow"), defaults::text("statusline.update_star")),
        _ => (c.c("dim"), ""),
    };
    format!(
        "  {}{}{}  {col}{prefix}{}{version}{}",
        c.c("dim"),
        defaults::text("statusline.sep"),
        c.c("reset"),
        defaults::text("statusline.chip_label"),
        c.c("reset")
    )
}

fn effort(data: &Option<J>) -> Option<String> {
    let data = data.as_ref()?;
    let as_label = |v: Option<&J>| -> String {
        match v {
            Some(J::Str(s)) => s.clone(),
            Some(o @ (J::Obj(_) | J::Arr(_))) => {
                for k in ["name", "level", "value"] {
                    if truthy(o.get(k)) {
                        return text_of(o.get(k).unwrap_or(&J::Null));
                    }
                }
                String::new()
            }
            _ => String::new(),
        }
    };
    let mut eff = as_label(data.get("effort"));
    if eff.is_empty() {
        eff = as_label(data.get("model").filter(|m| truthy(Some(m))).and_then(|m| m.get("effort")));
    }
    if eff.is_empty() {
        eff = as_label(data.get("output_style"));
    }
    (!eff.is_empty() && eff != "default" && eff != "Default").then_some(eff)
}

fn run_base(cmd: &str, input: &str) -> Option<String> {
    let mut c = Command::new(defaults::text("statusline.shell"));
    c.arg(defaults::text("statusline.shell_flag")).arg(cmd);
    let r = run_with_input(
        c,
        input.as_bytes(),
        Duration::from_millis(defaults::num("statusline.consolidated_timeout_ms")),
        defaults::num("statusline.base_max_buffer") as usize,
    )?;
    if !r.ok {
        return None;
    }
    Some(String::from_utf8_lossy(&r.stdout).trim_end_matches(['\r', '\n']).to_string())
}

/// The DevSwarm workspace dashboard (feature 1): from the daemon's compact snapshot copy, never the DevSwarm database.
fn devswarm_chip(cx: &Ctx, env: &BTreeMap<String, String>, c: &Colors, sep: &str) -> String {
    let st = crate::checks::git::util::Settings::from_env(&crate::reqenv::RequestEnv::from_pairs(env.clone()));
    let cfg = crate::devswarm_rt::linefile::LineCfg::read(&st);
    if !cfg.enabled {
        return String::new();
    }
    let Ok(text) = std::fs::read_to_string(crate::devswarm_rt::linefile::path()) else { return String::new() };
    let seg = crate::devswarm_rt::linefile::segment(&text, cx.now as i64, &cfg, &|name| c.c(name).to_string());
    if seg.is_empty() { seg } else { format!("{sep}{seg}") }
}

/// `generateStatusline()` for the stdin text `input_raw` and the process working directory `cwd`.
pub fn render(cx: &Ctx, env: &BTreeMap<String, String>, root: &str, cwd: &str, input_raw: &str) -> Rich {
    let c = Colors { on: env.get(defaults::text("statusline.no_color_env")).is_none_or(|v| v.is_empty()) };
    let raw = trim(input_raw).to_string();
    let data: Option<J> = if raw.starts_with('{') { parse(&raw) } else { None };
    // consolidated base
    let settings_base =
        crate::ops::settings::effective_text(defaults::text("statusline.section"), defaults::text("statusline.base_key"), "").unwrap_or_default();
    let settings_base = trim(&settings_base).to_string();
    let consolidated = if !settings_base.is_empty() {
        Some(settings_base)
    } else {
        read_json(&Path::new(&cx.home).join(defaults::text("paths.base_dir")).join(defaults::text("statusline.consolidated_file"))).and_then(|o| {
            match o.get("command") {
                Some(J::Str(s)) if !trim(s).is_empty() => Some(trim(s).to_string()),
                _ => None,
            }
        })
    };
    if let Some(base) = consolidated
        && let Some(out) = run_base(&base, &raw)
    {
        return Rich::Line(out + &ah_chip(cx, root, &c));
    }
    let g = git_info(cwd, env);
    let settings = read_json(&Path::new(cwd).join(defaults::text("statusline.claude_dir")).join(defaults::text("statusline.settings_file")))
        .filter(|v| truthy(Some(v)))
        .or_else(|| {
            read_json(&Path::new(cwd).join(defaults::text("statusline.claude_dir")).join(defaults::text("statusline.settings_local_file")))
                .filter(|v| truthy(Some(v)))
        });
    let display = data.as_ref().and_then(|d| d.get("model")).filter(|m| truthy(Some(m))).and_then(|m| m.get("display_name")).filter(|v| truthy(Some(v)));
    let model = match display {
        Some(v) => text_of(v),
        None => match model_name(cwd, cx, &settings) {
            Ok(m) => m,
            Err(()) => return Rich::Threw,
        },
    };
    let cw = data.as_ref().and_then(|d| d.get("context_window")).filter(|v| truthy(Some(v)));
    let used_pct = cw.map(|cw| floor_or(cw.get("used_percentage"), 0.0));
    let cost = data.as_ref().and_then(|d| d.get("cost")).filter(|v| truthy(Some(v)));
    let (mut duration, mut cost_usd) = (String::new(), 0.0);
    if let Some(cost) = cost {
        let ms = if truthy(cost.get("total_duration_ms")) { j_number(cost.get("total_duration_ms").unwrap_or(&J::Null)) } else { 0.0 };
        let mins = (ms / 60000.0).floor();
        let secs = ((ms % 60000.0) / 1000.0).floor();
        duration = if mins > 0.0 { format!("{}m{}s", n(mins), n(secs)) } else { format!("{}s", n(secs)) };
        let usd = cost.get("total_cost_usd").filter(|v| truthy(Some(v)));
        match usd {
            Some(J::Num(x)) => cost_usd = *x,
            Some(other) if j_number(other) > 0.0 => return Rich::Threw, // `.toFixed` is not a function on a string
            _ => {}
        }
    } else if let Some(d) = session_duration(cwd, cx) {
        duration = d;
    }
    let project_root = g.toplevel.clone();
    let rel = crate::checks::guardkit::paths::relative(&project_root, cwd);
    let (submodule, sub_path) = if rel.is_empty() || rel == "." {
        (None, String::new())
    } else if rel.starts_with("..") {
        (None, rel)
    } else {
        let parts: Vec<&str> = rel.split('/').collect();
        (Some(parts[0].to_string()).filter(|s| !s.is_empty()), parts[1..].join("/"))
    };
    let project_name = {
        let s = safe_label(&basename(&project_root));
        if s.is_empty() { defaults::text("statusline.default_project").to_string() } else { s }
    };
    let sep = format!("  {}{}{}  ", c.c("dim"), defaults::text("statusline.sep"), c.c("reset"));
    let mut h = format!("{}{}{}{project_name}{}", c.c("bold"), c.c("brightPurple"), defaults::text("statusline.header_mark"), c.c("reset"));
    if let Some(sm) = &submodule {
        h.push_str(&format!("{}/{}{}{}{}{}", c.c("dim"), c.c("reset"), c.c("bold"), c.c("brightPurple"), safe_label(sm), c.c("reset")));
    }
    h.push_str(&format!(" {}{}{}{}{}", c.c("dim"), defaults::text("statusline.user_mark"), c.c("brightCyan"), g.name, c.c("reset")));
    if !sub_path.is_empty() {
        h.push_str(&format!("{sep}{}{}{}{}", c.c("dim"), defaults::text("statusline.dir_icon"), safe_label(&sub_path), c.c("reset")));
    }
    if !g.branch.is_empty() {
        let icon = if g.is_worktree { defaults::text("statusline.tree_icon") } else { defaults::text("statusline.branch_icon") };
        let label = if g.is_worktree && !g.worktree_name.is_empty() {
            format!("{}@{}", safe_label(&g.worktree_name), safe_label(&g.branch))
        } else {
            safe_label(&g.branch)
        };
        h.push_str(&format!("{sep}{}{icon} {label}{}", c.c("brightBlue"), c.c("reset")));
        if g.modified + g.staged + g.untracked > 0 {
            let mut ind = String::new();
            if g.staged > 0 {
                ind.push_str(&format!("{}+{}{}", c.c("brightGreen"), g.staged, c.c("reset")));
            }
            if g.modified > 0 {
                ind.push_str(&format!("{}~{}{}", c.c("brightYellow"), g.modified, c.c("reset")));
            }
            if g.untracked > 0 {
                ind.push_str(&format!("{}?{}{}", c.c("dim"), g.untracked, c.c("reset")));
            }
            h.push_str(&format!(" {ind}"));
        }
        if g.ahead > 0 {
            h.push_str(&format!(" {}{}{}{}", c.c("brightGreen"), defaults::text("statusline.up"), g.ahead, c.c("reset")));
        }
        if g.behind > 0 {
            h.push_str(&format!(" {}{}{}{}", c.c("brightRed"), defaults::text("statusline.down"), g.behind, c.c("reset")));
        }
        if g.stash > 0 {
            h.push_str(&format!(" {}{}{}{}", c.c("brightPurple"), defaults::text("statusline.stash_icon"), g.stash, c.c("reset")));
        }
    }
    h.push_str(&format!("{sep}{}{model}{}", c.c("purple"), c.c("reset")));
    if let Some(e) = effort(&data) {
        h.push_str(&format!(" {}({e}){}", c.c("dim"), c.c("reset")));
    }
    let subs = subagent_count(cx);
    if subs > 0 {
        h.push_str(&format!("{sep}{}{}{subs}{}", c.c("brightCyan"), defaults::text("statusline.agent_icon"), c.c("reset")));
    }
    h.push_str(&devswarm_chip(cx, env, &c, &sep));
    if !duration.is_empty() {
        h.push_str(&format!("{sep}{}{}{duration}{}", c.c("cyan"), defaults::text("statusline.clock_icon"), c.c("reset")));
    }
    if let Some(p) = used_pct.filter(|p| *p > 0.0) {
        let col = if p >= defaults::num("statusline.level_red") as f64 {
            c.c("brightRed")
        } else if p >= defaults::num("statusline.level_yellow") as f64 {
            c.c("brightYellow")
        } else {
            c.c("brightGreen")
        };
        h.push_str(&format!("{sep}{col}{}{}% ctx{}", defaults::text("statusline.ctx_mark"), n(p), c.c("reset")));
    }
    if cost_usd > 0.0 {
        // from the limit on, `toFixed` returns `String(x)` (exponent form)
        let shown = if cost_usd >= defaults::text("statusline.tofixed_limit").parse::<f64>().unwrap_or(f64::MAX) {
            n(cost_usd)
        } else {
            crate::setup::jsfmt::to_fixed2(cost_usd)
        };
        h.push_str(&format!("{sep}{}${shown}{}", c.c("brightWhite"), c.c("reset")));
    }
    h.push_str(&ah_chip(cx, root, &c));
    let no_email = crate::ops::settings::effective_bool(defaults::text("statusline.section"), defaults::text("statusline.no_email_key"));
    if !no_email
        && let Some(email) = read_json(&Path::new(&cx.home).join(defaults::text("statusline.claude_json"))).and_then(|cfg| {
            match cfg.get("oauthAccount").and_then(|o| o.get("emailAddress")) {
                Some(J::Str(s)) if !trim(s).is_empty() => Some(trim(s).to_string()),
                _ => None,
            }
        })
    {
        h.push_str(&format!("{sep}{}{}{email}{}", c.c("dim"), defaults::text("statusline.email_icon"), c.c("reset")));
    }
    Rich::Line(h)
}

/// `getSessionStats()`: the duration from a local `session.json`. `startTime` is converted as `new Date(v)` converts it; a date
/// string whose V8 reading the port does not reproduce leaves the duration out.
fn session_duration(cwd: &str, cx: &Ctx) -> Option<String> {
    use crate::checks::jsport::date::{Parsed, parse};
    let data = read_json(&Path::new(cwd).join(defaults::text("statusline.claude_dir")).join(defaults::text("statusline.session_file")))?;
    let start = data.get("startTime").filter(|v| truthy(Some(v)))?;
    let parsed = match start {
        J::Str(s) => parse(s),
        J::Num(x) => Parsed::Ms(time_clip(*x)),
        J::Bool(b) => Parsed::Ms(f64::from(u8::from(*b))),
        other => parse(&text_of(other)), // an array or object becomes its string form first
    };
    let mins = match parsed {
        Parsed::Ms(ms) => ((cx.now - ms) / 60000.0).floor(),
        Parsed::Nan => f64::NAN,
        Parsed::Unknown => return None,
    };
    Some(if mins < 60.0 { format!("{}m", n(mins)) } else { format!("{}h{}m", n((mins / 60.0).floor()), n(mins % 60.0)) })
}

/// `TimeClip(x)`: NaN outside the representable date range, else the integer part.
fn time_clip(x: f64) -> f64 {
    let max = defaults::text("statusline.date_max_ms").parse::<f64>().unwrap_or(f64::NAN);
    if !x.is_finite() || x.abs() > max { f64::NAN } else { x.trunc() + 0.0 }
}
