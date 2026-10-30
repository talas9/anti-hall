//! The deploy routine (`update --from-local`) validates every target plugin root's defaults against the NEW binary before it
//! replaces anything live. Stale or swapped defaults are rejected with the previous install intact; a matching set passes.
//! Every run uses its own scratch HOME, state directory and plugin roots (never the real ones, never a live engine).
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
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

struct Lab {
    top: PathBuf,
    /// The target plugin root the routine installs into.
    root: PathBuf,
    /// The installed engine the routine must leave alone when it rejects.
    live: PathBuf,
    state: PathBuf,
}

const SENTINEL: &[u8] = b"previous install, must stay byte-identical";

fn lab(tag: &str) -> Lab {
    let top = std::env::temp_dir().join(format!("ah-deploy-gate-{}-{tag}", std::process::id()));
    std::fs::remove_dir_all(&top).ok();
    let (root, state) = (top.join("root"), top.join("state"));
    for d in ["engine/defaults", "engine/defaults.pristine"] {
        copy_dir(&plugin_src().join(d), &root.join(d));
    }
    let live = state.join("bin").join("ah-engine");
    std::fs::create_dir_all(live.parent().unwrap()).unwrap();
    std::fs::write(&live, SENTINEL).unwrap();
    std::fs::create_dir_all(top.join("home")).unwrap();
    std::fs::create_dir_all(top.join("from")).unwrap();
    Lab { top, root, live, state }
}

/// `update --from-local <empty dir> --engine-bin <this build> <extra> --json` against the lab; (exit code, stdout).
fn deploy(l: &Lab, extra: &[&str]) -> (i32, String) {
    deploy_roots(l, extra, true)
}

/// As [`deploy`]; with `env_roots` false the AH_DEPLOY_ROOTS override is not set, so the roots come from the live registrations.
fn deploy_roots(l: &Lab, extra: &[&str], env_roots: bool) -> (i32, String) {
    let mut cmd = Command::new(BIN);
    if !env_roots {
        cmd.env_remove("AH_DEPLOY_ROOTS");
    }
    let out = cmd
        .arg("update")
        .args(["--from-local"])
        .arg(l.top.join("from"))
        .args(["--engine-bin", BIN, "--json", "--force"]) // --force: a dirty dev build is the dirty gate's business, not this check's
        .args(extra)
        .env("HOME", l.top.join("home"))
        .env("AH_ENGINE_DIR", &l.state)
        .env("AH_ENGINE_PLUGIN_ROOT", plugin_src())
        .envs(env_roots.then_some(("AH_DEPLOY_ROOTS", &l.root)))
        .env("AH_ENGINE_NOSPAWN", "1")
        .output()
        .unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Nothing live was touched: the installed engine is byte-identical and no deploy journal was started.
fn assert_previous_install_intact(l: &Lab) {
    assert_eq!(std::fs::read(&l.live).unwrap(), SENTINEL, "the installed engine was replaced");
    let leftovers: Vec<_> = std::fs::read_dir(l.state.join("bin")).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(leftovers.len(), 1, "staged files left beside the live engine: {leftovers:?}");
    let deploys = std::fs::read_dir(&l.state).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains("deploy")).count();
    assert_eq!(deploys, 0, "a deploy journal was started before the pre-check passed");
}

/// The first `[key]` table of `file` removed, from the edited and the pristine copy alike: a plugin of an older release.
fn drop_key_everywhere(l: &Lab, file: &str, key: &str) {
    for d in ["engine/defaults", "engine/defaults.pristine"] {
        let p = l.root.join(d).join(file);
        let text = std::fs::read_to_string(&p).unwrap();
        let head = format!("[{key}]");
        let start = text.find(&head).unwrap_or_else(|| panic!("{key} not in {file}"));
        let end = text[start + head.len()..].find("\n[").map_or(text.len(), |i| start + head.len() + i + 1);
        std::fs::write(&p, format!("{}{}", &text[..start], &text[end..])).unwrap();
    }
}

fn rejected(l: &Lab, what: &str) {
    let (code, out) = deploy(l, &["--yes"]);
    assert_ne!(code, 0, "{what}: the routine accepted it: {out}");
    assert!(out.contains(&l.root.display().to_string()), "{what}: the rejection does not name the root: {out}");
    assert!(out.contains("\"problems\""), "{what}: not rejected by the pre-check: {out}");
    assert_previous_install_intact(l);
}

#[test]
fn a_matching_set_passes_the_defaults_check() {
    let l = lab("match");
    let (code, out) = deploy(&l, &["--check"]);
    assert_eq!(code, 0, "{out}");
    assert_previous_install_intact(&l);
}

#[test]
fn stale_defaults_missing_a_key_the_new_binary_requires_are_rejected_before_any_replacement() {
    let l = lab("stale");
    drop_key_everywhere(&l, "routine.toml", "routine.call_timeout_s");
    rejected(&l, "stale defaults");
}

#[test]
fn defaults_of_another_engine_version_swapped_in_are_rejected_before_any_replacement() {
    let l = lab("swapped");
    // another release's set: a key the new binary reads has changed type (a string where a number is read)
    for d in ["engine/defaults", "engine/defaults.pristine"] {
        let p = l.root.join(d).join("routine.toml");
        let text = std::fs::read_to_string(&p).unwrap();
        let head = "[routine.call_timeout_s]";
        let at = text.find(head).unwrap();
        let v = at + text[at..].find("value =").unwrap();
        let eol = v + text[v..].find('\n').unwrap();
        std::fs::write(&p, format!("{}value = \"swapped\"{}", &text[..v], &text[eol..])).unwrap();
    }
    rejected(&l, "swapped defaults");
}

#[test]
fn defaults_only_the_edited_copy_lacks_are_healed_from_the_pristine_copy_not_rejected() {
    let l = lab("healable");
    let p = l.root.join("engine/defaults/routine.toml");
    let text = std::fs::read_to_string(&p).unwrap();
    let start = text.find("[routine.call_timeout_s]").unwrap();
    let end = text[start + 1..].find("\n[").map_or(text.len(), |i| start + 1 + i + 1);
    std::fs::write(&p, format!("{}{}", &text[..start], &text[end..])).unwrap();
    let (code, out) = deploy(&l, &["--check"]);
    assert_eq!(code, 0, "{out}");
    assert_previous_install_intact(&l);
}

/// #201: the root the deploy check validates is the one the LIVE hook command runs from, not an assumed path. Here the only
/// pointer to the stale root is the plugin directory inside the registered Codex hook command (no AH_DEPLOY_ROOTS, no registry).
#[test]
fn a_stale_root_named_only_by_the_live_hook_command_is_rejected() {
    let l = lab("livehook");
    drop_key_everywhere(&l, "routine.toml", "routine.call_timeout_s");
    // the marker the root test needs lives in the copied defaults tree
    let codex = l.top.join("home/.codex");
    std::fs::create_dir_all(&codex).unwrap();
    let cmd = format!("exec sh \"{}/hooks/install.sh\" Stop --host codex", l.root.display());
    let reg = serde_json::json!({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": cmd}]}]}});
    std::fs::write(codex.join("hooks.json"), reg.to_string()).unwrap();
    let (code, out) = deploy_roots(&l, &["--yes"], false);
    assert_ne!(code, 0, "the live hook's root was not checked: {out}");
    assert!(out.contains(&l.root.display().to_string()) && out.contains("\"problems\""), "{out}");
    assert_previous_install_intact(&l);
}
