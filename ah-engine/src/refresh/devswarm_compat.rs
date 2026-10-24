//! Version-keyed, read-only DevSwarm dependency checks. Failures are diagnostics, never gates.
use crate::defaults;
use serde_json::{Value, json};
use std::path::Path;
use std::time::Instant;

fn manifest() -> Value {
    json!({
        "commands": defaults::list("devswarm_compat.commands"),
        "schema": defaults::list("devswarm_compat.schema"),
        "environment": defaults::list("devswarm_compat.environment"),
        "outputs": defaults::list("devswarm_compat.outputs"),
        "paths": defaults::list("devswarm_compat.paths"),
        "semanticConflicts": defaults::list("devswarm_compat.semantic_conflicts"),
        "forwarding": defaults::list("devswarm_compat.forwarding"),
        "helpArg": defaults::text("devswarm_compat.help_arg"),
        "helpMarker": defaults::text("devswarm_compat.help_marker"),
        "totalBudgetMs": defaults::num("devswarm_compat.total_budget_ms"),
        "commandTimeoutMs": defaults::num("devswarm_compat.command_timeout_ms"),
    })
}

/// Cached results only: status and doctor never execute probes or write state.
pub fn cached(home: &Path) -> Value {
    let path = home.join(defaults::text("devswarm_compat.cache"));
    let Some(cache) = super::read_object(&path) else {
        return json!({"status": "unverified", "reason": "no compatibility probe cached"});
    };
    let mut report = Value::Object(cache);
    let version =
        super::read_object(&home.join(defaults::text("session.devswarm_cache"))).and_then(|c| c.get("installed").and_then(Value::as_str).map(str::to_string));
    let stale = report.get("manifest") != Some(&manifest()) || version.as_deref().is_none_or(|v| report.get("version").and_then(Value::as_str) != Some(v));
    if stale {
        report["status"] = json!("unverified");
        report["reason"] = json!("cached probe differs from current version or dependency manifest");
    }
    report
}

/// Refresh only when the full version or dependency contract changed. Executes help, never operational verbs.
pub(super) fn refresh(home: &Path, bin: &str, version: &str) {
    let path = home.join(defaults::text("devswarm_compat.cache"));
    let contract = manifest();
    if let Some(old) = super::read_object(&path)
        && old.get("version").and_then(Value::as_str) == Some(version)
        && old.get("manifest") == Some(&contract)
    {
        return;
    }
    let started = Instant::now();
    let budget = defaults::millis("devswarm_compat.total_budget_ms");
    let mut checks = Vec::new();
    for spec in defaults::list("devswarm_compat.commands") {
        let Some((command, tokens)) = spec.split_once('|') else { continue };
        let mut args: Vec<&str> = command.split_whitespace().collect();
        args.push(defaults::text("devswarm_compat.help_arg"));
        let remaining = budget.saturating_sub(started.elapsed());
        let result = if remaining.is_zero() { None } else {
            super::exec(bin, &args, None, remaining.min(defaults::millis("devswarm_compat.command_timeout_ms")))
        };
        let mut conflicts = Vec::new();
        let (status, missing) = match result {
            Some((Some(0), out, _)) if out.contains(defaults::text("devswarm_compat.help_marker")) => {
                for conflict in defaults::list("devswarm_compat.semantic_conflicts") {
                    let parts: Vec<&str> = conflict.splitn(3, '|').collect();
                    if let [verb, marker, diagnostic] = parts.as_slice()
                        && *verb == command
                        && out.contains(*marker)
                    {
                        conflicts.push(*diagnostic);
                    }
                }
                let missing: Vec<&str> = tokens.split(',').filter(|t| !t.is_empty() && !out.contains(t)).collect();
                (if missing.is_empty() && conflicts.is_empty() { "help_verified" } else { "incompatible" }, missing)
            }
            Some((Some(_), _, _)) => ("incompatible", Vec::new()),
            _ => ("unverified", Vec::new()),
        };
        checks.push(json!({"dependency": command, "status": status, "missingFlags": missing, "semanticConflicts": conflicts}));
    }
    let env: crate::meshw::ident::Env = std::env::vars().collect();
    let db_path = crate::meshw::ident::app_db_path(home, &env);
    let conn = if started.elapsed() >= budget { None } else { db_path.as_deref().and_then(crate::meshw::appdb::open) };
    for spec in defaults::list("devswarm_compat.schema") {
        let Some((table, columns)) = spec.split_once(':') else { continue };
        // Only identifiers from the shipped contract, quoted even though no SQL mutation is possible on this connection.
        let names = conn.as_ref().and_then(|c| {
            let mut stmt = c.prepare(&format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""))).ok()?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(1)).ok()?;
            rows.collect::<Result<Vec<_>, _>>().ok()
        });
        let missing: Vec<&str> = columns.split(',').filter(|col| names.as_ref().is_none_or(|ns| !ns.iter().any(|n| n == *col))).collect();
        let status = if names.is_none() {
            "unverified"
        } else if missing.is_empty() {
            "schema_verified"
        } else {
            "incompatible"
        };
        checks.push(json!({"dependency": table, "status": status, "missingColumns": missing}));
    }
    let environment: Vec<Value> = defaults::list("devswarm_compat.environment")
        .iter()
        .map(|name| json!({"name": name, "present": env.get(*name).is_some_and(|v| !v.is_empty()), "status": "semantics_unverified"}))
        .collect();
    let incompatible = checks.iter().any(|c| c["status"] == "incompatible");
    let issues: Vec<&str> = checks.iter()
        .flat_map(|c| c.get("semanticConflicts").and_then(Value::as_array).into_iter().flatten())
        .filter_map(Value::as_str).collect();
    let reason = if incompatible {
        let names: Vec<&str> = checks.iter().filter(|c| c["status"] == "incompatible")
            .filter_map(|c| c.get("dependency").and_then(Value::as_str)).collect();
        format!("Dependency conflicts ({}): {}. Help and schema do not certify runtime compatibility.", names.join(", "), issues.join("; "))
    } else {
        "Help and schema only; output fields, environment semantics and descriptor producers remain unverified".to_string()
    };
    let report = json!({
        "version": version, "checkedAt": crate::health::now_ms(), "source": bin,
        "status": if incompatible { "incompatible" } else { "partial" },
        "reason": reason, "semanticConflicts": issues,
        "manifest": contract, "checks": checks, "environment": environment, "appDb": db_path,
    });
    crate::discard::harmless(super::write_file(&path, &report.to_string())); // retry next version refresh if unwritable
}
