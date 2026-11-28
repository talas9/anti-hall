//! The pure arithmetic of the memory soak (tests/it/memory_soak.rs), kept in its own module so its millisecond unit test
//! runs in every profile while the long soak stays excluded by the `memory_soak::` filters.

/// The heap no registered holder names, KB: the live counted heap less every holder's bytes (the `other` of the ledger).
pub fn other_kb(st: &serde_json::Value) -> Option<f64> {
    let heap = st["memory"]["heap_live_kb"].as_f64()?;
    let held: f64 = st["memory"]["budgets"]["holders"].as_array()?.iter().filter_map(|h| h["bytes"].as_f64()).sum();
    Some(heap - held / 1024.0)
}

/// Least-squares slope of `(calls, kb)` in KB per 1000 calls.
pub fn slope_kb_per_kcall(s: &[(f64, f64)]) -> f64 {
    let n = s.len() as f64;
    let (mx, my) = (s.iter().map(|p| p.0).sum::<f64>() / n, s.iter().map(|p| p.1).sum::<f64>() / n);
    let num: f64 = s.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
    let den: f64 = s.iter().map(|p| (p.0 - mx).powi(2)).sum();
    if den == 0.0 { 0.0 } else { num / den * 1000.0 }
}

#[test]
fn the_other_heap_slope_is_least_squares_per_thousand_calls() {
    assert_eq!(slope_kb_per_kcall(&[(1000.0, 10.0), (2000.0, 20.0), (3000.0, 30.0)]), 10.0);
    assert_eq!(slope_kb_per_kcall(&[(1000.0, 7.0), (2000.0, 7.0)]), 0.0);
    let st = serde_json::json!({"memory": {"heap_live_kb": 100, "budgets": {"holders": [{"bytes": 20480}, {"bytes": 10240}]}}});
    assert_eq!(other_kb(&st), Some(70.0));
}
