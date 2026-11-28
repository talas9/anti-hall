//! What a view draws while its data loads or after it stops arriving: a skeleton of its final layout, an error line that names the
//! endpoint with a retry once `web.load_timeout_ms` has passed, and a "stale since" note when data on screen stops updating.
use super::{now_ms, tx};
use ah_web_proto::{is_stale, Boot, Load, LoadClock};
use leptos::prelude::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use wasm_bindgen_futures::JsFuture;

pub(crate) async fn sleep_ms(ms: i32) {
    let p = js_sys::Promise::new(&mut |ok: js_sys::Function, _| {
        if let Some(w) = web_sys::window() {
            let _ = w.set_timeout_with_callback_and_timeout_and_arguments_0(&ok, ms);
        }
    });
    let _ = JsFuture::from(p).await;
}

/// "HH:MM" in the browser's local time.
pub(crate) fn hm(ts_ms: u64) -> String {
    let d = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(ts_ms as f64));
    format!("{:02}:{:02}", d.get_hours(), d.get_minutes())
}

/// Grey blocks in the shape of the final layout: `rows` (a list or table), `cards` (stat figures and a chart frame) or `tree` (indented lines).
#[component]
pub(crate) fn Skel(#[prop(default = "rows")] shape: &'static str) -> impl IntoView {
    let boot = expect_context::<Arc<Boot>>();
    let n = if shape == "cards" { boot.skeleton_stats } else { boot.skeleton_rows };
    view! {
        <div class=format!("skel skel-{shape}") aria-busy="true" aria-label=tx("h_waiting")>
            {(shape == "cards").then(|| view! { <div class="skel-stats">{(0..n).map(|_| view! { <i class="skel-stat"></i> }).collect_view()}</div><i class="skel-chart"></i> })}
            {(shape != "cards").then(|| (0..n).map(|i| view! { <i class=if shape == "tree" && i % 3 != 0 { "skel-row skel-in" } else { "skel-row" }></i> }).collect_view())}
        </div>
    }
}

/// The skeleton until `have`, then nothing; an error line with a retry when the read failed or took longer than the timeout.
#[component]
pub(crate) fn Pending(have: Signal<bool>, failed: Signal<bool>, endpoint: &'static str, retry: impl Fn() + Copy + Send + Sync + 'static, #[prop(default = "rows")] shape: &'static str) -> impl IntoView {
    let boot = expect_context::<Arc<Boot>>();
    let timeout = boot.load_timeout_ms;
    let tick = boot.load_tick_ms.max(1);
    // Mounted when its view opens (every caller wraps it in the view's own `Show`), so the clock starts with the fetch.
    let clock = RwSignal::new(LoadClock::new(tick));
    let alive = Arc::new(AtomicBool::new(true));
    let flag = alive.clone();
    on_cleanup(move || flag.store(false, Ordering::Relaxed));
    leptos::task::spawn_local(async move {
        while alive.load(Ordering::Relaxed) && !have.get_untracked() {
            sleep_ms(tick.min(i32::MAX as u64) as i32).await;
            clock.update(|c| {
                c.tick();
            });
        }
    });
    move || match clock.get().state(have.get(), failed.get(), timeout) {
        Load::Data => ().into_any(),
        Load::Skeleton => view! { <Skel shape=shape /> }.into_any(),
        Load::Error => view! {
            <p class="load-err" role="alert">
                <span class="load-ep">{endpoint}</span> " " {tx("load_failed")}
                <button type="button" class="chip" on:click=move |_| { clock.update(LoadClock::reset); retry(); }>{tx("load_retry")}</button>
            </p>
        }
        .into_any(),
    }
}

/// "Stale since HH:MM" while data that is on screen has stopped updating (`last_ok` is the time of the last good read, 0 = none).
#[component]
pub(crate) fn StaleNote(failed: Signal<bool>, last_ok: Signal<u64>) -> impl IntoView {
    let boot = expect_context::<Arc<Boot>>();
    let (after, tick) = (boot.stale_after_ms, boot.stale_tick_ms.max(1).min(i32::MAX as u64) as i32);
    let now = RwSignal::new(now_ms());
    let alive = Arc::new(AtomicBool::new(true));
    let flag = alive.clone();
    on_cleanup(move || flag.store(false, Ordering::Relaxed));
    leptos::task::spawn_local(async move {
        while alive.load(Ordering::Relaxed) {
            sleep_ms(tick).await;
            now.set(now_ms());
        }
    });
    move || is_stale(failed.get(), last_ok.get(), now.get(), after).then(|| view! { <p class="stale" role="status">{tx("stale_since").replace("{t}", &hm(last_ok.get()))}</p> })
}
