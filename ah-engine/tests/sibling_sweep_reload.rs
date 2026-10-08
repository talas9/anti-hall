//! Review P2 #7: the sibling-sweep settings cache follows a defaults reload. It was keyed on the user's two config files
//! only, so an edited shipped default (the layer every unset setting resolves to) was not seen until a restart. One test
//! in its own binary: it swaps this process's defaults snapshot.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use ah_engine::cfgstore::Paths;
use ah_engine::checks::sibling_sweep::tune;
use ah_engine::defaults;
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
fn an_edited_shipped_default_reaches_the_sibling_sweep_settings_after_a_reload() {
    let root = std::env::temp_dir().join(format!("ah-sweep-reload-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&root));
    copy_tree(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/defaults"), &root.join("engine/defaults"));
    defaults::reload(Some(&root)).unwrap();
    let paths = Paths { user: root.join("no-user.toml"), settings: None };
    let before = tune::load(&paths).num("sibling_sweep.text_max_bytes");
    let file = root.join("engine/defaults/sibling_sweep.toml");
    let text = std::fs::read_to_string(&file).unwrap();
    let head = "[sibling_sweep.text_max_bytes]\n";
    let at = text.find(head).unwrap() + head.len();
    let v = at + text[at..].find("value = ").unwrap();
    let end = v + text[v..].find('\n').unwrap();
    std::fs::write(&file, format!("{}value = {}{}", &text[..v], before + 1, &text[end..])).unwrap();
    assert_eq!(defaults::reload(Some(&root)).unwrap(), defaults::Reloaded::Applied);
    assert_eq!(tune::load(&paths).num("sibling_sweep.text_max_bytes"), before + 1, "the reload reaches the cached settings");
    ah_engine::discard::harmless(std::fs::remove_dir_all(&root));
}
