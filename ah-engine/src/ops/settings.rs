//! `ah-engine settings`: show, read, change and reset any anti-hall setting. Port of `scripts/settings.js`.
//!
//! The values are read and written through the same chain the Node store defines (`hooks/lib/settings.js`), which the
//! migration module already implements for the forward migrations ([`crate::migrate::settings`]): environment, then
//! `~/.anti-hall/settings.json`, then the plugin option, then the legacy file, then the schema default. The registry that
//! says which settings exist, their labels and descriptions is the plugin's generated `engine/defaults/settings_cli.toml`
//! (next to the validation schema `migrate_settings.toml`); nothing about a setting is written in this file.
use super::{allow, env_snapshot, err, home, out, plugin_root};
use crate::checks::git::util::Settings;
use crate::checks::jsport::json::{self, J};
use crate::cli::Parsed;
use crate::defaults;
use crate::jev::settings::{Env, JevSettings, Sources};
use crate::migrate::settings::{self as store, Entry, Outcome};
use crate::migrate::{Ctx, j_string, plugin_version};
use crate::setup::jsfmt::pretty;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;

// ---- the registry -----------------------------------------------------------------------------------------------------

/// One setting as `show` prints it.
struct Item {
    section: String,
    key: String,
    /// The schema default; `None` when the schema has none (`undefined`), `Some(J::Null)` for an explicit `null`.
    default: Option<J>,
    advanced: bool,
    locked: bool,
    safety_note: String,
    description: String,
}

struct Section {
    key: String,
    label: String,
    description: String,
}

fn parse_item(t: &str) -> Option<J> {
    json::parse(t, defaults::num("setup.json_max_depth") as usize).ok()
}

fn s_field(v: &J, k: &str) -> String {
    match v.get(k) {
        Some(J::Str(s)) => s.clone(),
        _ => String::new(),
    }
}

fn b_field(v: &J, k: &str) -> bool {
    matches!(v.get(k), Some(J::Bool(true)))
}

fn items() -> &'static [Item] {
    static ALL: OnceLock<Vec<Item>> = OnceLock::new();
    ALL.get_or_init(|| {
        defaults::list("settings_cli.items")
            .iter()
            .filter_map(|t| parse_item(t))
            .map(|v| Item {
                section: s_field(&v, "section"),
                key: s_field(&v, "key"),
                default: v.get("default").cloned(),
                advanced: b_field(&v, "advanced"),
                locked: b_field(&v, "locked"),
                safety_note: s_field(&v, "safetyNote"),
                description: s_field(&v, "description"),
            })
            .collect()
    })
}

fn sections() -> &'static [Section] {
    static ALL: OnceLock<Vec<Section>> = OnceLock::new();
    ALL.get_or_init(|| {
        defaults::list("settings_cli.sections")
            .iter()
            .filter_map(|t| parse_item(t))
            .map(|v| Section { key: s_field(&v, "key"), label: s_field(&v, "label"), description: s_field(&v, "description") })
            .collect()
    })
}

fn find_item(section: &str, key: &str) -> Option<&'static Item> {
    items().iter().find(|i| i.section == section && i.key == key)
}

// ---- formatting -------------------------------------------------------------------------------------------------------

fn source_label(src: &str) -> String {
    defaults::raw("ops.settings_sources").get(src).and_then(defaults::V::as_str).unwrap_or(src).to_string()
}

/// `fmtValue(v)`.
fn fmt_value(v: Option<&J>) -> String {
    match v {
        None | Some(J::Null) => defaults::text("ops.empty_value").to_string(),
        Some(J::Str(s)) if s.is_empty() => defaults::text("ops.empty_value").to_string(),
        Some(o @ (J::Obj(_) | J::Arr(_))) => {
            let q = defaults::text("ops.code_quote");
            format!("{q}{}{q}", json::stringify(o).replace('|', "\\|"))
        }
        Some(other) => j_string(other),
    }
}

fn render_table(rows: &[Vec<String>], headers: &[&str]) -> String {
    let bar = defaults::text("ops.cell_sep");
    let mut lines = Vec::new();
    lines.push(format!("| {} |", headers.join(bar)));
    lines.push(format!("|{}|", headers.iter().map(|_| defaults::text("ops.rule_cell")).collect::<Vec<_>>().join("|")));
    for r in rows {
        lines.push(format!("| {} |", r.join(bar)));
    }
    lines.join("\n")
}

fn opt_default(i: &Item) -> Option<&J> {
    i.default.as_ref()
}

// ---- the run ----------------------------------------------------------------------------------------------------------

struct Run {
    ctx: Ctx,
    env: BTreeMap<String, String>,
    home: String,
    code: i32,
}

impl Run {
    fn new() -> Run {
        let env = env_snapshot();
        let home = home(&env);
        let root = plugin_root(&env);
        let mut ctx = Ctx::new(home.clone(), String::new(), env.clone(), false, None, root.clone());
        ctx.version = root.as_deref().and_then(|r| plugin_version(&ctx, r));
        Run { ctx, env, home, code: 0 }
    }

    fn entry(&self, i: &Item) -> Option<&'static Entry> {
        store::find(&i.section, &i.key)
    }

    /// `settings.get(section, key)` with the schema default standing in when the chain yields nothing.
    fn value(&self, i: &Item) -> Option<J> {
        match self.entry(i) {
            Some(e) => store::get(&self.ctx, e, None).or_else(|| i.default.clone()),
            None => i.default.clone(),
        }
    }

    fn source(&self, i: &Item) -> &'static str {
        self.entry(i).map_or("default", |e| store::source(&self.ctx, e))
    }

    fn fail(&mut self, line: String) {
        err(&(line + "\n"));
        self.code = 1;
    }
}

#[derive(Default)]
struct Args {
    positional: Vec<String>,
    json: bool,
    all: bool,
    section: Option<String>,
    confirmed: bool,
}

fn parse_args(argv: &[String]) -> Args {
    let mut a = Args::default();
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--json" => a.json = true,
            "--all" => a.all = true,
            "--confirmed" => a.confirmed = true,
            "--section" => {
                i += 1;
                a.section = argv.get(i).cloned();
            }
            other => a.positional.push(other.to_string()),
        }
        i += 1;
    }
    a
}

fn split_key(dotted: Option<&String>) -> Option<(String, String)> {
    let d = dotted?;
    let idx = d.find('.')?;
    Some((d[..idx].to_string(), d[idx + 1..].to_string()))
}

// ---- show -------------------------------------------------------------------------------------------------------------

struct Integration {
    id: String,
    effective: String,
    configured: Option<J>,
    source: &'static str,
    logs: String,
}

fn integrations(run: &Run) -> Vec<Integration> {
    let home = Path::new(&run.home);
    let process_env = Env::process();
    let jev = JevSettings::resolve(home, Sources::load(home, process_env.clone()));
    let base = home.join(defaults::text("paths.base_dir"));
    let read_obj = |name: &str| match std::fs::read_to_string(base.join(name)).ok().and_then(|t| parse_item(&t)) {
        Some(o @ J::Obj(_)) => o,
        _ => J::Obj(Vec::new()),
    };
    let file_cfg = read_obj(defaults::text("jev.legacy_file"));
    let settings_cfg = match read_obj(defaults::text("jev.settings_file")).get(defaults::text("ops.jev_section")) {
        Some(o @ J::Obj(_)) => o.clone(),
        _ => J::Obj(Vec::new()),
    };
    let cfg_get = |k: &str| settings_cfg.get(k).or_else(|| file_cfg.get(k)).cloned();
    let mut enabled = matches!(cfg_get("enabled"), Some(J::Bool(true))) || process_env.get(defaults::text("env.jev_enabled")) == Some("1");
    if process_env.get(defaults::text("env.jev_enabled")) == Some("0") {
        enabled = false;
    }
    items()
        .iter()
        .filter(|i| i.section == defaults::text("ops.jev_integrations_section"))
        .map(|i| {
            let e = run.entry(i);
            let triage = i.key == defaults::text("jev.legacy_triage_key");
            let effective = if triage {
                let off = process_env.get(&crate::jev::settings::integration_env_name(&i.key)) == Some("0")
                    || e.and_then(|e| store::get(&run.ctx, e, None)).is_some_and(|v| matches!(v, J::Str(s) if s == defaults::text("ops.mode_off")));
                let on = enabled && !matches!(cfg_get("triage"), Some(J::Bool(false))) && !off;
                if on { defaults::text("ops.mode_on") } else { defaults::text("ops.mode_off") }.to_string()
            } else {
                jev.mode(&i.key, false).as_str().to_string()
            };
            Integration {
                id: i.key.clone(),
                effective,
                configured: run.value(i),
                source: run.source(i),
                logs: if triage { defaults::text("ops.logs_triage") } else { defaults::text("ops.logs_default") }.to_string(),
            }
        })
        .collect()
}

fn section_rows(run: &Run, sec: &Section, advanced: bool) -> Vec<Vec<String>> {
    items()
        .iter()
        .filter(|i| i.section == sec.key && i.advanced == advanced)
        .map(|i| {
            let mut name = i.key.clone();
            if i.advanced {
                name.push_str(defaults::text("ops.advanced_suffix"));
            }
            if i.locked {
                name.push_str(defaults::text("ops.locked_suffix"));
            }
            vec![name, fmt_value(run.value(i).as_ref()), fmt_value(opt_default(i)), source_label(run.source(i)), i.description.clone()]
        })
        .collect()
}

fn integration_json(list: &[Integration]) -> J {
    J::Arr(
        list.iter()
            .map(|r| {
                let mut o = vec![("id".to_string(), J::Str(r.id.clone())), ("effective".to_string(), J::Str(r.effective.clone()))];
                if let Some(c) = &r.configured {
                    o.push(("configured".to_string(), c.clone()));
                }
                o.push(("source".to_string(), J::Str(r.source.to_string())));
                o.push(("logs".to_string(), J::Str(r.logs.clone())));
                J::Obj(o)
            })
            .collect(),
    )
}

fn cmd_show(run: &mut Run, a: &Args) {
    let target: Vec<&Section> = match &a.section {
        Some(s) if !s.is_empty() => sections().iter().filter(|x| x.key == *s).collect(),
        _ => sections().iter().collect(),
    };
    let wanted = a.section.as_deref().filter(|s| !s.is_empty());
    if let Some(name) = wanted
        && target.is_empty()
    {
        run.fail(defaults::render("ops.settings_unknown_section", &[("name", &name)]));
        return;
    }
    let jev_sections = [defaults::text("ops.jev_section"), defaults::text("ops.jev_integrations_section")];
    if a.json {
        let mut top = Vec::new();
        for sec in &target {
            let mut members = Vec::new();
            for i in items().iter().filter(|i| i.section == sec.key) {
                if !a.all && i.advanced {
                    continue;
                }
                let mut o = Vec::new();
                if let Some(v) = run.value(i) {
                    o.push(("value".to_string(), v));
                }
                if let Some(d) = &i.default {
                    o.push(("default".to_string(), d.clone()));
                }
                o.push(("source".to_string(), J::Str(run.source(i).to_string())));
                o.push(("advanced".to_string(), J::Bool(i.advanced)));
                o.push(("locked".to_string(), J::Bool(i.locked)));
                members.push((i.key.clone(), J::Obj(o)));
            }
            top.push((sec.key.clone(), J::Obj(members)));
        }
        if target.iter().any(|s| jev_sections.contains(&s.key.as_str())) {
            top.push((defaults::text("ops.jev_effective_key").to_string(), integration_json(&integrations(run))));
        }
        out(&(pretty(&J::Obj(top)) + "\n"));
        return;
    }
    let headers = defaults::list("ops.table_headers");
    let int_headers = defaults::list("ops.table_headers_integrations");
    let mut lines: Vec<String> = Vec::new();
    for sec in &target {
        lines.push(format!("{}{}", defaults::text("ops.heading_prefix"), sec.label));
        lines.push(String::new());
        if !sec.description.is_empty() {
            lines.push(sec.description.clone());
            lines.push(String::new());
        }
        let headline = section_rows(run, sec, false);
        if !headline.is_empty() {
            lines.push(render_table(&headline, &headers));
            lines.push(String::new());
        }
        let advanced_count = items().iter().filter(|i| i.section == sec.key && i.advanced).count();
        if advanced_count > 0 {
            if a.all {
                lines.push(defaults::text("ops.advanced_label").to_string());
                lines.push(String::new());
                lines.push(render_table(&section_rows(run, sec, true), &headers));
                lines.push(String::new());
            } else {
                lines.push(defaults::render("ops.advanced_hidden", &[("count", &advanced_count)]));
                lines.push(String::new());
            }
        }
        if sec.key == jev_sections[0] || (sec.key == jev_sections[1] && wanted.is_some()) {
            lines.push(defaults::text("ops.integrations_title").to_string());
            lines.push(String::new());
            let rows: Vec<Vec<String>> = integrations(run)
                .iter()
                .map(|r| vec![r.id.clone(), r.effective.clone(), fmt_value(r.configured.as_ref()), source_label(r.source), r.logs.clone()])
                .collect();
            lines.push(render_table(&rows, &int_headers));
            lines.push(String::new());
        }
    }
    if wanted.is_none() {
        lines.push(defaults::text("ops.not_toggleable_title").to_string());
        lines.push(String::new());
        lines.push(defaults::text("ops.not_toggleable_intro").to_string());
        lines.push(String::new());
        for n in defaults::list("settings_cli.not_toggleable").iter().filter_map(|t| parse_item(t)) {
            lines.push(defaults::render("ops.not_toggleable_line", &[("name", &s_field(&n, "name")), ("reason", &s_field(&n, "reason"))]));
        }
        lines.push(String::new());
    }
    out(&(lines.join("\n") + "\n"));
}

// ---- get / set / reset ------------------------------------------------------------------------------------------------

fn cmd_get(run: &mut Run, a: &Args) {
    let name = a.positional.first();
    let Some((section, key)) = split_key(name) else {
        run.fail(defaults::render("ops.settings_unknown_setting", &[("name", &name.map_or("undefined", String::as_str))]));
        return;
    };
    let Some(item) = find_item(&section, &key) else {
        run.fail(defaults::render("ops.settings_unknown_setting", &[("name", &name.map_or("undefined", String::as_str))]));
        return;
    };
    let value = run.value(item);
    let src = run.source(item);
    if a.json {
        let mut o = vec![("section".to_string(), J::Str(section.clone())), ("key".to_string(), J::Str(key.clone()))];
        if let Some(v) = value {
            o.push(("value".to_string(), v));
        }
        o.push(("source".to_string(), J::Str(src.to_string())));
        if let Some(d) = &item.default {
            o.push(("default".to_string(), d.clone()));
        }
        out(&(json::stringify(&J::Obj(o)) + "\n"));
    } else {
        out(&(defaults::render(
            "ops.get_line",
            &[
                ("name", &format!("{section}.{key}")),
                ("value", &fmt_value(value.as_ref())),
                ("source", &source_label(src)),
                ("default", &fmt_value(opt_default(item))),
            ],
        ) + "\n"));
    }
}

/// The `{ok:false...}` / error line shared by `set` and `reset`; returns the exit code to use.
fn report_failure(run: &mut Run, a: &Args, outcome: Outcome) -> bool {
    match outcome {
        Outcome::Done => return false,
        Outcome::LockBusy => {
            err(&(defaults::text("ops.lock_busy").to_string() + "\n"));
            run.code = super::defer_code();
            return true;
        }
        Outcome::Needs(warning) => {
            if a.json {
                out(&(json::stringify(&J::Obj(vec![
                    ("ok".into(), J::Bool(false)),
                    ("needsConfirmation".into(), J::Bool(true)),
                    ("warning".into(), J::Str(warning)),
                ])) + "\n"));
            } else {
                out(&(warning + "\n"));
            }
        }
        Outcome::Fail(error) => {
            if a.json {
                out(&(json::stringify(&J::Obj(vec![("ok".into(), J::Bool(false)), ("error".into(), J::Str(error))])) + "\n"));
            } else {
                err(&(defaults::render("ops.settings_err", &[("error", &error)]) + "\n"));
            }
        }
    }
    run.code = 1;
    true
}

fn report_success(run: &Run, a: &Args, item: &Item, section: &str, key: &str, line_key: fn(&str) -> String) {
    let value = run.value(item);
    if a.json {
        let mut o = vec![("ok".to_string(), J::Bool(true)), ("section".to_string(), J::Str(section.into())), ("key".to_string(), J::Str(key.into()))];
        if let Some(v) = value {
            o.push(("value".to_string(), v));
        }
        out(&(json::stringify(&J::Obj(o)) + "\n"));
    } else {
        out(&(line_key(&fmt_value(value.as_ref())).replace("{name}", &format!("{section}.{key}")) + "\n"));
    }
}

fn set_line(v: &str) -> String {
    defaults::render("ops.set_line", &[("value", &v)])
}

fn reset_line(v: &str) -> String {
    defaults::render("ops.reset_line", &[("value", &v)])
}

fn cmd_set(run: &mut Run, a: &Args) {
    let name = a.positional.first();
    let found = split_key(name).and_then(|(s, k)| find_item(&s, &k).map(|i| (s, k, i)));
    let Some((section, key, item)) = found else {
        run.fail(defaults::render("ops.settings_unknown_setting", &[("name", &name.map_or("undefined", String::as_str))]));
        return;
    };
    let Some(raw) = a.positional.get(1) else {
        run.fail(defaults::text("ops.settings_usage_set").to_string());
        return;
    };
    let Some(entry) = run.entry(item) else { return };
    let outcome = store::set_cli(&run.ctx, entry, &item.safety_note, raw, a.confirmed);
    if report_failure(run, a, outcome) {
        return;
    }
    report_success(run, a, item, &section, &key, set_line);
}

fn cmd_reset(run: &mut Run, a: &Args) {
    let name = a.positional.first();
    let found = split_key(name).and_then(|(s, k)| find_item(&s, &k).map(|i| (s, k, i)));
    let Some((section, key, item)) = found else {
        run.fail(defaults::render("ops.settings_unknown_setting", &[("name", &name.map_or("undefined", String::as_str))]));
        return;
    };
    let Some(entry) = run.entry(item) else { return };
    let outcome = store::reset_cli(&run.ctx, entry, &item.safety_note, a.confirmed);
    if report_failure(run, a, outcome) {
        return;
    }
    report_success(run, a, item, &section, &key, reset_line);
}

// ---- judge ------------------------------------------------------------------------------------------------------------

fn cmd_judge(run: &mut Run, a: &Args) {
    let verb = a.positional.first().map(String::as_str);
    let Some(verb) = verb.filter(|v| defaults::list("ops.judge_verbs").contains(v)) else {
        run.fail(defaults::text("ops.settings_usage_judge").to_string());
        return;
    };
    let semantic = find_item(defaults::text("ops.jev_section"), defaults::text("ops.judge_switch_key"));
    let (Some(sem), Some(sem_entry)) = (semantic, semantic.and_then(|i| run.entry(i))) else { return };
    if verb != "status" {
        let raw = if verb == "on" { defaults::text("ops.true_word") } else { defaults::text("ops.false_word") };
        match store::set_cli(&run.ctx, sem_entry, &sem.safety_note, raw, false) {
            Outcome::Done => {}
            Outcome::LockBusy => {
                err(&(defaults::text("ops.lock_busy").to_string() + "\n"));
                run.code = super::defer_code();
                return;
            }
            Outcome::Needs(_) => {
                run.fail(defaults::render("ops.settings_err", &[("error", &defaults::text("ops.undefined_word"))]));
                return;
            }
            Outcome::Fail(e) => {
                run.fail(defaults::render("ops.settings_err", &[("error", &e)]));
                return;
            }
        }
    }
    let get_dflt = |section: &str, key: &str, dflt: J| -> J {
        find_item(section, key).and_then(|i| run.entry(i)).and_then(|e| store::get(&run.ctx, e, Some(&dflt))).unwrap_or(dflt)
    };
    let jev_sec = defaults::text("ops.jev_section");
    let on = matches!(get_dflt(jev_sec, defaults::text("ops.judge_switch_key"), J::Bool(false)), J::Bool(true));
    let st = Settings { home: run.home.clone(), env: run.env.clone().into_iter().collect() };
    let has_key = crate::judge::settings::anthropic_key_visible(&st, true).unwrap_or(false);
    // speculationBackend(): jev mode of `speculation`, else the API judge flag.
    let home = Path::new(&run.home);
    let jev = JevSettings::resolve(home, Sources::load(home, Env::process()));
    let be = if jev.mode(defaults::text("ops.speculation_id"), false).as_str() == defaults::text("ops.mode_on") {
        defaults::text("ops.backend_jev")
    } else if on {
        defaults::text("ops.backend_api")
    } else {
        defaults::text("ops.backend_lexical")
    };
    let model = j_string(&get_dflt(jev_sec, defaults::text("ops.judge_model_key"), J::Str(defaults::text("ops.judge_model_default").into())));
    let mut lines: Vec<String> = Vec::new();
    let still_env = if verb == "off" && on { defaults::text("ops.judge_still_on") } else { "" };
    lines.push(defaults::render(
        "ops.judge_line",
        &[("state", &if on { defaults::text("ops.mode_on") } else { defaults::text("ops.mode_off") }), ("extra", &still_env)],
    ));
    let jb = j_string(&get_dflt(jev_sec, defaults::text("ops.judge_backend_key"), J::Str(defaults::text("ops.judge_backend_default").into())));
    let via_cli = jb == defaults::text("ops.judge_cli") || (jb == defaults::text("ops.judge_auto") && !has_key);
    let detail = if be == defaults::text("ops.backend_jev") {
        let tail = if on { defaults::text("ops.jev_detail_skipped") } else { defaults::text("ops.jev_detail_plain") };
        defaults::render("ops.backend_jev_detail", &[("tail", &tail)])
    } else if be == defaults::text("ops.backend_api") {
        if via_cli { defaults::render("ops.backend_api_cli", &[("backend", &jb)]) } else { defaults::text("ops.backend_api_api").to_string() }
    } else {
        defaults::text("ops.backend_lexical_detail").to_string()
    };
    lines.push(defaults::render("ops.backend_line", &[("backend", &be), ("detail", &detail)]));
    if verb == "on" || verb == "status" {
        lines.push(if has_key { defaults::text("ops.key_found") } else { defaults::text("ops.key_missing") }.to_string());
        if verb == "status" {
            lines.push(defaults::render("ops.model_line", &[("model", &model)]));
        }
    }
    if verb == "on" {
        if !has_key && !via_cli {
            for l in defaults::list("ops.judge_no_key_lines") {
                lines.push(l.to_string());
            }
        }
        let cost = if via_cli { defaults::text("ops.judge_cost_cli") } else { defaults::text("ops.judge_cost_api") };
        lines.push(defaults::render("ops.cost_line", &[("cost", &cost)]));
    }
    out(&(lines.join("\n") + "\n"));
}

/// The effective value of one setting as text (`String(settings.get(section, key, dflt) || '')`); `None` for a key the registry
/// does not list.
pub(crate) fn effective_text(section: &str, key: &str, dflt: &str) -> Option<String> {
    let run = Run::new();
    let entry = store::find(section, key)?;
    let d = J::Str(dflt.to_string());
    let v = store::get(&run.ctx, entry, Some(&d))?;
    Some(match &v {
        J::Null => String::new(),
        J::Bool(false) => String::new(),
        J::Num(n) if *n == 0.0 || n.is_nan() => String::new(),
        other => j_string(other),
    })
}

/// `settings.get(section, key) === true`.
pub(crate) fn effective_bool(section: &str, key: &str) -> bool {
    let run = Run::new();
    store::find(section, key).and_then(|e| store::get(&run.ctx, e, None)).is_some_and(|v| matches!(v, J::Bool(true)))
}

// ---- entry ------------------------------------------------------------------------------------------------------------

/// `settings <verb> [args] [--json]`
pub fn run(p: &Parsed) -> i32 {
    let plan = super::shadow::begin(defaults::text("ops.verb_settings"), defaults::text("ops.script_settings"), &p.raw, None);
    let code = run_inner(p);
    super::shadow::end(plan, code);
    code
}

fn run_inner(p: &Parsed) -> i32 {
    let verb = p.raw.first().map(String::as_str);
    let a = parse_args(p.raw.get(1..).unwrap_or(&[]));
    let mut run = Run::new();
    match verb {
        Some("show") => cmd_show(&mut run, &a),
        Some("get") => cmd_get(&mut run, &a),
        Some("set") => cmd_set(&mut run, &a),
        Some("reset") => cmd_reset(&mut run, &a),
        Some("judge") => cmd_judge(&mut run, &a),
        Some("trust-command-allow") => run.code = allow::run_trust(allow::Kind::Command, &a.positional, a.json, a.confirmed, &run.env, &run.home),
        Some("trust-edit-allow") => run.code = allow::run_trust(allow::Kind::Edit, &a.positional, a.json, a.confirmed, &run.env, &run.home),
        _ => run.fail(defaults::text("ops.settings_usage").to_string()),
    }
    // The Node tool swallows these (an unreadable or unparseable settings file reads as empty); stderr stays byte-identical
    // and the engine keeps the fact in its event log instead.
    for n in run.ctx.take_notes() {
        crate::discard::note("ops_settings_read", &n);
    }
    run.code
}
