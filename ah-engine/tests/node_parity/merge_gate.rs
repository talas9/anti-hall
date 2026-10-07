//! Parity of the built-in `merge-gate` check against `hooks/merge-gate.js` (PreToolUse on Bash).
//!
//! The engine must never be weaker than Node (D74): wherever Node blocks the engine may only defer, and wherever the engine
//! answers it must print exactly what Node printed. Corpus: (1) auto-merge command shapes (plain, env prefix, chains, heredoc
//! / redirect / tee / sed -i / python -c carriers of the merge text, quotes, odd white space, Unicode) against ~45 transcript
//! shapes (hedges, resolutions, masks, record kinds, malformed lines, window edges, invalid UTF-8, BOM, CRLF), (2) switch
//! sources (env, settings, plugin options, skip), (3) payload shape fuzz (missing and mistyped fields). Real Bash commands
//! from a developer's transcripts (the old fourth section) are local data and are not part of the committed corpus.

use super::guard::*;
use super::support::*;
use serde_json::{Value, json};
use std::sync::Arc;

fn pl(command: Value, tp: Option<Value>, extra: Value) -> Value {
    let mut p = json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "s", "cwd": "/tmp", "tool_input": {"command": command}});
    if let Some(t) = tp {
        p["transcript_path"] = t;
    }
    assign(p, extra)
}

fn a(text: &str, extra: Value) -> String {
    serde_json::to_string(&assign(json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}), extra)).unwrap()
}
fn u(text: &str, extra: Value) -> String {
    serde_json::to_string(&assign(json!({"type": "user", "message": {"role": "user", "content": text}}), extra)).unwrap()
}
fn ub(blocks: Value, extra: Value) -> String {
    serde_json::to_string(&assign(json!({"type": "user", "message": {"role": "user", "content": blocks}}), extra)).unwrap()
}
fn tr() -> String {
    ub(json!([{"type": "tool_result", "tool_use_id": "t", "content": "ok"}]), json!({"toolUseResult": {}}))
}
fn lines(l: &[String]) -> String {
    format!("{}\n", l.join("\n"))
}
fn n() -> Value {
    json!({})
}

const HEDGES: [&str; 11] = [
    "pending owner review",
    "DO NOT MERGE yet",
    "this is a First-Pass",
    "first pass only",
    "not pixel-perfect",
    "Not Pixel Perfect",
    "pending review",
    "needs your review",
    "needs your eyes",
    "review it in the build",
    "built, pending owner verification",
];

fn transcripts() -> Vec<(String, Vec<u8>)> {
    let mut t: Vec<(String, Vec<u8>)> = Vec::new();
    let mut put = |k: &str, v: String| t.push((k.to_string(), v.into_bytes()));
    put("empty", String::new());
    put("blank", "\n\n  \n".into());
    put("clean", lines(&[a("all done, tests pass", n()), u("thanks", n())]));
    put("cleanOnly", lines(&[a("I merged nothing yet.", n())]));
    put("garbage", "not json at all\n{broken\n".into());
    put("garbageThenHedge", lines(&["{broken".into(), a("pending review", n())]));
    put("hedgeThenResolved", lines(&[a("first-pass, pending review", n()), u("owner approved, go", n())]));
    put("hedgeThenResolvedLate", lines(&[a("first-pass", n()), u("looks ok", n()), a("merging", n()), u("verified against the spec", n())]));
    put("hedgeThenResolutionByAssistant", lines(&[a("pending review", n()), a("owner approved", n())]));
    put("hedgeThenToolResult", lines(&[a("do not merge", n()), tr(), a("owner approved", n())]));
    put("hedgeThenMeta", lines(&[a("do not merge", n()), u("owner approved", json!({"isMeta": true}))]));
    put("hedgeThenSidechain", lines(&[a("do not merge", n()), u("owner approved", json!({"isSidechain": true}))]));
    put("hedgeThenPeer", lines(&[a("do not merge", n()), u("owner approved", json!({"origin": {"kind": "peer"}}))]));
    put("hedgeThenHuman", lines(&[a("do not merge", n()), u("owner approved", json!({"origin": {"kind": "human"}}))]));
    put("hedgeThenReminder", lines(&[a("do not merge", n()), u("<system-reminder>owner approved</system-reminder>", n())]));
    put("hedgeThenTaskNote", lines(&[a("do not merge", n()), u("<task-notification>owner approved</task-notification>", n())]));
    put("hedgeThenCompact", lines(&[a("do not merge", n()), u("owner approved", json!({"isCompactSummary": true}))]));
    put("resolvedThenHedge", lines(&[u("owner approved", n()), a("hmm, pending review", n())]));
    put("hedgeInQuotes", lines(&[a("He said \"pending review\" about it.", n()), u("ok", n())]));
    put("hedgeInCode", lines(&[a("the flag `do not merge` is set", n()), u("ok", n())]));
    put("hedgeInFence", lines(&[a("ran this:\n```\npending review\n```\nand finished.", n())]));
    put("hedgeInBlockquote", lines(&[a("> do not merge\nfinished.", n())]));
    put("hedgeOnlyQuoted", lines(&[a("> do not merge", n())]));
    put("hedgeCurly", lines(&[a("see \u{201c}first-pass\u{201d} here", n())]));
    put("hedgeStrContent", format!("{}\n", json!({"type": "assistant", "message": {"role": "assistant", "content": "pending review"}})));
    put("hedgeNoMessage", format!("{}\n", json!({"type": "assistant", "text": "pending review"})));
    put(
        "hedgeToolUseBlock",
        format!("{}\n", json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "x", "input": {"note": "pending review"}}]}})),
    );
    put("hedgeEscaped", "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"pending\\u0020review\"}]}}\n".into());
    put("hedgeSurrogate", "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"\\ud800 do not merge\"}]}}\n".into());
    put("hedgeUnicodeCase", lines(&[a("PENDING REVIEW \u{212a}", n())]));
    put("hedgeCRLF", format!("{}\r\n{}\r\n", a("do not merge", n()), u("x", n())));
    put("hedgeBOM", format!("\u{feff}{}\n", a("do not merge", n())));
    put("hedgeNoTrailingNL", a("needs your eyes", n()));
    put(
        "hedgeAdjacentBlocks",
        format!("{}\n", json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "pending"}, {"type": "text", "text": "review"}]}})),
    );
    put("hedgeTwoSpaces", lines(&[a("pending  review", n()), a("first-  pass", n()), a("first_pass", n())]));
    put("hedgeNonAscii", lines(&[a("pending\u{a0}review", n()), a("first\u{2011}pass", n())]));
    put("hedgeHuge", lines(&[a(&format!("{} pending review", "x".repeat(300000)), n())]));
    put("hedgeBeyondWindow", format!("{}{}", lines(&[a("pending review", n())]), lines(&(0..400).map(|_| a(&"y".repeat(400), n())).collect::<Vec<_>>())));
    put("hedgeInsideWindow", format!("{}{}", lines(&(0..400).map(|_| a(&"y".repeat(400), n())).collect::<Vec<_>>()), lines(&[a("pending review", n())])));
    put("hedgeCutFirstLine", format!("{}\n{}", "z".repeat(130000), lines(&[a("clean tail", n())])));
    put("hedgeInCutFirstLine", format!("{}{}", lines(&[a(&format!("do not merge {}", "q".repeat(131000)), n())]), lines(&[a("clean tail", n())])));
    put("oneHugeLine", a(&format!("pending review {}", "w".repeat(200000)), n()));
    let mut inv = a("ok ", n()).into_bytes();
    inv.extend([0xff, 0xfe]);
    inv.extend(b" pending review\n");
    t.push(("invalidUtf8".into(), inv));
    let mut inv2 = a("fine ", n()).into_bytes();
    inv2.extend([0xc3, 0x28]);
    inv2.extend(b" done\n");
    t.push(("invalidUtf8Clean".into(), inv2));
    let mut put = |k: &str, v: String| t.push((k.to_string(), v.into_bytes()));
    put("numbers", "{\"type\":\"assistant\",\"n\":1e999,\"message\":{\"content\":\"first-pass\"}}\n".into());
    put("deepJson", format!("{}1{}\n{}\n", "{\"a\":".repeat(500), "}".repeat(500), a("first-pass", n())));
    put("nullLines", format!("null\n123\n\"str\"\n[1,2]\ntrue\n{}\n", a("clean", n())));
    put("userHedge", lines(&[u("pending review please", n()), a("ok", n())]));
    for (i, h) in HEDGES.iter().enumerate() {
        put(&format!("hedge{i}"), lines(&[a(&format!("I built it. {h}."), n()), u("ok", n())]));
    }
    t
}

fn with_ing<'a>(extra: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    let mut e = vec![("ANTIHALL_INGEST_DRY_RUN", "1")];
    e.extend_from_slice(extra);
    e
}

fn tp(k: &str) -> Option<Value> {
    Some(json!(format!("$HOME/t/{k}.jsonl")))
}

pub fn scenarios() -> Vec<Scenario> {
    let mut r = Rng::new(1);
    let mut out: Vec<Scenario> = Vec::new();
    let mut add = |payload: Value, ctx: &Arc<Ctx>, id: Option<String>| {
        let id = id.expect("every scenario of this corpus is named");
        out.push(Scenario { id, ctx: Some(ctx.clone()), steps: vec![Step::new(payload)] });
    };
    let t = transcripts();
    let mut files: Vec<(String, Vec<u8>)> = t.iter().map(|(k, v)| (format!("t/{k}.jsonl"), v.clone())).collect();
    files.push(("t/dir.jsonl/x".into(), b"a directory named like a transcript".to_vec()));
    let mk = |settings: Option<Value>, env: &[(&str, &str)], claude: Option<Value>, skip: Option<Value>| {
        let mut c = Ctx::new();
        if let Some(s) = settings {
            c = c.settings(s);
        }
        if let Some(s) = skip {
            c = c.skip(s);
        }
        if let Some(s) = claude {
            c = c.claude(s);
        }
        c.env = env_of(env);
        c.files = files.clone();
        c
    };
    let on = mk(Some(json!({"guards": {"mergeGate": true}})), &[("ANTIHALL_INGEST_DRY_RUN", "1")], None, None).arc();

    let merges: Vec<String> = [
        "gh pr merge 5",
        "gh pr merge --auto --squash",
        "gh pr review 3 --approve",
        "gh pr review --approve -b ok",
        "git merge --no-ff main",
        "git merge --ff-only origin/main",
        "git merge --ff develop",
        "git merge --no-ff feature main",
        "FOO=1 gh pr merge 2",
        "A=1 B=2 git merge --no-ff master",
        "cd repo && gh pr merge 9",
        "git fetch; git merge --no-ff origin/develop",
        "true || gh pr merge 1",
        "ls | gh pr merge 4",
        "hivecontrol workspace merge-into-source",
        "hivecontrol workspace merge-from-source --force",
        "gh   pr   merge   7",
        "\tgh pr merge 8",
        "gh pr merge 5 # done",
        "GH_TOKEN=x gh pr merge 1 -R a/b",
        "cat <<EOF\ngh pr merge 1\nEOF",
        "cat > run.sh <<'EOF'\ngh pr merge 1\nEOF",
        "echo \"gh pr merge 1\" > /tmp/x.sh",
        "echo 'gh pr merge 1' | tee /tmp/x.sh",
        "printf \"git merge --no-ff main\\n\" >> deploy.sh",
        "sed -i 's/a/gh pr merge 1/' run.sh",
        "python3 -c 'import os; os.system(\"gh pr merge 1\")'",
        "python -c \"open('m.sh','w').write('gh pr merge 2')\"",
        "bash -c \"gh pr merge 3\"",
        "sh -c 'git merge --no-ff main'",
        "eval \"gh pr merge 3\"",
        "git commit -m \"gh pr merge 5\"",
        "echo gh pr merge 5",
        "grep \"gh pr merge\" notes.md",
        "xargs -I{} gh pr merge {} < ids.txt",
        "$(echo gh) pr merge 1",
        "g\\h pr merge 1",
        "gh pr \"merge\" 1",
        "gh pr 'merge' 1",
        "gh\u{a0}pr\u{a0}merge 4",
        "gh pr merge 5\u{2028}git status",
        "git merge\u{2003}--no-ff main",
        "GH pr merge 1",
        "gh PR merge 1",
        "git merge feature",
        "git merge --no-ff feature",
        "git merge --no-commit main",
        "git merge --abort",
        "gh pr view 3",
        "gh pr review 3 --comment",
        "gh pr create",
        "gh pr list",
        "git status",
        "ls",
        "echo hi",
        "hivecontrol workspace status",
        "hivecontrol workspace merge",
        "gh",
        "gh pr",
        "git merge",
        "merge",
        "",
        "   ",
        "git push origin main",
        "gh api repos/a/b/merges",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let _ = &merges;
    // ---- (1) commands x transcripts
    let keys: Vec<String> = t.iter().map(|(k, _)| k.clone()).collect();
    for k in &keys {
        let mut cs: Vec<String> = merges[..6].to_vec();
        cs.push(r.pick(&merges).clone());
        cs.push(r.pick(&merges).clone());
        cs.push("git status".into());
        for c in cs {
            add(pl(json!(c), tp(k), n()), &on, Some(format!("cross-{k}-{}", clip(&c, 20))));
        }
    }
    for c in &merges {
        for k in ["clean", "hedge0", "hedgeThenResolved", "hedgeInQuotes", "empty", "garbage", "hedgeSurrogate"] {
            add(pl(json!(c), tp(k), n()), &on, Some(format!("cmd-{k}-{}", clip(c, 30))));
        }
    }
    // ---- transcript path shapes
    let shapes: Vec<(&str, Option<Value>)> = vec![
        ("missing", None),
        ("null", Some(Value::Null)),
        ("empty", Some(json!(""))),
        ("num", Some(json!(5))),
        ("obj", Some(json!({}))),
        ("arr", Some(json!(["$HOME/t/hedge0.jsonl"]))),
        ("nonexistent", Some(json!("$HOME/t/nope.jsonl"))),
        ("dir", Some(json!("$HOME/t/dir.jsonl"))),
        ("relative", Some(json!("t/hedge0.jsonl"))),
        ("dotdot", Some(json!("$HOME/t/../t/hedge0.jsonl"))),
        ("tilde", Some(json!("~/t/hedge0.jsonl"))),
        ("file-url", Some(json!("file://$HOME/t/hedge0.jsonl"))),
        ("nul", Some(json!("$HOME/t/hedge0.jsonl\u{0}x"))),
        ("trailing-slash", Some(json!("$HOME/t/hedge0.jsonl/"))),
        ("space", Some(json!(" $HOME/t/hedge0.jsonl"))),
        ("unicode", Some(json!("$HOME/t/\u{e9}.jsonl"))),
    ];
    for (id, p) in shapes {
        add(pl(json!("gh pr merge 1"), p, n()), &on, Some(format!("tp-{id}")));
    }
    // ---- (2) switch sources
    let probe = [pl(json!("gh pr merge 1"), tp("hedge0"), n()), pl(json!("gh pr merge 1"), tp("clean"), n()), pl(json!("git status"), tp("hedge0"), n())];
    let ing = [("ANTIHALL_INGEST_DRY_RUN", "1")];
    let g = |v: Value| Some(json!({"guards": {"mergeGate": v}}));
    let now = now_ms() as i64;
    let ctxs: Vec<(&str, Ctx)> = vec![
        ("off", mk(None, &ing, None, None)),
        ("offExplicit", mk(g(json!(false)), &ing, None, None)),
        ("envOn", mk(None, &with_ing(&[("ANTIHALL_MERGE_GATE", "1")]), None, None)),
        ("envOnWord", mk(None, &with_ing(&[("ANTIHALL_MERGE_GATE", " On ")]), None, None)),
        ("envOff", mk(g(json!(true)), &with_ing(&[("ANTIHALL_MERGE_GATE", "0")]), None, None)),
        ("envOffWord", mk(g(json!(true)), &with_ing(&[("ANTIHALL_MERGE_GATE", "off")]), None, None)),
        ("envJunk", mk(g(json!(true)), &with_ing(&[("ANTIHALL_MERGE_GATE", "zz")]), None, None)),
        ("strOn", mk(g(json!("yes")), &ing, None, None)),
        ("numOn", mk(g(json!(1)), &ing, None, None)),
        ("numTwo", mk(g(json!(2)), &ing, None, None)),
        ("objOn", mk(g(json!({})), &ing, None, None)),
        ("optOn", mk(None, &with_ing(&[("CLAUDE_PLUGIN_OPTION_GUARDS_MERGE_GATE", "true")]), None, None)),
        ("optDefault", mk(Some(json!({})), &with_ing(&[("CLAUDE_PLUGIN_OPTION_GUARDS_MERGE_GATE", "false")]), None, None)),
        ("optStored", mk(None, &ing, Some(json!({"pluginConfigs": {"anti-hall": {"options": {"guards_merge_gate": true}}}})), None)),
        ("optStoredFlat", mk(None, &ing, Some(json!({"pluginConfigs": {"anti-hall@anti-hall": {"guards_merge_gate": "true"}}})), None)),
        ("optStoredDefault", mk(g(json!(true)), &ing, Some(json!({"pluginConfigs": {"anti-hall": {"options": {"guards_merge_gate": false}}}})), None)),
        ("skip", mk(g(json!(true)), &ing, None, Some(json!({"merge-gate": now + 3600000})))),
        ("skipAll", mk(g(json!(true)), &ing, None, Some(json!({"all": now + 3600000})))),
        ("skipExpired", mk(g(json!(true)), &ing, None, Some(json!({"all": now - 1000})))),
        ("skipOther", mk(g(json!(true)), &ing, None, Some(json!({"git-guard": now + 3600000})))),
        ("badSettings", {
            let mut c = mk(None, &ing, None, None);
            c.settings = Some(Doc::Raw("{x".into()));
            c
        }),
        ("badSkip", {
            let mut c = mk(g(json!(true)), &ing, None, None);
            c.skip = Some(Doc::Raw("{x".into()));
            c
        }),
    ];
    for (k, c) in ctxs {
        let c = c.arc();
        for (i, p) in probe.iter().enumerate() {
            add(p.clone(), &c, Some(format!("ctx-{k}-{i}")));
        }
    }
    // ---- (3) payload shape fuzz
    let hp = tp("hedge0");
    let shapes: Vec<(&str, Value)> = vec![
        ("no-tool-input", json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "transcript_path": "$HOME/t/hedge0.jsonl"})),
        ("null-input", pl(Value::Null, hp.clone(), json!({"tool_input": null}))),
        ("str-input", pl(Value::Null, hp.clone(), json!({"tool_input": "gh pr merge 1"}))),
        ("arr-input", pl(Value::Null, hp.clone(), json!({"tool_input": ["gh pr merge 1"]}))),
        ("num-cmd", pl(json!(5), hp.clone(), n())),
        ("obj-cmd", pl(json!({"a": 1}), hp.clone(), n())),
        ("arr-cmd", pl(json!(["gh pr merge 1"]), hp.clone(), n())),
        ("null-cmd", pl(Value::Null, hp.clone(), n())),
        ("bool-cmd", pl(json!(true), hp.clone(), n())),
        ("other-tool", pl(json!("gh pr merge 1"), hp.clone(), json!({"tool_name": "Write"}))),
        ("no-tool", without(pl(json!("gh pr merge 1"), hp.clone(), n()), &["tool_name"])),
        ("extra-fields", pl(json!("gh pr merge 1"), hp.clone(), json!({"agent_id": "a", "turn_id": "t", "model": "m"}))),
        ("huge-cmd", pl(json!(format!("gh pr merge 1 {}", "x".repeat(500000))), hp.clone(), n())),
        ("unicode-cmd", pl(json!("gh pr merge 1 \u{1f600} \u{e9}"), hp.clone(), n())),
        ("cmd-newline", pl(json!("\n\ngh pr merge 1\n\n"), hp.clone(), n())),
        ("cmd-crlf", pl(json!("echo a\r\ngh pr merge 1\r\n"), tp("clean"), n())),
        ("cmd-nul", pl(json!("gh pr merge 1\u{0}"), hp.clone(), n())),
    ];
    for (id, p) in shapes {
        add(p, &on, Some(format!("shape-{id}")));
    }
    let _ = Arc::strong_count(&on);
    out
}

pub fn opts() -> Opts {
    let mut o = Opts::new("merge-gate", "merge-gate", "merge-gate.js");
    o.events = vec!["PreToolUse"];
    o.tools = vec!["*"];
    o
}
