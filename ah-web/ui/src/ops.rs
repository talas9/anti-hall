//! The Accounts & usage, Updates and Logs screens. Every text is a label from the boot data (merged in from `web_ops.toml`) and every
//! number comes from `/api/ops/config`; this file carries neither. The screens poll only while shown and while the browser tab is
//! visible, so nothing is asked of the server when nobody is looking. Full draws ring gauges that ease between readings; Lite draws
//! the same numbers as flat bars (the CSS picks by the page's `data-mode`), with the same data and the same actions.
use super::{compact, fmt_age, now_ms, since, tx, Ctx};
use ah_web_proto::ops::{Accounts, Bucket, LogLine, LogTail, OpsCfg, UpdateCheck, OPS_ACCOUNTS_PATH, OPS_CFG_PATH, OPS_LOGS_PATH, OPS_UPDATE_PATH};
use ah_web_proto::Boot;
use leptos::prelude::*;
use std::cell::Cell;
use std::collections::BTreeSet;
use std::future::Future;
use std::rc::Rc;
use std::sync::Arc;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{RequestInit, Response};

/// One request; the body of an answer that is not a success is an error.
async fn fetch_text(method: &str, url: &str) -> Result<String, String> {
    let window = web_sys::window().ok_or("no window")?;
    let init = RequestInit::new();
    init.set_method(method);
    let resp = JsFuture::from(window.fetch_with_str_and_init(url, &init)).await.map_err(|_| "network".to_string())?;
    let resp: Response = resp.dyn_into().map_err(|_| "response".to_string())?;
    let ok = resp.ok();
    let text = JsFuture::from(resp.text().map_err(|_| "body".to_string())?).await.map_err(|_| "body".to_string())?.as_string().unwrap_or_default();
    if ok { Ok(text) } else { Err(text.chars().take(120).collect()) }
}

async fn sleep_ms(ms: u64) {
    let promise = js_sys::Promise::new(&mut |resolve, _| {
        if let Some(w) = web_sys::window() {
            let _ = w.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms.min(i32::MAX as u64) as i32);
        }
    });
    let _ = JsFuture::from(promise).await;
}

/// The browser tab is on screen.
fn visible() -> bool {
    web_sys::window().and_then(|w| w.document()).is_none_or(|d| !d.hidden())
}

/// Run `tick` every `ms` while `on` is true and the tab is visible; it stops when `on` turns false (and starts afresh when it is true again).
fn poll<F, Fut>(on: Signal<bool>, ms: impl Fn() -> u64 + 'static, tick: F)
where
    F: Fn() -> Fut + Clone + 'static,
    Fut: Future<Output = ()> + 'static,
{
    let generation = Rc::new(Cell::new(0u64));
    Effect::new(move |_| {
        let run = on.get();
        generation.set(generation.get() + 1);
        if !run {
            return;
        }
        let (mine, every) = (generation.get(), ms());
        let (generation, tick) = (generation.clone(), tick.clone());
        leptos::task::spawn_local(async move {
            while generation.get() == mine {
                if visible() {
                    tick().await;
                }
                sleep_ms(every).await;
            }
        });
    });
}

/// The three screens, one of which is shown when `screen` is 1 (accounts), 2 (updates) or 3 (logs); 0 shows none of them.
#[component]
pub fn OpsScreens(screen: RwSignal<u8>) -> impl IntoView {
    let cfg = RwSignal::new(None::<OpsCfg>);
    let loading = RwSignal::new(false);
    let failed = RwSignal::new(false);
    // the numbers are fetched the first time a screen opens; a failure is tried again when a screen is opened again
    Effect::new(move |_| {
        if screen.get() == 0 || cfg.with_untracked(Option::is_some) || loading.get_untracked() {
            return;
        }
        loading.set(true);
        failed.set(false);
        leptos::task::spawn_local(async move {
            match fetch_text("GET", OPS_CFG_PATH).await.and_then(|t| serde_json::from_str::<OpsCfg>(&t).map_err(|e| e.to_string())) {
                Ok(c) => cfg.set(Some(c)),
                Err(_) => failed.set(true),
            }
            loading.set(false);
        });
    });
    let shown = move |n: u8| Signal::derive(move || screen.get() == n && cfg.with(Option::is_some));
    let hide = move |n: u8| move || screen.get() != n;
    view! {
        <main class="main ops-main" hidden=hide(1)>
            <Notice cfg=cfg failed=failed />
            <AccountsScreen active=shown(1) cfg=cfg />
        </main>
        <main class="main ops-main" hidden=hide(2)>
            <UpdatesScreen />
        </main>
        <main class="main ops-main" hidden=hide(3)>
            <Notice cfg=cfg failed=failed />
            <LogsScreen active=shown(3) cfg=cfg />
        </main>
    }
}

/// "Loading" or "could not load" until the config is here.
#[component]
fn Notice(cfg: RwSignal<Option<OpsCfg>>, failed: RwSignal<bool>) -> impl IntoView {
    view! {
        <Show when=move || cfg.with(Option::is_none)>
            <p class="soft-note">{move || if failed.get() { tx("ops_failed") } else { tx("ops_loading") }}</p>
        </Show>
    }
}

// ---------------------------------------------------------------------------------------------------------------- Accounts

/// A usage bucket as a gauge: ring (Full) or bar (Lite), percent, reset countdown, and a warning near the limit.
#[component]
fn Gauge(bucket: Bucket, cfg: OpsCfg, now: RwSignal<u64>) -> impl IntoView {
    let reset_ms = js_sys::Date::parse(&bucket.resets_at);
    let known = reset_ms.is_finite();
    let raw = bucket.percent;
    // a bucket whose reset time has passed counts as empty, as the engine's own limit check reads it
    let passed = move || known && (reset_ms as u64) < now.get();
    let pct = move || if passed() { 0.0 } else { raw.clamp(0.0, 100.0) };
    let (warn, bad) = (cfg.warn_pct, cfg.bad_pct);
    let tone = move || {
        let p = pct();
        if p >= bad { "g-bad" } else if p >= warn { "g-warn" } else { "g-ok" }
    };
    let countdown = move || {
        if !known {
            tx("ops_reset_unknown")
        } else if passed() {
            tx("ops_reset_passed")
        } else {
            format!("{} {}", tx("ops_resets_in"), fmt_age((reset_ms as u64).saturating_sub(now.get()) / 1000))
        }
    };
    let warning = move || {
        let p = pct();
        if p >= bad { Some(tx("ops_at_limit")) } else if p >= warn { Some(tx("ops_near_limit")) } else { None }
    };
    view! {
        <div class=move || format!("gauge {}", tone())>
            <div class="ring" style=move || format!("--p:{:.1}", pct()) role="img" aria-label=format!("{} {:.0}%", bucket.label, raw)><span>{move || format!("{:.0}%", pct())}</span></div>
            <div class="g-body">
                <div class="g-name">{bucket.label.clone()}</div>
                <div class="g-bar" aria-hidden="true"><i style=move || format!("width:{:.1}%", pct())></i></div>
                <div class="g-pct">{move || format!("{:.0}%", pct())}</div>
                <div class="g-reset">{countdown}</div>
                {move || warning().map(|w| view! { <div class="g-warn-text" role="status">{w}</div> })}
            </div>
        </div>
    }
}

#[component]
fn AccountsScreen(active: Signal<bool>, cfg: RwSignal<Option<OpsCfg>>) -> impl IntoView {
    let data = RwSignal::new(None::<Accounts>);
    let failed = RwSignal::new(false);
    let now = RwSignal::new(now_ms());
    let ms = move |pick: fn(&OpsCfg) -> u64| move || cfg.with_untracked(|c| c.as_ref().map_or(0, pick)).max(1);
    poll(active, ms(|c| c.poll_accounts_ms), move || async move {
        match fetch_text("GET", OPS_ACCOUNTS_PATH).await.and_then(|t| serde_json::from_str::<Accounts>(&t).map_err(|e| e.to_string())) {
            Ok(a) => {
                failed.set(false);
                data.set(Some(a));
            }
            Err(_) => failed.set(true),
        }
    });
    poll(active, ms(|c| c.tick_ms), move || async move { now.set(now_ms()) });
    view! {
        <div class="main-head"><h1>{tx("ops_accounts_title")}</h1></div>
        <p class="soft-note">{tx("ops_accounts_hint")}</p>
        <Show when=move || failed.get()><p class="fb fb-bad" role="status">{tx("ops_failed")}</p></Show>
        {move || {
            let (Some(a), Some(c)) = (data.get(), cfg.get()) else { return view! { <p class="soft-note">{tx("ops_loading")}</p> }.into_any() };
            let stale = a.usage_read_ms > 0 && now_ms().saturating_sub(a.usage_read_ms) > c.stale_ms;
            let buckets = a.buckets.clone();
            let cost = a.cost_rows.clone();
            let collapsed = RwSignal::new(std::collections::HashSet::<String>::new());
            view! {
                <div class="ops-grid">
                    <section class="card ops-card">
                        <div class="ops-card-head">
                            <strong>{tx("ops_claude")}</strong>
                            <span class=if a.claude.signed_in { "pill pill-ok" } else { "pill pill-warn" }>{if a.claude.signed_in { tx("ops_signed_in") } else { tx("ops_signed_out") }}</span>
                        </div>
                        {(!a.claude.email.is_empty()).then(|| view! { <div class="acct-who"><span class="acct-email">{a.claude.email.clone()}</span>{(!a.claude.name.is_empty()).then(|| view! { <span class="acct-name">{a.claude.name.clone()}</span> })}</div> })}
                        <dl class="kv">
                            {a.claude.fields.iter().map(|f| { let tip = (!f.raw.is_empty()).then(|| format!("{}: {}", tx("ops_raw_tip"), f.raw)); view! { <dt>{tx(&f.label_key)}</dt><dd title=tip>{f.text.clone()}</dd> } }).collect_view()}
                        </dl>
                        {(!a.claude.fingerprint.is_empty()).then(|| view! { <p class="acct-id">{tx("ops_fingerprint")} " " {a.claude.fingerprint.clone()}</p> })}
                    </section>
                    <section class="card ops-card">
                        <div class="ops-card-head">
                            <strong>{tx("ops_codex")}</strong>
                            <span class=if a.codex.signed_in { "pill pill-ok" } else { "pill pill-warn" }>{if a.codex.signed_in { tx("ops_codex_signed_in") } else { tx("ops_codex_signed_out") }}</span>
                        </div>
                        <dl class="kv">
                            {a.codex.signed_in.then(|| view! { <dt>{tx("ops_codex_changed")}</dt><dd>{since(a.codex.changed_ms)}</dd> })}
                        </dl>
                        {a.codex.signed_in.then(|| view! { <p class="soft-note">{tx("ops_codex_no_details")}</p> })}
                        <p class="soft-note">{tx("ops_codex_usage")}</p>
                    </section>
                    <section class="card ops-card ops-later" aria-disabled="true">
                        <div class="ops-card-head">
                            <strong>{tx("ops_swap_title")}</strong>
                            <span class="pill">{tx("ops_swap_later")}</span>
                        </div>
                        <p class="soft-note">{tx("ops_swap_hint")}</p>
                    </section>
                </div>
                <section class="card ops-card">
                    <div class="ops-card-head">
                        <strong>{tx("ops_usage_title")}</strong>
                        {(a.usage_read_ms > 0).then(|| view! { <span class="soft-note">{tx("ops_usage_age")} " " {since(a.usage_read_ms)}</span> })}
                        {stale.then(|| view! { <span class="pill pill-warn">{tx("ops_usage_stale")}</span> })}
                    </div>
                    {if a.usage_error {
                        view! { <p class="fb fb-bad">{tx("ops_usage_error")}</p> }.into_any()
                    } else if buckets.is_empty() {
                        view! { <p class="soft-note">{tx("ops_usage_none")}</p> }.into_any()
                    } else {
                        view! { <div class="gauges">{buckets.into_iter().map(|b| view! { <Gauge bucket=b cfg=c.clone() now=now /> }).collect_view()}</div> }.into_any()
                    }}
                </section>
                <section class="card ops-card">
                    <div class="ops-card-head">
                        <strong>{tx("ops_cost_title")}</strong>
                        {a.cost_ok.then(|| view! { <span class="soft-note">{tx("ops_cost_total")} ": " {compact(a.cost_total_tokens)} " " {tx("ops_cost_tokens")} " \u{b7} " {compact(a.cost_total_outcomes)} " " {tx("ops_cost_outcomes")}</span> })}
                    </div>
                    {if !a.cost_ok || cost.is_empty() {
                        view! { <p class="soft-note">{tx("ops_cost_none")}</p> }.into_any()
                    } else {
                        view! {
                            <table class="ops-table">
                                <thead><tr><th>{tx("ops_cost_agent")}</th><th>{tx("ops_cost_kind")}</th><th class="num">{tx("ops_cost_tokens")}</th><th class="num">{tx("ops_cost_outcomes")}</th><th class="num">{tx("ops_cost_per")}</th></tr></thead>
                                <tbody>
                                    {move || {
                                        // a row is hidden while a row above it, one level up, is folded
                                        let mut hide_below: Option<usize> = None;
                                        let folded = collapsed.get();
                                        cost.iter().filter(|r| {
                                            let depth = r.guides.len();
                                            if r.header { hide_below = None; return true; }
                                            if let Some(d) = hide_below { if depth > d { return false; } hide_below = None; }
                                            if r.kids && folded.contains(&r.agent) { hide_below = Some(depth); }
                                            true
                                        }).cloned().collect::<Vec<_>>().into_iter().map(|r| {
                                        if r.header {
                                            return view! { <tr class="cost-group"><td colspan="2">{r.name.clone()}</td><td class="num">{compact(r.tokens)}</td><td class="num">{compact(r.outcomes)}</td><td class="num">{compact(r.tokens_per_outcome)}</td></tr> }.into_any();
                                        }
                                        let name = r.name.clone();
                                        let kind = { let k = format!("kind_{}", r.kind); let t = tx(&k); if t == k { r.kind.clone() } else { t } };
                                        view! { <tr><td title=r.agent.clone()><span class="tree-cell"><crate::Guides guides=r.guides.clone() /><crate::Twist key=r.agent.clone() kids=r.kids collapsed=collapsed label_key="agent_toggle" /><span class="tree-name">{name}</span></span></td><td>{kind}</td><td class="num">{compact(r.tokens)}</td><td class="num">{compact(r.outcomes)}</td><td class="num">{compact(r.tokens_per_outcome)}</td></tr> }.into_any()
                                    }).collect_view() }}
                                </tbody>
                            </table>
                        }.into_any()
                    }}
                </section>
            }.into_any()
        }}
    }
}

// ---------------------------------------------------------------------------------------------------------------- Updates

#[component]
fn UpdatesScreen() -> impl IntoView {
    let boot = expect_context::<Arc<Boot>>();
    let ctx = expect_context::<Ctx>();
    let result = RwSignal::new(None::<UpdateCheck>);
    let busy = RwSignal::new(false);
    let none = tx("ops_ver_unknown");
    let pulse = move |f: fn(&ah_web_proto::Pulse) -> String| ctx.snap.with(|s| s.pulse.as_ref().map(f)).filter(|v| !v.is_empty());
    let plugin = boot.plugin_version.clone();
    let web = boot.web_version.clone();
    let skew = {
        let plugin = plugin.clone();
        move || pulse(|p| p.plugin_version.clone()).is_some_and(|e| !plugin.is_empty() && e != plugin)
    };
    let check = move |_| {
        if busy.get_untracked() {
            return;
        }
        busy.set(true);
        leptos::task::spawn_local(async move {
            let r = fetch_text("POST", OPS_UPDATE_PATH).await.and_then(|t| serde_json::from_str::<UpdateCheck>(&t).map_err(|e| e.to_string()));
            result.set(Some(r.unwrap_or_default()));
            busy.set(false);
        });
    };
    let (n1, n2, n3, n4) = (none.clone(), none.clone(), none.clone(), none.clone());
    view! {
        <div class="main-head"><h1>{tx("ops_updates_title")}</h1></div>
        <p class="soft-note">{tx("ops_updates_hint")}</p>
        <section class="card ops-card">
            <dl class="kv">
                <dt>{tx("ops_ver_plugin")}</dt><dd>{if plugin.is_empty() { n1 } else { format!("v{plugin}") }}</dd>
                <dt>{tx("ops_ver_engine")}</dt><dd>{move || pulse(|p| p.version.clone()).unwrap_or_else(|| n2.clone())}</dd>
                <dt>{tx("ops_ver_build")}</dt><dd>{move || pulse(|p| p.build_sha.clone()).unwrap_or_else(|| n3.clone())}</dd>
                {move || pulse(|p| p.plugin_version.clone()).map(|v| view! { <dt>{tx("ops_ver_engine_plugin")}</dt><dd>{format!("v{v}")}</dd> })}
                <dt>{tx("ops_ver_hook")}</dt><dd>{move || pulse(|p| p.hook_version.clone()).unwrap_or_else(|| n4.clone())}</dd>
                <dt>{tx("ops_ver_web")}</dt><dd>{format!("v{web}")}</dd>
            </dl>
            <Show when=skew><p class="fb fb-bad" role="status">{tx("ops_skew")}</p></Show>
        </section>
        <section class="card ops-card">
            <div class="ops-card-head">
                <strong>{tx("ops_check_title")}</strong>
                <button type="button" class="btn primary ops-btn" disabled=move || busy.get() on:click=check>{move || if busy.get() { tx("ops_checking") } else { tx("ops_check_button") }}</button>
            </div>
            {move || match result.get() {
                None if busy.get() => view! { <p class="soft-note" role="status">{tx("ops_checking_note")}</p> }.into_any(),
                None => view! { <p class="soft-note">{tx("ops_check_never")}</p> }.into_any(),
                Some(c) if !c.ok => view! { <p class="fb fb-bad" role="status">{tx("ops_check_failed")} " " <span class="fb-note">{c.message.clone()}</span></p> }.into_any(),
                Some(c) => view! {
                    <dl class="kv">
                        {(!c.channel.is_empty()).then(|| view! { <dt>{tx("ops_check_channel")}</dt><dd>{c.channel.clone()}</dd> })}
                        <dt>{tx("ops_check_installed")}</dt><dd>{if c.installed.is_empty() { tx("ops_ver_unknown") } else { c.installed.clone() }}</dd>
                        <dt>{tx("ops_check_latest")}</dt><dd>{if c.latest.is_empty() { tx("ops_ver_unknown") } else { c.latest.clone() }}</dd>
                        <dt>{tx("ops_check_result")}</dt><dd>{match c.state.as_str() {
                            "unknown" | "lagging" => tx(&format!("ops_check_{}", c.state)),
                            _ if c.available => tx("ops_check_available"),
                            _ => tx("ops_check_current"),
                        }}</dd>
                        <dt>{tx("ops_check_at")}</dt><dd>{since(c.checked_ms)}</dd>
                    </dl>
                    <p class="soft-note">{c.message.clone()}</p>
                    {c.available.then(|| view! {
                        <div><div class="sect">{tx("ops_check_changelog")}</div><p class="soft-note">{tx("ops_check_changelog_none")}</p><p class="soft-note">{tx("ops_check_apply")}</p></div>
                    })}
                    <p class="soft-note">{tx("ops_check_readonly")}</p>
                }.into_any(),
            }}
        </section>
    }
}

// ---------------------------------------------------------------------------------------------------------------- Logs

/// Everything the Logs screen keeps; all signals, so the whole bundle is `Copy`.
#[derive(Clone, Copy)]
struct LogState {
    src: RwSignal<String>,
    lines: RwSignal<Vec<LogLine>>,
    last_ts: RwSignal<u64>,
    truncated: RwSignal<bool>,
    error: RwSignal<String>,
    paused: RwSignal<bool>,
    view_max: RwSignal<usize>,
}

/// Fetch the lines newer than the last one seen and fold them in.
async fn pull(st: LogState) {
    let src = st.src.get_untracked();
    if src.is_empty() || st.paused.get_untracked() {
        return;
    }
    let url = format!("{OPS_LOGS_PATH}?src={src}&since={}", st.last_ts.get_untracked());
    let tail = fetch_text("GET", &url).await.and_then(|t| serde_json::from_str::<LogTail>(&t).map_err(|e| e.to_string()));
    // the person switched source while this was in flight: it is not this source's answer any more
    if st.src.get_untracked() != src {
        return;
    }
    match tail {
        Ok(t) if t.ok => {
            st.error.set(String::new());
            st.truncated.set(t.truncated);
            if let Some(last) = t.lines.last() {
                st.last_ts.set(last.ts_ms);
            }
            if !t.lines.is_empty() {
                let max = st.view_max.get_untracked().max(1);
                st.lines.update(|v| {
                    v.extend(t.lines);
                    let over = v.len().saturating_sub(max);
                    v.drain(..over);
                });
            }
        }
        Ok(t) => st.error.set(t.error),
        Err(e) => st.error.set(e),
    }
}

fn clock(ts_ms: u64) -> String {
    let d = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(ts_ms as f64));
    format!("{:02}:{:02}:{:02}.{:03}", d.get_hours(), d.get_minutes(), d.get_seconds(), d.get_milliseconds())
}

#[component]
fn LogsScreen(active: Signal<bool>, cfg: RwSignal<Option<OpsCfg>>) -> impl IntoView {
    let st = LogState {
        src: RwSignal::new(String::new()),
        lines: RwSignal::new(Vec::new()),
        last_ts: RwSignal::new(0),
        truncated: RwSignal::new(false),
        error: RwSignal::new(String::new()),
        paused: RwSignal::new(false),
        view_max: RwSignal::new(1),
    };
    let follow = RwSignal::new(true);
    let min_level = RwSignal::new(0usize);
    let comp = RwSignal::new(String::new());
    let query = RwSignal::new(String::new());
    crate::route::bind_num(min_level, "logs.level");
    crate::route::bind_text(comp, "logs.component");
    crate::route::bind_text(query, "logs.search");
    crate::route::bind_text(st.src, "logs.source");
    let list = NodeRef::<leptos::html::Div>::new();
    // the first source and the line cap, once the numbers are here
    Effect::new(move |_| {
        if let Some(c) = cfg.get() {
            st.view_max.set(c.logs_view_max);
            if st.src.get_untracked().is_empty() {
                st.src.set(c.sources.first().map(|s| s.0.clone()).unwrap_or_default());
            }
        }
    });
    poll(active, move || cfg.with_untracked(|c| c.as_ref().map_or(0, |c| c.logs_poll_ms)).max(1), move || pull(st));
    // a switch of source starts clean and reads at once
    let pick = move |id: String| {
        if st.src.get_untracked() == id {
            return;
        }
        st.lines.set(Vec::new());
        st.last_ts.set(0);
        st.truncated.set(false);
        st.error.set(String::new());
        st.src.set(id);
        leptos::task::spawn_local(pull(st));
    };
    let shown = Memo::new(move |_| {
        let levels = cfg.with(|c| c.as_ref().map(|c| c.levels.clone()).unwrap_or_default());
        let (floor, want_comp, needle) = (min_level.get(), comp.get(), query.get().to_lowercase());
        st.lines.with(|v| {
            v.iter()
                .filter(|l| levels.iter().position(|x| *x == l.level).unwrap_or(0) >= floor)
                .filter(|l| want_comp.is_empty() || l.comp == want_comp)
                .filter(|l| needle.is_empty() || l.text.to_lowercase().contains(&needle) || l.comp.to_lowercase().contains(&needle))
                .cloned()
                .collect::<Vec<_>>()
        })
    });
    let comps = Memo::new(move |_| st.lines.with(|v| v.iter().map(|l| l.comp.clone()).filter(|c| !c.is_empty()).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>()));
    // follow: keep the newest line in view
    Effect::new(move |_| {
        shown.track();
        if follow.get_untracked() {
            if let Some(el) = list.get() {
                el.set_scroll_top(el.scroll_height());
            }
        }
    });
    let total = move || st.lines.with(Vec::len);
    let clear = move |_| {
        min_level.set(0);
        comp.set(String::new());
        query.set(String::new());
    };
    view! {
        <div class="main-head">
            <h1>{tx("ops_logs_title")}</h1>
            <span class="counts">{move || {
                let n = shown.with(Vec::len);
                if n == total() { format!("{n} {}", tx("ops_log_lines")) } else { format!("{n} {} \u{b7} {} {}", tx("ops_log_shown"), total(), tx("ops_log_lines")) }
            }}</span>
            <span class="conn">{move || if st.paused.get() { tx("ops_log_paused") } else { String::new() }}</span>
        </div>
        <p class="soft-note">{tx("ops_logs_hint")}</p>
        <div class="ops-filters">
            <div class="seg" role="group" aria-label=tx("ops_log_source")>
                {move || cfg.get().map(|c| c.sources.into_iter().map(|(id, key)| {
                    let (id2, id3) = (id.clone(), id.clone());
                    view! { <button type="button" class=move || if st.src.get() == id2 { "on" } else { "" } on:click=move |_| pick(id3.clone())>{tx(&key)}</button> }
                }).collect_view())}
            </div>
            <div class="seg" role="group" aria-label=tx("ops_log_level")>
                <button type="button" class=move || if min_level.get() == 0 { "on" } else { "" } on:click=move |_| min_level.set(0)>{tx("ops_log_all")}</button>
                {move || cfg.get().map(|c| c.levels.into_iter().enumerate().skip(1).map(|(i, name)| view! {
                    <button type="button" class=move || if min_level.get() == i { "on" } else { "" } on:click=move |_| min_level.set(i)>{name.clone()}</button>
                }).collect_view())}
            </div>
            <label class="ops-field">
                <span class="sect">{tx("ops_log_component")}</span>
                <select prop:value=move || comp.get() on:change=move |e| comp.set(event_target_value(&e))>
                    <option value="">{tx("ops_log_all")}</option>
                    {move || comps.get().into_iter().map(|c| view! { <option value=c.clone()>{c.clone()}</option> }).collect_view()}
                </select>
            </label>
            <input class="ops-search" type="search" placeholder=tx("ops_log_search") aria-label=tx("ops_log_search") prop:value=move || query.get() on:input=move |e| query.set(event_target_value(&e)) />
            <button type="button" class="btn ops-btn" on:click=clear>{tx("ops_log_clear_filters")}</button>
            <button type="button" class="btn ops-btn" aria-pressed=move || st.paused.get().to_string() on:click=move |_| {
                let p = !st.paused.get_untracked();
                st.paused.set(p);
                if !p { leptos::task::spawn_local(pull(st)); }
            }>{move || if st.paused.get() { tx("ops_log_resume") } else { tx("ops_log_pause") }}</button>
            <label class="ops-check"><input type="checkbox" prop:checked=move || follow.get() on:change=move |e| follow.set(event_target_checked(&e)) /> {tx("ops_log_follow")}</label>
        </div>
        <Show when=move || !st.error.get().is_empty()><p class="fb fb-bad" role="status">{tx("ops_failed")} " " <span class="fb-note">{move || st.error.get()}</span></p></Show>
        <div class="ops-log" node_ref=list tabindex="0" aria-live="off">
            <Show when=move || st.truncated.get()><div class="log-note">{tx("ops_log_truncated")}</div></Show>
            {move || {
                let rows = shown.get();
                if rows.is_empty() {
                    return view! { <p class="soft-note">{tx("ops_log_empty")}</p> }.into_any();
                }
                rows.into_iter().map(|l| view! {
                    <div class=format!("log-line lv-{}", l.level)><time>{clock(l.ts_ms)}</time><b class="lv">{l.level.clone()}</b><span class="lc">{l.comp.clone()}</span><span class="lt">{l.text.clone()}</span></div>
                }).collect_view().into_any()
            }}
        </div>
    }
}
