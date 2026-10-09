//! Unit tests of the Node goldens helper (`tests/common/goldens.rs`), here so they run once (the helper is also compiled into
//! the top-level test binaries that include `tests/common`).

use crate::common::goldens::{Norm, fingerprint};

#[test]
fn a_norm_round_trips_scratch_paths_and_their_canonical_form() {
    let d = std::env::temp_dir().join(format!("ah-goldens-norm-{}", std::process::id()));
    std::fs::create_dir_all(d.join("h1")).unwrap();
    let n = Norm::new().path(&d, "SCRATCH").path(&d.join("h1"), "HOME");
    let real = d.join("h1").canonicalize().unwrap();
    let text = format!("a {} b {} c {}", d.join("h1").display(), real.display(), d.join("x").display());
    let stored = n.apply(&text);
    assert!(!stored.contains(&d.to_string_lossy().to_string()), "{stored}");
    assert_eq!(n.undo(&stored), text);
    std::fs::remove_dir_all(&d).ok();
}

#[test]
fn the_fingerprint_closure_follows_requires_and_joins() {
    let fp = fingerprint(&["plugins/anti-hall/hooks/api-guard.js"], &[]);
    let names: Vec<&str> = fp.parts.iter().map(|(r, _)| r.as_str()).collect();
    for want in ["plugins/anti-hall/hooks/api-guard.js", "plugins/anti-hall/hooks/lib/settings.js", "plugins/anti-hall/.claude-plugin/plugin.json"] {
        assert!(names.contains(&want), "{want} missing from {names:?}");
    }
}
