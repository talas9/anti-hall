//! The executor: plans, re-checks, claims, runs, verifies, records. See the module header of [`crate::dsact`].
use super::decide::decide;
use super::ledger::{Begin, KeyState, Ledger, Word};
use super::live::LiveState;
use super::runner::{RunResult, RunSpec, Runner, at_least, parse_version};
use super::settings::ActSettings;
use crate::checks::git::util::Settings;
use crate::checks::taskkit::time::iso;
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Who started the action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// A trigger with no owner request behind it (the supervisor's sweep).
    Automatic,
    /// The owner asked: a command, a skill or a mesh request.
    Owner,
}

impl Origin {
    fn text(self) -> &'static str {
        defaults::list("devswarm_act.origins").get(self as usize).copied().unwrap_or_default()
    }
}

/// What happened to one action.
#[derive(Debug, Clone)]
pub struct Report {
    /// The kind.
    pub kind: String,
    /// The id.
    pub id: String,
    /// The key.
    pub key: String,
    /// The word.
    pub word: Word,
    /// The detail.
    pub detail: Value,
}

impl Report {
    fn new(kind: &str, id: &str, key: &str, word: Word, detail: Value) -> Report {
        Report { kind: kind.into(), id: id.into(), key: key.into(), word, detail }
    }

    /// The report as a JSON object.
    pub fn json(&self) -> Value {
        json!({"kind": self.kind, "id": self.id, "key": self.key, "outcome": self.word.text(), "detail": self.detail})
    }
}

/// The action layer for one run.
pub struct Act<'a> {
    /// The home directory (Node's records live under it).
    pub home: PathBuf,
    /// The engine state directory (ledger, log, plans).
    pub state_dir: PathBuf,
    /// The request environment (settings tiers).
    pub env: RequestEnv,
    /// The live.
    pub live: &'a dyn LiveState,
    /// The runner.
    pub runner: &'a dyn Runner,
    ledger: Ledger,
    probe: RefCell<Option<(bool, Option<Vec<u64>>)>>,
}

fn strings(v: &Value) -> Option<Vec<String>> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
}

impl<'a> Act<'a> {
    /// A layer over `live` and `runner`.
    pub fn new(home: &Path, state_dir: &Path, env: RequestEnv, live: &'a dyn LiveState, runner: &'a dyn Runner) -> Act<'a> {
        Act { home: home.into(), state_dir: state_dir.into(), env, live, runner, ledger: Ledger::open(state_dir), probe: RefCell::new(None) }
    }

    fn settings(&self) -> ActSettings {
        ActSettings::read(&Settings::from_env(&self.env))
    }

    fn home_str(&self) -> String {
        self.home.to_string_lossy().into_owned()
    }

    fn log(&self, rec: &Value) {
        append_line(&self.state_dir.join(defaults::text("devswarm_act.log_file")), rec);
    }

    fn payload(&self, kind: &str, facts: Value, request: Value, ledger_keys: Vec<String>, s: &ActSettings) -> Value {
        json!({"kind": kind, "now": self.live.now_ms(), "settings": s.json(), "facts": facts, "request": request, "ledgerKeys": ledger_keys})
    }

    /// Keys of auto-archives already made at some HEAD of `id`, by the engine or by Node (its durable gate-(h) file).
    fn archived_keys(&self, id: &str) -> Vec<String> {
        let kind = defaults::text("devswarm_act.auto_archive_kind");
        let mut keys = self.ledger.acted_keys(&format!("{kind}:{id}:"));
        let file = self.home.join(defaults::text("devswarm_act.node_archived_state"));
        if let Some(Value::Object(o)) = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok())
            && let Some(Value::Array(list)) = o.get(id)
        {
            for e in list {
                if let Some(h) = e.get("doneHead").and_then(Value::as_str) {
                    keys.push(format!("{kind}:{id}:{h}"));
                }
            }
        }
        keys
    }

    /// Whether `origin` may start `kind`: the automatic set is `devswarm_act.automatic_kinds`, the owner set `owner_kinds`, and the
    /// kinds the engine does not execute answer `deferred`.
    pub fn permit(&self, origin: Origin, kind: &str) -> Result<(), Report> {
        if defaults::list("devswarm_act.deferred_kinds").contains(&kind) {
            return Err(Report::new(kind, "", "", Word::Deferred, json!({})));
        }
        let allowed = match origin {
            Origin::Automatic => defaults::list("devswarm_act.automatic_kinds"),
            Origin::Owner => defaults::list("devswarm_act.owner_kinds"),
        };
        if allowed.contains(&kind) {
            return Ok(());
        }
        let why = defaults::render("devswarm_act.msg_origin", &[("kind", &kind), ("origin", &origin.text())]);
        Err(Report::new(kind, "", "", Word::Refused, json!({"why": why})))
    }

    /// `hivecontrol --version`, once per layer.
    fn version(&self) -> (bool, Option<Vec<u64>>) {
        if let Some(p) = self.probe.borrow().clone() {
            return p;
        }
        let args = defaults::list("devswarm_act.argv_version").into_iter().map(str::to_string).collect();
        let r = self.runner.run(&RunSpec { bin: None, args, cwd: None, timeout_ms: defaults::num("devswarm_act.probe_timeout_ms"), ..RunSpec::default() });
        let p = (r.missing, parse_version(&format!("{} {}", r.stdout, r.stderr)));
        *self.probe.borrow_mut() = Some(p.clone());
        p
    }

    /// Whether the DevSwarm CLI can run `verb`: present, and new enough where the verb has a minimum.
    fn capability(&self, verb: &str) -> Result<(), String> {
        let (missing, ver) = self.version();
        if missing {
            return Err(defaults::text("devswarm_act.msg_inert").to_string());
        }
        let min = defaults::list("devswarm_act.verbs").into_iter().find_map(|e| e.split_once(':').filter(|(v, _)| *v == verb).map(|(_, m)| m));
        let Some(min) = min else { return Err(defaults::render("devswarm_act.msg_verb", &[("argv", &verb)])) };
        if min.is_empty() {
            return Ok(());
        }
        let want = parse_version(min).unwrap_or_default();
        match ver {
            None => Err(defaults::render("devswarm_act.msg_version_unknown", &[("verb", &verb)])),
            Some(have) if !at_least(&have, &want) => {
                Err(defaults::render("devswarm_act.msg_version", &[("verb", &verb), ("have", &join(&have)), ("want", &min)]))
            }
            Some(_) => Ok(()),
        }
    }

    /// The invariants no script answer may break: a hivecontrol argv names an allowed verb, and an id verb carries exactly one
    /// explicit id (hivecontrol would act on the CURRENT workspace without one).
    fn argv_ok(&self, argv: &[String]) -> Result<String, String> {
        let head = defaults::list("devswarm_act.argv_create");
        let bad = || defaults::render("devswarm_act.msg_verb", &[("argv", &argv.join(" "))]);
        if argv.len() < 2 || argv[0] != head[0] {
            return Err(bad());
        }
        let verb = argv[1].as_str();
        if !defaults::list("devswarm_act.verbs").iter().any(|e| e.split_once(':').is_some_and(|(v, _)| v == verb)) {
            return Err(bad());
        }
        if defaults::list("devswarm_act.id_verbs").contains(&verb) {
            let id = argv.get(2).map(String::as_str).unwrap_or_default();
            if argv.len() != 3 || id.trim().is_empty() || id.starts_with('-') {
                return Err(bad());
            }
        }
        Ok(verb.to_string())
    }

    /// Claim, run, check, record one action. `check` decides whether a successful process really did the job.
    fn execute(&self, kind: &str, id: &str, d: &Value, timeout_ms: u64, check: &dyn Fn(&RunResult) -> Result<(), String>) -> Report {
        // a merge's informational check is side-effecting, so it runs only once the key is claimed
        let pre = d.get("pre").and_then(strings).filter(|p| self.argv_ok(p).and_then(|_| self.capability(&p[1])).is_ok());
        let key = d.get("key").and_then(Value::as_str).unwrap_or_default().to_string();
        let argv = d.get("argv").and_then(strings);
        let cwd = d.get("cwd").and_then(Value::as_str).map(str::to_string);
        let poking = defaults::list("devswarm_act.automatic_kinds")[1..].contains(&kind);
        let mut spec = RunSpec { bin: None, args: vec![], cwd, timeout_ms, ..RunSpec::default() };
        if let Some(a) = &argv {
            if poking {
                spec.bin = a.first().cloned();
                spec.args = a[1..].to_vec();
            } else {
                match self.argv_ok(a).and_then(|v| self.capability(&v).map(|()| v)) {
                    Err(why) => return Report::new(kind, id, &key, Word::Unavailable, json!({"why": why})),
                    Ok(_) => spec.args = a.clone(),
                }
            }
        }
        let now = self.live.now_ms();
        let attempt = match self.ledger.begin(&key, kind, id, now) {
            Begin::Claimed(n) => n,
            Begin::Refused(st) => {
                let w = if st == KeyState::Done {
                    Word::Skipped
                } else if st == KeyState::InDoubt {
                    Word::InDoubt
                } else {
                    Word::Refused
                };
                return Report::new(kind, id, &key, w, json!({"state": format!("{st:?}")}));
            }
            Begin::Unwritable(why) => {
                let why = defaults::render("devswarm_act.msg_ledger", &[("why", &why)]);
                return Report::new(kind, id, &key, Word::Refused, json!({"why": why}));
            }
        };
        if let Some(args) = pre {
            let _check = self.runner.run(&RunSpec { bin: None, args, cwd: spec.cwd.clone(), timeout_ms, ..RunSpec::default() }); // keep: the check is informational, its answer changes nothing
        }
        let mut res = if argv.is_some() { self.runner.run(&spec) } else { RunResult { ok: true, ..RunResult::default() } };
        let retry = kind == defaults::list("devswarm_act.owner_kinds")[0] && !res.ok && !res.timed_out && !res.missing;
        let mut retried = false;
        if retry
            && let Ok(re) = regex::RegexBuilder::new(defaults::text("devswarm_act.archive_retry_re")).case_insensitive(true).build()
            && re.is_match(&format!("{} {}", res.stderr, res.stdout))
        {
            retried = true;
            res = self.runner.run(&spec);
        }
        let verdict = if res.ok {
            check(&res)
        } else {
            Err(res.error.clone().unwrap_or_else(|| format!("{}{}", res.stderr.trim(), res.status.map(|s| format!(" (exit {s})")).unwrap_or_default())))
        };
        let word = if verdict.is_ok() {
            Word::Done
        } else if res.timed_out {
            Word::Timeout
        } else {
            Word::Failed
        };
        let err = verdict.err();
        self.ledger.finish(&key, kind, id, self.live.now_ms(), word, err.as_deref());
        let detail = json!({"argv": argv, "cwd": spec.cwd, "attempt": attempt, "retried": retried, "status": res.status, "stdout": res.stdout, "error": err, "missing": res.missing});
        self.log(&json!({"ts": self.live.now_ms(), "kind": kind, "id": id, "key": key, "outcome": word.text(), "argv": argv, "error": err}));
        Report::new(kind, id, &key, word, detail)
    }

    /// One auto-archive candidate: decide from fresh facts.
    fn auto_candidate(&self, id: &str, s: &ActSettings) -> Option<Value> {
        let facts = self.live.facts(defaults::text("devswarm_act.auto_archive_kind"), id)?;
        let p = self.payload(defaults::text("devswarm_act.auto_archive_kind"), facts.clone(), json!({}), self.archived_keys(id), s);
        let mut d = decide(&self.home_str(), &p).ok()?;
        d["id"] = json!(id);
        d["facts"] = facts;
        Some(d)
    }

    /// Node's `autoArchiveSweep`, with the same summary: off does nothing; dry-run and an absent verb only plan; on archives at
    /// most `maxPerSweep` workspaces, each re-checked against fresh facts right before its archive.
    pub fn auto_archive_sweep(&self) -> Value {
        let s = self.settings();
        let words = defaults::list("devswarm_act.plan_mode_words");
        if s.mode == words[2] {
            return json!({"mode": s.mode, "archived": []});
        }
        if !self.live.present() {
            return json!({"mode": s.mode, "dormant": defaults::text("devswarm_act.msg_inert"), "candidates": 0, "wouldArchive": [], "archived": [], "failed": []});
        }
        let cap = self.capability(defaults::list("devswarm_act.id_verbs")[0]);
        let cands: Vec<Value> = self.live.candidates().iter().filter_map(|id| self.auto_candidate(id, &s)).collect();
        let eligible = |c: &Value| c.get("eligible").and_then(Value::as_bool) == Some(true);
        let would: Vec<String> =
            cands.iter().filter(|c| eligible(c)).take(s.max_per_sweep.max(1) as usize).filter_map(|c| c["id"].as_str().map(str::to_string)).collect();
        let mut sum = json!({"mode": s.mode, "dormant": cap.as_ref().err(), "candidates": cands.len(), "wouldArchive": would, "archived": [], "failed": [], "notices": [], "plan": cands.iter().map(|c| json!({"id": c["id"], "eligible": c["eligible"], "blockers": c["blockers"]})).collect::<Vec<_>>()});
        if s.mode != words[0] || cap.is_err() {
            return sum;
        }
        for id in &would {
            // facts are read again immediately before the action (the plan may be seconds old)
            let again = self.auto_candidate(id, &s);
            let Some(d) = again.filter(eligible) else {
                self.log(&json!({"ts": self.live.now_ms(), "kind": defaults::text("devswarm_act.auto_archive_kind"), "id": id, "outcome": Word::Stale.text()}));
                push(&mut sum, "failed", json!({"id": id, "reason": Word::Stale.text()}));
                continue;
            };
            let kind = defaults::text("devswarm_act.auto_archive_kind");
            let r = self.execute(kind, id, &d, defaults::num("devswarm_act.hc_timeout_ms"), &|_| Ok(()));
            let head = d["facts"]["head"].clone();
            self.node_records(&r, &d, &head);
            if r.word == Word::Done {
                push(&mut sum, "archived", json!(id));
                push(&mut sum, "notices", json!({"id": id, "text": d["notice"]}));
            } else {
                push(&mut sum, "failed", json!({"id": id, "reason": r.detail.get("error").cloned().unwrap_or(json!(r.word.text())), "outcome": r.word.text()}));
            }
        }
        let owned: Vec<Value> = cands.iter().filter(|c| eligible(c) || c.get("soft").and_then(Value::as_bool) == Some(true)).map(|c| c["id"].clone()).collect();
        write_atomic(&self.home.join(defaults::text("devswarm_act.auto_archive_state_file")), &json!({"at": self.live.now_ms(), "owned": owned}).to_string());
        sum
    }

    /// Node's records of an auto-archive: the NDJSON line and the durable `auto-archived.json` entry gate (h) reads.
    fn node_records(&self, r: &Report, d: &Value, head: &Value) {
        let now = self.live.now_ms();
        let f = &d["facts"];
        let rec = json!({"ts": iso(now), "at": now, "action": defaults::text("devswarm_act.auto_archive_kind"), "id": r.id, "doneHead": head, "branch": f["branch"], "label": f["label"], "argv": d["argv"], "ok": r.word == Word::Done, "error": r.detail.get("error").filter(|e| !e.is_null())});
        append_line(&self.home.join(defaults::text("devswarm_act.node_archive_log")), &rec);
        if r.word != Word::Done {
            return;
        }
        let file = self.home.join(defaults::text("devswarm_act.node_archived_state"));
        let mut state: serde_json::Map<String, Value> = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let list = state.entry(r.id.clone()).or_insert_with(|| json!([]));
        if let Some(a) = list.as_array_mut()
            && !a.iter().any(|e| e.get("doneHead") == Some(head))
        {
            a.push(json!({"doneHead": head, "at": now}));
        }
        write_atomic(&file, &Value::Object(state).to_string());
    }

    /// Poke or escalate every stale workspace, as Node's `pokeOrEscalate` does.
    pub fn poke_sweep(&self) -> Vec<Report> {
        self.poke_sweep_for(&|_| true)
    }

    /// [`Act::poke_sweep`] restricted to the kinds `allow` accepts (`poke`, `escalate`): a kind it refuses is left alone, so the
    /// per-action executor switch can give one of the two to another actor.
    pub fn poke_sweep_for(&self, allow: &dyn Fn(&str) -> bool) -> Vec<Report> {
        let mut out = Vec::new();
        if !self.live.present() {
            return out;
        }
        let s = self.settings();
        let kinds = defaults::list("devswarm_act.automatic_kinds");
        for id in self.live.stale() {
            let decided = |this: &Self| -> Option<Value> {
                let facts = this.live.facts(&format!("{}-or-{}", kinds[1], kinds[2]), &id)?;
                let d = decide(&this.home_str(), &this.payload(&format!("{}-or-{}", kinds[1], kinds[2]), facts, json!({}), vec![], &s)).ok()?;
                (d.get("eligible").and_then(Value::as_bool) == Some(true)).then_some(d)
            };
            if decided(self).is_none() {
                continue;
            }
            // right before acting: read and decide again
            let Some(d) = decided(self) else {
                out.push(Report::new("", &id, "", Word::Stale, json!({})));
                continue;
            };
            let kind = d["kind"].as_str().unwrap_or_default().to_string();
            if !allow(&kind) {
                continue;
            }
            if let Err(r) = self.permit(Origin::Automatic, &kind) {
                out.push(r);
                continue;
            }
            out.push(self.execute(&kind, &id, &d, defaults::num("devswarm_act.hc_timeout_ms"), &|_| Ok(())));
        }
        out
    }

    /// An owner request: archive, create or merge. `req` carries `id` / `rest` / `cwd` / `title` and the request's own `request`
    /// id (the idempotency key's last part: the same request is never run twice).
    pub fn request(&self, kind: &str, req: &Value) -> Report {
        if let Err(r) = self.permit(Origin::Owner, kind) {
            return r;
        }
        if !self.live.present() {
            return Report::new(kind, req["id"].as_str().unwrap_or_default(), "", Word::Inert, json!({"why": defaults::text("devswarm_act.msg_inert")}));
        }
        let id = req.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let s = self.settings();
        let facts = self.live.facts(kind, &id).unwrap_or_else(|| json!({}));
        let p = self.payload(kind, facts, req.clone(), vec![], &s);
        let d = match decide(&self.home_str(), &p) {
            Ok(d) => d,
            Err(why) => return Report::new(kind, &id, "", Word::Refused, json!({"why": why})),
        };
        let key = d["key"].as_str().unwrap_or_default().to_string();
        if d.get("eligible").and_then(Value::as_bool) != Some(true) {
            return Report::new(kind, &id, &key, Word::Refused, json!({"blockers": d["blockers"]}));
        }
        let verbs = defaults::list("devswarm_act.owner_kinds");
        let timeout = if kind == verbs[1] { s.create_timeout_ms as u64 } else { defaults::num("devswarm_act.hc_timeout_ms") };
        let live = self.live;
        let ident = id.clone();
        let check = move |r: &RunResult| -> Result<(), String> {
            if kind != verbs[0] {
                return Ok(());
            }
            let body: Option<Value> = serde_json::from_str(&r.stdout).ok();
            let flag = defaults::text("devswarm_act.archive_refused_flag");
            if body.as_ref().and_then(|b| b.get(flag)) == Some(&json!(false)) {
                return Err(r.stdout.trim().chars().take(defaults::num("devswarm_act.err_chars") as usize).collect());
            }
            match live.archived(&ident) {
                Some(true) => Ok(()),
                Some(false) => Err(defaults::text("devswarm_act.msg_unverified").to_string()),
                None if body.as_ref().and_then(|b| b.get(flag)) == Some(&json!(true)) => Ok(()),
                None => Err(defaults::text("devswarm_act.msg_unverified").to_string()),
            }
        };
        let r = self.execute(kind, &id, &d, timeout, &check);
        if r.word == Word::Done
            && let Some(title) = d.get("title").and_then(strings)
            && self.argv_ok(&title).is_ok()
        {
            let t = self.runner.run(&RunSpec { bin: None, args: title, cwd: d["cwd"].as_str().map(str::to_string), timeout_ms: timeout, ..RunSpec::default() });
            self.log(&json!({"ts": self.live.now_ms(), "kind": kind, "id": id, "key": key, "titled": t.ok}));
        }
        r
    }

    // ---- delete (prune): owner only, planned, confirmed -------------------------------------------------------------

    fn plans_dir(&self) -> PathBuf {
        self.state_dir.join(defaults::text("devswarm_act.plans_dir"))
    }

    /// The dry run: store a plan of the archives older than `days` that the live state calls eligible. Writes only the plan.
    pub fn plan_prune(&self, days: u64) -> Result<Value, String> {
        use ring::rand::{SecureRandom, SystemRandom};
        let now = self.live.now_ms();
        let rows = self.live.prune_rows(days);
        let mut ids: Vec<String> =
            rows.iter().filter(|r| r.get("eligible").and_then(Value::as_bool) == Some(true)).filter_map(|r| r["id"].as_str().map(str::to_string)).collect();
        ids.sort();
        let mut raw: Vec<u8> = std::iter::repeat_n(0, defaults::num("devswarm_act.plan_nonce_len") as usize).collect();
        SystemRandom::new().fill(&mut raw).map_err(|e| e.to_string())?;
        let nonce: String =
            raw.iter().map(|b| format!("{b:02x}")).collect::<String>().chars().take(defaults::num("devswarm_act.plan_nonce_len") as usize).collect();
        let ttl = defaults::num("devswarm_act.plan_ttl_ms") as i64;
        let plan = json!({"nonce": nonce, "createdAt": now, "expiresAt": now + ttl, "olderThanDays": days, "eligibleIds": ids, "rows": rows});
        std::fs::create_dir_all(self.plans_dir()).map_err(|e| e.to_string())?;
        std::fs::write(self.plans_dir().join(format!("{nonce}.json")), plan.to_string()).map_err(|e| e.to_string())?;
        Ok(plan)
    }

    /// Delete exactly the archived workspaces `ids` of the owner-approved plan `nonce`. Refused for an automated caller, an
    /// unknown, used or expired plan, or ids that differ from the plan's; each row is re-verified against fresh facts right
    /// before its delete. Only the DevSwarm CLI deletes (an archived workspace; it refuses uncommitted work itself);
    /// anti-hall writes a tombstone and removes nothing.
    pub fn delete_confirmed(&self, ids: &[String], nonce: &str) -> Value {
        let kind = defaults::list("devswarm_act.owner_kinds")[3];
        if let Err(r) = self.permit(Origin::Owner, kind) {
            return json!({"ok": false, "report": r.json()});
        }
        let caller = self.env.get(defaults::text("devswarm_act.caller_env")).unwrap_or_default();
        if !caller.is_empty() && caller != defaults::text("devswarm_act.interactive_caller") {
            return json!({"ok": false, "error": defaults::render("devswarm_act.msg_caller", &[("caller", &caller)])});
        }
        if !self.live.present() {
            return json!({"ok": false, "dormant": true, "error": defaults::text("devswarm_act.msg_inert")});
        }
        let now = self.live.now_ms();
        let path = self.plans_dir().join(format!("{nonce}.json"));
        let valid_nonce = nonce.len() == defaults::num("devswarm_act.plan_nonce_len") as usize && nonce.bytes().all(|b| b.is_ascii_hexdigit());
        let Some(mut plan) = valid_nonce.then(|| std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())).flatten() else {
            return json!({"ok": false, "error": defaults::render("devswarm_act.msg_plan_unknown", &[("nonce", &nonce)])});
        };
        if plan.get("consumedAt").is_some_and(|c| !c.is_null()) {
            return json!({"ok": false, "error": defaults::render("devswarm_act.msg_plan_used", &[("nonce", &nonce)])});
        }
        let (created, expires) = (plan["createdAt"].as_i64().unwrap_or(0), plan["expiresAt"].as_i64().unwrap_or(0));
        if !(created <= now && now <= expires) {
            return json!({"ok": false, "error": defaults::render("devswarm_act.msg_plan_expired", &[("nonce", &nonce)])});
        }
        let mut want: Vec<String> = ids.to_vec();
        want.sort();
        want.dedup();
        let planned: Vec<String> =
            plan["eligibleIds"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if want.is_empty() || want != planned {
            return json!({"ok": false, "error": defaults::render("devswarm_act.msg_plan_ids", &[("ids", &planned.join(","))])});
        }
        if let Err(why) = self.capability(kind) {
            return json!({"ok": false, "dormant": true, "error": why});
        }
        plan["consumedAt"] = json!(now);
        if let Err(e) = std::fs::write(&path, plan.to_string()) {
            return json!({"ok": false, "error": defaults::render("devswarm_act.msg_plan_write", &[("why", &e)])});
        }
        let s = self.settings();
        let log = self.home.join(defaults::text("devswarm_act.prune_log"));
        let mut results = Vec::new();
        for id in &want {
            let req = json!({"id": id, "nonce": nonce});
            let facts = self.live.facts(kind, id).unwrap_or_else(|| json!({}));
            let rec = json!({"ts": iso(now), "action": defaults::text("devswarm_act.prune_kind"), "plan": nonce, "id": id});
            let d = decide(&self.home_str(), &self.payload(kind, facts, req, vec![], &s))
                .unwrap_or_else(|e| json!({"eligible": false, "blockers": [{"detail": e}]}));
            if d.get("eligible").and_then(Value::as_bool) != Some(true) {
                let why = d["blockers"][0]["detail"].clone();
                append_line(&log, &merge(&rec, json!({"ok": false, "refused": why})));
                results.push(json!({"id": id, "ok": false, "refused": why}));
                continue;
            }
            let r = self.execute(kind, id, &d, defaults::num("devswarm_act.hc_timeout_ms"), &|_| Ok(()));
            let ok = r.word == Word::Done;
            append_line(&log, &merge(&rec, json!({"argv": d["argv"], "ok": ok, "error": r.detail.get("error").filter(|e| !e.is_null())})));
            if ok {
                write_atomic(
                    &self.home.join(defaults::text("devswarm_act.pruned_dir")).join(format!("{id}.json")),
                    &json!({"id": id, "prunedAt": now, "plan": nonce}).to_string(),
                );
            }
            results.push(json!({"id": id, "ok": ok, "outcome": r.word.text(), "error": r.detail.get("error")}));
        }
        json!({"ok": results.iter().all(|r| r["ok"] == json!(true)), "plan": nonce, "results": results})
    }
}

fn join(v: &[u64]) -> String {
    v.iter().map(u64::to_string).collect::<Vec<_>>().join(".")
}

fn push(v: &mut Value, key: &str, item: Value) {
    if let Some(a) = v.get_mut(key).and_then(Value::as_array_mut) {
        a.push(item);
    }
}

fn merge(a: &Value, b: Value) -> Value {
    let mut o = a.as_object().cloned().unwrap_or_default();
    if let Value::Object(m) = b {
        o.extend(m);
    }
    Value::Object(o)
}

/// Append one JSON line; a failure loses the line, never the action's result.
pub fn append_line(path: &Path, rec: &Value) {
    if let Some(d) = path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the open below reports the failure
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        crate::discard::harmless(writeln!(f, "{rec}")); // keep: a lost log line never changes an action
    }
}

/// Write `text` to `path` through a temp file and a rename (best effort).
pub fn write_atomic(path: &Path, text: &str) {
    if let Some(d) = path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports the failure
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".{}{}", std::process::id(), defaults::text("mesh_write.tmp_suffix")));
    let tmp = PathBuf::from(tmp);
    if std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, path)).is_err() {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: a staged temp must not leak
    }
}
