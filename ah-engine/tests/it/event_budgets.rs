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

/// #684: for every event, the wall ceiling of a request (plus the most grace a check may take past it) ends inside the window the
/// client waits for a late reply, so a verdict the daemon still gives under load is read, not thrown away. Only Stop and SubagentStop
/// have the long ceiling and window; every other event, SessionEnd (5 s hook timeout) included, keeps the short pair.
#[test]
fn the_request_wall_ceiling_fits_the_clients_late_reply_window_per_event() {
    // SAFETY: as above, the same value every time, before any default is read.
    unsafe {
        std::env::set_var("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"));
        std::env::remove_var("AH_ENGINE_SLOW_FALLBACK_MAX_MS");
    }
    let grace = defaults::num("diagnostics.deadline_grace_cap_ms");
    let margin = defaults::num("client.slow_wait_margin_ms");
    let long = ["Stop", "SubagentStop"];
    for ev in ["Stop", "SubagentStop", "PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "SessionEnd", "Notification", ""] {
        let ceiling = ah_engine::deadline::ceiling_ms(ev);
        let window = defaults::num_for_event("client.slow_fallback_max_ms", "client.slow_fallback_event_ms", ev).saturating_sub(margin);
        assert!(ceiling + grace <= window, "{ev:?}: ceiling {ceiling} + grace {grace} must fit the client's late-reply window {window}");
        let is_long = long.contains(&ev);
        assert_eq!(ceiling > defaults::num("daemon.request_hard_ms"), is_long, "{ev:?}: only Stop/SubagentStop have the long ceiling ({ceiling})");
        assert_eq!(window + margin > defaults::num("client.slow_fallback_max_ms"), is_long, "{ev:?}: only Stop/SubagentStop wait longer");
    }
    // the short pair is the pre-#684 pair: a prompt or tool call never blocks for seconds on a daemon that is not answering
    assert_eq!((defaults::num("daemon.request_hard_ms"), defaults::num("client.slow_fallback_max_ms")), (2000, 3000));
    let warn = defaults::num("daemon.request_wall_warn_ms");
    assert!(
        defaults::num("client.deadline_ms") <= warn && warn <= defaults::num("daemon.request_hard_ms") && warn < ah_engine::deadline::ceiling_ms("Stop"),
        "soft wall mark {warn} sits between the fail-fast wait and the ceilings (below the long one, which it is there to count)"
    );
    // the progress gate is longer than two watchdog ticks (a late tick is no stall) and not past the heartbeat staleness it sits beside
    let (gate, tick) = (defaults::num("client.progress_stale_ms"), defaults::num("daemon.watchdog_tick_ms"));
    assert!(gate > tick * 2 && gate <= defaults::num("client.heartbeat_stale_ms"), "progress gate {gate} vs tick {tick}");
}
