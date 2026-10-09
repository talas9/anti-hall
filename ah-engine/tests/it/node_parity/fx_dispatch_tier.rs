//! Parity of the built-in `dispatch-tier` check against `hooks/dispatch-tier.js` (PostToolUse on TaskCreate|TaskUpdate).
//! While the Jev dispatchTier integration is off the Node hook does nothing, so the engine must do nothing too: compared on exit
//! code, stdout, stderr and the whole file tree. While it is on or in shadow the Node hook asks Jev detached and writes its request
//! marker; the engine asks natively (since 1.93 it no longer defers there) and must answer the same and leave the same marker. The
//! detached worker's own log lands after Node exits, so for those scenarios the log is left out of the comparison and the marker's
//! times are masked.

use super::fx::*;
use super::jsjson::J;
use super::support::*;

fn post(tool: J, input: J, extra: &[(&str, Option<J>)]) -> J {
    let mut p =
        jo! {"hook_event_name": "PostToolUse", "tool_name": tool, "tool_input": input, "session_id": "s1", "cwd": "$PROJ", "transcript_path": "$HOME/t.jsonl"};
    for (k, v) in extra {
        match v {
            Some(v) => p.set(k, v.clone()),
            None => p.remove(k),
        }
    }
    p
}
fn tool(t: &str) -> J {
    J::from(t)
}

pub(crate) fn scenarios() -> Vec<Scenario> {
    let mut r = Rng::new(1);
    let mut out: Vec<Scenario> = Vec::new();
    let t_lines = [
        jo! {"type": "assistant", "message": jo! {"role": "assistant", "content": ja![jo! {"type": "tool_use", "id": "tu1", "name": "TaskCreate", "input": jo! {"subject": "first task", "description": "do it"}}]}}.text(),
        jo! {"type": "user", "message": jo! {"role": "user", "content": ja![jo! {"type": "tool_result", "tool_use_id": "tu1", "content": "Task #1 created successfully: first task"}]}}.text(),
    ];
    let t = t_lines.join("\n");
    let w = World::new().file("home/t.jsonl", &t).git("proj");
    let jev_on = World::new().file("home/t.jsonl", &t).file("home/.anti-hall/settings.json", "{\"jev\":{\"enabled\":true}}").git("proj");
    let inputs: Vec<J> = vec![
        jo! {"subject": "write tests", "description": "cover it"},
        jo! {"subject": ""},
        jo! {},
        jo! {"title": "t"},
        jo! {"content": "c"},
        jo! {"description": "only"},
        jo! {"subject": "x", "metadata": jo! {"blockedOn": "owner"}},
        jo! {"subject": "OWNER: decide"},
        jo! {"taskId": "1", "subject": "renamed"},
        jo! {"taskId": 1, "description": "new desc"},
        jo! {"id": "1", "subject": "x"},
        jo! {"taskId": "9", "status": "completed"},
        jo! {"taskId": "1"},
        J::Null,
        J::from("str"),
        J::from(5),
        ja![1],
    ];
    for tl in ["TaskCreate", "TaskUpdate"] {
        for (i, inp) in inputs.iter().enumerate() {
            out.push(Scenario::one(&format!("off-{tl}-{i}"), post(tool(tl), inp.clone(), &[]), &w));
        }
    }
    let tools: Vec<(&str, J)> = vec![
        ("\"Bash\"", tool("Bash")),
        ("\"Task\"", tool("Task")),
        ("\"TaskGet\"", tool("TaskGet")),
        ("\"TaskList\"", tool("TaskList")),
        ("\"taskcreate\"", tool("taskcreate")),
        ("\"TaskCreate \"", tool("TaskCreate ")),
        ("\"\"", tool("")),
        ("null", J::Null),
        ("5", J::from(5)),
        ("\"Agent\"", tool("Agent")),
    ];
    for (id, tl) in tools {
        out.push(Scenario::one(&format!("off-tool-{id}"), post(tl, jo! {"subject": "s"}, &[]), &w));
    }
    let sub = || jo! {"subject": "x"};
    let upd = || jo! {"taskId": "1", "subject": "x"};
    out.push(Scenario::one("off-no-transcript", post(tool("TaskUpdate"), upd(), &[("transcript_path", None)]), &w));
    out.push(Scenario::one("off-missing-transcript", post(tool("TaskUpdate"), upd(), &[("transcript_path", Some(J::from("$HOME/none.jsonl")))]), &w));
    out.push(Scenario::one("off-bad-cwd", post(tool("TaskCreate"), sub(), &[("cwd", Some(J::from(5)))]), &w));
    out.push(Scenario::one("off-no-session", post(tool("TaskCreate"), sub(), &[("session_id", None)]), &w));
    out.push(Scenario::one("off-not-object", ja![1], &w));
    out.push(Scenario::one("off-null-payload", J::Null, &w));
    out.push(Scenario::new("off-raw-garbage", w.clone(), vec![Step::raw("not json")]));
    // switches that keep it off
    for (id, settings) in [
        ("file-enabled-false", "{\"jev\":{\"enabled\":false}}"),
        ("file-integration-off", "{\"jev\":{\"enabled\":true},\"jevIntegrations\":{\"dispatchTier\":\"off\"}}"),
        ("file-integration-bad", "{\"jev\":{\"enabled\":\"maybe\"}}"),
    ] {
        out.push(Scenario::one(&format!("switch-{id}"), post(tool("TaskCreate"), sub(), &[]), &World::new().file("home/.anti-hall/settings.json", settings)));
    }
    out.push(Scenario::one(
        "switch-legacy-jev-json-off",
        post(tool("TaskCreate"), sub(), &[]),
        &World::new().file("home/.anti-hall/jev.json", "{\"enabled\":true,\"integrations\":{\"dispatchTier\":\"off\"}}"),
    ));
    out.push(Scenario::one("switch-garbage-settings", post(tool("TaskCreate"), sub(), &[]), &World::new().file("home/.anti-hall/settings.json", "{nope")));
    out.push(Scenario::new("switch-env-off", jev_on.clone(), vec![Step::payload(post(tool("TaskCreate"), sub(), &[])).env("ANTIHALL_JEV", "0")]));
    out.push(Scenario::new(
        "switch-env-integration-off",
        jev_on.clone(),
        vec![Step::payload(post(tool("TaskCreate"), sub(), &[])).env("ANTIHALL_JEV_DISPATCH_TIER", "0")],
    ));
    out.push(Scenario::new(
        "switch-option-off",
        jev_on.clone(),
        vec![Step::payload(post(tool("TaskCreate"), sub(), &[])).env("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DISPATCH_TIER", "off")],
    ));
    // on / shadow: the engine must defer
    for tl in ["TaskCreate", "TaskUpdate"] {
        for (i, inp) in inputs.iter().take(9).enumerate() {
            out.push(Scenario::one(&format!("on-{tl}-{i}"), post(tool(tl), inp.clone(), &[]), &jev_on).async_effects());
        }
    }
    out.push(Scenario::new("on-env", w.clone(), vec![Step::payload(post(tool("TaskCreate"), sub(), &[])).env("ANTIHALL_JEV", "1")]).async_effects());
    out.push(
        Scenario::new("on-shadow", jev_on.clone(), vec![Step::payload(post(tool("TaskCreate"), sub(), &[])).env("ANTIHALL_JEV_DISPATCH_TIER", "shadow")])
            .async_effects(),
    );
    out.push(
        Scenario::one(
            "on-file-shadow",
            post(tool("TaskCreate"), sub(), &[]),
            &World::new().file("home/.anti-hall/settings.json", "{\"jev\":{\"enabled\":true},\"jevIntegrations\":{\"dispatchTier\":\"shadow\"}}"),
        )
        .async_effects(),
    );
    // fuzz (off)
    let vals: Vec<J> =
        vec![J::from(""), J::from("x"), J::from("owner"), J::from(5), J::Null, J::Bool(true), ja![], jo! {}, J::from("\u{e9}"), J::from("x".repeat(2000))];
    let nfuzz: usize = std::env::var("AH_PARITY_FUZZ").ok().and_then(|x| x.parse().ok()).unwrap_or(120);
    for i in 0..nfuzz {
        let tl = *r.pick(&["TaskCreate", "TaskUpdate", "Bash"]);
        let subject = r.pick(&vals).clone();
        let description = r.pick(&vals).clone();
        let task_id = r.pick(&vals).clone();
        // the metadata array is built (and its blockedOn drawn) before the draw from it
        let blocked = r.pick(&vals).clone();
        let metas: [Option<J>; 3] = [None, Some(jo! {"blockedOn": blocked}), Some(J::from(5))];
        let meta = r.pick(&metas).clone();
        let mut input = jo! {"subject": subject, "description": description, "taskId": task_id};
        if let Some(m) = meta {
            input.set("metadata", m);
        }
        let sess = r.pick(&vals).clone();
        let cwd = r.pick(&[J::from("$PROJ"), J::from(5), J::from("")]).clone();
        let world = if r.below(2) == 0 { w.clone() } else { World::new() };
        out.push(Scenario::one(&format!("fuzz-{i}"), post(tool(tl), input, &[("session_id", Some(sess)), ("cwd", Some(cwd))]), &world));
    }
    out
}

pub(crate) fn opts() -> Opts {
    let mut o = Opts::new("dispatch-tier", "dispatch-tier.js", "dispatch-tier");
    o.may_defer = Some(Box::new(|sc, _| sc.id == "off-raw-garbage"));
    o
}
