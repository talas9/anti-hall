//! Every key the source reads from the shipped defaults exists, and every shipped setting is read by the source
//! (D17). Together with `no_hardcoded_tunables` this keeps code and `defaults/*.toml` in lock step: a typo cannot
//! panic in production, and a setting nobody reads cannot linger and mislead.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

fn js_in(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            js_in(&p, out);
        } else if p.extension().is_some_and(|x| x == "js") {
            out.push(p);
        }
    }
}

#[path = "../../build_support/keyscan.rs"]
#[allow(dead_code)] // `HELPERS` and `Kind::name` serve build.rs
mod keyscan;

/// Review P1 #3: the keys the build compiles in (and the load rejects a plugin without) are exactly what the shared scanner
/// collects, including the shapes the first scanner missed: `env_var`/`env_name` (`env.*`), the settings-view methods of
/// sibling_sweep (`t.num("sibling_sweep.*")`), and keys built from a prefix (`git.*` short names, `files.*`, `store.*`).
#[test]
fn the_compiled_key_list_is_the_scanned_one_and_covers_every_call_shape() {
    let scanned = keyscan::scan(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"));
    let compiled: BTreeSet<&str> = ah_engine::defaults::required().iter().map(|(k, _)| *k).collect();
    assert_eq!(compiled, scanned.keys().map(String::as_str).collect::<BTreeSet<_>>(), "build.rs and the scanner disagree");
    for k in ["env.done_file", "files.log", "store.kv_cap", "dispatch.msg_no_fallback"] {
        assert!(compiled.contains(k), "{k} is read by the source but not checked at load");
    }
    let kind = |k: &str| ah_engine::defaults::required().iter().find(|(x, _)| *x == k).map(|(_, t)| *t);
    use ah_engine::defaults::Kind;
    assert_eq!(kind("env.done_file"), Some(Kind::Str));
    assert_eq!(kind("dispatch.guard_events"), Some(Kind::List));
}

#[test]
fn every_key_the_source_reads_is_shipped_and_every_shipped_key_is_read() {
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let shipped: BTreeSet<String> = ah_engine::defaults::all().iter().map(|e| e.key.to_string()).collect();
    let used: BTreeSet<String> = keyscan::scan(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src")).into_keys().collect();
    let missing: Vec<&String> = used.iter().filter(|k| k.contains('.') && !shipped.contains(*k)).collect();
    assert!(missing.is_empty(), "keys read by the source but not shipped: {missing:?}");
    // A shipped key counts as read when its full name appears as a string literal in the source, or, for sections whose
    // keys are read through a prefixing helper (`git.*`, `env.*`, `files.*`, `store.*`), when its short name does.
    let mut literals: BTreeSet<String> = BTreeSet::new();
    // identifier-like literals only: a key or a short name, which is all this check needs
    let re = regex::Regex::new(r#""([a-z][a-z0-9_.]*)""#).unwrap();
    for f in &files {
        let text = fs::read_to_string(f).unwrap();
        let text = text.split("#[cfg(test)]\nmod tests {").next().unwrap_or("").to_string();
        literals.extend(re.captures_iter(&text).map(|c| c[1].to_string()));
    }
    // a scheduled job names the setting that holds its interval (`every_key`); the scheduler reads it through that name
    for e in ah_engine::defaults::all().iter().filter(|e| e.key.starts_with("job.")) {
        if let Some(k) = e.value.get("every_key").and_then(ah_engine::defaults::V::as_str) {
            assert!(shipped.contains(k), "{} names every_key {k}, which is not shipped", e.key);
            literals.insert(k.to_string());
        }
    }
    // D88: a check whose logic is a plugin script reads its settings from the script (`engine/logic/**/*.js`). Every dotted
    // string literal of a script whose section is a shipped section must be a shipped key, and counts as a read.
    let sections: BTreeSet<&str> = shipped.iter().filter_map(|k| k.split_once('.').map(|(s, _)| s)).collect();
    let js_re = regex::Regex::new(r#"['"]([a-z][a-z0-9_]*\.[a-z0-9_.]+)['"]"#).unwrap();
    let mut js_files = Vec::new();
    js_in(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/logic"), &mut js_files);
    assert!(!js_files.is_empty(), "no scripts found under engine/logic");
    for f in &js_files {
        for c in js_re.captures_iter(&fs::read_to_string(f).unwrap()) {
            let key = c[1].to_string();
            if sections.contains(key.split('.').next().unwrap_or("")) {
                assert!(shipped.contains(&key), "{}: reads defaults key {key}, which is not shipped", f.display());
                literals.insert(key);
            }
        }
    }
    // a latency gate in a test binary of its own reads the per-check allowances (`script.p95_budget_by_check`)
    let latency = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/script_latency.rs")).unwrap();
    literals.extend(re.captures_iter(&latency).map(|c| c[1].to_string()));
    // the invisible-channel ratchet test reads its own lists (`channel_ratchet.*`, tests/it/invisible_channel.rs)
    let channel = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/it/invisible_channel.rs")).unwrap();
    literals.extend(re.captures_iter(&channel).map(|c| c[1].to_string()));
    // the git script reads its `git.*` tables through the one-argument helper `c('short_name')`
    let c_re = regex::Regex::new(r#"\bc\('([a-z][a-z0-9_]*)'\)"#).unwrap();
    for f in js_files.iter().filter(|f| f.file_name().is_some_and(|n| n == "git.js")) {
        for c in c_re.captures_iter(&fs::read_to_string(f).unwrap()) {
            literals.insert(format!("git.{}", &c[1]));
        }
    }
    // the tasklist-guard script reads its `tasklist_guard.*` keys through the helpers `tlT('short_name')` and `tlN('short_name')`
    let tl_re = regex::Regex::new(r#"\btl[TN]\('([a-z][a-z0-9_]*)'\)"#).unwrap();
    for f in js_files.iter().filter(|f| f.file_name().is_some_and(|n| n == "tasklist-guard.js")) {
        for c in tl_re.captures_iter(&fs::read_to_string(f).unwrap()) {
            literals.insert(format!("tasklist_guard.{}", &c[1]));
        }
    }
    // scripts that read their keys through a one-argument helper `xT('short_name')` / `xN('short_name')`: (script, helper regex, section)
    for (script, helper, section) in [
        ("task-tracker.js", r"\btt[TN]\('([a-z][a-z0-9_]*)'\)", "task_tracker"),
        ("task-lifecycle-log.js", r"\blc[TN]\('([a-z][a-z0-9_]*)'\)", "task_lifecycle_log"),
        ("devswarm-comms-guard.js", r"\bdc[TN]\('([a-z][a-z0-9_]*)'\)", "devswarm_comms"),
        ("jev-review-reminder.js", r"\bsg[TN]\('([a-z][a-z0-9_]*)'\)", "session_gates"),
        ("jev-weekly-scorecard.js", r"\bsg[TN]\('([a-z][a-z0-9_]*)'\)", "session_gates"),
        ("repair-on-reload.js", r"\bsg[TN]\('([a-z][a-z0-9_]*)'\)", "session_gates"),
        ("scan-throttle.js", r"\bst[TN]\('([a-z][a-z0-9_]*)'\)", "scan_throttle"),
        ("merge-side-pick.js", r"\bmp[TN]\('([a-z][a-z0-9_]*)'\)", "merge_side_pick"),
        ("merge-gate.js", r"\bmg[TN]\('([a-z][a-z0-9_]*)'\)", "merge_gate"),
        ("coordinator-work-guard.js", r"\b(?:cw[TN]|cwNamed|g)\('([a-z][a-z0-9_]*)'\)", "coordinator_work"),
        ("codex-availability.js", r"\bcx[TN]\('([a-z][a-z0-9_]*)'\)", "codex_handover"),
        ("codex-quota-detect.js", r"\bcx[TN]\('([a-z][a-z0-9_]*)'\)", "codex_handover"),
        ("codex-nudge.js", r"\bcx[TN]\('([a-z][a-z0-9_]*)'\)", "codex_handover"),
        ("command.js", r"\bcm(?:C|Set|ReAny)\('([a-z][a-z0-9_]*)'", "command"),
        ("api-guard.js", r"\bagCfg\('([a-z][a-z0-9_]*)'\)", "api_guard_v1"),
    ] {
        let re = regex::Regex::new(helper).unwrap();
        for f in js_files.iter().filter(|f| f.file_name().is_some_and(|n| n == script)) {
            for c in re.captures_iter(&fs::read_to_string(f).unwrap()) {
                literals.insert(format!("{section}.{}", &c[1]));
            }
        }
    }
    // a script that takes a lock names the defaults group holding its timings (`<group>.lock_*`, nodelock::Params::from_group);
    // the host reads them by that name. The group is a literal ('swarm_guard') or the value of a shipped text key
    // (ah.cfg('spawn_ceiling.reservation_lock_group')), which must name a shipped group.
    let lock_re = regex::Regex::new(r"\.lock\(.*?,\s*(?:'([a-z][a-z0-9_]*)'|ah\.cfg\('([a-z][a-z0-9_.]*)'\))").unwrap();
    for f in &js_files {
        for c in lock_re.captures_iter(&fs::read_to_string(f).unwrap()) {
            let group = match (c.get(1), c.get(2)) {
                (Some(g), _) => g.as_str().to_string(),
                (None, Some(k)) => {
                    let k = k.as_str();
                    let v = ah_engine::defaults::all().iter().find(|e| e.key == k).and_then(|e| e.value.as_str().map(str::to_string));
                    v.unwrap_or_else(|| panic!("{}: a lock group key {k} that is not a shipped text", f.display()))
                }
                _ => unreachable!(),
            };
            assert!(shipped.contains(&format!("{group}.lock_wait_ms")), "{}: lock group {group} is not shipped", f.display());
            for k in [
                "lock_stale_ms",
                "lock_wait_ms",
                "lock_step_ms",
                "lock_reclaim_stale_ms",
                "lock_release_tries",
                "lock_release_step_ms",
                "lock_boot_slop_s",
                "lock_steal_dead", // optional: only a group that ships it takes over a dead holder at once
            ] {
                literals.insert(format!("{group}.{k}"));
            }
        }
    }
    // Optional startup optimizations are enumerated by prefix, including when absent in pristine.
    literals.extend(shipped.iter().filter(|k| k.starts_with("script.prewarm_")).cloned());
    // Retired fields from the immutable pristine schema remain required by defaults::load's
    // repair path. Keep this list explicit: newly unused fields must still fail the audit.
    let compatibility: BTreeSet<&str> = [
        "act.msg_no_session",
        "devswarm_prompt.escape_marker",
        "devswarm_role.pg_frame_head",
        "devswarm_role.pg_frame_indent",
        "devswarm_role.pg_frame_instead",
        "devswarm_role.pg_frame_override",
        "devswarm_role.pg_frame_why",
        "devswarm_role.pg_why",
        "git.block_emoji",
        "git.block_mark",
        "git.label_allowed",
        "git.label_instead",
        "git.label_override",
        "git.label_why",
        "guardkit.brief_why",
        "mesh_write.cause_not_registered",
        "mesh_write.heal_cooldown_flag",
        "mesh_write.heal_disabled_key",
        "mesh_write.heal_disabled_label_key",
        "mesh_write.heal_engine_owned_note",
        "mesh_write.heal_retry_after",
        "mesh_write.ingest_owner_name",
        "mesh_write.launchd_label_prefix",
        "mesh_write.log_op_inbox_ack_primary",
        "mesh_write.ms_per_hour",
        "mesh_write.msg_ack_primary_not_owner",
        "mesh_write.msg_pull_replay_failed",
        "mesh_write.msg_receipt_owner",
        "mesh_write.msg_store_not_opened",
        "mesh_write.reason_receipt_owner_mismatch",
        "mesh_write.tick_roster_env",
        "mesh_write.tick_roster_setting",
        "mesh_write.tick_settings_files",
        "messages.style_guide",
        "msg.err_mesh_read_id",
        "msg.log_budget_skipped",
        "nested_spawn.summary",
        "routine.sweep_step_files",
        "routine.sweep_step_units",
        "tasklist_guard.details_label",
        "update.zero_version",
    ]
    .into_iter()
    .collect();
    let pristine = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/defaults.pristine");
    let pristine_text: String = fs::read_dir(pristine)
        .unwrap()
        .flatten()
        .filter(|f| f.path().extension().is_some_and(|x| x == "toml"))
        .map(|f| fs::read_to_string(f.path()).unwrap())
        .collect();
    for key in &compatibility {
        assert!(pristine_text.contains(&format!("[{key}]")), "compatibility field {key} must belong to the immutable repair schema");
    }
    let indirect = |k: &str| {
        k.starts_with("routine.flag_") // routine::flag constructs these CLI names from its argument
            || ["metric.tasklist_integration_skipped", "metric.tasklist_progress_carried", "metric.command_heavy_segment_named", "metric.devswarm_parent_gate_fired", "metric.devswarm_parent_gate_suppressed", "metric.devswarm_parent_gate_count_mismatch", "metric.devswarm_orphans_warning_suppressed", "metric.devswarm_dead_child_skipped", "metric.devswarm_dead_child_expired", "metric.devswarm_dead_mark_ignored", "metric.burn_breaker_paused", "metric.burn_breaker_bypass", "metric.burn_pause_withheld", "metric.agent_outcome_kind", "devswarm_role.pg_repeat_step", "metric.spawns_denied_over_cap", "metric.spawn_reservations", "metric.runtime_escalation_stop_unrecorded", "metric.protocol_delivery", "metric.silent_agent_nudge_fired", "metric.silent_agent_nudge_acked", "metric.rule_digest", "guard_rules.msg_rm_rf_root", "guard_rules.msg_no_heredoc", "metric.git_blocked", "metric.git_push_blocked", "metric.git_push_ack_downgraded", "metric.git_audit_blocked"].contains(&k) // counted by the scripts through ah.advisory(kind, name) / ah.metric(name); pg_repeat_step is named by the repeat.allowed_keys table; the name is a literal in the script; burn_pause_withheld and agent_outcome_kind are named by burn.doubt.metric and agent_tracker.outcome_metric.name (GH #458)
            || k.starts_with("webapi.source_") // web::query enumerates this registry with defaults::with_prefix
            || k.starts_with("jevrep.t_") // the texts and thresholds of the report, handed whole to the plugin script rules/jev-report (`jev_report::cfg`)
            || k.starts_with("jevrep.thr_")
            || k.starts_with("opcli.ahc_") // the words and numbers of the L03 verbs, handed whole to the plugin scripts rules/operator-cli and rules/coordinator-work-baseline (`ops::opcli_cfg`)
            || k.starts_with("opcli.dr_")
            || k.starts_with("opcli.fd_")
            || k.starts_with("opcli.cwb_")
            || k.starts_with("flag.") // the documented flags, read whole by the reference generator (`docs::documented_flags`)
            || k == "docs.external_flags" // read by the flag drift test (tests/it/reference.rs)
            || ["env.auto_update", "env.install_lock_token", "env.release_base", "env.wrapper_diag"].contains(&k) // read by the shell wrappers, named here so the reference lists them
            || k.starts_with("cmd.") // handlers are checked against the registry by cli::tests; planned commands have no handler
            || k.starts_with("protocol.") // documents the wire format; the request words are parsed in daemon.rs
            || k.starts_with("job.") // scheduled jobs are read by prefix in schedule.rs
            || k.starts_with("msg.hint_") // named by the health.error_codes table, not by source
            || k.starts_with("git.msg_") // block messages are rendered by block(name); the name is a literal there
            || k.starts_with("coordinator_work.lock_") // the lock timings of the coordinator-work-guard script, read as a group (`Params::from_group("coordinator_work")`)
            || k.starts_with("ctxbudget.ca_advice_") // regex sources named by the ctxbudget.ca_advice list
            || k.starts_with("web.") // the Command Center server (ah-web) reads its own file; the engine reads only the start-up keys
            || k.starts_with("launcher.") // the hook launcher (ah-launcher, binary ah-hook) reads these; the engine does not
            || k.starts_with("files.launcher_") // the launcher's own log, drop counter, spawn lock and spawn log
            || k.starts_with("msg.launcher_") // the launcher's texts
            || k.starts_with("client.wrapper_") // the shell wrapper (`hooks/ah-hook.sh`) reads these before Rust starts
            || k == "client.slow_fallback_max_ms" // the shell wrapper's watchdog extension for a call waiting on a slow daemon
            || k.starts_with("client.cold_guard_") // the shell wrapper's cold-start wait for a guard event (the engine reads only the kick event's name)
            || k == "files.cold_guard_notice" // the wrapper's once-per-session notice stamp
            || k == "msg.cold_guard_notice" // the wrapper's notice text
            || k == "files.unreachable_notice" // the wrapper's and the launcher's once-per-session stamp of the engine-unreachable notice
            || k == "msg.engine_unreachable_notice" // that notice's text (read by hooks/ah-hook.sh and by the launcher)
            || k == "msg.run_engine_missing" // the text the thin client (`ah-hook <verb>`) prints when no engine can run its command
            || k.starts_with("doctor_l.") // the thin client's built-in doctor (`ah-hook doctor`, ah-launcher/src/doctor.rs) reads these; the engine does not
            || k.starts_with("hooks_form.") // the direct form of a hook command: read by `ah-hook doctor --repair` (the engine's hooks generator follows it)
            || k.starts_with("updater.") // the thin client's updater (`ah-hook update`, ah-launcher/src/update.rs) reads these; the engine does not
            || k.starts_with("msg.updater_") // the updater's texts
            || k == "env.live_kit" // the live-kit directory override, read by the updater
            || k.starts_with("msg.install_") // the installer's texts (hooks/install.sh and the thin client)
            || k.starts_with("install.") // the thin client's installer (`ah-hook install`, ah-launcher/src/install.rs) and hooks/install.sh read these; the engine does not
            || k.starts_with("rollback.") // the thin client (`ah-hook integrity`, ah-launcher) reads its names and thresholds itself; the engine reads only the client name
            || k == "files.integrity_log" // written by the thin client (`ah-hook integrity`)
            || k == "files.wrapper_fail_log" // written by the thin client, from its failure reports
            || k.starts_with("dispatch.hooks_") // the dispatch table, read by host and event (dispatch::table::key)
            || k == "script.p95_budget_by_check" // read by tests/script_latency.rs, the go/no-go gate of the scripted checks
            || k.starts_with("procwatch.mode_") // each orphan class names its mode setting by key (procwatch.classes mode_key)
            || matches!(k, "claim_evidence.neg_res" | "claim_evidence.neg_subject_res" | "claim_evidence.modal_res" | "claim_evidence.future_res" | "claim_evidence.reported_res" | "claim_evidence.criterion_res" | "claim_evidence.no_idiom_re" | "claim_evidence.opener_idiom_re" | "claim_evidence.opener_filler_re" | "claim_evidence.noun_before_re" | "claim_evidence.compound_after_re") // each suppress row names its pattern list and idiom regex by key (claim_evidence.suppress list, idiom)
            || k.starts_with("claim_evidence.reach_") && k != "claim_evidence.reach_label" // each suppress row names its reach by key (claim_evidence.suppress reach)
            || k.starts_with("devswarm_sup.duty.") // the supervisor duties, read by name from the ordered list devswarm_sup.duties
            || k.starts_with("devswarm_sup.set_") // Node settings entries, named by the duty that uses them (the duty's `sec` / `mode` fields)
            || ah_engine::skillgen::rules().iter().any(|r| r.source.split_once('.').is_some_and(|(s, n)| *k == format!("{s}.{}", n.replacen("what", "digest", 1)))) // the digest field beside a rule's split message entry (skillgen::digest_field)
    };
    let read = |k: &String| {
        let (section, name) = k.split_once('.').unwrap_or(("", k));
        literals.contains(k) || (["git", "env", "files", "store", "metric", "impact", "cmd", "tasklist_guard"].contains(&section) && literals.contains(name))
    };
    let unread: Vec<&String> = shipped.iter().filter(|k| !read(k) && !indirect(k) && !compatibility.contains(k.as_str())).collect();
    assert!(unread.is_empty(), "shipped settings nothing reads (delete them or use them): {unread:?}");
}

#[test]
fn every_metric_and_impact_kind_the_source_records_is_registered() {
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let metric_calls = regex::Regex::new(r#"\b(?:inc|add|observe|set)\("([a-z_]+)""#).unwrap();
    let impact_calls = regex::Regex::new(r#"\.impact\("([a-z_]+)""#).unwrap();
    for f in &files {
        let text = fs::read_to_string(f).unwrap();
        let text = text.split("#[cfg(test)]\nmod tests {").next().unwrap_or("").to_string();
        for c in metric_calls.captures_iter(&text) {
            // `set("...")` is also used by unrelated code; only names that look like metrics matter
            let name = &c[1];
            if ah_engine::defaults::has(&format!("metric.{name}")) || !text.contains(&format!("(\"{name}\", &[")) && !text.contains(&format!("inc(\"{name}\""))
            {
                continue;
            }
            panic!("{}: metric {name:?} is recorded but not registered in defaults/telemetry.toml", f.display());
        }
        for c in impact_calls.captures_iter(&text) {
            assert!(ah_engine::impact::is_kind(&c[1]), "{}: impact kind {:?} is recorded but not registered", f.display(), &c[1]);
        }
    }
}
