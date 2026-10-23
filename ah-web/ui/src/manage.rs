//! The Settings screens: settings by category, config files, checks and guards, Jev modes and the history of changes. All data
//! comes from `/api/manage/*` (the engine's own `describe` and `config` verbs); every label comes from `web_manage.toml` through
//! `/api/manage/cfg`, so this file carries no text of its own. A write goes to the engine, which validates, writes and audits it;
//! the page only shows the engine's answer inline (running, then done or the reason it failed). Full and Lite share this screen:
//! it is forms and lists, drawn the same, and Lite only drops the transitions (CSS).
use leptos::prelude::*;
use serde_json::{Value, json};
use std::sync::Arc;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{RequestInit, Response};

const CFG_URL: &str = "/api/manage/cfg";
const DATA_URL: &str = "/api/manage/data";
const FILE_URL: &str = "/api/manage/file?name=";
const HISTORY_URL: &str = "/api/manage/history";
const WRITE_URL: &str = "/api/manage/write";

/// The page's texts and the lists the server sent with them.
#[derive(Clone)]
struct M(Arc<Value>);

/// The text for `key` (the key itself when `web_manage.toml` lacks it, so a gap is visible).
fn mt(key: &str) -> String {
    expect_context::<M>().0.get("ui").and_then(|u| u.get(key)).and_then(Value::as_str).map_or_else(|| key.to_string(), str::to_string)
}

/// `template` with each `{name}` replaced.
fn fill(template: &str, pairs: &[(&str, &str)]) -> String {
    pairs.iter().fold(template.to_string(), |t, (k, v)| t.replace(&format!("{{{k}}}"), v))
}

fn list_of(key: &str) -> Vec<String> {
    expect_context::<M>().0.get(key).and_then(Value::as_array).map(|l| l.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn text_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// A value as the person reads and types it.
fn show(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

async fn fetch(url: &str, body: Option<String>) -> Result<Value, String> {
    let window = web_sys::window().ok_or("no window")?;
    let resp = match body {
        None => JsFuture::from(window.fetch_with_str(url)).await,
        Some(b) => {
            let init = RequestInit::new();
            init.set_method("POST");
            init.set_body(&wasm_bindgen::JsValue::from_str(&b));
            let headers = web_sys::Headers::new().map_err(|_| "headers")?;
            headers.set("Content-Type", "application/json").map_err(|_| "headers")?;
            init.set_headers(&headers);
            JsFuture::from(window.fetch_with_str_and_init(url, &init)).await
        }
    }
    .map_err(|_| "network".to_string())?;
    let resp: Response = resp.dyn_into().map_err(|_| "response")?;
    let text = JsFuture::from(resp.text().map_err(|_| "body")?).await.map_err(|_| "body")?.as_string().unwrap_or_default();
    let v: Value = serde_json::from_str(&text).map_err(|_| text.chars().take(120).collect::<String>())?;
    match v.get("error").and_then(Value::as_str) {
        Some(e) if !resp.ok() => Err(e.to_string()),
        _ => Ok(v),
    }
}

/// The inline state of one write.
#[derive(Clone, PartialEq)]
enum Fb {
    Idle,
    Running,
    Ok(String),
    Bad(String),
}

/// A change the person still has to confirm: what to write and the sentence that says what it does.
#[derive(Clone, PartialEq)]
struct Pending {
    op: String,
    key: String,
    value: String,
    consequence: String,
}

/// One setting or config key, from the registry or from a config file.
#[derive(Clone)]
struct Opt {
    key: String,
    title: String,
    doc: String,
    ty: String,
    value: Value,
    default: Value,
    min: Option<f64>,
    max: Option<f64>,
    values: Vec<String>,
    changed: bool,
    safety: String,
    confirm: bool,
    env: String,
    restart_only: bool,
    source: String,
    unit: String,
    readonly: bool,
}

impl Opt {
    fn from_registry(v: &Value) -> Opt {
        let safety = text_of(v, "safety_note");
        let in_safety = list_of("safety_categories").contains(&text_of(v, "category"));
        Opt {
            key: text_of(v, "id"),
            title: text_of(v, "id"),
            doc: text_of(v, "description"),
            ty: text_of(v, "type"),
            value: v.get("value").cloned().unwrap_or(Value::Null),
            default: v.get("default").cloned().unwrap_or(Value::Null),
            min: v.get("min").and_then(Value::as_f64),
            max: v.get("max").and_then(Value::as_f64),
            values: v.get("values").and_then(Value::as_array).map(|l| l.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
            changed: text_of(v, "source") != "default",
            confirm: !safety.is_empty() || in_safety || v.get("locked") == Some(&Value::Bool(true)),
            safety,
            env: text_of(v, "env"),
            restart_only: false,
            source: text_of(v, "source"),
            unit: String::new(),
            readonly: text_of(v, "type") == "object",
        }
    }

    fn from_file_key(v: &Value) -> Opt {
        let ty = text_of(v, "type");
        Opt {
            key: text_of(v, "key"),
            title: text_of(v, "key"),
            doc: text_of(v, "doc"),
            value: v.get("value").cloned().unwrap_or(Value::Null),
            default: v.get("default").cloned().unwrap_or(Value::Null),
            min: v.get("min").and_then(Value::as_f64),
            max: v.get("max").and_then(Value::as_f64),
            values: Vec::new(),
            changed: v.get("changed") == Some(&Value::Bool(true)),
            safety: String::new(),
            confirm: false,
            env: text_of(v, "env"),
            restart_only: v.get("restart_only") == Some(&Value::Bool(true)),
            source: String::new(),
            unit: text_of(v, "unit"),
            readonly: ty == "table" || v.get("locked") == Some(&Value::Bool(true)),
            ty,
        }
    }

    fn is_bool(&self) -> bool {
        matches!(self.ty.as_str(), "boolean" | "bool")
    }

    fn is_number(&self) -> bool {
        matches!(self.ty.as_str(), "number" | "integer" | "int")
    }
}

/// Send one write and fold the engine's answer into `fb`. A refusal that wants a confirmation fills `pending`; a finished write runs `done`.
fn run_write(fb: RwSignal<Fb>, pending: RwSignal<Option<Pending>>, op: &str, key: &str, value: &str, check: bool, confirmed: bool, done: Callback<()>) {
    let (op, key, value) = (op.to_string(), key.to_string(), value.to_string());
    fb.set(Fb::Running);
    pending.set(None);
    leptos::task::spawn_local(async move {
        let body = json!({"op": op, "key": key, "value": value, "check": check, "confirmed": confirmed}).to_string();
        match fetch(WRITE_URL, Some(body)).await {
            Err(e) => fb.set(Fb::Bad(e)),
            Ok(r) => {
                let ok = r.get("ok") == Some(&Value::Bool(true));
                let note = text_of(&r, "note");
                if !ok && r.get("needs_confirmation") == Some(&Value::Bool(true)) && !confirmed {
                    fb.set(Fb::Idle);
                    pending.set(Some(Pending { op, key, value, consequence: text_of(&r, "warning") }));
                } else if !ok {
                    let e = text_of(&r, "error");
                    fb.set(Fb::Bad(if note.is_empty() { e } else { note }));
                } else if check {
                    fb.set(Fb::Ok(fill(&mt("checked_ok"), &[("new", &show(r.get("value").unwrap_or(&Value::Null)))])));
                } else {
                    let msg = match op.as_str() {
                        "reset" => mt("reset_done"),
                        "undo" => mt("undone"),
                        _ => fill(&mt("saved"), &[("old", &r.get("prev").filter(|p| !p.is_null()).map_or_else(|| mt("history_none_old"), show))]),
                    };
                    fb.set(Fb::Ok(if note.is_empty() { msg } else { format!("{msg} {note}") }));
                    done.run(());
                }
            }
        }
    });
}

/// The inline outcome line of a write.
#[component]
fn FbLine(fb: RwSignal<Fb>) -> impl IntoView {
    view! {
        {move || match fb.get() {
            Fb::Idle => ().into_any(),
            Fb::Running => view! { <p class="mg-fb fb-run" role="status">{mt("running")}</p> }.into_any(),
            Fb::Ok(m) => view! { <p class="mg-fb fb-ok" role="status">{mt("done")} ": " {m}</p> }.into_any(),
            Fb::Bad(m) => view! { <p class="mg-fb fb-bad" role="alert">{mt("failed")} ": " {m}</p> }.into_any(),
        }}
    }
}

/// The confirmation step: says what the change does in plain words before anything is written.
#[component]
fn ConfirmBox(pending: RwSignal<Option<Pending>>, fb: RwSignal<Fb>, done: Callback<()>) -> impl IntoView {
    view! {
        {move || pending.get().map(|p| {
            let p2 = p.clone();
            view! {
                <div class="mg-confirm" role="alertdialog" aria-label=mt("confirm_title")>
                    <strong>{mt("confirm_title")}</strong>
                    <p>{p.consequence.clone()}</p>
                    <div class="mg-btns">
                        <button type="button" class="mg-btn danger" on:click=move |_| run_write(fb, pending, &p2.op, &p2.key, &p2.value, false, true, done)>{mt("confirm_yes")}</button>
                        <button type="button" class="mg-btn" on:click=move |_| pending.set(None)>{mt("confirm_no")}</button>
                    </div>
                </div>
            }
        })}
    }
}

/// A switch button.
#[component]
fn Switch(on: bool, label: String, disabled: bool, click: Callback<bool>) -> impl IntoView {
    view! {
        <button type="button" role="switch" class=if on { "mg-switch on" } else { "mg-switch" } aria-checked=on.to_string() aria-label=label disabled=disabled on:click=move |_| click.run(!on)>
            <span class="knob"></span>
        </button>
    }
}

/// One option: description, default, limits, the editor for its type, check/save/reset and the inline outcome.
#[component]
fn OptRow(opt: Opt, done: Callback<()>) -> impl IntoView {
    let fb = RwSignal::new(Fb::Idle);
    let pending = RwSignal::new(None::<Pending>);
    let draft = RwSignal::new(show(&opt.value));
    let key = opt.key.clone();
    let consequence = if opt.safety.is_empty() { mt("confirm_generic") } else { fill(&mt("confirm_consequence"), &[("note", &opt.safety)]) };
    let ask_or_write = {
        let (key, consequence, confirm) = (key.clone(), consequence.clone(), opt.confirm);
        move |op: &'static str, value: String, check: bool| {
            if confirm && !check {
                pending.set(Some(Pending { op: op.to_string(), key: key.clone(), value, consequence: consequence.clone() }));
            } else {
                run_write(fb, pending, op, &key, &value, check, false, done);
            }
        }
    };
    let meta = {
        let mut parts = vec![format!("{} {}", mt("default"), show(&opt.default))];
        if opt.min.is_some() || opt.max.is_some() {
            parts.push(format!("{} {}\u{2013}{}", mt("range"), opt.min.map_or(String::new(), |m| m.to_string()), opt.max.map_or(String::new(), |m| m.to_string())));
        }
        if !opt.values.is_empty() {
            parts.push(format!("{} {}", mt("values"), opt.values.join(" / ")));
        }
        if !opt.unit.is_empty() {
            parts.push(opt.unit.clone());
        }
        if !opt.env.is_empty() {
            parts.push(format!("{} {}", mt("env"), opt.env));
        }
        if !opt.source.is_empty() {
            parts.push(format!("{} {}", mt("source"), mt(&format!("src_{}", opt.source))));
        }
        parts.join(" \u{b7} ")
    };
    let editor = if opt.readonly {
        view! { <span class="mg-ro">{show(&opt.value)}</span> }.into_any()
    } else if opt.is_bool() {
        let on = opt.value.as_bool().unwrap_or(false);
        let ask = ask_or_write.clone();
        view! { <Switch on=on label=opt.title.clone() disabled=false click=Callback::new(move |v: bool| ask("set", v.to_string(), false)) /> }.into_any()
    } else {
        let ask = ask_or_write.clone();
        let ask2 = ask_or_write.clone();
        let input = if !opt.values.is_empty() {
            let vals = opt.values.clone();
            view! {
                <select class="mg-input" aria-label=opt.title.clone() on:change=move |e| draft.set(event_target_value(&e))>
                    {vals.into_iter().map(|v| { let sel = v == draft.get_untracked(); view! { <option value=v.clone() selected=sel>{v.clone()}</option> } }).collect_view()}
                </select>
            }
            .into_any()
        } else if opt.is_number() {
            let (min, max) = (opt.min.map(|m| m.to_string()), opt.max.map(|m| m.to_string()));
            view! { <input class="mg-input num" type="number" step="any" min=min max=max aria-label=opt.title.clone() prop:value=move || draft.get() on:input=move |e| draft.set(event_target_value(&e)) /> }.into_any()
        } else {
            let hint = if opt.ty == "list" { mt("config_list_hint") } else { String::new() };
            view! { <input class="mg-input txt" type="text" placeholder=hint aria-label=opt.title.clone() prop:value=move || draft.get() on:input=move |e| draft.set(event_target_value(&e)) /> }.into_any()
        };
        view! {
            <div class="mg-edit">
                {input}
                <button type="button" class="mg-btn" on:click=move |_| ask2("set", draft.get_untracked(), true)>{mt("check")}</button>
                <button type="button" class="mg-btn primary" on:click=move |_| ask("set", draft.get_untracked(), false)>{mt("save")}</button>
            </div>
        }
        .into_any()
    };
    let reset = (opt.changed && !opt.readonly).then(|| {
        let (key, consequence, confirm) = (key.clone(), fill(&mt("reset_confirm"), &[("key", &key)]), opt.confirm);
        view! {
            <button type="button" class="mg-btn" on:click=move |_| {
                if confirm { pending.set(Some(Pending { op: "reset".into(), key: key.clone(), value: String::new(), consequence: consequence.clone() })); } else { run_write(fb, pending, "reset", &key, "", false, false, done); }
            }>{mt("reset")}</button>
        }
    });
    view! {
        <div class=if opt.changed { "mg-row changed" } else { "mg-row" }>
            <div class="mg-main">
                <div class="mg-title">
                    <span class="mg-name">{opt.title.clone()}</span>
                    {opt.changed.then(|| view! { <span class="mg-badge chg">{mt("changed")}</span> })}
                    {(!opt.safety.is_empty()).then(|| view! { <span class="mg-badge warn">{mt("safety")}</span> })}
                    {opt.restart_only.then(|| view! { <span class="mg-badge">{mt("restart_only")}</span> })}
                </div>
                <p class="mg-doc">{opt.doc.clone()}</p>
                <p class="mg-meta">{meta}</p>
            </div>
            <div class="mg-side">{editor}{reset}</div>
            <ConfirmBox pending=pending fb=fb done=done />
            <FbLine fb=fb />
        </div>
    }
}

/// Where the screen's data lives, and how to reload it.
#[derive(Clone, Copy)]
struct Store {
    data: RwSignal<Option<Result<Value, String>>>,
    hist: RwSignal<Option<Result<Value, String>>>,
}

fn load(store: Store) {
    leptos::task::spawn_local(async move {
        store.data.set(Some(fetch(DATA_URL, None).await));
        store.hist.set(Some(fetch(HISTORY_URL, None).await));
    });
}

/// `#settings` or `#settings/<tab>` in the address opens this screen (and the tab, by its number in the tab row).
pub fn hash() -> Option<Option<usize>> {
    let h = web_sys::window()?.location().hash().ok()?;
    let rest = h.strip_prefix("#settings")?;
    Some(rest.strip_prefix('/').and_then(|n| n.parse().ok()))
}

/// The screen. Nothing is fetched or drawn while it is not the chosen one.
#[component]
pub fn ManageScreen(active: Signal<bool>) -> impl IntoView {
    view! { <Show when=move || active.get()><ManageLoader /></Show> }
}

#[component]
fn ManageLoader() -> impl IntoView {
    let cfg = RwSignal::new(None::<Result<Value, String>>);
    leptos::task::spawn_local(async move { cfg.set(Some(fetch(CFG_URL, None).await)) });
    view! {
        {move || match cfg.get() {
            None => view! { <p class="empty">"\u{2026}"</p> }.into_any(),
            Some(Err(e)) => view! { <p class="empty">{e}</p> }.into_any(),
            Some(Ok(c)) => {
                provide_context(M(Arc::new(c)));
                view! { <ManageBody /> }.into_any()
            }
        }}
    }
}

#[component]
fn ManageBody() -> impl IntoView {
    let store = Store { data: RwSignal::new(None), hist: RwSignal::new(None) };
    let tab = RwSignal::new(hash().flatten().unwrap_or(0));
    load(store);
    let reload = Callback::new(move |()| load(store));
    let tabs = ["tab_settings", "tab_config", "tab_checks", "tab_jev", "tab_history"];
    view! {
        <div class="mg">
            <div class="main-head">
                <h1>{mt("title")}</h1>
                <div class="grow"></div>
                <div class="seg" role="tablist" aria-label=mt("tabs_label")>
                    {tabs.iter().enumerate().map(|(i, k)| view! {
                        <button type="button" role="tab" class=move || if tab.get() == i { "on" } else { "" } on:click=move |_| tab.set(i)>{mt(k)}</button>
                    }).collect_view()}
                </div>
                <button type="button" class="mg-btn" on:click=move |_| reload.run(())>{mt("refresh")}</button>
            </div>
            <p class="mg-hint">{mt("hint")}</p>
            {move || match store.data.get() {
                None => view! { <p class="empty">{mt("loading")}</p> }.into_any(),
                Some(Err(e)) => view! { <p class="empty">{mt("load_failed")} " " {e} " " <button type="button" class="mg-btn" on:click=move |_| reload.run(())>{mt("retry")}</button></p> }.into_any(),
                Some(Ok(d)) => {
                    let d = Arc::new(d);
                    match tab.get() {
                        0 => view! { <SettingsTab data=d reload=reload /> }.into_any(),
                        1 => view! { <ConfigTab data=d reload=reload /> }.into_any(),
                        2 => view! { <ChecksTab data=d reload=reload /> }.into_any(),
                        3 => view! { <JevTab data=d reload=reload /> }.into_any(),
                        _ => view! { <HistoryTab store=store reload=reload /> }.into_any(),
                    }
                }
            }}
        </div>
    }
}

fn rows_of<'a>(d: &'a Value, k: &str) -> Vec<&'a Value> {
    d.get(k).and_then(Value::as_array).map(|l| l.iter().collect()).unwrap_or_default()
}

fn matches(filter: &str, parts: &[&str]) -> bool {
    filter.is_empty() || parts.iter().any(|p| p.to_lowercase().contains(filter))
}

/// Settings grouped by category: the categories on the left, one card per category.
#[component]
fn SettingsTab(data: Arc<Value>, reload: Callback<()>) -> impl IntoView {
    let filter = RwSignal::new(String::new());
    let cat = RwSignal::new(String::new());
    let adv = RwSignal::new(false);
    let prefix = expect_context::<M>().0.get("jev_prefix").and_then(Value::as_str).unwrap_or_default().to_string();
    let all: Vec<Value> = rows_of(&data, "settings").into_iter().filter(|s| !text_of(s, "id").starts_with(&prefix)).cloned().collect();
    let mut cats: Vec<(String, usize, usize)> = Vec::new();
    for s in &all {
        let c = text_of(s, "category");
        let changed = usize::from(text_of(s, "source") != "default");
        match cats.iter_mut().find(|x| x.0 == c) {
            Some(x) => {
                x.1 += 1;
                x.2 += changed;
            }
            None => cats.push((c, 1, changed)),
        }
    }
    cats.sort();
    let all = Arc::new(all);
    view! {
        <div class="mg-split">
            <nav class="mg-cats" aria-label=mt("categories")>
                <button type="button" class=move || if cat.get().is_empty() { "mg-cat on" } else { "mg-cat" } on:click=move |_| cat.set(String::new())><span>{mt("all")}</span><span class="n">{all.len()}</span></button>
                {cats.into_iter().map(|(c, n, ch)| { let c2 = c.clone(); let c3 = c.clone(); view! {
                    <button type="button" class=move || if cat.get() == c2 { "mg-cat on" } else { "mg-cat" } on:click=move |_| cat.set(c3.clone())>
                        <span>{c.clone()}</span><span class="n">{(ch > 0).then(|| format!("{ch}/")).unwrap_or_default()}{n}</span>
                    </button> } }).collect_view()}
            </nav>
            <section class="mg-list">
                <div class="mg-bar">
                    <input class="mg-input txt" type="search" placeholder=mt("filter") aria-label=mt("filter_label") on:input=move |e| filter.set(event_target_value(&e).to_lowercase()) />
                    <label class="mg-check"><input type="checkbox" on:change=move |e| adv.set(event_target_checked(&e)) /> {mt("show_advanced")}</label>
                </div>
                {move || {
                    let (f, c, a) = (filter.get(), cat.get(), adv.get());
                    let hit: Vec<&Value> = all.iter().filter(|s| (c.is_empty() || text_of(s, "category") == c) && (a || s.get("advanced") != Some(&Value::Bool(true))) && matches(&f, &[&text_of(s, "id"), &text_of(s, "description")])).collect();
                    if hit.is_empty() {
                        return view! { <p class="empty">{mt("empty")}</p> }.into_any();
                    }
                    let mut groups: Vec<(String, Vec<Opt>)> = Vec::new();
                    for s in hit {
                        let g = text_of(s, "category");
                        match groups.iter_mut().find(|x| x.0 == g) {
                            Some(x) => x.1.push(Opt::from_registry(s)),
                            None => groups.push((g, vec![Opt::from_registry(s)])),
                        }
                    }
                    groups.sort_by(|a, b| a.0.cmp(&b.0));
                    groups.into_iter().map(|(g, rows)| view! {
                        <div class="mg-card"><h2>{g}</h2>{rows.into_iter().map(|o| view! { <OptRow opt=o done=reload /> }).collect_view()}</div>
                    }).collect_view().into_any()
                }}
            </section>
        </div>
    }
}

/// Config files and their keys: docs, default and effective value; edits go through `config set`, which validates first.
#[component]
fn ConfigTab(data: Arc<Value>, reload: Callback<()>) -> impl IntoView {
    let files: Vec<Value> = rows_of(&data, "files").into_iter().cloned().collect();
    let pick = RwSignal::new(String::new());
    let keys = RwSignal::new(None::<Result<Value, String>>);
    let filter = RwSignal::new(String::new());
    let rows_max = expect_context::<M>().0.get("rows_max").and_then(Value::as_u64).unwrap_or(100) as usize;
    let open = move |name: String| {
        pick.set(name.clone());
        keys.set(None);
        leptos::task::spawn_local(async move { keys.set(Some(fetch(&format!("{FILE_URL}{name}"), None).await)) });
    };
    // after a write the open file is read again so the new value shows
    let done = Callback::new(move |()| {
        let name = pick.get_untracked();
        if !name.is_empty() {
            leptos::task::spawn_local(async move { keys.set(Some(fetch(&format!("{FILE_URL}{name}"), None).await)) });
        }
        reload.run(());
    });
    // the first file is open from the start
    if let Some(first) = files.first().map(|f| text_of(f, "file")) {
        open(first);
    }
    view! {
        <div class="mg-split">
            <nav class="mg-cats" aria-label=mt("config_files")>
                {files.into_iter().map(|f| { let name = text_of(&f, "file"); let n = name.clone(); let n2 = name.clone(); let ch = f.get("changed").and_then(Value::as_u64).unwrap_or(0); view! {
                    <button type="button" class=move || if pick.get() == n { "mg-cat on" } else { "mg-cat" } on:click=move |_| open(n2.clone())>
                        <span>{name}</span><span class="n">{(ch > 0).then(|| format!("{ch} {} / ", mt("config_changed"))).unwrap_or_default()}{f.get("count").and_then(Value::as_u64).unwrap_or(0)}</span>
                    </button> } }).collect_view()}
            </nav>
            <section class="mg-list">
                <p class="mg-hint">{mt("config_pristine")}</p>
                {move || if pick.get().is_empty() {
                    view! { <p class="empty">{mt("config_pick")}</p> }.into_any()
                } else {
                    match keys.get() {
                        None => view! { <p class="empty">{mt("loading")}</p> }.into_any(),
                        Some(Err(e)) => view! { <p class="empty">{e}</p> }.into_any(),
                        Some(Ok(k)) => {
                            let all: Vec<Value> = k.get("keys").and_then(Value::as_array).cloned().unwrap_or_default();
                            view! {
                                <div class="mg-bar"><input class="mg-input txt" type="search" placeholder=mt("filter") aria-label=mt("filter_label") on:input=move |e| filter.set(event_target_value(&e).to_lowercase()) /></div>
                                {move || {
                                    let f = filter.get();
                                    let shown: Vec<Opt> = all.iter().filter(|s| matches(&f, &[&text_of(s, "key"), &text_of(s, "doc")])).take(rows_max).map(Opt::from_file_key).collect();
                                    if shown.is_empty() { view! { <p class="empty">{mt("empty")}</p> }.into_any() } else {
                                        view! { <div class="mg-card">{shown.into_iter().map(|o| view! { <OptRow opt=o done=done /> }).collect_view()}</div> }.into_any()
                                    }
                                }}
                            }.into_any()
                        }
                    }
                }}
            </section>
        </div>
    }
}

/// One check: its hook events, its fire counts and, where it has one, its switch.
#[component]
fn CheckRow(check: Value, reload: Callback<()>) -> impl IntoView {
    let fb = RwSignal::new(Fb::Idle);
    let pending = RwSignal::new(None::<Pending>);
    let name = text_of(&check, "name");
    let setting = text_of(&check, "setting");
    let on = check.get("on").and_then(Value::as_bool);
    let note = text_of(&check, "safety_note");
    let guard = list_of("guard_categories").contains(&text_of(&check, "category")) || !note.is_empty();
    let consequence = if note.is_empty() { mt("confirm_generic") } else { fill(&mt("confirm_consequence"), &[("note", &note)]) };
    let events: Vec<String> = check.get("events").and_then(Value::as_array).map(|l| l.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let fires = check.get("fires").and_then(Value::as_u64);
    let blocks = check.get("outcomes").and_then(|o| o.get("block")).and_then(Value::as_u64).unwrap_or(0);
    let toggle = match (on, setting.is_empty()) {
        (Some(on), false) => {
            let (setting, consequence) = (setting.clone(), consequence.clone());
            view! { <Switch on=on label=name.clone() disabled=false click=Callback::new(move |v: bool| {
                // switching a safety guard off asks first; switching anything on is never risky
                if guard && !v { pending.set(Some(Pending { op: "set".into(), key: setting.clone(), value: v.to_string(), consequence: consequence.clone() })); }
                else { run_write(fb, pending, "set", &setting, &v.to_string(), false, false, reload); }
            }) /> }
            .into_any()
        }
        _ => view! { <span class="mg-ro">{mt("checks_no_switch")}</span> }.into_any(),
    };
    view! {
        <div class=if on == Some(false) { "mg-row off" } else { "mg-row" }>
            <div class="mg-main">
                <div class="mg-title">
                    <span class="mg-name">{name.clone()}</span>
                    {guard.then(|| view! { <span class="mg-badge warn">{mt("safety")}</span> })}
                    {(!setting.is_empty()).then(|| view! { <span class="mg-badge" title=text_of(&check, "setting_doc")>{mt("checks_switch")} " " {setting.clone()}</span> })}
                </div>
                <p class="mg-doc">{text_of(&check, "summary")}</p>
                {(!setting.is_empty()).then(|| view! { <p class="mg-meta">{mt("checks_switch")} ": " {text_of(&check, "setting_doc")}</p> })}
                <p class="mg-meta">
                    {mt("checks_events")} ": " {events.iter().map(|e| view! { <span class="mg-chip">{e.clone()}</span> }).collect_view()}
                    " \u{b7} " {match fires { Some(n) => format!("{n} {}{}", mt("checks_fires"), if blocks > 0 { format!(", {blocks} {}", mt("checks_block")) } else { String::new() }), None => mt("checks_fire_none") }}
                </p>
            </div>
            <div class="mg-side">{toggle}</div>
            <ConfirmBox pending=pending fb=fb done=reload />
            <FbLine fb=fb />
        </div>
    }
}

#[component]
fn ChecksTab(data: Arc<Value>, reload: Callback<()>) -> impl IntoView {
    let filter = RwSignal::new(String::new());
    let checks: Arc<Vec<Value>> = Arc::new(rows_of(&data, "checks").into_iter().cloned().collect());
    let guard_cats = list_of("guard_categories");
    view! {
        <section class="mg-list wide">
            <div class="mg-bar"><input class="mg-input txt" type="search" placeholder=mt("filter") aria-label=mt("filter_label") on:input=move |e| filter.set(event_target_value(&e).to_lowercase()) /></div>
            {move || {
                let f = filter.get();
                let (guards, others): (Vec<&Value>, Vec<&Value>) = checks.iter().filter(|c| matches(&f, &[&text_of(c, "name"), &text_of(c, "summary")])).partition(|c| guard_cats.contains(&text_of(c, "category")) || !text_of(c, "safety_note").is_empty());
                if guards.is_empty() && others.is_empty() { return view! { <p class="empty">{mt("checks_none")}</p> }.into_any(); }
                view! {
                    <div class="mg-card"><h2>{mt("checks_guards")}</h2>{guards.into_iter().map(|c| view! { <CheckRow check=c.clone() reload=reload /> }).collect_view()}</div>
                    <div class="mg-card"><h2>{mt("checks_all")}</h2>{others.into_iter().map(|c| view! { <CheckRow check=c.clone() reload=reload /> }).collect_view()}</div>
                }.into_any()
            }}
        </section>
    }
}

/// One Jev integration: a choice of its mode.
#[component]
fn JevRow(item: Value, doc: String, reload: Callback<()>) -> impl IntoView {
    let fb = RwSignal::new(Fb::Idle);
    let pending = RwSignal::new(None::<Pending>);
    let id = text_of(&item, "id");
    let mode = text_of(&item, "mode");
    let key = format!("{}{id}", expect_context::<M>().0.get("jev_prefix").and_then(Value::as_str).unwrap_or_default());
    let modes = list_of("jev_modes");
    view! {
        <div class="mg-row">
            <div class="mg-main">
                <div class="mg-title"><span class="mg-name">{id.clone()}</span><span class=format!("mg-badge mode-{mode}")>{mt(&mode)}</span></div>
                <p class="mg-doc">{doc}</p>
                <p class="mg-meta">{mt("jev_log")} ": " {text_of(&item, "logs")}</p>
            </div>
            <div class="mg-side">
                <div class="seg" role="group" aria-label=id.clone()>
                    {modes.into_iter().map(|m| { let (key, m2, on) = (key.clone(), m.clone(), m == mode); view! {
                        <button type="button" class=if on { "on" } else { "" } title=mt(&format!("mode_{m}")) on:click=move |_| if !on { run_write(fb, pending, "set", &key, &m2, false, false, reload) }>{mt(&m)}</button>
                    } }).collect_view()}
                </div>
            </div>
            <FbLine fb=fb />
        </div>
    }
}

#[component]
fn JevTab(data: Arc<Value>, reload: Callback<()>) -> impl IntoView {
    let prefix = expect_context::<M>().0.get("jev_prefix").and_then(Value::as_str).unwrap_or_default().to_string();
    let docs: Vec<(String, String)> = rows_of(&data, "settings").into_iter().map(|s| (text_of(s, "id"), text_of(s, "description"))).collect();
    let items: Vec<Value> = data.get("jev").and_then(Value::as_array).cloned().unwrap_or_default();
    view! {
        <section class="mg-list wide">
            <h2 class="mg-h">{mt("jev_title")}</h2>
            <p class="mg-hint">{mt("jev_hint")}</p>
            <div class="mg-card">
                {items.into_iter().map(|i| { let doc = docs.iter().find(|(k, _)| *k == format!("{prefix}{}", text_of(&i, "id"))).map(|(_, d)| d.clone()).unwrap_or_default(); view! { <JevRow item=i doc=doc reload=reload /> } }).collect_view()}
            </div>
        </section>
    }
}

/// One change of the history with its Undo button.
#[component]
fn HistoryRow(row: Value, reload: Callback<()>) -> impl IntoView {
    let fb = RwSignal::new(Fb::Idle);
    let pending = RwSignal::new(None::<Pending>);
    let id = text_of(&row, "id");
    let verb = text_of(&row, "verb");
    let ok = text_of(&row, "result") == "ok";
    let undone = row.get("undone") == Some(&Value::Bool(true));
    let can_undo = ok && verb != "undo" && !undone;
    let none = mt("history_none_old");
    let val = |k: &str| row.get(k).filter(|v| !v.is_null()).map_or_else(|| none.clone(), show);
    let (old, new) = (val("old"), val("new"));
    let ts = row.get("ts").and_then(Value::as_u64).unwrap_or(0);
    let id2 = id.clone();
    let when: String = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(ts as f64)).to_locale_string("default", &wasm_bindgen::JsValue::UNDEFINED).into();
    view! {
        <div class=if ok { "mg-row" } else { "mg-row off" }>
            <div class="mg-main">
                <div class="mg-title">
                    <span class="mg-name">{mt(&if verb == "undo" { "history_undo_verb".to_string() } else { format!("history_{verb}") })} " " {text_of(&row, "key")}</span>
                    {undone.then(|| view! { <span class="mg-badge">{mt("history_undone")}</span> })}
                    {(!ok).then(|| view! { <span class="mg-badge warn">{mt("history_failed")}</span> })}
                </div>
                <p class="mg-doc"><span class="mono">{old}</span> " \u{2192} " <span class="mono">{new}</span></p>
                <p class="mg-meta">{when} " \u{b7} " {crate::since(ts)}{(!ok).then(|| format!(" \u{b7} {}", text_of(&row, "error")))}</p>
            </div>
            <div class="mg-side">
                {can_undo.then(|| view! { <button type="button" class="mg-btn" title=mt("history_undo_row") on:click=move |_| run_write(fb, pending, "undo", &id2, "", false, false, reload)>{mt("history_undo")}</button> })}
            </div>
            <FbLine fb=fb />
            {move || matches!(fb.get(), Fb::Bad(_)).then(|| { let id = id.clone(); view! { <div class="mg-btns"><button type="button" class="mg-btn danger" on:click=move |_| run_write(fb, pending, "undo", &id, "", false, true, reload)>{mt("history_force")}</button></div> } })}
        </div>
    }
}

#[component]
fn HistoryTab(store: Store, reload: Callback<()>) -> impl IntoView {
    view! {
        <section class="mg-list wide">
            <h2 class="mg-h">{mt("history_title")}</h2>
            {move || match store.hist.get() {
                None => view! { <p class="empty">{mt("loading")}</p> }.into_any(),
                Some(Err(e)) => view! { <p class="empty">{e}</p> }.into_any(),
                Some(Ok(h)) => {
                    let rows: Vec<Value> = h.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
                    if rows.is_empty() { return view! { <p class="empty">{mt("history_empty")}</p> }.into_any(); }
                    view! { <div class="mg-card">{rows.into_iter().map(|r| view! { <HistoryRow row=r reload=reload /> }).collect_view()}</div> }.into_any()
                }
            }}
        </section>
    }
}
