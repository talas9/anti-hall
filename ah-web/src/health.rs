//! The Health and Topology data: the engine's `pulse`, `status` and `io` reduced to one [`Health`] document. Every call is a read.
//! A figure the engine does not report stays `None` or empty; nothing here invents a value.
use crate::app::App;
use crate::cfg::Settings;
use crate::ctl;
use ah_web_proto::{ClientRow, Health, Holder, StoreRow};
use serde_json::Value;
use std::time::{Duration, Instant};

fn num(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// The reading from the three documents; `status` and `io` are `None` when that call failed.
pub fn reduce(s: &Settings, pulse: &Value, status: Option<&Value>, io: Option<&Value>, now_ms: u64) -> Health {
    let none = Value::Null;
    let st = status.unwrap_or(&none);
    let budgets = &st["memory"]["budgets"]["global"];
    let footprint_kb = st.get("footprint_kb").and_then(Value::as_u64).or_else(|| pulse.get("footprint_kb").and_then(Value::as_u64)).unwrap_or(0);
    let mut holders: Vec<Holder> = st["memory"]["ledger"]["heap"]["holders"]
        .as_array()
        .map(|l| l.iter().map(|h| Holder { name: text(h, "name"), bytes: num(h, "bytes"), soft: num(h, "soft"), hard: num(h, "hard"), level: text(h, "level") }).collect())
        .unwrap_or_default();
    holders.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    holders.truncate(s.health_holders_max);
    let reason = st["health"]["degraded_reason"].as_str().unwrap_or_default().to_string();
    let clients = io
        .and_then(|d| d["clients"].as_array())
        .map(|l| {
            l.iter()
                .map(|c| ClientRow { id: text(c, "id"), label: String::new(), calls: num(c, "calls"), timeouts: num(c, "timeouts"), fail_open: num(c, "fail_open"), cold_starts: num(c, "cold_starts"), last_ms: num(c, "last_ms"), p50_us: num(c, "p50_us"), p95_us: num(c, "p95_us"), p50_over: c["p50_over"].as_bool().unwrap_or(false), p95_over: c["p95_over"].as_bool().unwrap_or(false) })
                .collect()
        })
        .unwrap_or_default();
    let stores = io
        .and_then(|d| d["stores"].as_array())
        .map(|l| {
            l.iter()
                .map(|c| StoreRow { id: text(c, "id"), reads: num(c, "reads"), writes: num(c, "writes"), bytes_in: num(c, "bytes_in"), bytes_out: num(c, "bytes_out"), errors: num(c, "errors"), last_ms: num(c, "last_ms"), p50_us: num(c, "p50_us"), p95_us: num(c, "p95_us"), p50_over: c["p50_over"].as_bool().unwrap_or(false), p95_over: c["p95_over"].as_bool().unwrap_or(false) })
                .collect()
        })
        .unwrap_or_default();
    Health {
        at_ms: now_ms,
        engine_ok: true,
        pid: num(pulse, "pid"),
        uptime_s: num(pulse, "uptime_s"),
        version: text(pulse, "version"),
        cpu_permille: pulse.get("cpu_permille").and_then(Value::as_u64),
        cpu_soft_permille: s.health_cpu_soft_permille,
        cpu_hard_permille: s.health_cpu_hard_permille,
        footprint_kb,
        rss_kb: num(pulse, "rss_kb"),
        mem_soft_kb: num(budgets, "soft_bytes") / 1024,
        mem_hard_kb: num(budgets, "hard_bytes") / 1024,
        requests: num(pulse, "requests"),
        errors: num(pulse, "errors"),
        slow_replies: num(pulse, "slow_replies"),
        busy_replies: num(pulse, "busy_replies"),
        panics: num(pulse, "panics"),
        restarts: num(pulse, "restarts"),
        queue_depth: num(pulse, "queue_depth"),
        workers: num(pulse, "workers"),
        degraded: st.get("degraded").and_then(Value::as_bool).unwrap_or(false),
        degraded_reason: reason,
        load_per_core: pulse.get("load_per_core").and_then(Value::as_f64),
        disk_free_kb: st.get("disk_free_kb").and_then(Value::as_u64),
        holders,
        io_enabled: io.and_then(|d| d["enabled"].as_bool()).unwrap_or(false),
        clients,
        stores,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The current reading, shared between tabs for `web.health_cache_ms`. An engine that does not answer gives `engine_ok: false`.
pub async fn read(app: &App) -> Health {
    let s = app.settings();
    if let Some((at, h)) = app.health.lock().unwrap_or_else(|p| p.into_inner()).as_ref()
        && at.elapsed() < Duration::from_millis(s.health_cache_ms)
    {
        return h.clone();
    }
    let timeout = Duration::from_millis(s.ctl_timeout_ms);
    let call = |req: &'static str| ctl::call(&app.socket, req, timeout, s.ctl_max_bytes);
    let (pulse, status, io) = tokio::join!(call("pulse"), call("status"), call("io"));
    let mut h = match pulse {
        Ok(p) => reduce(&s, &p, status.as_ref().ok(), io.as_ref().ok(), now_ms()),
        Err(_) => Health { at_ms: now_ms(), ..Health::default() },
    };
    // a client is a session id: name it by the project and the title the tracker knows it by (the id stays the hover detail)
    for c in &mut h.clients {
        if let Some(a) = app.model().lookup(&c.id, s.placeholder_id_chars) {
            c.label = if a.project_name.is_empty() || a.project_name == a.label { a.label } else { s.client_label.replace("{project}", &a.project_name).replace("{name}", &a.label) };
        }
    }
    *app.health.lock().unwrap_or_else(|p| p.into_inner()) = Some((Instant::now(), h.clone()));
    h
}
