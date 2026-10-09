//! Corpus for codex-availability (SessionStart): PATH probes, platform detection, the quota record, job logs, switches.

use super::b78::*;
use super::jsjson::js_number;
use super::lab::Lab;
use super::support::*;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

fn start(extra: Value) -> Value {
    assign(
        json!({"hook_event_name": "SessionStart", "session_id": "s1", "cwd": "/tmp", "source": "startup", "transcript_path": "/home/u/.claude/projects/x/s1.jsonl"}),
        extra,
    )
}

fn exe(lab: &Lab, root: &Path, rel: &str, mode: u32) -> PathBuf {
    let f = lab.write(root, rel, "#!/bin/sh\nexit 0\n", None);
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(mode)).expect("chmod");
    f
}

fn mkdir(p: &Path) {
    std::fs::create_dir_all(p).expect("directory");
}

const BASE_PATH: &str = "/usr/bin:/bin";

type Mk = fn(&Lab, &Path) -> Vec<String>;
type Quota = Box<dyn Fn(&Lab, &Path) + Send + Sync>;

fn with_path(mk: Mk, payload: Payload, quota: Option<Quota>) -> impl Fn(&Lab, &Path) -> Built + Send + Sync {
    move |lab, root| {
        let dirs = mk(lab, root);
        if let Some(q) = &quota {
            q(lab, root);
        }
        let p = match &payload {
            Payload::Json(v) => Payload::Json(v.clone()),
            Payload::Raw(s) => Payload::Raw(s.clone()),
        };
        Built { payload: Some(p), env: env_of(&[("PATH", &dirs.join(":"))]), run_cwd: None }
    }
}

fn pj(v: Value) -> Payload {
    Payload::Json(v)
}

/// `path.join(root, rel)`, normalized as Node does.
fn d(root: &Path, rel: &str) -> String {
    path_join(&[&root.to_string_lossy(), rel])
}

/// The state file text as `JSON.stringify(Object.assign({available: true, checkedAt: 1, source: 'path-probe'}, extra, quota))`.
fn rec_text(quota: Option<String>, extra: &[(&str, String)]) -> String {
    let mut pairs: Vec<(&str, String)> = vec![("available", "true".into()), ("checkedAt", "1".into()), ("source", js("path-probe"))];
    for (k, v) in extra {
        match pairs.iter_mut().find(|(n, _)| n == k) {
            Some(e) => e.1 = v.clone(),
            None => pairs.push((k, v.clone())),
        }
    }
    if let Some(q) = quota {
        match pairs.iter_mut().find(|(n, _)| *n == "quota") {
            Some(e) => e.1 = q,
            None => pairs.push(("quota", q)),
        }
    }
    oj(&pairs)
}

fn rec(quota: Option<String>) -> Quota {
    Box::new(move |lab, r| {
        lab.write(r, "home/.anti-hall/codex-availability.json", rec_text(quota.clone(), &[]), None);
    })
}

fn jobs(specs: Vec<(String, String, String, i64)>) -> Quota {
    Box::new(move |lab, r| {
        for (repo, file, text, age) in &specs {
            lab.write(r, &format!("home/.claude/plugins/data/codex-openai-codex/state/{repo}/jobs/{file}"), text, Some(*age));
        }
        // The check keeps the newest repository directories by their own modification time. A directory made during the run
        // has the file system's clock: on ext4 that is a 4 ms tick, so 25 directories made in a row tie or split by chance, and
        // the two runs (Node, then the engine) kept different ones (CI run 37894970868). Give each its newest log's time.
        for (repo, _, _, _) in &specs {
            let newest = specs.iter().filter(|(r2, ..)| r2 == repo).map(|(.., age)| *age).min().unwrap_or(0);
            set_mtime(&r.join(format!("home/.claude/plugins/data/codex-openai-codex/state/{repo}")), (lab.base - newest) as f64);
        }
    })
}

fn logmsg(date: &str) -> String {
    format!("[codex] working...\nERROR: You've hit your usage limit. Upgrade to Pro or try again at {date}.\n")
}

fn num(n: f64) -> String {
    js_number(n)
}

pub(crate) fn scenarios() -> Vec<Sc> {
    let mut out: Vec<Sc> = Vec::new();
    // ---- PATH shapes
    out.push(Sc::setup(
        "path-exec",
        with_path(
            |l, r| {
                exe(l, r, "bin1/codex", 0o755);
                vec![d(r, "bin1"), BASE_PATH.into()]
            },
            pj(start(json!({}))),
            None,
        ),
    ));
    out.push(Sc::setup(
        "path-exec-second",
        with_path(
            |l, r| {
                exe(l, r, "bin2/codex", 0o755);
                mkdir(&r.join("bin1"));
                vec![d(r, "bin1"), d(r, "bin2")]
            },
            pj(start(json!({}))),
            None,
        ),
    ));
    out.push(Sc::setup(
        "path-not-exec",
        with_path(
            |l, r| {
                exe(l, r, "bin1/codex", 0o644);
                vec![d(r, "bin1"), BASE_PATH.into()]
            },
            pj(start(json!({}))),
            None,
        ),
    ));
    out.push(Sc::setup(
        "path-dir-named-codex",
        with_path(
            |_, r| {
                mkdir(&r.join("bin1/codex"));
                vec![d(r, "bin1"), BASE_PATH.into()]
            },
            pj(start(json!({}))),
            None,
        ),
    ));
    out.push(Sc::setup(
        "path-symlink-exec",
        with_path(
            |l, r| {
                exe(l, r, "real/codex", 0o755);
                mkdir(&r.join("bin1"));
                std::os::unix::fs::symlink(r.join("real/codex"), r.join("bin1/codex")).expect("symlink");
                vec![d(r, "bin1")]
            },
            pj(start(json!({}))),
            None,
        ),
    ));
    out.push(Sc::setup(
        "path-symlink-dir",
        with_path(
            |_, r| {
                mkdir(&r.join("real/codex"));
                mkdir(&r.join("bin1"));
                std::os::unix::fs::symlink(r.join("real/codex"), r.join("bin1/codex")).expect("symlink");
                vec![d(r, "bin1")]
            },
            pj(start(json!({}))),
            None,
        ),
    ));
    out.push(Sc::setup(
        "path-broken-symlink",
        with_path(
            |_, r| {
                mkdir(&r.join("bin1"));
                std::os::unix::fs::symlink(r.join("nowhere"), r.join("bin1/codex")).expect("symlink");
                vec![d(r, "bin1")]
            },
            pj(start(json!({}))),
            None,
        ),
    ));
    out.push(Sc::setup("path-none", with_path(|_, _| vec![BASE_PATH.into()], pj(start(json!({}))), None)));
    out.push(Sc::setup(
        "path-empty-entries",
        with_path(
            |l, r| {
                exe(l, r, "bin1/codex", 0o755);
                vec![String::new(), String::new(), d(r, "bin1"), String::new()]
            },
            pj(start(json!({}))),
            None,
        ),
    ));
    out.push(Sc::setup(
        "path-dotdot",
        with_path(
            |l, r| {
                exe(l, r, "bin1/codex", 0o755);
                mkdir(&r.join("x"));
                vec![d(r, "x/../bin1")]
            },
            pj(start(json!({}))),
            None,
        ),
    ));
    out.push(Sc::setup(
        "path-symlink-dotdot",
        with_path(
            |l, r| {
                exe(l, r, "real/bin/codex", 0o755);
                mkdir(&r.join("real/sub"));
                std::os::unix::fs::symlink(r.join("real/sub"), r.join("lnk")).expect("symlink");
                vec![d(r, "lnk/../bin")]
            },
            pj(start(json!({}))),
            None,
        ),
    ));
    out.push(Sc::setup("path-nonexistent", with_path(|_, _| vec!["/nonexistent/a".into(), "/nonexistent/b".into()], pj(start(json!({}))), None)));
    out.push(Sc::setup("path-unset", |_, _| Built { payload: Some(pj(start(json!({})))), env: vec![("PATH".into(), None)], run_cwd: None }));
    out.push(Sc::setup("path-empty", |_, _| Built { payload: Some(pj(start(json!({})))), env: env_of(&[("PATH", "")]), run_cwd: None }));
    out.push(Sc::setup(
        "path-codex-only-uppercase",
        with_path(
            |l, r| {
                exe(l, r, "bin1/CODEX", 0o755);
                vec![d(r, "bin1")]
            },
            pj(start(json!({}))),
            None,
        ),
    ));
    out.push(Sc::setup(
        "path-unicode-dir",
        with_path(
            |l, r| {
                exe(l, r, "b\u{ed}n \u{1F600}/codex", 0o755);
                vec![d(r, "b\u{ed}n \u{1F600}")]
            },
            pj(start(json!({}))),
            None,
        ),
    ));
    out.push(Sc::setup("path-relative", |l, root| {
        exe(l, root, "rel/codex", 0o755);
        Built { payload: Some(pj(start(json!({})))), env: env_of(&[("PATH", "rel")]), run_cwd: Some(root.to_path_buf()) }
    }));
    // ---- platform
    let exe_on = |payload: Payload| {
        with_path(
            |l, r| {
                exe(l, r, "bin1/codex", 0o755);
                vec![d(r, "bin1")]
            },
            payload,
            None,
        )
    };
    let tp = |p: &str| pj(start(json!({"transcript_path": p})));
    out.push(Sc::setup("claude-startup", exe_on(pj(start(json!({}))))));
    out.push(Sc::setup("codex-turn-id", exe_on(pj(start(json!({"turn_id": "t1"}))))));
    out.push(Sc::setup("codex-empty-turn-id", exe_on(pj(start(json!({"turn_id": ""}))))));
    out.push(Sc::setup("codex-num-turn-id", exe_on(pj(start(json!({"turn_id": 5}))))));
    out.push(Sc::setup("codex-rollout", exe_on(tp("/home/u/.codex/sessions/2026/10/07/rollout-2026-abc.jsonl"))));
    out.push(Sc::setup("codex-rollout-plain", exe_on(tp("/x/rollout-abc.jsonl"))));
    out.push(Sc::setup("codex-rollout-bare", exe_on(tp("rollout-abc.jsonl"))));
    out.push(Sc::setup("codex-rollout-dir", exe_on(tp("/x/rollout-abc.jsonl/y"))));
    out.push(Sc::setup("codex-rollout-short", exe_on(tp("/x/rollout-.jsonl"))));
    out.push(Sc::setup("codex-rollout-too-short", exe_on(tp("/x/rollout.jsonl"))));
    out.push(Sc::setup("codex-backslash-rollout", exe_on(tp("C:\\x\\rollout-1.jsonl"))));
    out.push(Sc::setup("codex-dotcodex-dir", exe_on(tp("/home/u/.codex/x.txt"))));
    out.push(Sc::setup("codex-dotcodex-backslash", exe_on(tp("C:\\u\\.codex\\x.txt"))));
    out.push(Sc::setup("codex-dotcodex-nosep", exe_on(tp("/home/u/.codexx/x"))));
    out.push(Sc::setup("codex-dotcodex-end", exe_on(tp("/home/u/.codex"))));
    out.push(Sc::setup("no-transcript", exe_on(pj(without(start(json!({})), &["transcript_path"])))));
    out.push(Sc::setup("payload-array", exe_on(Payload::Raw("[1]".into()))));
    out.push(Sc::setup("payload-null", exe_on(Payload::Raw("null".into()))));
    out.push(Sc::setup("payload-number", exe_on(Payload::Raw("7".into()))));
    out.push(Sc::setup("payload-empty-object", exe_on(pj(json!({})))));
    out.push(Sc::setup("malformed", exe_on(Payload::Raw("{\"a\":".into()))));
    out.push(Sc::setup("empty-stdin", exe_on(Payload::Raw(String::new()))));
    // ---- quota record
    let future = || now_ms() as f64 + 5.0 * 3600.0 * 1000.0;
    for (label, has_exe) in [("exe", true), ("noexe", false)] {
        let mk: Mk = if has_exe {
            |l, r| {
                exe(l, r, "bin1/codex", 0o755);
                vec![d(r, "bin1")]
            }
        } else {
            |_, r| {
                mkdir(&r.join("bin1"));
                vec![d(r, "bin1")]
            }
        };
        let st = || pj(start(json!({})));
        out.push(Sc::setup(&format!("quota-live-{label}"), {
            let f = with_path(mk, st(), None);
            let q = oj(&[("available", "false".into()), ("until", num(future())), ("reason", js("usage limit")), ("recordedAt", "1".into())]);
            move |l, r| {
                let b = f(l, r);
                rec(Some(q.clone()))(l, r);
                b
            }
        }));
        out.push(Sc::setup(&format!("quota-live-codex-{label}"), {
            let f = with_path(mk, pj(start(json!({"turn_id": "t"}))), None);
            let q = oj(&[("available", "false".into()), ("until", num(future())), ("reason", js("usage limit")), ("recordedAt", "1".into())]);
            move |l, r| {
                let b = f(l, r);
                rec(Some(q.clone()))(l, r);
                b
            }
        }));
        // the variants that depend on the clock: the corpus read the clock once, when it built the scenario
        let expired = now_ms() as f64 - 1000.0;
        let time_variants: Vec<(String, String)> = vec![
            (format!("quota-expired-{label}"), oj(&[("available", "false".into()), ("until", num(expired)), ("reason", js("old"))])),
            (format!("quota-no-until-{label}"), oj(&[("available", "false".into()), ("reason", js("x"))])),
            (format!("quota-string-until-{label}"), oj(&[("available", "false".into()), ("until", js(&num(future()))), ("reason", js("x"))])),
            (format!("quota-no-reason-{label}"), oj(&[("available", "false".into()), ("until", num(future()))])),
            (format!("quota-num-reason-{label}"), oj(&[("available", "false".into()), ("until", num(future())), ("reason", "5".into())])),
            (format!("quota-array-{label}"), "[1,2]".into()),
            (format!("quota-null-{label}"), "null".into()),
            (format!("quota-huge-until-{label}"), oj(&[("until", num(1e300)), ("reason", js("x"))])),
            (format!("quota-far-until-{label}"), oj(&[("until", num(9e15)), ("reason", js("x"))])),
            (format!("quota-unicode-reason-{label}"), oj(&[("until", num(future())), ("reason", js("caf\u{e9} \u{1F600}  spaced\n\tout"))])),
            (format!("quota-frac-until-{label}"), oj(&[("until", num(future() + 0.75)), ("reason", js("x"))])),
        ];
        for (id, q) in time_variants {
            let f = with_path(mk, pj(start(json!({}))), None);
            out.push(Sc::setup(&id, move |l, r| {
                let b = f(l, r);
                rec(Some(q.clone()))(l, r);
                b
            }));
        }
    }
    let mk1: Mk = |l, r| {
        exe(l, r, "bin1/codex", 0o755);
        vec![d(r, "bin1")]
    };
    let raw_state = |txt: &'static str| {
        let f = with_path(mk1, pj(start(json!({}))), None);
        move |l: &Lab, r: &Path| {
            let b = f(l, r);
            l.write(r, "home/.anti-hall/codex-availability.json", txt, None);
            b
        }
    };
    out.push(Sc::setup("state-corrupt", raw_state("{nope")));
    out.push(Sc::setup("state-array", raw_state("[1]")));
    out.push(Sc::setup("state-empty", raw_state("")));
    out.push(Sc::setup(
        "state-extras",
        raw_state("{\"zz\":1,\"quota\":{\"until\":1,\"reason\":\"x\"},\"aa\":[{\"b\":1,\"a\":2}],\"5\":1,\"available\":\"old\"}"),
    ));
    out.push(Sc::setup("state-proto", raw_state("{\"__proto__\":{\"x\":1}}")));
    out.push(Sc::setup("state-lone-surrogate", raw_state("{\"a\":\"\\ud83d\"}")));
    out.push(Sc::setup("state-bom", raw_state("\u{feff}{\"a\":1}")));
    out.push(Sc::setup("state-dir-blocks", |l, root| {
        l.write(root, "home/.anti-hall/codex-availability.json/x", "y", None);
        exe(l, root, "bin1/codex", 0o755);
        Built { payload: Some(pj(start(json!({})))), env: env_of(&[("PATH", &d(root, "bin1"))]), run_cwd: None }
    }));
    out.push(Sc::setup("state-anti-hall-is-file", |l, root| {
        std::fs::remove_dir_all(root.join("home/.anti-hall")).expect("remove state dir");
        l.write(root, "home/.anti-hall", "file", None);
        exe(l, root, "bin1/codex", 0o755);
        Built { payload: Some(pj(start(json!({})))), env: env_of(&[("PATH", &d(root, "bin1"))]), run_cwd: None }
    }));
    // ---- job logs
    let noexe: Mk = |_, r| {
        mkdir(&r.join("bin1"));
        vec![d(r, "bin1")]
    };
    let job_sc = |id: &str, specs: Vec<(String, String, String, i64)>| {
        Sc::setup(id, {
            let f = with_path(noexe, pj(start(json!({}))), Some(jobs(specs)));
            move |l, r| f(l, r)
        })
    };
    let s = |a: &str, b: &str, c: String, age: i64| (a.to_string(), b.to_string(), c, age);
    let oct3 = "Oct 3rd, 2030 9:11 PM";
    out.push(job_sc("job-future", vec![s("repoA", "task-1.log", logmsg(oct3), 60)]));
    out.push(job_sc("job-future-iso", vec![s("repoA", "task-1.log", "out of quota until 2030-10-08T12:00:00Z.\n".into(), 60)]));
    out.push(job_sc("job-past-date", vec![s("repoA", "task-1.log", logmsg("Oct 3rd, 2020 9:11 PM"), 60)]));
    out.push(job_sc("job-no-date", vec![s("repoA", "task-1.log", "You are out of quota.\n".into(), 120)]));
    out.push(job_sc("job-no-date-old-but-in-window", vec![s("repoA", "task-1.log", "You are out of quota.\n".into(), 20 * 3600)]));
    out.push(job_sc("job-no-date-too-old", vec![s("repoA", "task-1.log", "You are out of quota.\n".into(), 30 * 3600)]));
    out.push(job_sc("job-not-a-log", vec![s("repoA", "task-1.txt", logmsg(oct3), 60)]));
    out.push(job_sc("job-two-logs-newest-wins", vec![s("repoA", "a.log", logmsg(oct3), 600), s("repoA", "b.log", logmsg("Nov 3rd, 2031 9:11 PM"), 60)]));
    out.push(job_sc("job-two-repos", vec![s("repoA", "a.log", logmsg(oct3), 600), s("repoB", "b.log", logmsg("Nov 3rd, 2031 9:11 PM"), 60)]));
    out.push(job_sc("job-equal-mtime-tie", vec![s("repoA", "a.log", logmsg(oct3), 100), s("repoA", "b.log", logmsg("Nov 3rd, 2031 9:11 PM"), 100)]));
    for (id, until_iso, reason) in
        [("job-existing-later-outage", "2031-01-01T00:00:00Z", "later"), ("job-existing-earlier-outage", "2029-01-01T00:00:00Z", "earlier")]
    {
        let f = with_path(noexe, pj(start(json!({}))), None);
        let j = jobs(vec![s("repoA", "a.log", logmsg(oct3), 60)]);
        out.push(Sc::setup(id, move |l, r| {
            let b = f(l, r);
            j(l, r);
            let until = super::lab::iso_ms(until_iso).expect("a valid instant") as f64;
            rec(Some(oj(&[("available", "false".into()), ("until", num(until)), ("reason", js(reason))])))(l, r);
            b
        }));
    }
    out.push(job_sc("job-big-log-message-in-tail", vec![s("repoA", "a.log", format!("{}\n{}", "x".repeat(20000), logmsg(oct3)), 60)]));
    out.push(job_sc("job-big-log-message-before-tail", vec![s("repoA", "a.log", format!("{}{}", logmsg(oct3), "x".repeat(20000)), 60)]));
    out.push(job_sc("job-tail-cuts-multibyte", vec![s("repoA", "a.log", format!("{}{}", "\u{e9}".repeat(5000), logmsg(oct3)), 60)]));
    out.push(job_sc("job-empty-log", vec![s("repoA", "a.log", String::new(), 60)]));
    out.push(Sc::setup(
        "job-no-jobs-dir",
        with_path(noexe, pj(start(json!({}))), Some(Box::new(|_, r| mkdir(&r.join("home/.claude/plugins/data/codex-openai-codex/state/repoA"))))),
    ));
    out.push(job_sc(
        "job-many-repos",
        (0..25).map(|i| s(&format!("repo{i:02}"), "a.log", logmsg(&format!("Oct {} 2030 9:11 PM", (i % 28) + 1)), 100 + i as i64)).collect(),
    ));
    out.push(job_sc(
        "job-many-logs",
        (0..14).map(|i| s("repoA", &format!("l{i:02}.log"), if i == 13 { logmsg(oct3) } else { "nothing here\n".into() }, 100 + i as i64)).collect(),
    ));
    out.push(job_sc("job-switch-off-env", vec![s("repoA", "a.log", logmsg(oct3), 60)]).env("ANTIHALL_CODEX_QUOTA_DETECT", "0"));
    out.push(Sc::setup("job-switch-off-settings", move |l, root| {
        l.write(root, "home/.anti-hall/settings.json", json!({"guards": {"codexQuotaDetect": false}}).to_string(), None);
        jobs(vec![s("repoA", "a.log", logmsg(oct3), 60)])(l, root);
        Built { payload: Some(pj(start(json!({})))), env: env_of(&[("PATH", &noexe(l, root).join(":"))]), run_cwd: None }
    }));
    out.push(job_sc("job-date-unfamiliar-shape", vec![s("repoA", "a.log", logmsg("12/25/2030"), 60)]));
    for tz in ["America/New_York", "Asia/Kolkata"] {
        out.push(job_sc(&format!("job-local-time-{tz}"), vec![s("repoA", "a.log", logmsg(oct3), 60)]).env("TZ", tz));
    }
    // ---- switches and children
    out.push(Sc::setup("judge-child", exe_on(pj(start(json!({}))))).env("ANTIHALL_JUDGE_CHILD", "1"));
    out.push(Sc::setup("judge-child-zero", exe_on(pj(start(json!({}))))).env("ANTIHALL_JUDGE_CHILD", "0"));
    out.push(Sc::setup("home-unwritable", |l, root| {
        exe(l, root, "bin1/codex", 0o755);
        std::fs::set_permissions(root.join("home/.anti-hall"), std::fs::Permissions::from_mode(0o555)).expect("chmod");
        Built { payload: Some(pj(start(json!({})))), env: env_of(&[("PATH", &d(root, "bin1"))]), run_cwd: None }
    }));
    let _ = Value::Null;
    out
}
