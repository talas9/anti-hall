//! The evidence gate (owner rule J1, design `jev-evidence-design.md` section 1): a model, Jev or Haiku through the cascade, is asked
//! only when the concrete evidence a confident answer needs has been gathered and is in the call.
//!
//! For an integration listed in `evidence.integrations` a decision goes through four steps, in this order:
//! 1. **Mode.** An integration that is `off` (or Jev disabled) is not looked at, and writes no row.
//! 2. **Rules.** The deterministic facts of the pack may settle the case outright (a done child is not asked about, running CI means
//!    waiting, one step in progress is the step, a recent commit means not looping). No model is called; the row says `rule`.
//! 3. **Sufficiency.** Every `required` fact must meet its minimum, otherwise the call is skipped with the missing items named.
//! 4. **Ask.** If the integration has `ask_when` groups, one must hold (the model confirms a rule-found candidate, it never
//!    discovers one); then the labelled pack goes to the backend: Jev through the shared layer (whose own cascade may escalate to
//!    Haiku), or Haiku directly with an answer that must cite an evidence line that exists, capped per integration per day.
//!
//! Every outcome is logged with which facts were present and which required ones were missing (`evidence.log`). The shipped
//! modes are untouched: this gate only decides whether to ask and what the pack holds; whether the answer is acted on stays with
//! the integration's mode and the caller. Every number, rule, prompt and word is in `engine/defaults/jev_evidence.toml`.
use super::assist::iso_ms;
use super::cascade;
use super::client::Answer;
use super::question::{Kind, Question};
use super::settings::{Env, Mode};
use super::{AskRequest, Trust};
use crate::checks::git::util::Settings;
use crate::checks::jsport::text::slice16_lossy;
use crate::checks::replykit::io::now_ms;
use crate::defaults;
use crate::judge::{cli, settings, telemetry};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::Path;
use std::time::Duration;

/// One rule of an integration: when all its conditions hold, `then` is the result.
#[derive(Debug, Clone)]
struct Rule {
    id: String,
    when: Vec<String>,
    then: String,
}

/// An integration's evidence configuration (`evidence.<id>`).
#[derive(Debug, Clone)]
struct Cfg {
    id: String,
    backend: String,
    steps: bool,
    daily_cap: u64,
    pack_cap: usize,
    section_cap: usize,
    act: f64,
    question: String,
    true_label: String,
    false_label: String,
    true_meaning: String,
    false_meaning: String,
    unknown_label: String,
    unknown_meaning: String,
    step_text_cap: usize,
    sections: Vec<String>,
    required: Vec<(String, f64)>,
    rules: Vec<Rule>,
    ask_when: Vec<String>,
    default_label: String,
}

fn int_of(t: &defaults::V, k: &str) -> u64 {
    t.get(k).and_then(defaults::V::as_integer).map_or(0, |n| n.max(0) as u64)
}

fn strings_of(t: &defaults::V, k: &str) -> Vec<String> {
    t.get(k).and_then(defaults::V::as_array).map(|a| a.iter().filter_map(defaults::V::as_str).map(str::to_string).collect()).unwrap_or_default()
}

fn word(k: &str) -> &'static str {
    defaults::raw("evidence.words").str_field(k)
}

impl Cfg {
    fn load(id: &str) -> Option<Cfg> {
        let t = *defaults::raw("evidence.cfg").get(id)?;
        let s = |k: &str| t.str_field(k).to_string();
        let required = strings_of(&t, "required")
            .iter()
            .filter_map(|r| {
                let (name, min) = r.rsplit_once(':')?;
                Some((name.trim().to_string(), min.trim().parse::<f64>().ok()?))
            })
            .collect();
        let rules = t
            .get("rules")
            .and_then(defaults::V::as_array)
            .map(|a| a.iter().map(|r| Rule { id: r.str_field("id").to_string(), when: strings_of(r, "when"), then: r.str_field("then").to_string() }).collect())
            .unwrap_or_default();
        Some(Cfg {
            id: id.to_string(),
            backend: s("backend"),
            steps: t.str_field("kind") == defaults::text("evidence.kind_steps"),
            daily_cap: int_of(&t, "daily_cap"),
            pack_cap: int_of(&t, "pack_cap") as usize,
            section_cap: int_of(&t, "section_cap") as usize,
            act: t.str_field("act_threshold").parse().unwrap_or(1.0),
            question: s("question"),
            true_label: s("true_label"),
            false_label: s("false_label"),
            true_meaning: s("true_meaning"),
            false_meaning: s("false_meaning"),
            unknown_label: s("unknown_label"),
            unknown_meaning: s("unknown_meaning"),
            step_text_cap: int_of(&t, "step_text_cap") as usize,
            sections: strings_of(&t, "sections"),
            required,
            rules,
            ask_when: strings_of(&t, "ask_when"),
            default_label: s("default_label"),
        })
    }
}

/// A fact map: a number, or a bool as 1 or 0. Anything else is ignored.
type Facts = BTreeMap<String, f64>;

fn facts_of(v: Option<&Value>) -> Facts {
    let mut out = Facts::new();
    for (k, v) in v.and_then(Value::as_object).into_iter().flatten() {
        match v {
            Value::Bool(b) => {
                out.insert(k.clone(), f64::from(u8::from(*b)));
            }
            Value::Number(n) => {
                if let Some(x) = n.as_f64() {
                    out.insert(k.clone(), x);
                }
            }
            _ => {}
        }
    }
    out
}

/// One condition of a rule or an `ask_when` group against the facts.
fn holds(cond: &str, facts: &Facts) -> bool {
    let c = cond.trim();
    if let Some(name) = c.strip_prefix('!') {
        return facts.get(name.trim()).is_none_or(|v| *v == 0.0);
    }
    let Some(at) = c.find(['<', '>', '=']) else { return facts.get(c).is_some_and(|v| *v != 0.0) };
    let (name, rest) = c.split_at(at);
    let op_len = rest.chars().take_while(|ch| matches!(ch, '<' | '>' | '=')).count();
    let (op, num) = rest.split_at(op_len);
    let (Some(have), Ok(want)) = (facts.get(name.trim()), num.trim().parse::<f64>()) else { return false };
    match op {
        ">=" => *have >= want,
        "<=" => *have <= want,
        "==" => (*have - want).abs() < f64::EPSILON,
        ">" => *have > want,
        "<" => *have < want,
        _ => false,
    }
}

fn all_hold(conds: &[String], facts: &Facts) -> bool {
    conds.iter().all(|c| holds(c, facts))
}

/// The result of the gate before any model is asked.
#[derive(Debug, Clone, PartialEq)]
enum Gate {
    /// A rule says do not ask and keep the baseline.
    Skip(String),
    /// A rule decided the label.
    Label { rule: String, label: String },
    /// A rule picked a plan step.
    Step { rule: String, n: i64 },
    /// A required fact is below its minimum: the names of the missing items.
    Insufficient(Vec<String>),
    /// `ask_when` found no candidate: the default label stands.
    NoCandidate(String),
    /// Ask the model.
    Ask,
}

/// What the plan input of a steps pack yields: the steps, the facts and the hints the rules pick a step from.
#[derive(Debug, Default)]
struct Derived {
    steps: Vec<(i64, String, String)>,
    summary: String,
    earlier: Vec<(String, Option<i64>)>,
    doing_n: Option<i64>,
    overlap_n: Option<i64>,
}

fn tokens(s: &str) -> BTreeSet<String> {
    let min = defaults::num("evidence.token_min_len") as usize;
    s.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= min).map(str::to_lowercase).collect()
}

/// The facts and hints of a steps pack, from its `plan` input.
fn derive(plan: &Value, facts: &mut Facts) -> Derived {
    let mut d = Derived::default();
    for s in plan.get("steps").and_then(Value::as_array).into_iter().flatten() {
        if let Some(n) = s.get("n").and_then(Value::as_i64) {
            let text = |k: &str| s.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            d.steps.push((n, text("text"), text("status")));
        }
    }
    d.summary = plan.get("summary").and_then(Value::as_str).unwrap_or("").to_string();
    for e in plan.get("earlier").and_then(Value::as_array).into_iter().flatten() {
        d.earlier.push((e.get("text").and_then(Value::as_str).unwrap_or("").to_string(), e.get("step").and_then(Value::as_i64)));
    }
    let doing_word = defaults::text("evidence.stepmap_doing_status");
    let doing: Vec<i64> = d.steps.iter().filter(|(_, _, st)| st == doing_word).map(|(n, _, _)| *n).collect();
    d.doing_n = (doing.len() == 1).then(|| doing[0]);
    let sum_tokens = tokens(&d.summary);
    let seq = defaults::list("evidence.stepmap_sequence_words");
    let mut best = (0.0f64, None);
    for (n, text, _) in &d.steps {
        let st = tokens(text);
        if st.is_empty() {
            continue;
        }
        let ov = st.intersection(&sum_tokens).count() as f64 / st.len() as f64;
        if ov > best.0 {
            best = (ov, Some(*n));
        }
    }
    d.overlap_n = best.1;
    facts.insert("steps".into(), d.steps.len() as f64);
    facts.insert("summary_chars".into(), d.summary.chars().count() as f64);
    facts.insert("earlier_with_step".into(), d.earlier.iter().filter(|(_, s)| s.is_some()).count() as f64);
    facts.insert("doing_count".into(), doing.len() as f64);
    facts.insert("has_sequence_word".into(), f64::from(u8::from(seq.iter().any(|w| sum_tokens.contains(*w)))));
    facts.insert("best_overlap".into(), best.0);
    d
}

fn gate(cfg: &Cfg, facts: &Facts, derived: &Derived) -> Gate {
    for r in &cfg.rules {
        if r.when.is_empty() || !all_hold(&r.when, facts) {
            continue;
        }
        match r.then.as_str() {
            "skip" => return Gate::Skip(r.id.clone()),
            "doing_step" => {
                if let Some(n) = derived.doing_n {
                    return Gate::Step { rule: r.id.clone(), n };
                }
            }
            "overlap_step" => {
                if let Some(n) = derived.overlap_n {
                    return Gate::Step { rule: r.id.clone(), n };
                }
            }
            other => {
                if let Some(label) = other.strip_prefix("label:") {
                    return Gate::Label { rule: r.id.clone(), label: label.to_string() };
                }
            }
        }
    }
    let missing: Vec<String> =
        cfg.required.iter().filter(|(name, min)| facts.get(name).copied().unwrap_or(0.0) < *min).map(|(n, m)| format!("{n}:{m}")).collect();
    if !missing.is_empty() {
        return Gate::Insufficient(missing);
    }
    if !cfg.ask_when.is_empty() {
        let any = cfg.ask_when.iter().any(|g| g.split('&').all(|c| holds(c, facts)));
        if !any {
            return Gate::NoCandidate(cfg.default_label.clone());
        }
    }
    Gate::Ask
}

/// The labelled evidence pack text and the ids of the lines it carries.
fn render(cfg: &Cfg, facts: &Facts, sections: &[(String, Vec<String>)]) -> (String, Vec<String>) {
    let mut out = String::from(defaults::text("evidence.heading_facts"));
    for (k, v) in facts {
        let shown = if v.fract() == 0.0 { format!("{}", *v as i64) } else { format!("{v}") };
        out.push_str(&defaults::render("evidence.fact_line", &[("name", k), ("value", &shown)]));
        out.push('\n');
    }
    let mut ids = Vec::new();
    for name in &cfg.sections {
        let Some((_, lines)) = sections.iter().find(|(n, _)| n == name) else { continue };
        // the most recent lines are kept when a section is over its cap: they are last in the input
        let mut kept: Vec<(usize, String)> = Vec::new();
        let mut used = 0usize;
        for (i, l) in lines.iter().enumerate().rev() {
            let line = defaults::render("evidence.line_id", &[("section", name), ("i", &(i + 1))]) + " " + l;
            let len = line.chars().count() + 1;
            if used + len > cfg.section_cap && !kept.is_empty() {
                break;
            }
            used += len;
            kept.push((i + 1, slice16_lossy(&line, cfg.section_cap)));
        }
        if kept.is_empty() {
            continue;
        }
        out.push_str(&defaults::render("evidence.heading_section", &[("section", name)]));
        for (i, line) in kept.into_iter().rev() {
            ids.push(defaults::render("evidence.line_id", &[("section", name), ("i", &i)]));
            out.push_str(&line);
            out.push('\n');
        }
    }
    let out = slice16_lossy(&out, cfg.pack_cap);
    ids.retain(|id| out.contains(id.as_str()));
    (out, ids)
}

/// An id or a reference reduced to the characters that identify a line, so `[tool_calls.3]` and `tool_calls.3` compare equal.
fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric() || matches!(c, '_' | '.')).collect()
}

/// The question the model is asked, with the caller's duration filled in.
fn question_of(cfg: &Cfg, dur: &str, step_labels: &[(i64, String)]) -> Question {
    let text = cfg.question.replace(defaults::text("evidence.dur_placeholder"), dur);
    if cfg.steps {
        let mut opts: Vec<(String, String)> = step_labels.iter().map(|(n, t)| (n.to_string(), slice16_lossy(t, cfg.step_text_cap))).collect();
        opts.push((cfg.unknown_label.clone(), cfg.unknown_meaning.clone()));
        Question::choice(&text, opts)
    } else {
        Question::noul(&text, &cfg.true_meaning, &cfg.false_meaning)
    }
}

/// What the gate did with one decision.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    /// `rule`, `skipped` or `asked`.
    pub phase: String,
    /// Who answered: `jev`, `haiku`, `rule` or `none`.
    pub source: String,
    /// Why nothing was asked or answered.
    pub reason: Option<String>,
    /// The rule that decided, or that told the gate not to ask.
    pub rule: Option<String>,
    /// The answer as a label (a configured word, or a step number).
    pub label: Option<String>,
    /// The answer's confidence, when a model gave one.
    pub confidence: Option<f64>,
    /// Whether the answer may be acted on: the integration is `on` and a rule decided or the confidence met the threshold.
    pub actionable: bool,
    /// The evidence line a Haiku answer cited.
    pub evidence_ref: Option<String>,
    /// The facts that were present (non-zero).
    pub present: Vec<String>,
    /// The required items that were missing, as `fact:minimum`.
    pub missing: Vec<String>,
    /// Milliseconds the model call took (0 when none was made).
    pub ms: u64,
}

impl Outcome {
    fn new(phase: &str, source: &str) -> Outcome {
        Outcome {
            phase: phase.into(),
            source: source.into(),
            reason: None,
            rule: None,
            label: None,
            confidence: None,
            actionable: false,
            evidence_ref: None,
            present: Vec::new(),
            missing: Vec::new(),
            ms: 0,
        }
    }

    /// The outcome as the JSON the command prints and the log row holds.
    pub fn to_json(&self, id: &str) -> Value {
        json!({
            "integration": id, "phase": self.phase, "source": self.source, "reason": self.reason, "rule": self.rule, "label": self.label,
            "confidence": self.confidence, "actionable": self.actionable, "evidenceRef": self.evidence_ref,
            "present": self.present, "missing": self.missing, "ms": self.ms,
        })
    }
}

fn append_row(home: &Path, text: &str) {
    let rel = defaults::text("evidence.log");
    if rel.is_empty() {
        return;
    }
    let path = home.join(defaults::text("paths.base_dir")).join(rel);
    let write = || -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let mut f = if size + text.len() as u64 > defaults::num("evidence.log_max_bytes") {
            std::fs::File::create(&path)?
        } else {
            std::fs::OpenOptions::new().create(true).append(true).open(&path)?
        };
        f.write_all(text.as_bytes())
    };
    crate::discard::logged("evidence_log_write", write());
}

fn log(home: &Path, id: &str, o: &Outcome, child: Option<&str>) {
    let mut row = o.to_json(id);
    if let Some(m) = row.as_object_mut() {
        m.insert("ts".into(), json!(iso_ms(now_ms() as u64)));
        m.insert("child".into(), json!(child));
    }
    append_row(home, &format!("{row}\n"));
}

/// Direct Haiku calls an integration made today (UTC), counted from the evidence log.
fn haiku_calls_today(home: &Path, id: &str) -> u64 {
    let path = home.join(defaults::text("paths.base_dir")).join(defaults::text("evidence.log"));
    let today = iso_ms(now_ms() as u64).chars().take(defaults::num("evidence.date_chars") as usize).collect::<String>();
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|r| {
            r["integration"] == id
                && r["phase"] == word("phase_asked")
                && r["source"] == word("source_haiku")
                && r["ts"].as_str().is_some_and(|t| t.starts_with(&today))
        })
        .count() as u64
}

fn label_of(cfg: &Cfg, a: &Answer) -> Option<String> {
    match a {
        Answer::Bool(b) => Some(if *b { cfg.true_label.clone() } else { cfg.false_label.clone() }),
        Answer::Label(l) => Some(l.clone()),
    }
}

/// A Haiku reply as (answer, confidence, evidence ref).
fn parse_haiku(q: &Question, text: &str) -> Option<(Answer, f64, String)> {
    let v = cli::parse_loose(text)?;
    let conf = v.get(defaults::text("evidence.confidence_key")).and_then(Value::as_f64).filter(|c| (0.0..=1.0).contains(c))?;
    let r = v.get(defaults::text("evidence.ref_key")).and_then(Value::as_str)?.to_string();
    let raw = v.get(defaults::text("evidence.answer_key"))?;
    let a = match q.kind {
        Kind::Noul => match raw {
            Value::Bool(b) => Answer::Bool(*b),
            Value::String(s) if s.trim().eq_ignore_ascii_case("true") => Answer::Bool(true),
            Value::String(s) if s.trim().eq_ignore_ascii_case("false") => Answer::Bool(false),
            _ => return None,
        },
        Kind::Choice => {
            let l = raw.as_str().map(str::to_string).or_else(|| raw.as_i64().map(|n| n.to_string()))?;
            q.criteria.iter().any(|(k, _)| *k == l).then_some(Answer::Label(l))?
        }
    };
    Some((a, conf, r))
}

/// Ask Haiku directly with the labelled pack; the answer must cite a line that is in the pack.
fn ask_haiku(home: &Path, cfg: &Cfg, q: &Question, pack: &str, ids: &[String], o: &mut Outcome, env: &Env) {
    let w = word("reason_no_answer");
    let st = Settings { home: home.to_string_lossy().into_owned(), env: cli::process_env() };
    let model = settings::model(&st);
    let mut input = String::from(defaults::text("evidence.heading_question"));
    input.push_str(&q.instructions);
    input.push_str(defaults::text("evidence.heading_options"));
    for (label, meaning) in &q.criteria {
        input.push_str(&format!("{label}: {meaning}\n"));
    }
    input.push_str(defaults::text("evidence.heading_evidence"));
    input.push_str(&super::scrub::scrub_secrets(pack));
    let _ = env;
    let res = cascade::call_model(&cli::CliCall {
        system: defaults::text("evidence.system_prompt"),
        model: &model,
        input: &input,
        env: &st.env,
        timeout: Duration::from_millis(defaults::num("evidence.timeout_ms")),
    });
    o.ms = res.ms;
    let verdict = match &res.result {
        Err(e) => Err(e.word().to_string()),
        Ok(t) => parse_haiku(q, t).ok_or_else(|| w.to_string()),
    };
    let mut row =
        telemetry::Row { integration: &cfg.id, backend: defaults::text("judge.backend_haiku_cli"), model: Some(&model), ms: res.ms, ..Default::default() };
    match verdict {
        Err(reason) => {
            row.error = Some(&reason);
            telemetry::record(home, &row);
            o.reason = Some(reason);
        }
        Ok((a, conf, r)) => {
            let label = label_of(cfg, &a);
            row.confidence = Some(conf.to_string());
            row.decision = label.as_deref();
            telemetry::record(home, &row);
            if !ids.iter().any(|id| norm(id) == norm(&r)) {
                o.reason = Some(word("reason_bad_ref").to_string());
                return;
            }
            o.label = label;
            o.confidence = Some(conf);
            o.evidence_ref = Some(r);
        }
    }
}

/// Ask Jev through the shared layer (its own cascade may escalate to the model for a caller that may wait).
fn ask_jev(home: &Path, env: &Env, cfg: &Cfg, q: Question, pack: &str, blocking: bool, o: &mut Outcome) {
    let mut req = AskRequest::new(&cfg.id, q, pack, Trust::Advisory, Value::Null);
    req.env = Some(env.clone());
    req.wait_for_escalation = !blocking;
    let Some(lane) = super::shared::lane(home, env) else {
        o.reason = Some(word("reason_no_answer").to_string());
        return;
    };
    let d = lane.ask(&req);
    o.ms = d.ms;
    let answer = match &d.jev {
        Value::Bool(b) => Some(Answer::Bool(*b)),
        Value::String(s) => Some(Answer::Label(s.clone())),
        Value::Number(n) => Some(Answer::Label(n.to_string())),
        _ => None,
    };
    match (answer, d.confidence) {
        (Some(a), Some(c)) => {
            o.label = label_of(cfg, &a);
            o.confidence = Some(c);
        }
        _ => o.reason = Some(d.reason.map_or_else(|| word("reason_no_answer").to_string(), |r| r.to_string())),
    }
}

/// Decide one request: `{id, facts, sections, dur, blocking, child, plan}`. Never fails; the worst outcome is a skip.
pub fn evaluate(home: &Path, env: &Env, req: &Value) -> Outcome {
    let skipped = |reason: &str| {
        let mut o = Outcome::new(word("phase_skipped"), word("source_none"));
        o.reason = Some(reason.to_string());
        o
    };
    let id = req.get("id").and_then(Value::as_str).unwrap_or("");
    let Some(cfg) = Cfg::load(id) else { return skipped(word("reason_unknown_integration")) };
    let mode = super::shared::mode_of(home, env, id);
    if mode == Mode::Off {
        return skipped(word("reason_off")); // an off integration is not looked at and writes no row
    }
    let child = req.get("child").and_then(Value::as_str);
    let mut facts = facts_of(req.get("facts"));
    let derived = match req.get("plan") {
        Some(p) if cfg.steps => derive(p, &mut facts),
        _ => Derived::default(),
    };
    let mut sections: Vec<(String, Vec<String>)> = Vec::new();
    for (k, v) in req.get("sections").and_then(Value::as_object).into_iter().flatten() {
        let lines = match v {
            Value::Array(a) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            Value::String(s) => s.lines().map(str::to_string).collect(),
            _ => Vec::new(),
        };
        sections.push((k.clone(), lines));
    }
    if cfg.steps {
        let plan_line = |n: &i64, t: &str, s: &str| defaults::render("evidence.plan_line", &[("n", n), ("status", &s), ("text", &t)]);
        sections.push(("plan".into(), derived.steps.iter().map(|(n, t, s)| plan_line(n, t, s)).collect()));
        sections.push(("summary".into(), vec![derived.summary.clone()]));
        let un = defaults::text("evidence.unreported");
        sections.push((
            "earlier".into(),
            derived
                .earlier
                .iter()
                .map(|(t, s)| defaults::render("evidence.earlier_line", &[("step", &s.map_or_else(|| un.to_string(), |n| n.to_string())), ("text", t)]))
                .collect(),
        ));
    }
    let present: Vec<String> = facts.iter().filter(|(_, v)| **v != 0.0).map(|(k, _)| k.clone()).collect();
    let mut o = match gate(&cfg, &facts, &derived) {
        Gate::Skip(rule) => {
            let mut o = skipped(word("reason_rule_skip"));
            o.rule = Some(rule);
            o
        }
        Gate::Label { rule, label } => {
            let mut o = Outcome::new(word("phase_rule"), word("source_rule"));
            (o.rule, o.label, o.actionable) = (Some(rule), Some(label), mode == Mode::On);
            o
        }
        Gate::Step { rule, n } => {
            let mut o = Outcome::new(word("phase_rule"), word("source_rule"));
            (o.rule, o.label, o.actionable) = (Some(rule), Some(n.to_string()), mode == Mode::On);
            o
        }
        Gate::Insufficient(missing) => {
            let mut o = skipped(word("reason_insufficient"));
            o.missing = missing;
            o
        }
        Gate::NoCandidate(label) => {
            let mut o = Outcome::new(word("phase_rule"), word("source_rule"));
            o.reason = Some(word("reason_no_candidate").to_string());
            (o.label, o.actionable) = (Some(label).filter(|l| !l.is_empty()), mode == Mode::On);
            o
        }
        Gate::Ask => ask(home, env, &cfg, req, &facts, &sections, &derived, mode),
    };
    o.present = present;
    log(home, id, &o, child);
    o
}

#[allow(clippy::too_many_arguments)]
fn ask(home: &Path, env: &Env, cfg: &Cfg, req: &Value, _facts: &Facts, sections: &[(String, Vec<String>)], derived: &Derived, mode: Mode) -> Outcome {
    let mut o = Outcome::new(word("phase_asked"), word("source_none"));
    let dur = req.get("dur").and_then(Value::as_str).unwrap_or("");
    let step_labels: Vec<(i64, String)> = derived.steps.iter().map(|(n, t, _)| (*n, t.clone())).collect();
    let q = question_of(cfg, dur, &step_labels);
    let (pack, ids) = render(cfg, _facts, sections);
    let haiku = cfg.backend == word("tag_haiku");
    if haiku {
        if haiku_calls_today(home, &cfg.id) >= cfg.daily_cap {
            o.phase = word("phase_skipped").into();
            o.reason = Some(word("reason_daily_cap").into());
            return o;
        }
        o.source = word("source_haiku").into();
        ask_haiku(home, cfg, &q, &pack, &ids, &mut o, env);
    } else {
        o.source = word("source_jev").into();
        ask_jev(home, env, cfg, q, &pack, req.get("blocking").and_then(Value::as_bool).unwrap_or(false), &mut o);
    }
    if let (Some(c), Some(l)) = (o.confidence, o.label.as_deref()) {
        let usable = !cfg.steps || l != cfg.unknown_label;
        if c < cfg.act {
            o.reason = Some(word("reason_low_confidence").into());
        } else if mode == Mode::On && usable {
            o.actionable = true;
        } else if mode != Mode::On {
            o.reason = Some(word("reason_shadow").into());
        }
    }
    o
}

/// `ah-engine jev evidence`: one request per stdin line, one outcome per stdout line.
pub fn run(home: &Path, input: &str) -> i32 {
    let env = Env::process();
    let mut bad = false;
    for line in input.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<Value>(line) {
            Ok(req) => {
                let id = req.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                println!("{}", evaluate(home, &env, &req).to_json(&id));
            }
            Err(_) => {
                bad = true;
                eprintln!("{}", defaults::text("evidence.usage"));
            }
        }
    }
    i32::from(bad) * 64
}

#[cfg(test)]
mod tests;
