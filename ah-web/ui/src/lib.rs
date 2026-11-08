//! The Command Center page. Client-side rendered; every label comes from the boot data the server injects from the plugin's
//! `web.toml`, so this file carries no text of its own. Slice 2: the header (engine vitals, tier switch), the live agent tree
//! with its action menu, the selected-agent panel with details and the activity feed; the graph is a styled placeholder.
//! Data arrives as one snapshot and then only changes (server-sent events); the tier (full or lite) picks the push rate and
//! whether anything moves.
mod health;
mod live;
mod load;
mod manage;
mod ops;
mod route;
mod tel;
#[cfg(feature = "full")]
mod apex;
use ah_web_proto::{ActionReq, ActionRes, Agent, Boot, Delta, Detail, FeedItem, Pulse, PulseLimits, Snapshot, ACTION_PATH, BOOT_ELEMENT_ID, DELTA_EVENT, DETAIL_PATH, SNAPSHOT_EVENT, STREAM_PATH};
use leptos::mount::mount_to_body;
use leptos::prelude::*;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{EventSource, MessageEvent, RequestInit, Response};

/// Connection state of the event stream.
#[derive(Clone, Copy, PartialEq)]
enum Conn {
    Connecting,
    Live,
    Reconnecting,
}

/// Library entry: mount the app (called by the generated loader).
#[wasm_bindgen(start)]
pub fn start() {
    let boot = read_boot();
    mount_to_body(move || view! { <App boot=boot.clone() /> });
}

fn read_boot() -> Boot {
    web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.get_element_by_id(BOOT_ELEMENT_ID))
        .and_then(|e| e.text_content())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// The label for `key` from the boot data; a missing key shows the key itself, so a gap in `web.toml` is visible.
fn tx(key: &str) -> String {
    expect_context::<Arc<Boot>>().ui.get(key).cloned().unwrap_or_else(|| key.to_string())
}

fn fmt_age(s: u64) -> String {
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}m {:02}s", s / 60, s % 60)
    } else {
        format!("{}h {:02}m", s / 3600, (s % 3600) / 60)
    }
}

fn hb_class(boot: &Boot, a: &Agent) -> &'static str {
    match a.last_output_s {
        None => "hb-none",
        Some(s) if s >= boot.heartbeat_stale_s => "hb-stale",
        Some(s) if s >= boot.heartbeat_warn_s => "hb-warn",
        Some(_) => "hb-ok",
    }
}

fn role_class(a: &Agent) -> &'static str {
    // a finished turn with only a shell still running is idle, not working
    let live = a.state == "running" && !a.idle_shell;
    match (a.kind.as_str(), live) {
        (_, false) => "k-idle",
        ("main", _) => "k-primary",
        ("workspace", _) => "k-ws",
        ("codex", _) => "k-codex",
        _ => "k-sub",
    }
}

fn kind_label(a: &Agent) -> String {
    let key = format!("kind_{}", a.kind);
    let boot = expect_context::<Arc<Boot>>();
    boot.ui.get(&key).or_else(|| boot.ui.get("kind_other")).cloned().unwrap_or(key)
}

/// One line of the agents tree: a project heading or an agent, how deep it sits and whether something is nested under it.
#[derive(Clone, PartialEq)]
struct TreeRow {
    /// `p:<project root>` for a heading, `a:<agent id>`: also what the person's fold choice is kept under.
    key: String,
    depth: usize,
    /// The agent shown; `None` for a project heading.
    agent: Option<String>,
    /// The heading's name and how many agents it holds (live, all).
    project: Option<(String, usize, usize)>,
    kids: bool,
    /// The tree guides in front of the name, one per level below the top agent (see `Guides`).
    guides: Vec<u8>,
    /// " #2" ... for an agent whose siblings carry the same name and kind.
    suffix: String,
}

/// The tree: projects, each with its agents nested by parent (Primary, then its workspaces, then what they started). Every agent is
/// under exactly one project; a parent that is in another project (or missing) makes the agent a top row of its own project. What the
/// person folded (`collapsed`) hides everything beneath it.
fn flatten(kind_order: &[String], agents: &[Agent], collapsed: &HashSet<String>) -> Vec<TreeRow> {
    let rank = |a: &Agent| kind_order.iter().position(|k| *k == a.kind).unwrap_or(usize::MAX);
    let mut groups: BTreeMap<&str, Vec<&Agent>> = BTreeMap::new();
    for a in agents {
        groups.entry(a.project_root.as_str()).or_default().push(a);
    }
    // an empty root (no folder reported) goes last
    let mut order: Vec<(&str, Vec<&Agent>)> = groups.into_iter().collect();
    order.sort_by(|x, y| x.0.is_empty().cmp(&y.0.is_empty()).then_with(|| x.1[0].project_name.to_lowercase().cmp(&y.1[0].project_name.to_lowercase())).then_with(|| x.0.cmp(y.0)));
    let mut out = Vec::with_capacity(agents.len() + order.len());
    for (root, members) in order {
        let ids: BTreeSet<&str> = members.iter().map(|a| a.id.as_str()).collect();
        let mut kids: BTreeMap<&str, Vec<&Agent>> = BTreeMap::new();
        let mut roots: Vec<&Agent> = Vec::new();
        for a in &members {
            if a.parent.is_empty() || a.parent == a.id || !ids.contains(a.parent.as_str()) {
                roots.push(a);
            } else {
                kids.entry(a.parent.as_str()).or_default().push(a);
            }
        }
        let nkids = |a: &Agent| kids.get(a.id.as_str()).map_or(0, Vec::len);
        let sort = |v: &mut Vec<&Agent>| v.sort_by(|x, y| rank(x).cmp(&rank(y)).then_with(|| nkids(y).cmp(&nkids(x))).then_with(|| x.label.cmp(&y.label)).then_with(|| x.id.cmp(&y.id)));
        sort(&mut roots);
        for v in kids.values_mut() {
            v.sort_by(|x, y| rank(x).cmp(&rank(y)).then_with(|| x.label.cmp(&y.label)).then_with(|| x.id.cmp(&y.id)));
        }
        let live = members.iter().filter(|a| !a.placeholder && a.state == "running" && !a.idle_shell).count();
        let key = format!("p:{root}");
        let open = !collapsed.contains(&key);
        out.push(TreeRow { key, depth: 0, agent: None, project: Some((members[0].project_name.clone(), live, members.iter().filter(|a| !a.placeholder).count())), kids: !members.is_empty(), guides: Vec::new(), suffix: String::new() });
        if !open {
            continue;
        }
        let mut seen = BTreeSet::new();
        // siblings that share a name and a kind are told apart by a number
        let suffixes = |v: &[&Agent]| -> Vec<String> {
            let mut count: HashMap<(&str, &str), usize> = HashMap::new();
            v.iter().for_each(|a| *count.entry((a.label.as_str(), a.kind.as_str())).or_default() += 1);
            let mut n: HashMap<(&str, &str), usize> = HashMap::new();
            v.iter()
                .map(|a| {
                    let k = (a.label.as_str(), a.kind.as_str());
                    let i = n.entry(k).or_default();
                    *i += 1;
                    if count[&k] > 1 { format!(" #{i}") } else { String::new() }
                })
                .collect()
        };
        let mut stack: Vec<(&Agent, usize, String, Vec<u8>, Vec<u8>)> = roots.iter().zip(suffixes(&roots)).map(|(a, s)| (*a, 1usize, s, Vec::new(), Vec::new())).rev().collect();
        while let Some((a, d, suffix, guides, carry)) = stack.pop() {
            if !seen.insert(a.id.as_str()) {
                continue; // a parent cycle in the data must not loop
            }
            let children = kids.get(a.id.as_str()).cloned().unwrap_or_default();
            let akey = format!("a:{}", a.id);
            let open = !collapsed.contains(&akey);
            out.push(TreeRow { key: akey, depth: d, agent: Some(a.id.clone()), project: None, kids: !children.is_empty(), guides, suffix });
            if open {
                let sfx = suffixes(&children);
                let n = children.len();
                stack.extend(children.iter().zip(sfx).enumerate().map(|(i, (k, s))| {
                    let last = i + 1 == n;
                    (*k, d + 1, s, [carry.clone(), vec![if last { 3u8 } else { 2 }]].concat(), [carry.clone(), vec![if last { 0u8 } else { 1 }]].concat())
                }).rev());
            }
        }
    }
    out
}

/// What the person last did with an action: the agent, the action name and how it went.
#[derive(Clone, PartialEq)]
struct Feedback {
    id: String,
    action: String,
    phase: Phase,
    message: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Running,
    Done,
    Failed,
}

/// The signals every part of the page shares.
#[derive(Clone, Copy)]
struct Ctx {
    snap: RwSignal<Snapshot>,
    conn: RwSignal<Conn>,
    selected: RwSignal<Option<String>>,
    feedback: RwSignal<Option<Feedback>>,
    /// An action waiting for the person's yes: (agent id, action name).
    confirm: RwSignal<Option<(String, String)>>,
    /// The agent whose details are open and what the tracker said (None while loading).
    detail: RwSignal<Option<(String, Option<Detail>)>>,
}

/// Fold a delta into the snapshot. The server merges everything the stream missed into one delta, so a higher sequence is complete.
fn apply(s: &mut Snapshot, d: Delta, feed_max: usize) {
    if d.seq <= s.seq {
        return;
    }
    s.seq = d.seq;
    if let Some(ok) = d.engine_ok {
        s.engine_ok = ok;
    }
    if let Some(g) = d.generated_ms {
        s.generated_ms = g;
    }
    if d.pulse.is_some() {
        s.pulse = d.pulse;
    }
    if !d.removed.is_empty() {
        s.agents.retain(|a| !d.removed.contains(&a.id));
    }
    for a in d.upsert {
        match s.agents.iter_mut().find(|x| x.id == a.id) {
            Some(x) => *x = a,
            None => s.agents.push(a),
        }
    }
    s.feed.extend(d.feed);
    let over = s.feed.len().saturating_sub(feed_max);
    s.feed.drain(..over);
}

/// Open the event stream for `tier` (`full` or `lite`) and keep `snap` current; the previous stream, if any, is closed first.
fn connect(ctx: Ctx, tier: &str, feed_max: usize, current: StoredValue<Option<EventSource>, LocalStorage>) {
    if let Some(old) = current.get_value() {
        old.close();
    }
    ctx.conn.set(Conn::Connecting);
    let Ok(es) = EventSource::new(&format!("{STREAM_PATH}?mode={tier}")) else { return };
    let on_snapshot = Closure::<dyn FnMut(MessageEvent)>::new(move |e: MessageEvent| {
        if let Some(s) = e.data().as_string().and_then(|t| serde_json::from_str::<Snapshot>(&t).ok()) {
            live::on_snapshot(&s);
            ctx.snap.set(s);
            ctx.conn.set(Conn::Live);
        }
    });
    let _ = es.add_event_listener_with_callback(SNAPSHOT_EVENT, on_snapshot.as_ref().unchecked_ref());
    on_snapshot.forget();
    let on_delta = Closure::<dyn FnMut(MessageEvent)>::new(move |e: MessageEvent| {
        if let Some(d) = e.data().as_string().and_then(|t| serde_json::from_str::<Delta>(&t).ok()) {
            live::on_delta(&d);
            ctx.snap.update(|s| apply(s, d, feed_max));
            ctx.conn.set(Conn::Live);
        }
    });
    let _ = es.add_event_listener_with_callback(DELTA_EVENT, on_delta.as_ref().unchecked_ref());
    on_delta.forget();
    let on_error = Closure::<dyn FnMut()>::new(move || ctx.conn.set(Conn::Reconnecting));
    es.set_onerror(Some(on_error.as_ref().unchecked_ref()));
    on_error.forget();
    current.set_value(Some(es));
}

fn set_theme(dark: bool) {
    if let Some(root) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.document_element()) {
        let _ = root.set_attribute("data-theme", if dark { "dark" } else { "light" });
    }
    if let Some(st) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) {
        let _ = st.set_item("ah-theme", if dark { "dark" } else { "light" });
    }
}

fn stored_dark() -> Option<bool> {
    let st = web_sys::window()?.local_storage().ok().flatten()?;
    match st.get_item("ah-theme").ok().flatten().as_deref() {
        Some("dark") => Some(true),
        Some("light") => Some(false),
        _ => None,
    }
}

fn stored_mode() -> Option<String> {
    let st = web_sys::window()?.local_storage().ok().flatten()?;
    st.get_item("ah-mode").ok().flatten().filter(|m| ["auto", "full", "lite"].contains(&m.as_str()))
}

fn store_mode(mode: &str) {
    if let Some(st) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) {
        let _ = st.set_item("ah-mode", mode);
    }
}

/// The tier a mode setting means now: `auto` is lite when the browser asks for reduced motion, else full.
fn tier_of(mode: &str) -> &'static str {
    match mode {
        "lite" => "lite",
        "full" => "full",
        _ => {
            let reduced = web_sys::window().and_then(|w| w.match_media("(prefers-reduced-motion: reduce)").ok().flatten()).is_some_and(|m| m.matches());
            if reduced { "lite" } else { "full" }
        }
    }
}

/// This build is the Full or the Lite page; a choice that needs the other one reloads the page, and the loader picks the right build.
fn reload_if_other_build(mode: &str) {
    if (tier_of(mode) == "full") != cfg!(feature = "full") {
        if let Some(w) = web_sys::window() {
            let _ = w.location().reload();
        }
    }
}

fn set_tier_attr(tier: &str) {
    if let Some(root) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.document_element()) {
        let _ = root.set_attribute("data-mode", tier);
    }
}

/// Milliseconds since the epoch, from the browser's clock.
fn now_ms() -> u64 {
    web_sys::window().and_then(|w| w.performance()).map_or(0, |p| (p.time_origin() + p.now()) as u64)
}

/// "12s", "3m" ... since `ts_ms`, followed by the "ago" label.
fn since(ts_ms: u64) -> String {
    let s = now_ms().saturating_sub(ts_ms) / 1000;
    if s < 5 {
        return tx("just_now");
    }
    let age = if s < 60 { format!("{s}s") } else if s < 3600 { format!("{}m", s / 60) } else { format!("{}h", s / 3600) };
    format!("{age} {}", tx("ago"))
}

/// The pill colour class for `v` against its warn and bad limits.
fn level(v: u64, warn: u64, bad: u64) -> &'static str {
    if v >= bad {
        "pill pill-bad"
    } else if v >= warn {
        "pill pill-warn"
    } else {
        "pill pill-ok"
    }
}

fn compact(n: u64) -> String {
    expect_context::<Arc<Boot>>().number.fmt(n)
}

/// POST `req` to the server and read its answer.
async fn post_action(req: &ActionReq) -> Result<ActionRes, String> {
    let window = web_sys::window().ok_or("no window")?;
    let init = RequestInit::new();
    init.set_method("POST");
    init.set_body(&JsValue::from_str(&serde_json::to_string(req).map_err(|e| e.to_string())?));
    let headers = web_sys::Headers::new().map_err(|_| "headers")?;
    headers.set("Content-Type", "application/json").map_err(|_| "headers")?;
    init.set_headers(&headers);
    let resp = JsFuture::from(window.fetch_with_str_and_init(ACTION_PATH, &init)).await.map_err(|_| "network")?;
    let resp: Response = resp.dyn_into().map_err(|_| "response")?;
    let text = JsFuture::from(resp.text().map_err(|_| "body")?).await.map_err(|_| "body")?.as_string().unwrap_or_default();
    serde_json::from_str(&text).map_err(|_| text.chars().take(120).collect())
}

async fn get_detail(id: &str) -> Result<Detail, String> {
    let window = web_sys::window().ok_or("no window")?;
    let resp = JsFuture::from(window.fetch_with_str(&format!("{DETAIL_PATH}{id}"))).await.map_err(|_| "network")?;
    let resp: Response = resp.dyn_into().map_err(|_| "response")?;
    let text = JsFuture::from(resp.text().map_err(|_| "body")?).await.map_err(|_| "body")?.as_string().unwrap_or_default();
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn open_detail(ctx: Ctx, id: String) {
    ctx.selected.set(Some(id.clone()));
    ctx.detail.set(Some((id.clone(), None)));
    leptos::task::spawn_local(async move {
        let d = get_detail(&id).await.unwrap_or_default();
        ctx.detail.set(Some((id, Some(d))));
    });
}

/// Run `action` on `id` now and show how it went next to the menu.
fn run_action(ctx: Ctx, id: String, action: String, confirmed: bool) {
    ctx.feedback.set(Some(Feedback { id: id.clone(), action: action.clone(), phase: Phase::Running, message: String::new() }));
    leptos::task::spawn_local(async move {
        let req = ActionReq { id: id.clone(), action: action.clone(), confirmed };
        let (phase, message) = match post_action(&req).await {
            Ok(r) if r.ok => (Phase::Done, r.message),
            Ok(r) => (Phase::Failed, r.message),
            Err(e) => (Phase::Failed, e),
        };
        ctx.feedback.set(Some(Feedback { id, action, phase, message }));
    });
}

/// The click on a menu entry: details open locally, an action that asks first opens the confirmation, the rest run.
fn choose(ctx: Ctx, boot: &Boot, id: String, action: &str) {
    let Some(def) = boot.actions.iter().find(|a| a.name == action) else { return };
    if def.local {
        open_detail(ctx, id);
    } else if def.confirm {
        ctx.confirm.set(Some((id, action.to_string())));
    } else {
        run_action(ctx, id, action.to_string(), false);
    }
}

#[component]
fn App(boot: Boot) -> impl IntoView {
    live::init(&boot);
    let boot = Arc::new(boot);
    provide_context(boot.clone());
    let ctx = Ctx {
        snap: RwSignal::new(Snapshot::default()),
        conn: RwSignal::new(Conn::Connecting),
        selected: RwSignal::new(None),
        feedback: RwSignal::new(None),
        confirm: RwSignal::new(None),
        detail: RwSignal::new(None),
    };
    provide_context(ctx);
    provide_context(health::HealthState::new());
    let snap = ctx.snap;
    let conn = ctx.conn;
    let selected = ctx.selected;
    let graph = RwSignal::new(false);
    let live_on = RwSignal::new(false);
    let health_on = RwSignal::new(false);
    let topo_on = RwSignal::new(false);
    let manage_on = RwSignal::new(false);
    // 0 = no ops screen, 1 accounts, 2 updates, 3 logs, 4 telemetry, 5 impact (the last two are the tabs of Reports)
    let ops_screen = RwSignal::new(0u8);
    // the agents view is shown unless another screen is chosen
    let other_on = Memo::new(move |_| live_on.get() || health_on.get() || topo_on.get() || manage_on.get() || ops_screen.get() != 0);
    let go = move |live: bool, health: bool, topo: bool, manage: bool, ops: u8| {
        live_on.set(live);
        health_on.set(health);
        topo_on.set(topo);
        manage_on.set(manage);
        ops_screen.set(ops);
    };
    // which view is open, by the id `web.screens` gives it
    let go_id = move |id: &str| match id {
        "live" => go(true, false, false, false, 0),
        "health" => go(false, true, false, false, 0),
        "settings" => go(false, false, false, true, 0),
        "accounts" => go(false, false, false, false, 1),
        "updates" => go(false, false, false, false, 2),
        "logs" => go(false, false, false, false, 3),
        "reports" => go(false, false, false, false, if ops_screen.get_untracked() == 5 { 5 } else { 4 }),
        _ => go(false, false, false, false, 0),
    };
    let screen_now = move || {
        if live_on.get() {
            "live"
        } else if health_on.get() || topo_on.get() {
            "health"
        } else if manage_on.get() {
            "settings"
        } else {
            match ops_screen.get() {
                1 => "accounts",
                2 => "updates",
                3 => "logs",
                4 | 5 => "reports",
                _ => "agents",
            }
        }
    };
    // the view is part of the address: a reload, a pasted link and back/forward land on the same one; a view that is switched off lands home
    let bnav = boot.clone();
    let apply_route = move |r: route::Route| {
        // links made before Telemetry and Impact became tabs of Reports, and before Topology became a toggle of Health
        match r.screen.as_str() {
            "telemetry" if bnav.screen_on("reports") => go(false, false, false, false, 4),
            "impact" if bnav.screen_on("reports") => go(false, false, false, false, 5),
            "topology" if bnav.screen_on("health") && bnav.switch("topology_toggle") => go(false, false, true, false, 0),
            other => go_id(&bnav.resolve_screen(other)),
        }
    };
    apply_route(route::current());
    route::on_change(apply_route);
    Effect::new(move |_| route::enter(screen_now(), manage_on.get()));
    let dark = RwSignal::new(stored_dark().unwrap_or(true));
    if let Some(d) = stored_dark() {
        set_theme(d);
    }
    // the tier: the person's choice (kept in the browser), else the configured start; the stream follows it live
    let mode = RwSignal::new(stored_mode().unwrap_or_else(|| boot.mode.clone()));
    let stream: StoredValue<Option<EventSource>, LocalStorage> = StoredValue::new_local(None);
    let feed_max = boot.feed_max;
    Effect::new(move |_| {
        let tier = tier_of(&mode.get());
        set_tier_attr(tier);
        connect(ctx, tier, feed_max, stream);
    });

    let by_id = Memo::new(move |_| snap.with(|s| s.agents.iter().map(|a| (a.id.clone(), a.clone())).collect::<HashMap<_, _>>()));
    let b2 = boot.clone();
    let collapsed = RwSignal::new(HashSet::<String>::new());
    let rows = Memo::new(move |_| snap.with(|s| collapsed.with(|c| flatten(&b2.kind_order, &s.agents, c))));
    let counts = Memo::new(move |_| {
        snap.with(|s| {
            let real: Vec<&Agent> = s.agents.iter().filter(|a| !a.placeholder).collect();
            let live = real.iter().filter(|a| a.state == "running" && !a.idle_shell).count();
            let idle = real.len() - live;
            let projects = real.iter().map(|a| a.project_root.as_str()).collect::<BTreeSet<_>>().len();
            let codex = real.iter().filter(|a| a.kind == "codex").count();
            (live, idle, projects, real.len() - codex, codex)
        })
    });
    let current = Memo::new(move |_| {
        let id = selected.get().or_else(|| rows.with(|r| r.iter().find_map(|x| x.agent.clone())));
        id.and_then(|i| by_id.with(|m| m.get(&i).cloned()))
    });
    let lim = boot.limits.clone();
    let pill = move |pick: fn(&Pulse) -> u64, warn: u64, bad: u64, label: &'static str, fmt: fn(u64) -> String, tip: fn(&Pulse) -> String| {
        view! {
            <span title=move || snap.with(|s| s.pulse.as_ref().map(tip).unwrap_or_default()) class=move || snap.with(|s| s.pulse.as_ref().map_or("pill", |p| level(pick(p), warn, bad)))>
                <span class="pill-k">{tx(label)}</span> " " <span class="pill-v">{move || snap.with(|s| s.pulse.as_ref().map_or_else(|| "\u{2014}".to_string(), |p| fmt(pick(p))))}</span>
            </span>
        }
        .into_any()
    };
    let PulseLimits { cpu_warn_permille, cpu_bad_permille, mem_warn_mb, mem_bad_mb, err_warn, err_bad } = lim;
    let mut strip: HashMap<&str, AnyView> = HashMap::new();
    strip.insert("cpu", pill(|p| p.cpu_permille.unwrap_or(0), cpu_warn_permille, cpu_bad_permille, "pill_cpu", |v| format!("{:.1}%", v as f64 / 10.0), |_| String::new()));
    // the memory pill shows the footprint (the figure the engine's budget is measured on); RSS only where the engine reports no footprint
    strip.insert(
        "mem",
        pill(
            |p| p.footprint_kb.unwrap_or(p.rss_kb) / 1024,
            mem_warn_mb,
            mem_bad_mb,
            "pill_mem",
            |v| format!("{v} MB"),
            |p| match p.footprint_kb {
                Some(fp) => tx("pill_mem_tip").replace("{fp}", &format!("{} MB", fp / 1024)).replace("{rss}", &format!("{} MB", p.rss_kb / 1024)),
                None => tx("pill_mem_rss_only").replace("{rss}", &format!("{} MB", p.rss_kb / 1024)),
            },
        ),
    );
    strip.insert("req", pill(|p| p.requests, u64::MAX, u64::MAX, "pill_req", compact, |_| String::new()));
    strip.insert("err", pill(|p| p.errors, err_warn, err_bad, "pill_err", compact, |_| String::new()));
    let pills: Vec<AnyView> = boot.strip_pills.iter().filter_map(|id| strip.remove(id.as_str())).collect();
    let b3 = boot.clone();
    let bnav2 = boot.clone();
    let btop = boot.clone();
    let bmain = boot.clone();
    let bside = boot.clone();
    let hb_tip = hb_tip(&boot);
    let blocks_only = RwSignal::new(false);

    view! {
        <div class="shell">
            <header class="top">
                <div class="brand">
                    <Logo />
                    <span class="brand-name">{tx("brand")}</span>
                    <span class="brand-product">{tx("product")}</span>
                </div>
                <div class="pills">
                    <span class=move || if snap.with(|s| s.engine_ok) { "eng eng-ok" } else { "eng eng-down" }>
                        <i class="sdot"></i>
                        {tx("engine")} " "
                        {move || if snap.with(|s| s.engine_ok) { tx("running") } else { tx("stopped") }}
                    </span>
                    {pills}
                </div>
                <SkewNotice snap=snap />
                <div class="grow"></div>
                {btop.switch("search").then(|| view! {
                    <label class="search">
                        <input aria-label=tx("search_label") placeholder=tx("search") disabled />
                    </label>
                })}
            </header>
            <div class="body">
                <nav class="nav" aria-label=tx("nav_label")>
                    <div class="nav-items">
                        {bnav2.nav().into_iter().map(|s| {
                            let id = s.id.clone();
                            let id2 = id.clone();
                            view! {
                                <button type="button" class=move || if screen_now() == id { "nav-item on" } else { "nav-item" } title=tx(&s.label) on:click=move |_| go_id(&id2)>
                                    <span class="glyph"><Icon name=s.icon.clone() /></span><span>{tx(&s.label)}</span>
                                </button>
                            }
                        }).collect_view()}
                    </div>
                    <div class="nav-foot">
                        {bside.switch("tier_switch").then(|| view! {
                            <div class="seg" role="group" aria-label=tx("mode_label")>
                                {["auto", "full", "lite"].into_iter().map(|m| view! {
                                    <button type="button" class=move || if mode.get() == m { "on" } else { "" } on:click=move |_| { store_mode(m); mode.set(m.to_string()); reload_if_other_build(m); }>{tx(&format!("mode_{m}"))}</button>
                                }).collect_view()}
                            </div>
                        })}
                        <button type="button" class="theme" aria-label=tx("theme_label") on:click=move |_| {
                            let d = !dark.get_untracked();
                            dark.set(d);
                            set_theme(d);
                        }>{move || if dark.get() { tx("theme_light") } else { tx("theme_dark") }}</button>
                    </div>
                </nav>
                <main class="main" hidden=move || other_on.get()>
                    <div class="main-head">
                        <h1>{tx("title_agents")}</h1>
                        <span class="counts">
                            {move || {
                                let (live, idle, projects, claude, codex) = counts.get();
                                format!("{live} {} \u{b7} {idle} {} \u{b7} {projects} {} \u{b7} {} {claude} \u{b7} {} {codex}", tx("live"), tx("idle"), tx("projects"), tx("claude"), tx("codex"))
                            }}
                        </span>
                        <span class="conn">{move || match conn.get() { Conn::Connecting => tx("connecting"), Conn::Reconnecting => tx("reconnecting"), Conn::Live => String::new() }}</span>
                        <div class="grow"></div>
                        {bmain.switch("graph_tab").then(|| view! {
                            <div class="seg" role="group" aria-label=tx("layout_label")>
                                <button type="button" class=move || if graph.get() { "on" } else { "" } on:click=move |_| graph.set(true)>{tx("tab_graph")}</button>
                                <button type="button" class=move || if graph.get() { "" } else { "on" } on:click=move |_| graph.set(false)>{tx("tab_tree")}</button>
                            </div>
                        })}
                    </div>
                    {bmain.switch("graph_tab").then(|| view! {
                        <section class="canvas" hidden=move || !graph.get()>
                            <div class="placeholder">
                                <strong>{tx("graph_placeholder")}</strong>
                                <span>{tx("graph_hint")}</span>
                            </div>
                            <div class="legend">
                                <span>{tx("legend_primary")}</span>
                                <span>{tx("legend_workspace")}</span>
                                <span>{tx("legend_subagent")}</span>
                                <span>{tx("legend_codex")}</span>
                            </div>
                        </section>
                    })}
                    <load::StaleNote failed=Signal::derive(move || conn.get() == Conn::Reconnecting) last_ok=Signal::derive(move || snap.with(|s| s.generated_ms)) />
                    <section class="tree" hidden=move || graph.get()>
                        <div class="tree-cols" aria-hidden="true">
                            <span class="twist-sp"></span>
                            <div class="row-cols"><span class="dot-sp"></span><span class="c-name">{tx("col_name")}</span><span class="c-kind">{tx("col_kind")}</span><span class="c-hb" title=hb_tip.clone()>{tx("col_hb")}</span><span class="c-brief">{tx("col_brief")}</span></div>
                            <span class="kebab-sp"></span>
                        </div>
                        <Show when=move || rows.with(|r| r.is_empty()) && conn.get() != Conn::Live>
                            <load::Skel shape="tree" />
                        </Show>
                        <Show when=move || rows.with(|r| r.is_empty()) && conn.get() == Conn::Live>
                            <p class="empty">{tx("empty")}</p>
                        </Show>
                        <For each=move || rows.get() key=|r| format!("{}|{}|{}", r.key, r.depth, r.kids) children=move |r| view! { <TreeLine row=r by_id=by_id current=current collapsed=collapsed /> } />
                    </section>
                    <Ribbon snap=snap />
                </main>
                {b3.screen_on("live").then(|| view! {
                    <main class="main live-main" hidden=move || !live_on.get() || ops_screen.get() != 0>
                        <live::LiveScreen mode=mode active=live_on.into() />
                    </main>
                })}
                {b3.screen_on("health").then(|| view! {
                    <div class="view-wrap" hidden=move || !(health_on.get() || topo_on.get())>
                    <ViewTabs alt=Signal::derive(move || topo_on.get()) shown=b3.switch("topology_toggle")
                        first="topo_toggle_health" second="topo_toggle_topology"
                        pick=move |second| { health_on.set(!second); topo_on.set(second); } />
                    <main class="main live-main" hidden=move || !health_on.get()>
                        <health::HealthScreen active=health_on.into() />
                    </main>
                    {b3.switch("topology_toggle").then(|| view! {
                        <main class="main live-main" hidden=move || !topo_on.get()>
                            <health::TopologyScreen mode=mode active=topo_on.into() />
                        </main>
                    })}
                    </div>
                    <Show when=move || health_on.get() || topo_on.get()><health::Poller mode=mode /></Show>
                })}
                {b3.screen_on("settings").then(|| view! {
                    <main class="main manage-main" hidden=move || !manage_on.get()>
                        <manage::ManageScreen active=manage_on.into() />
                    </main>
                })}
                {b3.screen_on("reports").then(|| view! {
                    <div class="view-wrap" hidden=move || !matches!(ops_screen.get(), 4 | 5)>
                    <ViewTabs alt=Signal::derive(move || ops_screen.get() == 5) shown=true
                        first="rep_tel" second="rep_impact"
                        pick=move |second| ops_screen.set(if second { 5 } else { 4 }) />
                    <main class="main tel-main" hidden=move || ops_screen.get() != 4>
                        <tel::TelScreen active=Signal::derive(move || ops_screen.get() == 4) />
                    </main>
                    <main class="main tel-main" hidden=move || ops_screen.get() != 5>
                        <tel::ImpactScreen active=Signal::derive(move || ops_screen.get() == 5) />
                    </main>
                    </div>
                })}
                <ops::OpsScreens screen=ops_screen />
                <aside class="detail" aria-label=tx("selected_label") hidden=move || other_on.get()>
                    {move || match current.get() {
                        None => view! { <p class="empty">{tx("pick_prompt")}</p> }.into_any(),
                        Some(a) => {
                            let b = expect_context::<Arc<Boot>>();
                            let hb = a.last_output_s.map(fmt_age).unwrap_or_else(|| "\u{2014}".into());
                            let hbc = hb_class(&b, &a);
                            let rc = role_class(&a);
                            view! {
                                <div class="who">
                                    <div class=format!("avatar {rc}")><span class="avatar-dot"></span></div>
                                    <div class="who-text"><span class="who-name">{a.label.clone()}</span><span class="who-kind">{kind_label(&a)} " \u{b7} " {a.project_name.clone()}</span></div>
                                    <div class="grow"></div>
                                    {(!a.placeholder).then(|| view! { <ActionMenu id=a.id.clone() uid="panel".to_string() /> })}
                                </div>
                                <Feedback_ id=a.id.clone() />
                                <div class="stats">
                                    <div class="stat"><div class="stat-k">{tx("tile_heartbeat")}</div><div class=format!("stat-v {hbc}")>{hb}</div></div>
                                    <div class="stat"><div class="stat-k">{tx("tile_tokens")}</div><div class="stat-v">{compact(a.tokens_out)}</div></div>
                                    <div class="stat"><div class="stat-k">{tx("tile_state")}</div><div class="stat-v small">{if a.idle_shell { tx("ops_idle_shell") } else { a.state.clone() }}</div></div>
                                </div>
                                <div><div class="sect">{tx("doing_now")}</div><p class="brief">{a.step.clone()}</p></div>
                                <Details id=a.id.clone() />
                            }.into_any()
                        }
                    }}
                    <div class="feed-wrap">
                        <div class="sect-row">
                            <div class="sect">{tx("feed_title")}</div>
                            <button type="button" class=move || if blocks_only.get() { "chip on" } else { "chip" } aria-pressed=move || blocks_only.get().to_string() on:click=move |_| blocks_only.update(|v| *v = !*v)>{tx("feed_only_block")}</button>
                        </div>
                        <ol class="feed" aria-live="polite">
                            <For each=move || snap.with(|s| s.feed.iter().rev().filter(|f| !blocks_only.get() || f.tone == "block").cloned().collect::<Vec<FeedItem>>()) key=|f| f.n children=move |f| {
                                let tag = verdict_key(&f.tone).map(|k| (k, tx(k)));
                                view! {
                                    <li class=format!("feed-item tone-{}", f.tone)>
                                        {tag.map(|(k, t)| view! { <span class=format!("vtag {k}")>{t}</span> })}
                                        <span class="feed-text">{f.text.clone()}</span><span class="feed-age">{since(f.ts_ms)}</span>
                                    </li>
                                }
                            } />
                        </ol>
                        <Show when=move || snap.with(|s| s.feed.is_empty())>
                            <p class="soft-note">{tx("feed_empty")}</p>
                        </Show>
                    </div>
                    {bside.switch("compose").then(|| view! {
                        <div class="compose">
                            <label for="cmd" class="sect">{tx("send_label")}</label>
                            <textarea id="cmd" rows="3" placeholder=tx("send_placeholder") disabled></textarea>
                            <div class="actions">
                                <button type="button" class="btn primary" disabled>{tx("send")}</button>
                            </div>
                            <p class="soft-note">{tx("controls_note")}</p>
                        </div>
                    })}
                </aside>
            </div>
            <ConfirmBox boot=b3.clone() />
        </div>
    }
}

/// The word that tags a feed line by its tone (`web.ui` key), if it is a decision.
fn verdict_key(tone: &str) -> Option<&'static str> {
    match tone {
        "block" => Some("v_block"),
        "advisory" => Some("v_advise"),
        "error" => Some("v_error"),
        _ => None,
    }
}

/// What the heartbeat ages mean, from the configured thresholds (the title of the column heading).
fn hb_tip(b: &Boot) -> String {
    let (warn, stale) = (fmt_age(b.heartbeat_warn_s), fmt_age(b.heartbeat_stale_s));
    format!(
        "{}: {} \u{b7} {} \u{b7} {}",
        tx("hb_legend_title"),
        tx("hb_legend_ok").replace("{t}", &warn),
        tx("hb_legend_warn").replace("{t}", &stale),
        tx("hb_legend_stale").replace("{t}", &stale)
    )
}

/// The wordmark's shield, one flat line drawing in the text colour.
#[component]
fn Logo() -> impl IntoView {
    view! {
        <svg class="logo" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label=tx("logo_alt")>
            <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V6L12 3Z"></path>
            <path d="m8.5 12 2.5 2.5 4.5-5"></path>
        </svg>
    }
}

/// A nav icon: one line set, 16px, 1.5 stroke, in the text colour of its row.
#[component]
fn Icon(name: String) -> impl IntoView {
    let d = match name.as_str() {
        "agents" => "M4 6h16M8 12h12M12 18h8",
        "health" => "M3 12h4l2-6 4 12 2-6h6",
        "logs" => "m5 8 5 4-5 4M12 17h7",
        "settings" => "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
        "accounts" => "M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM5 20a7 7 0 0 1 14 0",
        "updates" => "M12 16V5M7.5 9.5 12 5l4.5 4.5M5 20h14",
        "reports" => "M6 20v-8M12 20V5M18 20v-5",
        "live" => "M5 12a7 7 0 0 1 14 0M8.5 12a3.5 3.5 0 0 1 7 0M12 12v.01",
        _ => "M5 12h14",
    };
    view! { <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=d></path></svg> }
}

/// A two-way toggle above a view that holds two screens (Health and Topology, Telemetry and Impact). `pick(true)` chose the second one.
#[component]
fn ViewTabs(alt: Signal<bool>, shown: bool, first: &'static str, second: &'static str, pick: impl Fn(bool) + Copy + 'static) -> impl IntoView {
    shown.then(|| {
        view! {
            <div class="view-tabs seg" role="group">
                <button type="button" class=move || if alt.get() { "" } else { "on" } on:click=move |_| pick(false)>{tx(first)}</button>
                <button type="button" class=move || if alt.get() { "on" } else { "" } on:click=move |_| pick(true)>{tx(second)}</button>
            </div>
        }
    })
}

/// The last hour of decisions as one thin timeline: a slot per stretch of time, a tall mark where the engine blocked, a short grey one for advice.
#[component]
fn Ribbon(snap: RwSignal<Snapshot>) -> impl IntoView {
    let b = expect_context::<Arc<Boot>>();
    let (window_ms, slots) = (b.ribbon_window_s.max(1) * 1000, b.ribbon_buckets.max(1));
    let cells = Memo::new(move |_| {
        let now = now_ms();
        snap.with(|s| {
            let mut v = vec![(0u32, 0u32); slots];
            for f in s.feed.iter().filter(|f| verdict_key(&f.tone).is_some()) {
                let age = now.saturating_sub(f.ts_ms);
                if age >= window_ms {
                    continue;
                }
                let i = slots - 1 - (age * slots as u64 / window_ms) as usize;
                if f.tone == "block" { v[i].0 += 1 } else { v[i].1 += 1 }
            }
            v
        })
    });
    let totals = move || cells.with(|c| c.iter().fold((0, 0), |a, x| (a.0 + x.0, a.1 + x.1)));
    view! {
        <div class="ribbon" role="img" aria-label=tx("ribbon_title")>
            <span class="ribbon-k">{tx("ribbon_title")}</span>
            <div class="ribbon-track">
                {move || cells.get().into_iter().map(|(block, other)| { let class = if block > 0 { "rb rb-block" } else if other > 0 { "rb rb-other" } else { "rb" }; view! { <i class=class></i> } }).collect_view()}
            </div>
            <span class="ribbon-sum">{move || { let (bl, ad) = totals(); if bl + ad == 0 { tx("ribbon_none") } else { tx("ribbon_summary").replace("{block}", &bl.to_string()).replace("{advise}", &ad.to_string()) } }}</span>
        </div>
    }
}

/// Shown only when the dashboard and the engine loaded different plugin versions; the versions themselves are on Updates.
#[component]
fn SkewNotice(snap: RwSignal<Snapshot>) -> impl IntoView {
    let plugin = expect_context::<Arc<Boot>>().plugin_version.clone();
    let skew = Memo::new(move |_| snap.with(|s| s.pulse.as_ref().map(|p| p.plugin_version.clone())).is_some_and(|e| !e.is_empty() && !plugin.is_empty() && e != plugin));
    view! { <Show when=move || skew.get()><span class="ver-skew" title=tx("ver_skew")>{tx("strip_skew")}</span></Show> }
}

/// The inline outcome of the last action on `id` ("working", "done", the reason it failed).
#[component]
#[allow(non_snake_case)]
fn Feedback_(id: String) -> impl IntoView {
    let ctx = expect_context::<Ctx>();
    view! {
        {move || ctx.feedback.get().filter(|f| f.id == id).map(|f| {
            let (class, label) = match f.phase {
                Phase::Running => ("fb fb-run", tx("act_running")),
                Phase::Done => ("fb fb-ok", tx("act_done")),
                Phase::Failed => ("fb fb-bad", tx("act_failed")),
            };
            let name = expect_context::<Arc<Boot>>().actions.iter().find(|a| a.name == f.action).map(|a| tx(&a.label)).unwrap_or_default();
            view! { <p class=class role="status">{name} ": " {label} " " <span class="fb-note">{f.message}</span></p> }
        })}
    }
}

/// The details the tracker has for the selected agent, once "show details" was chosen.
#[component]
fn Details(id: String) -> impl IntoView {
    let ctx = expect_context::<Ctx>();
    view! {
        {move || ctx.detail.get().filter(|(i, _)| *i == id).map(|(_, d)| match d {
            None => view! { <div><div class="sect">{tx("details_title")}</div><p class="soft-note">{tx("details_loading")}</p></div> }.into_any(),
            Some(d) if d.rows.is_empty() => view! { <div><div class="sect">{tx("details_title")}</div><p class="soft-note">{tx("details_failed")}</p></div> }.into_any(),
            Some(d) => view! {
                <div>
                    <div class="sect">{tx("details_title")}</div>
                    <dl class="kv">
                        {d.rows.into_iter().map(|(k, v)| view! { <dt>{k}</dt><dd>{v}</dd> }).collect_view()}
                    </dl>
                </div>
            }.into_any(),
        })}
    }
}

/// The action menu of one agent: a button that opens a popover anchored to it, with the entries from `web.actions`.
#[component]
fn ActionMenu(id: String, uid: String) -> impl IntoView {
    let ctx = expect_context::<Ctx>();
    let boot = expect_context::<Arc<Boot>>();
    let menu_id = format!("menu-{uid}");
    let anchor = format!("--anchor-{uid}");
    let items = boot.actions.clone();
    view! {
        <button type="button" class="kebab" aria-label=tx("act_menu") popovertarget=menu_id.clone() style=format!("anchor-name:{anchor}")>"\u{22EF}"</button>
        <div id=menu_id popover="auto" class="menu" role="menu" style=format!("position-anchor:{anchor}")>
            {items.into_iter().map(|a| {
                let (id, boot, name) = (id.clone(), boot.clone(), a.name.clone());
                view! {
                    <button type="button" role="menuitem" class=if a.confirm { "menu-item danger" } else { "menu-item" } popovertarget=format!("menu-{uid}") popovertargetaction="hide"
                        on:click=move |_| choose(ctx, &boot, id.clone(), &name)>{tx(&a.label)}</button>
                }
            }).collect_view()}
        </div>
    }
}

/// The yes/no before an action that asks first.
#[component]
fn ConfirmBox(boot: Arc<Boot>) -> impl IntoView {
    let ctx = expect_context::<Ctx>();
    let _ = boot;
    view! {
        <Show when=move || ctx.confirm.get().is_some()>
            <div class="scrim">
                <div class="confirm" role="alertdialog" aria-modal="true" aria-label=tx("act_confirm_title")>
                    <strong>{tx("act_confirm_title")}</strong>
                    <p>{tx("act_confirm_stop")}</p>
                    <div class="actions">
                        <button type="button" class="btn" on:click=move |_| ctx.confirm.set(None)>{tx("act_confirm_no")}</button>
                        <button type="button" class="btn danger" on:click=move |_| {
                            if let Some((id, action)) = ctx.confirm.get_untracked() {
                                ctx.confirm.set(None);
                                run_action(ctx, id, action, true);
                            }
                        }>{tx("act_confirm_yes")}</button>
                    </div>
                </div>
            </div>
        </Show>
    }
}

/// The guide lines in front of a name in any tree: per level a vertical line carried down (pipe), an elbow (last child) or a tee
/// (a child with later siblings). Drawn by CSS from the level's code (0 gap, 1 pipe, 2 branch, 3 last); one look for every tree.
#[component]
pub(crate) fn Guides(guides: Vec<u8>) -> impl IntoView {
    view! { <span class="tg" aria-hidden="true">{guides.into_iter().map(|g| view! { <i class=format!("tg-{g}")></i> }).collect_view()}</span> }
}

/// The fold button of a row that has something nested under it; an empty spacer of the same width otherwise.
#[component]
pub(crate) fn Twist(key: String, kids: bool, collapsed: RwSignal<HashSet<String>>, label_key: &'static str) -> impl IntoView {
    if !kids {
        return view! { <span class="twist-sp"></span> }.into_any();
    }
    let (k1, k2, k3) = (key.clone(), key.clone(), key);
    view! {
        <button type="button" class="twist" aria-label=tx(label_key) aria-expanded=move || (!collapsed.with(|c| c.contains(&k1))).to_string()
            on:click=move |_| collapsed.update(|c| { if !c.remove(&k2) { c.insert(k2.clone()); } })>
            {move || if collapsed.with(|c| c.contains(&k3)) { "\u{25B8}" } else { "\u{25BE}" }}
        </button>
    }.into_any()
}

/// A line of the tree: a project heading or an agent.
#[component]
fn TreeLine(row: TreeRow, by_id: Memo<HashMap<String, Agent>>, current: Memo<Option<Agent>>, collapsed: RwSignal<HashSet<String>>) -> impl IntoView {
    match (row.agent.clone(), row.project.clone()) {
        (Some(id), _) => view! { <Row id=id key=row.key.clone() guides=row.guides.clone() kids=row.kids suffix=row.suffix.clone() by_id=by_id current=current collapsed=collapsed /> }.into_any(),
        (None, Some((name, live, all))) => view! {
            <div class="row-wrap proj-row">
                <Twist key=row.key.clone() kids=row.kids collapsed=collapsed label_key="proj_toggle" />
                <span class="proj-name">{name}</span>
                <span class="proj-meta">{live} " " {tx("live")} " \u{b7} " {all.saturating_sub(live)} " " {tx("idle")}</span>
            </div>
        }.into_any(),
        _ => ().into_any(),
    }
}

#[component]
fn Row(
    id: String,
    key: String,
    guides: Vec<u8>,
    kids: bool,
    suffix: String,
    by_id: Memo<HashMap<String, Agent>>,
    current: Memo<Option<Agent>>,
    collapsed: RwSignal<HashSet<String>>,
) -> impl IntoView {
    let ctx = expect_context::<Ctx>();
    let a = {
        let id = id.clone();
        Memo::new(move |_| by_id.with(|m| m.get(&id).cloned()))
    };
    let is_sel = {
        let id = id.clone();
        move || current.with(|c| c.as_ref().is_some_and(|c| c.id == id))
    };
    let pick = {
        let id = id.clone();
        move |_| ctx.selected.set(Some(id.clone()))
    };
    let uid: String = id.chars().filter(char::is_ascii_alphanumeric).collect();
    let placeholder = move || a.get().is_some_and(|a| a.placeholder);
    view! {
        <div class="row-wrap">
            <span class="indent"></span>
            <Guides guides=guides />
            <Twist key=key kids=kids collapsed=collapsed label_key="agent_toggle" />
            <button type="button" class=move || if is_sel() { "row sel" } else { "row" } on:click=pick>
                <span class=move || a.get().map(|a| format!("dot {}", role_class(&a))).unwrap_or_default()></span>
                <span class="c-name" class:ghost=placeholder title=move || if placeholder() { tx("placeholder_tip") } else { String::new() }>{move || a.get().map(|a| a.label).unwrap_or_default()}{suffix}{move || a.get().filter(|a| a.idle_shell).map(|_| view! { <em class="badge-idle" title=tx("ops_idle_shell_tip")>{tx("ops_idle_shell")}</em> })}</span>
                <span class="c-kind">{move || a.get().map(|a| kind_label(&a)).unwrap_or_default()}</span>
                <span style=move || {
                    // how far the heartbeat is along its way to stale, in percent: the colour of the age follows it
                    let b = expect_context::<Arc<Boot>>();
                    a.get().and_then(|a| a.last_output_s).map(|s| format!("--age:{}", (s * 100 / b.heartbeat_stale_s.max(1)).min(100))).unwrap_or_default()
                } class=move || {
                    let b = expect_context::<Arc<Boot>>();
                    a.get().map(|a| format!("c-hb {}", if a.placeholder { "hb-none" } else { hb_class(&b, &a) })).unwrap_or_default()
                }>{move || a.get().and_then(|a| a.last_output_s).map(fmt_age).unwrap_or_else(|| "\u{2014}".into())}</span>
                <span class="c-brief">{move || a.get().map(|a| a.step).unwrap_or_default()}</span>
            </button>
            {let menu_id = id.clone(); move || (!placeholder()).then(|| view! { <ActionMenu id=menu_id.clone() uid=uid.clone() /> })}
            <Feedback_ id=id.clone() />
        </div>
    }
}

/// A build stamp (`<version>+<branch>.<sha8>[-dirty]`) as the short display `<version> (<sha8>)`; the text is the `ver_short` template. A stamp
/// that does not have that shape (a release build: only the version) is shown as it is.
fn short_stamp(stamp: &str) -> String {
    let Some((version, tail)) = stamp.split_once('+') else { return stamp.to_string() };
    let tail = tail.strip_suffix("-dirty").unwrap_or(tail);
    let sha = tail.rsplit('.').next().unwrap_or(tail);
    tx("ver_short").replace("{version}", version).replace("{sha}", sha)
}
