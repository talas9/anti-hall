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
