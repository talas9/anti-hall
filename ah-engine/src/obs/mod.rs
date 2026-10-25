//! The observability contract (v0.301 W1): what the engine can tell you about itself, on demand and at no cost while idle.
//!
//! * [`profile`]: per-check CPU and allocation spans, switchable at run time, auto-expiring, bounded.
//! * [`trace`]: a small always-on ring of the latest records, dumped on request and when a hard limit trips.
//! * [`counters`]: per-site hand-back counters and uniform duty / stage accounting, kept by every process.
//! * [`diagverbs`]: the `diag <topic>` reports that read state the engine already has.
pub mod counters;
pub mod diagverbs;
pub mod profile;
pub mod trace;
