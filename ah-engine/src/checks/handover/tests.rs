//! Unit tests of the handover checks. The full Node-vs-engine comparison is `tests/node_parity` (the Rust Node-parity test).
use super::find::{self, Unsure};
use crate::checks::jsport::testkit::{Sandbox, git};
use std::path::PathBuf;

const SID: &str = "sess-1";

fn repo(sb: &Sandbox) -> PathBuf {
    let repo = sb.root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    std::fs::canonicalize(repo).unwrap()
}

fn today() -> String {
    let tz: Vec<(String, String)> = crate::checks::jsport::date::process_zone().map(|t| vec![("TZ".to_string(), t)]).unwrap_or_default();
    let _zone = crate::checks::jsport::date::ZoneGuard::new(&crate::reqenv::RequestEnv::from_pairs(tz));
    find::local_date().unwrap()
}

fn handover_dir(repo: &std::path::Path, sid: &str) -> String {
    format!("{}/.anti-hall/handovers/{}/{sid}", repo.to_string_lossy(), today())
}

fn put(repo: &std::path::Path, sid: &str, name: &str, text: &str, age: u64) -> PathBuf {
    let p = PathBuf::from(handover_dir(repo, sid)).join(name);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, text).unwrap();
    let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
    f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(age)).unwrap();
    p
}



// ---- finding handovers -------------------------------------------------------------------------------------------

#[test]
fn the_newest_handover_wins_but_a_same_session_one_beats_a_newer_foreign_one() {
    let sb = Sandbox::new("h-find");
    let repo = repo(&sb);
    put(&repo, SID, "HANDOVER.md", "a", 3600);
    put(&repo, "other", "HANDOVER.md", "b", 10);
    let root = format!("{}/.anti-hall/handovers", repo.to_string_lossy());
    assert_eq!(find::newest_handover(&root, SID).unwrap().unwrap().session_id, SID);
    assert_eq!(find::newest_handover(&root, "").unwrap().unwrap().session_id, "other");
    assert_eq!(find::newest_handover(&root, "nobody").unwrap().unwrap().session_id, "other");
}

#[test]
fn file_names_carry_their_sequence_number_and_only_the_exact_patterns_match() {
    use find::Kind::{Handover, Precompact};
    assert_eq!(find::match_name("HANDOVER.md", Handover), Some(None));
    assert_eq!(find::match_name("HANDOVER-12.md", Handover), Some(Some("12")));
    for bad in ["HANDOVER-.md", "HANDOVER-x.md", "HANDOVER2.md", "HANDOVER.md.md", "handover.md", "HANDOVER-1.txt", "PRECOMPACT-1.md"] {
        assert_eq!(find::match_name(bad, Handover), None, "{bad}");
    }
    assert_eq!(find::match_name("PRECOMPACT-7.md", Precompact), Some(Some("7")));
    for bad in ["PRECOMPACT-.md", "PRECOMPACT.md", "PRECOMPACT-1a.md", "HANDOVER.md"] {
        assert_eq!(find::match_name(bad, Precompact), None, "{bad}");
    }
}

#[test]
fn the_newest_snapshot_is_this_sessions_and_ties_go_to_the_higher_number() {
    let sb = Sandbox::new("h-snap");
    let repo = repo(&sb);
    let root = format!("{}/.anti-hall/handovers", repo.to_string_lossy());
    let a = put(&repo, SID, "PRECOMPACT-2.md", "x", 100);
    let b = put(&repo, SID, "PRECOMPACT-12.md", "x", 100);
    put(&repo, "other", "PRECOMPACT-99.md", "x", 1);
    // same mtime to the nanosecond
    let t = std::fs::metadata(&a).unwrap().modified().unwrap();
    std::fs::OpenOptions::new().write(true).open(&b).unwrap().set_modified(t).unwrap();
    let got = find::newest_precompact(&root, SID).unwrap().unwrap();
    assert!(got.file_path.ends_with("PRECOMPACT-12.md"), "{got:?}");
    assert_eq!(find::newest_precompact(&root, ""), Ok(None));
}

#[test]
fn a_sequence_number_too_long_for_a_double_is_left_to_node() {
    let sb = Sandbox::new("h-seq");
    let repo = repo(&sb);
    put(&repo, SID, "HANDOVER-99999999999999999999.md", "x", 1);
    let root = format!("{}/.anti-hall/handovers", repo.to_string_lossy());
    assert_eq!(find::newest_handover(&root, SID), Err(Unsure));
}

// ---- reading the transcript --------------------------------------------------------------------------------------






// ---- precompact-snapshot -----------------------------------------------------------------------------------------







// ---- handover-resume ---------------------------------------------------------------------------------------------










