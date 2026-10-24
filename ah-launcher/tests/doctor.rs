//! `ah-hook doctor`: the thin client's built-in diagnosis (no engine, no Node) and its repairs. Scratch HOME and plugin root only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;
use common::Env;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const OLD_CLAUDE: &str = r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"sh \"${CLAUDE_PLUGIN_ROOT}/hooks/ah-hook.sh\" PreToolUse","timeout":10}]}],"Stop":[{"hooks":[{"type":"command","command":"sh \"${CLAUDE_PLUGIN_ROOT}/hooks/ah-hook.sh\" Stop"}]}]}}"#;
const OLD_CODEX: &str = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"sh \"${PLUGIN_ROOT}/hooks/ah-hook.sh\" Stop --host codex"}]}]}}"#;

fn exe(p: &Path, body: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
}

struct Kit {
    e: Env,
}

impl Kit {
    fn new(tag: &str) -> Kit {
        let k = Kit { e: Env::new(tag) };
        std::fs::create_dir_all(k.e.root.join("engine/defaults.pristine")).unwrap();
        std::fs::write(k.e.root.join("engine/defaults.pristine/index.toml"), "").unwrap();
        std::fs::create_dir_all(k.e.root.join(".claude-plugin")).unwrap();
        std::fs::write(
            k.e.root.join(".claude-plugin/plugin.json"),
            r#"{"version":"9.9.9"}"#,
        )
        .unwrap();
        k
    }

    fn engine(&self, body: &str) -> PathBuf {
        let p = self.e.state.join("bin/ah-engine");
        exe(&p, body);
        p
    }

    fn doctor(&self, args: &[&str]) -> (i32, String) {
        let o = Command::new(env!("CARGO_BIN_EXE_ah-hook"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &self.e.home)
            .env("AH_WRAPPER_TEST", "1")
            .arg("--plugin-root")
            .arg(&self.e.root)
            .arg("doctor")
            .args(args)
            .output()
            .unwrap();
        (
            o.status.code().unwrap_or(-1),
            format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            ),
        )
    }

    fn put(&self, rel: &str, body: &str) -> PathBuf {
        let p = self.e.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
        p
    }
}

const GOOD_ENGINE: &str = "#!/bin/sh\n[ \"$1\" = version ] && echo 0.1.0\nif [ \"$1\" = doctor ]; then echo \"ENGINE doctor $*\"; exit 3; fi\nexit 0\n";

#[test]
fn a_running_engine_gets_the_call_and_builtin_forces_the_built_in_report() {
    let k = Kit::new("dr-handover");
    k.engine(GOOD_ENGINE);
    let (code, out) = k.doctor(&["--check"]);
    assert_eq!(code, 3, "the engine's own exit code: {out}");
    assert!(out.contains("ENGINE doctor doctor --check"), "{out}");
    let (_, out) = k.doctor(&["--builtin"]);
    assert!(
        out.contains("anti-hall doctor v9.9.9") && out.contains("Install health"),
        "{out}"
    );
}

#[test]
fn without_a_working_engine_the_built_in_report_names_the_fix_and_fails() {
    let k = Kit::new("dr-noeng");
    let (code, out) = k.doctor(&[]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("engine binary not installed at"), "{out}");
    assert!(out.contains("hooks/install.sh --download -v"), "{out}");
    assert!(out.contains("no working engine"), "{out}");
    assert!(out.contains("failure(s)"), "{out}");
}

#[test]
fn old_form_hook_commands_are_flagged_and_repaired_with_a_backup() {
    let k = Kit::new("dr-hooks");
    k.engine(GOOD_ENGINE);
    let claude = k.put("hooks/hooks.json", OLD_CLAUDE);
    let codex = k.put("codex/hooks/hooks.json", OLD_CODEX);
    let (_, out) = k.doctor(&["--builtin"]);
    assert!(
        out.contains("still runs 2 hook command(s) through the retired shell wrapper"),
        "{out}"
    );
    // a dry run changes nothing
    let (_, out) = k.doctor(&["--builtin", "--repair", "--dry-run"]);
    assert!(
        out.contains("Repair (dry-run") && out.contains("would rewrite 2 hook command(s)"),
        "{out}"
    );
    assert_eq!(std::fs::read_to_string(&claude).unwrap(), OLD_CLAUDE);
    // the repair
    let (_, out) = k.doctor(&["--builtin", "--repair"]);
    assert!(out.contains("FIXED [hooks-form]"), "{out}");
    let fixed = std::fs::read_to_string(&claude).unwrap();
    assert!(
        fixed.contains("exec sh \\\"${CLAUDE_PLUGIN_ROOT}/hooks/install.sh\\\" PreToolUse"),
        "{fixed}"
    );
    assert!(
        fixed.contains("[ -x \\\"$HOME/.anti-hall/ah-engine/bin/ah-hook\\\" ] && exec"),
        "{fixed}"
    );
    assert!(!fixed.contains("ah-hook.sh"), "{fixed}");
    let cx = std::fs::read_to_string(&codex).unwrap();
    assert!(
        cx.contains("install.sh\\\" Stop --host codex"),
        "the host argument survives: {cx}"
    );
    let backups: Vec<_> = std::fs::read_dir(claude.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(".bak-antihall-"))
        .collect();
    assert_eq!(backups.len(), 1, "one backup, never deleted");
    assert_eq!(
        std::fs::read_to_string(backups[0].path()).unwrap(),
        OLD_CLAUDE,
        "the backup is the original"
    );
    // idempotent: nothing left to do, no second backup
    let (_, out) = k.doctor(&["--builtin", "--repair"]);
    assert!(out.contains("nothing to repair"), "{out}");
    assert!(
        out.contains("every hook command is the direct form"),
        "{out}"
    );
    let backups2 = std::fs::read_dir(claude.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(".bak-antihall-"))
        .count();
    assert_eq!(backups2, 1);
}

#[test]
fn node_on_an_entry_path_and_extra_shell_files_are_flagged() {
    let k = Kit::new("dr-node");
    k.engine(GOOD_ENGINE);
    k.put("hooks/hooks.json", r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node \"${CLAUDE_PLUGIN_ROOT}/hooks/x.js\""}]}]}}"#);
    k.put("scripts/leftover.sh", "#!/bin/sh\n");
    k.put("hooks/install.sh", "#!/bin/sh\n");
    let (_, out) = k.doctor(&["--builtin"]);
    assert!(
        out.contains("runs Node on an entry path (1 command(s)"),
        "{out}"
    );
    assert!(
        out.contains(
            "the plugin ships 1 shell file(s) besides hooks/install.sh (first: scripts/leftover.sh)"
        ),
        "{out}"
    );
    // the severity is a setting: failing when install_health_fail is 1
    k.e.edit_toml("doctor.toml", |t| {
        common::set_value(t, "doctor_l.install_health_fail", "1")
    });
    let (code, out) = k.doctor(&["--builtin"]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("❌"), "{out}");
}

#[test]
fn launcher_shims_must_be_sh_shims_without_node() {
    let k = Kit::new("dr-shims");
    k.engine(GOOD_ENGINE);
    exe(
        &k.e.home.join(".anti-hall/bin/devswarm.js"),
        "#!/bin/sh\nexec \"$HOME/.anti-hall/ah-engine/bin/ah-hook\" devswarm \"$@\"\n",
    );
    let (_, out) = k.doctor(&["--builtin"]);
    assert!(
        out.contains("1 launcher shim(s) in") && out.contains("are sh shims"),
        "{out}"
    );
    exe(
        &k.e.home.join(".anti-hall/bin/wake-watch.js"),
        "#!/usr/bin/env node\nconsole.log(1)\n",
    );
    let (_, out) = k.doctor(&["--builtin"]);
    assert!(out.contains("is not an sh shim for ah-hook"), "{out}");
}

#[test]
fn the_repair_makes_the_binaries_executable_and_creates_the_state_directory() {
    let k = Kit::new("dr-exec");
    let eng = k.engine(GOOD_ENGINE);
    std::fs::set_permissions(&eng, std::fs::Permissions::from_mode(0o644)).unwrap();
    let (_, out) = k.doctor(&["--builtin"]);
    assert!(out.contains("is not executable (mode 644)"), "{out}");
    let (_, out) = k.doctor(&["--builtin", "--repair"]);
    assert!(out.contains("FIXED [exec-bit]"), "{out}");
    assert_ne!(
        std::fs::metadata(&eng).unwrap().permissions().mode() & 0o100,
        0
    );
    // the state directory
    let k = Kit::new("dr-state");
    assert!(!k.e.state.exists());
    let (_, out) = k.doctor(&["--builtin", "--repair"]);
    assert!(out.contains("FIXED [state-dir]"), "{out}");
    assert_eq!(
        std::fs::metadata(&k.e.state).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn the_hooks_wiring_check_accepts_exactly_the_direct_form_of_each_event() {
    let k = Kit::new("dr-thin");
    k.engine(GOOD_ENGINE);
    k.put("hooks/install.sh", "#!/bin/sh\n");
    let direct = |ev: &str, root: &str, host: &str| {
        format!(
            "[ -x \\\"$HOME/.anti-hall/ah-engine/bin/ah-hook\\\" ] && exec \\\"$HOME/.anti-hall/ah-engine/bin/ah-hook\\\" {ev}{host} || exec sh \\\"{root}/hooks/install.sh\\\" {ev}{host}"
        )
    };
    let file = |cmds: &[(&str, String)]| {
        let body: Vec<String> = cmds
            .iter()
            .map(|(ev, c)| {
                format!("\"{ev}\":[{{\"hooks\":[{{\"type\":\"command\",\"command\":\"{c}\"}}]}}]")
            })
            .collect();
        format!("{{\"hooks\":{{{}}}}}", body.join(","))
    };
    k.put(
        "hooks/hooks.json",
        &file(&[
            (
                "PreToolUse",
                direct("PreToolUse", "${CLAUDE_PLUGIN_ROOT}", ""),
            ),
            ("Stop", direct("Stop", "${CLAUDE_PLUGIN_ROOT}", "")),
        ]),
    );
    k.put(
        "codex/hooks/hooks.json",
        &file(&[("Stop", direct("Stop", "${PLUGIN_ROOT}", " --host codex"))]),
    );
    let (_, out) = k.doctor(&["--builtin"]);
    assert!(
        out.contains("hooks/hooks.json is the thin form")
            && out.contains("codex/hooks/hooks.json is the thin form"),
        "{out}"
    );
    // a command for another event, a missing host argument and a hand-written command are all flagged
    k.put(
        "hooks/hooks.json",
        &file(&[
            ("PreToolUse", direct("Stop", "${CLAUDE_PLUGIN_ROOT}", "")),
            ("Stop", direct("Stop", "${CLAUDE_PLUGIN_ROOT}", "")),
        ]),
    );
    k.put(
        "codex/hooks/hooks.json",
        &file(&[("Stop", direct("Stop", "${PLUGIN_ROOT}", ""))]),
    );
    let (code, out) = k.doctor(&["--builtin"]);
    assert!(
        out.contains("hooks/hooks.json is not the thin form: 1 command(s)")
            || out.contains("hooks/hooks.json is not the thin form"),
        "{out}"
    );
    assert!(
        out.contains("codex/hooks/hooks.json is not the thin form"),
        "{out}"
    );
    assert_eq!(code, 1, "{out}");
}

#[test]
fn a_statusline_that_runs_the_retired_wrapper_is_rewritten_to_the_thin_client_with_a_backup() {
    let k = Kit::new("dr-statusline");
    k.engine(GOOD_ENGINE);
    let client = k.e.state.join("bin/ah-hook");
    // a stand-in for the installed thin client (the doctor keeps the real path in the command)
    let old_cmd = "sh \"/x/plugins/anti-hall/scripts/ah-run.sh\" --stdin statusline -- \"/x/plugins/anti-hall/statusline/statusline.js\"";
    let body = format!(
        "{{\n  \"theme\": \"dark\",\n  \"statusLine\": {{\n    \"type\": \"command\",\n    \"command\": {}\n  }}\n}}\n",
        serde_json::to_string(old_cmd).unwrap()
    );
    let settings = k.e.home.join(".claude/settings.json");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    std::fs::write(&settings, &body).unwrap();
    // no thin client at its installed path: nothing to point the status line at, the file is left alone
    let (_, out) = k.doctor(&["--builtin", "--repair"]);
    assert_eq!(std::fs::read_to_string(&settings).unwrap(), body, "{out}");
    exe(&client, "#!/bin/sh\nexit 0\n");
    let (_, out) = k.doctor(&["--builtin", "--repair", "--dry-run"]);
    assert!(out.contains("would rewrite the statusLine"), "{out}");
    assert_eq!(
        std::fs::read_to_string(&settings).unwrap(),
        body,
        "a dry run changes nothing"
    );
    let (_, out) = k.doctor(&["--builtin", "--repair"]);
    assert!(out.contains("FIXED [statusline]"), "{out}");
    let new_cmd = format!("\"{}\" statusline", client.display());
    let after = std::fs::read_to_string(&settings).unwrap();
    assert_eq!(
        after,
        body.replace(
            &serde_json::to_string(old_cmd).unwrap(),
            &serde_json::to_string(&new_cmd).unwrap()
        ),
        "only the command string changed"
    );
    let backups: Vec<_> = std::fs::read_dir(settings.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(".bak-antihall-"))
        .collect();
    assert_eq!(backups.len(), 1, "one backup, never deleted");
    assert_eq!(std::fs::read_to_string(backups[0].path()).unwrap(), body);
    // idempotent: nothing left to do, no second backup
    let (_, out) = k.doctor(&["--builtin", "--repair"]);
    assert!(!out.contains("FIXED [statusline]"), "{out}");
    assert_eq!(std::fs::read_to_string(&settings).unwrap(), after);
    let n = std::fs::read_dir(settings.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(".bak-antihall-"))
        .count();
    assert_eq!(n, 1);
}
