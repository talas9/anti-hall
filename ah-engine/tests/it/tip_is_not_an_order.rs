//! GH #764 item 4: a message that asks the agent for an action (it carries an `instead:` line, rendered "Do instead:") must use the
//! order form (`text.message('order', ...)`, icon and "Do now:" label from guardkit.icons / guardkit.msg_labels), never the `tip` kind:
//! a tip is ignored about nine times in ten. `tasklist-hygiene` is owned by GH #765 and is the only allowed exception until that lands.
//! The scan reads the plugin's check scripts; `AH_TIP_SCAN_ROOT` points it at another plugin root (to replay an older tree).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report

use std::path::{Path, PathBuf};

const ALLOWED: &[&str] = &["tasklist-hygiene.js"];

fn scripts(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            scripts(&p, out);
        } else if p.extension().is_some_and(|x| x == "js") {
            out.push(p);
        }
    }
}

/// `file:line` of every `text.message('tip', ...)` call whose argument list holds an `instead:` property.
fn action_tips(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    scripts(&root.join("engine/logic"), &mut files);
    files.sort();
    let mut hits = Vec::new();
    for f in files {
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        if ALLOWED.contains(&name.as_str()) {
            continue;
        }
        let src = std::fs::read_to_string(&f).unwrap();
        let needle = "text.message('tip'";
        let mut from = 0;
        while let Some(i) = src[from..].find(needle) {
            let at = from + i;
            // the call ends at its balanced closing parenthesis
            let (mut depth, mut end) = (0i32, src.len());
            for (k, c) in src[at..].char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            end = at + k;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            if src[at..end].contains("instead:") {
                hits.push(format!("{}:{}", f.strip_prefix(root).unwrap().display(), src[..at].matches('\n').count() + 1));
            }
            from = at + needle.len();
        }
    }
    hits
}

#[test]
fn no_message_that_asks_for_an_action_uses_the_tip_kind() {
    let root = std::env::var("AH_TIP_SCAN_ROOT").map(PathBuf::from).unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"));
    let hits = action_tips(&root);
    assert!(hits.is_empty(), "these messages ask for an action but render as a tip; use text.message('order', ...): {hits:#?}");
}

#[test]
fn the_order_kind_has_its_icon_and_label_in_both_default_copies() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine");
    for d in ["defaults", "defaults.pristine"] {
        let t = std::fs::read_to_string(root.join(d).join("small_guards.toml")).unwrap();
        assert!(t.contains("order = \"⚠️\""), "{d}: guardkit.icons has no order icon");
        assert!(t.contains("\"order\" = \"Do now: \""), "{d}: guardkit.msg_labels has no order label");
    }
}
