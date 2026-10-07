//! Unit tests of the inbox-read-guard path taxonomy; the Node-vs-engine parity corpus is `tests/spawn_ctx_parity.rs`.
use super::*;

const H: &str = "/home/u";

fn c(p: &str) -> Option<Class> {
    classify(p, H, Some("/work"))
}

#[test]
fn the_inbox_is_blocked_and_the_rest_of_the_devswarm_root_is_not() {
    assert_eq!(c("/home/u/.anti-hall/devswarm/inbox/a.ndjson"), Some(Class::Inbox));
    assert_eq!(c("/home/u/.anti-hall/devswarm/inbox"), Some(Class::Inbox));
    assert_eq!(c("/home/u/.anti-hall/devswarm/inbox/"), Some(Class::Inbox));
    assert_eq!(c("/home/u/.anti-hall/devswarm\\inbox\\a"), Some(Class::Inbox), "backslashes count as separators after resolution");
    for p in ["summary.json", "cursors/a", "workspaces/w.json", "liveness/x", "archive-1/inbox/x", ""] {
        assert_eq!(c(&format!("/home/u/.anti-hall/devswarm/{p}")), Some(Class::Allow), "{p}");
    }
    assert_eq!(c("/home/u/.anti-hall/devswarm-other/inbox/x"), Some(Class::Allow));
    assert_eq!(c("/etc/passwd"), Some(Class::Allow));
    assert_eq!(c(""), Some(Class::Allow));
}

#[test]
fn an_absolute_path_is_not_normalized_but_a_relative_one_is() {
    assert_eq!(c("/home/u/.anti-hall/devswarm/./inbox/x"), Some(Class::Allow), "Node compares the raw absolute path");
    assert_eq!(c("/home/u/.anti-hall/devswarm/x/../inbox/y"), Some(Class::Allow));
    assert_eq!(c("/home/u/.anti-hall/devswarm//inbox/x"), Some(Class::Allow));
    assert_eq!(classify("inbox/x", H, Some("/home/u/.anti-hall/devswarm")), Some(Class::Inbox));
    assert_eq!(classify("../inbox/x", H, Some("/home/u/.anti-hall/devswarm/store")), Some(Class::Inbox));
    assert_eq!(classify(".anti-hall/devswarm/inbox/x", H, None), Some(Class::Inbox), "no working directory: the home is the base");
    assert_eq!(classify("inbox/x", H, Some("relative")), None, "Node would use its own working directory");
}

#[test]
fn the_store_shapes_are_found_per_project_key_and_flat() {
    for p in [
        "devswarm.db",
        "devswarm.db-wal",
        "devswarm.db-shm",
        "devswarm.db-journal",
        "journal/a.ndjson",
        "repo-abc123/devswarm.db",
        "12345678/devswarm.db-shm",
        "ABCDEF12/journal/x.ndjson",
    ] {
        assert_eq!(c(&format!("/home/u/.anti-hall/devswarm/store/{p}")), Some(Class::Store), "{p}");
    }
    for p in ["", "journal", "journal/a.txt", "devswarm.db-extra", "repo-abc12/devswarm.db", "UPPER-ABCDEF/devswarm.db", "abcdefgh/devswarm.db"] {
        assert_eq!(c(&format!("/home/u/.anti-hall/devswarm/store/{p}")), Some(Class::Allow), "{p}");
    }
}

#[test]
fn the_block_is_the_json_decision_on_stdout_only() {
    let Verdict::Exact(x) = block() else { panic!("an exact block") };
    assert_eq!((x.code, x.err.as_str()), (2, ""));
    assert!(x.out.starts_with("{\"decision\":\"block\",\"reason\":\"\u{26d4} anti-hall \u{b7} devswarm-inbox-read: ") && x.out.ends_with("\"}\n"));
}
