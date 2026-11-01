//! The one integration-test binary of ah-engine: every former `tests/<name>.rs` is the module `<name>` here, so the crate
//! compiles and links once instead of once per file. Run one former file with `cargo test --test it -- <name>::` (or
//! `cargo nextest run -E 'test(/^<name>::/)'`). Tests that set process-global state stay in their own binaries under
//! `tests/` (`config_hotswap`, `runtime_config`, `jev_http`: they `set_var` HOME / proxy variables and rely on being alone in
//! their process); see docs/DEVELOPMENT.md.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)] // a test crate: a panic is the failure report, and E2 exempts tests

mod advisor_mode;
mod broad_kill;
#[path = "../common/mod.rs"]
mod common;
mod deploy_defaults_gate;
mod event_budgets;
mod invisible_channel;
mod lane_waste;
mod replies;
mod roles;
mod transcript_support;

mod agent_cli;
mod agent_scan_kept;
mod cascade_judge;
mod cli_pipe;
mod client_no_hooks;
mod codex_scripts_parity;
mod compiled_logic_gate;
mod crashloop_drill;
mod ctxbudget_e2e;
mod defaults_failover;
mod defaults_keys;
mod dep_budget;
mod devswarm_rt;
mod devswarm_wire;
mod dispatch_config;
mod dispatch_e2e;
mod dispatch_table;
mod docs_coverage;
mod doctor_scenarios;
mod dssup;
mod dssup_ingest;
mod dssup_telemetry;
mod durability;
mod e2e;
mod engine_update;
mod fail_closed_matrix;
mod flip_parity;
mod gitcache_parity;
mod gitcheck;
mod handover_codex_e2e;
mod handover_hygiene;
mod hooks_files;
mod jev_review_scan_mem;
mod jev_scrub_reload;
mod js_number_printers;
mod launcher_parity;
mod mcp_reaper_job;
mod mcp_reaper_parity;
mod mem_guard;
mod mem_restart_e2e;
mod memory_soak;
mod mesh_no_node_defers;
mod no_compiled_config;
mod no_hardcoded_tunables;
mod nodeback;
mod operator_parity;
mod process_env_reads;
mod prompt_emit_dispatch;
mod prop_parsers;
mod r_inline_e2e;
mod read_only_verbs;
mod reference;
mod reliability;
mod schedule;
mod session_e2e;
mod settings_overflow;
mod sibling_sweep_reload;
mod spawn_budget;
mod spool;
mod stop_channel_e2e;
mod stop_scripts_guardrail;
mod swarm_guard_cost;
mod task_checks_e2e;
mod task_readers_store;
mod telemetry;
mod temp_leaks;
mod transcript_index;
mod w2_behaviour_matrix;
mod w6_command_allow;
mod w6_task_tracker;
