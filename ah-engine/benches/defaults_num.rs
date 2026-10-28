//! Per-call cost of the settings accessors (`cargo bench --bench defaults_num`), the hot path of every `defaults::*` read
//! (#195). `daemon.queue` has an `env` override (the variable is unset here), `devswarm_wire.reconcile_min_gap_ms` has none.
//! The `_overlay64` cases read with the owner's config overlay holding 64 settings, the measured ones among them.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use ah_engine::defaults;
use criterion::{Criterion, criterion_group, criterion_main};
use std::hint::black_box;

fn accessors(c: &mut Criterion) {
    defaults::init().unwrap();
    let mut g = c.benchmark_group("defaults");
    g.bench_function("num_env_key", |b| b.iter(|| defaults::num(black_box("daemon.queue"))));
    g.bench_function("num_plain_key", |b| b.iter(|| defaults::num(black_box("devswarm_wire.reconcile_min_gap_ms"))));
    g.bench_function("text", |b| b.iter(|| defaults::text(black_box("msg.cfg_err_io"))));
    // the owner's files set 64 settings, the measured ones among them (#195)
    let mut over: Vec<(&str, serde_json::Value)> =
        defaults::all().iter().filter(|e| e.value.as_integer().is_some() && e.env.is_none()).take(62).map(|e| (e.key, e.value.to_json())).collect();
    over.push(("devswarm_wire.reconcile_min_gap_ms", serde_json::json!(5000)));
    over.push(("msg.cfg_err_io", serde_json::json!("overridden {path}: {err}")));
    defaults::set_overlay(&over);
    g.bench_function("num_env_key_overlay64", |b| b.iter(|| defaults::num(black_box("daemon.queue"))));
    g.bench_function("num_plain_key_overlay64", |b| b.iter(|| defaults::num(black_box("devswarm_wire.reconcile_min_gap_ms"))));
    g.bench_function("text_overlay64", |b| b.iter(|| defaults::text(black_box("msg.cfg_err_io"))));
    defaults::set_overlay(&[]);
    g.finish();
}

criterion_group!(benches, accessors);
criterion_main!(benches);
