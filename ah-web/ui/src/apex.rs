//! The Full tier's chart library, ApexCharts, behind a thin binding. The library is one vendored file served by this server; it is
//! loaded (once) the first time a Telemetry or Impact chart is drawn and never in the Lite build. A chart is created from a JSON
//! options document; the number formatting of its axes and tooltips is a closure from the page's own formats.
use js_sys::{Function, Promise, Reflect};
use serde_json::Value;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    /// The library's chart class (a global once the script is loaded).
    #[wasm_bindgen(js_name = ApexCharts)]
    type ApexCharts;

    #[wasm_bindgen(constructor, js_class = "ApexCharts")]
    fn new(el: &web_sys::Element, options: &JsValue) -> ApexCharts;

    #[wasm_bindgen(method)]
    fn render(this: &ApexCharts) -> Promise;

    #[wasm_bindgen(method, js_name = updateOptions)]
    fn update_options(this: &ApexCharts, options: &JsValue, redraw: bool, animate: bool);

    #[wasm_bindgen(method)]
    fn destroy(this: &ApexCharts);
}

/// A drawn chart; dropping it does not remove it, call [`Chart::destroy`].
pub struct Chart(ApexCharts);

impl Chart {
    /// Draw a chart in `el` from `options` (JSON). `fmt` writes the values of the y axis and the tooltips.
    pub fn create(el: &web_sys::Element, options: &str, fmt: Rc<dyn Fn(f64) -> String>) -> Result<Chart, String> {
        let opts = js_sys::JSON::parse(options).map_err(|_| "chart options".to_string())?;
        let f = Closure::<dyn Fn(f64) -> String>::new(move |v: f64| fmt(v)).into_js_value();
        for path in [["yaxis", "labels", "formatter"], ["tooltip", "y", "formatter"]] {
            set_path(&opts, &path, &f);
        }
        let chart = ApexCharts::new(el, &opts);
        let _ = chart.render();
        Ok(Chart(chart))
    }

    /// Replace the data and options in place (formatters set at creation stay).
    pub fn update(&self, options: &str) {
        if let Ok(opts) = js_sys::JSON::parse(options) {
            self.0.update_options(&opts, true, false);
        }
    }

    pub fn destroy(self) {
        self.0.destroy();
    }
}

/// `root.a.b = value`, creating the objects on the way.
fn set_path(root: &JsValue, path: &[&str], value: &JsValue) {
    let mut cur = root.clone();
    for (i, key) in path.iter().enumerate() {
        let k = JsValue::from_str(key);
        if i + 1 == path.len() {
            let _ = Reflect::set(&cur, &k, value);
            return;
        }
        let next = Reflect::get(&cur, &k).ok().filter(|v| v.is_object());
        cur = match next {
            Some(n) => n,
            None => {
                let o = js_sys::Object::new();
                let _ = Reflect::set(&cur, &k, &o);
                o.into()
            }
        };
    }
}

fn library_ready() -> bool {
    web_sys::window().and_then(|w| Reflect::get(&w, &JsValue::from_str("ApexCharts")).ok()).is_some_and(|v| v.is_function())
}

/// Load the library from `/static/<file>` unless it is already there (or already loading).
pub async fn ensure_loaded(file: &str, timeout_ms: i32) -> Result<(), String> {
    if library_ready() {
        return Ok(());
    }
    let doc = web_sys::window().and_then(|w| w.document()).ok_or("no document")?;
    let id = "apex-script";
    let script: web_sys::Element = match doc.get_element_by_id(id) {
        Some(s) => s,
        None => {
            let s = doc.create_element("script").map_err(|_| "script")?;
            s.set_id(id);
            let _ = s.set_attribute("src", &format!("/static/{file}"));
            doc.head().ok_or("no head")?.append_child(&s).map_err(|_| "append")?;
            s
        }
    };
    let waiting = script.clone();
    let loaded = Promise::new(&mut |ok: Function, fail: Function| {
        let _ = waiting.add_event_listener_with_callback("load", &ok);
        let _ = waiting.add_event_listener_with_callback("error", &fail);
    });
    let _ = JsFuture::from(Promise::race(&js_sys::Array::of2(&loaded, &turn(timeout_ms)))).await;
    if library_ready() { Ok(()) } else { Err("chart library".into()) }
}

/// A promise that resolves after `ms` (the longest the load is waited for).
fn turn(ms: i32) -> Promise {
    Promise::new(&mut |ok: Function, _| {
        if let Some(w) = web_sys::window() {
            let _ = w.set_timeout_with_callback_and_timeout_and_arguments_0(&ok, ms);
        }
    })
}

/// Options shared by every chart: the page's theme colours and sizes (the `apex` table of `web_tel.toml`).
pub fn base(apex: &Value, dark: bool, height: u64) -> Value {
    let theme = &apex[if dark { "dark" } else { "light" }];
    let animations = apex["animations"].as_bool().unwrap_or(false);
    serde_json::json!({
        "chart": {
            "height": height, "background": "transparent", "foreColor": theme["fg"], "fontFamily": "inherit",
            "animations": { "enabled": animations }, "toolbar": { "show": true, "autoSelected": "zoom" },
            "zoom": { "enabled": apex["zoom"].as_bool().unwrap_or(false) },
        },
        "theme": { "mode": if dark { "dark" } else { "light" } },
        "grid": { "borderColor": theme["grid"] },
        "colors": apex["palette"],
        "tooltip": { "theme": if dark { "dark" } else { "light" } },
        "dataLabels": { "enabled": false },
        "stroke": { "width": 2, "curve": "smooth" },
    })
}

/// `b` merged into `a` (objects deeply, everything else replaced).
pub fn merge(a: &mut Value, b: Value) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for (k, v) in y {
                merge(x.entry(k).or_insert(Value::Null), v);
            }
        }
        (slot, v) => *slot = v,
    }
}
