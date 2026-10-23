//! Live effects on a graph: a decision travelling event -> check -> decision and bursting in its colour, an action's ripple / ring /
//! shake on its node. The caller pushes [`FxEvent`]s into an [`FxBus`]; the graph (a) highlights the node card in both tiers (DOM
//! attributes, cleared by one timeout) and (b) in the Full tier draws the particles on the wire canvas. Nothing here has a value of its
//! own: sizes, times, counts and colours come from `FxCfg`.

use crate::geom::{self, Particle, WireGeom};
use crate::layout::Pos;
use crate::model::{FxCfg, GraphConfig, GraphData};
use send_wrapper::SendWrapper;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FxKind {
    /// A particle crosses `path` segment by segment and bursts at each stop.
    Decision,
    /// One ring spreading from the node.
    Ripple,
    /// Two rings, one after the other.
    Ring,
    /// The node shakes and one fast ring spreads (a refused action).
    Shake,
}

impl FxKind {
    pub fn parse(s: &str) -> Option<FxKind> {
        match s {
            "decision" => Some(FxKind::Decision),
            "ripple" => Some(FxKind::Ripple),
            "ring" => Some(FxKind::Ring),
            "shake" => Some(FxKind::Shake),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            FxKind::Decision => "decision",
            FxKind::Ripple => "ripple",
            FxKind::Ring => "ring",
            FxKind::Shake => "shake",
        }
    }
}

#[derive(Clone, Debug)]
pub struct FxEvent {
    pub kind: FxKind,
    /// Node ids: the stops of a travelling decision, or the one node of a ripple / ring / shake.
    pub path: Vec<String>,
    /// Key into `fx.colors`: the burst, and the travel after the first stop.
    pub color: String,
    /// Key into `fx.colors`: the first leg of a travelling decision.
    pub travel_color: String,
}

struct Inner {
    q: VecDeque<FxEvent>,
    cap: usize,
    wake: Option<Rc<dyn Fn()>>,
}

/// Where a caller drops effects. Cheap to clone; one bus feeds one graph.
#[derive(Clone)]
pub struct FxBus(SendWrapper<Rc<RefCell<Inner>>>);

impl FxBus {
    pub fn new(cap: usize) -> FxBus {
        FxBus(SendWrapper::new(Rc::new(RefCell::new(Inner { q: VecDeque::new(), cap: cap.max(1), wake: None }))))
    }

    /// Queue one effect; the graph picks it up at once. Beyond `fx.queue_max` the oldest waiting ones are dropped.
    pub fn push(&self, ev: FxEvent) {
        let wake = {
            let mut i = self.0.borrow_mut();
            i.q.push_back(ev);
            while i.q.len() > i.cap {
                i.q.pop_front();
            }
            i.wake.clone()
        };
        if let Some(w) = wake {
            w();
        }
    }

    pub(crate) fn attach(&self, wake: Rc<dyn Fn()>) {
        self.0.borrow_mut().wake = Some(wake);
    }

}

/// A bus the graph's own wake closure holds (a strong clone would make the bus and the closure keep each other alive).
pub(crate) struct FxWeak(std::rc::Weak<RefCell<Inner>>);

impl FxWeak {
    pub(crate) fn drain(&self) -> Vec<FxEvent> {
        self.0.upgrade().map(|i| i.borrow_mut().q.drain(..).collect()).unwrap_or_default()
    }
}

impl FxBus {
    pub(crate) fn weak(&self) -> FxWeak {
        FxWeak(Rc::downgrade(&self.0))
    }
}

/// An effect being drawn, with the geometry fixed when it started.
pub struct Active {
    kind: FxKind,
    segs: Vec<Vec<[f32; 2]>>,
    stops: Vec<[f32; 2]>,
    t0: f64,
    col: [f32; 4],
    tcol: [f32; 4],
}

fn ease_out(u: f32) -> f32 {
    1.0 - (1.0 - u.clamp(0.0, 1.0)).powi(3)
}

fn colour(cfg: &FxCfg, key: &str) -> [f32; 4] {
    cfg.colors.get(key).and_then(|c| crate::color::parse_oklch(c)).unwrap_or([1.0, 1.0, 1.0, 1.0])
}

fn center(data: &GraphData, pos: &Pos, cfg: &GraphConfig, id: &str) -> Option<[f32; 2]> {
    let n = data.nodes.iter().find(|n| n.id == id)?;
    let (x, y) = pos.get(id)?;
    let (w, h) = geom::node_size(n, cfg);
    Some([x + w / 2.0, y + h / 2.0])
}

/// Fix an effect's geometry now: the wire between two stops when the graph has one, else the straight line.
pub fn start(ev: &FxEvent, data: &GraphData, wires: &[WireGeom], pos: &Pos, cfg: &GraphConfig, t0: f64) -> Option<Active> {
    let stops: Vec<[f32; 2]> = ev.path.iter().filter_map(|id| center(data, pos, cfg, id)).collect();
    if stops.len() != ev.path.len() || stops.is_empty() {
        return None;
    }
    let mut segs = Vec::new();
    if ev.kind == FxKind::Decision {
        for (i, pair) in ev.path.windows(2).enumerate() {
            let wire = data.edges.iter().position(|e| e.from == pair[0] && e.to == pair[1]).and_then(|ei| wires.iter().find(|w| w.edge == ei));
            segs.push(wire.map(|w| w.pts.clone()).unwrap_or_else(|| vec![stops[i], stops[i + 1]]));
        }
    }
    Some(Active { kind: ev.kind, segs, stops, t0, col: colour(&cfg.fx, &ev.color), tcol: colour(&cfg.fx, &ev.travel_color) })
}

fn with_alpha(c: [f32; 4], a: f32) -> [f32; 4] {
    [c[0], c[1], c[2], c[3] * a.clamp(0.0, 1.0)]
}

fn ring(out: &mut Vec<Particle>, at: [f32; 2], n: usize, radius: f32, u: f32, col: [f32; 4], size: f32, phase: f32) {
    if !(0.0..1.0).contains(&u) {
        return;
    }
    let r = radius * ease_out(u);
    for k in 0..n {
        let a = phase + k as f32 / n.max(1) as f32 * std::f32::consts::TAU;
        out.push(Particle { pos: [at[0] + a.cos() * r, at[1] + a.sin() * r], hot: false, col: Some(with_alpha(col, 1.0 - u)), r: size });
    }
}

/// The particles of `a` at time `t_ms`; `false` once it has finished.
pub fn frame(a: &Active, t_ms: f64, cfg: &FxCfg, out: &mut Vec<Particle>) -> bool {
    let e = (t_ms - a.t0).max(0.0) as f32;
    match a.kind {
        FxKind::Decision => {
            let (seg, burst) = (cfg.travel_ms.max(1.0), cfg.burst_ms.max(1.0));
            let n = a.segs.len();
            let total = n as f32 * seg + burst;
            if e >= total {
                return false;
            }
            if e < n as f32 * seg {
                let i = (e / seg) as usize;
                let u = (e - i as f32 * seg) / seg;
                let c = if i + 1 < n { a.tcol } else { a.col };
                for k in 0..=cfg.travel_trail {
                    let uk = (u - k as f32 * cfg.travel_trail_gap).max(0.0);
                    let fade = 1.0 - k as f32 / (cfg.travel_trail + 1) as f32;
                    out.push(Particle { pos: geom::along(&a.segs[i], ease_out(uk)), hot: false, col: Some(with_alpha(c, fade)), r: 1.0 + 0.6 * fade });
                }
            }
            for j in 0..n {
                let b = e - (j + 1) as f32 * seg;
                if (0.0..burst).contains(&b) {
                    let last = j + 1 == n;
                    ring(out, a.stops[j + 1], cfg.burst_count, cfg.burst_radius * if last { 1.0 } else { 0.5 }, b / burst, a.col, cfg.burst_size, j as f32 * 0.7);
                }
            }
            true
        }
        FxKind::Ripple => {
            if e >= cfg.ripple_ms {
                return false;
            }
            ring(out, a.stops[0], cfg.ripple_count, cfg.ripple_radius, e / cfg.ripple_ms, a.col, 1.0, 0.0);
            true
        }
        FxKind::Ring => {
            if e >= cfg.ring_ms * 1.35 {
                return false;
            }
            ring(out, a.stops[0], cfg.ring_count, cfg.ring_radius, e / cfg.ring_ms, a.col, 1.3, 0.0);
            ring(out, a.stops[0], cfg.ring_count, cfg.ring_radius, (e - 0.35 * cfg.ring_ms) / cfg.ring_ms, a.col, 1.3, 0.2);
            true
        }
        FxKind::Shake => {
            if e >= cfg.shake_ms {
                return false;
            }
            ring(out, a.stops[0], cfg.ripple_count, cfg.ripple_radius, e / cfg.shake_ms, a.col, 1.1, 0.0);
            true
        }
    }
}

thread_local! {
    static SEQ: Cell<u32> = const { Cell::new(0) };
}

/// Highlight `id`'s card: `data-fx` names the kind (the Full tier animates it), `data-fxc` the colour key; one timeout clears both,
/// unless a newer effect took the card meanwhile.
pub fn flash(root: &web_sys::Element, id: &str, kind: FxKind, color: &str, ms: u32) {
    let sel = format!("[data-id=\"{}\"]", id.replace('\\', "\\\\").replace('"', "\\\""));
    let Ok(Some(el)) = root.query_selector(&sel) else { return };
    let n = SEQ.with(|s| {
        s.set(s.get().wrapping_add(1));
        s.get()
    });
    let _ = el.set_attribute("data-fx", &format!("{}-{}", kind.name(), if n % 2 == 0 { "a" } else { "b" }));
    let _ = el.set_attribute("data-fxc", color);
    let _ = el.set_attribute("data-fxn", &n.to_string());
    let el2 = el.clone();
    let clear = Closure::once_into_js(move || {
        if el2.get_attribute("data-fxn").as_deref() == Some(&n.to_string()) {
            let _ = el2.remove_attribute("data-fx");
            let _ = el2.remove_attribute("data-fxc");
            let _ = el2.remove_attribute("data-fxn");
        }
    });
    if let Some(w) = web_sys::window() {
        let _ = w.set_timeout_with_callback_and_timeout_and_arguments_0(clear.unchecked_ref(), ms as i32);
    }
}

/// CSS rules that map `data-fxc="<key>"` to its colour (written once into the graph's own `<style>`).
pub fn colour_rules(cfg: &FxCfg) -> String {
    cfg.colors.iter().map(|(k, v)| format!(".ahg-node[data-fxc=\"{k}\"]{{--fx-c:{v}}}")).collect()
}

pub fn reduced_motion() -> bool {
    web_sys::window().and_then(|w| w.match_media("(prefers-reduced-motion: reduce)").ok().flatten()).is_some_and(|m| m.matches())
}
