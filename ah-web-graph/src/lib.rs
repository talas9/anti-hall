//! ah-web-graph: the one node-graph component of the Command Center (agent graph, system topology, rules/hooks editor).
//! Rust API: `Graph` (a Leptos component). JS API for the bundle: `mount_graph`.

pub mod color;
pub mod geom;
pub mod layout;
pub mod model;
#[cfg(feature = "full")]
pub mod pacer;
#[cfg(feature = "full")]
pub mod render;
pub mod view;

pub use model::*;
pub use view::{ActionCall, Graph};

use leptos::prelude::*;
use send_wrapper::SendWrapper;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

/// Live handle returned by `mount_graph`: push new data / a highlighted path (e.g. the rule execution being traced).
#[wasm_bindgen]
pub struct GraphHandle {
    data: RwSignal<GraphData>,
    hl: RwSignal<Vec<String>>,
}

#[wasm_bindgen]
impl GraphHandle {
    #[wasm_bindgen(js_name = setData)]
    pub fn set_data(&self, json: &str) -> Result<(), JsValue> {
        self.data.set(serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?);
        Ok(())
    }

    #[wasm_bindgen(js_name = setHighlight)]
    pub fn set_highlight(&self, json: &str) -> Result<(), JsValue> {
        self.hl.set(serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?);
        Ok(())
    }
}

fn hook(h: &SendWrapper<JsValue>, name: &str) -> Option<js_sys::Function> {
    js_sys::Reflect::get(h, &name.into()).ok()?.dyn_into::<js_sys::Function>().ok()
}

/// Mount a graph into `host`.
/// `hooks` is a JS object: `actions(nodeId) -> JSON [ActionDef]`, `onAction(nodeId, actionId, done(ok))`,
/// `panel(nodeId) -> string` (optional; the selection side panel).
#[wasm_bindgen]
pub fn mount_graph(host: web_sys::HtmlElement, cfg_json: &str, data_json: &str, tier: &str, mode: &str, hooks: JsValue) -> Result<GraphHandle, JsValue> {
    let err = |e: serde_json::Error| JsValue::from_str(&e.to_string());
    let cfg: Arc<GraphConfig> = Arc::new(serde_json::from_str(cfg_json).map_err(err)?);
    let data = RwSignal::new(serde_json::from_str::<GraphData>(data_json).map_err(err)?);
    let hl = RwSignal::new(Vec::<String>::new());
    let tier = if tier == "full" { Tier::Full } else { Tier::Lite };
    let mode = if mode == "layered" { LayoutMode::Layered } else { LayoutMode::Force };
    let hooks = SendWrapper::new(hooks);
    let h1 = hooks.clone();
    let actions = Callback::new(move |id: String| {
        hook(&h1, "actions")
            .and_then(|f| f.call1(&JsValue::NULL, &id.into()).ok())
            .and_then(|v| v.as_string())
            .and_then(|s| serde_json::from_str::<Vec<ActionDef>>(&s).ok())
            .unwrap_or_default()
    });
    let h2 = hooks.clone();
    let on_action = Callback::new(move |c: ActionCall| {
        let done = c.done;
        let cb = Closure::once_into_js(move |ok: JsValue| done.run(ok.as_bool().unwrap_or(false)));
        if let Some(f) = hook(&h2, "onAction") {
            let _ = f.call3(&JsValue::NULL, &c.node.into(), &c.action.into(), &cb);
        }
    });
    let h3 = hooks.clone();
    let panel = hook(&hooks, "panel").map(|_| {
        Callback::new(move |id: String| {
            let txt = hook(&h3, "panel").and_then(|f| f.call1(&JsValue::NULL, &id.into()).ok()).and_then(|v| v.as_string()).unwrap_or_default();
            view! { <pre class="ahg-panel-body">{txt}</pre> }.into_any()
        })
    });
    leptos::mount::mount_to(host, move || {
        view! { <Graph data=data.into() cfg=cfg.clone() tier=tier mode=mode actions=actions on_action=on_action highlight=Signal::from(hl) panel=panel.unwrap_or_else(|| Callback::new(|_| ().into_any())) /> }
    })
    .forget();
    Ok(GraphHandle { data, hl })
}
