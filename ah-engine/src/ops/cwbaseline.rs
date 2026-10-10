//! `ah-engine coordinator-work-baseline <transcript.jsonl> [--from-line N] [--cwd DIR] [--json]`: replay a session transcript's
//! main-thread Bash calls through the coordinator-work classifier and window and say what the guard would have done. Port of
//! `scripts/coordinator-work-baseline.js`. The command reads the transcript (only the lines that can hold a Bash tool use or its
//! result) and asks the plugin script `coordinator-work-baseline.js` (`cwbRun`), which builds on the classifier of `command.js` and the
//! window of `coordinator-work-guard.js`, for the numbers. A command whose class only the hook process could tell (a relative path,
//! an unreadable file) is counted as not work and said once on stderr: a baseline is an analysis, not a guard.
use super::{err, opcli_call, opcli_cfg, out};
use crate::cli::Parsed;
use crate::defaults;
use serde_json::{Value, json};
use std::io::BufRead;

/// Node's `Number(x) || 0` of an argument.
fn number_or_zero(arg: Option<&String>) -> f64 {
    let n = arg.map_or(f64::NAN, |s| crate::checks::guardkit::text::js_number_of_str(s));
    if n.is_nan() { 0.0 } else { n }
}

fn fail(msg: String) -> i32 {
    err(&(msg + "\n"));
    defaults::num("opcli.fail_exit") as i32
}

pub(crate) fn run(p: &Parsed) -> i32 {
    let (mut file, mut from, mut cwd, mut json_out) = (None::<String>, 0.0, None::<String>, false);
    let argv = &p.raw;
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        if a == defaults::text("opcli.cwb_json_flag") {
            json_out = true;
        } else if a == defaults::text("opcli.cwb_from_flag") {
            i += 1;
            from = number_or_zero(argv.get(i));
        } else if a == defaults::text("opcli.cwb_cwd_flag") {
            i += 1;
            cwd = argv.get(i).filter(|s| !s.is_empty()).cloned();
        } else if file.is_none() {
            file = Some(a.to_string());
        }
        i += 1;
    }
    let shown = file.clone().unwrap_or_else(|| "null".to_string());
    let Some(path) = file.as_deref().filter(|f| !f.is_empty()) else {
        return fail(defaults::render("opcli.cwb_not_found", &[("file", &if file.is_some() { String::new() } else { shown })]));
    };
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => {}
        Ok(_) => return fail(defaults::render("opcli.cwb_not_found", &[("file", &path)])),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return fail(defaults::render("opcli.cwb_error", &[("error", &defaults::render("opcli.cwb_enoent", &[("path", &path)]))]));
        }
        Err(e) => return fail(defaults::render("opcli.cwb_error", &[("error", &e)])),
    }
    let reader = match std::fs::File::open(path) {
        Ok(f) => std::io::BufReader::new(f),
        Err(e) => return fail(defaults::render("opcli.cwb_error", &[("error", &e)])),
    };
    let marks = defaults::list("opcli.cwb_prefilter");
    let mut lines: Vec<Value> = Vec::new();
    for (idx, raw) in reader.split(b'\n').enumerate() {
        let Ok(raw) = raw else { break };
        let n = (idx + 1) as f64;
        if n < from {
            continue;
        }
        let text = String::from_utf8_lossy(&raw);
        let text = text.strip_suffix('\r').unwrap_or(&text);
        if marks.iter().any(|m| text.contains(m)) {
            lines.push(json!([n, text]));
        }
    }
    let process_cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let input = json!({"lines": lines, "fromLine": from, "cwd": cwd, "processCwd": process_cwd, "json": json_out, "cfg": opcli_cfg()});
    let Some(r) = opcli_call("coordinator-work-baseline", defaults::text("opcli.cwb_script"), "cwbRun", &input) else {
        return defaults::num("opcli.fail_exit") as i32;
    };
    out(r.get("out").and_then(Value::as_str).unwrap_or_default());
    let missed = r.get("unclassified").and_then(Value::as_u64).unwrap_or(0);
    if missed > 0 {
        err(&(defaults::render("opcli.cwb_unclassified", &[("count", &missed)]) + "\n"));
    }
    0
}
