//! Scenarios of the `verify-first` check (UserPromptSubmit).
use super::harness::*;
use serde_json::{Value, json};

const TP: &str = "$HOME/t.jsonl";
const HASH_VF: &str = "d56c9d9a6075c27da23dee89c5f498e77fdcab81"; // sha1("VERIFY-FIRST")

fn sf(sid: &str) -> String {
    format!(".anti-hall/emit-dedupe/dedupe-{sid}.json")
}

fn pl(sid: &str, tp: &str, prompt: &str) -> String {
    payload(json!({"session_id": sid, "transcript_path": tp, "prompt": prompt, "cwd": "/tmp", "hook_event_name": "UserPromptSubmit"}))
}

fn one(name: &str, raw: String) -> Scn {
    scn(format!("vf-{name}"), "verify-first", vec![step(raw)])
}

/// A transcript that has timestamps but no delivered block yet.
fn base_transcript(now: f64) -> W {
    w("t.jsonl", filler(now - 60_000.0))
}

/// A transcript whose tail holds a delivered block of another hook: any copy of ours that is not there is still pending.
fn pending_transcript(now: f64) -> W {
    w("t.jsonl", format!("{}{}", filler(now - 60_000.0), ups_attachment(now - 30_000.0, &["some other hook's block"])))
}

fn deliver() -> impl Fn(&Prev, f64) -> Vec<W> + Send + Sync + 'static {
    |prev, now| match &prev.last_ctx {
        Some(c) => vec![wa("t.jsonl", ups_attachment(now, &[c]))],
        None => vec![],
    }
}

/// emit, then `n` delivered turns of the same prompt.
fn consumed_sequence(name: &str, sid: &str, n: usize, env: &[(&str, &str)]) -> Scn {
    let raw = pl(sid, TP, "same prompt");
    let mut steps = vec![step(raw.clone())];
    for _ in 0..n {
        steps.push(step(raw.clone()).after(deliver()));
    }
    scn(format!("vf-seq-{name}"), "verify-first", steps).seed(vec![base_transcript(now_ms())]).env(env)
}

pub fn scenarios() -> Vec<Scn> {
    let now = now_ms();
    let mut v: Vec<Scn> = Vec::new();

    // ---- the rotating line: every prompt digest picks one of the lines ------------------------------------------
    for i in 0..48 {
        v.push(one(&format!("rotate-{i}"), pl(&format!("rot-{i}"), TP, &format!("prompt number {i}"))).seed(vec![base_transcript(now)]));
    }
    v.push(one("rotate-key-order", "{\"prompt\":\"x\",\"session_id\":\"ko\",\"cwd\":\"/tmp\"}".into()));
    v.push(one("rotate-whitespace", "  {\"session_id\":\"ws\" ,\"prompt\":\"x\"}\n\n".into()));
    v.push(one("rotate-crlf", "{\"session_id\":\"crlf\",\r\n\"prompt\":\"x\"}\r\n".into()));
    v.push(one("rotate-escaped", "{\"session_id\":\"es\\u0041\",\"prompt\":\"caf\\u00e9 \\ud83d\\ude00\"}".into()));
    v.push(one("rotate-unicode-prompt", pl("uni", TP, "héllo 世界 😀 \u{2028}")));

    // ---- session ids ---------------------------------------------------------------------------------------------
    for (n, sid) in [
        ("none-null", json!(null)),
        ("none-empty", json!("")),
        ("none-zero", json!(0)),
        ("none-false", json!(false)),
        ("num-5", json!(5)),
        ("num-float", json!(2.5)),
        ("true", json!(true)),
        ("unicode", json!("héllo-世界")),
        ("slash", json!("a/b/../c")),
        ("dots", json!("...")),
        ("space", json!("a b")),
        ("long", json!("L".repeat(400))),
        ("len128", json!("k".repeat(128))),
        ("emoji-edge", json!(format!("{}😀z", "e".repeat(127)))),
    ] {
        v.push(
            one(&format!("sid-{n}"), payload(json!({"session_id": sid, "prompt": "p", "transcript_path": TP, "cwd": "/tmp"}))).seed(vec![base_transcript(now)]),
        );
    }
    v.push(one("sid-absent", payload(json!({"prompt": "p", "cwd": "/tmp"}))));
    v.push(one("sid-array", payload(json!({"session_id": ["a"], "prompt": "p"}))).defers());
    v.push(one("sid-object", payload(json!({"session_id": {"a": 1}, "prompt": "p"}))).defers());

    // ---- transcript paths and shapes ----------------------------------------------------------------------------
    v.push(one("tp-absent", payload(json!({"session_id": "tpa", "prompt": "p"}))));
    v.push(one("tp-empty", pl("tpe", "", "p")));
    v.push(one("tp-number", payload(json!({"session_id": "tpn", "transcript_path": 5, "prompt": "p"}))));
    v.push(one("tp-null", payload(json!({"session_id": "tpz", "transcript_path": null, "prompt": "p"}))));
    v.push(one("tp-array", payload(json!({"session_id": "tpr", "transcript_path": ["x"], "prompt": "p"}))));
    v.push(one("tp-relative", pl("tprel", "rel/t.jsonl", "p")).defers());
    v.push(one("tp-missing", pl("tpm", "/nonexistent/dir/t.jsonl", "p")));
    v.push(one("tp-unicode-path", pl("tpu", "$HOME/héllo 世界.jsonl", "p")).seed(vec![w("héllo 世界.jsonl", filler(now))]));
    v.push(scn("vf-tp-empty-file", "verify-first", vec![step(pl("tef", TP, "p")), step(pl("tef", TP, "p"))]).seed(vec![w("t.jsonl", "")]));
    v.push(scn("vf-tp-directory", "verify-first", vec![step(pl("tdr", "$HOME/adir", "p")), step(pl("tdr", "$HOME/adir", "p"))]).seed(vec![w("adir/x", "x")]));
    v.push(
        scn("vf-tp-no-timestamps", "verify-first", vec![step(pl("tnt", TP, "p")), step(pl("tnt", TP, "p"))])
            .seed(vec![w("t.jsonl", "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n")]),
    );
    v.push(
        scn("vf-tp-garbage-lines", "verify-first", vec![step(pl("tgl", TP, "p")), step(pl("tgl", TP, "p"))])
            .seed(vec![w("t.jsonl", format!("not json\n{}{{broken\n", filler(now)))]),
    );
    v.push(
        scn("vf-tp-timestamp-only", "verify-first", vec![step(pl("tto", TP, "p")), step(pl("tto", TP, "p")), step(pl("tto", TP, "p"))])
            .seed(vec![base_transcript(now)]),
    );
    v.push(
        scn("vf-tp-no-trailing-newline", "verify-first", vec![step(pl("tnn", TP, "p")), step(pl("tnn", TP, "p")).after(deliver())])
            .seed(vec![w("t.jsonl", filler(now).trim_end())])
            .defers_second_step(),
    );

    // ---- the burst and delivery rules ---------------------------------------------------------------------------
    v.push(
        scn("vf-burst-pending", "verify-first", vec![step(pl("bp", TP, "a")), step(pl("bp", TP, "b")), step(pl("bp", TP, "c")), step(pl("bp", TP, "d"))])
            .seed(vec![base_transcript(now)]),
    );
    v.push(
        scn(
            "vf-burst-pending-known",
            "verify-first",
            vec![step(pl("bpk", TP, "a")), step(pl("bpk", TP, "b")), step(pl("bpk", TP, "c")), step(pl("bpk", TP, "d"))],
        )
        .seed(vec![pending_transcript(now)]),
    );
    v.push(consumed_sequence("keepalive-default", "kd", 12, &[]));
    for (n, every) in [
        ("0", "0"),
        ("1", "1"),
        ("2", "2"),
        ("3", "3"),
        ("junk", "abc"),
        ("neg", "-1"),
        ("frac", "2.5"),
        ("spaced", " 3 "),
        ("hex", "0x2"),
        ("exp", "1e0"),
        ("blank", "  "),
    ] {
        v.push(consumed_sequence(&format!("every-{n}"), &format!("ev{n}"), 7, &[("ANTIHALL_INJECTION_REPEAT_EVERY", every)]));
    }
    v.push(consumed_sequence("every-opt-2", "evo2", 6, &[("CLAUDE_PLUGIN_OPTION_GUARDS_INJECTION_REPEAT_EVERY", "2")]));
    v.push(consumed_sequence("every-opt-default", "evod", 4, &[("CLAUDE_PLUGIN_OPTION_GUARDS_INJECTION_REPEAT_EVERY", "10")]));
    let mut f = consumed_sequence("every-file-2", "evf2", 6, &[]);
    f.seed.push(w(".anti-hall/settings.json", "{\"guards\":{\"injectionRepeatEvery\":2}}"));
    v.push(f);
    let mut f = consumed_sequence("every-file-str", "evfs", 5, &[]);
    f.seed.push(w(".anti-hall/settings.json", "{\"guards\":{\"injectionRepeatEvery\":\"1\"}}"));
    v.push(f);
    let mut f = consumed_sequence("every-stored", "evst", 5, &[]);
    f.seed.push(w(".claude/settings.json", "{\"pluginConfigs\":{\"anti-hall\":{\"options\":{\"guards_injection_repeat_every\":1}}}}"));
    v.push(f);
    v.push(consumed_sequence("emit-dedupe-off-env", "off", 3, &[("ANTIHALL_EMIT_DEDUPE", "0")]));
    v.push(consumed_sequence("window-0-env", "w0", 3, &[("ANTIHALL_DEDUPE_WINDOW_MIN", "0")]));

    // delivered content held as whole segments of a joined additionalContext
    v.push(
        scn(
            "vf-delivered-as-segment",
            "verify-first",
            vec![
                step(pl("seg", TP, "x")),
                step(pl("seg", TP, "x")).after(|prev, now| {
                    vec![wa("t.jsonl", ups_attachment(now, &[&format!("OTHER BLOCK\n\n{}\n\nTAIL BLOCK", prev.last_ctx.clone().unwrap_or_default())]))]
                }),
                step(pl("seg", TP, "x"))
                    .after(|prev, now| vec![wa("t.jsonl", ups_attachment(now, &[&format!("A\n\n{}", prev.last_ctx.clone().unwrap_or_default())]))]),
            ],
        )
        .seed(vec![base_transcript(now)]),
    );
    v.push(
        scn(
            "vf-delivered-prefix-only",
            "verify-first",
            vec![
                step(pl("pfx", TP, "x")),
                step(pl("pfx", TP, "x"))
                    .after(|prev, now| vec![wa("t.jsonl", ups_attachment(now, &[&format!("{} and more", prev.last_ctx.clone().unwrap_or_default())]))]),
            ],
        )
        .seed(vec![base_transcript(now)]),
    );
    v.push(
        scn(
            "vf-delivered-non-array-content",
            "verify-first",
            vec![
                step(pl("nac", TP, "x")),
                step(pl("nac", TP, "x")).after(|prev, now| vec![wa("t.jsonl", line(json!({"type":"attachment","timestamp":iso(now),"attachment":{"type":"hook_additional_context","hookEvent":"UserPromptSubmit","content":prev.last_ctx.clone().unwrap_or_default()}})))]),
            ],
        )
        .seed(vec![base_transcript(now)]),
    );
    for (n, ev_name, ty) in
        [("other-event", "Stop", "hook_additional_context"), ("other-type", "UserPromptSubmit", "hook_success"), ("both-wrong", "SessionStart", "x")]
    {
        v.push(
            scn(
                format!("vf-attachment-{n}"),
                "verify-first",
                vec![
                    step(pl("att", TP, "x")),
                    step(pl("att", TP, "x")).after(move |prev, now| vec![wa("t.jsonl", line(json!({"type":"attachment","timestamp":iso(now),"attachment":{"type":ty,"hookEvent":ev_name,"content":[prev.last_ctx.clone().unwrap_or_default()]}})))]),
                ],
            )
            .seed(vec![base_transcript(now)]),
        );
    }
    // attachment timestamps against the emit time
    for (n, shift) in [("old", -120_000.0), ("tolerance-edge", -1_000.0), ("tolerance-inside", -900.0), ("future", 5_000.0)] {
        v.push(
            scn(
                format!("vf-attachment-ts-{n}"),
                "verify-first",
                vec![
                    step(pl("ats", TP, "x")),
                    step(pl("ats", TP, "x"))
                        .after(move |prev, now| vec![wa("t.jsonl", ups_attachment(now + shift - 40.0, &[&prev.last_ctx.clone().unwrap_or_default()]))]),
                ],
            )
            .seed(vec![base_transcript(now)]),
        );
    }
    for (n, ts) in [
        ("offset", json!("2099-01-01T00:00:00+04:00")),
        ("lowercase-z", json!("2099-01-01T00:00:00z")),
        ("nan-month", json!("2099-13-01T00:00:00Z")),
        ("garbage", json!("yesterday")),
        ("date-only", json!("2099-01-01")),
        ("fraction-long", json!("2099-01-01T00:00:00.123456789Z")),
        ("null", json!(null)),
        ("bool", json!(true)),
        ("object", json!({})),
        ("missing", json!("__missing__")),
    ] {
        let expect_defer = matches!(n, "lowercase-z" | "garbage" | "date-only");
        let sc = scn(
            format!("vf-attachment-timestamp-{n}"),
            "verify-first",
            vec![
                step(pl("tsx", TP, "x")),
                step(pl("tsx", TP, "x")).after(move |prev, _| {
                    let mut e = json!({"type":"attachment","attachment":{"type":"hook_additional_context","hookEvent":"UserPromptSubmit","content":[prev.last_ctx.clone().unwrap_or_default()]}});
                    if ts != json!("__missing__") {
                        e["timestamp"] = ts.clone();
                    }
                    vec![wa("t.jsonl", line(e))]
                }),
            ],
        )
        .seed(vec![base_transcript(now)]);
        v.push(if expect_defer { sc.defers_second_step() } else { sc });
    }
    for (n, ts) in [("number", json!(1700000000000i64)), ("array", json!(["2099-01-01T00:00:00Z"]))] {
        v.push(
            scn(
                format!("vf-attachment-timestamp-{n}"),
                "verify-first",
                vec![
                    step(pl("tsy", TP, "x")),
                    step(pl("tsy", TP, "x")).after(move |prev, _| vec![wa("t.jsonl", line(json!({"type":"attachment","timestamp":ts.clone(),"attachment":{"type":"hook_additional_context","hookEvent":"UserPromptSubmit","content":[prev.last_ctx.clone().unwrap_or_default()]}})))]),
                ],
            )
            .seed(vec![base_transcript(now)])
            .defers_second_step(),
        );
    }
    // a line that holds the marker but cannot be read by either parser
    v.push(
        scn(
            "vf-marker-line-broken",
            "verify-first",
            vec![
                step(pl("mlb", TP, "x")),
                step(pl("mlb", TP, "x")).pre(vec![wa("t.jsonl", "{\"type\":\"attachment\",\"attachment\":{\"type\":\"hook_additional_context\" BROKEN\n")]),
            ],
        )
        .seed(vec![base_transcript(now)])
        .defers_second_step(),
    );
    v.push(
        scn(
            "vf-marker-in-tool-output",
            "verify-first",
            vec![
                step(pl("mto", TP, "x")),
                step(pl("mto", TP, "x"))
                    .pre(vec![wa("t.jsonl", line(json!({"type":"user","timestamp":iso(now),"message":{"content":"grep hook_additional_context"}})))]),
            ],
        )
        .seed(vec![base_transcript(now)]),
    );
    v.push(
        scn(
            "vf-marker-lone-surrogate",
            "verify-first",
            vec![
                step(pl("mls", TP, "x")),
                step(pl("mls", TP, "x")).after(|prev, now| {
                    let c = prev.last_ctx.clone().unwrap_or_default();
                    let l = format!("{{\"type\":\"attachment\",\"timestamp\":\"{}\",\"attachment\":{{\"type\":\"hook_additional_context\",\"hookEvent\":\"UserPromptSubmit\",\"content\":[\"bad \\ud83d here\",{}]}}}}\n", iso(now), serde_json::to_string(&c).unwrap());
                    vec![wa("t.jsonl", l)]
                }),
            ],
        )
        .seed(vec![base_transcript(now)]),
    );
    // the wide tail: the delivery sits beyond the first 256KB window
    v.push(
        scn(
            "vf-wide-tail-found",
            "verify-first",
            vec![
                step(pl("wtf", TP, "x")),
                step(pl("wtf", TP, "x")).after(|prev, now| {
                    vec![w("t.jsonl", format!("{}{}", ups_attachment(now, &[&prev.last_ctx.clone().unwrap_or_default()]), big_filler_text(now)))]
                }),
            ],
        )
        .seed(vec![base_transcript(now)]),
    );
    v.push(
        scn(
            "vf-wide-tail-absent",
            "verify-first",
            vec![step(pl("wta", TP, "x")), step(pl("wta", TP, "x")).pre(vec![w("t.jsonl", format!("{}{}", filler(now), big_filler_text(now)))])],
        )
        .seed(vec![base_transcript(now)]),
    );

    // ---- fallback window, pending limit, reset marker, stale records -------------------------------------------
    let seeded = move |sid: &str, emitted_ago_ms: f64, seen_ago_ms: f64, turns: u32, tp: &str| {
        w(
            &sf(sid),
            format!(
                "{{\"verify-first\":{{\"hash\":\"{HASH_VF}\",\"tp\":{tp},\"lastEmittedAt\":{},\"lastSeenAt\":{},\"turnsSinceEmit\":{turns},\"ch\":\"aa\",\"k\":1}}}}",
                now - emitted_ago_ms,
                now - seen_ago_ms
            ),
        )
    };
    let t = "\"$TP($HOME/none.jsonl)\"";
    let notp = "null";
    for (n, emitted, seen, turns) in [
        ("fresh", 2_000.0, 2_000.0, 0),
        ("window-edge-in", 19.0 * 60_000.0, 19.0 * 60_000.0, 0),
        ("window-edge-out", 21.0 * 60_000.0, 21.0 * 60_000.0, 0),
        ("old", 3.0 * 3_600_000.0, 3.0 * 3_600_000.0, 0),
        ("turns-at-keepalive", 40.0 * 60_000.0, 40.0 * 60_000.0, 10),
        ("turns-below", 40.0 * 60_000.0, 40.0 * 60_000.0, 4),
        ("turns-above", 40.0 * 60_000.0, 40.0 * 60_000.0, 99),
        ("seen-recent", 40.0 * 60_000.0, 5_000.0, 10),
    ] {
        v.push(
            scn(
                format!("vf-state-nopath-{n}"),
                "verify-first",
                vec![step(payload(json!({"session_id": "sn", "prompt": "x"}))), step(payload(json!({"session_id": "sn", "prompt": "x"})))],
            )
            .seed(vec![seeded("sn", emitted, seen, turns, notp)]),
        );
        v.push(
            scn(format!("vf-state-unusable-{n}"), "verify-first", vec![step(pl("su", "$HOME/none.jsonl", "x")), step(pl("su", "$HOME/none.jsonl", "x"))])
                .seed(vec![seeded("su", emitted, seen, turns, t)])
                .env(&[("ANTIHALL_INJECTION_REPEAT_EVERY", "10")]),
        );
    }
    for (n, emitted_ago) in [("pending-recent", 60_000.0), ("pending-over-limit", 11.0 * 60_000.0), ("pending-edge", 9.9 * 60_000.0)] {
        v.push(
            scn(format!("vf-state-{n}"), "verify-first", vec![step(pl("sp", TP, "x")), step(pl("sp", TP, "x"))])
                .seed(vec![pending_transcript(now), seeded("sp", emitted_ago, emitted_ago, 0, "\"$TP($HOME/t.jsonl)\"")]),
        );
    }
    v.push(scn("vf-state-reset-after-emit", "verify-first", vec![step(pl("sra", TP, "x"))]).seed(vec![
        pending_transcript(now),
        seeded("sra", 60_000.0, 60_000.0, 0, "\"$TP($HOME/t.jsonl)\""),
        ed(&sf("sra"), move |t| {
            let mut v: Value = serde_json::from_str(t).unwrap_or(json!({}));
            v["__reset"] = json!({"resetAt": now - 1000.0, "lastSeenAt": now - 1000.0});
            v.to_string()
        }),
    ]));
    v.push(scn("vf-state-reset-before-emit", "verify-first", vec![step(pl("srb", TP, "x"))]).seed(vec![base_transcript(now), w(&sf("srb"), format!("{{\"__reset\":{{\"resetAt\":{},\"lastSeenAt\":{}}},\"verify-first\":{{\"hash\":\"{HASH_VF}\",\"tp\":\"$TP($HOME/t.jsonl)\",\"lastEmittedAt\":{},\"lastSeenAt\":{},\"turnsSinceEmit\":0,\"ch\":\"aa\",\"k\":1}}}}", now - 90_000.0, now - 90_000.0, now - 30_000.0, now - 30_000.0))]));
    v.push(
        scn(
            "vf-state-reset-after-emit-real",
            "verify-first",
            vec![
                step(pl("srr", TP, "x")),
                step(pl("srr", TP, "x")).pre(vec![ed(&sf("srr"), move |t| {
                    let mut v: Value = serde_json::from_str(t).unwrap_or(json!({}));
                    v["__reset"] = json!({"resetAt": now_ms() + 50.0, "lastSeenAt": now_ms()});
                    v.to_string()
                })]),
            ],
        )
        .seed(vec![base_transcript(now)]),
    );
    v.push(
        scn("vf-state-other-transcript", "verify-first", vec![step(pl("sot", TP, "x"))])
            .seed(vec![base_transcript(now), seeded("sot", 5_000.0, 5_000.0, 0, "\"deadbeefdeadbeef\"")]),
    );
    v.push(
        scn("vf-state-tp-null-vs-path", "verify-first", vec![step(pl("stn", TP, "x"))])
            .seed(vec![base_transcript(now), seeded("stn", 5_000.0, 5_000.0, 0, "null")]),
    );
    v.push(
        scn("vf-state-tp-falsy-zero", "verify-first", vec![step(payload(json!({"session_id":"sfz","prompt":"x"})))])
            .seed(vec![seeded("sfz", 5_000.0, 5_000.0, 0, "0")]),
    );
    v.push(
        scn("vf-state-tp-falsy-empty", "verify-first", vec![step(payload(json!({"session_id":"sfe","prompt":"x"})))])
            .seed(vec![seeded("sfe", 5_000.0, 5_000.0, 0, "\"\"")]),
    );
    v.push(
        scn("vf-state-tp-object", "verify-first", vec![step(payload(json!({"session_id":"sto","prompt":"x"})))])
            .seed(vec![seeded("sto", 5_000.0, 5_000.0, 0, "{}")]),
    );
    v.push(scn("vf-state-hash-differs", "verify-first", vec![step(pl("shd", TP, "x"))]).seed(vec![
        base_transcript(now),
        w(
            &sf("shd"),
            format!(
                "{{\"verify-first\":{{\"hash\":\"0000\",\"tp\":\"$TP($HOME/t.jsonl)\",\"lastEmittedAt\":{},\"lastSeenAt\":{},\"turnsSinceEmit\":0}}}}",
                now - 5000.0,
                now - 5000.0
            ),
        ),
    ]));
    v.push(
        scn("vf-state-future-emit", "verify-first", vec![step(pl("sfu", TP, "x"))])
            .seed(vec![base_transcript(now), seeded("sfu", -3_600_000.0, 5_000.0, 0, "\"$TP($HOME/t.jsonl)\"")]),
    );
    v.push(
        scn("vf-state-missing-fields", "verify-first", vec![step(pl("smf", TP, "x"))])
            .seed(vec![base_transcript(now), w(&sf("smf"), format!("{{\"verify-first\":{{\"hash\":\"{HASH_VF}\"}}}}"))]),
    );
    v.push(scn("vf-state-string-times", "verify-first", vec![step(pl("sst", TP, "x"))]).seed(vec![
        base_transcript(now),
        w(
            &sf("sst"),
            format!("{{\"verify-first\":{{\"hash\":\"{HASH_VF}\",\"tp\":\"$TP($HOME/t.jsonl)\",\"lastEmittedAt\":\"{}\",\"lastSeenAt\":1}}}}", now - 1000.0),
        ),
    ]));
    v.push(
        scn("vf-state-entry-not-object", "verify-first", vec![step(pl("seo", TP, "x"))])
            .seed(vec![base_transcript(now), w(&sf("seo"), "{\"verify-first\":\"text\",\"other\":5}")]),
    );
    v.push(scn("vf-state-k-noninteger", "verify-first", vec![step(pl("skn", TP, "x"))]).seed(vec![base_transcript(now), w(&sf("skn"), format!("{{\"verify-first\":{{\"hash\":\"{HASH_VF}\",\"tp\":\"$TP($HOME/t.jsonl)\",\"lastEmittedAt\":{},\"lastSeenAt\":{},\"turnsSinceEmit\":0,\"ch\":\"aa\",\"k\":1.5}}}}", now - 5000.0, now - 5000.0))]).defers());
    v.push(scn("vf-state-k-zero", "verify-first", vec![step(pl("skz", TP, "x"))]).seed(vec![base_transcript(now), w(&sf("skz"), format!("{{\"verify-first\":{{\"hash\":\"{HASH_VF}\",\"tp\":\"$TP($HOME/t.jsonl)\",\"lastEmittedAt\":{},\"lastSeenAt\":{},\"turnsSinceEmit\":0,\"ch\":\"aa\",\"k\":0}}}}", now - 5000.0, now - 5000.0))]));
    v.push(scn("vf-state-ch-missing", "verify-first", vec![step(pl("scm", TP, "x"))]).seed(vec![
        base_transcript(now),
        w(
            &sf("scm"),
            format!(
                "{{\"verify-first\":{{\"hash\":\"{HASH_VF}\",\"tp\":\"$TP($HOME/t.jsonl)\",\"lastEmittedAt\":{},\"lastSeenAt\":{},\"turnsSinceEmit\":0}}}}",
                now - 5000.0,
                now - 5000.0
            ),
        ),
    ]));
    v.push(scn("vf-state-garbage", "verify-first", vec![step(pl("sg", TP, "x"))]).seed(vec![base_transcript(now), w(&sf("sg"), "}{ not json")]).defers());
    v.push(scn("vf-state-blank", "verify-first", vec![step(pl("sb", TP, "x"))]).seed(vec![base_transcript(now), w(&sf("sb"), "")]));
    v.push(scn("vf-state-array", "verify-first", vec![step(pl("sa", TP, "x"))]).seed(vec![base_transcript(now), w(&sf("sa"), "[]")]));
    v.push(scn("vf-state-stale-keys-pruned", "verify-first", vec![step(pl("skp", TP, "x"))]).seed(vec![
        base_transcript(now),
        w(&sf("skp"), format!("{{\"limit-conserve\":{{\"hash\":\"h\",\"lastSeenAt\":{}}},\"keep\":{{\"lastSeenAt\":{}}}}}", now - 100_000_000.0, now - 1000.0)),
    ]));
    v.push(scn("vf-state-stats-counted", "verify-first", vec![step(pl("ssc", TP, "x")), step(pl("ssc", TP, "x")), step(pl("ssc", TP, "x"))]).seed(vec![
        base_transcript(now),
        w(&sf("ssc"), format!("{{\"__stats\":{{\"suppressed\":41,\"lastSeenAt\":{},\"lastSuppressedAt\":{}}}}}", now - 1000.0, now - 1000.0)),
    ]));
    v.push(scn("vf-state-other-keys-kept", "verify-first", vec![step(pl("sok", TP, "x"))]).seed(vec![base_transcript(now), w(&sf("sok"), format!("{{\"task-tracker\":{{\"hash\":\"h\",\"tp\":null,\"lastEmittedAt\":{},\"lastSeenAt\":{},\"turnsSinceEmit\":3,\"ch\":\"cc\",\"k\":2}},\"10\":{{\"lastSeenAt\":{}}}}}", now - 1000.0, now - 1000.0, now - 1000.0))]));
    v.push(
        scn("vf-state-dir-in-the-way", "verify-first", vec![step(pl("sdw", TP, "x"))]).seed(vec![base_transcript(now), w(&format!("{}/x", sf("sdw")), "x")]),
    );
    // sweep of old session files rides along with a write
    v.push(scn("vf-sweep-old-sessions", "verify-first", vec![step(pl("swp", TP, "x"))]).seed(vec![
        base_transcript(now),
        aged(w(&sf("stale"), "{}"), 9 * 86400),
        aged(w(&sf("fine"), "{}"), 86400),
    ]));

    // ---- switches -----------------------------------------------------------------------------------------------
    for (n, kv) in [
        ("opt-off", vec![("CLAUDE_PLUGIN_OPTION_CONTEXT_VERIFY_FIRST_TURN", "false")]),
        ("opt-on", vec![("CLAUDE_PLUGIN_OPTION_CONTEXT_VERIFY_FIRST_TURN", "true")]),
        ("opt-junk", vec![("CLAUDE_PLUGIN_OPTION_CONTEXT_VERIFY_FIRST_TURN", "perhaps")]),
        ("opt-zero", vec![("CLAUDE_PLUGIN_OPTION_CONTEXT_VERIFY_FIRST_TURN", "0")]),
        ("judge-child", vec![("ANTIHALL_JUDGE_CHILD", "1")]),
        ("judge-child-other", vec![("ANTIHALL_JUDGE_CHILD", "yes")]),
        ("emit-off", vec![("ANTIHALL_EMIT_DEDUPE", "off")]),
    ] {
        v.push(scn(format!("vf-switch-{n}"), "verify-first", vec![step(pl("sw", TP, "x")), step(pl("sw", TP, "x"))]).seed(vec![base_transcript(now)]).env(&kv));
    }
    for (n, body) in [
        ("file-off", "{\"context\":{\"verifyFirstTurn\":false}}"),
        ("file-off-str", "{\"context\":{\"verifyFirstTurn\":\"off\"}}"),
        ("file-off-zero", "{\"context\":{\"verifyFirstTurn\":0}}"),
        ("file-on", "{\"context\":{\"verifyFirstTurn\":true}}"),
        ("file-weird", "{\"context\":{\"verifyFirstTurn\":{\"a\":1}}}"),
        ("file-corrupt", "{{{"),
        ("file-top-array", "[1]"),
        ("file-emit-off", "{\"guards\":{\"emitDedupe\":false}}"),
        ("file-window-0", "{\"context\":{\"dedupeWindowMin\":0}}"),
        ("file-window-1", "{\"context\":{\"dedupeWindowMin\":1}}"),
    ] {
        v.push(
            scn(format!("vf-switch-{n}"), "verify-first", vec![step(pl("sw", TP, "x")), step(pl("sw", TP, "x"))])
                .seed(vec![base_transcript(now), w(".anti-hall/settings.json", body)]),
        );
    }
    v.push(
        scn("vf-switch-stored-off", "verify-first", vec![step(pl("sw", TP, "x"))])
            .seed(vec![w(".claude/settings.json", "{\"pluginConfigs\":{\"anti-hall@anti-hall\":{\"context_verify_first_turn\":false}}}")]),
    );
    v.push(
        scn("vf-switch-stored-nested-off", "verify-first", vec![step(pl("sw", TP, "x"))])
            .seed(vec![w(".claude/settings.json", "{\"pluginConfigs\":{\"anti-hall\":{\"options\":{\"context_verify_first_turn\":\"false\"}}}}")]),
    );
    v.push(scn("vf-switch-stored-corrupt", "verify-first", vec![step(pl("sw", TP, "x"))]).seed(vec![w(".claude/settings.json", "nope")]));
    v.push(
        scn("vf-switch-env-beats-file", "verify-first", vec![step(pl("sw", TP, "x"))])
            .env(&[("ANTIHALL_EMIT_DEDUPE", "1")])
            .seed(vec![w(".anti-hall/settings.json", "{\"guards\":{\"emitDedupe\":false}}")]),
    );

    // ---- DevSwarm: the Primary sentence stays on Node ------------------------------------------------------------
    let ds = |name: &str, kv: &[(&str, &str)], files: Vec<W>, defers: bool| {
        let sc = scn(format!("vf-ds-{name}"), "verify-first", vec![step(pl("ds", TP, "x")), step(pl("ds", TP, "x"))]).env(kv).seed(files);
        if defers { sc.defers() } else { sc }
    };
    v.push(ds("repo-primary", &[("DEVSWARM_REPO_ID", "r1")], vec![], true));
    v.push(ds("repo-child", &[("DEVSWARM_REPO_ID", "r1"), ("DEVSWARM_SOURCE_BRANCH", "feat")], vec![], false));
    v.push(ds("repo-blank", &[("DEVSWARM_REPO_ID", "   ")], vec![], false));
    v.push(ds("repo-empty", &[("DEVSWARM_REPO_ID", "")], vec![], false));
    v.push(ds("child-branch-blank", &[("DEVSWARM_REPO_ID", "r1"), ("DEVSWARM_SOURCE_BRANCH", "  ")], vec![], true));
    v.push(ds("no-env", &[], vec![], false));
    v.push(ds("mode-on-no-repo", &[("ANTIHALL_DEVSWARM_SUPERVISOR", "on")], vec![], true));
    v.push(ds("mode-on-child", &[("ANTIHALL_DEVSWARM_SUPERVISOR", "on"), ("DEVSWARM_SOURCE_BRANCH", "b")], vec![], false));
    v.push(ds("mode-off-repo", &[("ANTIHALL_DEVSWARM_SUPERVISOR", "off"), ("DEVSWARM_REPO_ID", "r1")], vec![], false));
    v.push(ds("mode-off-spaced-upper", &[("ANTIHALL_DEVSWARM_SUPERVISOR", "  OFF "), ("DEVSWARM_REPO_ID", "r1")], vec![], false));
    v.push(ds("mode-auto-no-repo", &[("ANTIHALL_DEVSWARM_SUPERVISOR", "auto")], vec![], false));
    v.push(ds("mode-junk-repo", &[("ANTIHALL_DEVSWARM_SUPERVISOR", "banana"), ("DEVSWARM_REPO_ID", "r1")], vec![], true));
    v.push(ds("disable-1", &[("DISABLE_ANTIHALL_DEVSWARM", "1"), ("DEVSWARM_REPO_ID", "r1")], vec![], false));
    v.push(ds("disable-1-mode-on", &[("DISABLE_ANTIHALL_DEVSWARM", "1"), ("ANTIHALL_DEVSWARM_SUPERVISOR", "on")], vec![], false));
    v.push(ds("disable-0", &[("DISABLE_ANTIHALL_DEVSWARM", "0"), ("DEVSWARM_REPO_ID", "r1")], vec![], true));
    v.push(ds("tier-text-off", &[("ANTIHALL_DEVSWARM_DISPATCH_TIER_TEXT", "0"), ("DEVSWARM_REPO_ID", "r1")], vec![], false));
    v.push(ds("tier-text-on", &[("ANTIHALL_DEVSWARM_DISPATCH_TIER_TEXT", "yes"), ("DEVSWARM_REPO_ID", "r1")], vec![], true));
    v.push(ds("tier-text-junk", &[("ANTIHALL_DEVSWARM_DISPATCH_TIER_TEXT", "zz"), ("DEVSWARM_REPO_ID", "r1")], vec![], true));
    v.push(ds("file-mode-off", &[("DEVSWARM_REPO_ID", "r1")], vec![w(".anti-hall/settings.json", "{\"devswarm\":{\"supervisorMode\":\"off\"}}")], false));
    v.push(ds("file-mode-on", &[], vec![w(".anti-hall/settings.json", "{\"devswarm\":{\"supervisorMode\":\"ON\"}}")], true));
    v.push(ds("file-mode-bad", &[("DEVSWARM_REPO_ID", "r1")], vec![w(".anti-hall/settings.json", "{\"devswarm\":{\"supervisorMode\":5}}")], true));
    v.push(ds("file-tier-off", &[("DEVSWARM_REPO_ID", "r1")], vec![w(".anti-hall/settings.json", "{\"devswarm\":{\"dispatchTierText\":false}}")], false));
    v.push(ds("opt-mode-off", &[("DEVSWARM_REPO_ID", "r1"), ("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off")], vec![], false));
    v.push(ds("opt-mode-auto", &[("DEVSWARM_REPO_ID", "r1"), ("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "auto")], vec![], true));
    v.push(ds("opt-mode-on", &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "on")], vec![], true));
    v.push(ds(
        "stored-mode-off",
        &[("DEVSWARM_REPO_ID", "r1")],
        vec![w(".claude/settings.json", "{\"pluginConfigs\":{\"anti-hall\":{\"options\":{\"devswarm_supervisor_mode\":\"off\"}}}}")],
        false,
    ));
    v.push(ds(
        "env-beats-file",
        &[("DEVSWARM_REPO_ID", "r1"), ("ANTIHALL_DEVSWARM_SUPERVISOR", "auto")],
        vec![w(".anti-hall/settings.json", "{\"devswarm\":{\"supervisorMode\":\"off\"}}")],
        true,
    ));
    // the verify-first switch off wins before any DevSwarm question
    v.push(
        scn("vf-ds-turn-off-first", "verify-first", vec![step(pl("ds", TP, "x"))])
            .env(&[("DEVSWARM_REPO_ID", "r1")])
            .seed(vec![w(".anti-hall/settings.json", "{\"context\":{\"verifyFirstTurn\":false}}")]),
    );

    // ---- payload shapes ------------------------------------------------------------------------------------------
    for (n, raw) in [("null", "null"), ("array", "[1,2]"), ("number", "42"), ("string", "\"just text\""), ("empty-object", "{}"), ("true", "true")] {
        v.push(one(&format!("shape-{n}"), raw.into()));
    }
    v.push(one("shape-malformed", "{\"session_id\":".into()).defers());
    v.push(one("shape-empty-stdin", String::new()).defers());
    v.push(one("shape-bom", format!("\u{feff}{}", pl("bom", TP, "x"))).defers());
    v.push(one("shape-lone-surrogate", "{\"session_id\":\"ls\",\"prompt\":\"\\udc00\"}".into()).defers());
    v.push(one("shape-trailing", format!("{} junk", pl("tj", TP, "x"))).defers());
    v.push(one("shape-huge", payload(json!({"session_id": "huge", "prompt": "q".repeat(2_000_000)}))));
    v.push(one("shape-deep", format!("{{\"session_id\":\"deep\",\"a\":{}1{}}}", "[".repeat(100), "]".repeat(100))));
    v.push(one("shape-too-deep", format!("{{\"session_id\":\"deep2\",\"a\":{}1{}}}", "[".repeat(300), "]".repeat(300))).defers());
    v.push(one("shape-duplicate-keys", "{\"session_id\":\"first\",\"session_id\":\"second\",\"prompt\":\"x\"}".into()));
    v.push(one("shape-big-number", "{\"session_id\":\"bn\",\"n\":1e999}".into()).defers());
    v
}

fn big_filler_text(now: f64) -> String {
    (0..4200).map(|i| filler(now - 50_000.0 + i as f64)).collect()
}
