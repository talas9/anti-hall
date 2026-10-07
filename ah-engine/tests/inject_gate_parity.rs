//! The injection gate's text constants and settings must say what the Node hooks and `settings-schema.js` say, so the gate
//! recognises exactly what the hooks print and a settings change in one place reaches the other.
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").canonicalize().unwrap().join("plugins/anti-hall")
}

fn node(script: &str, args: &[&str]) -> String {
    let o = Command::new("node").arg("-e").arg(script).args(args).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8(o.stdout).unwrap()
}

#[test]
fn the_switches_match_the_node_settings_schema() {
    let script = r#"
const s = require(process.argv[1] + '/hooks/lib/settings-schema.js');
const keys = ['injectGate','injectGateLimit','injectGateLimitEvery','injectGateTask','injectGateTaskEvery','injectGateComms','injectGateCommsEvery','injectGateSwarm','injectGateSwarmEvery'];
console.log(JSON.stringify(keys.map((k) => { const e = s.findSetting('context', k); return { key: k, type: e.type, env: e.env || '', default: e.default, min: e.min === undefined ? null : e.min }; })));
"#;
    let rows: Value = serde_json::from_str(&node(script, &[plugin().to_str().unwrap()])).unwrap();
    let ours = [
        "inject_gate.sw_master",
        "inject_gate.sw_limit",
        "inject_gate.num_limit_every",
        "inject_gate.sw_task",
        "inject_gate.num_task_every",
        "inject_gate.sw_comms",
        "inject_gate.num_comms_every",
        "inject_gate.sw_swarm",
        "inject_gate.num_swarm_every",
    ];
    for (row, key) in rows.as_array().unwrap().iter().zip(ours) {
        let e = ah_engine::defaults::raw(key).to_json();
        assert_eq!(e["section"], "context", "{key}");
        assert_eq!(e["key"], row["key"], "{key}");
        assert_eq!(e["env"], row["env"], "{key}");
        assert_eq!(e["default"], row["default"], "{key}");
        if row["type"] == "number" {
            assert_eq!(e["min"], row["min"], "{key}.min");
        }
    }
}

#[test]
fn the_task_tracker_text_the_gate_recognises_is_what_the_hook_prints() {
    // first turn of a session prints the long form, the next one the short form (Node's own dedupe is off so the short form shows)
    let home = std::env::temp_dir().join(format!("ah-gate-parity-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let run = |turn: u32| -> String {
        let payload = serde_json::json!({"session_id": "gate-parity", "cwd": home, "prompt": format!("p{turn}")}).to_string();
        let mut c = Command::new("node");
        c.arg(plugin().join("hooks/task-tracker.js"))
            .env_clear()
            .env("HOME", &home)
            .env("ANTIHALL_EMIT_DEDUPE", "0")
            .env("PATH", std::env::var("PATH").unwrap_or_default());
        c.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
        let mut ch = c.spawn().unwrap();
        std::io::Write::write_all(&mut ch.stdin.take().unwrap(), payload.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        let v: Value = serde_json::from_slice(&o.stdout).unwrap_or(Value::Null);
        v["hookSpecificOutput"]["additionalContext"].as_str().unwrap_or("").to_string()
    };
    let long = run(1);
    let short = run(2);
    let _ = std::fs::remove_dir_all(&home);
    assert!(long.starts_with(ah_engine::defaults::text("inject_gate.task_long_prefix")), "{long:?}");
    assert!(short.starts_with(ah_engine::defaults::text("inject_gate.task_short")), "{short:?}");
}

#[test]
fn the_comms_and_swarm_markers_are_in_the_hooks_that_print_them() {
    let hooks = plugin().join("hooks");
    let src = |f: &str| std::fs::read_to_string(hooks.join(f)).unwrap();
    let markers = ah_engine::defaults::list("inject_gate.comms_markers");
    for hook in ["devswarm-child-turn.js", "devswarm-parent-inbox.js"] {
        assert!(src(hook).contains(markers[0]), "{hook} prints {:?}", markers[0]);
    }
    assert!(src("devswarm-parent-inbox.js").contains(markers[1]), "the title instruction");
    // the shared-tree advisory is built by block-message with the guard name "shared-tree"
    let built = node(
        "console.log(require(process.argv[1] + '/hooks/lib/block-message.js').message({kind:'warn',guard:'shared-tree',what:'x'}))",
        &[plugin().to_str().unwrap()],
    );
    assert!(built.contains(ah_engine::defaults::text("inject_gate.swarm_marker")), "{built:?}");
}
