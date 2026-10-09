//! The impact ledger's report (D52): everything the engine affected, with savings shown as labelled estimates.
//!
//! Observed facts (blocks, warnings, injected context, fallbacks) are exact counts. Savings are never presented as
//! measurements: each carries the method that produced it and the price table's own date and source. Where a
//! controlled with/without benchmark exists, its measured median is meant to sit beside the estimate with its
//! provenance; none is registered yet, so the list is empty rather than invented.
use crate::defaults;
use crate::storage::{ImpactFilter, Store};
use serde_json::{Map, Value, json};

/// Registered impact kinds, from `impact.*` in the defaults (excluding the price table and method entries).
pub fn kinds() -> Vec<String> {
    defaults::all().iter().filter(|e| e.key.starts_with("impact.") && e.value.get("counted").is_some()).map(|e| e.key["impact.".len()..].to_string()).collect()
}

/// True when `kind` is a registered impact kind.
pub fn is_kind(kind: &str) -> bool {
    kinds().iter().any(|k| k == kind)
}

fn bump(m: &mut Map<String, Value>, key: &str, by: u64) {
    let cur = m.get(key).and_then(Value::as_u64).unwrap_or(0);
    m.insert(key.to_string(), json!(cur + by));
}

/// The `impact` report for `filter`, with the last `recent` events.
pub fn summary(store: &dyn Store, filter: &ImpactFilter, recent: usize) -> Value {
    let counts = store.impact_counts(filter);
    let (mut by_kind, mut by_check, mut blocks_by_reason, mut by_project) = (Map::new(), Map::new(), Map::new(), Map::new());
    let mut total = 0;
    for c in &counts {
        total += c.count;
        bump(&mut by_kind, &c.kind, c.count);
        if !c.check.is_empty() {
            bump(&mut by_check, &c.check, c.count);
        }
        if c.kind == "block" {
            bump(&mut blocks_by_reason, &c.reason, c.count);
        }
        bump(&mut by_project, &c.project, c.count);
    }
    let table = defaults::raw("impact.price_table");
    let events: Vec<Value> = store
        .recent_impact(filter, recent)
        .into_iter()
        .map(|e| json!({"ts_ms": e.ts_ms, "kind": e.kind, "check": e.check, "reason": e.reason, "project": e.project}))
        .collect();
    json!({
        "running": true,
        "persisted": store.persisted(),
        "note": defaults::text(if store.persisted() { "telemetry.impact_persisted_note" } else { "telemetry.not_persisted_note" }),
        "registered_kinds": kinds(),
        "total": total,
        "by_kind": by_kind,
        "by_check": by_check,
        "blocks_by_reason": blocks_by_reason,
        "by_project": by_project,
        "events_held": store.held_events(),
        "events_dropped": store.dropped(),
        "recent": events,
        "savings": {
            "model_routing": {
                "label": "estimate",
                "status": defaults::text("msg.impact_no_routing"),
                "estimated_usd": null,
                "method": defaults::text("impact.savings_method"),
                "price_table": {"date": table.str_field("date"), "source": table.str_field("source")},
            },
            "measured_benchmarks": [],
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{ImpactEvent, MemStore};

    #[test]
    fn savings_are_labelled_estimates_with_their_method_and_no_invented_figure() {
        let s = MemStore::new(10, 10, "other");
        let v = summary(&s, &ImpactFilter::default(), 5);
        let r = &v["savings"]["model_routing"];
        assert_eq!(r["label"], "estimate");
        assert!(r["estimated_usd"].is_null(), "no routing events, so no figure");
        assert!(r["method"].as_str().unwrap().contains("estimate"));
        assert_eq!(v["savings"]["measured_benchmarks"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn the_report_groups_blocks_by_reason() {
        let s = MemStore::new(10, 10, "other");
        for (k, r) in [("block", "force_push"), ("block", "force_push"), ("block", "credit"), ("warning", "w")] {
            s.record_impact(ImpactEvent { ts_ms: 1, kind: k.into(), check: "git".into(), reason: r.into(), project: "p".into() });
        }
        let v = summary(&s, &ImpactFilter::default(), 2);
        assert_eq!(v["total"], 4);
        assert_eq!(v["blocks_by_reason"]["force_push"], 2);
        assert_eq!(v["recent"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn registered_kinds_exclude_the_price_table_and_method() {
        let k = kinds();
        assert!(k.contains(&"block".to_string()) && !k.contains(&"price_table".to_string()) && !k.contains(&"savings_method".to_string()));
        assert!(is_kind("fallback") && !is_kind("nope"));
    }
}
