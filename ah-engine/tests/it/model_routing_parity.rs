//! Node-vs-engine parity for the built-in `model-routing` check.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// Child pairs and stateful sequences stay serial even under Cargo's parallel test harness.
static SERIAL: Mutex<()> = Mutex::new(());
static HOME_ID: AtomicUsize = AtomicUsize::new(0);

struct Case {
    name: String,
    payload: Value,
    raw: Option<String>,
    expect_divergence: bool,
    env: Vec<(&'static str, &'static str)>,
    skip: bool,
}

fn payload(tool_input: Value) -> Value {
    json!({"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":tool_input,"session_id":"t","cwd":std::env::current_dir().unwrap()})
}

fn payload_with_tool_name(tool_name: Option<&str>, tool_input: Value) -> Value {
    let mut p = serde_json::Map::new();
    p.insert("hook_event_name".into(), json!("PreToolUse"));
    if let Some(tool_name) = tool_name {
        p.insert("tool_name".into(), json!(tool_name));
    }
    p.insert("tool_input".into(), tool_input);
    p.insert("session_id".into(), json!("t"));
    p.insert("cwd".into(), json!(std::env::current_dir().unwrap()));
    Value::Object(p)
}

fn payload_raw_tool_input(tool_input: Option<Value>) -> Value {
    let mut p = serde_json::Map::new();
    p.insert("hook_event_name".into(), json!("PreToolUse"));
    p.insert("tool_name".into(), json!("Agent"));
    p.insert("session_id".into(), json!("t"));
    p.insert("cwd".into(), json!(std::env::current_dir().unwrap()));
    if let Some(ti) = tool_input {
        p.insert("tool_input".into(), ti);
    }
    Value::Object(p)
}

fn temp_home(tag: &str) -> PathBuf {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let d = std::env::temp_dir().join(format!("ah-model-routing-{tag}-{}-{nonce}-{}", std::process::id(), HOME_ID.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d
}

fn run(mut cmd: Command, input: &str) -> (i32, Vec<u8>, Vec<u8>) {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.as_bytes().to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let stdout_reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        stdout.read_to_end(&mut b).unwrap();
        b
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        stderr.read_to_end(&mut b).unwrap();
        b
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break (status, false);
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            break (child.wait().unwrap(), true);
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let written = writer.join().unwrap();
    let out = stdout_reader.join().unwrap();
    let err = stderr_reader.join().unwrap();
    assert!(!timed_out, "child exceeded 15 seconds: {cmd:?}");
    written.unwrap();
    (status.code().unwrap_or(-1), out, err)
}

fn run_node(repo: &Path, home: &Path, case: &Case, input: &str) -> (i32, Vec<u8>, Vec<u8>) {
    let mut c = Command::new("node");
    c.arg(repo.join("plugins/anti-hall/hooks/model-routing-guard.js"))
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1");
    for (k, v) in &case.env {
        c.env(k, v);
    }
    run(c, input)
}

fn run_engine(home: &Path, case: &Case, input: &str) -> (i32, Vec<u8>, Vec<u8>) {
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check")
        .arg("model-routing")
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("AH_ENGINE_DIR", home.join("engine"))
        .env("ANTIHALL_TEST_ISOLATION", "1");
    for (k, v) in &case.env {
        c.env(k, v);
    }
    run(c, input)
}

fn cases() -> Vec<Case> {
    let mut out = Vec::new();
    fn add(out: &mut Vec<Case>, name: &str, tool_input: Value) {
        out.push(Case { name: name.into(), payload: payload(tool_input), raw: None, expect_divergence: false, env: Vec::new(), skip: false });
    }
    fn raw_diverges(out: &mut Vec<Case>, name: &str, input: &str) {
        out.push(Case { name: name.into(), payload: Value::Null, raw: Some(input.into()), expect_divergence: true, env: Vec::new(), skip: false });
    }
    add(
        &mut out,
        "row1-opus-block",
        json!({"model":"opus","subagent_type":"general-purpose","description":"fetch logs","prompt":"curl endpoint and download dump, then tail logs"}),
    );
    out.push(Case {
        name: "task-row1-opus-block".into(),
        payload: json!({"hook_event_name":"PreToolUse","tool_name":"Task","tool_input":{"model":"opus","subagent_type":"general-purpose","description":"fetch logs","prompt":"curl endpoint and download dump, then tail logs"},"session_id":"t","cwd":std::env::current_dir().unwrap()}),
        raw: None,
        expect_divergence: false,
        env: Vec::new(),
        skip: false,
    });
    for (name, tool_name) in [
        ("tool-name-missing-row1-opus-block", None),
        ("tool-name-space-row1-opus-block", Some("Agent ")),
        ("tool-name-workflow-row1-opus-block", Some("Workflow")),
        ("tool-name-codex-task-row1-opus-block", Some("codex:Task")),
        ("tool-name-spawn-agent-row1-opus-block", Some("spawn_agent")),
    ] {
        out.push(Case {
            name: name.into(),
            payload: payload_with_tool_name(
                tool_name,
                json!({"model":"opus","subagent_type":"general-purpose","description":"fetch logs","prompt":"fetch logs and list files"}),
            ),
            raw: None,
            expect_divergence: false,
            env: Vec::new(),
            skip: false,
        });
    }
    add(
        &mut out,
        "row1-role-advice",
        json!({"model":"fable","subagent_type":"general-purpose","description":"Round 1 Reviewer","prompt":"fetch and grep logs, run the build"}),
    );
    add(
        &mut out,
        "row1-research-advice",
        json!({"model":"opus","subagent_type":"general-purpose","description":"investigate population","prompt":"check status and export findings"}),
    );
    add(&mut out, "row2-strict-block", json!({"subagent_type":"general-purpose","prompt":"fetch and download dump, tail logs"}));
    out.push(Case {
        name: "row2-advisory-env".into(),
        payload: payload(json!({"subagent_type":"general-purpose","prompt":"fetch and grep and tail logs, run the build"})),
        raw: None,
        expect_divergence: false,
        env: vec![("ANTIHALL_MODEL_ROUTING", "advisory")],
        skip: false,
    });
    out.push(Case {
        name: "invalid-enum-env-falls-through-to-file".into(),
        payload: payload(json!({"subagent_type":"general-purpose","prompt":"fetch and download dump, tail logs"})),
        raw: None,
        expect_divergence: false,
        env: vec![("ANTIHALL_MODEL_ROUTING", "invalid")],
        skip: false,
    });
    add(&mut out, "row3-custom-advice", json!({"model":"opus","subagent_type":"custom-fetcher","prompt":"fetch and download dump, tail logs"}));
    add(
        &mut out,
        "row4-haiku-plan",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"Design architecture","prompt":"deep code review and security audit"}),
    );
    add(
        &mut out,
        "row4-suppressed",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"List merge order","prompt":"Read-only. Run exactly `git log --oneline -5` and nothing else; return at most 5 lines showing the merge order."}),
    );
    add(&mut out, "row5-haiku-mechanical", json!({"model":"haiku","subagent_type":"general-purpose","prompt":"fetch and download dump, tail logs"}));
    add(&mut out, "unknown-model", json!({"model":"some-future-tier","subagent_type":"general-purpose","prompt":"fetch and download and tail logs"}));
    add(
        &mut out,
        "complex-veto",
        json!({"model":"fable","subagent_type":"general-purpose","description":"fetch data","prompt":"fetch then plan the migration"}),
    );
    add(
        &mut out,
        "fullwidth",
        json!({"model":"opus","subagent_type":"general-purpose","description":"ＦＥＴＣＨ data","prompt":"GREP files and TAIL LOGS and GIT PUSH"}),
    );
    add(
        &mut out,
        "research-explore",
        json!({"model":"sonnet","subagent_type":"general-purpose","description":"research X","prompt":"investigate and find usages, gather results"}),
    );
    add(
        &mut out,
        "research-write-suppress",
        json!({"model":"sonnet","subagent_type":"general-purpose","description":"audit diff then commit","prompt":"find changed files, apply patch, commit and push"}),
    );
    add(
        &mut out,
        "handover-advice",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"write handover","prompt":"write a detailed handover for the next session"}),
    );
    add(
        &mut out,
        "deploy-opus-allow",
        json!({"model":"opus","subagent_type":"general-purpose","description":"deploy web UI","prompt":"Run `wrangler r2 bucket cors set` then tools/deploy_webui.sh prod"}),
    );
    add(
        &mut out,
        "deploy-haiku-advice",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"deploy web UI","prompt":"Run `wrangler r2 bucket cors set` then tools/deploy_webui.sh prod"}),
    );
    out.push(Case {
        name: "deploy-floor-off".into(),
        payload: payload(json!({"model":"opus","subagent_type":"general-purpose","description":"deploy web UI","prompt":"Run `wrangler r2 bucket cors set` then tools/deploy_webui.sh prod"})),
        raw: None,
        expect_divergence: false,
        env: vec![("ANTIHALL_MODEL_ROUTING_DEPLOY_FLOOR", "off")],
        skip: false,
    });
    add(
        &mut out,
        "update-block",
        json!({"model":"sonnet","subagent_type":"general-purpose","description":"update","prompt":"Please run /anti-hall:update and report"}),
    );
    add(
        &mut out,
        "reasoning-veto",
        json!({"model":"opus","subagent_type":"general-purpose","description":"Summarize report","prompt":"Summarize the attached document, synthesize findings and export them."}),
    );
    out.push(Case {
        name: "skip-hatch".into(),
        payload: payload(json!({"model":"opus","subagent_type":"general-purpose","prompt":"fetch and download and tail logs"})),
        raw: None,
        expect_divergence: false,
        env: Vec::new(),
        skip: true,
    });
    raw_diverges(&mut out, "raw-empty-stdin", "");
    raw_diverges(&mut out, "raw-malformed-json", "{bad");
    add(&mut out, "nonnull-tool-input-json", json!(null));
    out.push(Case {
        name: "missing-tool-input".into(),
        payload: payload_raw_tool_input(None),
        raw: None,
        expect_divergence: false,
        env: Vec::new(),
        skip: false,
    });
    out.push(Case {
        name: "null-tool-input".into(),
        payload: payload_raw_tool_input(Some(Value::Null)),
        raw: None,
        expect_divergence: false,
        env: Vec::new(),
        skip: false,
    });
    out.push(Case {
        name: "string-tool-input".into(),
        payload: payload_raw_tool_input(Some(json!("research and find usages"))),
        raw: None,
        expect_divergence: false,
        env: Vec::new(),
        skip: false,
    });
    out.push(Case {
        name: "array-tool-input".into(),
        payload: payload_raw_tool_input(Some(json!(["research"]))),
        raw: None,
        expect_divergence: false,
        env: Vec::new(),
        skip: false,
    });
    add(&mut out, "non-string-fields", json!({"model":123,"subagent_type":["x"],"description":{"a":1},"prompt":null}));
    add(
        &mut out,
        "row1-role-word-prompt-only-block",
        json!({"model":"opus","subagent_type":"general-purpose","description":"download export","prompt":"as the critic, fetch and curl and tail logs and git push"}),
    );
    add(
        &mut out,
        "row1-research-hard-exec-block",
        json!({"model":"opus","subagent_type":"general-purpose","description":"investigate build then install it","prompt":"install dependencies and run tests before building"}),
    );
    add(
        &mut out,
        "row1-ambiguous-no-research-block",
        json!({"model":"opus","subagent_type":"general-purpose","description":"export report","prompt":"dump the list and check status"}),
    );
    add(
        &mut out,
        "row2-role-words-still-block",
        json!({"subagent_type":"general-purpose","description":"Reviewer auditor critic","prompt":"fetch and download and tail logs"}),
    );
    add(
        &mut out,
        "row4-audit-key-suppressed",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"Enable jev.audit.snippets via settings CLI","prompt":"Owner-authorized single config change. Use the settings CLI to set `jev.audit.snippets` to true."}),
    );
    add(
        &mut out,
        "row4-report-status-suppressed",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"Read Jev report (hourly watch)","prompt":"Run exactly this read-only command and nothing else: `node scripts/jev-report.js`. Return the headline lines and any REVIEW or REMOVE verdicts."}),
    );
    add(
        &mut out,
        "row4-ledger-design-suppressed",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"Ledger + progress for v0.95.0","prompt":"Two edits with the Edit tool only (no git; touch nothing else). Append to the ledger: ## Release v0.95.0 -- plan change accepted, design decision recorded."}),
    );
    add(
        &mut out,
        "row4-deep-code-review",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"Deep code review of parser","prompt":"Do a deep code review of the new parser module and flag design smells."}),
    );
    add(
        &mut out,
        "row4-security-audit",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"Security audit of auth","prompt":"Perform a security audit of the authentication flow for injection and privilege-escalation risks."}),
    );
    add(
        &mut out,
        "row4-root-cause-analysis",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"Root cause analysis of flaky test","prompt":"Do a root cause analysis of the flaky CI test, considering timing and shared state."}),
    );
    add(
        &mut out,
        "row4-readonly-code-review",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"Read-only code review of settings.js","prompt":"READ-ONLY code review of hooks/lib/settings.js. Do not edit any file. Report correctness bugs with file:line."}),
    );
    add(
        &mut out,
        "row4-review-pr",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"Review this PR","prompt":"Review this PR for correctness and missing tests. Read-only: do not push or edit."}),
    );
    add(
        &mut out,
        "row4-root-cause-ledger-suppressed",
        json!({"model":"haiku","subagent_type":"general-purpose","description":"Ledger: hang root cause confirmed","prompt":"Using the Edit tool only (no git; touch nothing else), append to the ledger: - Root cause: the store lock was held across the fsync. (f3b8 root cause)."}),
    );
    add(
        &mut out,
        "scan-limit-past",
        json!({"model":"opus","subagent_type":"general-purpose","description":"neutral header","prompt":format!("{} fetch download tail logs git push", "x ".repeat(70 * 1024))}),
    );
    add(
        &mut out,
        "scan-limit-within",
        json!({"model":"opus","subagent_type":"general-purpose","description":"fetch and download the dump","prompt":"x ".repeat(70 * 1024)}),
    );
    add(&mut out, "handover-prompt", json!({"description":"session wrap-up","prompt":"please prepare a handoff document for the next session"}));
    add(
        &mut out,
        "handover-noun-without-write-verb",
        json!({"description":"review the handover for accuracy","prompt":"check that the existing handover reflects reality"}),
    );
    add(
        &mut out,
        "handover-intercepts-row1",
        json!({"model":"opus","subagent_type":"general-purpose","description":"write the session handover","prompt":"run the build and git push, then draft the handover"}),
    );
    add(
        &mut out,
        "deploy-sonnet-allow",
        json!({"model":"sonnet","subagent_type":"general-purpose","description":"run db migrate","prompt":"run the database migration then check status"}),
    );
    add(
        &mut out,
        "deploy-omitted-secret-advice",
        json!({"subagent_type":"general-purpose","description":"token rotation","prompt":"download the new credentials and run script rotate.sh"}),
    );
    out.push(Case { name: "deploy-floor-opus".into(), payload: payload(json!({"model":"sonnet","subagent_type":"general-purpose","description":"deploy","prompt":"Run `wrangler r2 bucket cors set` for the assets bucket, then tools/deploy_webui.sh prod"})), raw: None, expect_divergence: false, env: vec![("ANTIHALL_MODEL_ROUTING_DEPLOY_FLOOR", "opus")], skip: false });
    add(
        &mut out,
        "deploy-one-weak-word-block",
        json!({"model":"opus","subagent_type":"general-purpose","description":"grep for TODO","prompt":"grep for TODO markers in src and list them, no secrets involved"}),
    );
    add(
        &mut out,
        "deploy-two-weak-words-prod-credentials-allow",
        json!({"model":"opus","subagent_type":"general-purpose","description":"update prod credentials","prompt":"download the new credentials and install them on the prod box"}),
    );
    add(
        &mut out,
        "deploy-shaped-still-allows-row6-explore-advisory",
        json!({"model":"opus","subagent_type":"general-purpose","description":"audit prod secrets usage","prompt":"investigate where prod secrets are read and map every call site"}),
    );
    for (name, prompt) in [
        ("deploy-sentence-production", "deploy the webui to production"),
        ("deploy-sentence-run-deploy", "run the deploy"),
        ("deploy-sentence-firebase", "firebase deploy --only functions"),
    ] {
        add(&mut out, name, json!({"model":"opus","subagent_type":"general-purpose","description":"deploy","prompt":prompt}));
    }
    add(
        &mut out,
        "reasoning-pdf-read-synthesize-kb",
        json!({"model":"opus","subagent_type":"general-purpose","description":"Ingest PDF source","prompt":"Download the 45-page PDF from the KB inbox, read it page by page, write a source note, amend and reconcile the KB docs, list what changed, then commit/push."}),
    );
    add(
        &mut out,
        "reasoning-code-span-does-not-count",
        json!({"model":"opus","subagent_type":"general-purpose","description":"run cmd","prompt":"Run `jev analyze --summarize` then download the dump and tail the logs."}),
    );
    for (name, prompt) in [
        ("write-save-findings", "Find the root cause of the flaky test. Save the full findings to /private/tmp/x/scratchpad/findings.md and report a summary."),
        ("write-clone-generator", "Search the repo for stale docs. Clone the repo into scratchpad/work, run the generator, and report which files changed."),
        ("write-create-files", "Gather the schema keys, then create new files for each group under docs/ and report the paths."),
        ("write-format-patch", "Locate the regression, then run git format-patch for it into the patches dir."),
    ] {
        add(&mut out, name, json!({"model":"sonnet","subagent_type":"general-purpose","description":"research task","prompt":prompt}));
    }
    for (name, prompt) in [
        ("readonly-build-word", "research how the build works and report"),
        ("readonly-release-tag", "find where the release tag is created, report only"),
        ("readonly-negated-edit", "investigate how fixes are applied; do not edit anything"),
        ("readonly-patch-notes", "locate the patch notes and summarize"),
        ("readonly-save-handled", "find where save is handled"),
        ("readonly-clone-logic", "investigate how files get saved and the clone logic"),
        ("readonly-generator-places", "find all places that run the generator"),
    ] {
        add(&mut out, name, json!({"model":"sonnet","subagent_type":"general-purpose","description":"research task","prompt":prompt}));
    }
    add(
        &mut out,
        "imperative-fix-suppresses-explore",
        json!({"model":"sonnet","subagent_type":"general-purpose","description":"research task","prompt":"find the bug, then fix it"}),
    );
    add(
        &mut out,
        "omitted-build-strict-before-row6",
        json!({"subagent_type":"general-purpose","description":"research task","prompt":"research how the build works and report"}),
    );

    // Remaining payload classes in both model-routing-guard*.test.js files.
    // Their hooks.json registration-order assertion is not a payload class.
    for (name, ti) in [
        (
            "row1-fable",
            json!({"model":"fable","subagent_type":"general-purpose","description":"fetch the data","prompt":"curl the endpoint and download the dump, then tail the logs"}),
        ),
        ("row1-missing-subagent", json!({"model":"opus","prompt":"run the build and run the tests, then git push"})),
        ("row5-sonnet-mechanical", json!({"model":"sonnet","prompt":"fetch and download dump, tail logs"})),
        ("row5-no-signals", json!({"model":"opus","description":"handle task","prompt":"do the thing quietly"})),
        ("word-boundary", json!({"model":"fable","description":"set up a listener","prompt":"the listener handles inbound connections quietly"})),
        (
            "row6-no-model",
            json!({"subagent_type":"general-purpose","description":"investigate the codebase structure","prompt":"research and find all usages of the deprecated API, then gather results"}),
        ),
        (
            "row6-explore",
            json!({"model":"haiku","subagent_type":"Explore","description":"investigate the codebase structure","prompt":"search and find all usages of the deprecated API"}),
        ),
        (
            "row6-implementation",
            json!({"model":"sonnet","subagent_type":"general-purpose","description":"implement the new feature","prompt":"write the code to add user authentication with JWT tokens"}),
        ),
        (
            "row6-codex-rescue",
            json!({"model":"sonnet","subagent_type":"codex:codex-rescue","description":"investigate and research the bug","prompt":"scout the codebase to locate the failing module"}),
        ),
        (
            "row4-readonly-security-audit",
            json!({"model":"haiku","description":"Read-only security audit of auth","prompt":"Read-only security audit of the authentication flow. Do not edit files."}),
        ),
        ("row4-review-diff", json!({"model":"haiku","description":"review the diff","prompt":"review the diff for correctness"})),
        ("row4-audit-the", json!({"model":"haiku","description":"audit the parser","prompt":"audit the parser for correctness"})),
        ("row4-find-root-cause", json!({"model":"haiku","description":"find the root cause","prompt":"find the root cause of the flaky test"})),
        (
            "reasoning-mixed-analyze",
            json!({"model":"opus","description":"build and analyze","prompt":"Run the build, download the artifacts, then analyze the output and explain regressions."}),
        ),
        ("reasoning-pure-run-tests", json!({"model":"opus","description":"run tests","prompt":"Run npm test and report the results. List failing files."})),
        ("reasoning-pure-read-logs", json!({"model":"opus","description":"fetch logs","prompt":"Read logs and list the errors, then export them to a file."})),
        ("reasoning-pure-build", json!({"model":"opus","description":"build","prompt":"Install dependencies, run the build, then git push."})),
        ("reasoning-bare-read-logs", json!({"model":"opus","description":"tail","prompt":"Read logs, tail the output and download the dump."})),
        (
            "readonly-haiku-build",
            json!({"model":"haiku","description":"research how the build works and report","prompt":"research how the build works and report"}),
        ),
        ("readonly-null-model-build", json!({"model":null,"description":"research task","prompt":"research how the build works and report"})),
    ] {
        add(&mut out, name, ti);
    }
    for (name, prompt) in [
        ("write-save-into", "Search for config drift, then save the findings into /private/tmp/out.md"),
        ("readonly-writing-noun", "describe how the writing of settings happens"),
        ("readonly-survey-hooks", "Locate and map every hook that reads settings.json and report the keys each one reads. Report only."),
        ("write-imperative-start-fix", "Fix the failing hook and report"),
        ("write-imperative-install", "investigate the module and install the deps"),
        ("update-other-dependencies", "Update the npm dependencies in package.json and run the tests"),
        ("update-other-docs", "Fix the update.js docs typo in the changelog"),
        ("update-other-project", "Run node scripts/update.js for the billing project"),
        (
            "update-helper-quoted",
            "Run exactly: node \"$HOME/.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/skills/update/scripts/update.js\" --check",
        ),
        ("update-helper-qualified", "In the anti-hall checkout run node ./update.js and report"),
    ] {
        add(&mut out, name, json!({"model":"sonnet","subagent_type":"general-purpose","description":"research task","prompt":prompt}));
    }
    add(&mut out, "update-setting-off", json!({"model":"sonnet","description":"update","prompt":"Run node plugins/anti-hall/skills/update/scripts/update.js"}));
    out.last_mut().unwrap().env.push(("ANTIHALL_UPDATE_IN_SESSION", "0"));
    add(&mut out, "routing-setting-off", json!({"model":"opus","prompt":"fetch and download dump, tail logs"}));
    out.last_mut().unwrap().env.push(("ANTIHALL_MODEL_ROUTING", "off"));
    for (name, prompt) in [("routing-off-update", "Run /anti-hall:update"), ("routing-off-handover", "write the session handover")] {
        add(&mut out, name, json!({"model":"opus","prompt":prompt}));
        out.last_mut().unwrap().env.push(("ANTIHALL_MODEL_ROUTING", "off"));
    }
    for (name, prompt) in [("fetch-combining-greek", "fetch\u{0345}"), ("fetch-combining-hebrew", "fetch\u{05b0}"), ("fetch-enclosed-symbol", "fetch\u{1f170}")]
    {
        add(&mut out, name, json!({"model":"opus","prompt":prompt}));
    }
    add(&mut out, "no-parent-inference", json!({"prompt":"fetch and download dump, tail logs"}));
    for (name, ti) in [
        (
            "jev-row1-block",
            json!({"model":"opus","subagent_type":"general-purpose","description":"fetch the data","prompt":"curl the endpoint and download the dump, then tail the logs"}),
        ),
        ("jev-row2-block", json!({"subagent_type":"general-purpose","prompt":"curl the endpoint and download the dump"})),
        ("jev-allow", json!({"model":"haiku","subagent_type":"general-purpose","prompt":"curl the endpoint and download the dump"})),
        ("jev-advisory", json!({"model":"opus","subagent_type":"executor","prompt":"curl the endpoint and download the dump"})),
    ] {
        add(&mut out, name, ti);
        out.last_mut()
            .unwrap()
            .env
            .extend([("ANTIHALL_JEV_TEST_ENDPOINT", "http://127.0.0.1:9/unreachable"), ("CLAUDE_PLUGIN_OPTION_JEV_API_KEY", "test-key")]);
    }

    let models = [None, Some("opus"), Some("fable"), Some("haiku"), Some("sonnet"), Some("future")];
    let subs = [None, Some("general-purpose"), Some("Explore"), Some("custom")];
    let prompts = [
        ("mech", "fetch and download dump then tail logs"),
        ("hard", "install dependencies and run tests then git push"),
        ("research", "investigate the module and find usages, report only"),
        ("write", "research task, then save the findings to /tmp/out.md"),
        ("plan", "design the architecture and do a deep review"),
        ("none", "handle the thing quietly"),
        ("reason", "download the 45-page PDF, read it page by page and synthesize findings"),
        ("deploy", "firebase deploy --only functions"),
        ("quoted", "Run `jev analyze --summarize` then download the dump and tail logs"),
        ("boundary", "the listener handles inbound connections quietly"),
    ];
    for (pi, (pname, prompt_text)) in prompts.iter().enumerate() {
        for (mi, model) in models.iter().enumerate() {
            for (si, sub) in subs.iter().enumerate() {
                let mut ti = serde_json::Map::new();
                if let Some(m) = model {
                    ti.insert("model".into(), json!(m));
                }
                if let Some(s) = sub {
                    ti.insert("subagent_type".into(), json!(s));
                }
                ti.insert("description".into(), json!(format!("{pname} case {pi}-{mi}-{si}")));
                ti.insert("prompt".into(), json!(prompt_text));
                out.push(Case {
                    name: format!("generated-{pname}-{pi}-{mi}-{si}"),
                    payload: payload(Value::Object(ti)),
                    raw: None,
                    expect_divergence: false,
                    env: Vec::new(),
                    skip: false,
                });
            }
        }
    }
    for (label, tool_name) in [
        ("tool-missing", None),
        ("tool-space", Some("Agent ")),
        ("tool-workflow", Some("Workflow")),
        ("tool-codex-task", Some("codex:Task")),
        ("tool-spawn-agent", Some("spawn_agent")),
    ] {
        out.push(Case {
            name: format!("generated-{label}"),
            payload: payload_with_tool_name(
                tool_name,
                json!({"model":"opus","subagent_type":"general-purpose","description":"generated tool-name parity","prompt":"fetch and download dump then tail logs"}),
            ),
            raw: None,
            expect_divergence: false,
            env: Vec::new(),
            skip: false,
        });
    }
    out
}

fn decision(result: &(i32, Vec<u8>, Vec<u8>)) -> &'static str {
    if result.1.is_empty() {
        assert_eq!(result.0, 0, "silent output must allow");
        return "allow";
    }
    let output: Value = serde_json::from_slice(&result.1).expect("hook stdout must be JSON");
    if output.get("decision") == Some(&json!("block")) {
        assert_eq!(result.0, 2, "block must exit 2");
        "block"
    } else {
        assert_eq!(result.0, 0, "advisory must exit 0");
        assert_eq!(output["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert!(output["hookSpecificOutput"]["additionalContext"].is_string());
        "advise"
    }
}

fn initialize(home: &Path, case: &Case) {
    if case.name == "invalid-enum-env-falls-through-to-file" {
        std::fs::write(home.join(".anti-hall/settings.json"), json!({"guards":{"modelRouting":"advisory"}}).to_string()).unwrap();
    }
    if case.skip {
        std::fs::write(home.join(".anti-hall/skip.json"), json!({"model-routing-guard":4_102_444_800_000u64}).to_string()).unwrap();
    }
    if case.name.starts_with("jev-") {
        std::fs::write(home.join(".anti-hall/jev.json"), json!({"enabled":true,"integrations":{"modelRouting":"on"}}).to_string()).unwrap();
    }
    if case.name == "no-parent-inference" {
        std::fs::write(home.join(".claude.json"), "not JSON: parent-model sentinel").unwrap();
    }
}

fn jev_rows(home: &Path) -> Vec<Value> {
    std::fs::read_to_string(home.join(".anti-hall/logs/jev-assist.ndjson"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|row| row["id"] == "modelRouting")
        .collect()
}

fn assert_route_metadata(case: &Case, home: &Path, node: &(i32, Vec<u8>, Vec<u8>)) -> bool {
    use ah_engine::checks::{Check, Verdict, model_routing::ModelRouting};
    use ah_engine::reqenv::RequestEnv;
    use ah_engine::rules::Subject;
    let expected = match case.name.as_str() {
        "row1-opus-block" => ("mechanical", "haiku", "haiku", "down", true, "opus"),
        "tool-name-missing-row1-opus-block" => ("mechanical", "haiku", "haiku", "down", true, "opus"),
        "tool-name-space-row1-opus-block" => ("mechanical", "haiku", "haiku", "down", true, "opus"),
        "tool-name-workflow-row1-opus-block" => ("mechanical", "haiku", "haiku", "down", true, "opus"),
        "tool-name-codex-task-row1-opus-block" => ("mechanical", "haiku", "haiku", "down", true, "opus"),
        "tool-name-spawn-agent-row1-opus-block" => ("mechanical", "haiku", "haiku", "down", true, "opus"),
        "row2-strict-block" => ("mechanical", "haiku", "haiku", "down", true, "inherit:unknown"),
        "row1-role-advice" => ("mechanical", "haiku", "haiku", "down", false, "fable"),
        "research-explore" => ("research", "Explore", "sonnet", "exempt", false, "sonnet"),
        "deploy-haiku-advice" => ("deploy", "sonnet", "sonnet", "up", false, "haiku"),
        "row5-haiku-mechanical" => ("unknown", "haiku", "haiku", "allow", false, "haiku"),
        _ => return false,
    };
    let mut pairs = vec![("HOME".to_string(), home.to_string_lossy().into_owned())];
    pairs.extend(case.env.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let env = RequestEnv::from_pairs(pairs);
    let subject = Subject { event: "PreToolUse", tool: Some("Agent"), cwd: None, tool_input: &case.payload["tool_input"], prompt: None };
    let verdict = ModelRouting.run_env(&subject, &case.payload, &Value::Null, &env).unwrap();
    let Verdict::Routed(inner, meta) = verdict else { panic!("{}: route telemetry missing", case.name) };
    assert_eq!(meta.len(), 1, "{}: exactly one route", case.name);
    let route = &meta[0];
    assert_eq!(
        (
            route.task_class.as_str(),
            route.recommended_tier.as_str(),
            route.selected_model.as_str(),
            route.outcome.as_str(),
            route.delegate,
            route.requested_model.as_str()
        ),
        expected,
        "{}: telemetry",
        case.name
    );
    assert_eq!(route.parent_model, "inherit:unknown");
    assert!(!route.spawn_key.is_empty());
    let output = match *inner {
        Verdict::Exact(x) => (x.code, x.out.into_bytes(), x.err.into_bytes()),
        Verdict::Allow => (0, Vec::new(), Vec::new()),
        other => panic!("{}: unexpected routed verdict: {other:?}", case.name),
    };
    assert_eq!(&output, node, "{}: telemetry wrapper preserves exact Node output", case.name);
    true
}

#[test]
fn node_and_engine_outputs_match_for_model_routing_table() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let rows: Vec<_> = cases().into_iter().filter(|case| !case.expect_divergence).collect();
    let generated = rows.iter().filter(|case| case.name.starts_with("generated-")).count();
    assert!(generated >= 200, "need at least 200 generated rows independently of fixtures, got {generated}");
    assert_eq!(generated, 10 * 6 * 4 + 5, "generated Cartesian corpus plus tool-name rows must not silently shrink");
    let mut mismatches = Vec::new();
    let mut telemetry_fixtures = 0;
    for (i, case) in rows.iter().enumerate() {
        let node_home = temp_home(&format!("node-{i}"));
        let rust_home = temp_home(&format!("rust-{i}"));
        initialize(&node_home, case);
        initialize(&rust_home, case);
        let input = case.raw.clone().unwrap_or_else(|| serde_json::to_string(&case.payload).unwrap());
        let node = run_node(&repo, &node_home, case, &input);
        let rust = run_engine(&rust_home, case, &input);
        if case.name.starts_with("jev-") {
            let expected = usize::from(case.name.ends_with("-block"));
            for (label, home) in [("node", &node_home), ("rust", &rust_home)] {
                let logged = jev_rows(home);
                assert_eq!(logged.len(), expected, "{}: {label} Jev rows: {logged:?}", case.name);
                for row in logged {
                    assert_eq!(row["mode"], "on");
                    assert_eq!(row["base"], true);
                    assert_eq!(row["final"], true);
                    assert_eq!(row["backend"], "baseline-only");
                }
            }
        }
        if case.name == "no-parent-inference" {
            for home in [&node_home, &rust_home] {
                assert_eq!(std::fs::read_to_string(home.join(".claude.json")).unwrap(), "not JSON: parent-model sentinel");
            }
        }
        telemetry_fixtures += usize::from(assert_route_metadata(case, &rust_home, &node));
        if decision(&node) != decision(&rust) || node != rust {
            mismatches.push(format!(
                "{}: {}\nnode=({}, {:?}, {:?})\nrust=({}, {:?}, {:?})",
                i,
                case.name,
                node.0,
                String::from_utf8_lossy(&node.1),
                String::from_utf8_lossy(&node.2),
                rust.0,
                String::from_utf8_lossy(&rust.1),
                String::from_utf8_lossy(&rust.2)
            ));
        }
        ah_engine::discard::harmless(std::fs::remove_dir_all(node_home));
        ah_engine::discard::harmless(std::fs::remove_dir_all(rust_home));
    }
    assert!(mismatches.is_empty(), "{} / {} parity rows mismatched:\n{}", mismatches.len(), rows.len(), mismatches.join("\n\n"));
    assert_eq!(telemetry_fixtures, 11);
    println!("model-routing parity: {} / {} exact matches ({generated} generated, {} fixtures); D74 excluded", rows.len(), rows.len(), rows.len() - generated);
    println!("model-routing telemetry: {telemetry_fixtures} route metadata fixtures preserve exact Node output");
}

#[test]
fn same_home_repeated_handover_and_update_parity() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let node_home = temp_home("node-sequence");
    let rust_home = temp_home("rust-sequence");
    let mut compared = 0;
    for (name, ti, expected) in [
        ("handover-simple", json!({"description":"write a handover","prompt":"draft the session handover now"}), ["advise", "allow"]),
        (
            "handover-block-fallthrough",
            json!({"model":"opus","description":"write the session handover","prompt":"run the build and git push, then draft the handover"}),
            ["advise", "block"],
        ),
        ("update", json!({"model":"sonnet","prompt":"Please run /anti-hall:update and report"}), ["block", "block"]),
        ("update-helper", json!({"model":"sonnet","prompt":"Run node plugins/anti-hall/skills/update/scripts/update.js"}), ["block", "block"]),
    ] {
        let mut p = payload(ti);
        p["session_id"] = json!(format!("sequence-{name}"));
        let case = Case { name: name.into(), payload: p, raw: None, expect_divergence: false, env: Vec::new(), skip: false };
        let input = serde_json::to_string(&case.payload).unwrap();
        for wanted in expected {
            let node = run_node(&repo, &node_home, &case, &input);
            let rust = run_engine(&rust_home, &case, &input);
            assert_eq!(decision(&node), wanted, "{name}: Node state transition");
            assert_eq!(decision(&rust), wanted, "{name}: Rust state transition");
            assert_eq!(node, rust, "{name}: exact output in retained HOME");
            compared += 1;
        }
    }
    ah_engine::discard::harmless(std::fs::remove_dir_all(node_home));
    ah_engine::discard::harmless(std::fs::remove_dir_all(rust_home));
    println!("model-routing stateful parity: {compared} / {compared} exact matches in retained HOMEs");
}

#[test]
fn d74_unparsable_stdin_is_deferred_to_node_never_blocked() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut rows: Vec<(String, String)> = cases().into_iter().filter(|case| case.expect_divergence).map(|c| (c.name.clone(), c.raw.clone().unwrap())).collect();
    assert_eq!(rows.len(), 2);
    // valid for JS.JSON.parse, rejected by serde_json: Node decides normally (here an allow), so the engine must defer
    rows.push((
        "lone-surrogate-escape".into(),
        r#"{"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"t","cwd":"/tmp","tool_input":{"model":"sonnet","subagent_type":"general-purpose","prompt":"implement the parser \ud83d"}}"#.into(),
    ));
    for (name, input) in &rows {
        let case = Case { name: name.clone(), payload: Value::Null, raw: Some(input.clone()), expect_divergence: true, env: Vec::new(), skip: false };
        let node_home = temp_home("node-d74");
        let rust_home = temp_home("rust-d74");
        let node = run_node(&repo, &node_home, &case, input);
        let rust = run_engine(&rust_home, &case, input);
        assert_eq!(node, (0, Vec::new(), Vec::new()), "{name}: Node allows");
        assert_eq!(rust, (0, format!("{}\n", ah_engine::hookio::FALLBACK).into_bytes(), Vec::new()), "{name}: the engine defers to Node, never blocks");
        ah_engine::discard::harmless(std::fs::remove_dir_all(node_home));
        ah_engine::discard::harmless(std::fs::remove_dir_all(rust_home));
    }
    println!("unparsable stdin: {} / {} deferred to Node", rows.len(), rows.len());
}
