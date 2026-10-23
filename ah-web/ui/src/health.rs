//! The Health and Topology screens. One poller reads `/api/health` while either screen is shown (and the tab is visible), keeps the
//! reading and the call rates worked out from two readings, and the screens draw them: Health as meters, tiles and tables, Topology
//! on the shared graph component (clients, the engine's parts, the files and databases they use; a line pulses with its real rate).
//! Every text and threshold comes from the boot data; the screens carry none of their own.
use super::{compact, fmt_age, now_ms, since, tier_of, tx};
use ah_web_graph::{ActionCall, ActionDef, EdgeDef, Graph, GraphConfig, GraphData, LayoutMode, NodeDef, Tier};
use ah_web_proto::{ActionRes, Boot, ClientRow, Health, StoreRow, TopoActionDef, TopoCfg, TopoReq, HEALTH_PATH, TOPO_ACTION_PATH};
use leptos::prelude::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{RequestInit, Response};

/// Calls per second worked out from two readings.
#[derive(Clone, Default, PartialEq)]
pub struct Rates {
    pub clients: HashMap<String, f32>,
    pub stores: HashMap<String, f32>,
    pub requests: f32,
}

/// What the screens share: the latest reading, its rates, whether the last read failed and the output of the last node action
/// (node id, action label, text).
#[derive(Clone, Copy)]
pub struct HealthState {
    pub doc: RwSignal<Option<Health>>,
    pub rates: RwSignal<Rates>,
    pub failed: RwSignal<bool>,
    pub out: RwSignal<Option<(String, String, String)>>,
}

impl HealthState {
    pub fn new() -> HealthState {
        HealthState { doc: RwSignal::new(None), rates: RwSignal::new(Rates::default()), failed: RwSignal::new(false), out: RwSignal::new(None) }
    }
}

thread_local! {
    static PREV: RefCell<Option<Health>> = const { RefCell::new(None) };
    /// The tick closures, by the interval id each one runs under: an interval is cleared, then its closure dropped, never the other way.
    static TICKS: RefCell<HashMap<i32, Closure<dyn FnMut()>>> = RefCell::new(HashMap::new());
}

fn per_s(now: u64, before: u64, dt_s: f64) -> f32 {
    if now < before || dt_s <= 0.0 { 0.0 } else { ((now - before) as f64 / dt_s) as f32 }
}

/// The rates between two readings (0 where a counter went back: the engine restarted).
fn rates_between(prev: &Health, now: &Health) -> Rates {
    let dt = now.at_ms.saturating_sub(prev.at_ms) as f64 / 1000.0;
    let calls: HashMap<&str, u64> = prev.clients.iter().map(|c| (c.id.as_str(), c.calls)).collect();
    let ops: HashMap<&str, u64> = prev.stores.iter().map(|s| (s.id.as_str(), s.reads + s.writes)).collect();
    Rates {
        clients: now.clients.iter().map(|c| (c.id.clone(), per_s(c.calls, calls.get(c.id.as_str()).copied().unwrap_or(c.calls), dt))).collect(),
        stores: now.stores.iter().map(|s| (s.id.clone(), per_s(s.reads + s.writes, ops.get(s.id.as_str()).copied().unwrap_or(s.reads + s.writes), dt))).collect(),
        requests: per_s(now.requests, prev.requests, dt),
    }
}

async fn get_health() -> Result<Health, String> {
    let w = web_sys::window().ok_or("no window")?;
    let resp: Response = JsFuture::from(w.fetch_with_str(HEALTH_PATH)).await.map_err(|_| "network")?.dyn_into().map_err(|_| "response")?;
    let text = JsFuture::from(resp.text().map_err(|_| "body")?).await.map_err(|_| "body")?.as_string().unwrap_or_default();
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

async fn post_topo(req: &TopoReq) -> Result<ActionRes, String> {
    let w = web_sys::window().ok_or("no window")?;
    let init = RequestInit::new();
    init.set_method("POST");
    init.set_body(&JsValue::from_str(&serde_json::to_string(req).map_err(|e| e.to_string())?));
    let headers = web_sys::Headers::new().map_err(|_| "headers")?;
    headers.set("Content-Type", "application/json").map_err(|_| "headers")?;
    init.set_headers(&headers);
    let resp: Response = JsFuture::from(w.fetch_with_str_and_init(TOPO_ACTION_PATH, &init)).await.map_err(|_| "network")?.dyn_into().map_err(|_| "response")?;
    let text = JsFuture::from(resp.text().map_err(|_| "body")?).await.map_err(|_| "body")?.as_string().unwrap_or_default();
    serde_json::from_str(&text).map_err(|_| text.chars().take(120).collect())
}

fn read_now(st: HealthState) {
    leptos::task::spawn_local(async move {
        match get_health().await {
            Ok(h) => {
                let rates = PREV.with(|p| p.borrow().as_ref().map(|prev| rates_between(prev, &h)));
                PREV.with(|p| *p.borrow_mut() = Some(h.clone()));
                if let Some(r) = rates {
                    st.rates.set(r);
                }
                st.failed.set(false);
                st.doc.set(Some(h));
            }
            Err(_) => st.failed.set(true),
        }
    });
}

/// Reads the engine while it exists (mounted only while Health or Topology is shown): at once, then every `poll_*_ms`, skipping a
/// round while the tab is hidden.
#[component]
pub fn Poller(mode: RwSignal<String>) -> impl IntoView {
    let st = expect_context::<HealthState>();
    let topo = expect_context::<Arc<Boot>>().topo.clone();
    let ms = if tier_of(&mode.get_untracked()) == "full" { topo.poll_full_ms } else { topo.poll_lite_ms };
    PREV.with(|p| *p.borrow_mut() = None);
    read_now(st);
    let tick = Closure::<dyn FnMut()>::new(move || {
        if web_sys::window().and_then(|w| w.document()).is_some_and(|d| d.hidden()) {
            return;
        }
        read_now(st);
    });
    let id = web_sys::window().and_then(|w| w.set_interval_with_callback_and_timeout_and_arguments_0(tick.as_ref().unchecked_ref(), ms.max(250) as i32).ok());
    if let Some(id) = id {
        TICKS.with(|t| t.borrow_mut().insert(id, tick));
    }
    on_cleanup(move || {
        if let Some(id) = id {
            if let Some(w) = web_sys::window() {
                w.clear_interval_with_handle(id);
            }
            TICKS.with(|t| t.borrow_mut().remove(&id));
        }
    });
}

fn mb(kb: u64) -> String {
    format!("{} MB", (kb as f64 / 1024.0).round() as u64)
}

fn pct(permille: u64) -> String {
    format!("{:.1}%", permille as f64 / 10.0)
}

fn fill(t: String, pairs: &[(&str, String)]) -> String {
    pairs.iter().fold(t, |t, (k, v)| t.replace(&format!("{{{k}}}"), v))
}

/// "4 ms" / "380 us"; a dash where nothing was measured.
fn lat(us: u64) -> String {
    match us {
        0 => "\u{2014}".into(),
        1..=999 => format!("{us} \u{b5}s"),
        _ => format!("{} ms", us / 1000),
    }
}

/// The level word (`ok`, `warn`, `bad`) of `v` against its soft and hard limits; a limit of 0 is not reported.
fn level(v: u64, soft: u64, hard: u64) -> &'static str {
    if hard > 0 && v >= hard {
        "bad"
    } else if soft > 0 && v >= soft {
        "warn"
    } else {
        "ok"
    }
}

/// The plain-language headline and its level (`ok`, `warn`, `bad`, `down`).
fn headline(h: &Health, t: &TopoCfg) -> (&'static str, String) {
    if !h.engine_ok {
        return ("down", tx("hl_down"));
    }
    let cpu = h.cpu_permille.unwrap_or(0);
    let mem_level = level(h.footprint_kb, h.mem_soft_kb * t.warn_pct / 100, h.mem_hard_kb);
    let cpu_level = level(cpu, h.cpu_soft_permille, h.cpu_hard_permille);
    let mut why: Vec<String> = Vec::new();
    if mem_level == "bad" {
        why.push(fill(tx("hl_why_hard"), &[("mem", mb(h.footprint_kb)), ("hard", mb(h.mem_hard_kb))]));
    } else if mem_level == "warn" {
        why.push(fill(tx("hl_why_mem"), &[("mem", mb(h.footprint_kb)), ("soft", mb(h.mem_soft_kb))]));
    }
    if cpu_level == "bad" {
        why.push(fill(tx("hl_why_cpu_hard"), &[("cpu", pct(cpu)), ("bar", pct(h.cpu_hard_permille))]));
    } else if cpu_level == "warn" {
        why.push(fill(tx("hl_why_cpu"), &[("cpu", pct(cpu)), ("bar", pct(h.cpu_soft_permille))]));
    }
    if h.degraded {
        why.push(if h.degraded_reason.is_empty() { tx("hl_why_degraded") } else { h.degraded_reason.clone() });
    }
    if h.errors > 0 {
        why.push(fill(tx("hl_why_errors"), &[("n", compact(h.errors))]));
    }
    if why.is_empty() {
        let cpu_text = h.cpu_permille.map_or_else(|| "\u{2014}".to_string(), pct);
        return ("ok", fill(tx("hl_ok"), &[("mem", mb(h.footprint_kb)), ("soft", mb(h.mem_soft_kb)), ("cpu", cpu_text)]));
    }
    let key = if mem_level == "bad" || cpu_level == "bad" { "hl_bad" } else { "hl_warn" };
    (if key == "hl_bad" { "bad" } else { "warn" }, fill(tx(key), &[("why", why.join("; "))]))
}

#[component]
fn Headline() -> impl IntoView {
    let st = expect_context::<HealthState>();
    let topo = expect_context::<Arc<Boot>>().topo.clone();
    let topo2 = topo.clone();
    view! {
        <div class=move || st.doc.with(|d| match d { Some(h) => format!("hl hl-{}", headline(h, &topo).0), None => "hl".to_string() }) role="status">
            {move || st.doc.with(|d| match d { Some(h) => headline(h, &topo2).1, None => if st.failed.get() { tx("hl_down") } else { tx("h_waiting") } })}
        </div>
    }
}

/// A bar of `value` against `hard`, with a tick at `soft`.
#[component]
fn Meter(value: u64, soft: u64, hard: u64, text: String, #[prop(optional)] tip: String) -> impl IntoView {
    let scale = hard.max(soft).max(value).max(1) as f64;
    let (fill_w, tick) = (value as f64 / scale * 100.0, soft as f64 / scale * 100.0);
    let lvl = level(value, soft, hard);
    view! {
        <div class=format!("meter m-{lvl}") title=tip>
            <div class="meter-bar"><span class="meter-fill" style=format!("width:{fill_w:.1}%")></span>{(soft > 0).then(|| view! { <span class="meter-tick" style=format!("left:{tick:.1}%")></span> })}</div>
            <div class="meter-text">{text}</div>
        </div>
    }
}

fn tile(label: String, value: String, cls: &'static str) -> impl IntoView {
    view! { <div class="stat"><div class="stat-k">{label}</div><div class=format!("stat-v {cls}")>{value}</div></div> }
}

fn short(id: &str) -> String {
    if id.len() > 10 && id.contains('-') { id.chars().take(8).collect() } else { id.to_string() }
}

fn client_label(id: &str) -> String {
    if id == "unknown" { tx("topo_unknown_client") } else { short(id) }
}

fn fail_pct(failed: u64, calls: u64) -> f64 {
    if calls == 0 { 0.0 } else { failed as f64 * 100.0 / calls as f64 }
}

#[component]
pub fn HealthScreen(active: Signal<bool>) -> impl IntoView {
    view! { <Show when=move || active.get()><HealthBody /></Show> }
}

#[component]
fn HealthBody() -> impl IntoView {
    let st = expect_context::<HealthState>();
    let topo = expect_context::<Arc<Boot>>().topo.clone();
    let body = move || {
        st.doc.get().map(|h| {
            let cpu = h.cpu_permille;
            let tip = fill(tx("h_mem_tip"), &[("rss", mb(h.rss_kb))]);
            let holders = h.holders.clone();
            let mut clients: Vec<ClientRow> = h.clients.clone();
            clients.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.id.cmp(&b.id)));
            clients.truncate(topo.clients_max);
            let load = h.load_per_core.map_or_else(|| tx("h_not_reported"), |l| format!("{l:.2}"));
            let disk = h.disk_free_kb.map_or_else(|| tx("h_not_reported"), |kb| format!("{:.1} GB", kb as f64 / 1_048_576.0));
            let (soft, hard) = (format!("{} {}", tx("h_soft"), pct(h.cpu_soft_permille)), format!("{} {}", tx("h_hard"), pct(h.cpu_hard_permille)));
            let (msoft, mhard) = (format!("{} {}", tx("h_soft"), mb(h.mem_soft_kb)), format!("{} {}", tx("h_hard"), mb(h.mem_hard_kb)));
            view! {
                <div class="h-gauges">
                    <section class="h-card">
                        <div class="sect">{tx("h_cpu")}</div>
                        <Meter value=cpu.unwrap_or(0) soft=h.cpu_soft_permille hard=h.cpu_hard_permille text=format!("{} \u{b7} {soft} \u{b7} {hard}", cpu.map_or_else(|| "\u{2014}".to_string(), pct)) />
                    </section>
                    <section class="h-card">
                        <div class="sect">{tx("h_mem")}</div>
                        <Meter value=h.footprint_kb soft=h.mem_soft_kb hard=h.mem_hard_kb text=format!("{} \u{b7} {msoft} \u{b7} {mhard}", mb(h.footprint_kb)) tip=tip />
                    </section>
                </div>
                <div class="h-tiles">
                    {tile(tx("h_requests"), compact(h.requests), "")}
                    {tile(tx("h_errors"), compact(h.errors), if h.errors > 0 { "t-warn" } else { "" })}
                    {tile(tx("h_slow"), compact(h.slow_replies), if h.slow_replies > 0 { "t-warn" } else { "" })}
                    {tile(tx("h_busy"), compact(h.busy_replies), "")}
                    {tile(tx("h_restarts"), compact(h.restarts), "")}
                    {tile(tx("h_queue"), format!("{} / {}", h.queue_depth, h.workers), "")}
                    {tile(tx("h_degraded"), if h.degraded { tx("h_yes") } else { tx("h_no") }, if h.degraded { "t-bad" } else { "" })}
                    {tile(tx("h_uptime"), fmt_age(h.uptime_s), "")}
                </div>
                <div class="h-cols">
                    <section class="h-card">
                        <div class="sect">{tx("h_holders")}</div>
                        <p class="soft-note">{tx("h_holders_note")}</p>
                        <ul class="holders">
                            {holders.into_iter().map(|x| view! {
                                <li><span class="hname">{x.name.clone()}</span>
                                    <Meter value=x.bytes soft=x.soft hard=x.hard text=format!("{:.1} MB", x.bytes as f64 / 1_048_576.0) /></li>
                            }).collect_view()}
                        </ul>
                    </section>
                    <section class="h-card">
                        <div class="sect">{tx("h_system")}</div>
                        <dl class="kv"><dt>{tx("h_load")}</dt><dd>{load}</dd><dt>{tx("h_disk")}</dt><dd>{disk}</dd></dl>
                    </section>
                </div>
                <section class="h-card">
                    <div class="sect">{tx("h_clients")}</div>
                    <p class="soft-note">{tx("h_clients_note")}</p>
                    {(!h.io_enabled).then(|| view! { <p class="soft-note">{tx("h_io_off")}</p> })}
                    <table class="h-table">
                        <thead><tr><th>{tx("h_col_client")}</th><th>{tx("h_col_calls")}</th><th>{tx("h_col_p50")}</th><th>{tx("h_col_p95")}</th><th>{tx("h_col_timeouts")}</th><th>{tx("h_col_failopen")}</th><th>{tx("h_col_last")}</th></tr></thead>
                        <tbody>
                            {clients.into_iter().map(|c| view! {
                                <tr><td title=c.id.clone()>{client_label(&c.id)}</td><td>{compact(c.calls)}</td><td>{lat(c.p50_us)}</td><td>{lat(c.p95_us)}</td>
                                    <td class={if c.timeouts > 0 { "t-warn" } else { "" }}>{compact(c.timeouts)}</td><td class={if c.fail_open > 0 { "t-warn" } else { "" }}>{compact(c.fail_open)}</td>
                                    <td>{if c.last_ms == 0 { tx("topo_never") } else { since(c.last_ms) }}</td></tr>
                            }).collect_view()}
                        </tbody>
                    </table>
                </section>
            }
        })
    };
    view! {
        <div class="health">
            <div class="main-head"><h1>{tx("hl_title")}</h1><div class="grow"></div></div>
            <Headline />
            {body}
        </div>
    }
}

// ---- Topology ----

const COL_CLIENT: f32 = 0.0;
const COL_ENGINE: f32 = 1.0;
const COL_PART: f32 = 2.0;
const COL_STORE: f32 = 3.0;

fn node(id: String, label: String, sub: String, kind: &str, status: &str, col: f32, row: f32, gap: (f32, f32)) -> NodeDef {
    NodeDef { id, label, sub, kind: kind.into(), status: status.into(), x: Some(col * gap.0), y: Some(row * gap.1), ports_in: vec![], ports_out: vec![] }
}

fn edge(from: &str, to: &str, rate: f32) -> EdgeDef {
    EdgeDef { id: format!("{from}>{to}"), from: from.into(), from_port: String::new(), to: to.into(), to_port: String::new(), label: String::new(), rate }
}

/// A store's or client's status word: failed, waiting (amber), running (calls lately) or idle.
fn health_status(failed: u64, calls: u64, last_ms: u64, t: &TopoCfg) -> &'static str {
    let share = fail_pct(failed, calls);
    if share >= t.bad_fail_pct {
        "failed"
    } else if share >= t.warn_fail_pct {
        "waiting"
    } else if last_ms > 0 && now_ms().saturating_sub(last_ms) / 1000 <= t.idle_s {
        "running"
    } else {
        "idle"
    }
}

fn worst(a: &'static str, b: &'static str) -> &'static str {
    let rank = |s: &str| match s { "failed" => 3, "waiting" => 2, "running" => 1, _ => 0 };
    if rank(b) > rank(a) { b } else { a }
}

fn rate_text(r: f32) -> String {
    fill(tx("topo_calls"), &[("rate", if r >= 10.0 { format!("{r:.0}") } else { format!("{r:.1}") })])
}

/// The graph for one reading: clients, the engine, its parts, their stores; rows are centred on the tallest column so a node keeps its
/// place between readings.
fn topo_graph(h: &Health, rates: &Rates, t: &TopoCfg, gap: (f32, f32)) -> GraphData {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut clients: Vec<&ClientRow> = h.clients.iter().collect();
    clients.sort_by(|a, b| b.calls.cmp(&a.calls).then_with(|| a.id.cmp(&b.id)));
    clients.truncate(t.clients_max);
    let by_store: HashMap<&str, &StoreRow> = h.stores.iter().map(|s| (s.id.as_str(), s)).collect();
    let grouped: std::collections::HashSet<&str> = t.subsystems.iter().flat_map(|s| s.stores.iter().map(String::as_str)).collect();
    let loose: Vec<&StoreRow> = h.stores.iter().filter(|s| !grouped.contains(s.id.as_str())).collect();
    let parts: Vec<_> = t.subsystems.iter().map(|p| (p, p.stores.iter().filter_map(|id| by_store.get(id.as_str()).copied()).collect::<Vec<_>>())).filter(|(_, v)| !v.is_empty()).collect();
    let stores_total: usize = parts.iter().map(|(_, v)| v.len()).sum::<usize>() + loose.len();
    let tallest = clients.len().max(parts.len()).max(stores_total).max(1) as f32;
    let centre = |count: usize, i: usize| (tallest - count as f32) / 2.0 + i as f32;
    let engine_status = if !h.engine_ok || h.degraded || level(h.footprint_kb, h.mem_hard_kb, h.mem_hard_kb) == "bad" { "failed" } else if level(h.footprint_kb, h.mem_soft_kb, 0) == "warn" || level(h.cpu_permille.unwrap_or(0), h.cpu_soft_permille, 0) == "warn" { "waiting" } else { "ok" };
    let engine_sub = format!("{} \u{b7} {}", rate_text(rates.requests), tx("topo_engine_sub"));
    nodes.push(node("e:engine".into(), tx("topo_engine"), engine_sub, "engine", engine_status, COL_ENGINE, (tallest - 1.0) / 2.0, gap));
    for (i, c) in clients.iter().enumerate() {
        let r = rates.clients.get(&c.id).copied().unwrap_or(0.0);
        let status = health_status(c.timeouts + c.fail_open, c.calls, c.last_ms, t);
        let sub = format!("{} \u{b7} p95 {}", if r > 0.0 { rate_text(r) } else { tx("topo_idle") }, lat(c.p95_us));
        nodes.push(node(format!("c:{}", c.id), client_label(&c.id), sub, "client", status, COL_CLIENT, centre(clients.len(), i), gap));
        edges.push(edge(&format!("c:{}", c.id), "e:engine", r));
    }
    let mut row = 0usize;
    let store_node = |s: &StoreRow, row: usize| {
        let r = rates.stores.get(&s.id).copied().unwrap_or(0.0);
        let status = health_status(s.errors, s.reads + s.writes, s.last_ms, t);
        let kind = if t.databases.contains(&s.id) { "service" } else { "store" };
        let sub = format!("{} \u{b7} p95 {}", if r > 0.0 { rate_text(r) } else { tx("topo_idle") }, lat(s.p95_us));
        (node(format!("f:{}", s.id), s.id.clone(), sub, kind, status, COL_STORE, centre(stores_total, row), gap), status, r)
    };
    for (pi, (p, members)) in parts.iter().enumerate() {
        let pid = format!("s:{}", p.id);
        let (mut status, mut total) = ("idle", 0.0f32);
        for s in members {
            let (n, st, r) = store_node(s, row);
            row += 1;
            status = worst(status, st);
            total += r;
            edges.push(edge(&pid, &n.id, r));
            nodes.push(n);
        }
        nodes.push(node(pid.clone(), p.label.clone(), if total > 0.0 { rate_text(total) } else { tx("topo_idle") }, "service", status, COL_PART, centre(parts.len(), pi), gap));
        edges.push(edge("e:engine", &pid, total));
    }
    for s in loose {
        let (n, _, r) = store_node(s, row);
        row += 1;
        edges.push(edge("e:engine", &n.id, r));
        nodes.push(n);
    }
    GraphData { nodes, edges }
}

/// The node kind (`client`, `engine`, `subsystem`, `store`) and its id inside it.
fn split_node(id: &str) -> (&'static str, &str) {
    match id.split_once(':') {
        Some(("c", r)) => ("client", r),
        Some(("e", r)) => ("engine", r),
        Some(("s", r)) => ("subsystem", r),
        Some(("f", r)) => ("store", r),
        _ => ("", id),
    }
}

fn menu_for(kind: &str, id: &str, t: &TopoCfg) -> Vec<TopoActionDef> {
    t.actions.iter().filter(|a| a.kind == kind && (!a.needs_viewer || t.viewers.iter().any(|v| v == id))).cloned().collect()
}

#[component]
pub fn TopologyScreen(mode: RwSignal<String>, active: Signal<bool>) -> impl IntoView {
    view! { <Show when=move || active.get()><TopologyBody mode=mode /></Show> }
}

#[component]
fn TopologyBody(mode: RwSignal<String>) -> impl IntoView {
    let st = expect_context::<HealthState>();
    let boot = expect_context::<Arc<Boot>>();
    let Some(cfg) = serde_json::from_str::<GraphConfig>(&boot.graph).ok().map(Arc::new) else { return view! { <p class="empty">{tx("live_no_config")}</p> }.into_any() };
    let topo = boot.topo.clone();
    let gap = (boot.live.col_gap, boot.live.row_gap);
    let data = RwSignal::new(GraphData::default());
    {
        let topo = topo.clone();
        Effect::new(move |_| {
            let (doc, rates) = (st.doc.get(), st.rates.get());
            if let Some(h) = doc {
                data.set(topo_graph(&h, &rates, &topo, gap));
            }
        });
    }
    let selected = RwSignal::new(None::<String>);
    let t1 = topo.clone();
    let actions = Callback::new(move |id: String| -> Vec<ActionDef> {
        let (kind, inner) = split_node(&id);
        menu_for(kind, inner, &t1).into_iter().map(|a| ActionDef { id: a.name.clone(), label: tx(&a.label), destructive: a.confirm, enabled: true, note: String::new() }).collect()
    });
    let t2 = topo.clone();
    let on_action = Callback::new(move |c: ActionCall| {
        let (kind, inner) = split_node(&c.node);
        let (inner, done) = (inner.to_string(), c.done);
        let Some(def) = menu_for(kind, &inner, &t2).into_iter().find(|a| a.name == c.action) else {
            done.run(false);
            return;
        };
        selected.set(Some(c.node.clone()));
        if def.local {
            done.run(true);
            return;
        }
        let (node, label, req) = (c.node.clone(), tx(&def.label), TopoReq { kind: kind.into(), id: inner, action: def.name.clone(), confirmed: true });
        leptos::task::spawn_local(async move {
            let (ok, text) = match post_topo(&req).await {
                Ok(r) => (r.ok, r.message),
                Err(e) => (false, e),
            };
            st.out.set(Some((node, label, text)));
            done.run(ok);
        });
    });
    let panel = Callback::new(move |id: String| view! { <NodePanel id=id /> }.into_any());
    let tier = if tier_of(&mode.get_untracked()) == "full" { Tier::Full } else { Tier::Lite };
    view! {
        <div class="health topo">
            <div class="main-head"><h1>{tx("topo_title")}</h1><span class="counts">{tx("topo_hint")}</span><div class="grow"></div></div>
            <Headline />
            <div class="live-graph topo-graph">
                <Graph data=data.into() cfg=cfg tier=tier mode=LayoutMode::Layered actions=actions on_action=on_action selected=selected panel=panel />
            </div>
            <p class="soft-note">{tx("topo_grouping_note")}</p>
        </div>
    }
    .into_any()
}

/// The figures of one node, and the output of the last action run on it.
#[component]
fn NodePanel(id: String) -> impl IntoView {
    let st = expect_context::<HealthState>();
    let (kind, inner) = split_node(&id);
    let inner = inner.to_string();
    let id2 = id.clone();
    let rows = move || -> Vec<(String, String)> {
        let Some(h) = st.doc.get() else { return Vec::new() };
        let rates = st.rates.get();
        match kind {
            "client" => h.clients.iter().find(|c| c.id == inner).map(|c| {
                vec![
                    (tx("topo_kind_client"), c.id.clone()),
                    (tx("h_col_calls"), format!("{} ({})", compact(c.calls), rate_text(rates.clients.get(&c.id).copied().unwrap_or(0.0)))),
                    (tx("h_col_p50"), lat(c.p50_us)),
                    (tx("h_col_p95"), lat(c.p95_us)),
                    (tx("h_col_timeouts"), compact(c.timeouts)),
                    (tx("h_col_failopen"), compact(c.fail_open)),
                    (tx("topo_last"), if c.last_ms == 0 { tx("topo_never") } else { since(c.last_ms) }),
                ]
            }),
            "store" => h.stores.iter().find(|s| s.id == inner).map(|s| {
                vec![
                    (tx("h_col_store"), s.id.clone()),
                    (tx("h_col_reads"), compact(s.reads)),
                    (tx("h_col_writes"), compact(s.writes)),
                    (tx("topo_bytes_in"), compact(s.bytes_in)),
                    (tx("topo_bytes_out"), compact(s.bytes_out)),
                    (tx("h_col_errors"), compact(s.errors)),
                    (tx("topo_failed_share"), format!("{:.2}%", fail_pct(s.errors, s.reads + s.writes))),
                    (tx("topo_last"), if s.last_ms == 0 { tx("topo_never") } else { since(s.last_ms) }),
                ]
            }),
            "engine" => Some(vec![
                (tx("topo_kind_engine"), format!("{} \u{b7} pid {}", h.version, h.pid)),
                (tx("h_mem"), mb(h.footprint_kb)),
                (tx("h_cpu"), h.cpu_permille.map_or_else(|| "\u{2014}".into(), pct)),
                (tx("h_requests"), format!("{} ({})", compact(h.requests), rate_text(rates.requests))),
                (tx("h_errors"), compact(h.errors)),
                (tx("h_uptime"), fmt_age(h.uptime_s)),
            ]),
            "subsystem" => {
                let t = expect_context::<Arc<Boot>>().topo.clone();
                t.subsystems.iter().find(|s| s.id == inner).map(|p| {
                    p.stores.iter().filter_map(|sid| h.stores.iter().find(|s| s.id == *sid)).map(|s| (s.id.clone(), format!("{} \u{b7} {} {}", rate_text(rates.stores.get(&s.id).copied().unwrap_or(0.0)), compact(s.reads + s.writes), tx("topo_ops")))).collect()
                })
            }
            _ => None,
        }
        .unwrap_or_default()
    };
    view! {
        <div class="topo-panel">
            <dl class="kv">{move || rows().into_iter().map(|(k, v)| view! { <dt>{k}</dt><dd>{v}</dd> }).collect_view()}</dl>
            {move || st.out.get().filter(|(n, _, _)| *n == id2).map(|(_, label, text)| view! { <div class="sect">{tx("topo_out_title")}" \u{b7} "{label}</div><pre class="topo-out">{text}</pre> })}
        </div>
    }
}
