//! The fallback status lines used when the rich renderer prints nothing: the simple one (model, branch, directory, context) and
//! the monorepo one (model, current task, directory, context bar). Ports of `statusline-simple.js` and `statusline-monorepo.js`.
use super::phasebar::Ctx;
use super::util::{n, run_with_input, truthy};
use crate::checks::git::util::posix_basename;
use crate::checks::jsport::json::{self, J};
use crate::checks::jsport::{fsx, num};
use crate::defaults;
use crate::migrate::{j_number, j_string};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

fn col(name: &str) -> &'static str {
    defaults::raw("statusline.simple_colors").get(name).and_then(defaults::V::as_str).unwrap_or("")
}

fn data_of(input: &str) -> Option<J> {
    match json::parse(input, defaults::num("setup.json_max_depth") as usize) {
        Ok(J::Null) | Err(_) => None, // `null.model` throws: the renderer prints nothing
        Ok(v) => Some(v),
    }
}

fn dir_of(data: &J, cwd: &str) -> String {
    let ws = data.get("workspace").and_then(|w| w.get("current_dir")).filter(|v| truthy(Some(v)));
    match ws.or_else(|| data.get("cwd").filter(|v| truthy(Some(v)))) {
        Some(v) => j_string(v),
        None => cwd.to_string(),
    }
}

fn model_of(data: &J) -> String {
    match data.get("model").and_then(|m| m.get("display_name")).filter(|v| truthy(Some(v))) {
        Some(v) => j_string(v),
        None => defaults::text("statusline.simple_model").to_string(),
    }
}

/// `statusline-simple.js`
pub fn simple(input: &str, cwd: &str, env: &BTreeMap<String, String>) -> Option<String> {
    let data = data_of(input)?;
    let model = model_of(&data);
    let dir = dir_of(&data, cwd);
    let ctx_seg = match data.get("context_window").and_then(|c| c.get("remaining_percentage")) {
        Some(J::Num(r)) if r.is_finite() => {
            let used = num::js_round(100.0 - r).clamp(0.0, 100.0);
            let color = if used < 50.0 { col("green") } else if used < 75.0 { col("yellow") } else { col("red") };
            format!("{color}{}%{}", n(used), col("reset"))
        }
        _ => String::new(),
    };
    let mut c = Command::new(defaults::text("statusline.git_bin"));
    c.args(defaults::list("statusline.git_branch_args")).current_dir(&dir);
    for (k, v) in env {
        c.env(k, v);
    }
    let branch = run_with_input(c, b"", Duration::from_millis(defaults::num("statusline.simple_git_timeout_ms")), defaults::num("statusline.git_max_buffer") as usize)
        .filter(|r| r.ok)
        .map(|r| String::from_utf8_lossy(&r.stdout).trim().to_string())
        .unwrap_or_default();
    let dirname = posix_basename(&dir);
    let mut segs = vec![format!("{}{model}{}", col("dim"), col("reset"))];
    if !branch.is_empty() {
        segs.push(format!("{}{branch}{}", col("blue"), col("reset")));
    }
    if !dirname.is_empty() {
        segs.push(format!("{}{dirname}{}", col("dim"), col("reset")));
    }
    if !ctx_seg.is_empty() {
        segs.push(ctx_seg);
    }
    Some(segs.join(defaults::text("statusline.simple_join")))
}

/// `statusline-monorepo.js`
pub fn monorepo(input: &str, cwd: &str, cx: &Ctx, env: &BTreeMap<String, String>) -> Option<String> {
    let data = data_of(input)?;
    let model = model_of(&data);
    let dir = dir_of(&data, cwd);
    let session = match data.get("session_id") {
        v if truthy(v) => j_string(v.unwrap_or(&J::Null)),
        _ => String::new(),
    };
    let cw = data.get("context_window");
    let total = cw.and_then(|c| c.get("total_tokens")).filter(|v| truthy(Some(v))).map_or(1_000_000.0, j_number);
    let acw = env.get(defaults::text("statusline.compact_env")).filter(|v| !v.is_empty()).map_or(0.0, |v| crate::setup::jsfmt::parse_int(v).unwrap_or(f64::NAN));
    let buffer = if acw > 0.0 { ((acw / total) * 100.0).min(100.0) } else { defaults::text("statusline.compact_default").parse::<f64>().unwrap_or(16.5) };
    let mut ctx = String::new();
    if let Some(J::Num(rem)) = cw.and_then(|c| c.get("remaining_percentage")).filter(|v| matches!(v, J::Num(x) if x.is_finite())) {
        let usable = (((rem - buffer) / (100.0 - buffer)) * 100.0).max(0.0);
        let used = num::js_round(100.0 - usable).clamp(0.0, 100.0);
        let filled = (used / 10.0).floor() as usize;
        let bar = format!("{}{}", "#".repeat(filled), "-".repeat(10 - filled));
        let color = if used < 50.0 { col("green") } else if used < 65.0 { col("yellow") } else if used < 80.0 { col("orange") } else { col("boldred") };
        ctx = format!(" {color}[{bar}] {}%{}", n(used), col("reset"));
    }
    let mut task = String::new();
    let claude_dir = env.get(defaults::text("statusline.config_dir_env")).filter(|v| !v.is_empty()).cloned().unwrap_or_else(|| Path::new(&cx.home).join(defaults::text("statusline.claude_dir")).to_string_lossy().into_owned());
    let todos = Path::new(&claude_dir).join(defaults::text("statusline.todos_dir"));
    if !session.is_empty() && todos.exists() {
        let mut files: Vec<(String, f64)> = std::fs::read_dir(&todos)
            .map(|rd| {
                let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
                names
                    .into_iter()
                    .filter(|f| f.starts_with(&session) && f.contains(defaults::text("statusline.agent_infix")) && f.ends_with(".json"))
                    .filter_map(|f| std::fs::metadata(todos.join(&f)).ok().map(|m| (f, fsx::mtime_ms(&m))))
                    .collect()
            })
            .unwrap_or_default();
        files.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        if let Some((name, _)) = files.first()
            && let Some(J::Arr(list)) = std::fs::read(todos.join(name)).ok().and_then(|b| json::parse(&String::from_utf8_lossy(&b), defaults::num("setup.json_max_depth") as usize).ok())
        {
            for t in &list {
                if matches!(t, J::Null) {
                    break; // `.status` of null throws: no task
                }
                if matches!(t.get("status"), Some(J::Str(s)) if s == defaults::text("statusline.in_progress")) {
                    task = match t.get("activeForm") {
                        v if truthy(v) => j_string(v.unwrap_or(&J::Null)),
                        _ => String::new(),
                    };
                    break;
                }
            }
        }
    }
    let dirname = posix_basename(&dir);
    let model_seg = format!("{}{model}{}", col("dim"), col("reset"));
    let dir_seg = format!("{}{dirname}{}", col("dim"), col("reset"));
    let join = defaults::text("statusline.simple_join");
    Some(if task.is_empty() { format!("{model_seg}{join}{dir_seg}{ctx}") } else { format!("{model_seg}{join}{}{task}{}{join}{dir_seg}{ctx}", col("bold"), col("reset")) })
}
