//! Ratchets for the error-audit hardening rollout.

use std::path::Path;

fn src_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n == "target") {
            continue;
        }
        if path.components().any(|c| c.as_os_str() == "bin") {
            continue;
        }
        if path.is_dir() {
            src_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name == "tests.rs" || name.contains("golden") || name.contains("host_tests") {
                continue;
            }
            out.push(path);
        }
    }
}

fn non_test_text(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap();
    let mut out = String::new();
    let mut skip = false;
    for line in text.lines() {
        if line.contains("#[cfg(test)]") {
            skip = true;
        }
        if !skip {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

#[test]
fn panic_and_unreachable_do_not_reenter_non_test_code() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    src_files(&root, &mut files);
    let mut offenders = Vec::new();
    for file in files {
        let text = non_test_text(&file);
        if text.contains("panic!(") || text.contains("unreachable!(") {
            offenders.push(file.strip_prefix(&root).unwrap().display().to_string());
        }
    }
    assert!(offenders.is_empty(), "non-test panic!/unreachable! sites: {offenders:?}");
}

#[test]
fn indexing_slicing_count_only_goes_down() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    src_files(&root, &mut files);
    let mut count = 0_usize;
    for file in files {
        let text = non_test_text(&file);
        count += text.matches("..]").count();
        count += text.matches("[..").count();
    }
    assert!(count <= 346, "indexing/slicing ratchet is {count}, expected <= 346");
}
