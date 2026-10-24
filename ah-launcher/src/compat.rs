//! The compatibility contract of this build: the lowest engine version the launcher works with. It travels to the engine with each
//! request (`env.hook_engine_min`), which checks it against its own version and reports a mismatch in `status`, never blocking a hook.

/// The lowest engine version this launcher works with.
pub const ENGINE_MIN: &str = "0.2.0";
