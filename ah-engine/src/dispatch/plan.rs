//! The dispatch plan (D87): from the entries a payload's matcher selected to the entries that run, decided by the hook
//! configuration ([`crate::hookcfg`]) and the entries' `when` predicates.
//!
//! In order: the event's `mode` (off answers the neutral no-op; shadow makes every entry shadow), the event's `order`, then per
//! entry its `mode` (off skips it; on a guard entry with a built-in check it only turns the check off, so the Node hook decides;
//! shadow runs it without letting it change the outcome, and on a guard entry with a check it runs the check beside the Node
//! hook that decides, to log whether they agree), its `when` predicate (false skips it; unknown applies it) and the event's
//! `max_rules` cap. The event's `budget_ms` is enforced by the dispatcher while it runs the plan.
//!
//! Every entry the plan leaves out or shadows is counted, per event and entry, under one of the `hooks.outcomes` words.
use super::table::Entry;
use crate::defaults;
use crate::hookcfg::session::SessionStore;
use crate::hookcfg::when::{Ctx, Facts, LoadedFacts, NoFacts, SettingRef, Val};
use crate::hookcfg::{HookCfg, Mode};
use crate::reqenv::RequestEnv;
use serde_json::Value;
use std::time::{Duration, Instant};

/// What happened to an entry: an index into `hooks.outcomes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// It ran and its answer counts.
    Ran = 0,
    /// Its `when` predicate was false.
    SkippedPredicate = 1,
    /// The event's `max_rules` cut it.
    SkippedMaxRules = 2,
    /// The event's budget had passed before it could start.
    SkippedBudget = 3,
    /// It ran but never changes the outcome.
    Shadowed = 4,
    /// It is configured off (or only its engine check is, on a guard entry).
    Off = 5,
}

impl Outcome {
    /// The word the telemetry uses.
    pub fn word(self) -> &'static str {
        defaults::list("hooks.outcomes")[self as usize]
    }
}

/// One entry of the plan.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    /// The entry (its `check` cleared when the Node hook is to decide).
    pub entry: Entry,
    /// It runs but its answer is dropped (and, for a check, compared with the Node hook of the same id).
    pub shadow: bool,
}

/// The wall budget of one occurrence.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    start: Instant,
    limit: Option<Duration>,
}

impl Budget {
    /// A budget of `ms` milliseconds from now (0 = none).
    pub fn new(ms: u64) -> Budget {
        Budget { start: Instant::now(), limit: (ms > 0).then(|| Duration::from_millis(ms)) }
    }

    /// Time since the budget started.
    pub fn elapsed(&self) -> Duration {
        self.start.elapsed()
    }

    /// Whether the budget has passed.
    pub fn exceeded(&self) -> bool {
        self.limit.is_some_and(|l| self.start.elapsed() >= l)
    }
}

/// The plan of one occurrence of an event.
#[derive(Debug, Clone)]
pub struct Plan {
    /// The entries to run, in run and combine order.
    pub items: Vec<Item>,
    /// The entries left out and why.
    pub dropped: Vec<(String, Outcome)>,
    /// The event is configured off: answer the neutral no-op.
    pub event_off: bool,
    /// The event's budget.
    pub budget: Budget,
    /// The hash of the non-default hook configuration this plan was made under (empty = defaults).
    pub cfg_hash: String,
}

impl Plan {
    /// Every entry's outcome in this plan: dropped ones, shadowed ones and the ones that run.
    pub fn outcomes(&self) -> Vec<(String, Outcome)> {
        let mut out = self.dropped.clone();
        out.extend(self.items.iter().map(|i| (i.entry.id.clone(), if i.shadow { Outcome::Shadowed } else { Outcome::Ran })));
        out
    }
}

/// What the dispatcher knows about the occurrence, for the predicates.
pub struct Occurrence<'a> {
    /// The hook payload.
    pub payload: &'a Value,
    /// The `--tool` argument.
    pub tool: Option<&'a str>,
    /// The request environment.
    pub env: &'a RequestEnv,
    /// Session state, when this process keeps it across calls (a one-shot client does not).
    pub sessions: Option<&'a SessionStore>,
    /// Loaded settings and the transcript index, when available.
    pub facts: &'a dyn Facts,
    /// The payload parsed; when it did not, no predicate is evaluated (every matched entry applies, as a guard must).
    pub payload_ok: bool,
}

fn is_guard(event: &str) -> bool {
    defaults::list("dispatch.guard_events").contains(&event)
}

/// Build the plan for `event` from the entries its matcher selected.
pub fn build(event: &str, matched: Vec<Entry>, cfg: &HookCfg, occ: &Occurrence<'_>) -> Plan {
    let mut ecfg = cfg.event(event);
    let guard = is_guard(event);
    if guard {
        ecfg.mode = Mode::On; // defence in depth: a guard event is never off or shadow, whatever a layer says (hookcfg rejects it)
        ecfg.max_rules = 0;
    }
    let mut plan = Plan { items: Vec::new(), dropped: Vec::new(), event_off: false, budget: Budget::new(ecfg.budget_ms), cfg_hash: cfg.hash().to_string() };
    if ecfg.mode == Mode::Off {
        plan.event_off = true;
        plan.dropped = matched.into_iter().map(|e| (e.id, Outcome::Off)).collect();
        return plan;
    }
    let mut entries = matched;
    if !ecfg.order.is_empty() {
        let pos = |id: &str| ecfg.order.iter().position(|o| o == id).unwrap_or(usize::MAX);
        entries.sort_by_key(|e| pos(&e.id)); // stable: ids not listed keep the table's order after the listed ones
    }
    let session_id = occ.payload.get("session_id").and_then(Value::as_str).unwrap_or("-");
    let cx = Ctx { payload: occ.payload, tool: occ.tool, env: occ.env, session_id, sessions: occ.sessions, facts: occ.facts };
    let mut kept = 0usize;
    for e in entries {
        let ec = cfg.entry(event, &e.id);
        let mode = if ecfg.mode == Mode::Shadow { Mode::Shadow } else { ec.mode };
        let mode = if guard && e.check.is_none() { Mode::On } else { mode }; // a guard entry with no engine check only has its Node hook
        if mode == Mode::Off {
            plan.dropped.push((e.id.clone(), Outcome::Off));
            if guard && e.check.is_some() {
                // the engine's check is off; the Node hook is the decider and still runs
                kept += 1;
                plan.items.push(Item { entry: Entry { check: None, ..e }, shadow: false });
            }
            continue;
        }
        if let Some(w) = ec.when.as_ref().or(e.when.as_ref())
            && occ.payload_ok
            && w.eval(&cx) == Some(false)
        {
            plan.dropped.push((e.id, Outcome::SkippedPredicate));
            continue;
        }
        if ecfg.max_rules > 0 && kept >= ecfg.max_rules {
            plan.dropped.push((e.id, Outcome::SkippedMaxRules));
            continue;
        }
        kept += 1;
        match mode {
            Mode::Shadow if guard && e.check.is_some() => {
                plan.items.push(Item { entry: Entry { check: None, ..e.clone() }, shadow: false });
                plan.items.push(Item { entry: e, shadow: true });
            }
            Mode::Shadow => plan.items.push(Item { entry: e, shadow: true }),
            _ => plan.items.push(Item { entry: e, shadow: false }),
        }
    }
    plan
}

/// Settings and transcript facts loaded on first use, from the engine's own config files (never from Node).
pub struct LiveFacts {
    loaded: std::sync::OnceLock<(Value, crate::cfgstore::Effective)>,
}

impl Default for LiveFacts {
    fn default() -> Self {
        LiveFacts { loaded: std::sync::OnceLock::new() }
    }
}

impl LiveFacts {
    fn loaded(&self) -> &(Value, crate::cfgstore::Effective) {
        self.loaded.get_or_init(|| {
            let (layers, _) = crate::cfgstore::load_layers_cold(&crate::cfgstore::Paths::from_env());
            let eff = crate::cfgstore::Effective::resolve_process(&layers);
            (layers.settings, eff)
        })
    }
}

impl Facts for LiveFacts {
    fn setting(&self, r: &SettingRef, env: &RequestEnv) -> Option<Option<Val>> {
        let (s, e) = self.loaded();
        LoadedFacts { settings: s, effective: e, index: None }.setting(r, env)
    }

    fn transcript(&self, payload: &Value, f: crate::hookcfg::when::Fact) -> Option<Option<Val>> {
        NoFacts.transcript(payload, f) // no transcript index lives in a one-shot client: unknown, so the entry applies
    }
}

/// The hook configuration of one occurrence: the engine's user file, then the project file under the payload's cwd. An
/// invalid file is logged and read as empty (a cold start has no earlier good config to keep).
pub fn load_config(cwd: &str) -> HookCfg {
    let user = match crate::cfgstore::load_layers(&crate::cfgstore::Paths::from_env()) {
        Ok(l) => l.hooks,
        Err(e) => {
            crate::health::log_event("config_invalid", e.code(), &e.to_string());
            Default::default()
        }
    };
    let project = crate::hookcfg::load_project(cwd).unwrap_or_else(|e| {
        crate::health::log_event("config_invalid", e.code(), &e.to_string());
        None
    });
    HookCfg::new(project, user)
}

/// What one dispatch records about its plan.
#[derive(Debug, Default)]
pub struct Tele {
    /// Outcomes of every entry the plan considered, plus any the budget cut later.
    pub outcomes: Vec<(String, Outcome)>,
    /// The config hash.
    pub cfg_hash: String,
}

impl Tele {
    /// Record that `id`, planned to run, was left out for `why` after all.
    pub fn mark(&mut self, id: &str, why: Outcome) {
        if let Some(o) = self.outcomes.iter_mut().find(|(i, o)| i == id && *o == Outcome::Ran) {
            o.1 = why;
        }
    }

    /// Whether anything other than "ran" under the default configuration happened.
    pub fn notable(&self) -> bool {
        !self.cfg_hash.is_empty() || self.outcomes.iter().any(|(_, o)| *o != Outcome::Ran)
    }

    /// The event-log detail.
    pub fn detail(&self) -> String {
        let list = |o: Outcome| self.outcomes.iter().filter(|(_, x)| *x == o).map(|(id, _)| id.as_str()).collect::<Vec<_>>().join(",");
        defaults::render(
            "hooks.msg_plan_event",
            &[
                ("cfg", &self.cfg_hash),
                ("ran", &list(Outcome::Ran)),
                ("predicate", &list(Outcome::SkippedPredicate)),
                ("max_rules", &list(Outcome::SkippedMaxRules)),
                ("budget", &list(Outcome::SkippedBudget)),
                ("shadowed", &list(Outcome::Shadowed)),
                ("off", &list(Outcome::Off)),
            ],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::table;
    use crate::hookcfg::{Layer, Origin, parse_layer};
    use serde_json::json;
    use std::path::Path;

    fn cfg(user: &str) -> HookCfg {
        let t: toml::Table = user.parse().unwrap();
        let j = |k: &str| t.get(k).map(|v| crate::cfgstore::toml_to_json(Path::new("t"), k, v).unwrap());
        HookCfg::new(None, parse_layer(Path::new("t"), Origin::User, j("events").as_ref(), j("entries").as_ref()).unwrap())
    }

    fn plan_for(event: &str, payload: Value, c: &HookCfg) -> Plan {
        let env = RequestEnv::default();
        let matched = table::select("claude", event, &payload, None);
        build(event, matched, c, &Occurrence { payload: &payload, tool: None, env: &env, sessions: None, facts: &NoFacts, payload_ok: true })
    }

    fn ids(p: &Plan) -> Vec<(String, bool)> {
        p.items.iter().map(|i| (i.entry.id.clone(), i.shadow)).collect()
    }

    const POST_BASH: &str = r#"{"tool_name":"Bash","session_id":"s"}"#;

    fn post() -> Value {
        serde_json::from_str(POST_BASH).unwrap()
    }

    #[test]
    fn the_default_configuration_plans_exactly_the_matched_entries_in_table_order() {
        let c = HookCfg::default();
        let p = plan_for("PostToolUse", post(), &c);
        let want: Vec<String> = table::select("claude", "PostToolUse", &post(), None).into_iter().map(|e| e.id).collect();
        assert_eq!(p.items.iter().map(|i| i.entry.id.clone()).collect::<Vec<_>>(), want);
        assert!(p.dropped.is_empty() && !p.event_off && p.cfg_hash.is_empty() && p.items.iter().all(|i| !i.shadow));
    }

    #[test]
    fn max_rules_keeps_the_first_n_in_order_and_counts_the_rest() {
        let all = plan_for("PostToolUse", post(), &HookCfg::default());
        let c = cfg("[events.PostToolUse]\nmax_rules = 2\n");
        let p = plan_for("PostToolUse", post(), &c);
        assert_eq!(ids(&p).len(), 2);
        assert_eq!(ids(&p)[..], ids(&all)[..2]);
        assert_eq!(p.dropped.len(), ids(&all).len() - 2);
        assert!(p.dropped.iter().all(|(_, o)| *o == Outcome::SkippedMaxRules));
    }

    #[test]
    fn order_runs_the_listed_ids_first_and_keeps_the_table_order_for_the_rest() {
        let all = ids(&plan_for("PostToolUse", post(), &HookCfg::default()));
        let last = all.last().unwrap().0.clone();
        let c = cfg(&format!("[events.PostToolUse]\norder = [\"{last}\"]\n"));
        let got = ids(&plan_for("PostToolUse", post(), &c));
        assert_eq!(got[0].0, last);
        assert_eq!(got[1..].iter().map(|x| x.0.clone()).collect::<Vec<_>>(), all[..all.len() - 1].iter().map(|x| x.0.clone()).collect::<Vec<_>>());
    }

    #[test]
    fn an_off_event_answers_neutral_and_counts_every_entry_as_off() {
        let p = plan_for("PostToolUse", post(), &cfg("[events.PostToolUse]\nenabled = false\n"));
        assert!(p.event_off && p.items.is_empty());
        assert!(!p.dropped.is_empty() && p.dropped.iter().all(|(_, o)| *o == Outcome::Off));
    }

    #[test]
    fn a_shadow_event_runs_every_entry_but_none_counts() {
        let p = plan_for("PostToolUse", post(), &cfg("[events.PostToolUse]\nmode = \"shadow\"\n"));
        assert!(!p.items.is_empty() && p.items.iter().all(|i| i.shadow));
        assert!(p.outcomes().iter().all(|(_, o)| *o == Outcome::Shadowed));
    }

    #[test]
    fn a_when_override_skips_an_entry_whose_predicate_is_false_and_unknown_applies_it() {
        let c = cfg("[entries.\"git-guard:audit\"]\nwhen = { field = \"/tool_input/command\", regex = \"^git\" }\n");
        let ran = plan_for("PostToolUse", json!({"tool_name":"Bash","tool_input":{"command":"git status"}}), &c);
        assert!(ran.items.iter().any(|i| i.entry.id == "git-guard:audit"));
        let skipped = plan_for("PostToolUse", json!({"tool_name":"Bash","tool_input":{"command":"ls"}}), &c);
        assert!(!skipped.items.iter().any(|i| i.entry.id == "git-guard:audit"));
        assert!(skipped.dropped.contains(&("git-guard:audit".to_string(), Outcome::SkippedPredicate)));
        let unknown = cfg("[entries.\"git-guard:audit\"]\nwhen = { session = \"s\", first = true }\n");
        let p = plan_for("PostToolUse", post(), &unknown);
        assert!(p.items.iter().any(|i| i.entry.id == "git-guard:audit"), "a predicate the process cannot decide applies the entry");
    }

    #[test]
    fn a_guard_entry_with_a_check_turned_off_keeps_its_node_hook_as_the_decider() {
        let p = plan_for("PreToolUse", json!({"tool_name":"Bash","session_id":"s"}), &cfg("[entries.\"PreToolUse/git-guard\"]\nmode = \"off\"\n"));
        let it = p.items.iter().find(|i| i.entry.id == "git-guard").expect("the Node hook still runs");
        assert!(it.entry.check.is_none() && !it.shadow, "off clears the engine check; the Node hook decides");
        assert!(p.dropped.contains(&("git-guard".to_string(), Outcome::Off)));
    }

    #[test]
    fn a_guard_entry_with_a_check_in_shadow_runs_the_check_beside_the_deciding_node_hook() {
        let p = plan_for("PreToolUse", json!({"tool_name":"Bash","session_id":"s"}), &cfg("[entries.\"PreToolUse/git-guard\"]\nmode = \"shadow\"\n"));
        let both: Vec<&Item> = p.items.iter().filter(|i| i.entry.id == "git-guard").collect();
        assert_eq!(both.len(), 2);
        assert!(both[0].entry.check.is_none() && !both[0].shadow, "the Node hook decides");
        assert!(both[1].entry.check.is_some() && both[1].shadow, "the check is the shadow");
    }

    #[test]
    fn shadow_never_changes_the_set_of_deciding_entries() {
        let real = |p: &Plan| p.items.iter().filter(|i| !i.shadow).map(|i| (i.entry.id.clone(), i.entry.check.is_some())).collect::<Vec<_>>();
        let payload = json!({"tool_name":"Bash","session_id":"s"});
        let plain = real(&plan_for("PreToolUse", payload.clone(), &HookCfg::default()));
        let shadowed = real(&plan_for(
            "PreToolUse",
            payload,
            &cfg("[entries.\"PreToolUse/git-guard\"]\nmode = \"shadow\"\n[entries.\"PreToolUse/command-guard\"]\nmode = \"shadow\"\n"),
        ));
        let strip = |v: &[(String, bool)]| v.iter().map(|x| x.0.clone()).collect::<Vec<_>>();
        assert_eq!(strip(&plain), strip(&shadowed), "the same ids decide; only their engine checks stopped deciding");
        assert!(shadowed.iter().filter(|x| x.0 == "git-guard" || x.0 == "command-guard").all(|x| !x.1));
    }

    #[test]
    fn the_budget_is_unlimited_at_zero_and_trips_once_the_wall_time_has_passed() {
        assert!(!Budget::new(0).exceeded());
        let b = Budget::new(1);
        std::thread::sleep(Duration::from_millis(5));
        assert!(b.exceeded());
        let _ = Layer::default();
    }

    #[test]
    fn the_plan_event_detail_lists_each_outcome() {
        let t = Tele {
            outcomes: vec![("a".into(), Outcome::Ran), ("b".into(), Outcome::SkippedPredicate), ("c".into(), Outcome::Shadowed)],
            cfg_hash: "abc".into(),
        };
        assert!(t.notable());
        let d = t.detail();
        assert!(d.contains("cfg=abc") && d.contains("ran=[a]") && d.contains("skipped_predicate=[b]") && d.contains("shadowed=[c]"), "{d}");
        assert!(!Tele { outcomes: vec![("a".into(), Outcome::Ran)], cfg_hash: String::new() }.notable());
    }
}
