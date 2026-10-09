//! Corpus for silent-agent-nudge (Stop): the nudge itself. Each scenario builds one sandbox (home, transcript, output and
//! sidechain files with fixed ages, heartbeats, nudge state, the stop-ack file, the host's plugin registry), runs the REAL
//! Node hook in it, rebuilds it at the same absolute path and runs `ah-engine check silent-agent-nudge`, and compares exit
//! code, stdout, stderr and every file left behind. The run clock appears in the written state (`everNudged`) and in the
//! nudge's override sentence, so a 13-digit time within ten minutes of now reads `<NOW>` on both sides; everything else,
//! the order of keys included, must be identical. A scenario marked `defers` must make the engine defer (`AHFALLBACK`).

use super::lab::{Lab, snapshot};
use super::support::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const HOOK: &str = "silent-agent-nudge";

/// A file of the sandbox, relative to the home directory; with `age` its mtime is `base - age` seconds.
struct F {
    rel: String,
    body: String,
    age: Option<i64>,
}

pub(crate) struct Sc {
    id: String,
    payload: Value,
    files: Vec<F>,
    env: Vec<(String, String)>,
    defers: bool,
    /// Run the Node hook once on each side before the compared run (a nudge already given).
    warm: bool,
    /// Between the warm-up and the compared run: give this file (relative to home) a new age in seconds.
    retouch: Option<(String, i64)>,
    /// Leave the engine without the plugin root (Node always knows its own).
    no_root: bool,
}

fn sc(id: &str, session: Value) -> Sc {
    Sc {
        id: id.into(),
        payload: json!({"hook_event_name": "Stop", "session_id": session, "transcript_path": "$HOME/t/session.jsonl", "cwd": "/tmp", "stop_hook_active": false}),
        files: Vec::new(),
        env: Vec::new(),
        defers: false,
        warm: false,
        retouch: None,
        no_root: false,
    }
}

impl Sc {
    fn file(mut self, rel: &str, body: &str) -> Sc {
        self.files.push(F { rel: rel.into(), body: body.into(), age: None });
        self
    }
    fn aged(mut self, rel: &str, body: &str, age_secs: i64) -> Sc {
        self.files.push(F { rel: rel.into(), body: body.into(), age: Some(age_secs) });
        self
    }
    fn env(mut self, k: &str, v: &str) -> Sc {
        self.env.push((k.into(), v.into()));
        self
    }
    fn lines(self, lines: &[String]) -> Sc {
        let mut body = lines.join("\n");
        body.push('\n');
        self.file("t/session.jsonl", &body)
    }
    fn state(self, nudged: Value, ever: Value) -> Sc {
        self.file(".anti-hall/silent-agent-nudge-state.json", &json!({"nudged": nudged, "everNudged": ever}).to_string())
    }
    fn settings(self, v: Value) -> Sc {
        self.file(".anti-hall/settings.json", &v.to_string())
    }
    fn registry(self, version: &str) -> Sc {
        self.file(
            ".claude/plugins/installed_plugins.json",
            &json!({"version": 2, "plugins": {"anti-hall@anti-hall": [{"scope": "user", "version": version}]}}).to_string(),
        )
    }
    fn ack(self, session: &str, body: &str) -> Sc {
        self.file(&format!(".anti-hall/stop-ack/stop-ack-{session}.json"), body)
    }
    fn defers(mut self) -> Sc {
        self.defers = true;
        self
    }
    fn warm(mut self) -> Sc {
        self.warm = true;
        self
    }
}

// ---- transcript lines (the shapes the harness writes; see tests/agent_controls_parity.rs) ------------------------

/// An ISO time `secs` seconds before the scenario clock: `$BASE-<secs>` is replaced when the sandbox is built.
fn ago(secs: i64) -> String {
    format!("$BASE-{secs}")
}

fn agent_use(tuid: &str, desc: &str, ts: &str) -> String {
    json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": tuid, "name": "Agent", "input": {"description": desc, "subagent_type": "general-purpose", "prompt": "p", "run_in_background": true}}]}, "timestamp": ts}).to_string()
}

fn launch(tuid: &str, agent: &str, out: &str, ts: &str) -> String {
    let text = format!(
        "Async agent launched successfully. (internal metadata)\nagentId: {agent} (internal ID - do not mention to user. Use SendMessage with to: '{agent}', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background.\noutput_file: {out}\nDo NOT Read or tail this file via the shell tool."
    );
    json!({"type": "user", "message": {"role": "user", "content": [{"tool_use_id": tuid, "type": "tool_result", "content": [{"type": "text", "text": text}]}]}, "timestamp": ts}).to_string()
}

fn resume(full: &str, short: &str, ts: &str) -> Vec<String> {
    let text = json!({"success": true, "message": format!("Resuming agent {short} in the background"), "resumedAgentId": full}).to_string();
    vec![
        json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "tu_r", "name": "SendMessage", "input": {"to": short, "summary": "s", "message": "go on"}}]}, "timestamp": ts}).to_string(),
        json!({"type": "user", "message": {"role": "user", "content": [{"tool_use_id": "tu_r", "type": "tool_result", "content": [{"type": "text", "text": text}]}]}, "timestamp": ts}).to_string(),
    ]
}

fn task_status(id: &str, out: &str, desc: &str, ts: &str) -> String {
    json!({"type": "attachment", "attachment": {"type": "task_status", "taskId": id, "status": "running", "outputFilePath": out, "description": desc}, "timestamp": ts}).to_string()
}

/// Agent `n` (id `a1b2c3d4e5f6<n>`) launched 90 minutes ago with description `desc`; its output file is `out-<n>.txt`.
fn task_status_typed(id: &str, out: &str, desc: &str, ts: &str, task_type: &str) -> String {
    json!({"type": "attachment", "attachment": {"type": "task_status", "taskId": id, "taskType": task_type, "status": "running", "outputFilePath": out, "description": desc}, "timestamp": ts}).to_string()
}

fn agent(n: &str, desc: &str) -> Vec<String> {
    let id = format!("a1b2c3d4e5f6{n}");
    vec![agent_use(&format!("tu_{n}"), desc, &ago(5400)), launch(&format!("tu_{n}"), &id, &format!("$HOME/out-{n}.txt"), &ago(5400))]
}

fn id(n: &str) -> String {
    format!("a1b2c3d4e5f6{n}")
}

/// An output file 60.5 minutes old (half a minute off the boundary, so both runs print the same minute).
const OLD: i64 = 3630;

fn hb(id: &str, session: &str, step: Option<&str>, age_secs: i64) -> String {
    let mut v = json!({"id": id, "session": session, "status": "running", "ts": format!("$BASEMS-{age_secs}")});
    if let Some(s) = step {
        v["step"] = json!(s);
    }
    // the time is a number in the file: unquote the placeholder
    v.to_string().replace(&format!("\"$BASEMS-{age_secs}\""), &format!("$BASEMS-{age_secs}"))
}

pub(crate) fn scenarios() -> Vec<Sc> {
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(repo_root().join("plugins/anti-hall/.claude-plugin/plugin.json")).unwrap()).unwrap();
    let ver = manifest["version"].as_str().unwrap().to_string();
    let parts: Vec<u64> = ver.split('.').map(|p| p.parse().unwrap()).collect();
    let newer = format!("{}.{}.{}", parts[0], parts[1], parts[2] + 1);
    let older = format!("{}.{}.{}", parts[0], parts[1].saturating_sub(1), parts[2]);
    let s1 = json!("s1");
    let mut v: Vec<Sc> = Vec::new();
    let one = || agent("01", "agent 01");

    // ---- the first nudge
    v.push(sc("first-nudge-one-agent", s1.clone()).lines(&one()).aged("out-01.txt", "{}\n", OLD));
    v.push(sc("first-nudge-output-missing", s1.clone()).lines(&one()));
    v.push(sc("first-nudge-no-session", json!(null)).lines(&one()).aged("out-01.txt", "{}\n", OLD));
    v.push(sc("first-nudge-session-number", json!(5)).lines(&one()).aged("out-01.txt", "{}\n", OLD));
    v.push(sc("two-agents-say-them", s1.clone()).lines(&[agent("02", "second"), agent("01", "first")].concat()).aged("out-01.txt", "{}\n", OLD).aged(
        "out-02.txt",
        "{}\n",
        OLD + 600,
    ));
    {
        let mut s = sc("five-agents-name-three-and-more", s1.clone());
        let mut lines = Vec::new();
        for n in ["05", "03", "01", "04", "02"] {
            lines.extend(agent(n, &format!("agent {n}")));
            s = s.aged(&format!("out-{n}.txt"), "{}\n", OLD);
        }
        v.push(s.lines(&lines));
    }
    v.push(sc("long-description-cut", s1.clone()).lines(&agent("01", &"word ".repeat(30))).aged("out-01.txt", "{}\n", OLD));
    v.push(sc("description-control-chars", s1.clone()).lines(&agent("01", "a\u{1}b\tc\n\nd\u{85}e  ")).aged("out-01.txt", "{}\n", OLD));
    v.push(sc("description-unicode", s1.clone()).lines(&agent("01", "réparer — ü 😀 done")).aged("out-01.txt", "{}\n", OLD));
    v.push(
        sc("description-cut-through-pair-defers", s1.clone())
            .lines(&agent("01", &format!("{}😀tail", "x".repeat(59))))
            .aged("out-01.txt", "{}\n", OLD)
            .defers(),
    );
    let other = "11111111-2222-3333-4444-555555555555";
    v.push(sc("previous-session-agent-is-skipped", s1.clone()).lines(&[task_status_typed(
        "0123456789abcdef",
        &format!("$HOME/p/{other}/tasks/0123456789abcdef.output"),
        "old lane",
        &ago(5400),
        "local_agent",
    )]));
    v.push(sc("previous-session-agent-no-session-still-judged", json!(null)).lines(&[task_status_typed(
        "0123456789abcdef",
        &format!("$HOME/p/{other}/tasks/0123456789abcdef.output"),
        "old lane",
        &ago(5400),
        "local_agent",
    )]));
    v.push(sc("own-session-dir-agent-nudges", json!(other)).lines(&[task_status_typed(
        "0123456789abcdef",
        &format!("$HOME/p/{other}/tasks/0123456789abcdef.output"),
        "old lane",
        &ago(5400),
        "local_agent",
    )]));
    v.push(sc("background-shell-named-as-shell", s1.clone()).lines(&[task_status_typed(
        "b9hc3cu3v",
        "$HOME/nope",
        "Restart the build-load throttle",
        &ago(5400),
        "local_bash",
    )]));
    v.push(sc("shell-and-agent-mixed-noun", s1.clone()).lines(&[
        task_status_typed("b9hc3cu3v", "$HOME/nope", "Restart the build-load throttle", &ago(5400), "local_bash"),
        task_status_typed("0123456789abcdef", "$HOME/nope", "an agent", &ago(5400), "local_agent"),
    ]));
    v.push(sc("no-description-names-id", s1.clone()).lines(&[task_status("0123456789abcdef", "$HOME/nope", "", &ago(5400))]));
    v.push(sc("sidechain-is-the-age", s1.clone()).lines(&one()).aged("out-01.txt", "{}\n", 7200).aged(
        &format!("t/session/subagents/agent-{}.jsonl", id("01")),
        "{}\n",
        OLD,
    ));
    v.push(sc("resumed-long-ago", s1.clone()).lines(&[one(), resume(&id("01"), "a1b2c3d", &ago(2730))].concat()).aged("out-01.txt", "{}\n", 7200));
    v.push(sc("threshold-fraction", s1.clone()).lines(&one()).aged("out-01.txt", "{}\n", OLD).env("ANTIHALL_SILENT_AGENT_NUDGE_MIN", "30.5"));
    v.push(sc("threshold-small", s1.clone()).lines(&one()).aged("out-01.txt", "{}\n", 400).env("ANTIHALL_SILENT_AGENT_NUDGE_MIN", "5"));
    v.push(sc("threshold-settings", s1.clone()).lines(&one()).aged("out-01.txt", "{}\n", OLD).settings(json!({"guards": {"silentAgentNudgeMin": 45}})));

    // ---- heartbeats
    v.push(sc("heartbeat-step-label", s1.clone()).file(".anti-hall/agents/hb1.json", &hb("hb1", "s1", Some("indexing  the\trepo"), 5400)));
    v.push(sc("heartbeat-id-label", s1.clone()).file(".anti-hall/agents/hb1.json", &hb("hb1", "s1", None, 5400)));
    v.push(
        sc("heartbeat-and-transcript-same-id-one-line", s1.clone())
            .lines(&one())
            .aged("out-01.txt", "{}\n", OLD)
            .file(".anti-hall/agents/x.json", &hb(&id("01"), "s1", Some("hb step"), 5400)),
    );
    v.push(
        sc("heartbeat-and-transcript-two-agents", s1.clone())
            .lines(&one())
            .aged("out-01.txt", "{}\n", OLD)
            .file(".anti-hall/agents/hb1.json", &hb("hb1", "s1", Some("other"), 5400)),
    );

    // ---- dedupe, the once-per-agent cap and its TTL, pruning
    v.push(sc("warm-second-stop-is-quiet", s1.clone()).lines(&one()).aged("out-01.txt", "{}\n", OLD).warm());
    v.push(sc("warm-no-session-second-stop-is-quiet", json!(null)).lines(&one()).aged("out-01.txt", "{}\n", OLD).warm());
    {
        let mut s = sc("warm-retouched-output-capped", s1.clone()).lines(&one()).aged("out-01.txt", "{}\n", OLD).warm();
        s.retouch = Some(("out-01.txt".into(), OLD + 300));
        v.push(s);
    }
    {
        let mut s = sc("warm-retouched-output-no-session-nudges-again", json!(null)).lines(&one()).aged("out-01.txt", "{}\n", OLD).warm();
        s.retouch = Some(("out-01.txt".into(), OLD + 300));
        v.push(s);
    }
    v.push(
        sc("warm-then-second-agent-nudges-only-it", s1.clone())
            .lines(&[one(), agent("02", "late")].concat())
            .aged("out-01.txt", "{}\n", OLD)
            .aged("out-02.txt", "{}\n", 60)
            .warm(),
    );
    v.push(sc("cap-expired-nudges", s1.clone()).lines(&one()).state(json!({}), json!({format!("s1::{}", id("01")): "$BASEMS-3456000"})));
    v.push(sc("cap-other-session-nudges", s1.clone()).lines(&one()).state(json!({}), json!({format!("s2::{}", id("01")): "$BASEMS-1"})));
    v.push(sc("cap-same-session-quiet", s1.clone()).lines(&one()).state(json!({}), json!({format!("s1::{}", id("01")): "$BASEMS-1"})));
    v.push(sc("old-snapshot-different-nudges", s1.clone()).lines(&one()).state(json!({format!("t:{}", id("01")): "123"}), json!({})));
    v.push(
        sc("prunes-dead-keys-and-nudges", s1.clone())
            .lines(&one())
            .state(json!({"t:gone": "x", "h:old": "5"}), json!({"s1::gone": "$BASEMS-1", "s0::x": "$BASEMS-4320000", "s9::kept": "$BASEMS-100"})),
    );
    v.push(sc("ever-values-coerced", s1.clone()).lines(&one()).file(
        ".anti-hall/silent-agent-nudge-state.json",
        "{\"nudged\":{},\"everNudged\":{\"a\":\"$BASEMS-5\",\"b\":null,\"c\":true,\"d\":[$BASEMS-6],\"e\":{},\"f\":\"\",\"g\":\"0x10\"}}",
    ));
    v.push(sc("state-corrupt-nudges", s1.clone()).lines(&one()).file(".anti-hall/silent-agent-nudge-state.json", "{oops"));
    v.push(
        sc("state-index-key-defers", s1.clone())
            .lines(&one())
            .file(".anti-hall/silent-agent-nudge-state.json", "{\"nudged\":{\"7\":\"x\"},\"everNudged\":{}}")
            .defers(),
    );

    // ---- the stale-build downgrade (stop-version-gate.js)
    v.push(sc("registry-newer-is-quiet-and-keeps-state", s1.clone()).lines(&one()).registry(&newer).state(json!({"t:gone": "x"}), json!({})));
    v.push(sc("registry-equal-nudges", s1.clone()).lines(&one()).registry(&ver));
    v.push(sc("registry-older-nudges", s1.clone()).lines(&one()).registry(&older));
    v.push(sc("registry-newer-v-prefixed", s1.clone()).lines(&one()).registry(&format!("v{newer}")));
    v.push(sc("registry-not-semver-nudges", s1.clone()).lines(&one()).registry("next"));
    v.push(sc("registry-corrupt-nudges", s1.clone()).lines(&one()).file(".claude/plugins/installed_plugins.json", "{nope"));
    v.push(
        sc("registry-legacy-string", s1.clone())
            .lines(&one())
            .file(".claude/plugins/installed_plugins.json", &json!({"anti-hall@anti-hall": newer}).to_string()),
    );
    v.push(sc("registry-newer-gate-off-env", s1.clone()).lines(&one()).registry(&newer).env("ANTIHALL_STOP_HOOK_VERSION_DOWNGRADE", "off"));
    v.push(sc("registry-newer-gate-off-settings", s1.clone()).lines(&one()).registry(&newer).settings(json!({"guards": {"stopHookVersionDowngrade": false}})));
    {
        // the update skill's test override: an absolute existing directory two levels below the registry
        let s = sc("registry-via-marketplace-override", s1.clone())
            .lines(&one())
            .file("mk/plugins/marketplaces/anti-hall/.keep", "")
            .file("mk/plugins/installed_plugins.json", &json!({"plugins": {"anti-hall@anti-hall": [{"scope": "project", "version": newer}]}}).to_string());
        v.push(s.env("ANTIHALL_MARKETPLACE_DIR", "$HOME/mk/plugins/marketplaces/anti-hall"));
    }
    {
        let mut s = sc("no-plugin-root-defers", s1.clone()).lines(&one()).defers();
        s.no_root = true;
        v.push(s);
    }

    // ---- the stop-ack (stop-ack.js)
    let sig1 = sha1_hex(&id("01"))[..16].to_string();
    v.push(sc("acked-is-quiet-and-writes-state", s1.clone()).lines(&one()).ack("s1", &json!({format!("silent-agent-nudge:{sig1}"): 5}).to_string()));
    v.push(
        sc("acked-but-ack-off-nudges", s1.clone())
            .lines(&one())
            .ack("s1", &json!({format!("silent-agent-nudge:{sig1}"): 5}).to_string())
            .env("ANTIHALL_STOP_ACK", "off"),
    );
    v.push(sc("ack-other-signature-nudges", s1.clone()).lines(&one()).ack("s1", &json!({"silent-agent-nudge:0000000000000000": 5}).to_string()));
    v.push(sc("ack-zero-nudges", s1.clone()).lines(&one()).ack("s1", &json!({format!("silent-agent-nudge:{sig1}"): 0}).to_string()));
    v.push(sc("ack-string-nudges", s1.clone()).lines(&one()).ack("s1", &json!({format!("silent-agent-nudge:{sig1}"): "5"}).to_string()));
    v.push(sc("ack-corrupt-nudges", s1.clone()).lines(&one()).ack("s1", "{nope"));
    v.push(sc("ack-list-nudges", s1.clone()).lines(&one()).ack("s1", "[5]"));
    v.push(sc("ack-lone-surrogate-defers", s1.clone()).lines(&one()).ack("s1", "{\"k\":\"\\ud800\"}").defers());
    {
        let sig2 = sha1_hex(&format!("{},{}", id("01"), id("02")))[..16].to_string();
        v.push(
            sc("acked-pair-sorted-ids", s1.clone())
                .lines(&[agent("02", "b"), agent("01", "a")].concat())
                .ack("s1", &json!({format!("silent-agent-nudge:{sig2}"): 5}).to_string()),
        );
    }
    v.push(sc("ack-path-sanitized-session", json!("s/1 é")).lines(&one()).ack("s_1__", &json!({format!("silent-agent-nudge:{sig1}"): 5}).to_string()));
    v.push(sc("ack-hint-sanitized-session", json!("weird id/😀")).lines(&one()));

    // ---- quiet controls
    v.push(sc("fresh-output-quiet", s1.clone()).lines(&one()).aged("out-01.txt", "{}\n", 60));
    v.push(sc("disabled-quiet", s1.clone()).lines(&one()).env("ANTIHALL_SILENT_AGENT_NUDGE", "off"));
    v
}

// ---- the lane ---------------------------------------------------------------------------------------------------

/// Write the scenario's files under `<root>/home`, with every `$HOME`, `$BASE-<s>` (ISO) and `$BASEMS-<s>` (ms) resolved.
fn build(root: &Path, sc: &Sc, lab: &Lab) {
    let home = root.join("home");
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    for f in &sc.files {
        let body = resolve(&f.body, &home, lab);
        let p = home.join(&f.rel);
        write_file(&p, body.as_bytes());
        if let Some(a) = f.age {
            set_mtime(&p, (lab.base - a) as f64);
        }
    }
}

fn resolve(s: &str, home: &Path, lab: &Lab) -> String {
    let t = s.replace("$HOME", &home.to_string_lossy());
    let re = regex::Regex::new(r"\$BASE(MS)?-(\d+)").unwrap();
    re.replace_all(&t, |c: &regex::Captures| {
        let ms = (lab.base - c[2].parse::<i64>().unwrap()) * 1000;
        if c.get(1).is_some() { ms.to_string() } else { iso_from_ms(ms) }
    })
    .to_string()
}

/// Paths to `$R`, and a 13-digit time within ten minutes of now to `<NOW>`.
fn norm(s: &str, root: &Path) -> String {
    let t = super::lab::norm_text(s, &root.to_string_lossy());
    let re = regex::Regex::new(r"\b\d{13}\b").unwrap();
    let now = now_ms() as i64;
    re.replace_all(&t, |c: &regex::Captures| {
        let n: i64 = c[0].parse().unwrap();
        if (n - now).abs() < 600_000 { "<NOW>".to_string() } else { c[0].to_string() }
    })
    .to_string()
}

struct Side {
    out: Out,
    files: BTreeMap<String, String>,
}

fn run_side(hooks: &Path, root: &Path, sc: &Sc, lab: &Lab, engine: bool) -> Side {
    wipe(root);
    build(root, sc, lab);
    let home = root.join("home");
    let path = std::env::var("PATH").unwrap_or_default();
    let mut env =
        env_of(&[("PATH", &path), ("HOME", &home.to_string_lossy()), ("ANTIHALL_TEST_ISOLATION", "1"), ("ANTIHALL_INGEST_DRY_RUN", "1"), ("TZ", "UTC")]);
    let extra: Vec<(String, Option<String>)> = sc.env.iter().map(|(k, v)| (k.clone(), Some(resolve(v, &home, lab)))).collect();
    env = env_merge(&env, &extra);
    let input = resolve(&sc.payload.to_string(), &home, lab);
    let hook = hooks.join(format!("{HOOK}.js")).to_string_lossy().to_string();
    let cwd = root.to_string_lossy().to_string();
    if sc.warm {
        node(&strs(&[&hook]), input.as_bytes(), &env, &cwd);
        if let Some((rel, age)) = &sc.retouch {
            set_mtime(&home.join(rel), (lab.base - age) as f64);
        }
    }
    let out = if engine {
        let mut e = env.clone();
        if !sc.no_root {
            let plugin = hooks.parent().unwrap().to_string_lossy().to_string();
            e = env_merge(&e, &vec![("AH_ENGINE_PLUGIN_ROOT".into(), Some(plugin))]);
        }
        run(ENGINE, &strs(&["check", HOOK]), input.as_bytes(), &e, &cwd)
    } else {
        node(&strs(&[&hook]), input.as_bytes(), &env, &cwd)
    };
    let files = snapshot(root, now_ms() as f64).into_iter().map(|(k, v)| (k, norm(&v, root))).collect();
    Side { out, files }
}

pub(crate) struct Report {
    pub n: usize,
    pub same: usize,
    pub deferred: usize,
    pub blocks: usize,
    pub mismatches: Vec<String>,
}

pub(crate) fn run_lane(hooks: &Path, scenarios: &[Sc], mutate: bool) -> Report {
    let scratch = Scratch::new("silent-nudge");
    let only = std::env::var("AH_PARITY_ONLY").ok();
    let mut rep = Report { n: 0, same: 0, deferred: 0, blocks: 0, mismatches: Vec::new() };
    for sc in scenarios {
        if only.as_ref().is_some_and(|o| !sc.id.contains(o.as_str())) {
            continue;
        }
        rep.n += 1;
        let lab = Lab { base: (now_ms() / 1000) as i64 };
        let root: PathBuf = scratch.path().join("s");
        let n = run_side(hooks, &root, sc, &lab, false);
        let e = run_side(hooks, &root, sc, &lab, true);
        wipe(&root);
        let mut nout = norm(&n.out.out, &root);
        if mutate {
            nout.push_str("~mutant");
        }
        if nout.contains("\"decision\":\"block\"") {
            rep.blocks += 1;
        }
        let deferred = e.out.out.trim() == "AHFALLBACK";
        if deferred {
            rep.deferred += 1;
            if !sc.defers {
                rep.mismatches.push(format!("--- {}: engine deferred (node: code={} out={})", sc.id, n.out.code, clip(&nout, 300)));
            }
            continue;
        }
        // a scripted check runs in a UTF-16 interpreter: a lone surrogate the compiled port could not hold is held, so the engine
        // may answer where it once deferred, as long as the answer is Node's
        let answered_like_node =
            (n.out.code.clone(), nout.clone(), norm(&n.out.err, &root)) == (e.out.code.clone(), norm(&e.out.out, &root), norm(&e.out.err, &root));
        if sc.defers && !answered_like_node {
            rep.mismatches.push(format!(
                "--- {}: expected a deferral (or Node's own answer), engine answered code={} out={}",
                sc.id,
                e.out.code,
                clip(&e.out.out, 300)
            ));
            continue;
        }
        let nr = (n.out.code.clone(), nout, norm(&n.out.err, &root));
        let er = (e.out.code.clone(), norm(&e.out.out, &root), norm(&e.out.err, &root));
        if nr == er && n.files == e.files {
            rep.same += 1;
        } else {
            let mut m = format!("--- {}\n  node  : {:?}\n  engine: {:?}\n", sc.id, nr, er);
            for k in n.files.keys().chain(e.files.keys()).collect::<std::collections::BTreeSet<_>>() {
                if n.files.get(k) != e.files.get(k) {
                    m.push_str(&format!("  file {k}\n    node  : {:?}\n    engine: {:?}\n", n.files.get(k), e.files.get(k)));
                }
            }
            rep.mismatches.push(m);
        }
    }
    rep
}

pub(crate) fn require(hooks: &Path) {
    let list = scenarios();
    let rep = run_lane(hooks, &list, false);
    println!(
        "silent-agent-nudge: scenarios={} same={} deferred={} node-blocks={} MISMATCH={}",
        rep.n,
        rep.same,
        rep.deferred,
        rep.blocks,
        rep.mismatches.len()
    );
    assert!(rep.mismatches.is_empty(), "silent-agent-nudge mismatches:\n{}", rep.mismatches.join("\n"));
    if std::env::var_os("AH_PARITY_ONLY").is_none() {
        assert!(rep.n >= 50, "only {} scenarios", rep.n);
        assert!(rep.blocks >= 30, "the corpus is vacuous: Node blocked in only {} scenarios", rep.blocks);
        assert!(rep.same >= rep.n - 5, "too few exact answers: {}/{}", rep.same, rep.n);
    }
}
