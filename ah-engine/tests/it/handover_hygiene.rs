//! The handover brief tree (`ah-engine handovers`, the `handover-hygiene` SessionStart check, the `handovers` job): the
//! script `engine/logic/handover-hygiene.js` driven through the real binary in a scratch project and a scratch HOME.
//!
//! Covered: an empty project, one day, many days, legacy directories, a handover without front matter, a duplicate
//! sequence, unicode, a huge file, concurrent writers, idempotent re-runs, incremental rebuilds, snapshots, broken
//! references, self-healing of damaged briefs, search, the SessionStart advisory, the registered-projects job command, a
//! tuned rule rebuilding the briefs, and the Node shadow (the discovery rule and file set of `hooks/lib/handover-find.js`).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall").canonicalize().unwrap()
}

/// A scratch world: a project, a HOME and an engine state directory.
struct World {
    dir: PathBuf,
    plugin: PathBuf,
}

static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

impl World {
    fn new(tag: &str) -> World {
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("ah-hh-{tag}-{}-{n}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::create_dir_all(dir.join("proj/.anti-hall")).unwrap();
        World { dir, plugin: plugin_root() }
    }

    fn proj(&self) -> PathBuf {
        self.dir.join("proj")
    }
    fn hdir(&self) -> PathBuf {
        self.proj().join(".anti-hall/handovers")
    }

    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_PLUGIN_ROOT", &self.plugin)
            .env("AH_ENGINE_NOSPAWN", "1")
            .env_remove("ANTIHALL_JUDGE_CHILD")
            .current_dir(self.proj());
        c
    }

    /// `(stdout, stderr, exit code)` of `ah-engine <args>` run in the project.
    fn run(&self, args: &[&str]) -> (String, String, i32) {
        let o = self.cmd().args(args).output().unwrap();
        (String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string(), o.status.code().unwrap_or(-1))
    }

    fn json(&self, args: &[&str]) -> Value {
        let mut a = args.to_vec();
        a.push("--json");
        let (out, err, code) = self.run(&a);
        serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("{args:?} gave no JSON ({e}); code {code}; out {out:?}; err {err:?}"))
    }

    fn index(&self) -> Value {
        let v = self.json(&["handovers", "index"]);
        assert!(v.get("error").is_none(), "index failed: {v}");
        v
    }

    fn write(&self, rel: &str, text: &str) {
        let p = self.hdir().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.hdir().join(rel)).unwrap()
    }

    fn sidecar(&self, rel: &str) -> Value {
        serde_json::from_str(&self.read(rel)).unwrap()
    }

    fn entries(&self, date: &str) -> Vec<Value> {
        self.sidecar(&format!("{date}/BRIEF.json"))["entries"].as_array().unwrap().clone()
    }

    /// Every file under the handovers directory with its bytes, for before/after comparisons.
    fn snapshot(&self) -> std::collections::BTreeMap<String, Vec<u8>> {
        fn walk(base: &Path, dir: &Path, out: &mut std::collections::BTreeMap<String, Vec<u8>>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(base, &p, out);
                } else {
                    out.insert(p.strip_prefix(base).unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap());
                }
            }
        }
        let mut m = std::collections::BTreeMap::new();
        walk(&self.hdir(), &self.hdir(), &mut m);
        m
    }

    /// The handover files only (what the engine must never touch): every file that is not a BRIEF.*
    fn sources(&self) -> std::collections::BTreeMap<String, Vec<u8>> {
        self.snapshot().into_iter().filter(|(k, _)| !k.ends_with("BRIEF.md") && !k.ends_with("BRIEF.json")).collect()
    }
}

impl Drop for World {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

const SID: &str = "11111111-aaaa-bbbb-cccc-222222222222";

fn good(title: &str, situation: &str, next: &str) -> String {
    format!(
        "---\nhandover: {title}\nSituation: {situation}\nNext action: {next}\n---\n\n# {title}\n\n## Decisions\n- chose the plugin script over compiled code\n- keep INDEX.md append-only\n\n## Owner rules in force\n- never delete a handover\n\nSee `ah-engine/src/lib.rs` and commit `abc1234f`.\n"
    )
}

/// Every relative link of a brief resolves to a file or directory next to it.
fn assert_links_resolve(w: &World, brief: &str) {
    let text = w.read(brief);
    let base = Path::new(brief).parent().unwrap();
    let re = regex::Regex::new(r"\]\(([^)]+)\)").unwrap();
    for c in re.captures_iter(&text) {
        let target = percent_decode(&c[1]);
        let p = w.hdir().join(base).join(&target);
        assert!(p.exists(), "{brief}: link {target} does not resolve ({})", p.display());
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let (mut out, mut i) = (Vec::new(), 0);
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len() + 1
            && s.is_char_boundary(i + 1)
            && s.get(i + 1..i + 3).is_some()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[test]
fn an_empty_project_gets_nothing_and_an_empty_handovers_directory_a_clean_zero_brief() {
    let w = World::new("empty");
    // no handovers directory at all: an error, and nothing is created
    let (_, err, code) = w.run(&["handovers", "index"]);
    assert_eq!(code, 1, "{err}");
    assert!(err.contains("no .anti-hall/handovers"), "{err}");
    assert!(!w.hdir().exists(), "the engine must not create a handovers directory");
    // an empty one: a root brief with zero handovers, idempotent, and check is clean
    std::fs::create_dir_all(w.hdir()).unwrap();
    let first = w.index();
    assert_eq!(first["handovers"], 0);
    assert_eq!(first["days"], 0);
    let again = w.index();
    assert_eq!((again["rebuilt"].as_u64(), again["written"].as_u64()), (Some(0), Some(0)));
    let (out, _, code) = w.run(&["handovers", "check"]);
    assert_eq!(code, 0, "{out}");
    assert!(w.read("BRIEF.md").contains("0 handovers"));
}

#[test]
fn one_day_gets_a_root_brief_a_day_brief_and_typed_sidecars() {
    let w = World::new("oneday");
    w.write(&format!("2026-10-01/{SID}/HANDOVER.md"), &good("First handover", "the engine is live", "push the branch"));
    let r = w.index();
    assert_eq!((r["handovers"].as_u64(), r["days"].as_u64(), r["rebuilt"].as_u64()), (Some(1), Some(1), Some(1)));
    for f in ["BRIEF.md", "BRIEF.json", "2026-10-01/BRIEF.md", "2026-10-01/BRIEF.json"] {
        assert!(w.hdir().join(f).is_file(), "{f} is written");
    }
    let e = &w.entries("2026-10-01")[0];
    assert_eq!(e["id"], format!("2026-10-01/{SID}/HANDOVER"));
    assert_eq!(e["session"], SID);
    assert_eq!(e["seq"], 1);
    assert_eq!(e["kind"], "handover");
    assert_eq!(e["situation"], "the engine is live");
    assert_eq!(e["next_action"], "push the branch");
    assert_eq!(e["summary_source"], "front_matter");
    assert_eq!(e["front_matter"], true);
    assert_eq!(e["decisions"], serde_json::json!(["chose the plugin script over compiled code", "keep INDEX.md append-only"]));
    assert_eq!(e["preferences"], serde_json::json!(["never delete a handover"]));
    assert!(e["files"].as_array().unwrap().iter().any(|f| f == "ah-engine/src/lib.rs"), "{e}");
    assert!(e["commits"].as_array().unwrap().iter().any(|f| f == "abc1234f"), "{e}");
    assert!(e["uid"].as_str().unwrap().starts_with("h-"));
    assert!(e["problems"].as_array().unwrap().is_empty(), "{e}");
    // the tree: root -> day brief -> handover file
    assert!(w.read("BRIEF.md").contains("(2026-10-01/BRIEF.md)"));
    assert!(w.read("2026-10-01/BRIEF.md").contains(&format!("({SID}/HANDOVER.md)")));
    assert_links_resolve(&w, "BRIEF.md");
    assert_links_resolve(&w, "2026-10-01/BRIEF.md");
    let root = w.sidecar("BRIEF.json");
    assert_eq!(root["totals"]["handovers"], 1);
    assert_eq!(root["days"][0]["brief"], "2026-10-01/BRIEF.md");
}

#[test]
fn many_days_form_a_tree_with_a_session_chain_across_days_and_the_source_files_never_change() {
    let w = World::new("many");
    for d in 1..=12u32 {
        let date = format!("2026-09-{d:02}");
        w.write(&format!("{date}/{SID}/HANDOVER.md"), &good(&format!("Day {d}"), &format!("situation of day {d}"), &format!("action {d}")));
        w.write(&format!("{date}/other-{d}/HANDOVER.md"), &good(&format!("Other {d}"), "side work", "none"));
    }
    w.write("INDEX.md", "# Handover index\n\n- row\n");
    let before = w.sources();
    let r = w.index();
    assert_eq!((r["handovers"].as_u64(), r["days"].as_u64()), (Some(24), Some(12)));
    assert_eq!(w.sources(), before, "no handover file or INDEX.md is touched");
    let root = w.read("BRIEF.md");
    for d in 1..=12u32 {
        let date = format!("2026-09-{d:02}");
        assert!(root.contains(&format!("({date}/BRIEF.md)")), "root references {date}");
        let day = w.read(&format!("{date}/BRIEF.md"));
        assert!(day.contains(&format!("({SID}/HANDOVER.md)")) && day.contains(&format!("(other-{d}/HANDOVER.md)")), "{date} references every handover");
        assert_links_resolve(&w, &format!("{date}/BRIEF.md"));
    }
    assert!(root.contains("(INDEX.md)"), "the append-only row index is linked");
    // the session chain crosses days and is symmetric
    let d5 = &w.entries("2026-09-05").into_iter().find(|e| e["session"] == SID).unwrap();
    assert_eq!(d5["session_prev"], format!("2026-09-04/{SID}/HANDOVER"));
    assert_eq!(d5["session_next"], format!("2026-09-06/{SID}/HANDOVER"));
    assert!(w.read("2026-09-05/BRIEF.md").contains("Continued by"));
    let first = &w.entries("2026-09-01").into_iter().find(|e| e["session"] == SID).unwrap();
    assert!(first["session_prev"].is_null());
    let sessions = &w.sidecar("BRIEF.json")["sessions"][SID];
    assert_eq!(sessions["count"], 12);
}

#[test]
fn legacy_directories_are_indexed_without_front_matter_rules_and_hidden_state_is_skipped() {
    let w = World::new("legacy");
    w.write(
        "2026-06-11/legacy-old-session/HANDOVER.md",
        "# Session Handoff (2026-06-10)\n\nTrigger: manual\n\nWe shipped v0.32 and left the plan stage open.\n\n## Next\n- later\n",
    );
    w.write("2026-06-11/.omc/state/x.md", "# hidden tool state\n");
    w.write(&format!("2026-06-11/{SID}/.omc/state/HANDOVER.md"), "# nested hidden\n");
    w.index();
    let es = w.entries("2026-06-11");
    assert_eq!(es.len(), 1, "{es:?}");
    assert_eq!(es[0]["kind"], "legacy");
    assert_eq!(es[0]["summary_source"], "first_paragraph");
    assert_eq!(es[0]["situation"], "We shipped v0.32 and left the plan stage open.");
    assert!(es[0]["problems"].as_array().unwrap().is_empty(), "legacy is exempt from the front-matter rules: {:?}", es[0]);
    let (out, _, code) = w.run(&["handovers", "check"]);
    assert_eq!(code, 0, "{out}");
}

#[test]
fn a_handover_without_front_matter_or_next_action_is_reported_and_never_edited() {
    let w = World::new("nofm");
    w.write(&format!("2026-10-02/{SID}/HANDOVER.md"), "# A plain handover\n\n## Situation\nthings are fine\n\nNo next step here.\n");
    let before = w.sources();
    w.index();
    let codes: Vec<String> = w.entries("2026-10-02")[0]["problems"].as_array().unwrap().iter().map(|p| p["code"].as_str().unwrap().to_string()).collect();
    assert!(codes.contains(&"no_front_matter".to_string()) && codes.contains(&"no_next_action".to_string()), "{codes:?}");
    assert!(!codes.contains(&"no_situation".to_string()), "the Situation heading is accepted: {codes:?}");
    assert_eq!(w.entries("2026-10-02")[0]["situation"], "things are fine No next step here.");
    let (out, _, code) = w.run(&["handovers", "check"]);
    assert_eq!(code, 3, "{out}");
    assert!(out.contains("no_next_action"), "{out}");
    assert_eq!(w.sources(), before);
}

#[test]
fn a_duplicate_sequence_is_flagged_and_one_session_over_two_days_is_chained() {
    let w = World::new("dup");
    w.write(&format!("2026-10-03/{SID}/HANDOVER.md"), &good("a", "s", "n"));
    w.write(&format!("2026-10-03/{SID}/HANDOVER-1.md"), &good("b", "s", "n"));
    w.write(&format!("2026-10-04/{SID}/HANDOVER.md"), &good("c", "s", "n"));
    w.index();
    let es = w.entries("2026-10-03");
    let flagged: Vec<&Value> = es.iter().filter(|e| e["problems"].as_array().unwrap().iter().any(|p| p["code"] == "duplicate_seq")).collect();
    assert_eq!(flagged.len(), 1, "exactly one of the two seq-1 files is flagged: {es:?}");
    let next = &w.entries("2026-10-04")[0];
    assert!(next["session_prev"].as_str().unwrap().starts_with(&format!("2026-10-03/{SID}/HANDOVER")));
}

#[test]
fn unicode_titles_are_kept_whole_cut_on_characters_and_searchable() {
    let w = World::new("unicode");
    let long = "日本語のテキスト🙂".repeat(80);
    w.write(&format!("2026-10-05/{SID}/HANDOVER.md"), &format!("---\nhandover: Überprüfung — naïve café ☕\nSituation: {long}\nNext action: déjà vu 🚀\n---\n\n# Überprüfung — naïve café ☕\n\n## Decisions\n- 採用: プラグイン方式\n"));
    w.index();
    let e = &w.entries("2026-10-05")[0];
    let s = e["situation"].as_str().unwrap();
    assert!(s.ends_with('…') && s.chars().count() <= 601, "cut on characters with an ellipsis: {} chars", s.chars().count());
    assert!(std::str::from_utf8(s.as_bytes()).is_ok());
    assert_eq!(e["title"], "Überprüfung — naïve café ☕");
    assert_eq!(e["decisions"][0], "採用: プラグイン方式");
    let hit = w.json(&["handovers", "search", "プラグイン"]);
    assert_eq!(hit["total"], 1, "{hit}");
    let hit = w.json(&["handovers", "search", "naïve"]);
    assert_eq!(hit["total"], 1, "{hit}");
}

#[test]
fn a_huge_file_is_indexed_from_its_head_and_flagged_without_blowing_up() {
    let w = World::new("huge");
    let mut body = good("Huge", "big one", "shrink it");
    body.push_str(&"filler line of no interest\n".repeat(120_000)); // ~3 MB
    w.write(&format!("2026-10-06/{SID}/HANDOVER.md"), &body);
    let t = std::time::Instant::now();
    w.index();
    assert!(t.elapsed() < std::time::Duration::from_secs(20), "{:?}", t.elapsed());
    let e = &w.entries("2026-10-06")[0];
    assert_eq!(e["truncated"], true);
    assert_eq!(e["situation"], "big one");
    assert!(e["problems"].as_array().unwrap().iter().any(|p| p["code"] == "too_large"), "{e}");
    assert!(w.read("2026-10-06/BRIEF.json").len() < 20_000);
}

#[test]
fn rerunning_is_a_byte_for_byte_noop_and_only_the_changed_day_is_rebuilt() {
    let w = World::new("incr");
    for d in 1..=5u32 {
        w.write(&format!("2026-10-{d:02}/s{d}/HANDOVER.md"), &good(&format!("t{d}"), "s", "n"));
    }
    w.index();
    let before = w.snapshot();
    let again = w.index();
    assert_eq!((again["rebuilt"].as_u64(), again["written"].as_u64()), (Some(0), Some(0)));
    assert_eq!(w.snapshot(), before);
    // a force run converges to the same bytes
    let forced = w.json(&["handovers", "index", "--force"]);
    assert_eq!(forced["rebuilt"], 5);
    assert_eq!(forced["written"], 0, "{forced}");
    assert_eq!(w.snapshot(), before);
    // a new handover on a new day with a new session: one day rebuilt, the other four untouched
    w.write("2026-10-09/new-session/HANDOVER.md", &good("late", "s", "n"));
    let r = w.index();
    assert_eq!(r["rebuilt"], 1, "{r}");
    let after = w.snapshot();
    for d in 1..=5u32 {
        for f in ["BRIEF.md", "BRIEF.json"] {
            let k = format!("2026-10-{d:02}/{f}");
            assert_eq!(before.get(&k), after.get(&k), "{k} is untouched");
        }
    }
    assert!(after.contains_key("2026-10-09/BRIEF.md"));
    // a continuation of an old session on a new day rewrites the previous day's brief (its `Continued by` link) and nothing else
    w.write("2026-10-10/s3/HANDOVER.md", &good("continues s3", "s", "n"));
    let r = w.index();
    assert_eq!(r["rebuilt"], 1);
    let after2 = w.snapshot();
    assert_ne!(after.get("2026-10-03/BRIEF.md"), after2.get("2026-10-03/BRIEF.md"), "the predecessor day gains its successor link");
    assert_eq!(after.get("2026-10-02/BRIEF.md"), after2.get("2026-10-02/BRIEF.md"));
    assert_eq!(after.get("2026-10-04/BRIEF.md"), after2.get("2026-10-04/BRIEF.md"));
}

#[test]
fn a_touched_file_with_the_same_text_rewrites_only_the_sidecar_and_a_removed_handover_disappears_from_the_index_not_the_disk() {
    let w = World::new("touch");
    w.write(&format!("2026-10-01/{SID}/HANDOVER.md"), &good("a", "s", "n"));
    w.write("2026-10-02/other/HANDOVER.md", &good("b", "s", "n"));
    w.index();
    let before = w.snapshot();
    std::thread::sleep(std::time::Duration::from_millis(30));
    let text = w.read(&format!("2026-10-01/{SID}/HANDOVER.md"));
    w.write(&format!("2026-10-01/{SID}/HANDOVER.md"), &text); // same bytes, new mtime
    let r = w.index();
    assert_eq!(r["rebuilt"], 1);
    assert_eq!(w.snapshot().get("2026-10-01/BRIEF.md"), before.get("2026-10-01/BRIEF.md"), "the brief text did not change");
    // removing a handover: the index drops it; the engine deletes nothing (here the test did the removal)
    std::fs::remove_file(w.hdir().join(format!("2026-10-01/{SID}/HANDOVER.md"))).unwrap();
    w.index();
    assert!(w.entries("2026-10-01").is_empty());
    assert!(w.hdir().join("2026-10-02/other/HANDOVER.md").is_file());
}

#[test]
fn precompact_snapshots_attach_to_the_handover_they_name_else_to_the_newest_of_the_session() {
    let w = World::new("snap");
    w.write(&format!("2026-10-07/{SID}/HANDOVER.md"), &good("one", "s", "n"));
    w.write(&format!("2026-10-07/{SID}/HANDOVER-2.md"), &good("two", "s", "n"));
    w.write(
        &format!("2026-10-07/{SID}/PRECOMPACT-1.md"),
        &format!("# PRECOMPACT snapshot — {SID} · #1 · 2026-10-07T18:38:27.951Z\n\nMechanical dump.\n\n## Newest handover\n{}/.anti-hall/handovers/2026-10-07/{SID}/HANDOVER.md (modified now)\n", w.proj().display()),
    );
    w.write(&format!("2026-10-07/{SID}/PRECOMPACT-2.md"), &format!("# PRECOMPACT snapshot — {SID} · #2 · 2026-10-07T19:00:00.000Z\n\nNo handover named.\n"));
    w.write(&format!("2026-10-07/{SID}/state.md"), "# state\n");
    w.write(&format!("2026-10-07/{SID}/decisions.md"), "# decisions\n");
    w.index();
    let es = w.entries("2026-10-07");
    let one = es.iter().find(|e| e["file"] == "HANDOVER.md").unwrap();
    let two = es.iter().find(|e| e["file"] == "HANDOVER-2.md").unwrap();
    assert_eq!(one["snapshots"].as_array().unwrap().len(), 1, "{one}");
    assert_eq!(one["snapshots"][0]["file"], "PRECOMPACT-1.md");
    assert_eq!(one["snapshots"][0]["at"], "2026-10-07T18:38:27.951Z");
    assert_eq!(two["snapshots"].as_array().unwrap().len(), 1);
    assert_eq!(two["snapshots"][0]["file"], "PRECOMPACT-2.md");
    let kinds: Vec<&str> = one["companions"].as_array().unwrap().iter().map(|c| c["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["decisions", "state"]);
    assert_eq!(es.len(), 2, "a snapshot is never a handover entry");
    assert_links_resolve(&w, "2026-10-07/BRIEF.md");
}

#[test]
fn a_broken_reference_is_reported_and_clears_when_the_target_appears() {
    let w = World::new("ref");
    let target = format!(".anti-hall/handovers/2026-10-01/{SID}/HANDOVER.md");
    w.write(&format!("2026-10-08/{SID}/HANDOVER.md"), &format!("---\nhandover: x\nSituation: s\nNext action: n\n---\n\nPredecessor: {target}\nSee also `.anti-hall/handovers/2026-10-02/ghost/HANDOVER.md` and [plan](../../../plans/none.md).\n"));
    w.index();
    let (out, _, code) = w.run(&["handovers", "check"]);
    assert_eq!(code, 3);
    assert!(out.matches("broken_ref").count() >= 2, "{out}");
    w.write(&format!("2026-10-01/{SID}/HANDOVER.md"), &good("pred", "s", "n"));
    w.write("2026-10-02/ghost/HANDOVER.md", &good("ghost", "s", "n"));
    std::fs::create_dir_all(w.proj().join(".anti-hall/plans")).unwrap();
    std::fs::write(w.proj().join(".anti-hall/plans/none.md"), "x").unwrap();
    w.index();
    let e = &w.entries("2026-10-08")[0];
    assert_eq!(e["predecessor"]["id"], format!("2026-10-01/{SID}/HANDOVER"));
    let (out, _, code) = w.run(&["handovers", "check"]);
    assert_eq!(code, 0, "{out}");
}

#[test]
fn a_missing_brief_an_unindexed_handover_and_a_damaged_sidecar_are_found_and_healed() {
    let w = World::new("heal");
    w.write(&format!("2026-10-01/{SID}/HANDOVER.md"), &good("a", "s", "n"));
    w.write(&format!("2026-10-02/{SID}/HANDOVER.md"), &good("b", "s", "n"));
    w.index();
    // unindexed: a new handover appears
    w.write(&format!("2026-10-03/{SID}/HANDOVER.md"), &good("c", "s", "n"));
    let (out, _, code) = w.run(&["handovers", "check"]);
    assert_eq!(code, 3);
    assert!(out.contains("unindexed") && out.contains("2026-10-03"), "{out}");
    // missing brief: the day brief is gone
    w.index();
    std::fs::remove_file(w.hdir().join("2026-10-01/BRIEF.md")).unwrap();
    let (out, _, code) = w.run(&["handovers", "check"]);
    assert_eq!(code, 3);
    assert!(out.contains("missing_brief"), "{out}");
    // a damaged day sidecar and a damaged root sidecar
    std::fs::write(w.hdir().join("2026-10-02/BRIEF.json"), "{not json").unwrap();
    std::fs::write(w.hdir().join("BRIEF.json"), "").unwrap();
    let (_, _, code) = w.run(&["handovers", "check"]);
    assert_eq!(code, 3);
    let r = w.index();
    assert_eq!(r["handovers"], 3);
    let (out, _, code) = w.run(&["handovers", "check"]);
    assert_eq!(code, 0, "{out}");
    assert!(w.hdir().join("2026-10-01/BRIEF.md").is_file());
}

#[test]
fn concurrent_index_runs_and_a_writer_leave_a_consistent_tree() {
    let w = World::new("conc");
    for d in 1..=6u32 {
        w.write(&format!("2026-10-{d:02}/s{d}/HANDOVER.md"), &good(&format!("t{d}"), "s", "n"));
    }
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let stop = stop.clone();
        let p = w.hdir().join("2026-10-03/s3/HANDOVER.md");
        std::thread::spawn(move || {
            let mut i = 0;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                i += 1;
                std::fs::write(&p, good(&format!("t3 rev {i}"), "s", "n")).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        })
    };
    let procs: Vec<_> = (0..6).map(|_| w.cmd().args(["handovers", "index", "--json"]).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap()).collect();
    for p in procs {
        let o = p.wait_with_output().unwrap();
        let code = o.status.code().unwrap();
        assert!(code == 0 || code == 75, "an index run exits 0 or reports busy (75): code {code}: {}", String::from_utf8_lossy(&o.stderr));
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    writer.join().unwrap();
    // every file the runs wrote parses, and one more run converges and check is clean
    for d in 1..=6u32 {
        let _: Value = w.sidecar(&format!("2026-10-{d:02}/BRIEF.json"));
    }
    w.index();
    let (out, _, code) = w.run(&["handovers", "check"]);
    assert_eq!(code, 0, "{out}");
    let after = w.snapshot();
    let r = w.index();
    assert_eq!(r["written"], 0);
    assert_eq!(w.snapshot(), after);
}

#[test]
fn search_filters_ranks_limits_and_reports_the_typed_fields() {
    let w = World::new("search");
    w.write(
        "2026-09-01/a/HANDOVER.md",
        "---\nhandover: Alpha\nSituation: rebuilt the cursor store\nNext action: ship it\n---\n\n## Decisions\n- use per-instance cursors\n",
    );
    w.write(
        "2026-09-02/b/HANDOVER.md",
        "---\nhandover: Beta\nSituation: cursor tests flaky\nNext action: fix the clock\n---\n\n## Decisions\n- inject the clock\n\nTouched `src/cursor.rs`.\n",
    );
    w.write("2026-10-03/c/HANDOVER.md", "---\nhandover: Gamma\nSituation: unrelated work\nNext action: rest\n---\n");
    w.index();
    let v = w.json(&["handovers", "search", "cursor"]);
    assert_eq!(v["total"], 2);
    assert!(v["hits"][0]["score"].as_u64().unwrap() >= v["hits"][1]["score"].as_u64().unwrap());
    let v = w.json(&["handovers", "search", "cursor", "date:2026-09-02"]);
    assert_eq!(v["total"], 1);
    assert_eq!(v["hits"][0]["session"], "b");
    assert!(v["hits"][0]["matched"].as_array().unwrap().iter().any(|m| m == "files"));
    let v = w.json(&["handovers", "search", "decision:clock"]);
    assert_eq!(v["total"], 1);
    let v = w.json(&["handovers", "search", "from:2026-09-02", "to:2026-09-30", "cursor"]);
    assert_eq!(v["total"], 1);
    let v = w.json(&["handovers", "search", "session:c"]);
    assert_eq!(v["total"], 1);
    let v = w.json(&["handovers", "search", "cursor", "--limit", "1"]);
    assert_eq!(v["hits"].as_array().unwrap().len(), 1);
    assert_eq!(v["total"], 2);
    let (out, _, code) = w.run(&["handovers", "search", "nonexistentword"]);
    assert_eq!(code, 0);
    assert!(out.contains("no handover matches"), "{out}");
    let (out, _, code) = w.run(&["handovers", "search", "cursor"]);
    assert_eq!(code, 0);
    assert!(out.contains("2 of 2 match"), "{out}");
}

#[test]
fn search_before_any_index_says_so_and_an_unknown_verb_prints_usage() {
    let w = World::new("noidx");
    w.write(&format!("2026-10-01/{SID}/HANDOVER.md"), &good("a", "s", "n"));
    let (_, err, code) = w.run(&["handovers", "search", "x"]);
    assert_eq!(code, 1);
    assert!(err.contains("no handover index yet"), "{err}");
    let (_, err, code) = w.run(&["handovers", "frobnicate"]);
    assert_eq!(code, 64);
    assert!(err.contains("usage: ah-engine handovers"), "{err}");
}

fn session_start(w: &World) -> (String, i32) {
    let payload =
        serde_json::json!({"hook_event_name": "SessionStart", "source": "startup", "cwd": w.proj().to_string_lossy(), "session_id": "s-1"}).to_string();
    let mut ch = w.cmd().args(["check", "handover-hygiene"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    (String::from_utf8_lossy(&o.stdout).trim().to_string(), o.status.code().unwrap_or(-1))
}

#[test]
fn the_session_start_advisory_names_the_problem_once_and_stays_silent_when_clean() {
    let w = World::new("adv");
    // no handovers: silent
    assert_eq!(session_start(&w), (String::new(), 0));
    w.write(&format!("2026-10-01/{SID}/HANDOVER.md"), &good("a", "s", "n"));
    let (out, code) = session_start(&w);
    assert_eq!(code, 0);
    let v: Value = serde_json::from_str(&out).expect("an advisory JSON");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
    assert_eq!(v["hookSpecificOutput"]["hookEventName"], "SessionStart");
    assert!(ctx.contains("handover-hygiene") && ctx.contains("ah-engine handovers index") && ctx.contains("out of date"), "{ctx}");
    // the same problem set is not repeated on the next session
    assert_eq!(session_start(&w), (String::new(), 0));
    // after the index it is clean and silent; a new problem speaks again
    w.index();
    assert_eq!(session_start(&w), (String::new(), 0));
    w.write("2026-10-02/x/HANDOVER.md", &good("b", "s", "n"));
    assert!(session_start(&w).0.contains("additionalContext"));
    // the advisory never edits or writes inside the handovers directory
    assert!(!w.hdir().join("2026-10-02/BRIEF.md").exists());
}

#[test]
fn the_advisory_is_off_for_a_judge_child_and_with_the_setting_off() {
    let w = World::new("advoff");
    w.write(&format!("2026-10-01/{SID}/HANDOVER.md"), &good("a", "s", "n"));
    std::fs::create_dir_all(w.dir.join("home/.anti-hall")).unwrap();
    std::fs::write(w.dir.join("home/.anti-hall/settings.json"), r#"{"guards":{"handoverHygiene":false}}"#).unwrap();
    assert_eq!(session_start(&w), (String::new(), 0));
    std::fs::remove_file(w.dir.join("home/.anti-hall/settings.json")).unwrap();
    let payload = serde_json::json!({"hook_event_name": "SessionStart", "cwd": w.proj().to_string_lossy()}).to_string();
    let mut ch = w.cmd().env("ANTIHALL_JUDGE_CHILD", "1").args(["check", "handover-hygiene"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    assert!(ch.wait_with_output().unwrap().stdout.is_empty());
}

#[test]
fn the_registered_projects_command_the_job_runs_indexes_every_project_the_session_start_saw() {
    let w = World::new("job");
    w.write(&format!("2026-10-01/{SID}/HANDOVER.md"), &good("a", "s", "n"));
    session_start(&w); // registers the project
    let reg: Value = serde_json::from_str(&std::fs::read_to_string(w.dir.join("home/.anti-hall/handover-projects.json")).unwrap()).unwrap();
    assert!(reg["projects"].as_object().unwrap().keys().any(|k| k.ends_with("/proj")), "{reg}");
    let v = w.json(&["handovers", "index", "--registered"]);
    assert_eq!(v["projects"][0]["handovers"], 1, "{v}");
    assert!(w.hdir().join("BRIEF.md").is_file());
    // the job is shipped, runs that command and is tunable
    let (out, _, _) = w.run(&["schedule", "--json"]);
    assert!(out.contains("handovers"), "{out}");
}

#[test]
fn a_tuned_rule_rebuilds_every_day_brief_without_rebuilding_the_engine() {
    let w = World::new("tune");
    // a private copy of the plugin's engine files, so the rule can be edited
    let plugin = w.dir.join("plugin");
    let src = plugin_root();
    for sub in ["engine", "hooks", "codex"] {
        copy_dir(&src.join(sub), &plugin.join(sub));
    }
    let mut w = w;
    w.plugin = plugin.clone();
    w.write(&format!("2026-10-01/{SID}/HANDOVER.md"), &good("a", &"x".repeat(300), "n"));
    w.index();
    assert_eq!(w.entries("2026-10-01")[0]["situation"].as_str().unwrap().chars().count(), 300);
    let toml = plugin.join("engine/defaults/handovers.toml");
    let text = std::fs::read_to_string(&toml).unwrap();
    let at = text.find("[handovers.summary_chars]").unwrap();
    let (head, tail) = text.split_at(at);
    std::fs::write(&toml, format!("{head}{}", tail.replacen("value = 600", "value = 100", 1))).unwrap();
    let r = w.index();
    assert_eq!(r["rebuilt"], 1, "a changed rule rebuilds the day: {r}");
    assert_eq!(w.entries("2026-10-01")[0]["situation"].as_str().unwrap().chars().count(), 101);
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (p, q) = (e.path(), to.join(e.file_name()));
        if p.is_dir() {
            copy_dir(&p, &q);
        } else {
            std::fs::copy(&p, &q).unwrap();
        }
    }
}

#[test]
fn node_shadow_the_discovery_rule_and_file_set_match_hooks_lib_handover_find() {
    // The Node twin of the discovery (hooks/lib/handover-find.js) is the witness: the engine's numbered-handover pattern is
    // the same regular expression, and over a mixed tree the engine indexes exactly the files Node's rule selects.
    let w = World::new("shadow");
    for (d, s, f) in [
        ("2026-10-01", SID, "HANDOVER.md"),
        ("2026-10-01", SID, "HANDOVER-2.md"),
        ("2026-10-01", SID, "HANDOVER-10.md"),
        ("2026-10-02", "other", "HANDOVER.md"),
        ("2026-10-02", "other", "handover.md"),
        ("2026-10-02", "other", "HANDOVER-x.md"),
        ("2026-10-02", "other", "HANDOVER-2.md.bak"),
        ("2026-10-03", "legacy-thing", "HANDOVER.md"),
    ] {
        w.write(&format!("{d}/{s}/{f}"), &good("t", "s", "n"));
    }
    w.index();
    let script = r#"
      const fs = require('fs'), path = require('path');
      const { HANDOVER_FILE_RE } = require(process.argv[1]);
      const root = process.argv[2], out = [];
      console.log(JSON.stringify({ re: HANDOVER_FILE_RE.source, files: (() => {
        for (const date of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name))
          for (const sid of fs.readdirSync(path.join(root, date), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name))
            for (const f of fs.readdirSync(path.join(root, date, sid))) {
              const m = HANDOVER_FILE_RE.exec(f);
              if (m) out.push(date + '/' + sid + '/' + f + '|' + (m[1] ? parseInt(m[1], 10) : 1));
            }
        return out.sort();
      })() }));
    "#;
    let node = Command::new("node").args(["-e", script, "--"]).arg(plugin_root().join("hooks/lib/handover-find.js")).arg(w.hdir()).output();
    let Ok(node) = node else { return }; // no node on this machine: the witness cannot run (CI has it)
    if !node.status.success() {
        return;
    }
    let theirs: Value = serde_json::from_slice(&node.stdout).unwrap();
    let shipped: toml::Table = toml::from_str(&std::fs::read_to_string(plugin_root().join("engine/defaults/handovers.toml")).unwrap()).unwrap();
    let handover_re = shipped["handovers"]["handover_re"]["value"].as_str().unwrap().to_string();
    assert_eq!(theirs["re"].as_str().unwrap(), handover_re, "the engine uses Node's discovery pattern");
    let mut mine = Vec::new();
    for d in ["2026-10-01", "2026-10-02", "2026-10-03"] {
        for e in w.entries(d) {
            if e["kind"] == "handover" || e["kind"] == "legacy" {
                let name = e["file"].as_str().unwrap();
                if regex::Regex::new(&handover_re).unwrap().is_match(name) {
                    mine.push(format!("{}/{}/{}|{}", d, e["session"].as_str().unwrap(), name, e["seq"]));
                }
            }
        }
    }
    mine.sort();
    let theirs: Vec<String> = theirs["files"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
    assert_eq!(mine, theirs, "the same numbered handovers with the same sequence numbers");
    // the named addendum is the engine's own kind: Node's rule ignores it, the engine indexes it as `named`
    let named = w.entries("2026-10-02").into_iter().filter(|e| e["kind"] == "named").count();
    assert_eq!(named, 1);
}
