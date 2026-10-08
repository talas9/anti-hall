//! Scenarios of the `emit-dedupe-reset` check (SessionStart).
use super::harness::*;
use serde_json::json;

fn sf(sid: &str) -> String {
    format!(".anti-hall/emit-dedupe/dedupe-{sid}.json")
}

fn ev(sid: serde_json::Value, source: &str) -> String {
    payload(json!({"session_id": sid, "hook_event_name": "SessionStart", "source": source, "transcript_path": "/tmp/none.jsonl", "cwd": "/tmp"}))
}

fn one(name: &str, raw: String) -> Scn {
    scn(format!("reset-{name}"), "emit-dedupe-reset", vec![step(raw)])
}

fn old_entry(now: f64, age_ms: f64) -> String {
    format!("{{\"hash\":\"h\",\"tp\":null,\"lastEmittedAt\":{},\"lastSeenAt\":{},\"turnsSinceEmit\":0}}", now - age_ms, now - age_ms)
}

pub fn scenarios() -> Vec<Scn> {
    let now = now_ms();
    let mut v: Vec<Scn> = Vec::new();
    for src in ["startup", "resume", "clear", "compact"] {
        v.push(one(&format!("source-{src}"), ev(json!("sess-1"), src)));
    }
    v.push(one("basic-twice", ev(json!("s"), "startup")).seed(vec![]));
    let mut twice = scn("reset-twice-in-a-row", "emit-dedupe-reset", vec![step(ev(json!("s"), "startup")), step(ev(json!("s"), "compact"))]);
    twice.expect_defer = Some(false);
    v.push(twice);
    // session ids
    let long300 = "x".repeat(300);
    let a128 = "a".repeat(128);
    let a129 = "a".repeat(129);
    let emoji_edge = format!("{}😀tail", "b".repeat(127));
    for (n, sid) in [
        ("unicode", json!("héllo-世界")),
        ("slash", json!("a/b/c")),
        ("dots", json!("..")),
        ("dotfile", json!(".hidden")),
        ("spaces", json!("a b  c")),
        ("long300", json!(long300)),
        ("len128", json!(a128)),
        ("len129", json!(a129)),
        ("emoji-edge", json!(emoji_edge)),
        ("num-5", json!(5)),
        ("num-1.5", json!(1.5)),
        ("num-big", json!(1e21)),
        ("num-neg", json!(-3)),
        ("bool-true", json!(true)),
    ] {
        v.push(one(&format!("sid-{n}"), ev(sid, "startup")));
    }
    for (n, sid) in [("num-0", json!(0)), ("bool-false", json!(false)), ("null", json!(null)), ("empty", json!(""))] {
        v.push(one(&format!("sid-none-{n}"), ev(sid, "startup")));
    }
    v.push(one("sid-absent", payload(json!({"hook_event_name": "SessionStart"}))));
    v.push(one("sid-array", ev(json!(["a"]), "startup"))); // the script (like Node) uses String(id)
    v.push(one("sid-object", ev(json!({"a": 1}), "startup")));
    // payload shapes
    for (n, raw) in [("null", "null"), ("array", "[]"), ("number", "5"), ("string", "\"s\""), ("empty-object", "{}"), ("true", "true")] {
        v.push(one(&format!("shape-{n}"), raw.into()));
    }
    v.push(one("shape-huge", payload(json!({"session_id": "huge", "pad": "z".repeat(1_500_000)}))));
    v.push(one("malformed", "{not json".into()).defers());
    v.push(one("empty-stdin", String::new()).defers());
    v.push(one("bom", format!("\u{feff}{}", ev(json!("b"), "startup"))).defers());
    v.push(one("lone-surrogate", "{\"session_id\":\"s\",\"x\":\"\\ud800\"}".into()).defers());
    v.push(one("trailing-garbage", format!("{} x", ev(json!("t"), "startup"))).defers());
    // existing state
    let fresh = old_entry(now, 1000.0);
    v.push(one("state-merge", ev(json!("m"), "startup")).seed(vec![w(
        &sf("m"),
        format!("{{\"verify-first\":{fresh},\"__stats\":{{\"suppressed\":3,\"lastSeenAt\":{},\"lastSuppressedAt\":{}}}}}", now - 5000.0, now - 5000.0),
    )]));
    v.push(
        one("state-replace-reset", ev(json!("r"), "compact"))
            .seed(vec![w(&sf("r"), format!("{{\"__reset\":{{\"resetAt\":{},\"lastSeenAt\":{}}},\"k\":{fresh}}}", now - 4000.0, now - 4000.0))]),
    );
    v.push(
        one("state-prune-old-key", ev(json!("p"), "startup")).seed(vec![w(&sf("p"), format!("{{\"old\":{},\"keep\":{fresh}}}", old_entry(now, 90_000_000.0)))]),
    );
    v.push(
        one("state-prune-edge-ttl", ev(json!("pe"), "startup"))
            .seed(vec![w(&sf("pe"), format!("{{\"edge\":{},\"over\":{}}}", old_entry(now, 86_000_000.0), old_entry(now, 86_500_000.0)))]),
    );
    v.push(
        one("state-prune-no-seen", ev(json!("pn"), "startup"))
            .seed(vec![w(&sf("pn"), "{\"a\":{\"hash\":\"x\"},\"b\":5,\"c\":\"str\",\"d\":null,\"e\":[1],\"f\":{\"lastSeenAt\":\"123\"}}")]),
    );
    v.push(one("state-int-keys-order", ev(json!("ik"), "startup")).seed(vec![w(
        &sf("ik"),
        format!("{{\"zeta\":{fresh},\"10\":{fresh},\"2\":{fresh},\"abc\":{fresh},\"007\":{fresh},\"4294967295\":{fresh},\"4294967294\":{fresh}}}"),
    )]));
    v.push(
        one("state-dup-keys", ev(json!("dk"), "startup")).seed(vec![w(&sf("dk"), format!("{{\"a\":{fresh},\"b\":{fresh},\"a\":{}}}", old_entry(now, 5000.0)))]),
    );
    v.push(one("state-float-numbers", ev(json!("fn"), "startup")).seed(vec![w(
        &sf("fn"),
        format!("{{\"a\":{{\"lastSeenAt\":{}.5,\"x\":1e21,\"y\":1.5e-7,\"z\":0.000001,\"n\":-0,\"big\":12345678901234567890}}}}", now as u64),
    )]));
    v.push(
        one("state-unicode-keys", ev(json!("uk"), "startup"))
            .seed(vec![w(&sf("uk"), format!("{{\"k\\u00e9y\":{fresh},\"\\\"q\\\\\":{fresh},\"\\u0001\":{fresh},\"tab\\t\":{fresh}}}"))]),
    );
    v.push(one("state-garbage", ev(json!("g"), "startup")).seed(vec![w(&sf("g"), "not json at all")]));
    v.push(one("state-blank", ev(json!("bl"), "startup")).seed(vec![w(&sf("bl"), "  \n ")]));
    v.push(one("state-empty-file", ev(json!("ef"), "startup")).seed(vec![w(&sf("ef"), "")]));
    v.push(one("state-array", ev(json!("ar"), "startup")).seed(vec![w(&sf("ar"), "[1,2]")]));
    v.push(one("state-number", ev(json!("nu"), "startup")).seed(vec![w(&sf("nu"), "5")]));
    v.push(one("state-null", ev(json!("nl"), "startup")).seed(vec![w(&sf("nl"), "null")]));
    v.push(one("state-invalid-utf8", ev(json!("iu"), "startup")).seed(vec![w(&sf("iu"), [b'{', b'"', 0xff, 0xfe, b'"', b':', b'1', b'}'])]));
    v.push(one("state-lone-surrogate-key", ev(json!("ls"), "startup")).seed(vec![w(&sf("ls"), "{\"a\\ud800\":1}")]));
    // "state-dir-in-the-way" (the session file is a directory) is gone: Node leaves a temp file behind when the rename fails, the script's atomic write cleans up
    // switches
    for (n, kv) in [
        ("env-off-0", vec![("ANTIHALL_EMIT_DEDUPE", "0")]),
        ("env-off-word", vec![("ANTIHALL_EMIT_DEDUPE", "off")]),
        ("env-off-false", vec![("ANTIHALL_EMIT_DEDUPE", " False ")]),
        ("env-on-1", vec![("ANTIHALL_EMIT_DEDUPE", "1")]),
        ("env-garbage", vec![("ANTIHALL_EMIT_DEDUPE", "maybe")]),
        ("env-window-0", vec![("ANTIHALL_DEDUPE_WINDOW_MIN", "0")]),
        ("env-window-5", vec![("ANTIHALL_DEDUPE_WINDOW_MIN", "5")]),
        ("env-window-neg", vec![("ANTIHALL_DEDUPE_WINDOW_MIN", "-4")]),
        ("env-window-junk", vec![("ANTIHALL_DEDUPE_WINDOW_MIN", "soon")]),
        ("env-window-hex0", vec![("ANTIHALL_DEDUPE_WINDOW_MIN", "0x0")]),
        ("env-window-blank", vec![("ANTIHALL_DEDUPE_WINDOW_MIN", "   ")]),
        ("opt-off", vec![("CLAUDE_PLUGIN_OPTION_GUARDS_EMIT_DEDUPE", "false")]),
        ("opt-default-true", vec![("CLAUDE_PLUGIN_OPTION_GUARDS_EMIT_DEDUPE", "true")]),
        ("opt-window-0", vec![("CLAUDE_PLUGIN_OPTION_CONTEXT_DEDUPE_WINDOW_MIN", "0")]),
        ("opt-window-20", vec![("CLAUDE_PLUGIN_OPTION_CONTEXT_DEDUPE_WINDOW_MIN", "20")]),
        ("judge-child", vec![("ANTIHALL_JUDGE_CHILD", "1")]),
        ("judge-child-0", vec![("ANTIHALL_JUDGE_CHILD", "0")]),
    ] {
        v.push(one(&format!("switch-{n}"), ev(json!("sw"), "startup")).env(&kv));
    }
    for (n, body) in [
        ("file-off", "{\"guards\":{\"emitDedupe\":false}}"),
        ("file-off-str", "{\"guards\":{\"emitDedupe\":\"no\"}}"),
        ("file-off-num", "{\"guards\":{\"emitDedupe\":0}}"),
        ("file-on-num", "{\"guards\":{\"emitDedupe\":1}}"),
        ("file-bad-type", "{\"guards\":{\"emitDedupe\":[false]}}"),
        ("file-window-0", "{\"context\":{\"dedupeWindowMin\":0}}"),
        ("file-window-str0", "{\"context\":{\"dedupeWindowMin\":\"0\"}}"),
        ("file-window-neg", "{\"context\":{\"dedupeWindowMin\":-1}}"),
        ("file-window-frac", "{\"context\":{\"dedupeWindowMin\":0.5}}"),
        ("file-corrupt", "{oops"),
        ("file-section-array", "{\"guards\":[1]}"),
    ] {
        v.push(one(&format!("switch-{n}"), ev(json!("sw"), "startup")).seed(vec![w(".anti-hall/settings.json", body)]));
    }
    v.push(
        one("switch-stored-off", ev(json!("sw"), "startup"))
            .seed(vec![w(".claude/settings.json", "{\"pluginConfigs\":{\"anti-hall\":{\"options\":{\"guards_emit_dedupe\":false}}}}")]),
    );
    v.push(
        one("switch-stored-flat-id", ev(json!("sw"), "startup"))
            .seed(vec![w(".claude/settings.json", "{\"pluginConfigs\":{\"anti-hall@anti-hall\":{\"context_dedupe_window_min\":0}}}")]),
    );
    v.push(
        one("switch-env-beats-file", ev(json!("sw"), "startup"))
            .env(&[("ANTIHALL_EMIT_DEDUPE", "1")])
            .seed(vec![w(".anti-hall/settings.json", "{\"guards\":{\"emitDedupe\":false}}")]),
    );
    // the sweep of idle session files
    let sweep_seed = |stamp: Option<&str>| {
        let mut f = vec![
            aged(w(&sf("old1"), format!("{{\"a\":{}}}", old_entry(now, 1000.0))), 8 * 86400),
            aged(w(&sf("old2"), "{}"), 30 * 86400),
            aged(w(&sf("young"), "{}"), 6 * 86400),
            aged(w(".anti-hall/emit-dedupe/other-old.json", "{}"), 20 * 86400),
            aged(w(".anti-hall/emit-dedupe/dedupe-note.txt", "x"), 20 * 86400),
            aged(w(&sf("self"), "{}"), 40 * 86400),
        ];
        if let Some(s) = stamp {
            f.push(w(".anti-hall/emit-dedupe/.prune-stamp-dedupe.json", s));
        }
        f
    };
    v.push(one("sweep-no-stamp", ev(json!("self"), "startup")).seed(sweep_seed(None)));
    v.push(one("sweep-fresh-stamp", ev(json!("self"), "startup")).seed(sweep_seed(Some(&format!("{{\"lastSweep\":{}}}", now - 3_600_000.0)))));
    v.push(one("sweep-stale-stamp", ev(json!("self"), "startup")).seed(sweep_seed(Some(&format!("{{\"lastSweep\":{}}}", now - 7.0 * 3_600_000.0)))));
    v.push(one("sweep-future-stamp", ev(json!("self"), "startup")).seed(sweep_seed(Some(&format!("{{\"lastSweep\":{}}}", now + 3_600_000.0)))));
    v.push(one("sweep-bad-stamp", ev(json!("self"), "startup")).seed(sweep_seed(Some("garbage"))));
    v.push(one("sweep-stamp-string", ev(json!("self"), "startup")).seed(sweep_seed(Some("{\"lastSweep\":\"123\"}"))));
    v.push(one("sweep-stamp-edge", ev(json!("self"), "startup")).seed(sweep_seed(Some(&format!("{{\"lastSweep\":{}}}", now - 21_599_000.0)))));
    v.push(one("sweep-blank-stamp", ev(json!("self"), "startup")).seed(sweep_seed(Some("  "))));
    v.push(one("sweep-two-runs", ev(json!("self"), "startup")).seed(sweep_seed(None)));
    v.push(
        scn("reset-sweep-second-run", "emit-dedupe-reset", vec![step(ev(json!("self"), "startup")), step(ev(json!("self"), "clear"))]).seed(sweep_seed(None)),
    );
    v
}
