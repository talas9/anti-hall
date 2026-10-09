//! Corpus for handover-resume (SessionStart): sources, discovery, freshness, writer activity, shape, snapshots, state.

use super::b78::*;
use super::jsjson::{J, a, n, o, s};
use super::lab::Lab;
use super::support::*;
use std::path::{Path, PathBuf};

const SID: &str = "sess-1";
const D: f64 = 86400.0;

fn day() -> String {
    local_day(0.0)
}
fn enc(p: &Path) -> String {
    p.to_string_lossy().chars().flat_map(|c| if matches!(c, '/' | '\\' | ':' | '.') { vec!['-'] } else { vec![c] }).collect()
}
fn hdir(repo: &Path, sid: &str, date: Option<&str>) -> PathBuf {
    repo.join(".anti-hall/handovers").join(date.map_or_else(day, str::to_string)).join(if sid.is_empty() { SID } else { sid })
}
fn hand(lab: &Lab, repo: &Path, sid: &str, name: &str, content: Option<&str>, age: Option<f64>, date: Option<&str>) -> PathBuf {
    let f = hdir(repo, sid, date).join(name);
    write_file(&f, content.unwrap_or("# handover\nSituation\n").as_bytes());
    if let Some(a) = age {
        set_mtime(&f, lab.base as f64 - a);
    }
    f
}
fn ps(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

const FULL: &str = "# H\n\n## Resume-verification checklist\n- do it\n";

type Before = Box<dyn Fn(&Lab, &Path, &Path) + Send + Sync>;
type PayloadFn = Box<dyn Fn(&Path, &Path) -> Vec<(&'static str, Option<J>)> + Send + Sync>;

struct Mk {
    no_repo: bool,
    before: Option<Before>,
    payload: Option<PayloadFn>,
    env: Env,
}

fn mk() -> Mk {
    Mk { no_repo: false, before: None, payload: None, env: Vec::new() }
}

impl Mk {
    fn no_repo(mut self) -> Mk {
        self.no_repo = true;
        self
    }
    fn before(mut self, f: impl Fn(&Lab, &Path, &Path) + Send + Sync + 'static) -> Mk {
        self.before = Some(Box::new(f));
        self
    }
    fn payload(mut self, f: impl Fn(&Path, &Path) -> Vec<(&'static str, Option<J>)> + Send + Sync + 'static) -> Mk {
        self.payload = Some(Box::new(f));
        self
    }
    fn set(self, k: &'static str, v: Option<J>) -> Mk {
        self.payload(move |_, _| vec![(k, v.clone())])
    }
    fn build(&self, lab: &Lab, root: &Path) -> Built {
        let repo = if self.no_repo {
            std::fs::create_dir_all(root.join("plain")).expect("plain dir");
            root.join("plain")
        } else {
            lab.repo(root, "repo", &[])
        };
        if let Some(b) = &self.before {
            b(lab, root, &repo);
        }
        let mut p = o(vec![
            ("hook_event_name", s("SessionStart")),
            ("session_id", s(SID)),
            ("cwd", s(&ps(&repo))),
            ("source", s("startup")),
            ("transcript_path", s(&ps(&root.join("home/.claude/projects").join(enc(&repo)).join(format!("{SID}.jsonl"))))),
        ]);
        if let Some(pf) = &self.payload {
            for (k, v) in pf(root, &repo) {
                match v {
                    Some(v) => p.set(k, v),
                    None => p.remove(k),
                }
            }
        }
        Built { payload: Some(Payload::Raw(p.text())), env: self.env.clone(), run_cwd: None }
    }
}

fn sc(id: &str, m: Mk) -> Sc {
    Sc::setup(id, move |lab, root| m.build(lab, root))
}

/// One handover of the session with the given age, content and name.
fn one(age: f64, content: Option<&'static str>, name: &'static str) -> impl Fn(&Lab, &Path, &Path) + Send + Sync + Clone {
    move |lab, _, repo| {
        hand(lab, repo, SID, name, content, Some(age), None);
    }
}
fn one_h(age: f64) -> impl Fn(&Lab, &Path, &Path) + Send + Sync + Clone {
    one(age, None, "HANDOVER.md")
}

fn tr(lab: &Lab, r: &Path, repo: &Path, sid: &str, age: f64) -> PathBuf {
    let f = lab.write(r, &format!("home/.claude/projects/{}/{sid}.jsonl", enc(repo)), "{}\n", None);
    set_mtime(&f, lab.base as f64 - age);
    f
}

pub(crate) fn scenarios() -> Vec<Sc> {
    let mut out: Vec<Sc> = Vec::new();
    // ---- sources and presence
    let srcs: Vec<(String, Option<J>)> = vec![
        ("\"startup\"".into(), Some(s("startup"))),
        ("\"resume\"".into(), Some(s("resume"))),
        ("\"clear\"".into(), Some(s("clear"))),
        ("\"compact\"".into(), Some(s("compact"))),
        ("\"\"".into(), Some(s(""))),
        ("\"other\"".into(), Some(s("other"))),
        ("undefined".into(), None),
        ("5".into(), Some(n(5.0))),
        ("null".into(), Some(J::Null)),
    ];
    for (id, v) in srcs {
        out.push(sc(&format!("src-{id}-with-handover"), mk().before(one_h(3600.0)).set("source", v.clone())));
        out.push(sc(&format!("src-{id}-none"), mk().set("source", v)));
    }
    out.push(sc(
        "none-handovers-dir-empty",
        mk().before(|_, _, repo| std::fs::create_dir_all(repo.join(".anti-hall/handovers")).expect("dir")).set("source", Some(s("clear"))),
    ));
    out.push(sc(
        "none-handovers-is-file",
        mk().before(|lab, _, repo| {
            lab.write(repo, ".anti-hall/handovers", "f", None);
        })
        .set("source", Some(s("clear"))),
    ));
    out.push(sc(
        "none-handovers-symlink-dir",
        mk().before(|lab, r, repo| {
            hand(lab, repo, SID, "HANDOVER.md", Some("# x"), Some(100.0), None);
            std::fs::rename(repo.join(".anti-hall/handovers"), r.join("moved")).expect("rename");
            std::os::unix::fs::symlink(r.join("moved"), repo.join(".anti-hall/handovers")).expect("symlink");
        })
        .set("source", Some(s("compact"))),
    ));
    out.push(sc(
        "none-dir-no-md",
        mk().before(|lab, _, repo| {
            hand(lab, repo, SID, "notes.txt", Some("x"), Some(100.0), None);
        })
        .set("source", Some(s("clear"))),
    ));
    // ---- age
    for (id, age) in [("1h", 3600.0), ("6d", 6.0 * D), ("6.99d", 6.99 * D), ("7.01d", 7.01 * D), ("30d", 30.0 * D), ("future", -3600.0)] {
        out.push(sc(&format!("age-{id}"), mk().before(one_h(age)).set("source", Some(s("compact")))));
    }
    out.push(sc("age-stale-clear-no-negative", mk().before(one_h(30.0 * D)).set("source", Some(s("clear")))));
    // ---- session preference
    let h = |lab: &Lab, repo: &Path, sid: &str, name: &str, c: &str, age: f64| {
        hand(lab, repo, sid, name, Some(c), Some(age), None);
    };
    out.push(sc(
        "sess-same-vs-newer-other",
        mk().before(move |l, _, r| {
            h(l, r, SID, "HANDOVER.md", "# a", 3600.0);
            h(l, r, "other", "HANDOVER.md", "# b", 10.0);
        }),
    ));
    out.push(sc("sess-only-other", mk().before(move |l, _, r| h(l, r, "other", "HANDOVER.md", "# b", 10.0))));
    out.push(sc("sess-no-session-id", mk().before(move |l, _, r| h(l, r, "other", "HANDOVER.md", "# b", 10.0)).set("session_id", None)));
    out.push(sc("sess-empty-session-id", mk().before(move |l, _, r| h(l, r, "other", "HANDOVER.md", "# b", 10.0)).set("session_id", Some(s("")))));
    out.push(sc(
        "sess-same-stale-other-fresh",
        mk().before(move |l, _, r| {
            h(l, r, SID, "HANDOVER.md", "# a", 30.0 * D);
            h(l, r, "other", "HANDOVER.md", "# b", 10.0);
        }),
    ));
    out.push(sc(
        "sess-tie",
        mk().before(move |l, _, r| {
            h(l, r, "aaa", "HANDOVER.md", "# a", 100.0);
            h(l, r, "bbb", "HANDOVER.md", "# b", 100.0);
        }),
    ));
    out.push(sc(
        "sess-seq-2",
        mk().before(move |l, _, r| {
            h(l, r, SID, "HANDOVER.md", "# a", 200.0);
            h(l, r, SID, "HANDOVER-2.md", "# b", 100.0);
        }),
    ));
    out.push(sc("sess-seq-3", mk().before(move |l, _, r| h(l, r, SID, "HANDOVER-3.md", "# b", 100.0))));
    out.push(sc("sess-seq-10", mk().before(move |l, _, r| h(l, r, SID, "HANDOVER-10.md", "# b", 100.0))));
    out.push(sc("sess-seq-0", mk().before(move |l, _, r| h(l, r, SID, "HANDOVER-0.md", "# b", 100.0))));
    out.push(sc("sess-seq-huge", mk().before(move |l, _, r| h(l, r, SID, "HANDOVER-99999999999999999999.md", "# b", 100.0))));
    let sids: Vec<(&str, J)> = vec![
        ("num", n(12345.0)),
        ("zero", n(0.0)),
        ("false", J::Bool(false)),
        ("true", J::Bool(true)),
        ("array", a(vec![s("a"), s("b")])),
        ("object", o(vec![("a", n(1.0))])),
        ("null", J::Null),
        ("weird", s("a b/c..d")),
        ("unicode", s("sess-\u{e9}\u{1F600}")),
        ("long", s(&"s".repeat(300))),
    ];
    for (id, v) in sids {
        out.push(sc(&format!("sid-{id}"), mk().before(move |l, _, r| h(l, r, "other", "HANDOVER.md", "# b", 100.0)).set("session_id", Some(v))));
    }
    // ---- INDEX.md outcome
    let row = |seq: u32, outcome: &str, sid: Option<&str>, date: Option<&str>| {
        format!(
            "- {} \u{b7} {} \u{b7} seq {seq} \u{b7} {outcome} \u{b7} [sub] \u{b7} [main]({}/{SID}/HANDOVER.md)",
            date.map_or_else(day, str::to_string),
            sid.unwrap_or(SID),
            day()
        )
    };
    let idx = |lines: Vec<String>| {
        mk().before(move |l, _, r| {
            h(l, r, SID, "HANDOVER.md", "# a", 3600.0);
            h(l, r, SID, "HANDOVER-2.md", "# a", 1800.0);
            l.write(r, ".anti-hall/handovers/INDEX.md", lines.join("\n"), None);
        })
    };
    out.push(sc("index-match-seq", idx(vec![row(1, "first outcome", None, None), row(2, "second outcome", None, None)])));
    out.push(sc("index-fallback-last", idx(vec![row(1, "first outcome", None, None), row(5, "later outcome", None, None)])));
    out.push(sc("index-other-session", idx(vec![row(1, "other", Some("someone-else"), None)])));
    out.push(sc("index-other-date", idx(vec![row(1, "old", Some(SID), Some("2020-01-01"))])));
    out.push(sc("index-short-row", idx(vec![format!("- {} \u{b7} {SID} \u{b7} seq 2", day())])));
    out.push(sc("index-empty-outcome", idx(vec![format!("- {} \u{b7} {SID} \u{b7} seq 2 \u{b7}  \u{b7} x", day())])));
    out.push(sc("index-unicode-outcome", idx(vec![row(2, "caf\u{e9} \u{1F600} \u{4e2d}\u{6587}", None, None)])));
    out.push(sc("index-crlf", idx(vec![format!("{}\r", row(2, "crlf outcome", None, None)), String::new()])));
    out.push(sc("index-dotless-separators", idx(vec![format!("- {} | {SID} | seq 2 | ascii pipes | x", day())])));
    out.push(sc(
        "index-is-dir",
        mk().before(move |l, _, r| {
            h(l, r, SID, "HANDOVER.md", "# a", 3600.0);
            std::fs::create_dir_all(r.join(".anti-hall/handovers/INDEX.md")).expect("dir");
        }),
    ));
    // ---- freshness (git)
    out.push(sc("fresh-clean", mk().before(one_h(3600.0))));
    out.push(sc(
        "fresh-dirty",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            l.write(repo, "new.txt", "n", None);
            l.write(repo, "a.txt", "changed\n", None);
        }),
    ));
    out.push(sc(
        "fresh-commits-since",
        mk().before(|l, r, repo| {
            one_h(3.0 * 3600.0)(l, r, repo);
            for i in 0..2 {
                l.write(repo, &format!("c{i}.txt"), "c", None);
                l.git(repo, &["add", "-A"]);
                let date = iso_from_secs(l.base - 3600);
                let out = std::process::Command::new("git")
                    .args(["commit", "-q", "-m", &format!("c{i}")])
                    .current_dir(repo)
                    .envs(super::lab::GITENV)
                    .env("GIT_AUTHOR_DATE", &date)
                    .env("GIT_COMMITTER_DATE", &date)
                    .output()
                    .expect("git");
                assert!(out.status.success(), "commit failed: {}", String::from_utf8_lossy(&out.stderr));
            }
        }),
    ));
    out.push(sc("fresh-not-git", mk().no_repo().before(|l, r, repo| one_h(3600.0)(l, r, repo))));
    out.push(sc(
        "fresh-subdir-cwd",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            std::fs::create_dir_all(repo.join("sub")).expect("sub");
        })
        .payload(|_, repo| vec![("cwd", Some(s(&ps(&repo.join("sub")))))]),
    ));
    out.push(sc(
        "fresh-detached",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            l.git(repo, &["checkout", "-q", "--detach"]);
        }),
    ));
    out.push(Sc::setup("fresh-no-commits", |lab, root| {
        let d = root.join("repo");
        std::fs::create_dir_all(&d).expect("repo dir");
        lab.git(&d, &["init", "-q", "-b", "main"]);
        hand(lab, &d, SID, "HANDOVER.md", Some("# a"), Some(3600.0), None);
        Built {
            payload: Some(Payload::Raw(
                o(vec![("hook_event_name", s("SessionStart")), ("session_id", s(SID)), ("cwd", s(&ps(&d))), ("source", s("startup"))]).text(),
            )),
            ..Built::default()
        }
    }));
    out.push(sc(
        "fresh-dirty-many",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            for i in 0..30 {
                l.write(repo, &format!("u{i}.txt"), "x", None);
            }
        }),
    ));
    out.push(sc("fresh-future-mtime", mk().before(one_h(-7200.0))));
    // Deterministic freshness-timeout case: a git slower than the 1500 ms
    // per-call cap makes BOTH sides omit the Freshness line (the cause of a
    // load-induced one-off mismatch on fresh-future-mtime).
    out.push(Sc::setup("freshness-git-slower-than-cap", |lab, root| {
        let real_path = std::env::var("PATH").expect("PATH is set for the test run");
        let dir = root.join("slowgit");
        lab.write(root, "slowgit/git", format!("#!/bin/sh\nsleep 2\nPATH='{real_path}' exec git \"$@\"\n"), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.join("git"), std::fs::Permissions::from_mode(0o755)).expect("chmod slow git shim");
        }
        let mut m = mk().before(one_h(-7200.0));
        m.env = vec![("PATH".to_string(), Some(format!("{}:{real_path}", dir.display())))];
        m.build(lab, root)
    }));
    // ---- writer activity
    out.push(sc(
        "writer-kept-running",
        mk().before(|l, r, repo| {
            one_h(3.0 * 3600.0)(l, r, repo);
            tr(l, r, repo, SID, 600.0);
        }),
    ));
    out.push(sc(
        "writer-within-grace",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            tr(l, r, repo, SID, 3600.0 - 120.0);
        }),
    ));
    out.push(sc(
        "writer-exactly-grace",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            tr(l, r, repo, SID, 3600.0 - 300.0);
        }),
    ));
    out.push(sc(
        "writer-older-than-handover",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            tr(l, r, repo, SID, 7200.0);
        }),
    ));
    out.push(sc("writer-no-transcript", mk().before(one_h(3600.0))));
    out.push(sc(
        "writer-other-session-handover",
        mk().before(|l, r, repo| {
            hand(l, repo, "other", "HANDOVER.md", Some("# a"), Some(3.0 * 3600.0), None);
            tr(l, r, repo, "other", 600.0);
        }),
    ));
    out.push(sc(
        "writer-session-id-invalid",
        mk().before(|l, r, repo| {
            hand(l, repo, "a b", "HANDOVER.md", Some("# a"), Some(3.0 * 3600.0), None);
            tr(l, r, repo, "a b", 600.0);
        })
        .set("session_id", None),
    ));
    out.push(sc(
        "writer-minutes-rounding",
        mk().before(|l, r, repo| {
            one_h(3.0 * 3600.0)(l, r, repo);
            tr(l, r, repo, SID, 3.0 * 3600.0 - 29.0 * 60.0 - 30.0);
        }),
    ));
    out.push(sc(
        "writer-cwd-subdir-second-root",
        mk().before(|l, r, repo| {
            one_h(3.0 * 3600.0)(l, r, repo);
            std::fs::create_dir_all(repo.join("sub")).expect("sub");
            tr(l, r, &repo.join("sub"), SID, 600.0);
        })
        .payload(|_, repo| vec![("cwd", Some(s(&ps(&repo.join("sub")))))]),
    ));
    out.push(sc(
        "writer-first-root-wins-even-if-small-gap",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            std::fs::create_dir_all(repo.join("sub")).expect("sub");
            tr(l, r, repo, SID, 3500.0);
            tr(l, r, &repo.join("sub"), SID, 100.0);
        })
        .payload(|_, repo| vec![("cwd", Some(s(&ps(&repo.join("sub")))))]),
    ));
    out.push(sc(
        "writer-fractional-mtime",
        mk().before(|l, r, repo| {
            let f = hand(l, repo, SID, "HANDOVER.md", Some("# a"), None, None);
            set_mtime(&f, l.base as f64 - 4.0 * 3600.0 + 0.5);
            let g = l.write(r, &format!("home/.claude/projects/{}/{SID}.jsonl", enc(repo)), "{}", None);
            set_mtime(&g, l.base as f64 - 600.0 + 0.25);
        }),
    ));
    // ---- handover shape
    let shape = |content: &'static str, files: &'static [&'static str]| {
        mk().before(move |l, _, r| {
            hand(l, r, SID, "HANDOVER.md", Some(content), Some(3600.0), None);
            for f in files {
                hand(l, r, SID, f, Some("x"), Some(3600.0), None);
            }
        })
    };
    for (id, content) in [
        ("shape-checklist", FULL),
        ("shape-checklist-lower", "## resume-verification CHECKLIST\n"),
        ("shape-checklist-space-before-title", "##    Resume-verification checklist"),
        ("shape-checklist-newline-between", "##\n\nResume-verification checklist"),
        ("shape-checklist-indented", "  ## Resume-verification checklist"),
        ("shape-checklist-h3", "### Resume-verification checklist"),
        ("shape-checklist-word-boundary", "## Resume-verification checklists"),
        ("shape-checklist-boundary-underscore", "## Resume-verification checklist_x"),
        ("shape-checklist-boundary-punct", "## Resume-verification checklist: do"),
        ("shape-checklist-boundary-unicode", "## Resume-verification checklist\u{e9}"),
        ("shape-checklist-crlf", "# H\r\n## Resume-verification checklist\r\n"),
        ("shape-checklist-cr-only", "# H\r## Resume-verification checklist"),
        ("shape-checklist-ls", "# H\u{2028}## Resume-verification checklist"),
        ("shape-checklist-after-text", "text ## Resume-verification checklist"),
        ("shape-checklist-kelvin", "## Resume-verification chec\u{212a}list"),
        ("shape-checklist-fullwidth-space", "##\u{3000}Resume-verification checklist"),
        ("shape-checklist-nbsp", "##\u{a0}Resume-verification checklist"),
        ("shape-no-checklist", "# no section\n"),
        ("shape-empty-file", ""),
        ("shape-binary", "\u{0}\u{1}\u{ff} garbage"),
    ] {
        out.push(sc(id, shape(content, &[])));
    }
    let detail_sets: Vec<Vec<&'static str>> = vec![
        vec![],
        vec!["state.md"],
        vec!["trials.md"],
        vec!["decisions.md", "knowledge.md"],
        vec!["state.md", "decisions.md", "trials.md", "knowledge.md"],
        vec!["state.md/"],
    ];
    for fs_ in detail_sets {
        let id = format!("shape-details-{}", fs_.join("+"));
        out.push(sc(
            &id,
            mk().before(move |l, _, r| {
                hand(l, r, SID, "HANDOVER.md", Some(FULL), Some(3600.0), None);
                for f in &fs_ {
                    if f.ends_with('/') {
                        std::fs::create_dir_all(hdir(r, SID, None).join(f)).expect("dir");
                    } else {
                        hand(l, r, SID, f, Some("x"), Some(3600.0), None);
                    }
                }
            }),
        ));
    }
    out.push(sc(
        "shape-detail-is-dir",
        mk().before(|l, _, r| {
            hand(l, r, SID, "HANDOVER.md", Some(FULL), Some(3600.0), None);
            std::fs::create_dir_all(hdir(r, SID, None).join("trials.md")).expect("dir");
        }),
    ));
    out.push(sc("shape-handover-is-dir", mk().before(|_, _, r| std::fs::create_dir_all(hdir(r, SID, None).join("HANDOVER.md")).expect("dir"))));
    // ---- PreCompact snapshots
    let snap = |name: &'static str, age: f64, sid: &'static str| {
        move |l: &Lab, _: &Path, r: &Path| {
            hand(l, r, sid, name, Some("# snap"), Some(age), None);
        }
    };
    out.push(sc(
        "snap-newer-than-handover",
        mk().before(move |l, r, repo| {
            one_h(3600.0)(l, r, repo);
            snap("PRECOMPACT-1.md", 600.0, SID)(l, r, repo);
        }),
    ));
    out.push(sc(
        "snap-older-than-handover",
        mk().before(move |l, r, repo| {
            one_h(600.0)(l, r, repo);
            snap("PRECOMPACT-1.md", 3600.0, SID)(l, r, repo);
        }),
    ));
    out.push(sc(
        "snap-two-newest-wins",
        mk().before(move |l, r, repo| {
            one_h(3600.0)(l, r, repo);
            snap("PRECOMPACT-1.md", 900.0, SID)(l, r, repo);
            snap("PRECOMPACT-2.md", 600.0, SID)(l, r, repo);
        }),
    ));
    out.push(sc(
        "snap-same-mtime-seq-wins",
        mk().before(move |l, r, repo| {
            one_h(3600.0)(l, r, repo);
            snap("PRECOMPACT-3.md", 600.0, SID)(l, r, repo);
            snap("PRECOMPACT-12.md", 600.0, SID)(l, r, repo);
            snap("PRECOMPACT-2.md", 600.0, SID)(l, r, repo);
        }),
    ));
    out.push(sc(
        "snap-stale-ignored",
        mk().before(move |l, r, repo| {
            one_h(3600.0)(l, r, repo);
            snap("PRECOMPACT-1.md", 8.0 * D, SID)(l, r, repo);
        }),
    ));
    out.push(sc(
        "snap-other-session-ignored",
        mk().before(move |l, r, repo| {
            one_h(3600.0)(l, r, repo);
            snap("PRECOMPACT-1.md", 600.0, "other")(l, r, repo);
        }),
    ));
    out.push(sc("snap-only", mk().before(snap("PRECOMPACT-1.md", 600.0, SID))));
    out.push(sc("snap-only-clear", mk().before(snap("PRECOMPACT-1.md", 600.0, SID)).set("source", Some(s("clear")))));
    out.push(sc(
        "snap-only-stale-handover",
        mk().before(move |l, r, repo| {
            one_h(30.0 * D)(l, r, repo);
            snap("PRECOMPACT-1.md", 600.0, SID)(l, r, repo);
        }),
    ));
    out.push(sc(
        "snap-only-other-session-handover",
        mk().before(move |l, r, repo| {
            hand(l, repo, "other", "HANDOVER.md", Some("# b"), Some(20.0 * D), None);
            snap("PRECOMPACT-1.md", 600.0, SID)(l, r, repo);
        }),
    ));
    out.push(sc("snap-only-no-session-id", mk().before(snap("PRECOMPACT-1.md", 600.0, SID)).set("session_id", None)));
    out.push(sc(
        "snap-huge-seq",
        mk().before(move |l, r, repo| {
            one_h(3600.0)(l, r, repo);
            snap("PRECOMPACT-99999999999999999999.md", 600.0, SID)(l, r, repo);
        }),
    ));
    out.push(sc(
        "snap-fractional-mtime",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            let f = hand(l, repo, SID, "PRECOMPACT-1.md", Some("s"), None, None);
            set_mtime(&f, 1790000000.987654);
        }),
    ));
    // ---- platform, event name, switches
    out.push(sc("codex-turn-id", mk().before(one(3600.0, Some(FULL), "HANDOVER.md")).set("turn_id", Some(s("t1")))));
    out.push(sc("codex-rollout", mk().before(one_h(3600.0)).set("transcript_path", Some(s("/h/.codex/sessions/x/rollout-1.jsonl")))));
    out.push(sc(
        "codex-snapshot-only",
        mk().before(snap("PRECOMPACT-1.md", 600.0, SID)).payload(|_, _| vec![("turn_id", Some(s("t1"))), ("source", Some(s("compact")))]),
    ));
    let evs: Vec<(String, Option<J>)> = vec![
        ("undefined".into(), None),
        ("\"\"".into(), Some(s(""))),
        ("\"PostCompact\"".into(), Some(s("PostCompact"))),
        ("\"SessionStart\"".into(), Some(s("SessionStart"))),
        ("5".into(), Some(n(5.0))),
        ("null".into(), Some(J::Null)),
        ("\"weird\\nname\"".into(), Some(s("weird\nname"))),
    ];
    for (id, v) in evs {
        out.push(sc(&format!("event-{id}"), mk().before(one_h(3600.0)).set("hook_event_name", v)));
    }
    out.push(sc("event-negative", mk().payload(|_, _| vec![("hook_event_name", Some(s("Custom"))), ("source", Some(s("clear")))])));
    out.push(Sc::setup("switch-off-settings", |lab, root| {
        lab.write(root, "home/.anti-hall/settings.json", "{\"context\":{\"handoverResume\":false}}", None);
        mk().before(one_h(3600.0)).build(lab, root)
    }));
    out.push(sc("switch-off-plugin-option", mk().before(one_h(3600.0))).env("CLAUDE_PLUGIN_OPTION_CONTEXT_HANDOVER_RESUME", "false"));
    out.push(sc("judge-child", mk().before(one_h(3600.0))).env("ANTIHALL_JUDGE_CHILD", "1"));
    // ---- cwd shapes
    out.push(sc("cwd-none", mk().before(one_h(3600.0)).set("cwd", None)));
    out.push(sc("cwd-empty", mk().before(one_h(3600.0)).set("cwd", Some(s("")))));
    out.push(sc("cwd-num", mk().before(one_h(3600.0)).set("cwd", Some(n(5.0)))));
    out.push(sc("cwd-relative", mk().before(one_h(3600.0)).set("cwd", Some(s("rel")))));
    out.push(sc("cwd-missing", mk().before(one_h(3600.0)).payload(|r, _| vec![("cwd", Some(s(&ps(&r.join("nope")))))])));
    out.push(sc(
        "cwd-subdir",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            std::fs::create_dir_all(repo.join("a/b")).expect("dir");
        })
        .payload(|_, repo| vec![("cwd", Some(s(&ps(&repo.join("a/b")))))]),
    ));
    out.push(sc("cwd-in-handovers", mk().before(one_h(3600.0)).payload(|_, repo| vec![("cwd", Some(s(&ps(&repo.join(".anti-hall/handovers")))))])));
    out.push(sc(
        "cwd-symlink",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            std::os::unix::fs::symlink(repo, r.join("lnk")).expect("symlink");
        })
        .payload(|r, _| vec![("cwd", Some(s(&ps(&r.join("lnk")))))]),
    ));
    out.push(sc("cwd-not-git-with-handovers", mk().no_repo().before(one_h(3600.0))));
    out.push(Sc::setup("cwd-home-repo", |lab, root| {
        let home = root.join("home");
        lab.git(&home, &["init", "-q", "-b", "main"]);
        lab.write(&home, "dot.txt", "d", None);
        lab.git(&home, &["add", "dot.txt"]);
        lab.git(&home, &["commit", "-q", "-m", "dots"]);
        hand(lab, &home, SID, "HANDOVER.md", Some("# h"), Some(3600.0), None);
        Built {
            payload: Some(Payload::Raw(
                o(vec![("hook_event_name", s("SessionStart")), ("session_id", s(SID)), ("cwd", s(&ps(&home))), ("source", s("startup"))]).text(),
            )),
            ..Built::default()
        }
    }));
    out.push(sc(
        "cwd-linked-worktree",
        mk().before(|l, r, repo| {
            l.git(repo, &["worktree", "add", "-q", &ps(&r.join("wt")), "-b", "feat"]);
            hand(l, &r.join("wt"), SID, "HANDOVER.md", Some("# h"), Some(3600.0), None);
        })
        .payload(|r, _| vec![("cwd", Some(s(&ps(&r.join("wt")))))]),
    ));
    out.push(Sc::setup("cwd-submodule", |lab, root| {
        let repo = lab.repo_no_files(root, "repo");
        let sub = lab.repo(root, "subsrc", &[("s.txt", "s")]);
        lab.git(&repo, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &ps(&sub), "vendor/sub"]);
        lab.git(&repo, &["commit", "-q", "-m", "sub"]);
        hand(lab, &repo.join("vendor/sub"), SID, "HANDOVER.md", Some("# h"), Some(3600.0), None);
        Built {
            payload: Some(Payload::Raw(
                o(vec![("hook_event_name", s("SessionStart")), ("session_id", s(SID)), ("cwd", s(&ps(&repo.join("vendor/sub")))), ("source", s("startup"))])
                    .text(),
            )),
            ..Built::default()
        }
    }));
    // ---- state file
    out.push(sc("state-written", mk().before(one_h(3600.0))));
    out.push(sc(
        "state-overwritten",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            l.write(r, &format!("home/.anti-hall/handover-resume-state-{SID}.json"), "old", None);
        }),
    ));
    out.push(sc(
        "state-dir-blocks",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            std::fs::create_dir_all(r.join(format!("home/.anti-hall/handover-resume-state-{SID}.json"))).expect("dir");
        }),
    ));
    out.push(sc(
        "state-anti-hall-is-file",
        mk().before(|l, r, repo| {
            one_h(3600.0)(l, r, repo);
            std::fs::remove_dir_all(r.join("home/.anti-hall")).expect("remove");
            write_file(&r.join("home/.anti-hall"), b"f");
        }),
    ));
    out.push(sc("state-not-written-for-snapshot-only", mk().before(snap("PRECOMPACT-1.md", 600.0, SID))));
    out.push(sc("state-sid-sanitized", mk().before(one_h(3600.0)).set("session_id", Some(s("a/b c")))));
    out.push(sc(
        "large-handover-path-unicode",
        mk().before(|l, _, r| {
            hand(l, r, "sess-\u{e9}", "HANDOVER.md", Some(FULL), Some(3600.0), None);
        })
        .set("session_id", Some(s("sess-\u{e9}"))),
    ));
    out
}
