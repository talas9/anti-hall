//! Launcher RCA: the per-event budget was unbounded while the launcher cuts a call at `client.slow_fallback_max_ms`, so the
//! dispatcher could plan Node work the launcher would kill. Every shipped budget must end, with the client's wait margin,
//! inside the launcher's hard limit; the events the RCA measured must have one.

use ah_engine::{defaults, hookcfg::HookCfg};

#[test]
fn shipped_event_budgets_fit_the_launcher_limit() {
    // this checkout's defaults, not an installed plugin's
    // SAFETY: sets the same value every time, before this test reads any default; other tests in the binary set it identically.
    unsafe {
        std::env::set_var("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"));
    }
    let c = HookCfg::default();
    let (hard, margin) = (defaults::num("client.slow_fallback_max_ms"), defaults::num("client.slow_wait_margin_ms"));
    for ev in ["SessionStart", "UserPromptSubmit", "SessionEnd"] {
        let b = c.event(ev).budget_ms;
        assert!(b > 0, "{ev} has no budget");
        assert!(b + margin <= hard, "{ev}: budget {b} + margin {margin} must fit the launcher hard limit {hard}");
    }
}

/// #684: the wall ceiling of a request (plus the most grace a check may take past it) ends inside the window a client waits for a late
/// reply, so a verdict the daemon still gives under load is read, not thrown away; the former wall deadline, now only a soft mark that
/// counts saved verdicts, stays below the ceiling.
#[test]
fn the_request_wall_ceiling_fits_the_clients_late_reply_window() {
    // SAFETY: as above, the same value every time, before any default is read.
    unsafe {
        std::env::set_var("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"));
    }
    let ceiling = defaults::num("daemon.request_hard_ms");
    let grace = defaults::num("diagnostics.deadline_grace_cap_ms");
    let window = defaults::num("client.slow_fallback_max_ms").saturating_sub(defaults::num("client.slow_wait_margin_ms"));
    assert!(ceiling + grace <= window, "ceiling {ceiling} + grace {grace} must fit the client's late-reply window {window}");
    let warn = defaults::num("daemon.request_wall_warn_ms");
    assert!(defaults::num("client.deadline_ms") <= warn && warn < ceiling, "soft wall mark {warn} sits between the fail-fast wait and the ceiling {ceiling}");
}
