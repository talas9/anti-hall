//! The graph component. One component, two tiers:
//!   Lite  - DOM cards + static SVG wires. No canvas, no GPU, no timers.
//!   Full  - DOM cards + a wire/particle canvas (wgpu, else Canvas2D) paced by `Pacer`.
//! Interaction (pan, zoom, drag, select, action menu) is identical in both.

use crate::geom::{self, Cam, WireGeom};
use crate::layout::{self, Pos};
use crate::model::*;
use leptos::html;
use leptos::prelude::*;
use send_wrapper::SendWrapper;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

static INSTANCES: AtomicU32 = AtomicU32::new(0);

/// What the caller receives when the user runs an action. Call `done(true|false)` when it finished; the component shows
/// running -> done/failed next to the node until then.
#[derive(Clone)]
pub struct ActionCall {
    pub node: String,
    pub action: String,
    pub done: Callback<bool>,
}

#[derive(Clone, PartialEq)]
struct MenuState {
    node: String,
    idx: usize,
    items: Vec<ActionDef>,
    /// Client-px fallback position for browsers without CSS anchor positioning.
    at: (f32, f32),
}

#[derive(Clone, PartialEq)]
struct ConfirmState {
    node: String,
    idx: usize,
    action: ActionDef,
    at: (f32, f32),
}

enum Gesture {
    None,
    Pan { sx: f32, sy: f32, cam: Cam, moved: bool },
    Node { id: String, sx: f32, sy: f32, ox: f32, oy: f32, moved: bool },
}

type Shared<T> = SendWrapper<Rc<RefCell<T>>>;

fn shared<T>(v: T) -> Shared<T> {
    SendWrapper::new(Rc::new(RefCell::new(v)))
}

/// Everything a node card needs; provided as context so `Card` stays a plain component.
#[derive(Clone)]
struct Ctx {
    data: Signal<GraphData>,
    pos: RwSignal<Pos>,
    cfg: Arc<GraphConfig>,
    sel: RwSignal<Option<String>>,
    fb: RwSignal<HashMap<(String, String), Fb>>,
    hl: RwSignal<HashSet<String>>,
    inst: u32,
    gesture: Shared<Gesture>,
    view_ref: NodeRef<html::Div>,
    open_menu: Callback<(String, (f32, f32))>,
}

fn call0(el: &web_sys::Element, name: &str) {
    if let Ok(f) = js_sys::Reflect::get(el, &name.into()) {
        if let Ok(f) = f.dyn_into::<js_sys::Function>() {
            let _ = f.call0(el);
        }
    }
}

fn after(ms: u32, f: impl FnOnce() + 'static) {
    let cb = Closure::once_into_js(f);
    if let Some(w) = web_sys::window() {
        let _ = w.set_timeout_with_callback_and_timeout_and_arguments_0(cb.unchecked_ref(), ms as i32);
    }
}

fn vars_css(cfg: &GraphConfig) -> String {
    let t = &cfg.theme;
    let mut s = format!("--ahg-bg:{};--ahg-grid:{};--ahg-wire:{};--ahg-wire-hot:{};--ahg-particle:{};", t.bg, t.grid, t.wire, t.wire_hot, t.particle);
    for (k, v) in &t.kinds {
        s.push_str(&format!("--ahg-k-{k}:{};", v.color));
    }
    for (k, v) in &t.status {
        s.push_str(&format!("--ahg-s-{k}:{v};"));
    }
    s
}

fn wire_d(w: &WireGeom) -> String {
    let c = &w.ctrl;
    format!("M{:.1} {:.1}C{:.1} {:.1} {:.1} {:.1} {:.1} {:.1}", c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1])
}

fn structure_key(d: &GraphData) -> String {
    let mut k = String::new();
    for n in &d.nodes {
        k.push_str(&n.id);
        k.push('|');
    }
    for e in &d.edges {
        k.push_str(&e.from);
        k.push('>');
        k.push_str(&e.to);
        k.push(';');
    }
    k
}

/// Throttled copy of the highlighted path: at most one change per `ms`, trailing edge kept.
fn throttled(src: Signal<Vec<String>>, ms: u32) -> RwSignal<HashSet<String>> {
    let out = RwSignal::new(HashSet::new());
    let busy = shared(false);
    Effect::new(move |_| {
        let v: HashSet<String> = src.get().into_iter().collect();
        if *busy.borrow() || v == out.get_untracked() {
            return;
        }
        out.set(v);
        *busy.borrow_mut() = true;
        let b2 = busy.clone();
        after(ms, move || {
            *b2.borrow_mut() = false;
            let v: HashSet<String> = src.get_untracked().into_iter().collect();
            if v != out.get_untracked() {
                out.set(v);
            }
        });
    });
    out
}

fn node_by_id(ctx: &Ctx, id: &str) -> Option<NodeDef> {
    ctx.data.with(|d| d.nodes.iter().find(|n| n.id == id).cloned())
}

#[component]
fn Card(id: String) -> impl IntoView {
    let ctx = expect_context::<Ctx>();
    let nd = {
        let (ctx, id) = (ctx.clone(), id.clone());
        move || node_by_id(&ctx, &id)
    };
    let idx = {
        let (ctx, id) = (ctx.clone(), id.clone());
        move || ctx.data.with(|d| d.nodes.iter().position(|n| n.id == id)).unwrap_or(0)
    };
    let size = {
        let (ctx, nd) = (ctx.clone(), nd.clone());
        move || nd().map(|n| geom::node_size(&n, &ctx.cfg)).unwrap_or((0.0, 0.0))
    };
    let style = {
        let (ctx, id, nd, size, idx) = (ctx.clone(), id.clone(), nd.clone(), size.clone(), idx.clone());
        move || {
            let (x, y) = ctx.pos.with(|p| p.get(&id).copied()).unwrap_or((0.0, 0.0));
            let (w, h) = size();
            let kind = nd().map(|n| n.kind).unwrap_or_default();
            format!("left:{x}px;top:{y}px;width:{w}px;height:{h}px;--k:var(--ahg-k-{kind}, var(--ahg-k-{}));anchor-name:--ahg{}-n{}", ctx.cfg.theme.fallback_kind, ctx.inst, idx())
        }
    };
    let on_down = {
        let (ctx, id) = (ctx.clone(), id.clone());
        move |ev: web_sys::PointerEvent| {
            if ev.button() != 0 {
                return;
            }
            ev.stop_propagation();
            if let Some(el) = ctx.view_ref.get_untracked() {
                let _ = el.set_pointer_capture(ev.pointer_id());
                let r = el.get_bounding_client_rect();
                let (x, y) = (ev.client_x() as f32 - r.left() as f32, ev.client_y() as f32 - r.top() as f32);
                let (ox, oy) = ctx.pos.with_untracked(|p| p.get(&id).copied()).unwrap_or((0.0, 0.0));
                *ctx.gesture.borrow_mut() = Gesture::Node { id: id.clone(), sx: x, sy: y, ox, oy, moved: false };
            }
        }
    };
    let on_ctx = {
        let (ctx, id) = (ctx.clone(), id.clone());
        move |ev: web_sys::MouseEvent| {
            ev.prevent_default();
            ctx.open_menu.run((id.clone(), (ev.client_x() as f32, ev.client_y() as f32)));
        }
    };
    let on_key = {
        let (ctx, id) = (ctx.clone(), id.clone());
        move |ev: web_sys::KeyboardEvent| {
            let k = ev.key();
            if k == "Enter" || k == " " {
                ev.prevent_default();
                ctx.sel.set(Some(id.clone()));
            } else if k == "ContextMenu" || (k == "F10" && ev.shift_key()) || k == "m" {
                ev.prevent_default();
                let at = ev.current_target().and_then(|t| t.dyn_into::<web_sys::Element>().ok()).map(|e| {
                    let r = e.get_bounding_client_rect();
                    (r.right() as f32, r.top() as f32)
                });
                ctx.open_menu.run((id.clone(), at.unwrap_or((0.0, 0.0))));
            }
        }
    };
    let on_more = {
        let (ctx, id) = (ctx.clone(), id.clone());
        move |ev: web_sys::MouseEvent| {
            ev.stop_propagation();
            let at = ev.current_target().and_then(|t| t.dyn_into::<web_sys::Element>().ok()).map(|e| {
                let r = e.get_bounding_client_rect();
                (r.left() as f32, r.bottom() as f32)
            });
            ctx.open_menu.run((id.clone(), at.unwrap_or((0.0, 0.0))));
        }
    };
    let chip = {
        let (ctx, id) = (ctx.clone(), id.clone());
        move || {
            ctx.fb.with(|m| {
                m.iter().find(|((n, _), _)| n == &id).map(|((_, a), s)| {
                    let t = &ctx.cfg.texts;
                    let (cls, txt) = match s {
                        Fb::Running => ("run", &t.running),
                        Fb::Done => ("ok", &t.done),
                        Fb::Failed => ("bad", &t.failed),
                    };
                    (cls, format!("{a}: {txt}"))
                })
            })
        }
    };
    let ports = {
        let (ctx, nd) = (ctx.clone(), nd.clone());
        move |is_in: bool| {
            nd().map(|n| {
                let h = geom::node_size(&n, &ctx.cfg).1;
                let list = if is_in { n.ports_in } else { n.ports_out };
                let cnt = list.len();
                list.into_iter()
                    .enumerate()
                    .map(|(i, p)| {
                        let (title, text) = (p.label.clone(), p.label);
                        view! { <span class=if is_in { "ahg-port in" } else { "ahg-port out" } title=title style=format!("top:{}px", geom::port_y(i, cnt, h))><em>{text}</em></span> }
                    })
                    .collect_view()
            })
        }
    };
    let ports_in = ports.clone();
    let (nd1, nd2, nd3, nd4, nd5) = (nd.clone(), nd.clone(), nd.clone(), nd.clone(), nd.clone());
    let (ctx_h, id_h, ctx_s, id_s) = (ctx.clone(), id.clone(), ctx.clone(), id.clone());
    let shape = {
        let (ctx, nd) = (ctx.clone(), nd.clone());
        move || nd().and_then(|n| ctx.cfg.kind(&n.kind).map(|k| k.shape.clone())).unwrap_or_default()
    };
    let more_title = ctx.cfg.texts.menu_button.clone();
    view! {
        <div class="ahg-node" role="button" tabindex="0" style=style
            data-kind=move || nd1().map(|n| n.kind).unwrap_or_default()
            data-status=move || nd2().map(|n| n.status).unwrap_or_default()
            data-sel=move || (ctx_s.sel.get().as_deref() == Some(id_s.as_str())).to_string()
            data-hot=move || ctx_h.hl.with(|h| h.contains(&id_h)).to_string()
            aria-label=move || nd3().map(|n| format!("{}, {}, {}", n.label, n.kind, n.status)).unwrap_or_default()
            on:pointerdown=on_down on:contextmenu=on_ctx on:keydown=on_key>
            <span class="ahg-dot" data-shape=shape></span>
            <span class="ahg-txt">
                <b>{move || nd4().map(|n| n.label).unwrap_or_default()}</b>
                <i>{move || nd5().map(|n| n.sub).unwrap_or_default()}</i>
            </span>
            <button type="button" class="ahg-more" aria-haspopup="menu" title=more_title.clone() aria-label=more_title
                on:pointerdown=|ev: web_sys::PointerEvent| ev.stop_propagation() on:click=on_more>"\u{22EF}"</button>
            {move || chip().map(|(c, t)| view! { <span class=format!("ahg-chip {c}") role="status">{t}</span> })}
            {move || ports_in(true)}
            {move || ports(false)}
        </div>
    }
}

#[component]
pub fn Graph(
    data: Signal<GraphData>,
    cfg: Arc<GraphConfig>,
    tier: Tier,
    mode: LayoutMode,
    actions: Callback<String, Vec<ActionDef>>,
    on_action: Callback<ActionCall>,
    #[prop(optional)] highlight: Option<Signal<Vec<String>>>,
    #[prop(optional)] selected: Option<RwSignal<Option<String>>>,
    #[prop(optional)] panel: Option<Callback<String, AnyView>>,
) -> impl IntoView {
    let inst = INSTANCES.fetch_add(1, Ordering::Relaxed);
    let full = tier == Tier::Full && cfg!(feature = "full");
    let geo = cfg.geometry.clone();

    let pos = RwSignal::new(Pos::new());
    let dragged = shared(HashSet::<String>::new());
    let cam = RwSignal::new(Cam { x: 0.0, y: 0.0, k: 1.0 });
    let vp = RwSignal::new((800.0f32, 600.0f32));
    let sel = selected.unwrap_or_else(|| RwSignal::new(None));
    let menu = RwSignal::new(None::<MenuState>);
    let confirm = RwSignal::new(None::<ConfirmState>);
    let fb = RwSignal::new(HashMap::<(String, String), Fb>::new());
    let backend = RwSignal::new(if full { "pending" } else { "svg" });
    let view_ref = NodeRef::<html::Div>::new();
    let menu_ref = NodeRef::<html::Div>::new();
    let confirm_ref = NodeRef::<html::Div>::new();
    let gesture = shared(Gesture::None);

    let hl_src: Signal<Vec<String>> = highlight.unwrap_or_else(|| Signal::stored(Vec::new()));
    let hl = throttled(hl_src, cfg.budget.highlight_throttle_ms);

    // ---- actions
    let run = {
        let cfg = cfg.clone();
        Callback::new(move |(node, action): (String, String)| {
            fb.update(|m| {
                m.insert((node.clone(), action.clone()), Fb::Running);
            });
            let (n2, a2) = (node.clone(), action.clone());
            let clear_ms = cfg.budget.feedback_clear_ms;
            let done = Callback::new(move |ok: bool| {
                let key = (n2.clone(), a2.clone());
                fb.update(|m| {
                    m.insert(key.clone(), if ok { Fb::Done } else { Fb::Failed });
                });
                after(clear_ms, move || {
                    fb.update(|m| {
                        m.remove(&key);
                    })
                });
            });
            on_action.run(ActionCall { node, action, done });
        })
    };
    let open_menu = Callback::new(move |(node, at): (String, (f32, f32))| {
        let idx = data.with_untracked(|d| d.nodes.iter().position(|n| n.id == node)).unwrap_or(0);
        confirm.set(None);
        menu.set(Some(MenuState { items: actions.run(node.clone()), node, idx, at }));
    });

    provide_context(Ctx { data, pos, cfg: cfg.clone(), sel, fb, hl, inst, gesture: gesture.clone(), view_ref, open_menu });

    // ---- layout (re-run only when the node/edge structure changes; existing positions are kept)
    let skey = Memo::new(move |_| data.with(structure_key));
    let first = shared(true);
    let fit = {
        let cfg = cfg.clone();
        Callback::new(move |_: ()| {
            let d = data.get_untracked();
            let p = pos.get_untracked();
            let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for n in &d.nodes {
                if let Some((x, y)) = p.get(&n.id) {
                    let (w, h) = geom::node_size(n, &cfg);
                    x0 = x0.min(*x);
                    y0 = y0.min(*y);
                    x1 = x1.max(x + w);
                    y1 = y1.max(y + h);
                }
            }
            if x0 > x1 {
                return;
            }
            let (vw, vh) = vp.get_untracked();
            let pad = cfg.geometry.fit_pad;
            let k = ((vw - 2.0 * pad) / (x1 - x0)).min((vh - 2.0 * pad) / (y1 - y0)).clamp(cfg.geometry.zoom_min, 1.0);
            cam.set(Cam { k, x: (vw - (x1 - x0) * k) / 2.0 - x0 * k, y: (vh - (y1 - y0) * k) / 2.0 - y0 * k });
        })
    };
    {
        let cfg = cfg.clone();
        let (first, dragged) = (first.clone(), dragged.clone());
        Effect::new(move |_| {
            skey.track();
            let d = data.get_untracked();
            let fresh = layout::compute(&d, mode, &cfg);
            let mut cur = pos.get_untracked();
            cur.retain(|id, _| d.nodes.iter().any(|n| &n.id == id));
            let is_first = *first.borrow();
            let keep = dragged.borrow();
            for (id, p) in fresh {
                if is_first || (!cur.contains_key(&id) && !keep.contains(&id)) {
                    cur.insert(id, p);
                }
            }
            drop(keep);
            pos.set(cur);
            if std::mem::replace(&mut *first.borrow_mut(), false) {
                fit.run(());
            }
        });
    }

    let wires = Memo::new({
        let cfg = cfg.clone();
        move |_| geom::wires(&data.get(), &pos.get(), &cfg, mode)
    });
    #[allow(unused_variables)]
    let is_hot = move |edge: usize| -> bool {
        data.with_untracked(|d| {
            let e = &d.edges[edge];
            hl.with_untracked(|h| h.contains(&e.from) && h.contains(&e.to))
        })
    };

    // ---- viewport size
    Effect::new(move |_| {
        let Some(el) = view_ref.get() else { return };
        let measure = {
            let el = el.clone();
            move || {
                let r = el.get_bounding_client_rect();
                vp.set((r.width() as f32, r.height() as f32));
            }
        };
        measure();
        let cb = Closure::<dyn FnMut()>::new(measure);
        if let Ok(ro) = web_sys::ResizeObserver::new(cb.as_ref().unchecked_ref()) {
            ro.observe(&el);
        }
        cb.forget();
    });

    // ---- Full tier: canvas + pacer
    #[cfg(feature = "full")]
    let canvas_ref = NodeRef::<html::Canvas>::new();
    #[cfg(feature = "full")]
    if full {
        use crate::render::{self, Backend, C2d, Frame, Palette};
        let kick: Shared<Option<Rc<crate::pacer::Pacer>>> = shared(None);
        let be: Shared<Option<Backend>> = shared(None);
        let pal = Palette {
            wire: crate::color::parse_oklch(&cfg.theme.wire).unwrap_or([1.0; 4]),
            hot: crate::color::parse_oklch(&cfg.theme.wire_hot).unwrap_or([1.0; 4]),
            particle: crate::color::parse_oklch(&cfg.theme.particle).unwrap_or([1.0; 4]),
        };
        let (be2, kick2, cfgc) = (be.clone(), kick.clone(), cfg.clone());
        Effect::new(move |done: Option<bool>| {
            if done == Some(true) {
                return true;
            }
            let Some(canvas) = canvas_ref.get() else { return false };
            let (be, cfgc) = (be2.clone(), cfgc.clone());
            let draw: Box<dyn FnMut(f64)> = Box::new({
                let (be, cfgc) = (be.clone(), cfgc.clone());
                move |t_ms: f64| {
                    let (w, h) = vp.get_untracked();
                    let dpr = web_sys::window().map(|w| w.device_pixel_ratio()).unwrap_or(1.0) as f32;
                    let ws = wires.get_untracked();
                    let d = data.get_untracked();
                    let wl: Vec<(&[[f32; 2]], bool)> = ws.iter().map(|g| (g.pts.as_slice(), is_hot(g.edge))).collect();
                    let parts = geom::particles(&d, &ws, &is_hot, (t_ms / 1000.0) as f32, &cfgc);
                    let frame = Frame { cam: cam.get_untracked(), w, h, dpr, wires: &wl, parts: &parts, pal, width: cfgc.budget.wire_width, psize: cfgc.budget.particle_size };
                    if let Some(b) = be.borrow_mut().as_mut() {
                        b.draw(&frame);
                    }
                }
            });
            let pacer = crate::pacer::Pacer::new(cfgc.budget.clone(), draw);
            *kick2.borrow_mut() = Some(pacer.clone());
            wasm_bindgen_futures::spawn_local(async move {
                let mut chosen: Option<(Backend, &'static str)> = None;
                if render::webgpu_available().await {
                    if let Some(g) = render::Gpu::new(canvas.clone()).await {
                        chosen = Some((Backend::Gpu(g), "webgpu"));
                    }
                }
                if chosen.is_none() {
                    if let Some(c) = C2d::new(&canvas) {
                        chosen = Some((Backend::C2d(c), "canvas2d"));
                    }
                }
                match chosen {
                    Some((b, name)) => {
                        *be.borrow_mut() = Some(b);
                        backend.set(name);
                        pacer.kick();
                    }
                    None => backend.set("svg"),
                }
            });
            true
        });
        // size the canvas backing store to the viewport
        Effect::new(move |_| {
            let (w, h) = vp.get();
            if let Some(c) = canvas_ref.get() {
                let dpr = web_sys::window().map(|w| w.device_pixel_ratio()).unwrap_or(1.0);
                c.set_width((w as f64 * dpr).max(1.0) as u32);
                c.set_height((h as f64 * dpr).max(1.0) as u32);
            }
        });
        // anything that changes the picture wakes the pacer; continuous motion keeps it at the ambient rate
        let k2 = kick.clone();
        Effect::new(move |_| {
            cam.track();
            wires.track();
            hl.track();
            vp.track();
            backend.track();
            if let Some(p) = k2.borrow().as_ref() {
                p.kick();
            }
        });
        let k3 = kick.clone();
        Effect::new(move |_| {
            let moving = data.with(|d| d.edges.iter().any(|e| e.rate > 0.0)) || hl.with(|h| !h.is_empty());
            backend.track();
            if let Some(p) = k3.borrow().as_ref() {
                p.set_ambient(moving);
            }
        });
    }
    let svg_wires = move || !full || backend.get() == "svg";

    // Show/hide the popovers when their state changes. `popover=auto` gives light dismiss + Esc; `toggle` syncs back.
    Effect::new(move |_| {
        let on = menu.with(|m| m.is_some());
        if let Some(el) = menu_ref.get() {
            call0(&el, if on { "showPopover" } else { "hidePopover" });
        }
    });
    Effect::new(move |_| {
        let on = confirm.with(|m| m.is_some());
        if let Some(el) = confirm_ref.get() {
            call0(&el, if on { "showPopover" } else { "hidePopover" });
        }
    });
    let closed = |ev: &web_sys::Event| js_sys::Reflect::get(ev, &"newState".into()).ok().and_then(|v| v.as_string()).as_deref() == Some("closed");

    // ---- pointer gestures on the viewport
    let rel = move |ev: &web_sys::PointerEvent| -> (f32, f32) {
        let r = view_ref.get_untracked().map(|e| e.get_bounding_client_rect());
        let (l, t) = r.map(|r| (r.left() as f32, r.top() as f32)).unwrap_or((0.0, 0.0));
        (ev.client_x() as f32 - l, ev.client_y() as f32 - t)
    };
    let g1 = gesture.clone();
    let on_down = move |ev: web_sys::PointerEvent| {
        if ev.button() != 0 {
            return;
        }
        if let Some(el) = view_ref.get_untracked() {
            let _ = el.set_pointer_capture(ev.pointer_id());
        }
        let (x, y) = rel(&ev);
        *g1.borrow_mut() = Gesture::Pan { sx: x, sy: y, cam: cam.get_untracked(), moved: false };
    };
    let (g2, dr2) = (gesture.clone(), dragged.clone());
    let on_move = move |ev: web_sys::PointerEvent| {
        let (x, y) = rel(&ev);
        match &mut *g2.borrow_mut() {
            Gesture::Pan { sx, sy, cam: c0, moved } => {
                if (x - *sx).abs() + (y - *sy).abs() > 3.0 {
                    *moved = true;
                }
                if *moved {
                    cam.set(Cam { x: c0.x + x - *sx, y: c0.y + y - *sy, k: c0.k });
                }
            }
            Gesture::Node { id, sx, sy, ox, oy, moved } => {
                if (x - *sx).abs() + (y - *sy).abs() > 3.0 {
                    *moved = true;
                }
                if *moved {
                    let k = cam.get_untracked().k;
                    dr2.borrow_mut().insert(id.clone());
                    pos.update(|p| {
                        p.insert(id.clone(), (*ox + (x - *sx) / k, *oy + (y - *sy) / k));
                    });
                }
            }
            Gesture::None => {}
        }
    };
    let g3 = gesture.clone();
    let on_up = move |_ev: web_sys::PointerEvent| match std::mem::replace(&mut *g3.borrow_mut(), Gesture::None) {
        Gesture::Node { id, moved: false, .. } => sel.set(Some(id)),
        Gesture::Pan { moved: false, .. } => sel.set(None),
        _ => {}
    };
    let zoom_at = {
        let g = geo.clone();
        Callback::new(move |(f, mx, my): (f32, f32, f32)| {
            let c = cam.get_untracked();
            let k = (c.k * f).clamp(g.zoom_min, g.zoom_max);
            cam.set(Cam { k, x: mx - (mx - c.x) * k / c.k, y: my - (my - c.y) * k / c.k });
        })
    };
    let on_wheel = {
        let step = geo.zoom_step;
        move |ev: web_sys::WheelEvent| {
            ev.prevent_default();
            let r = view_ref.get_untracked().map(|e| e.get_bounding_client_rect());
            let (l, t) = r.map(|r| (r.left() as f32, r.top() as f32)).unwrap_or((0.0, 0.0));
            zoom_at.run((if ev.delta_y() < 0.0 { step } else { 1.0 / step }, ev.client_x() as f32 - l, ev.client_y() as f32 - t));
        }
    };

    // ---- view pieces
    let style_vars = vars_css(&cfg);
    let t = cfg.texts.clone();
    let node_ids = move || data.with(|d| d.nodes.iter().map(|n| n.id.clone()).collect::<Vec<_>>());
    let step = geo.zoom_step;

    let edge_labels = {
        let unit = t.edge_rate_unit.clone();
        move || {
            let d = data.get();
            wires
                .get()
                .into_iter()
                .filter_map(|w| {
                    let e = &d.edges[w.edge];
                    if e.label.is_empty() && e.rate <= 0.0 {
                        return None;
                    }
                    let m = w.pts[w.pts.len() / 2];
                    let txt = if e.rate > 0.0 { format!("{} {:.1}{}", e.label, e.rate, unit).trim().to_string() } else { e.label.clone() };
                    let hot = hl.with(|h| h.contains(&e.from) && h.contains(&e.to));
                    Some(view! { <span class="ahg-lbl" data-hot=hot.to_string() style=format!("left:{}px;top:{}px", m[0], m[1])>{txt}</span> })
                })
                .collect_view()
        }
    };
    let svg_layer = move || {
        svg_wires().then(|| {
            view! {
                <svg class="ahg-wires" aria-hidden="true">
                    {move || {
                        let d = data.get();
                        wires.get().into_iter().map(|w| {
                            let e = &d.edges[w.edge];
                            let hot = hl.with(|h| h.contains(&e.from) && h.contains(&e.to));
                            view! { <path d=wire_d(&w) data-hot=hot.to_string() /> }
                        }).collect_view()
                    }}
                </svg>
            }
        })
    };

    // Minimap: bbox of the nodes -> small SVG; click recentres the camera.
    let bbox = Memo::new({
        let cfg = cfg.clone();
        move |_| {
            let d = data.get();
            let p = pos.get();
            let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for n in &d.nodes {
                if let Some((x, y)) = p.get(&n.id) {
                    let (w, h) = geom::node_size(n, &cfg);
                    x0 = x0.min(*x);
                    y0 = y0.min(*y);
                    x1 = x1.max(x + w);
                    y1 = y1.max(y + h);
                }
            }
            if x0 > x1 { (0.0, 0.0, 1.0, 1.0) } else { (x0 - 40.0, y0 - 40.0, x1 + 40.0, y1 + 40.0) }
        }
    });
    let (mw, mh) = (geo.minimap_w, geo.minimap_h);
    let mscale = move || {
        let (x0, y0, x1, y1) = bbox.get();
        (mw / (x1 - x0)).min(mh / (y1 - y0))
    };
    let mini_nodes = {
        let cfg = cfg.clone();
        move || {
            let (x0, y0, _, _) = bbox.get();
            let s = mscale();
            let d = data.get();
            let p = pos.get();
            d.nodes
                .iter()
                .filter_map(|n| {
                    let (x, y) = p.get(&n.id)?;
                    let (w, h) = geom::node_size(n, &cfg);
                    Some(view! { <rect x=(x - x0) * s y=(y - y0) * s width=(w * s).max(2.0) height=(h * s).max(2.0) rx="1.5" style=format!("fill:var(--ahg-k-{})", n.kind) /> })
                })
                .collect_view()
        }
    };
    let mini_view = move || {
        let (x0, y0, _, _) = bbox.get();
        let s = mscale();
        let (c, (vw, vh)) = (cam.get(), vp.get());
        (((-c.x / c.k) - x0) * s, ((-c.y / c.k) - y0) * s, vw / c.k * s, vh / c.k * s)
    };
    let mini_click = move |ev: web_sys::PointerEvent| {
        let Some(el) = ev.current_target().and_then(|t| t.dyn_into::<web_sys::Element>().ok()) else { return };
        ev.stop_propagation();
        let r = el.get_bounding_client_rect();
        let (x0, y0, _, _) = bbox.get_untracked();
        let s = mscale();
        let (wx, wy) = ((ev.client_x() as f32 - r.left() as f32) / s + x0, (ev.client_y() as f32 - r.top() as f32) / s + y0);
        let c = cam.get_untracked();
        let (vw, vh) = vp.get_untracked();
        cam.set(Cam { k: c.k, x: vw / 2.0 - wx * c.k, y: vh / 2.0 - wy * c.k });
    };

    // Menu / confirm contents
    let menu_style = move || {
        menu.with(|m| m.as_ref().map(|m| format!("position-anchor:--ahg{inst}-n{};--mx:{}px;--my:{}px", m.idx, m.at.0, m.at.1)).unwrap_or_default())
    };
    let confirm_style = move || {
        confirm.with(|m| m.as_ref().map(|m| format!("position-anchor:--ahg{inst}-n{};--mx:{}px;--my:{}px", m.idx, m.at.0, m.at.1)).unwrap_or_default())
    };
    let tx = t.clone();
    let menu_items = move || {
        let tx = tx.clone();
        menu.get().map(|m| {
            if m.items.is_empty() {
                return view! { <p class="ahg-empty">{tx.no_actions.clone()}</p> }.into_any();
            }
            let items = m
                .items
                .iter()
                .cloned()
                .map(|a| {
                    let (node, aid) = (m.node.clone(), a.id.clone());
                    let st = {
                        let (node, aid, tx) = (node.clone(), aid.clone(), tx.clone());
                        move || fb.with(|f| f.get(&(node.clone(), aid.clone())).map(|s| match s {
                            Fb::Running => ("run", tx.running.clone()),
                            Fb::Done => ("ok", tx.done.clone()),
                            Fb::Failed => ("bad", tx.failed.clone()),
                        }))
                    };
                    let (idx, at, a2) = (m.idx, m.at, a.clone());
                    let click = move |_| {
                        menu.set(None);
                        if a2.destructive {
                            confirm.set(Some(ConfirmState { node: node.clone(), idx, action: a2.clone(), at }));
                        } else {
                            run.run((node.clone(), aid.clone()));
                        }
                    };
                    view! {
                        <li role="none"><button type="button" role="menuitem" class:destructive=a.destructive disabled=!a.enabled title=a.note.clone() on:click=click>
                            <span>{a.label.clone()}</span>
                            {move || st().map(|(c, s)| view! { <span class=format!("ahg-fb {c}")>{s}</span> })}
                        </button></li>
                    }
                })
                .collect_view();
            view! { <ul>{items}</ul> }.into_any()
        })
    };
    let tc = t.clone();
    let confirm_body = move || {
        let tc = tc.clone();
        confirm.get().map(|c| {
            let title = tc.confirm_title.replace("{action}", &c.action.label);
            let body = if c.action.note.is_empty() { tc.confirm_body.replace("{node}", &c.node) } else { c.action.note.clone() };
            let (node, aid) = (c.node.clone(), c.action.id.clone());
            view! {
                <h3>{title}</h3>
                <p>{body}</p>
                <div class="ahg-btns">
                    <button type="button" autofocus on:click=move |_| confirm.set(None)>{tc.confirm_no.clone()}</button>
                    <button type="button" class="destructive" on:click=move |_| { confirm.set(None); run.run((node.clone(), aid.clone())); }>{tc.confirm_yes.clone()}</button>
                </div>
            }
        })
    };

    let (t_menu, t_fit, t_in, t_out, t_mini, t_graph, t_note) = (t.menu_label.clone(), t.fit.clone(), t.zoom_in.clone(), t.zoom_out.clone(), t.minimap.clone(), t.graph_label.clone(), t.tier_lite_note.clone());
    let world_style = move || {
        let c = cam.get();
        format!("transform:translate({}px,{}px) scale({})", c.x, c.y, c.k)
    };
    let grid_style = move || {
        let c = cam.get();
        format!("background-position:{}px {}px;background-size:{s}px {s}px", c.x, c.y, s = 32.0 * c.k)
    };
    let panel_view = move || {
        let p = panel?;
        sel.get().map(|id| view! { <aside class="ahg-panel">{p.run(id)}</aside> })
    };
    let _ = t_note;

    view! {
        <div class="ahg" data-tier=if full { "full" } else { "lite" } data-backend=move || backend.get() style=style_vars>
            <div class="ahg-view" node_ref=view_ref role="group" aria-label=t_graph tabindex="-1" style=grid_style
                on:pointerdown=on_down on:pointermove=on_move on:pointerup=on_up on:pointercancel=|_| {} on:wheel=on_wheel>
                {
                    #[cfg(feature = "full")]
                    { full.then(|| view! { <canvas class="ahg-canvas" node_ref=canvas_ref aria-hidden="true"></canvas> }) }
                    #[cfg(not(feature = "full"))]
                    { None::<()> }
                }
                <div class="ahg-world" style=world_style>
                    {svg_layer}
                    {edge_labels}
                    <For each=node_ids key=|id| id.clone() children=|id| view! { <Card id=id /> } />
                </div>
                <div class="ahg-tools" role="toolbar">
                    <button type="button" title=t_in.clone() aria-label=t_in on:click=move |_| { let (w, h) = vp.get_untracked(); zoom_at.run((step, w / 2.0, h / 2.0)) }>"+"</button>
                    <button type="button" title=t_out.clone() aria-label=t_out on:click=move |_| { let (w, h) = vp.get_untracked(); zoom_at.run((1.0 / step, w / 2.0, h / 2.0)) }>"\u{2212}"</button>
                    <button type="button" title=t_fit.clone() aria-label=t_fit on:click=move |_| fit.run(())>"\u{2922}"</button>
                </div>
                <svg class="ahg-mini" aria-label=t_mini viewBox=format!("0 0 {mw} {mh}") width=mw height=mh on:pointerdown=mini_click>
                    {mini_nodes}
                    {move || { let (x, y, w, h) = mini_view(); view! { <rect class="ahg-mini-view" x=x y=y width=w height=h /> } }}
                </svg>
            </div>
            {panel_view}
            <div node_ref=menu_ref popover="auto" class="ahg-pop ahg-menu" role="menu" aria-label=t_menu style=menu_style
                on:toggle=move |ev| if closed(&ev) { menu.set(None) }>
                {menu_items}
            </div>
            <div node_ref=confirm_ref popover="auto" class="ahg-pop ahg-confirm" role="alertdialog" style=confirm_style
                on:toggle=move |ev| if closed(&ev) { confirm.set(None) }>
                {confirm_body}
            </div>
        </div>
    }
}
