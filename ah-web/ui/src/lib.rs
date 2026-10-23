//! The Command Center page. Client-side rendered; every label comes from the boot data the server injects from the plugin's
//! `web.toml`, so this file carries no text of its own. Slice 2: the header (engine vitals, tier switch), the live agent tree
//! with its action menu, the selected-agent panel with details and the activity feed; the graph is a styled placeholder.
//! Data arrives as one snapshot and then only changes (server-sent events); the tier (full or lite) picks the push rate and
//! whether anything moves.
mod live;
mod tel;
#[cfg(feature = "full")]
mod apex;
use ah_web_proto::{ActionReq, ActionRes, Agent, Boot, Delta, Detail, FeedItem, Pulse, PulseLimits, Snapshot, ACTION_PATH, BOOT_ELEMENT_ID, DELTA_EVENT, DETAIL_PATH, SNAPSHOT_EVENT, STREAM_PATH};
use leptos::mount::mount_to_body;
use leptos::prelude::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};
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
    let live = a.state == "running";
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

/// Depth-first rows (id, depth): roots first by kind order then label, children the same way.
fn flatten(boot: &Boot, agents: &[Agent]) -> Vec<(String, usize)> {
    let ids: BTreeSet<&str> = agents.iter().map(|a| a.id.as_str()).collect();
    let rank = |a: &Agent| boot.kind_order.iter().position(|k| *k == a.kind).unwrap_or(usize::MAX);
    let mut kids: BTreeMap<&str, Vec<&Agent>> = BTreeMap::new();
    let mut roots: Vec<&Agent> = Vec::new();
    for a in agents {
        if a.parent.is_empty() || !ids.contains(a.parent.as_str()) {
            roots.push(a);
        } else {
            kids.entry(a.parent.as_str()).or_default().push(a);
        }
    }
    let order = |v: &mut Vec<&Agent>| v.sort_by(|x, y| rank(x).cmp(&rank(y)).then_with(|| x.label.cmp(&y.label)).then_with(|| x.id.cmp(&y.id)));
    order(&mut roots);
    for v in kids.values_mut() {
        order(v);
    }
    let mut out = Vec::with_capacity(agents.len());
    let mut seen = BTreeSet::new();
    let mut stack: Vec<(&Agent, usize)> = roots.into_iter().rev().map(|a| (a, 0)).collect();
    while let Some((a, d)) = stack.pop() {
        if !seen.insert(a.id.as_str()) {
            continue; // a parent cycle in the data must not loop
        }
        out.push((a.id.clone(), d));
        if let Some(c) = kids.get(a.id.as_str()) {
            stack.extend(c.iter().rev().map(|k| (*k, d + 1)));
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
    let snap = ctx.snap;
    let conn = ctx.conn;
    let selected = ctx.selected;
    let graph = RwSignal::new(false);
    let live_on = RwSignal::new(false);
    // 0 = Agents or Live (live_on), 1 = Telemetry, 2 = Impact
    let screen = RwSignal::new(0u8);
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
    let rows = Memo::new(move |_| snap.with(|s| flatten(&b2, &s.agents)));
    let counts = Memo::new(move |_| {
        snap.with(|s| {
            let live = s.agents.iter().filter(|a| a.state == "running").count();
            let idle = s.agents.len() - live;
            let projects = s.agents.iter().map(|a| a.project.as_str()).collect::<BTreeSet<_>>().len();
            let codex = s.agents.iter().filter(|a| a.kind == "codex").count();
            (live, idle, projects, s.agents.len() - codex, codex)
        })
    });
    let current = Memo::new(move |_| {
        let id = selected.get().or_else(|| rows.with(|r| r.first().map(|(i, _)| i.clone())));
        id.and_then(|i| by_id.with(|m| m.get(&i).cloned()))
    });
    let lim = boot.limits.clone();
    let pill = move |pick: fn(&Pulse) -> u64, warn: u64, bad: u64, label: &'static str, fmt: fn(u64) -> String| {
        view! {
            <span class=move || snap.with(|s| s.pulse.as_ref().map_or("pill", |p| level(pick(p), warn, bad)))>
                {tx(label)} " " {move || snap.with(|s| s.pulse.as_ref().map_or_else(|| "\u{2014}".to_string(), |p| fmt(pick(p))))}
            </span>
        }
    };
    let PulseLimits { cpu_warn_permille, cpu_bad_permille, mem_warn_mb, mem_bad_mb, err_warn, err_bad } = lim;
    let cpu_pill = pill(|p| p.cpu_permille.unwrap_or(0), cpu_warn_permille, cpu_bad_permille, "pill_cpu", |v| format!("{:.1}%", v as f64 / 10.0));
    let mem_pill = pill(|p| p.rss_kb / 1024, mem_warn_mb, mem_bad_mb, "pill_mem", |v| format!("{v} MB"));
    let req_pill = pill(|p| p.requests, u64::MAX, u64::MAX, "pill_req", compact);
    let err_pill = pill(|p| p.errors, err_warn, err_bad, "pill_err", compact);
    let b3 = boot.clone();

    view! {
        <div class="shell">
            <header class="top">
                <div class="brand">
                    <img class=move || if snap.with(|s| s.engine_ok) { "logo live" } else { "logo" } src="/static/logo.svg" alt=tx("logo_alt") width="30" height="30" />
                    <span class="brand-name">{tx("brand")}</span>
                    <span class="brand-product">{tx("product")}</span>
                </div>
                <div class="pills">
                    <span class=move || if snap.with(|s| s.engine_ok) { "pill pill-ok" } else { "pill pill-bad" }>
                        {tx("engine")} " "
                        {move || if snap.with(|s| s.engine_ok) { tx("running") } else { tx("stopped") }}
                    </span>
                    {cpu_pill}
                    {mem_pill}
                    {req_pill}
                    {err_pill}
                </div>
                <VersionBadge snap=snap />
                <div class="grow"></div>
                <div class="seg" role="group" aria-label=tx("mode_label")>
                    {["auto", "full", "lite"].into_iter().map(|m| view! {
                        <button type="button" class=move || if mode.get() == m { "on" } else { "" } on:click=move |_| { store_mode(m); mode.set(m.to_string()); reload_if_other_build(m); }>{tx(&format!("mode_{m}"))}</button>
                    }).collect_view()}
                </div>
                <button type="button" class="theme" aria-label=tx("theme_label") on:click=move |_| {
                    let d = !dark.get_untracked();
                    dark.set(d);
                    set_theme(d);
                }>{move || if dark.get() { tx("theme_light") } else { tx("theme_dark") }}</button>
                <label class="search">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg>
                    <input aria-label=tx("search_label") placeholder=tx("search") disabled />
                </label>
            </header>
            <div class="body">
                <nav class="nav" aria-label=tx("nav_label")>
                    <button type="button" class=move || if live_on.get() || screen.get() != 0 { "nav-item" } else { "nav-item on" } on:click=move |_| { screen.set(0); live_on.set(false) }><span class="glyph">"\u{25C9}"</span><span>{tx("nav_agents")}</span></button>
                    <button type="button" class=move || if live_on.get() && screen.get() == 0 { "nav-item on" } else { "nav-item" } on:click=move |_| { screen.set(0); live_on.set(true) }><span class="glyph">"\u{26A1}"</span><span>{tx("nav_live")}</span></button>
                    <button type="button" class=move || if screen.get() == 1 { "nav-item on" } else { "nav-item" } on:click=move |_| screen.set(1)><span class="glyph">"\u{2248}"</span><span>{tx("nav_telemetry")}</span></button>
                    <button type="button" class=move || if screen.get() == 2 { "nav-item on" } else { "nav-item" } on:click=move |_| screen.set(2)><span class="glyph">"\u{2191}"</span><span>{tx("nav_impact")}</span></button>
                    <span class="nav-item soft"><span class="glyph">"\u{2665}"</span><span>{tx("nav_health")}</span></span>
                    <span class="nav-item soft"><span class="glyph">"\u{224B}"</span><span>{tx("nav_logs")}</span></span>
                    <span class="nav-item soft"><span class="glyph">"\u{2699}"</span><span>{tx("nav_settings")}</span></span>
                    <span class="nav-item soft"><span class="glyph">"\u{21EA}"</span><span>{tx("nav_updates")}</span></span>
                </nav>
                <main class="main" hidden=move || live_on.get() || screen.get() != 0>
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
                        <div class="seg" role="group" aria-label=tx("layout_label")>
                            <button type="button" class=move || if graph.get() { "on" } else { "" } on:click=move |_| graph.set(true)>{tx("tab_graph")}</button>
                            <button type="button" class=move || if graph.get() { "" } else { "on" } on:click=move |_| graph.set(false)>{tx("tab_tree")}</button>
                        </div>
                    </div>
                    <section class="canvas" hidden=move || !graph.get()>
                        <div class="placeholder">
                            <strong>{tx("graph_placeholder")}</strong>
                            <span>{tx("graph_hint")}</span>
                        </div>
                        <div class="legend">
                            <span>"\u{25C6} " {tx("legend_primary")}</span>
                            <span>"\u{25CF} " {tx("legend_workspace")}</span>
                            <span>"\u{25CB} " {tx("legend_subagent")}</span>
                            <span>"\u{25C7} " {tx("legend_codex")}</span>
                        </div>
                    </section>
                    <section class="tree" hidden=move || graph.get()>
                        <div class="tree-cols" aria-hidden="true">
                            <span class="c-name">{tx("col_name")}</span><span class="c-kind">{tx("col_kind")}</span><span class="c-hb">{tx("col_hb")}</span><span class="c-brief">{tx("col_brief")}</span>
                        </div>
                        <Show when=move || rows.with(|r| r.is_empty())>
                            <p class="empty">{tx("empty")}</p>
                        </Show>
                        <For each=move || rows.get() key=|(id, d)| (id.clone(), *d) children=move |(id, depth)| view! { <Row id=id depth=depth by_id=by_id current=current /> } />
                    </section>
                </main>
                <main class="main live-main" hidden=move || !live_on.get() || screen.get() != 0>
                    <live::LiveScreen mode=mode active=Signal::derive(move || live_on.get() && screen.get() == 0) />
                </main>
                <main class="main tel-main" hidden=move || screen.get() != 1>
                    <tel::TelScreen active=Signal::derive(move || screen.get() == 1) />
                </main>
                <main class="main tel-main" hidden=move || screen.get() != 2>
                    <tel::ImpactScreen active=Signal::derive(move || screen.get() == 2) />
                </main>
                <aside class="detail" aria-label=tx("selected_label") hidden=move || live_on.get() || screen.get() != 0>
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
                                    <div class="who-text"><span class="who-name">{a.label.clone()}</span><span class="who-kind">{kind_label(&a)} " \u{b7} " {a.project.rsplit('/').find(|s| !s.is_empty()).unwrap_or_default().to_string()}</span></div>
                                    <div class="grow"></div>
                                    <ActionMenu id=a.id.clone() uid="panel".to_string() />
                                </div>
                                <Feedback_ id=a.id.clone() />
                                <div class="stats">
                                    <div class="stat"><div class="stat-k">{tx("heartbeat")}</div><div class=format!("stat-v {hbc}")>{hb}</div></div>
                                    <div class="stat"><div class="stat-k">{tx("running_for")}</div><div class="stat-v">{compact(a.tokens_out)}</div></div>
                                    <div class="stat"><div class="stat-k">{tx("model")}</div><div class="stat-v small">{a.state.clone()}</div></div>
                                </div>
                                <div><div class="sect">{tx("doing_now")}</div><p class="brief">{a.step.clone()}</p></div>
                                <Details id=a.id.clone() />
                            }.into_any()
                        }
                    }}
                    <div class="feed-wrap">
                        <div class="sect">{tx("feed_title")}</div>
                        <ol class="feed" aria-live="polite">
                            <For each=move || snap.with(|s| s.feed.iter().rev().cloned().collect::<Vec<FeedItem>>()) key=|f| f.n children=move |f| view! {
                                <li class=format!("feed-item tone-{}", f.tone)><span class="feed-text">{f.text.clone()}</span><span class="feed-age">{since(f.ts_ms)}</span></li>
                            } />
                        </ol>
                        <Show when=move || snap.with(|s| s.feed.is_empty())>
                            <p class="soft-note">{tx("feed_empty")}</p>
                        </Show>
                    </div>
                    <div class="compose">
                        <label for="cmd" class="sect">{tx("send_label")}</label>
                        <textarea id="cmd" rows="3" placeholder=tx("send_placeholder") disabled></textarea>
                        <div class="actions">
                            <button type="button" class="btn primary" disabled>{tx("send")}</button>
                        </div>
                        <p class="soft-note">{tx("controls_note")}</p>
                    </div>
                </aside>
            </div>
            <ConfirmBox boot=b3 />
        </div>
    }
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

#[component]
fn Row(
    id: String,
    depth: usize,
    by_id: Memo<HashMap<String, Agent>>,
    current: Memo<Option<Agent>>,
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
    view! {
        <div class="row-wrap">
            <button type="button" class=move || if is_sel() { "row sel" } else { "row" } on:click=pick>
                <span class="indent" style=format!("flex-basis:{}px", depth * 24)></span>
                <span class=move || a.get().map(|a| format!("dot {}", role_class(&a))).unwrap_or_default()></span>
                <span class="c-name">{move || a.get().map(|a| a.label).unwrap_or_default()}</span>
                <span class="c-kind">{move || a.get().map(|a| kind_label(&a)).unwrap_or_default()}</span>
                <span class=move || {
                    let b = expect_context::<Arc<Boot>>();
                    a.get().map(|a| format!("c-hb {}", hb_class(&b, &a))).unwrap_or_default()
                }>{move || a.get().and_then(|a| a.last_output_s).map(fmt_age).unwrap_or_else(|| "\u{2014}".into())}</span>
                <span class="c-brief">{move || a.get().map(|a| a.step).unwrap_or_default()}</span>
            </button>
            <ActionMenu id=id.clone() uid=uid />
            <Feedback_ id=id />
        </div>
    }
}

/// The header's version badge: the plugin and engine versions at a glance (amber when they differ), a popover with all of them.
#[component]
fn VersionBadge(snap: RwSignal<Snapshot>) -> impl IntoView {
    let boot = expect_context::<Arc<Boot>>();
    let (plugin, web) = (boot.plugin_version.clone(), boot.web_version.clone());
    let none = tx("ver_unavailable");
    let pulse = move |f: fn(&Pulse) -> String| snap.with(|s| s.pulse.as_ref().map(f)).filter(|v| !v.is_empty());
    let sha = move || pulse(|p| p.build_sha.clone());
    let engine_plugin = move || pulse(|p| p.plugin_version.clone());
    let plugin2 = plugin.clone();
    // amber only on a real mismatch: the plugin the engine says it loaded against the plugin this server serves
    let skew = Memo::new(move |_| engine_plugin().is_some_and(|e| !plugin2.is_empty() && e != plugin2));
    let (n1, n3) = (none.clone(), none.clone());
    let p1 = plugin.clone();
    let badge_plugin = plugin.clone();
    view! {
        <button type="button" class=move || if skew.get() { "ver ver-skew" } else { "ver" } popovertarget="ver-pop" aria-label=tx("ver_label") style="anchor-name:--ver">
            {move || format!("{}{}", if badge_plugin.is_empty() { String::new() } else { format!("v{badge_plugin} \u{b7} ") }, sha().map(|s| format!("{} {s}", tx("ver_engine"))).unwrap_or_else(|| n1.clone()))}
        </button>
        <div id="ver-pop" popover="auto" class="menu ver-pop" role="dialog" aria-label=tx("ver_title") style="position-anchor:--ver">
            <dl class="kv">
                <dt>{tx("ver_plugin")}</dt><dd>{if p1.is_empty() { none.clone() } else { format!("v{p1}") }}</dd>
                <dt>{tx("ver_engine")}</dt><dd>{move || pulse(|p| p.version.clone()).map(|v| sha().map_or_else(|| v.clone(), |h| format!("{v} \u{b7} {h}"))).unwrap_or_else(|| n3.clone())}</dd>
                <dt>{tx("ver_web")}</dt><dd>{web.clone()}</dd>
                <dt>{tx("ver_hook")}</dt><dd>{none.clone()}</dd>
                <dt>{tx("ver_uptime")}</dt><dd>{move || snap.with(|s| s.pulse.as_ref().map(|p| fmt_age(p.uptime_s))).unwrap_or_else(|| "\u{2014}".into())}</dd>
                <dt>{tx("ver_update")}</dt><dd>{tx("ver_update_unknown")}</dd>
            </dl>
            <Show when=move || skew.get()><p class="fb fb-bad">{tx("ver_skew")}</p></Show>
        </div>
    }
}
