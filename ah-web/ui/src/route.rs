//! The page's place in the address bar: `#<screen>[/<tab>][?<screen>.<key>=<value>&...]`. A reload, a pasted link and the back and
//! forward buttons all land on the same screen with the same tab and filters. Screen names come from the page's text table
//! (`route_*`), a screen's keys carry its own name as a prefix (so one screen's leftovers never read as another's), and writes that
//! only refine the current place replace the history entry instead of adding one.
use leptos::prelude::*;
use std::collections::BTreeMap;
use wasm_bindgen::{closure::Closure, JsCast, JsValue};

#[derive(Clone, Default, PartialEq, Debug)]
pub struct Route {
    pub screen: String,
    pub seg: String,
    pub params: BTreeMap<String, String>,
}

fn dec(s: &str) -> String {
    js_sys::decode_uri_component(s).ok().and_then(|j| j.as_string()).unwrap_or_else(|| s.to_string())
}

fn enc(s: &str) -> String {
    js_sys::encode_uri_component(s).as_string().unwrap_or_default()
}

pub fn parse(hash: &str) -> Route {
    let h = hash.trim_start_matches('#');
    let (path, query) = h.split_once('?').unwrap_or((h, ""));
    let (screen, seg) = path.split_once('/').unwrap_or((path, ""));
    let params = query.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (dec(k), dec(v))).collect();
    Route { screen: dec(screen), seg: dec(seg), params }
}

pub fn render(r: &Route) -> String {
    let mut out = enc(&r.screen);
    if !r.seg.is_empty() {
        out.push('/');
        out.push_str(&enc(&r.seg));
    }
    let q: Vec<String> = r.params.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect();
    if !q.is_empty() {
        out.push('?');
        out.push_str(&q.join("&"));
    }
    out
}

pub fn current() -> Route {
    web_sys::window().and_then(|w| w.location().hash().ok()).map(|h| parse(&h)).unwrap_or_default()
}

/// Make `r` the address. `push`: a new history entry (a screen was chosen); otherwise the entry is replaced (a tab or filter changed).
pub fn set(r: &Route, push: bool) {
    let Some(w) = web_sys::window() else { return };
    let h = render(r);
    if w.location().hash().ok().map(|c| c.trim_start_matches('#').to_string()) == Some(h.clone()) {
        return;
    }
    if push {
        let _ = w.location().set_hash(&h);
    } else if let Ok(hist) = w.history() {
        let _ = hist.replace_state_with_url(&JsValue::NULL, "", Some(&format!("#{h}")));
    }
}

/// The value of `key` in the address, if any.
pub fn param(key: &str) -> Option<String> {
    current().params.get(key).cloned()
}

/// Keep `key` at `value` in the address (removed when empty), leaving the rest of the place as it is.
pub fn set_param(key: &str, value: &str) {
    let mut r = current();
    if value.is_empty() {
        r.params.remove(key);
    } else {
        r.params.insert(key.to_string(), value.to_string());
    }
    set(&r, false);
}

/// Keep the tab segment (`#settings/<tab>`) at `value`.
pub fn set_seg(value: &str) {
    let mut r = current();
    r.seg = value.to_string();
    set(&r, false);
}

/// A text signal that follows `key` of the address: read once now, written back when it changes.
pub fn bind_text(sig: RwSignal<String>, key: &'static str) {
    if let Some(v) = param(key) {
        sig.set(v);
    }
    Effect::new(move |_| set_param(key, &sig.get()));
}

/// A number signal that follows `key` of the address.
pub fn bind_num(sig: RwSignal<usize>, key: &'static str) {
    if let Some(v) = param(key).and_then(|v| v.parse().ok()) {
        sig.set(v);
    }
    Effect::new(move |_| set_param(key, &sig.get().to_string()));
}

/// Call `f` with the new place whenever the address changes by other means than this page (back, forward, a pasted link).
pub fn on_change(f: impl Fn(Route) + 'static) {
    let Some(w) = web_sys::window() else { return };
    let cb = Closure::<dyn Fn()>::new(move || f(current()));
    let _ = w.add_event_listener_with_callback("hashchange", cb.as_ref().unchecked_ref());
    cb.forget();
}

/// When the screen of the address changes to `screen`, keep only that screen's own filters (their keys start with `<screen>.`) and
/// its tab segment if it is the one that owns tabs.
pub fn enter(screen: &str, keeps_seg: bool) {
    let cur = current();
    if cur.screen == screen {
        return;
    }
    let prefix = format!("{screen}.");
    let params = cur.params.into_iter().filter(|(k, _)| k.starts_with(&prefix)).collect();
    set(&Route { screen: screen.to_string(), seg: if keeps_seg { cur.seg } else { String::new() }, params }, !cur.screen.is_empty());
}
