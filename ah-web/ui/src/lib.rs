//! The Command Center page. Client-side rendered; every label comes from the boot data the server injects from the plugin's
//! `web.toml`, so this file carries no text of its own. Slice 1: the header, the live agent tree and the selected-agent
//! panel; the graph, the activity feed and the message controls are styled placeholders.
use ah_web_proto::{Agent, Boot, Snapshot, BOOT_ELEMENT_ID, SNAPSHOT_EVENT, STREAM_PATH};
use leptos::mount::mount_to_body;
use leptos::prelude::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{EventSource, MessageEvent};

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

fn connect(snap: RwSignal<Snapshot>, conn: RwSignal<Conn>) {
    let Ok(es) = EventSource::new(STREAM_PATH) else { return };
    let on_snapshot = Closure::<dyn FnMut(MessageEvent)>::new(move |e: MessageEvent| {
        if let Some(s) = e.data().as_string().and_then(|t| serde_json::from_str::<Snapshot>(&t).ok()) {
            snap.set(s);
            conn.set(Conn::Live);
        }
    });
    let _ = es.add_event_listener_with_callback(SNAPSHOT_EVENT, on_snapshot.as_ref().unchecked_ref());
    on_snapshot.forget();
    let on_error = Closure::<dyn FnMut()>::new(move || conn.set(Conn::Reconnecting));
    es.set_onerror(Some(on_error.as_ref().unchecked_ref()));
    on_error.forget();
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

#[component]
fn App(boot: Boot) -> impl IntoView {
    let boot = Arc::new(boot);
    provide_context(boot.clone());
    let snap = RwSignal::new(Snapshot::default());
    let conn = RwSignal::new(Conn::Connecting);
    let selected: RwSignal<Option<String>> = RwSignal::new(None);
    let graph = RwSignal::new(false);
    let dark = RwSignal::new(stored_dark().unwrap_or(true));
    if let Some(d) = stored_dark() {
        set_theme(d);
    }
    connect(snap, conn);

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

    view! {
        <div class="shell">
            <header class="top">
                <div class="brand">
                    <div class="mark"><div class="mark-dot"></div></div>
                    <span class="brand-name">{tx("brand")}</span>
                    <span class="brand-product">{tx("product")}</span>
                </div>
                <div class="pills">
                    <span class=move || if snap.with(|s| s.engine_ok) { "pill pill-ok" } else { "pill pill-warn" }>
                        {tx("engine")} " "
                        {move || if snap.with(|s| s.engine_ok) { tx("running") } else { tx("stopped") }}
                    </span>
                    <span class="pill">"CPU \u{2014}"</span>
                    <span class="pill">"MEM \u{2014}"</span>
                </div>
                <div class="grow"></div>
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
                    <a class="nav-item on" href="/" aria-current="page"><span class="glyph">"\u{25C9}"</span><span>{tx("nav_agents")}</span></a>
                    <span class="nav-item soft"><span class="glyph">"\u{2665}"</span><span>{tx("nav_health")}</span></span>
                    <span class="nav-item soft"><span class="glyph">"\u{224B}"</span><span>{tx("nav_logs")}</span></span>
                    <span class="nav-item soft"><span class="glyph">"\u{2699}"</span><span>{tx("nav_settings")}</span></span>
                    <span class="nav-item soft"><span class="glyph">"\u{21EA}"</span><span>{tx("nav_updates")}</span></span>
                </nav>
                <main class="main">
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
                        <For each=move || rows.get() key=|(id, d)| (id.clone(), *d) children=move |(id, depth)| view! { <Row id=id depth=depth by_id=by_id selected=selected current=current /> } />
                    </section>
                </main>
                <aside class="detail" aria-label=tx("selected_label")>
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
                                </div>
                                <div class="stats">
                                    <div class="stat"><div class="stat-k">{tx("heartbeat")}</div><div class=format!("stat-v {hbc}")>{hb}</div></div>
                                    <div class="stat"><div class="stat-k">{tx("running_for")}</div><div class="stat-v">{a.tokens_out}</div></div>
                                    <div class="stat"><div class="stat-k">{tx("model")}</div><div class="stat-v small">{a.state.clone()}</div></div>
                                </div>
                                <div><div class="sect">{tx("doing_now")}</div><p class="brief">{a.step.clone()}</p></div>
                            }.into_any()
                        }
                    }}
                    <div><div class="sect">{tx("recent")}</div><p class="soft-note">{tx("recent_placeholder")}</p></div>
                    <div class="compose">
                        <label for="cmd" class="sect">{tx("send_label")}</label>
                        <textarea id="cmd" rows="3" placeholder=tx("send_placeholder") disabled></textarea>
                        <div class="actions">
                            <button type="button" class="btn primary" disabled>{tx("send")}</button>
                            <button type="button" class="btn" disabled>{tx("nudge")}</button>
                            <button type="button" class="btn danger" disabled>{tx("stop")}</button>
                        </div>
                        <p class="soft-note">{tx("controls_note")}</p>
                    </div>
                </aside>
            </div>
        </div>
    }
}

#[component]
fn Row(
    id: String,
    depth: usize,
    by_id: Memo<HashMap<String, Agent>>,
    selected: RwSignal<Option<String>>,
    current: Memo<Option<Agent>>,
) -> impl IntoView {
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
        move |_| selected.set(Some(id.clone()))
    };
    view! {
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
    }
}
