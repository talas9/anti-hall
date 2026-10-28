//! Frame pacing for the Full tier. Three states, all from the budget in config:
//!   interact  - input within `interact_hold_ms`: requestAnimationFrame, capped at `fps_interact`
//!   effects   - a live effect is being drawn: setTimeout at `fx_fps`
//!   ambient   - nothing moving but flow particles / a hot path exist: setTimeout at `fps_ambient`
//!   idle      - no motion, or the tab is hidden: no timer at all (0 fps, 0 wakeups)

use crate::model::Budget;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use wasm_bindgen::prelude::*;

pub struct Pacer {
    budget: Budget,
    draw: RefCell<Box<dyn FnMut(f64) -> bool>>,
    last_input: Cell<f64>,
    last_frame: Cell<f64>,
    pending: Cell<bool>,
    ambient: Cell<bool>,
    fx: Cell<bool>,
    hidden: Cell<bool>,
    tick: RefCell<Option<Closure<dyn FnMut()>>>,
}

fn now() -> f64 {
    web_sys::window().and_then(|w| w.performance()).map(|p| p.now()).unwrap_or(0.0)
}

impl Pacer {
    pub fn new(budget: Budget, draw: Box<dyn FnMut(f64) -> bool>) -> Rc<Self> {
        let p = Rc::new(Self {
            budget,
            draw: RefCell::new(draw),
            last_input: Cell::new(f64::MIN),
            last_frame: Cell::new(0.0),
            pending: Cell::new(false),
            ambient: Cell::new(false),
            fx: Cell::new(false),
            hidden: Cell::new(web_sys::window().and_then(|w| w.document()).map(|d| d.hidden()).unwrap_or(false)),
            tick: RefCell::new(None),
        });
        let weak = Rc::downgrade(&p);
        *p.tick.borrow_mut() = Some(Closure::new(move || {
            if let Some(p) = weak.upgrade() {
                p.run();
            }
        }));
        let weak = Rc::downgrade(&p);
        let vis = Closure::<dyn FnMut()>::new(move || {
            if let Some(p) = weak.upgrade() {
                p.hidden.set(web_sys::window().and_then(|w| w.document()).map(|d| d.hidden()).unwrap_or(false));
                if !p.hidden.get() {
                    p.kick();
                }
            }
        });
        if let Some(d) = web_sys::window().and_then(|w| w.document()) {
            let _ = d.add_event_listener_with_callback("visibilitychange", vis.as_ref().unchecked_ref());
        }
        vis.forget();
        p
    }

    /// An input happened (pan, zoom, drag, data change): run at interact rate for a while.
    pub fn kick(self: &Rc<Self>) {
        self.last_input.set(now());
        self.schedule();
    }

    /// Whether anything keeps moving without input (flow particles, a hot path).
    pub fn set_ambient(self: &Rc<Self>, on: bool) {
        self.ambient.set(on);
        if on {
            self.schedule();
        }
    }

    /// A live effect is on screen (or just ended): run at the effect rate until the draw callback says it is over.
    pub fn set_fx(self: &Rc<Self>, on: bool) {
        self.fx.set(on);
        if on {
            self.schedule();
        }
    }

    fn interacting(&self, t: f64) -> bool {
        t - self.last_input.get() < self.budget.interact_hold_ms as f64
    }

    fn schedule(self: &Rc<Self>) {
        if self.pending.get() || self.hidden.get() {
            return;
        }
        let t = now();
        let (interval, raf) = if self.interacting(t) {
            (1000.0 / self.budget.fps_interact.max(1) as f64, true)
        } else if self.fx.get() && self.budget.fps_fx > 0 {
            (1000.0 / self.budget.fps_fx as f64, false)
        } else if self.ambient.get() && self.budget.fps_ambient > 0 {
            (1000.0 / self.budget.fps_ambient as f64, false)
        } else {
            return;
        };
        let wait = (self.last_frame.get() + interval - t).max(0.0);
        let Some(win) = web_sys::window() else { return };
        let tick = self.tick.borrow();
        let Some(cb) = tick.as_ref() else { return };
        self.pending.set(true);
        // rAF only when a frame is due now and we are interacting; otherwise a timer sized to the remaining interval.
        if raf && wait < 4.0 {
            let _ = win.request_animation_frame(cb.as_ref().unchecked_ref());
        } else {
            let _ = win.set_timeout_with_callback_and_timeout_and_arguments_0(cb.as_ref().unchecked_ref(), wait.ceil() as i32);
        }
    }

    fn run(self: &Rc<Self>) {
        self.pending.set(false);
        if self.hidden.get() {
            return;
        }
        let t = now();
        self.last_frame.set(t);
        let more = (self.draw.borrow_mut())(t);
        self.fx.set(more);
        self.schedule();
    }
}

impl Drop for Pacer {
    fn drop(&mut self) {
        // a frame or timer already asked for may still fire after the graph is gone: its callback must outlive this pacer (it finds
        // no pacer and does nothing) instead of being dropped under the browser, which throws "closure invoked after being dropped"
        if let Some(tick) = self.tick.get_mut().take() {
            tick.forget();
        }
    }
}
