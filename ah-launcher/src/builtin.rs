//! The launcher's built-in copy of the settings it needs: the ONE justified constant set (owner rule: no hardcoding).
//!
//! It is used only when a defaults file is missing, unreadable or invalid, or when a single value in it has the wrong type,
//! so the bootloader still starts and still fails open the same way. Every value here equals the shipped
//! `engine/defaults/*.toml` entry of the same key; the test `builtin_equals_shipped_defaults` fails on any difference, so this
//! table cannot drift unseen. Tuning the launcher is editing the plugin's TOML, never this file.

pub const NUMS: &[(&str, u64)] = &[
    ("launcher.stdin_idle_ms", 1000),
    ("launcher.write_timeout_ms", 1000),
    ("launcher.connect_timeout_ms", 50),
    ("launcher.spawn_retry_max", 2),
    ("launcher.spawn_backoff_base_ms", 5),
    ("launcher.spawn_backoff_cap_ms", 40),
    ("launcher.spawn_jitter_pct", 50),
    ("launcher.io_chunk_bytes", 65536),
    ("launcher.payload_prefix_bytes", 1048576),
    ("launcher.out_cap_bytes", 4194304),
    ("launcher.err_cap_bytes", 1048576),
    ("launcher.stdin_soft_bytes", 8388608),
    ("launcher.stdin_hard_bytes", 536870912),
    ("launcher.mem_soft_bytes", 16777216),
    ("launcher.mem_hard_bytes", 67108864),
    ("launcher.cpu_soft_ms", 500),
    ("launcher.cpu_hard_s", 5),
    ("launcher.wall_hard_margin_ms", 500),
    ("launcher.crashloop_window_s", 60),
    ("launcher.crashloop_max", 5),
    ("launcher.log_soft_bytes", 262144),
    ("launcher.log_hard_bytes", 1048576),
    ("launcher.log_line_max", 512),
    ("launcher.log_rotate_min_s", 60),
    ("launcher.io_drain_ms", 100),
    ("launcher.spool_max_bytes", 67108864),
    ("launcher.selftest_engine_timeout_ms", 3000),
    ("launcher.reaper", 1),
    ("paths.socket_max_len", 100),
    ("client.deadline_ms", 300),
    ("client.deadline_slack_ms", 10),
    ("client.wrapper_extra_ms", 250),
    ("client.wrapper_kill_grace_ms", 200),
    ("client.wrapper_default_timeout_s", 10),
    ("client.slow_fallback_max_ms", 3000),
    ("client.cold_guard_wait_ms", 2000),
    ("client.cold_guard_poll_ms", 50),
    ("dispatch.defer_exit", 75),
];

pub const STRS: &[(&str, &str)] = &[
    ("msg.launcher_st_unusable", "unusable: {files}"),
    ("msg.launcher_st_missing", "missing or wrong type: {keys}"),
    ("msg.launcher_st_incoherent", "incoherent: {rules}"),
    (
        "msg.launcher_st_no_state",
        "no state directory (home directory unset or not absolute)",
    ),
    (
        "msg.launcher_st_socket_len",
        "socket path is {len} bytes, limit {max}",
    ),
    ("msg.launcher_st_no_engine", "no executable engine binary"),
    ("msg.launcher_st_not_exec", "not an executable file: {path}"),
    (
        "msg.launcher_st_ver_empty",
        "the version check printed nothing",
    ),
    (
        "msg.launcher_st_ver_exit",
        "the version check exited {code}",
    ),
    (
        "msg.launcher_st_ver_timeout",
        "the version check did not finish in {ms} ms",
    ),
    (
        "msg.launcher_st_cannot_start",
        "cannot start (errno {errno})",
    ),
    (
        "msg.launcher_st_mem_below",
        "hard heap limit is below the current heap",
    ),
    (
        "msg.launcher_st_no_wall",
        "cannot arm the wall-clock backstop",
    ),
    ("launcher.knob_fault", "AH_LAUNCHER_FAULT"),
    ("launcher.run_done_file", "done"),
    ("launcher.run_wait_file", "wait"),
    ("launcher.run_fail_open_file", "fail_open"),
    ("launcher.run_spool_file", "payload"),
    ("launcher.stats_env", "AH_LAUNCHER_STATS"),
    ("launcher.knob_engine_bin", "AH_ENGINE_BIN"),
    ("launcher.knob_fallback_list", "AH_FALLBACK_LIST"),
    ("launcher.knob_timeout_s", "AH_HOOK_TIMEOUT_S"),
    ("launcher.knob_timeout_ms", "AH_HOOK_TIMEOUT_MS"),
    ("launcher.knob_kill_grace_s", "AH_KILL_GRACE_S"),
    ("launcher.knob_sweep_age_s", "AH_HOOK_SWEEP_AGE_S"),
    ("launcher.test_flag_env", "AH_WRAPPER_TEST"),
    ("launcher.diag_env", "AH_ENGINE_WRAPPER_DIAG"),
    ("launcher.in_process_env", "AH_ENGINE_DISPATCH_IN_PROCESS"),
    ("launcher.fallback_list_claude", "ah-fallback.list"),
    ("launcher.fallback_list_codex", "ah-fallback.codex.list"),
    ("launcher.script_integrity", "ah-engine-integrity.sh"),
    ("launcher.script_bootstrap", "ah-engine-bootstrap.sh"),
    ("launcher.script_hook", "ah-hook.sh"),
    ("launcher.script_doctor", "ah-doctor.sh"),
    ("launcher.engine_lock_file", "ah-engine.lock"),
    ("launcher.engine_bin_rel", "bin/ah-engine"),
    ("launcher.engine_bin_name", "ah-engine"),
    ("launcher.run_base_dir", "tmp"),
    ("launcher.tmp_dir_prefix", "ah-hook-"),
    ("launcher.run_dir_prefix", "ah-launch."),
    ("files.fallback_switch", "fallback.node"),
    ("files.launcher_log", "launcher.log"),
    ("files.launcher_drops", "launcher.drops"),
    ("files.launcher_spawn_lock", "launcher.spawn.lock"),
    ("files.launcher_spawn_log", "launcher.spawns"),
    (
        "msg.launcher_ignored_knobs",
        "anti-hall: ignoring test-only variables (need AH_WRAPPER_TEST=1): {vars}",
    ),
    (
        "msg.launcher_bad_host",
        "anti-hall: ignoring unknown --host value",
    ),
    (
        "msg.launcher_fallback_exec_failed",
        "anti-hall: cannot run the Node fallback wrapper: {err}; the engine answers",
    ),
    (
        "msg.launcher_no_doctor",
        "anti-hall: ah-doctor.sh is missing next to ah-hook.sh; reinstall the plugin",
    ),
    (
        "msg.launcher_doctor_failed",
        "anti-hall: cannot run ah-doctor.sh: {err}",
    ),
    (
        "msg.launcher_fail_closed",
        "anti-hall: fail closed for {event}: {why}",
    ),
    (
        "msg.launcher_fail_open_stop",
        "anti-hall: fail open for {event} because stop_hook_active is true: {why}",
    ),
    (
        "msg.launcher_why_timeout_s",
        "AH_HOOK_TIMEOUT_S must be a positive integer",
    ),
    (
        "msg.launcher_why_timeout_ms",
        "AH_HOOK_TIMEOUT_MS must be a positive integer",
    ),
    (
        "msg.launcher_internal",
        "anti-hall: launcher internal failure, hook let through: {what}",
    ),
    (
        "msg.launcher_mem_hard",
        "anti-hall: launcher memory limit reached, hook let through",
    ),
    (
        "msg.launcher_cpu_hard",
        "anti-hall: launcher CPU limit reached, hook let through",
    ),
    (
        "msg.launcher_wall_hard",
        "anti-hall: launcher time limit reached, hook let through",
    ),
    (
        "msg.launcher_config_invalid",
        "defaults file unusable, built-in values used: {file}",
    ),
    ("msg.launcher_selftest_ok", "ok {check}"),
    ("msg.launcher_selftest_fail", "FAIL {check}: {why}"),
    ("env.dir", "AH_ENGINE_DIR"),
    ("env.done_file", "AH_ENGINE_DONE_FILE"),
    ("env.wait_file", "AH_ENGINE_WAIT_FILE"),
    ("env.fail_open_file", "AH_ENGINE_FAIL_OPEN_FILE"),
    ("env.nospawn", "AH_ENGINE_NOSPAWN"),
    ("env.plugin_root", "AH_ENGINE_PLUGIN_ROOT"),
    ("env.home", "HOME"),
    ("env.tmpdir", "TMPDIR"),
    ("paths.base_dir", ".anti-hall"),
    ("paths.state_dir", "ah-engine"),
    ("paths.socket_file", "e.sock"),
    ("files.daemon_down_marker", "daemon.down.until"),
    ("files.breaker_until", "breaker.until"),
    ("files.crashloop_until", "crashloop.until"),
    ("files.cold_guard_notice", "cold-guard.notice"),
    ("files.unreachable_notice", "unreachable.notice"),
    ("client.cold_guard_kick_event", "ColdStartKick"),
    (
        "msg.cold_guard_notice",
        "anti-hall: the engine was still starting, so this {event} was not checked; the guards apply again once it is up",
    ),
    (
        "msg.engine_unreachable_notice",
        "anti-hall: the engine did not answer this {event} call ({why}); it went through unchecked. Run `ah-engine doctor` if it keeps happening.",
    ),
    ("msg.launcher_unreachable_why_missing", "the engine is not installed"),
    ("msg.launcher_unreachable_why_down", "the engine is marked down"),
    ("msg.launcher_unreachable_why_handed_back", "the engine handed the call back"),
    ("msg.launcher_unreachable_why_silent", "the engine exited without an answer"),
    ("msg.launcher_unreachable_why_timed_out", "the engine did not answer in time"),
    ("msg.launcher_unreachable_why_unfinished", "the engine did not finish"),
    ("msg.launcher_unreachable_why_not_started", "the engine could not be started"),
];

/// Per-field number tables (`{ default = .., <Event> = .. }`).
pub const TABLES: &[(&str, &[(&str, u64)])] = &[(
    "launcher.wall_soft_ms",
    &[
        ("default", 0),
        ("SessionStart", 1100),
        ("UserPromptSubmit", 900),
        ("SessionEnd", 800),
        ("Stop", 3000),
    ],
)];

pub const LISTS: &[(&str, &[&str])] = &[
    (
        "launcher.plugin_root_envs",
        &["CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"],
    ),
    ("launcher.hosts", &["claude", "codex"]),
    (
        "dispatch.guard_events",
        &["PreToolUse", "PermissionRequest", "Stop", "SubagentStop"],
    ),
];

/// How the launcher finds its own settings (the bootstrap that must work before any settings are read): the defaults
/// directory below the plugin root, the file that marks a plugin root as complete, and the three files the launcher reads.
pub const CFG_REL_DIR: &str = "engine/defaults";
pub const CFG_MARKER_FILE: &str = "index.toml";
pub const CFG_ENGINE_FILE: &str = "engine.toml";
pub const CFG_DISPATCH_FILE: &str = "dispatch.toml";
pub const CFG_MESSAGES_FILE: &str = "messages.toml";
/// The plugin's hooks directory below the plugin root.
pub const HOOKS_DIR: &str = "hooks";

pub fn num(key: &str) -> Option<u64> {
    NUMS.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

pub fn table_num(key: &str, field: &str) -> Option<u64> {
    TABLES
        .iter()
        .find(|(k, _)| *k == key)
        .and_then(|(_, t)| t.iter().find(|(f, _)| *f == field))
        .map(|(_, v)| *v)
}

pub fn text(key: &str) -> Option<&'static str> {
    STRS.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

pub fn list(key: &str) -> Option<&'static [&'static str]> {
    LISTS.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}
