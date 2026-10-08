//! Review P2 #6: the outbound secret-scrub rules are plugin data (`jev.scrub_rules`), compiled per defaults snapshot, so an
//! edit applies on the next reload with no rebuild, and a rule that does not compile redacts the whole text rather than
//! letting anything through unscrubbed. One test in its own binary: it swaps this process's defaults snapshot.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use ah_engine::defaults;
use ah_engine::jev::scrub::scrub_secrets;
use std::path::Path;

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (p, q) = (e.path(), to.join(e.file_name()));
        if p.is_dir() {
            copy_tree(&p, &q);
        } else {
            std::fs::copy(&p, &q).unwrap();
        }
    }
}

#[test]
fn scrub_rules_are_read_from_the_plugin_and_follow_a_reload() {
    let root = std::env::temp_dir().join(format!("ah-scrub-reload-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&root));
    copy_tree(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/defaults"), &root.join("engine/defaults"));
    defaults::reload(Some(&root)).unwrap();
    assert_eq!(scrub_secrets("mail me@example.com now"), "mail [REDACTED_EMAIL] now");
    let jev = root.join("engine/defaults/jev.toml");
    let shipped = std::fs::read_to_string(&jev).unwrap();
    std::fs::write(&jev, shipped.replace("to = '''[REDACTED_EMAIL]'''", "to = '''[MAIL]'''")).unwrap();
    assert_eq!(defaults::reload(Some(&root)).unwrap(), defaults::Reloaded::Applied);
    assert_eq!(scrub_secrets("mail me@example.com now"), "mail [MAIL] now", "an edited rule applies on reload");
    // a pattern that does not compile: nothing leaves unscrubbed
    std::fs::write(&jev, shipped.replace("pattern = '''glpat-", "pattern = '''(glpat-")).unwrap();
    assert_eq!(defaults::reload(Some(&root)).unwrap(), defaults::Reloaded::Applied);
    assert_eq!(scrub_secrets("token=hunter2"), defaults::text("jev.scrub_failed_text"));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&root));
}
