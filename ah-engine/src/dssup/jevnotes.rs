//! The two Jev recommendations on a child's `off-scope` straying warning: `devswarmOnBrief` (is the work outside the scope off the
//! brief) and `devswarmExtraSanctioned` (did the user ask for it). Node's `jevAdjust` in `companion/lib/devswarm-supervision-jev.js`.
//!
//! A question is asked only when its precondition holds (an `off-scope` signal), detached from the sweep, and only once per input
//! hash per `devswarm.supervisorBlockerLabelReaskSec`; the NEXT sweep reads the answer from the shared cache. A cached answer is
//! counted once per hash in the supervision metrics (`jev`: agree / disagree with the deterministic result). In mode `on`, an
//! answer that clears its threshold becomes a note on the signal (`{integration, verdict, confidence, supports}`); otherwise (off,
//! shadow, no answer yet, low confidence) the signal stands unchanged. Jev never suppresses a warning, never blocks, never kills.
//! Inputs are capped and secret-scrubbed. Mode `off` asks nothing and writes no Jev decision row; the trigger is still counted (`seen`, then
//! `skipped`), as Node counts it.
//!
//! The per-plan state is `devswarm/supervision-jev/<key>.json`. Every failure is open: a note that cannot be decided is no note.
// Discard triage (E3): every `.ok()` / `harmless` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file (transcript, state) is the absent one (Node: `try { ... } catch (_) { return [] }`)
// - the Jev state is best-effort bookkeeping (Node: "best-effort")
use super::tail::{current_step, log_event, read_obj, reask_ms, transcript_of, write_json};
use super::tick::Ctx;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::num::to_js_string;
use crate::defaults::{self, V};
use crate::dsact::runner::{RunSpec, Runner};
use crate::jev::assist::content_hash;
use crate::jev::cache::{FileCache, JevCache};
use crate::jev::client::Answer;
use crate::jev::settings::{Env as JevEnv, JevSettings, Mode};
use crate::jev::{AskRequest, Question, Trust};
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

/// A recommendation attached to a signal.
#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    /// The integration that decided it.
    pub integration: String,
    /// What it says.
    pub verdict: String,
    /// Its confidence, rounded to two places.
    pub confidence: f64,
    /// Whether Jev agrees the warning is real.
    pub supports: bool,
}

impl Note {
    /// The note as the stray state keeps it.
    pub fn to_oval(&self) -> OVal {
        OVal::Obj(vec![
            ("integration".into(), OVal::Str(self.integration.clone())),
            ("verdict".into(), OVal::Str(self.verdict.clone())),
            ("confidence".into(), OVal::Num(self.confidence)),
            ("supports".into(), OVal::Bool(self.supports)),
        ])
    }
}

/// One question about an off-scope signal.
pub(super) struct Spec {
    table: &'static V,
    /// The text the question shows (before scrubbing and capping).
    pub state: String,
}

impl Spec {
    fn id(&self) -> &'static str {
        self.table.str_field("id")
    }
    fn word(&self, k: &str) -> &'static str {
        self.table.str_field(k)
    }
    fn int(&self, k: &str) -> i64 {
        self.table.get(k).and_then(V::as_integer).unwrap_or(0)
    }
    /// The scrubbed, capped text Jev is asked about.
    pub fn text(&self) -> String {
        cap(&crate::jev::scrub::scrub_secrets(&self.state), self.int("cap").max(1) as usize)
    }
    /// The cache and dedupe key of the question for one plan.
    pub fn cache_key(&self, key: &str) -> String {
        format!("{key}\u{1}{}\u{1}{}", self.id(), self.text())
    }
    /// The content hash the answer is cached under.
    pub fn hash(&self, key: &str) -> String {
        content_hash(&[self.id(), defaults::text("jev.question_version"), &self.cache_key(key)])
    }
}

/// `cap(s, n)`: `s` cut to `n` UTF-16 units, the last one an ellipsis.
fn cap(s: &str, n: usize) -> String {
    if s.encode_utf16().count() <= n {
        return s.to_string();
    }
    let mut out = crate::checks::jsport::text::slice16_lossy(s, n.saturating_sub(1));
    out.push_str(defaults::text("devswarm_sup.jv_ellipsis"));
    out
}

fn fill(t: &str, args: &[(&str, &str)]) -> String {
    crate::checks::devswarm_role::text::fill_once(t, args)
}

/// `gitRecent(wt)`: the subjects of the last commits (`devswarm_sup.jv_commits_max` of them); empty on any failure.
fn recent_subjects(runner: &dyn Runner, wt: &str) -> Vec<String> {
    if wt.is_empty() {
        return Vec::new();
    }
    let spec = RunSpec {
        bin: Some(defaults::text("devswarm_sup.jv_git_bin").to_string()),
        args: defaults::list("devswarm_sup.jv_git_args").iter().map(|a| a.replace("{wt}", wt)).collect(),
        timeout_ms: defaults::num("devswarm_sup.jv_git_timeout_ms"),
        ..RunSpec::default()
    };
    let r = runner.run(&spec);
    if !r.ok || r.status != Some(0) || r.stdout.is_empty() {
        return Vec::new();
    }
    r.stdout
        .split(defaults::text("devswarm_sup.jv_git_mark"))
        .skip(1)
        .take(defaults::num("devswarm_sup.jv_commits_max") as usize)
        .map(|block| block.split('\n').next().unwrap_or_default().to_string())
        .collect()
}

/// `recentUserPrompts(home, d)`: the child's last user-typed prompts (the end of its own transcript, a bounded read), scrubbed.
fn recent_prompts(ctx: &Ctx, wt: &str, session: &str) -> Vec<String> {
    let Some(file) = transcript_of(ctx.home, wt, session) else { return Vec::new() };
    let Ok(mut f) = std::fs::File::open(&file) else { return Vec::new() };
    let Ok(size) = f.metadata().map(|m| m.len()) else { return Vec::new() };
    let len = size.min(defaults::num("devswarm_sup.jv_prompts_read_max"));
    let mut buf = vec![0u8; len as usize];
    if f.seek(SeekFrom::Start(size - len)).is_err() || f.read_exact(&mut buf).is_err() {
        return Vec::new();
    }
    let skip = crate::checks::guardkit::jsre::compile(defaults::text("devswarm_sup.jv_prompt_skip_re"), false);
    let marker = defaults::text("devswarm_sup.jv_prompt_marker");
    let mut prompts: Vec<String> = Vec::new();
    for line in String::from_utf8_lossy(&buf).split('\n') {
        if !line.contains(marker) {
            continue;
        }
        let Ok(j) = serde_json::from_str::<Value>(line) else { continue };
        if j.get("type").and_then(Value::as_str) != Some("user") || j.get("isMeta").is_some_and(|m| m.as_bool() != Some(false) && !m.is_null()) {
            continue;
        }
        let Some(m) = j.get("message").filter(|m| !m.is_null()) else { continue };
        let text = match m.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(a)) if a.iter().all(|x| x.get("type").and_then(Value::as_str) == Some("text")) => {
                a.iter().map(|x| x.get("text").and_then(Value::as_str).unwrap_or_default()).collect::<Vec<_>>().join("\n")
            }
            _ => String::new(),
        };
        if !text.is_empty() && !skip.is_match(crate::jev::js_trim(&text)) {
            prompts.push(text);
        }
    }
    let keep = defaults::num("devswarm_sup.jv_prompts_keep") as usize;
    let start = prompts.len().saturating_sub(keep);
    prompts[start..].iter().map(|t| crate::jev::scrub::scrub_secrets(&cap(t, defaults::num("devswarm_sup.jv_prompt_cap") as usize))).collect()
}

/// What a plan's Jev state remembers per question.
fn state_path(ctx: &Ctx, key: &str) -> PathBuf {
    crate::meshw::idlock::devswarm_root(ctx.home)
        .join(defaults::text("devswarm_sup.jv_state_dir"))
        .join(format!("{key}{}", defaults::text("mesh_write.json_suffix")))
}

/// What a plan's Jev state remembers about one question.
#[derive(Default, Clone)]
struct IState {
    hash: Option<String>,
    asked_at: f64,
    resolved: Option<String>,
    /// The trigger marks already counted, oldest first.
    trig_seen: Vec<String>,
}

impl IState {
    fn from_oval(v: Option<&OVal>) -> IState {
        let Some(v @ OVal::Obj(_)) = v else { return IState::default() };
        let text = |k: &str| match v.get(k) {
            Some(OVal::Str(s)) => Some(s.clone()),
            _ => None,
        };
        let trig_seen = match v.get("trigSeen") {
            Some(OVal::Obj(o)) => o.iter().map(|(k, _)| k.clone()).collect(),
            _ => Vec::new(),
        };
        IState {
            hash: text("hash"),
            asked_at: match v.get("askedAt") {
                Some(OVal::Num(x)) if x.is_finite() => *x,
                _ => 0.0,
            },
            resolved: text("resolved"),
            trig_seen,
        }
    }

    fn to_oval(&self) -> OVal {
        let mut o = Vec::new();
        if let Some(r) = &self.resolved {
            o.push(("resolved".to_string(), OVal::Str(r.clone())));
        }
        if let Some(h) = &self.hash {
            o.push(("hash".to_string(), OVal::Str(h.clone())));
            o.push(("askedAt".to_string(), OVal::Num(self.asked_at)));
        }
        if !self.trig_seen.is_empty() {
            o.push(("trigSeen".to_string(), OVal::Obj(self.trig_seen.iter().map(|m| (m.clone(), OVal::Num(1.0))).collect())));
        }
        OVal::Obj(o)
    }
}

/// One pass's view of one plan: the Jev settings, the stored state, and whether it changed.
struct Cx<'a> {
    ctx: &'a Ctx<'a>,
    settings: &'a JevSettings,
    env: JevEnv,
    d_id: &'a str,
    key: &'a str,
    state: Vec<(String, IState)>,
    dirty: bool,
}

/// A question's cached answer, or that it is pending.
struct Res {
    mode: Mode,
    pending: bool,
    answer: Option<bool>,
    confidence: f64,
    threshold: f64,
}

impl Cx<'_> {
    fn record(&self, typ: &str, fields: Vec<(&str, OVal)>) {
        let mut f = vec![("id", OVal::Str(self.d_id.to_string())), ("key", OVal::Str(self.key.to_string()))];
        f.extend(fields);
        log_event(self.ctx, typ, f);
    }

    fn st(&mut self, id: &str) -> &mut IState {
        let i = match self.state.iter().position(|(k, _)| k == id) {
            Some(i) => i,
            None => {
                self.state.push((id.to_string(), IState::default()));
                self.state.len() - 1
            }
        };
        &mut self.state[i].1
    }

    /// `consult(c, spec)`: the question's answer from the cache, asking detached when it has not been asked in the re-ask window.
    fn consult(&mut self, spec: &Spec) -> Option<Res> {
        let id = spec.id();
        let mode = self.settings.mode(id, false);
        if mode == Mode::Off {
            return None; // relax-block over a blocking baseline: only an `off` mode (or Jev disabled) skips
        }
        let threshold = self.settings.assist_threshold;
        let hash = spec.hash(self.key);
        if let Some(h) = FileCache::for_home(self.ctx.home).get(&hash) {
            let answer = match h.answer {
                Answer::Bool(b) => Some(b),
                Answer::Label(_) => None,
            };
            if self.st(id).resolved.as_deref() != Some(hash.as_str()) {
                self.st(id).resolved = Some(hash.clone());
                self.dirty = true;
                let fields = vec![
                    ("integration", OVal::Str(id.to_string())),
                    ("mode", OVal::Str(mode.as_str().to_string())),
                    ("agree", OVal::Bool(answer == Some(true))),
                    ("confidence", OVal::Num(h.confidence)),
                ];
                self.record(defaults::text("devswarm_sup.jv_ev_answer"), fields);
            }
            return Some(Res { mode, pending: false, answer, confidence: h.confidence, threshold });
        }
        let (now, window) = (self.ctx.now as f64, reask_ms(self.ctx));
        let st = self.st(id).clone();
        if st.hash.as_deref() == Some(hash.as_str()) && now - st.asked_at < window {
            return Some(Res { mode, pending: true, answer: None, confidence: 0.0, threshold });
        }
        let question = Question::noul(spec.word("instructions"), spec.word("when_true"), spec.word("when_false"));
        let mut req = AskRequest::new(id, question, &spec.text(), Trust::RelaxBlock, json!(true));
        req.cache_key = Some(spec.cache_key(self.key));
        crate::jev::shared::ask_detached(self.ctx.home, &self.env, req);
        let st = self.st(id);
        st.hash = Some(hash);
        st.asked_at = now;
        self.dirty = true;
        Some(Res { mode, pending: true, answer: None, confidence: 0.0, threshold })
    }

    /// `trigger(c, id, tkey, outcome, reason)`: one `jev-trigger` event per distinct (integration, outcome, trigger key).
    fn trigger(&mut self, id: &str, tkey: &str, outcome: &str, reason: Option<&str>) {
        let mark = format!("{outcome}:{tkey}");
        let keep = defaults::num("devswarm_sup.jv_trig_keep") as usize;
        let st = self.st(id);
        if st.trig_seen.contains(&mark) {
            return;
        }
        if st.trig_seen.len() >= keep {
            st.trig_seen.remove(0);
        }
        st.trig_seen.push(mark);
        self.dirty = true;
        let mut fields = vec![("integration", OVal::Str(id.to_string())), ("outcome", OVal::Str(outcome.to_string()))];
        if let Some(r) = reason {
            fields.push(("reason", OVal::Str(r.to_string())));
        }
        self.record(defaults::text("devswarm_sup.jv_ev_trigger"), fields);
    }
}

fn effective(r: &Option<Res>, threshold: f64) -> Option<(bool, f64)> {
    let r = r.as_ref()?;
    let answer = r.answer?;
    (r.mode == Mode::On && !r.pending && r.confidence >= threshold).then_some((answer, r.confidence))
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// The questions an off-scope signal raises: the plan's step, scope, summaries and recent commits for the brief, the user's prompts
/// for the sanction.
pub(super) fn specs(ctx: &Ctx, runner: &dyn Runner, plan: &Value, wt: &str, session: &str, files: &[String]) -> Option<[Spec; 2]> {
    let cur = current_step(plan)?;
    let steps = plan.get("steps")?.as_array()?;
    let done = steps.iter().filter(|s| s.get("status").and_then(Value::as_str) == Some(defaults::text("devswarm_sup.tl_step_done"))).count();
    let js = |v: Option<&Value>| match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => to_js_string(n.as_f64().unwrap_or(f64::NAN)),
        _ => "undefined".to_string(),
    };
    let blocked = if cur.get("status").and_then(Value::as_str) == Some("blocked") { defaults::text("devswarm_sup.jv_blocked") } else { "" };
    let step = fill(
        defaults::text("devswarm_sup.jv_step_line"),
        &[("n", &js(cur.get("n"))), ("done", &done.to_string()), ("total", &steps.len().to_string()), ("text", &js(cur.get("text"))), ("blocked", blocked)],
    );
    let [list_key, text_key] = [defaults::list("devswarm_sup.jv_summaries_key")[0], defaults::list("devswarm_sup.jv_summaries_key")[1]];
    let item_sep = defaults::text("devswarm_sup.jv_join_item");
    let list_sep = defaults::text("devswarm_sup.jv_join_list");
    let summaries: Vec<String> = plan
        .get(list_key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|s| s.get(text_key).and_then(Value::as_str)).filter(|t| !t.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    let scope: Vec<&str> = plan
        .get(defaults::text("devswarm_sup.jv_scope_key"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let shown: Vec<&str> = files.iter().take(defaults::num("devswarm_sup.jv_files_shown") as usize).map(String::as_str).collect();
    let files_text = shown.join(list_sep);
    let commits = recent_subjects(runner, wt).join(item_sep);
    let prompts = recent_prompts(ctx, wt, session).join(item_sep);
    let brief = defaults::raw("devswarm_sup.jv_on_brief");
    let extra = defaults::raw("devswarm_sup.jv_extra");
    Some([
        Spec {
            table: brief,
            state: fill(
                brief.str_field("state"),
                &[("step", &step), ("scope", &scope.join(list_sep)), ("summaries", &summaries.join(item_sep)), ("commits", &commits), ("files", &files_text)],
            ),
        },
        Spec { table: extra, state: fill(extra.str_field("state"), &[("prompts", &prompts), ("files", &files_text)]) },
    ])
}

/// The child and the off-scope signal the questions are about.
pub struct Off<'a> {
    /// The workspace id.
    pub id: &'a str,
    /// The plan key.
    pub key: &'a str,
    /// The plan.
    pub plan: &'a Value,
    /// The worktree.
    pub wt: &'a str,
    /// The child's session id.
    pub session: &'a str,
    /// The files outside the scope.
    pub files: &'a [String],
    /// The signal's key (what a trigger is counted by).
    pub signal_key: &'a str,
}

/// `jevAdjust` for an `off-scope` signal: the notes to attach (Node: `sig.jev`). Never fails.
pub fn adjust(ctx: &Ctx, runner: &dyn Runner, settings: &JevSettings, off: &Off) -> Vec<Note> {
    let Off { id: d_id, key, plan, wt, session, files, signal_key: trigger_key } = *off;
    if !super::liveness::safe_key(key) {
        return Vec::new();
    }
    let [brief_id, extra_id] = [defaults::raw("devswarm_sup.jv_on_brief").str_field("id"), defaults::raw("devswarm_sup.jv_extra").str_field("id")];
    let Some(specs) = specs(ctx, runner, plan, wt, session, files) else { return Vec::new() };
    let stored = read_obj(&state_path(ctx, key));
    let state: Vec<(String, IState)> =
        [brief_id, extra_id].iter().map(|id| ((*id).to_string(), IState::from_oval(stored.as_ref().and_then(|o| o.get(id))))).collect();
    let env = JevEnv::from_pairs(ctx.st.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    let mut c = Cx { ctx, settings, env, d_id, key, state, dirty: false };
    let tkey = if trigger_key.is_empty() { defaults::text("devswarm_sup.jv_default_trigger") } else { trigger_key };
    c.trigger(brief_id, tkey, defaults::text("devswarm_sup.jv_outcome_seen"), None);
    c.trigger(extra_id, tkey, defaults::text("devswarm_sup.jv_outcome_seen"), None);
    let [on_brief, extra] = &specs;
    let (r_brief, r_extra) = (c.consult(on_brief), c.consult(extra));
    for (spec, r) in [(on_brief, &r_brief), (extra, &r_extra)] {
        if r.is_none() {
            c.trigger(spec.id(), tkey, defaults::text("devswarm_sup.jv_outcome_skipped"), Some(defaults::text("devswarm_sup.jv_skip_reason")));
        }
    }
    let mut notes = Vec::new();
    for (spec, r) in [(on_brief, &r_brief), (extra, &r_extra)] {
        let floor = spec.int("min_pct") as f64 / 100.0;
        let threshold = r.as_ref().map_or(1.0, |r| r.threshold).max(floor);
        if let Some((answer, conf)) = effective(r, threshold) {
            let verdict = spec.word(if answer { "note_true" } else { "note_false" });
            notes.push(Note { integration: spec.id().to_string(), verdict: verdict.to_string(), confidence: round2(conf), supports: answer });
        }
    }
    if c.dirty {
        write_json(&state_path(ctx, key), &OVal::Obj(c.state.iter().map(|(k, v)| (k.clone(), v.to_oval())).collect()));
    }
    notes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::git::util::Settings;
    use crate::dsact::runner::RunResult;
    use crate::jev::settings::Sources;

    /// A runner whose every call fails (nothing here may need git).
    struct Nothing;
    impl Runner for Nothing {
        fn run(&self, _spec: &RunSpec) -> RunResult {
            RunResult { ok: false, missing: true, ..RunResult::default() }
        }
    }

    const NOW: i64 = 1_760_000_000_000;

    struct Fix {
        _dir: crate::db::TempDir,
        home: std::path::PathBuf,
        st: Settings,
        plan: Value,
    }

    fn fix(tag: &str, settings: Option<&str>) -> Fix {
        crate::defaults::init().unwrap();
        let dir = crate::db::TempDir::new(tag);
        let home = dir.0.join("home");
        std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
        if let Some(s) = settings {
            std::fs::write(home.join(".anti-hall/settings.json"), s).unwrap();
        }
        let mut env = std::collections::HashMap::new();
        env.insert("HOME".to_string(), home.to_string_lossy().into_owned());
        env.insert("ANTIHALL_JEV".to_string(), "1".to_string());
        let st = Settings { home: home.to_string_lossy().into_owned(), env };
        let plan = json!({"id": "w1", "scope_globs": ["src/**"], "summaries": [{"text": "did a thing"}],
            "steps": [{"n": 1, "text": "first", "status": "doing", "ts": NOW - 1000}, {"n": 2, "text": "second", "status": "done"}]});
        Fix { _dir: dir, home, st, plan }
    }

    impl Fix {
        fn ctx(&self, now: i64) -> Ctx<'_> {
            Ctx { home: &self.home, root: &self.home, st: &self.st, now, engine_pokes: true }
        }
        fn settings(&self) -> JevSettings {
            JevSettings::resolve(&self.home, Sources::load(&self.home, JevEnv::from_pairs(self.st.env.iter().map(|(k, v)| (k.clone(), v.clone())))))
        }
        fn run(&self, now: i64) -> Vec<Note> {
            let ctx = self.ctx(now);
            let files = ["src/a.rs".to_string(), "docs/b.md".to_string()];
            adjust(
                &ctx,
                &Nothing,
                &self.settings(),
                &Off { id: "w1", key: "plan1", plan: &self.plan, wt: "", session: "", files: &files, signal_key: "off-scope:1:abc" },
            )
        }
        fn answer(&self, which: usize, answer: bool, confidence: f64) {
            let ctx = self.ctx(NOW);
            let s = specs(&ctx, &Nothing, &self.plan, "", "", &["src/a.rs".into(), "docs/b.md".into()]).unwrap();
            let p = self.home.join(".anti-hall/cache/jev-assist.json");
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            let mut cache: Value = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
            cache[s[which].hash("plan1")] = json!({"answer": answer, "confidence": confidence, "_seq": which + 1});
            std::fs::write(p, cache.to_string()).unwrap();
        }
        fn log(&self) -> Vec<Value> {
            std::fs::read_to_string(self.home.join(".anti-hall/logs/devswarm-supervision.ndjson"))
                .unwrap_or_default()
                .lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        }
    }

    #[test]
    fn dssup_tail_jev_notes_come_from_the_cache_in_mode_on_and_count_once() {
        let f = fix("jevnotes-on", None);
        // nothing cached yet: the questions are asked (detached), no note, the trigger is counted
        let _lane = crate::jev::testkit::install_scripted(&f.home, &[("ANTIHALL_JEV", "1")], vec![]);
        assert!(f.run(NOW).is_empty());
        let st: Value = serde_json::from_str(&std::fs::read_to_string(f.home.join(".anti-hall/devswarm/supervision-jev/plan1.json")).unwrap()).unwrap();
        assert!(st["devswarmOnBrief"]["hash"].is_string() && st["devswarmOnBrief"]["askedAt"] == NOW);
        // the answers land in the cache: on-brief says off the brief (0.95), the sanction question only reaches 0.85 (< its 0.9 floor)
        f.answer(0, true, 0.954);
        f.answer(1, true, 0.85);
        let notes = f.run(NOW + 1000);
        assert_eq!(notes, vec![Note { integration: "devswarmOnBrief".into(), verdict: "off-brief".into(), confidence: 0.95, supports: true }]);
        let rows = f.log();
        let of = |t: &str| rows.iter().filter(|r| r["type"] == t).count();
        assert_eq!((of("jev"), of("jev-trigger")), (2, 2), "{rows:?}");
        let r = rows.iter().find(|r| r["type"] == "jev" && r["integration"] == "devswarmOnBrief").unwrap();
        assert_eq!((r["mode"].as_str(), r["agree"].as_bool(), r["id"].as_str(), r["key"].as_str()), (Some("on"), Some(true), Some("w1"), Some("plan1")));
        // a repeat sweep keeps the note and counts nothing again
        assert_eq!(f.run(NOW + 2000).len(), 1);
        let rows = f.log();
        assert_eq!(rows.iter().filter(|r| r["type"] == "jev" || r["type"] == "jev-trigger").count(), 4);
        // a "no" answer reads as on-brief, supporting nothing
        f.answer(0, false, 0.97);
        let notes = f.run(NOW + 3000);
        assert_eq!((notes[0].verdict.as_str(), notes[0].supports), ("on-brief", false));
    }

    #[test]
    fn dssup_tail_jev_notes_shadow_shows_nothing_and_off_asks_nothing() {
        let f = fix("jevnotes-shadow", Some(r#"{"jevIntegrations": {"devswarmOnBrief": "shadow", "devswarmExtraSanctioned": "off"}}"#));
        f.answer(0, true, 0.99);
        assert!(f.run(NOW).is_empty(), "shadow logs, shows nothing");
        let rows = f.log();
        let skipped: Vec<&Value> = rows.iter().filter(|r| r["outcome"] == "skipped").collect();
        assert_eq!(skipped.len(), 1);
        assert_eq!((skipped[0]["integration"].as_str(), skipped[0]["reason"].as_str()), (Some("devswarmExtraSanctioned"), Some("mode-off-or-jev-disabled")));
        let st: Value = serde_json::from_str(&std::fs::read_to_string(f.home.join(".anti-hall/devswarm/supervision-jev/plan1.json")).unwrap()).unwrap();
        assert!(st["devswarmExtraSanctioned"].get("hash").is_none(), "an integration that is off is never asked");
    }
}
