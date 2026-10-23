//! The Telemetry and Impact screens. The server sends one document per screen (`/api/telemetry`, `/api/impact`) with every sentence,
//! number format and threshold already in it; this file only draws. Sparklines, bars and the Lite charts are Rust SVG/HTML; the Full
//! build draws the zoomable series, the heatmap, the gauge and the waterfall with the vendored chart library (`apex.rs`), loaded
//! when the first of those is shown. A screen builds nothing and reads nothing while it is not the one shown.
use super::{now_ms, tx};
use ah_web_proto::tel::{Cell, Forecast, Heat, ImpactDoc, ImpactRow, Kpi, Mover, Pair, Saving, Step, Table, TelDoc, TelUi};
use leptos::prelude::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::collections::BTreeMap;
#[cfg(feature = "full")]
use std::rc::Rc;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::Response;

const TELEMETRY_PATH: &str = "/api/telemetry";
const IMPACT_PATH: &str = "/api/impact";
const STYLE_ID: &str = "tel-style";
const STYLE_HREF: &str = "/static/tel.css";

// ---- plumbing -------------------------------------------------------------------------------------------------------------

async fn get_json<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, String> {
    let window = web_sys::window().ok_or("no window")?;
    let resp = JsFuture::from(window.fetch_with_str(path)).await.map_err(|_| "network")?;
    let resp: Response = resp.dyn_into().map_err(|_| "response")?;
    let text = JsFuture::from(resp.text().map_err(|_| "body")?).await.map_err(|_| "body")?.as_string().unwrap_or_default();
    serde_json::from_str(&text).map_err(|_| text.chars().take(120).collect())
}

async fn sleep_ms(ms: i32) {
    let p = js_sys::Promise::new(&mut |ok: js_sys::Function, _| {
        if let Some(w) = web_sys::window() {
            let _ = w.set_timeout_with_callback_and_timeout_and_arguments_0(&ok, ms);
        }
    });
    let _ = JsFuture::from(p).await;
}

/// The screens' stylesheet, added to the page the first time one opens.
fn ensure_style() {
    let Some(doc) = web_sys::window().and_then(|w| w.document()) else { return };
    if doc.get_element_by_id(STYLE_ID).is_some() {
        return;
    }
    if let (Ok(link), Some(head)) = (doc.create_element("link"), doc.head()) {
        link.set_id(STYLE_ID);
        let _ = link.set_attribute("rel", "stylesheet");
        let _ = link.set_attribute("href", STYLE_HREF);
        let _ = head.append_child(&link);
    }
}

#[cfg(feature = "full")]
fn is_dark() -> bool {
    let attr = web_sys::window().and_then(|w| w.document()).and_then(|d| d.document_element()).and_then(|e| e.get_attribute("data-theme"));
    match attr.as_deref() {
        Some("light") => false,
        Some("dark") => true,
        _ => web_sys::window().and_then(|w| w.match_media("(prefers-color-scheme: dark)").ok().flatten()).is_some_and(|m| m.matches()),
    }
}

/// Read `path` now and then every `refresh` seconds (the server says how often, after the first read) until the screen is gone.
fn poll<T: serde::de::DeserializeOwned + Send + Sync + 'static>(path: &'static str, doc: RwSignal<Option<T>>, refresh_s: impl Fn(&T) -> u64 + 'static, failed: RwSignal<bool>) {
    let alive = Arc::new(AtomicBool::new(true));
    let flag = alive.clone();
    on_cleanup(move || flag.store(false, Ordering::Relaxed));
    leptos::task::spawn_local(async move {
        let mut wait = 30u64;
        while alive.load(Ordering::Relaxed) {
            match get_json::<T>(path).await {
                Ok(d) => {
                    wait = refresh_s(&d).max(1);
                    failed.set(false);
                    doc.set(Some(d));
                }
                Err(_) => failed.set(true),
            }
            sleep_ms((wait * 1000) as i32).await;
        }
    });
}

fn tt(texts: &BTreeMap<String, String>, key: &str) -> String {
    texts.get(key).cloned().unwrap_or_else(|| key.to_string())
}

fn age_text(ui: &TelUi, texts: &BTreeMap<String, String>, ts_ms: f64) -> String {
    let s = now_ms().saturating_sub(ts_ms as u64) / 1000;
    format!("{} {}", ui.fmt_age.fmt(s), tt(texts, "ago"))
}

/// A figure in its unit: counts as 12k / 1.1M, times as 3 ms, sizes as 2 MB, money as $0.035.
fn fmt_val(ui: &TelUi, texts: &BTreeMap<String, String>, unit: &str, v: f64) -> String {
    let whole = v.max(0.0).round() as u64;
    match unit {
        "us" => ui.fmt_us.fmt(whole),
        "bytes" => ui.fmt_bytes.fmt(whole),
        "usd" => format!("{}{:.*}", tt(texts, "unit_usd"), ui.usd_decimals, v),
        "pct" => format!("{v:.0}%"),
        "ts" => age_text(ui, texts, v),
        _ => ui.number.fmt(whole),
    }
}

fn fmt_cell(ui: &TelUi, texts: &BTreeMap<String, String>, unit: &str, c: &Cell) -> String {
    match c {
        Cell::Text(t) => t.clone(),
        Cell::Num(n) => fmt_val(ui, texts, unit, *n),
    }
}

fn delta_text(d: Option<f64>) -> String {
    d.map_or_else(String::new, |d| format!("{} {:.0}%", if d > 0.5 { "\u{25B2}" } else if d < -0.5 { "\u{25BC}" } else { "\u{25AC}" }, d.abs()))
}

/// Which way a change reads: `ok` when it moved the good way, `bad` the wrong way, `flat` when it did not move.
fn delta_tone(d: Option<f64>, good: &str, flat_below: f64) -> &'static str {
    match d {
        Some(d) if d.abs() >= flat_below => match (good, d > 0.0) {
            ("up", true) | ("down", false) => "ok",
            ("up", false) | ("down", true) => "bad",
            _ => "neutral",
        },
        _ => "flat",
    }
}

// ---- Rust SVG charts ------------------------------------------------------------------------------------------------------

fn extent(series: &[f64]) -> (f64, f64) {
    let max = series.iter().copied().fold(0.0_f64, f64::max);
    (0.0, if max > 0.0 { max } else { 1.0 })
}

fn xy(series: &[f64], w: f64, h: f64, pad: f64, (lo, hi): (f64, f64)) -> Vec<(f64, f64)> {
    let n = series.len().max(2) - 1;
    series.iter().enumerate().map(|(i, v)| (pad + (w - 2.0 * pad) * i as f64 / n as f64, h - pad - (h - 2.0 * pad) * (v - lo) / (hi - lo))).collect()
}

fn path_of(pts: &[(f64, f64)]) -> String {
    pts.iter().enumerate().map(|(i, (x, y))| format!("{}{x:.1},{y:.1}", if i == 0 { "M" } else { "L" })).collect::<Vec<_>>().join(" ")
}

/// A small trend line with the latest point marked.
#[component]
fn Spark(series: Vec<f64>, #[prop(into)] tone: String) -> impl IntoView {
    let (w, h, pad) = (100.0, 28.0, 2.0);
    let pts = xy(&series, w, h, pad, extent(&series));
    let line = path_of(&pts);
    let area = match (pts.first(), pts.last()) {
        (Some((x0, _)), Some((x1, _))) => format!("{line} L{x1:.1},{:.1} L{x0:.1},{:.1} Z", h - pad, h - pad),
        _ => String::new(),
    };
    let last = pts.last().copied().unwrap_or((0.0, h));
    view! {
        <svg class=format!("spark tone-{tone}") viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
            <path class="spark-area" d=area></path>
            <path class="spark-line" d=line vector-effect="non-scaling-stroke"></path>
            <circle class="spark-dot" cx=format!("{:.1}", last.0) cy=format!("{:.1}", last.1) r="2"></circle>
        </svg>
    }
}

/// The Lite line chart of one series with its first and last day and its top value.
#[cfg_attr(feature = "full", allow(dead_code))]
#[component]
fn LineChart(series: Vec<f64>, day_ms: Vec<u64>, unit: String, ui: TelUi, texts: BTreeMap<String, String>) -> impl IntoView {
    let (w, h, pad) = (600.0, 180.0, 6.0);
    let ext = extent(&series);
    let pts = xy(&series, w, h, pad, ext);
    let line = path_of(&pts);
    let area = match (pts.first(), pts.last()) {
        (Some((x0, _)), Some((x1, _))) => format!("{line} L{x1:.1},{:.1} L{x0:.1},{:.1} Z", h - pad, h - pad),
        _ => String::new(),
    };
    let day = |ms: Option<&u64>| ms.map_or_else(String::new, |m| age_text(&ui, &texts, *m as f64));
    let (first, last) = (day(day_ms.first()), tt(&texts, "series_today"));
    let top = fmt_val(&ui, &texts, &unit, ext.1);
    let dots = pts.iter().map(|(x, y)| view! { <circle class="spark-dot" cx=format!("{x:.1}") cy=format!("{y:.1}") r="2.5"></circle> }).collect_view();
    view! {
        <div class="linechart">
            <svg viewBox="0 0 600 180" preserveAspectRatio="none" role="img">
                <line class="axis" x1=pad y1={h - pad} x2={w - pad} y2={h - pad}></line>
                <path class="spark-area" d=area></path>
                <path class="spark-line" d=line vector-effect="non-scaling-stroke"></path>
                {dots}
            </svg>
            <div class="axis-labels"><span>{first}</span><span class="top">{top}</span><span>{last}</span></div>
        </div>
    }
}

/// The Lite heatmap: checks as rows, days as columns, the shade is the count.
#[cfg_attr(feature = "full", allow(dead_code))]
#[component]
fn HeatGrid(heat: Heat, ui: TelUi, texts: BTreeMap<String, String>) -> impl IntoView {
    let max = heat.cells.iter().flatten().copied().fold(0.0_f64, f64::max).max(1.0);
    let rows = heat
        .checks
        .iter()
        .zip(heat.cells.iter())
        .map(|(name, cells)| {
            let cells = cells
                .iter()
                .map(|v| {
                    let a = (v / max).clamp(0.0, 1.0);
                    view! { <span class="heat-cell" title=fmt_val(&ui, &texts, "count", *v) style=format!("--a:{a:.2}")></span> }
                })
                .collect_view();
            view! { <div class="heat-row"><span class="heat-name">{name.clone()}</span><span class="heat-cells">{cells}</span></div> }
        })
        .collect_view();
    view! { <div class="heat">{rows}</div> }
}

/// The spent / prevented / net waterfall as columns floating between the running totals.
#[cfg_attr(feature = "full", allow(dead_code))]
#[component]
fn WaterfallSvg(steps: Vec<Step>, ui: TelUi, texts: BTreeMap<String, String>) -> impl IntoView {
    let mut run = 0.0_f64;
    let mut spans: Vec<(f64, f64, &Step)> = Vec::new();
    for s in &steps {
        let (a, b) = match s.kind.as_str() {
            "spent" => (run, run - s.usd),
            "prevented" => (run, run + s.usd),
            _ => (0.0, s.usd),
        };
        if s.kind != "net" {
            run = b;
        }
        spans.push((a, b, s));
    }
    let lo = spans.iter().flat_map(|(a, b, _)| [*a, *b]).fold(0.0_f64, f64::min);
    let hi = spans.iter().flat_map(|(a, b, _)| [*a, *b]).fold(0.0_f64, f64::max);
    let hi = if hi - lo <= f64::EPSILON { lo + 1.0 } else { hi };
    let (w, h, pad) = (600.0, 200.0, 24.0);
    let y = |v: f64| pad + (h - 2.0 * pad) * (hi - v) / (hi - lo);
    let col = (w - 2.0 * pad) / spans.len().max(1) as f64;
    let bars = spans
        .iter()
        .enumerate()
        .map(|(i, (a, b, s))| {
            let (top, bottom) = (y(a.max(*b)), y(a.min(*b)));
            let x = pad + col * i as f64 + col * 0.15;
            view! {
                <g class=format!("wf-{}", s.kind)>
                    <rect x=format!("{x:.1}") y=format!("{top:.1}") width=format!("{:.1}", col * 0.7) height=format!("{:.1}", (bottom - top).max(1.0))></rect>
                    <text x=format!("{:.1}", x + col * 0.35) y={h - 6.0} text-anchor="middle" class="wf-label">{s.label.clone()}</text>
                    <text x=format!("{:.1}", x + col * 0.35) y=format!("{:.1}", top - 4.0) text-anchor="middle" class="wf-value">{fmt_val(&ui, &texts, "usd", s.usd)}</text>
                </g>
            }
        })
        .collect_view();
    view! {
        <svg class="waterfall" viewBox="0 0 600 200" role="img">
            <line class="axis" x1=pad y1=format!("{:.1}", y(0.0)) x2={w - pad} y2=format!("{:.1}", y(0.0))></line>
            {bars}
        </svg>
    }
}

// ---- Full tier charts -----------------------------------------------------------------------------------------------------

/// A chart drawn by the vendored library from `opts` (JSON); Lite and a failed load show `fallback` instead.
#[cfg(feature = "full")]
#[component]
fn ApexChart(opts: Memo<String>, ui: TelUi, unit: String, texts: BTreeMap<String, String>, fallback: ViewFn) -> impl IntoView {
    use crate::apex;
    let host = NodeRef::<leptos::html::Div>::new();
    let state: StoredValue<Option<apex::Chart>, LocalStorage> = StoredValue::new_local(None);
    let failed = RwSignal::new(false);
    let timeout = ui.apex_json.parse::<serde_json::Value>().ok().and_then(|v| v["load_timeout_ms"].as_i64()).unwrap_or(0) as i32;
    let fmt: Rc<dyn Fn(f64) -> String> = {
        let (ui, texts, unit) = (ui.clone(), texts.clone(), unit.clone());
        Rc::new(move |v| fmt_val(&ui, &texts, &unit, v))
    };
    let file = ui.apex_file.clone();
    Effect::new(move |_| {
        let json = opts.get();
        let Some(el) = host.get() else { return };
        let (file, fmt) = (file.clone(), fmt.clone());
        leptos::task::spawn_local(async move {
            if apex::ensure_loaded(&file, timeout).await.is_err() {
                failed.set(true);
                return;
            }
            // after the load nothing awaits: whichever task gets here first creates the chart, the rest update it
            state.update_value(|s| match s {
                Some(c) => c.update(&json),
                None => *s = apex::Chart::create(&el, &json, fmt).ok(),
            });
        });
    });
    on_cleanup(move || {
        if let Some(Some(c)) = state.try_update_value(Option::take) {
            c.destroy();
        }
    });
    let note = tt(&texts, "chart_failed");
    view! {
        <div class="apex-host" node_ref=host></div>
        <Show when=move || failed.get()><p class="soft-note">{note.clone()}</p>{fallback.run()}</Show>
    }
}

#[cfg(feature = "full")]
fn apex_cfg(ui: &TelUi) -> serde_json::Value {
    ui.apex_json.parse().unwrap_or_default()
}

#[cfg(feature = "full")]
fn day_labels(day_ms: &[u64]) -> Vec<f64> {
    day_ms.iter().map(|m| *m as f64).collect()
}

/// The zoomable daily series with a brush underneath.
#[cfg(feature = "full")]
#[component]
fn SeriesChart(kpi: Kpi, day_ms: Vec<u64>, ui: TelUi, texts: BTreeMap<String, String>) -> impl IntoView {
    use crate::apex;
    let cfg = apex_cfg(&ui);
    let h = |k: &str| cfg[k].as_u64().unwrap_or(0);
    let data: Vec<serde_json::Value> = day_labels(&day_ms).into_iter().zip(kpi.series.iter()).map(|(x, y)| serde_json::json!([x, y])).collect();
    let (min, max) = (day_ms.first().copied().unwrap_or(0), day_ms.last().copied().unwrap_or(0));
    let name = kpi.label.clone();
    let dark = is_dark();
    let mut main = apex::base(&cfg, dark, h("height_main"));
    apex::merge(&mut main, serde_json::json!({
        "chart": { "id": "tel-main", "type": "area", "zoom": { "enabled": true, "type": "x" } },
        "series": [{ "name": name, "data": data }],
        "xaxis": { "type": "datetime" },
        "fill": { "type": "gradient", "gradient": { "opacityFrom": 0.35, "opacityTo": 0.02 } },
    }));
    let mut brush = apex::base(&cfg, dark, h("height_brush"));
    apex::merge(&mut brush, serde_json::json!({
        "chart": { "id": "tel-brush", "type": "area", "brush": { "target": "tel-main", "enabled": true }, "selection": { "enabled": true, "xaxis": { "min": min, "max": max } }, "toolbar": { "show": false } },
        "series": [{ "name": kpi.label, "data": main["series"][0]["data"].clone() }],
        "xaxis": { "type": "datetime", "tooltip": { "enabled": false } },
        "yaxis": { "labels": { "show": false } },
        "fill": { "type": "gradient", "gradient": { "opacityFrom": 0.3, "opacityTo": 0.02 } },
        "legend": { "show": false },
    }));
    let (om, ob) = (Memo::new(move |_| main.to_string()), Memo::new(move |_| brush.to_string()));
    let fb = ViewFn::from(|| view! { <></> });
    view! {
        <ApexChart opts=om ui=ui.clone() unit=kpi.unit.clone() texts=texts.clone() fallback=fb.clone() />
        <p class="soft-note">{tt(&texts, "chart_brush")}</p>
        <ApexChart opts=ob ui=ui unit=kpi.unit texts=texts fallback=fb />
    }
}

/// The heatmap of blocks per check per day.
#[cfg(feature = "full")]
#[component]
fn HeatChart(heat: Heat, day_ms: Vec<u64>, ui: TelUi, texts: BTreeMap<String, String>) -> impl IntoView {
    use crate::apex;
    let cfg = apex_cfg(&ui);
    let series: Vec<serde_json::Value> = heat
        .checks
        .iter()
        .zip(heat.cells.iter())
        .map(|(n, cells)| serde_json::json!({ "name": n, "data": day_ms.iter().zip(cells.iter()).map(|(d, v)| serde_json::json!({ "x": d, "y": v })).collect::<Vec<_>>() }))
        .collect();
    let rows = heat.checks.len() as u64;
    let mut o = apex::base(&cfg, is_dark(), (rows * 30 + 70).max(cfg["height_small"].as_u64().unwrap_or(0)));
    apex::merge(&mut o, serde_json::json!({
        "chart": { "type": "heatmap", "toolbar": { "show": false } },
        "series": series,
        "xaxis": { "type": "datetime" },
        "plotOptions": { "heatmap": { "radius": 3, "colorScale": { "min": 0 } } },
        "colors": [cfg["info"]],
        "stroke": { "width": 1 },
        "legend": { "show": false },
    }));
    let opts = Memo::new(move |_| o.to_string());
    view! { <ApexChart opts=opts ui=ui unit="count".to_string() texts=texts fallback=ViewFn::from(|| view! { <></> }) /> }
}

/// The weekly-limit gauge.
#[cfg(feature = "full")]
#[component]
fn GaugeChart(forecast: Forecast, ui: TelUi, texts: BTreeMap<String, String>) -> impl IntoView {
    use crate::apex;
    let cfg = apex_cfg(&ui);
    let tone = cfg[forecast.tone.as_str()].clone();
    let mut o = apex::base(&cfg, is_dark(), cfg["height_small"].as_u64().unwrap_or(0));
    apex::merge(&mut o, serde_json::json!({
        "chart": { "type": "radialBar", "toolbar": { "show": false } },
        "series": [forecast.used_pct.min(100.0).round()],
        "labels": [tt(&texts, "f_used")],
        "colors": [if tone.is_null() { cfg["info"].clone() } else { tone }],
        "plotOptions": { "radialBar": { "hollow": { "size": "62%" } } },
    }));
    let opts = Memo::new(move |_| o.to_string());
    view! { <ApexChart opts=opts ui=ui unit="pct".to_string() texts=texts fallback=ViewFn::from(|| view! { <></> }) /> }
}

/// The waterfall as stacked columns over an invisible base. Each step is split at zero: the part above (stacked upward) and the
/// part below (stacked downward), so a step that crosses zero is drawn whole.
#[cfg(feature = "full")]
#[component]
fn WaterfallChart(steps: Vec<Step>, ui: TelUi, texts: BTreeMap<String, String>) -> impl IntoView {
    use crate::apex;
    let cfg = apex_cfg(&ui);
    let mut run = 0.0_f64;
    // base_pos, base_neg, then (pos, neg) for spent, prevented, net
    let mut cols: Vec<Vec<f64>> = vec![Vec::new(); 8];
    for s in &steps {
        let (lo, hi) = match s.kind.as_str() {
            "spent" => (run - s.usd, run),
            "prevented" => (run, run + s.usd),
            _ => (s.usd.min(0.0), s.usd.max(0.0)),
        };
        if s.kind == "spent" {
            run -= s.usd;
        } else if s.kind == "prevented" {
            run += s.usd;
        }
        let (pos, neg) = ((hi.max(0.0) - lo.max(0.0)).max(0.0), (lo.min(0.0) - hi.min(0.0)).min(0.0));
        let kind = match s.kind.as_str() { "spent" => 0, "prevented" => 1, _ => 2 };
        for (i, c) in cols.iter_mut().enumerate() {
            c.push(match i {
                0 => lo.max(0.0),
                1 => hi.min(0.0),
                x if x == 2 + kind * 2 => pos,
                x if x == 3 + kind * 2 => neg,
                _ => 0.0,
            });
        }
    }
    let names = ["", "", "spent_label", "spent_label", "prevented_label", "prevented_label", "net_label", "net_label"];
    let series: Vec<serde_json::Value> = cols.into_iter().zip(names).map(|(d, n)| serde_json::json!({ "name": if n.is_empty() { String::new() } else { tt(&texts, n) }, "data": d })).collect();
    let mut o = apex::base(&cfg, is_dark(), cfg["height_small"].as_u64().unwrap_or(0));
    apex::merge(&mut o, serde_json::json!({
        "chart": { "type": "bar", "stacked": true, "toolbar": { "show": false } },
        "series": series,
        "xaxis": { "categories": steps.iter().map(|s| s.label.clone()).collect::<Vec<_>>() },
        "colors": ["transparent", "transparent", cfg["bad"], cfg["bad"], cfg["ok"], cfg["ok"], cfg["info"], cfg["info"]],
        "plotOptions": { "bar": { "columnWidth": "55%", "borderRadius": 2 } },
        "legend": { "show": false },
        "tooltip": { "enabledOnSeries": [2, 3, 4, 5, 6, 7] },
    }));
    let opts = Memo::new(move |_| o.to_string());
    view! { <ApexChart opts=opts ui=ui unit="usd".to_string() texts=texts fallback=ViewFn::from(|| view! { <></> }) /> }
}

// ---- the Telemetry screen -------------------------------------------------------------------------------------------------

/// The screen. Nothing exists, and nothing is read, while it is not shown.
#[component]
pub fn TelScreen(active: Signal<bool>) -> impl IntoView {
    view! { <Show when=move || active.get()><TelBody /></Show> }
}

#[component]
fn TelBody() -> impl IntoView {
    ensure_style();
    let doc: RwSignal<Option<TelDoc>> = RwSignal::new(None);
    let failed = RwSignal::new(false);
    poll(TELEMETRY_PATH, doc, |d: &TelDoc| d.ui.refresh_s, failed);
    let sel = RwSignal::new(String::new());
    view! {
        <div class="main-head">
            <h1>{tx("title_telemetry")}</h1>
            <span class="counts">{move || doc.with(|d| d.as_ref().map(|d| format!("{} {}", tt(&d.texts, "updated"), age_text(&d.ui, &d.texts, d.generated_ms as f64))).unwrap_or_default())}</span>
        </div>
        <Show when=move || doc.with(Option::is_none)>
            <p class="empty">{move || if failed.get() { "\u{2014}".to_string() } else { "\u{2026}".to_string() }}</p>
        </Show>
        {move || doc.with(Option::is_some).then(|| view! { <TelContent doc=doc sel=sel /> })}
    }
}

#[component]
fn TelContent(doc: RwSignal<Option<TelDoc>>, sel: RwSignal<String>) -> impl IntoView {
    view! {
        <div class="tel">
            <Show when=move || doc.with(|d| d.as_ref().is_some_and(|d| !d.engine_ok))>
                <p class="empty">{move || doc.with(|d| d.as_ref().map(|d| tt(&d.texts, "engine_down")).unwrap_or_default())}</p>
            </Show>
            <Headlines doc=doc />
            <KpiGrid doc=doc sel=sel />
            <MainChart doc=doc sel=sel />
            <div class="tel-cols">
                <Anomalies doc=doc />
                <ForecastCard doc=doc />
            </div>
            <Movers doc=doc />
            <HeatSection doc=doc />
            <Tables doc=doc />
        </div>
    }
}

fn section_title(doc: RwSignal<Option<TelDoc>>, key: &'static str) -> impl IntoView {
    move || doc.with(|d| d.as_ref().map(|d| tt(&d.texts, key)).unwrap_or_default())
}

#[component]
fn Headlines(doc: RwSignal<Option<TelDoc>>) -> impl IntoView {
    view! {
        <section class="tel-card">
            <h2>{section_title(doc, "headlines")}</h2>
            <ul class="headlines">
                {move || doc.with(|d| d.as_ref().map(|d| d.headlines.iter().map(|h| view! { <li class=format!("tone-{}", h.tone)>{h.text.clone()}</li> }).collect_view()))}
            </ul>
        </section>
    }
}

#[component]
fn KpiGrid(doc: RwSignal<Option<TelDoc>>, sel: RwSignal<String>) -> impl IntoView {
    view! {
        <section class="tel-card">
            <h2>{section_title(doc, "kpis")}</h2>
            <div class="kpis">
                {move || doc.with(|d| d.as_ref().map(|d| {
                    let current = if sel.get().is_empty() { d.kpis.first().map(|k| k.id.clone()).unwrap_or_default() } else { sel.get() };
                    d.kpis.iter().map(|k| {
                        let id = k.id.clone();
                        let on = current == k.id;
                        let spark: Vec<f64> = k.series.iter().rev().take(d.ui.spark_points).rev().copied().collect();
                        view! {
                            <button type="button" class=format!("kpi tone-{}{}", k.tone, if on { " on" } else { "" }) title=k.hint.clone() on:click=move |_| sel.set(id.clone())>
                                <span class="kpi-label">{k.label.clone()}</span>
                                <span class="kpi-value">{fmt_val(&d.ui, &d.texts, &k.unit, k.value)}</span>
                                <span class=format!("kpi-delta tone-{}", k.tone)>{delta_text(k.delta_pct)}</span>
                                <Spark series=spark tone=k.tone.clone() />
                            </button>
                        }
                    }).collect_view()
                }))}
            </div>
        </section>
    }
}

#[component]
fn MainChart(doc: RwSignal<Option<TelDoc>>, sel: RwSignal<String>) -> impl IntoView {
    let picked = Memo::new(move |_| doc.with(|d| d.as_ref().and_then(|d| {
        let id = sel.get();
        d.kpis.iter().find(|k| k.id == id).or(d.kpis.first()).cloned().map(|k| (k, d.day_ms.clone(), d.ui.clone(), d.texts.clone()))
    })));
    view! {
        <section class="tel-card">
            <h2>{move || picked.get().map(|(k, _, _, t)| format!("{} \u{b7} {}", tt(&t, "chart_main"), k.label)).unwrap_or_default()}</h2>
            {move || picked.get().map(|(k, days, ui, texts)| chart_for(k, days, ui, texts))}
        </section>
    }
}

#[allow(unused_variables)]
fn chart_for(k: Kpi, days: Vec<u64>, ui: TelUi, texts: BTreeMap<String, String>) -> AnyView {
    #[cfg(feature = "full")]
    {
        view! { <SeriesChart kpi=k day_ms=days ui=ui texts=texts /> }.into_any()
    }
    #[cfg(not(feature = "full"))]
    {
        view! { <LineChart series=k.series day_ms=days unit=k.unit ui=ui texts=texts /> }.into_any()
    }
}

#[component]
fn Anomalies(doc: RwSignal<Option<TelDoc>>) -> impl IntoView {
    view! {
        <section class="tel-card">
            <h2>{section_title(doc, "anomalies")}</h2>
            {move || doc.with(|d| d.as_ref().map(|d| if d.anomalies.is_empty() {
                view! { <p class="soft-note">{tt(&d.texts, "anomalies_none")}</p> }.into_any()
            } else {
                view! { <ul class="anomalies">{d.anomalies.iter().map(|a| view! { <li class=format!("dir-{}", a.dir)>{a.text.clone()}</li> }).collect_view()}</ul> }.into_any()
            }))}
        </section>
    }
}

#[component]
fn ForecastCard(doc: RwSignal<Option<TelDoc>>) -> impl IntoView {
    view! {
        <section class="tel-card">
            <h2>{section_title(doc, "forecast")}</h2>
            {move || doc.with(|d| d.as_ref().map(|d| match &d.forecast {
                None => view! { <p class="soft-note">{tt(&d.texts, "forecast_none")}</p> }.into_any(),
                Some(f) => forecast_view(f.clone(), d.ui.clone(), d.texts.clone()),
            }))}
        </section>
    }
}

#[allow(unused_variables)]
fn forecast_view(f: Forecast, ui: TelUi, texts: BTreeMap<String, String>) -> AnyView {
    let bar = view! {
        <div class=format!("wk-gauge tone-{}", f.tone)>
            <div class="wk-gauge-fill" style=format!("width:{:.0}%", f.used_pct.clamp(0.0, 100.0))></div>
            {f.projected_pct.map(|p| view! { <div class="wk-gauge-mark" style=format!("left:{:.0}%", p.clamp(0.0, 100.0))></div> })}
        </div>
    };
    let note = view! { <p class=format!("tone-{}", f.tone)>{f.text.clone()}</p><p class="soft-note">{tt(&texts, "f_method")}</p> };
    #[cfg(feature = "full")]
    {
        view! { <GaugeChart forecast=f ui=ui texts=texts /> {note} }.into_any()
    }
    #[cfg(not(feature = "full"))]
    {
        view! { {bar} {note} }.into_any()
    }
}

#[component]
fn Movers(doc: RwSignal<Option<TelDoc>>) -> impl IntoView {
    view! {
        <section class="tel-card">
            <h2>{section_title(doc, "movers")}</h2>
            <div class="tel-cols">
                {move || doc.with(|d| d.as_ref().map(|d| d.movers.iter().map(|m| {
                    let rows = if m.rows.is_empty() {
                        view! { <p class="soft-note">{tt(&d.texts, "movers_none")}</p> }.into_any()
                    } else {
                        m.rows.iter().map(|r| mover_row(r, &d.ui, &d.texts)).collect_view().into_any()
                    };
                    view! { <div class="movers"><h3 title=m.hint.clone()>{m.label.clone()}</h3>{rows}</div> }
                }).collect_view()))}
            </div>
        </section>
    }
}

fn mover_row(r: &Mover, ui: &TelUi, texts: &BTreeMap<String, String>) -> impl IntoView {
    let tone = if r.change > 0.0 { "up" } else { "down" };
    view! {
        <div class=format!("mover dir-{tone}")>
            <span class="mover-name">{r.name.clone()}</span>
            <Spark series=r.series.clone() tone="neutral".to_string() />
            <span class="mover-val">{fmt_val(ui, texts, "count", r.value)}</span>
            <span class="mover-delta">{delta_text(r.pct.or(Some(r.change)))}</span>
        </div>
    }
}

#[component]
fn HeatSection(doc: RwSignal<Option<TelDoc>>) -> impl IntoView {
    view! {
        <section class="tel-card">
            <h2>{section_title(doc, "chart_heat")}</h2>
            {move || doc.with(|d| d.as_ref().map(|d| heat_view(d.heat.clone(), d.day_ms.clone(), d.ui.clone(), d.texts.clone())))}
        </section>
    }
}

#[allow(unused_variables)]
fn heat_view(heat: Heat, days: Vec<u64>, ui: TelUi, texts: BTreeMap<String, String>) -> AnyView {
    #[cfg(feature = "full")]
    {
        view! { <HeatChart heat=heat day_ms=days ui=ui texts=texts /> }.into_any()
    }
    #[cfg(not(feature = "full"))]
    {
        view! { <HeatGrid heat=heat ui=ui texts=texts /> }.into_any()
    }
}

// ---- tables ---------------------------------------------------------------------------------------------------------------

fn cell_key(c: &Cell) -> (f64, String) {
    match c {
        Cell::Num(n) => (*n, String::new()),
        Cell::Text(t) => (f64::NAN, t.to_lowercase()),
    }
}

fn cell_has(c: &Cell, q: &str) -> bool {
    match c {
        Cell::Text(t) => t.to_lowercase().contains(q),
        Cell::Num(n) => n.to_string().contains(q),
    }
}

#[component]
fn Tables(doc: RwSignal<Option<TelDoc>>) -> impl IntoView {
    let tab = RwSignal::new(String::new());
    let filter = RwSignal::new(String::new());
    let sort: RwSignal<(usize, bool)> = RwSignal::new((usize::MAX, false));
    let shown = RwSignal::new(0usize);
    view! {
        <section class="tel-card">
            <h2>{section_title(doc, "tables")}</h2>
            {move || doc.with(|d| d.as_ref().map(|d| {
                let current = if tab.get().is_empty() { d.tables.first().map(|t| t.id.clone()).unwrap_or_default() } else { tab.get() };
                let tabs = d.tables.iter().map(|t| {
                    let id = t.id.clone();
                    let on = id == current;
                    view! { <button type="button" class=if on { "on" } else { "" } on:click=move |_| { tab.set(id.clone()); sort.set((usize::MAX, false)); shown.set(0); }>{t.title.clone()}</button> }
                }).collect_view();
                view! { <div class="seg tabs" role="group">{tabs}</div> }
            }))}
            <TableView doc=doc tab=tab filter=filter sort=sort shown=shown />
        </section>
    }
}

#[component]
fn TableView(doc: RwSignal<Option<TelDoc>>, tab: RwSignal<String>, filter: RwSignal<String>, sort: RwSignal<(usize, bool)>, shown: RwSignal<usize>) -> impl IntoView {
    let table = Memo::new(move |_| doc.with(|d| d.as_ref().and_then(|d| {
        let id = tab.get();
        d.tables.iter().find(|t| t.id == id).or(d.tables.first()).cloned().map(|t| (t, d.ui.clone(), d.texts.clone()))
    })));
    view! {
        {move || table.get().map(|(t, ui, texts)| {
            let t2 = t.clone();
            let rows = Memo::new(move |_| filtered(&t2, &filter.get(), sort.get()));
            let step = ui.rows_shown;
            let limit = move || if shown.get() == 0 { step } else { shown.get() };
            let more = Memo::new(move |_| rows.with(Vec::len) > limit());
            let rows_label = tt(&texts, "table_rows");
            let head = t.cols.iter().enumerate().map(|(i, c)| {
                view! { <th><button type="button" class="th" title=tt(&texts, "sort") on:click=move |_| sort.update(|s| *s = if s.0 == i { (i, !s.1) } else { (i, false) })>{c.label.clone()}
                    {move || { let s = sort.get(); if s.0 == i { if s.1 { " \u{25B2}" } else { " \u{25BC}" } } else { "" } }}</button></th> }
            }).collect_view();
            let (ui2, texts2, cols) = (ui.clone(), texts.clone(), t.cols.clone());
            let export = {
                let (path, id) = (ui.export_path.clone(), t.id.clone());
                move |fmt: &str| format!("{path}?table={id}&format={fmt}&q={}", js_sys::encode_uri_component(&filter.get()).as_string().unwrap_or_default())
            };
            let (e1, e2) = (export.clone(), export);
            view! {
                <div class="table-bar">
                    <input type="search" class="filter" placeholder=tt(&texts, "table_filter") aria-label=tt(&texts, "table_filter") on:input=move |ev| { filter.set(event_target_value(&ev)); shown.set(0); } />
                    <span class="soft-note">{move || format!("{} {}", rows.with(Vec::len), rows_label)}</span>
                    <div class="grow"></div>
                    <a class="btn" href=move || e1("csv") download>{tt(&texts, "export_csv")}</a>
                    <a class="btn" href=move || e2("json") download>{tt(&texts, "export_json")}</a>
                </div>
                <div class="table-wrap">
                    <table class="data">
                        <thead><tr>{head}</tr></thead>
                        <tbody>
                            {move || rows.with(|r| r.iter().take(limit()).map(|row| {
                                let cells = row.iter().enumerate().map(|(i, c)| {
                                    let kind = cols.get(i).map_or("text", |c| c.kind.as_str());
                                    view! { <td class=if matches!(c, Cell::Num(_)) { "num" } else { "" }>{fmt_cell(&ui2, &texts2, kind, c)}</td> }
                                }).collect_view();
                                view! { <tr>{cells}</tr> }
                            }).collect_view())}
                        </tbody>
                    </table>
                </div>
                <Show when=move || more.get()>
                    <button type="button" class="btn" on:click=move |_| shown.set(limit() + step)>{tt(&texts, "more")}</button>
                </Show>
            }
        })}
    }
}

fn filtered(t: &Table, q: &str, sort: (usize, bool)) -> Vec<Vec<Cell>> {
    let q = q.to_lowercase();
    let mut rows: Vec<Vec<Cell>> = t.rows.iter().filter(|r| q.is_empty() || r.iter().any(|c| cell_has(c, &q))).cloned().collect();
    if let Some(_) = t.cols.get(sort.0) {
        rows.sort_by(|a, b| {
            let (x, y) = (a.get(sort.0).map(cell_key).unwrap_or_default(), b.get(sort.0).map(cell_key).unwrap_or_default());
            let o = if x.0.is_nan() || y.0.is_nan() { x.1.cmp(&y.1) } else { x.0.total_cmp(&y.0) };
            if sort.1 { o } else { o.reverse() }
        });
    }
    rows
}

// ---- the Impact screen ----------------------------------------------------------------------------------------------------

#[component]
pub fn ImpactScreen(active: Signal<bool>) -> impl IntoView {
    view! { <Show when=move || active.get()><ImpactBody /></Show> }
}

#[component]
fn ImpactBody() -> impl IntoView {
    ensure_style();
    let doc: RwSignal<Option<ImpactDoc>> = RwSignal::new(None);
    let failed = RwSignal::new(false);
    poll(IMPACT_PATH, doc, |d: &ImpactDoc| d.ui.refresh_s, failed);
    let period = RwSignal::new(0usize);
    view! {
        <div class="main-head">
            <h1>{tx("title_impact")}</h1>
            <span class="counts">{move || doc.with(|d| d.as_ref().map(|d| format!("{} {}", tt(&d.texts, "updated"), age_text(&d.ui, &d.texts, d.generated_ms as f64))).unwrap_or_default())}</span>
            <div class="grow"></div>
            <div class="seg" role="group">
                {move || doc.with(|d| d.as_ref().map(|d| d.periods.iter().enumerate().map(|(i, p)| view! {
                    <button type="button" class=move || if period.get() == i { "on" } else { "" } on:click=move |_| period.set(i)>{p.label.clone()}</button>
                }).collect_view()))}
            </div>
        </div>
        <Show when=move || doc.with(Option::is_none)>
            <p class="empty">{move || if failed.get() { "\u{2014}".to_string() } else { "\u{2026}".to_string() }}</p>
        </Show>
        {move || doc.with(|d| d.as_ref().map(|d| d.engine_ok)).unwrap_or(false).then(|| view! { <ImpactContent doc=doc period=period /> })}
        <Show when=move || doc.with(|d| d.as_ref().is_some_and(|d| !d.engine_ok))>
            <p class="empty">{move || doc.with(|d| d.as_ref().map(|d| tt(&d.texts, "engine_down")).unwrap_or_default())}</p>
        </Show>
    }
}

#[component]
fn ImpactContent(doc: RwSignal<Option<ImpactDoc>>, period: RwSignal<usize>) -> impl IntoView {
    let title = move |key: &'static str| move || doc.with(|d| d.as_ref().map(|d| tt(&d.texts, key)).unwrap_or_default());
    view! {
        <div class="tel">
            <section class="tel-card">
                <h2>{title("impact_prevention")}</h2>
                <p class="soft-note">{title("gl_i_note")}</p>
                {move || doc.with(|d| d.as_ref().map(|d| pair_rows(&d.prevention, period.get(), &d.texts, &d.ui)))}
            </section>
            <section class="tel-card">
                <h2>{title("impact_savings")}</h2>
                {move || doc.with(|d| d.as_ref().map(|d| d.savings.iter().map(|s| saving_card(s, &d.texts, &d.ui)).collect_view()))}
                <h3>{title("impact_waterfall")}</h3>
                {move || doc.with(|d| d.as_ref().map(|d| waterfall_view(d.waterfall.clone(), d.ui.clone(), d.texts.clone())))}
            </section>
            <section class="tel-card">
                <h2>{title("impact_failures")}</h2>
                {move || doc.with(|d| d.as_ref().map(|d| pair_rows(&d.failures, period.get(), &d.texts, &d.ui)))}
            </section>
            <section class="tel-card">
                <h2>{title("impact_gaps")}</h2>
                <div class="gaps">
                    {move || doc.with(|d| d.as_ref().map(|d| d.gaps.iter().map(|g| view! {
                        <div class=format!("gap tone-{}"  , g.tone)><strong>{g.label.clone()}</strong><span>{g.text.clone()}</span></div>
                    }).collect_view()))}
                </div>
            </section>
        </div>
    }
}

#[allow(unused_variables)]
fn waterfall_view(steps: Vec<Step>, ui: TelUi, texts: BTreeMap<String, String>) -> AnyView {
    #[cfg(feature = "full")]
    {
        view! { <WaterfallChart steps=steps ui=ui texts=texts /> }.into_any()
    }
    #[cfg(not(feature = "full"))]
    {
        view! { <WaterfallSvg steps=steps ui=ui texts=texts /> }.into_any()
    }
}

/// Paired bars: this period and the one before, scaled to the larger of the two, with the change per day.
fn pair_rows(rows: &[ImpactRow], period: usize, texts: &BTreeMap<String, String>, ui: &TelUi) -> impl IntoView {
    let legend = view! { <div class="pair-legend"><span class="cur">{tt(texts, "legend_cur")}</span><span class="prev">{tt(texts, "legend_prev")}</span></div> };
    let body = rows
        .iter()
        .map(|r| {
            let p: Pair = r.pairs.get(period).copied().unwrap_or_default();
            let max = p.cur.max(p.prev).max(1.0);
            let tone = delta_tone(p.delta_pct, &r.good, 0.5);
            view! {
                <div class="pair" title=r.hint.clone()>
                    <span class="pair-label">{r.label.clone()}</span>
                    <div class="pair-bars">
                        <div class="bar cur"><span style=format!("width:{:.1}%", p.cur / max * 100.0)></span><em>{fmt_val(ui, texts, "count", p.cur)}</em></div>
                        <div class="bar prev"><span style=format!("width:{:.1}%", p.prev / max * 100.0)></span><em>{fmt_val(ui, texts, "count", p.prev)}</em></div>
                    </div>
                    <span class=format!("pair-delta tone-{tone}")>{delta_text(p.delta_pct)}</span>
                </div>
            }
        })
        .collect_view();
    view! { {legend} {body} <p class="soft-note">{tt(texts, "impact_rate_note")}</p> }
}

fn saving_card(s: &Saving, texts: &BTreeMap<String, String>, ui: &TelUi) -> impl IntoView {
    let value = s.usd.map_or_else(|| tt(texts, "no_data"), |u| fmt_val(ui, texts, "usd", u));
    let kind = tt(texts, if s.kind == "measured" { "impact_measured" } else { "impact_estimate" });
    view! {
        <div class=format!("saving kind-{}", s.kind)>
            <div class="saving-head"><strong>{s.label.clone()}</strong><span class="badge">{kind}</span><span class="saving-value">{value}</span></div>
            {(!s.basis.is_empty()).then(|| view! { <p class="soft-note">{tt(texts, "impact_status")}": " {s.basis.clone()}</p> })}
            {(!s.formula.is_empty()).then(|| view! { <details><summary>{tt(texts, "impact_formula")}</summary><p>{s.formula.clone()}</p><p class="soft-note">{tt(texts, "impact_range")}": " {s.range.clone()}</p></details> })}
        </div>
    }
}
