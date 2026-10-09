//! The one integration-test binary of ah-engine: every former `tests/<name>.rs` is the module `<name>` here, so the crate
//! compiles and links once instead of once per file. Run one former file with `cargo test --test it -- <name>::` (or
//! `cargo nextest run -E 'test(/^<name>::/)'`). Tests that set process-global state stay in their own binaries under
//! `tests/` (`config_hotswap`, `runtime_config`, `jev_http`: they `set_var` HOME / proxy variables and rely on being alone in
//! their process); see docs/DEVELOPMENT.md.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

#[path = "../common/mod.rs"]
mod common;
mod replies;
mod roles;
mod transcript_support;

mod agent_cli;
mod agent_controls_parity;
mod cascade_judge;
mod compiled_logic_gate;
mod ctxbudget_e2e;
mod defaults_failover;
mod defaults_keys;
mod dep_budget;
mod devswarm_act_witness;
mod devswarm_gates_parity;
mod dssup_appsync;
mod js_number_printers;
mod dssup_deferred;
mod dssup_retention;
mod devswarm_prompt_parity;
mod devswarm_readside_parity;
mod devswarm_role_parity;
mod devswarm_rt;
mod devswarm_wire;
mod dispatch_config;
mod dispatch_e2e;
mod dispatch_table;
mod docs_coverage;
mod doctor_parity;
mod doctor_scenarios;
mod dssup;
mod dssup_ingest;
mod dssup_kill;
mod dssup_liveness;
mod durability;
mod e2e;
mod fail_closed_matrix;
mod fallback_read;
mod flip_parity;
mod gitcache_parity;
mod gitcheck;
mod goldens_unit;
mod handover_codex_e2e;
mod handover_hygiene;
mod hooks_files;
mod inject_gate_parity;
mod jev_cache_parity;
mod jev_integrations_parity;
mod jev_keep_parity;
mod jev_report_parity;
mod jev_scrub_reload;
mod judge_parity;
mod launcher_parity;
mod mcp_reaper_parity;
mod memory_soak;
mod mesh_parity;
mod migrate_parity;
mod model_routing_parity;
mod no_compiled_config;
mod no_hardcoded_tunables;
mod node_parity;
mod operator_parity;
mod port_guards_parity;
mod process_env_reads;
mod prompt_emit_dispatch;
mod prompt_emit_parity;
mod prop_parsers;
mod read_only_verbs;
mod reference;
mod reliability;
mod response_guards_parity;
mod schedule;
mod session_e2e;
mod setup_parity;
mod sibling_sweep_reload;
mod spawn_ctx_parity;
mod spool;
mod task_checks_e2e;
mod task_tracker_parity;
mod telemetry;
mod temp_leaks;
mod template_drift;
mod transcript_index;
mod transcript_parity;
mod update_parity;
mod wake_watch_parity;
