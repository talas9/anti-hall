//! The Live screen: every hook decision as it happens (event -> check -> decision), every action on its node, on the shared graph
//! component. The stream's decisions and action-log lines come in through `on_snapshot` / `on_delta` (called by the connection code);
//! this module keeps a small model of them, turns it into graph data at most every `web.live_tick_ms`, and drops the live effects
//! into the graph's `FxBus` the moment they arrive. Full draws particles and bursts, Lite flashes the nodes; both show the counters,
//! the timeline strip and the side panel. Nothing is drawn or timed while the screen is not shown.
use super::{get_detail, now_ms, open_detail, post_action, since, tier_of, tx, Ctx};
use ah_web_graph::{ActionCall, ActionDef, FxBus, FxEvent, FxKind, Graph, GraphConfig, GraphData, LayoutMode, NodeDef, Tier};
use ah_web_proto::{ActionEvt, ActionReq, JevEvt, Agent, Boot, Decision, Delta, LiveCfg, LiveMap, Snapshot, LIVE_MAP_PATH};
use leptos::prelude::*;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

/// Fixed slots of one column: a node keeps its row; when the column is full the least recently active node gives its row up.
#[derive(Default)]
struct Slots {
    ids: Vec<Option<String>>,
}

impl Slots {
    fn place(&mut self, id: &str, last: &HashMap<String, u64>, cap: usize) -> usize {
        if let Some(i) = self.ids.iter().position(|x| x.as_deref() == Some(id)) {
            return i;
        }
        if let Some(i) = self.ids.iter().position(Option::is_none) {
            self.ids[i] = Some(id.to_string());
            return i;
        }
        if self.ids.len() < cap {
            self.ids.push(Some(id.to_string()));
            return self.ids.len() - 1;
        }
        let victim = (0..self.ids.len()).min_by_key(|i| self.ids[*i].as_ref().and_then(|v| last.get(v)).copied().unwrap_or(0)).unwrap_or(0);
        self.ids[victim] = Some(id.to_string());
        victim
    }

    fn drop_if(&mut self, mut gone: impl FnMut(&str) -> bool) {
        for s in &mut self.ids {
            if s.as_deref().is_some_and(&mut gone) {
                *s = None;
            }
        }
    }
}

/// One second of decisions: totals, blocks, and the hits per edge and per check.
struct Bucket {
    sec: u64,
    total: u32,
    blocks: u32,
    edges: HashMap<String, u32>,
    checks: HashMap<String, u32>,
}

#[derive(Clone, Default, PartialEq)]
pub struct Counters {
    /// Decisions per second over the rate window, in tenths.
    rate_x10: u32,
    blocks: u32,
    top: Vec<(String, u32)>,
    jev_calls: u32,
}

struct Inner {
    cfg: LiveCfg,
    ui: std::collections::BTreeMap<String, String>,
    map: LiveMap,
    events: Slots,
    checks: Slots,
    rules: Slots,
    agents: Slots,
    jev: VecDeque<JevEvt>,
    last: HashMap<String, u64>,
    rule_of: HashMap<String, String>,
    recent: HashMap<String, VecDeque<Decision>>,
    acts: HashMap<String, VecDeque<ActionEvt>>,
    seen_edges: HashSet<String>,
    buckets: VecDeque<Bucket>,
    timeline: VecDeque<Decision>,
    last_ts: u64,
    mounted: bool,
    reduced: bool,
    bus: Option<FxBus>,
    local: Vec<(String, u64)>,
    dirty: bool,
    /// Bumped when the timeline changed, so the tick only copies it then.
    timeline_rev: u64,
}

/// The outputs the screen reads; set while the screen is shown.
#[derive(Clone, Copy)]
struct Sink {
    graph: RwSignal<GraphData>,
    timeline: RwSignal<Vec<Decision>>,
    counters: RwSignal<Counters>,
    panel_rev: RwSignal<u64>,
    snap: RwSignal<Snapshot>,
}

struct Hub {
    inner: RefCell<Inner>,
    sink: Cell<Option<Sink>>,
    timer: Cell<Option<i32>>,
    cb: RefCell<Option<Closure<dyn FnMut()>>>,
    timeline_seen: Cell<u64>,
}

thread_local! {
    static HUB: RefCell<Option<Rc<Hub>>> = const { RefCell::new(None) };
}

fn hub() -> Option<Rc<Hub>> {
    HUB.with(|h| h.borrow().clone())
}

/// Called once with the boot data.
pub fn init(boot: &Boot) {
    let inner = Inner {
        cfg: boot.live.clone(),
        ui: boot.ui.clone(),
        map: LiveMap::default(),
        events: Slots::default(),
        checks: Slots::default(),
        rules: Slots::default(),
        jev: VecDeque::new(),
        agents: Slots::default(),
        last: HashMap::new(),
        rule_of: HashMap::new(),
        recent: HashMap::new(),
        acts: HashMap::new(),
        seen_edges: HashSet::new(),
        buckets: VecDeque::new(),
        timeline: VecDeque::new(),
        last_ts: 0,
        mounted: false,
        reduced: false,
        bus: None,
        local: Vec::new(),
        dirty: false,
        timeline_rev: 0,
    };
    let h = Rc::new(Hub { inner: RefCell::new(inner), sink: Cell::new(None), timer: Cell::new(None), cb: RefCell::new(None), timeline_seen: Cell::new(0) });
    HUB.with(|slot| *slot.borrow_mut() = Some(h));
}

/// A snapshot arrived: its decisions are history (no effects).
pub fn on_snapshot(s: &Snapshot) {
    if let Some(h) = hub() {
        let mut i = h.inner.borrow_mut();
        for d in &s.decisions {
            i.record(d, false);
        }
    }
}

/// A delta arrived: its decisions and actions play as effects when the screen is shown.
pub fn on_delta(d: &Delta) {
    if d.decisions.is_empty() && d.actions.is_empty() && d.jev.is_empty() {
        return;
    }
    let Some(h) = hub() else { return };
    {
        let mut i = h.inner.borrow_mut();
        for x in &d.decisions {
            i.record(x, true);
        }
        for a in &d.actions {
            i.record_action(a);
        }
        for j in &d.jev {
            i.record_jev(j);
        }
    }
    h.ensure_ticking();
}

fn node_ev(e: &str) -> String {
    format!("ev:{e}")
}
fn node_ck(c: &str) -> String {
    format!("ck:{c}")
}
fn node_dn(fx: &str) -> String {
    format!("dn:{fx}")
}
fn node_ru(r: &str) -> String {
    format!("ru:{r}")
}
fn edge_cr(c: &str, r: &str) -> String {
    format!("r|{c}|{r}")
}
fn edge_rd(r: &str, fx: &str) -> String {
    format!("q|{r}|{fx}")
}
fn edge_ec(e: &str, c: &str) -> String {
    format!("e|{e}|{c}")
}
fn edge_cd(c: &str, fx: &str) -> String {
    format!("k|{c}|{fx}")
}

fn push_cap<T>(q: &mut VecDeque<T>, v: T, cap: usize) {
    q.push_back(v);
    while q.len() > cap {
        q.pop_front();
    }
}

impl Inner {
    /// A label from the boot texts (a missing key shows itself).
    fn t(&self, key: &str) -> String {
        self.ui.get(key).cloned().unwrap_or_else(|| key.to_string())
    }

    fn fx_key(&self, d: &Decision) -> String {
        if d.fx.is_empty() { self.cfg.travel_fx.clone() } else { d.fx.clone() }
    }

    fn record(&mut self, d: &Decision, live: bool) {
        if !live && d.ts_ms <= self.last_ts {
            return; // a snapshot repeating what the page already has
        }
        self.last_ts = self.last_ts.max(d.ts_ms);
        let fx = self.fx_key(d);
        let (ev, ck, dn) = (node_ev(&d.event), node_ck(&d.check), node_dn(&fx));
        self.events.place(&ev, &self.last, self.cfg.events_max);
        self.checks.place(&ck, &self.last, self.cfg.checks_max);
        for id in [&ev, &ck, &dn] {
            self.last.insert(id.clone(), d.ts_ms);
            push_cap(self.recent.entry(id.clone()).or_default(), d.clone(), self.cfg.panel_rows);
        }
        self.rule_of.insert(ck.clone(), d.rule.clone());
        let e1 = edge_ec(&d.event, &d.check);
        // the rule that named the check sits between the check and the decision; a row without one goes straight to the decision
        let (via, tail): (Option<String>, Vec<String>) = if d.rule.is_empty() {
            (None, vec![edge_cd(&d.check, &fx)])
        } else {
            let ru = node_ru(&d.rule);
            self.rules.place(&ru, &self.last, self.cfg.rules_max);
            self.last.insert(ru.clone(), d.ts_ms);
            push_cap(self.recent.entry(ru.clone()).or_default(), d.clone(), self.cfg.panel_rows);
            (Some(ru), vec![edge_cr(&d.check, &d.rule), edge_rd(&d.rule, &fx)])
        };
        self.seen_edges.insert(e1.clone());
        for e in &tail {
            self.seen_edges.insert(e.clone());
        }
        let sec = d.ts_ms / 1000;
        if self.buckets.back().is_none_or(|b| b.sec != sec) {
            self.buckets.push_back(Bucket { sec, total: 0, blocks: 0, edges: HashMap::new(), checks: HashMap::new() });
        }
        if let Some(b) = self.buckets.back_mut() {
            b.total += 1;
            b.blocks += u32::from(self.cfg.block_decisions.contains(&d.decision));
            *b.edges.entry(e1).or_default() += 1;
            for e in tail {
                *b.edges.entry(e).or_default() += 1;
            }
            *b.checks.entry(d.check.clone()).or_default() += 1;
        }
        push_cap(&mut self.timeline, d.clone(), self.cfg.timeline_max);
        self.timeline_rev += 1;
        self.dirty = true;
        // the agent that ran the hook starts the path, when the engine recorded it and the agent is drawn
        let agent = Some(format!("a:{}", d.session)).filter(|a| !d.session.is_empty() && self.agents.ids.iter().flatten().any(|x| x == a));
        if live && self.mounted && !self.reduced {
            if let Some(bus) = &self.bus {
                bus.push(FxEvent { kind: FxKind::Decision, path: [agent, Some(ev), Some(ck), via, Some(dn)].into_iter().flatten().collect(), color: fx, travel_color: self.cfg.travel_fx.clone() });
            }
        }
    }

    fn record_jev(&mut self, j: &JevEvt) {
        push_cap(&mut self.jev, j.clone(), self.cfg.panel_rows.max(self.cfg.top_n * 4));
        self.last.insert("mind".into(), j.ts_ms);
        let ck = node_ck(&j.check);
        let asked = !j.check.is_empty() && self.checks.ids.iter().flatten().any(|x| *x == ck);
        if asked {
            self.seen_edges.insert(format!("j|{}|mind", j.check));
        }
        self.dirty = true;
        if self.mounted && !self.reduced {
            if let Some(bus) = &self.bus {
                let color = self.cfg.jev_fx.get(&j.mode).cloned().unwrap_or_default();
                // the asking check's particle flows into the mind, which then pulses; without a recorded check only the pulse plays
                let path = if asked { vec![ck, "mind".to_string()] } else { vec!["mind".to_string()] };
                bus.push(FxEvent { kind: if asked { FxKind::Decision } else { FxKind::Ring }, path, color: color.clone(), travel_color: color });
            }
        }
    }

    /// The node an action's target names: an agent, else the engine.
    fn node_of(&self, target: &str) -> String {
        let a = format!("a:{target}");
        if self.agents.ids.iter().flatten().any(|x| *x == a) {
            return a;
        }
        "engine".to_string()
    }

    fn record_action(&mut self, a: &ActionEvt) {
        let node = self.node_of(&a.target);
        push_cap(self.acts.entry(node.clone()).or_default(), a.clone(), self.cfg.panel_rows);
        self.dirty = true;
        if !self.mounted || self.reduced || self.bus.is_none() {
            return;
        }
        let now = now_ms();
        self.local.retain(|(_, t)| now.saturating_sub(*t) < 3000);
        if self.local.iter().any(|(n, _)| *n == node) {
            return; // the page played this one itself when the person chose it
        }
        self.play_action(&node, &a.action, &a.outcome);
    }

    fn play_action(&self, node: &str, action: &str, outcome: &str) {
        let Some(bus) = &self.bus else { return };
        let word = |k: &str| self.cfg.action_fx.get(k).cloned();
        let name = word(action).or_else(|| action.rsplit('-').next().and_then(word)).or_else(|| word("default")).unwrap_or_default();
        let kind = if outcome == "refused" { FxKind::Shake } else { FxKind::parse(&name).unwrap_or(FxKind::Ripple) };
        let color = self.cfg.outcome_fx.get(outcome).cloned().unwrap_or_default();
        bus.push(FxEvent { kind, path: vec![node.to_string()], color: color.clone(), travel_color: color });
    }

    fn sync_agents(&mut self, agents: &[Agent]) {
        let live: HashSet<String> = agents.iter().map(|a| format!("a:{}", a.id)).collect();
        self.agents.drop_if(|id| !live.contains(id));
        for a in agents.iter().take(self.cfg.checks_max) {
            self.agents.place(&format!("a:{}", a.id), &self.last, self.cfg.checks_max);
        }
    }

    fn window_sums(&self, now_ms: u64, secs: u64) -> (u32, u32, HashMap<&str, u32>, HashMap<&str, u32>) {
        let from = (now_ms / 1000).saturating_sub(secs);
        let (mut total, mut blocks) = (0, 0);
        let (mut edges, mut checks): (HashMap<&str, u32>, HashMap<&str, u32>) = (HashMap::new(), HashMap::new());
        for b in self.buckets.iter().filter(|b| b.sec >= from) {
            total += b.total;
            blocks += b.blocks;
            for (k, v) in &b.edges {
                *edges.entry(k).or_default() += v;
            }
            for (k, v) in &b.checks {
                *checks.entry(k).or_default() += v;
            }
        }
        (total, blocks, edges, checks)
    }

    fn counters(&self, now_ms: u64) -> Counters {
        let c = &self.cfg;
        let (total, _, _, _) = self.window_sums(now_ms, c.rate_window_s);
        let (_, blocks, _, checks) = self.window_sums(now_ms, c.block_window_s);
        let mut top: Vec<(String, u32)> = checks.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        top.truncate(c.top_n);
        let from = (now_ms / 1000).saturating_sub(c.block_window_s) * 1000;
        let jev_calls = self.jev.iter().filter(|j| j.ts_ms >= from).count() as u32;
        Counters { jev_calls, rate_x10: (total as f32 * 10.0 / c.rate_window_s.max(1) as f32).round() as u32, blocks, top }
    }

    fn graph(&self, now_ms: u64, agents: &[Agent]) -> GraphData {
        let c = self.cfg.clone();
        let win = c.rate_window_s.max(1) as f32;
        let (_, _, er, _) = self.window_sums(now_ms, c.rate_window_s);
        let er: HashMap<String, f32> = er.into_iter().map(|(k, v)| (k.to_string(), v as f32 / win)).collect();
        let rate_of = |prefix: &str, id: &str, pos: usize| -> f32 { er.iter().filter(|(k, _)| k.starts_with(prefix) && k.split('|').nth(pos) == Some(id)).map(|(_, v)| *v).sum() };
        let per_s = self.t("live_per_s");
        let mut nodes = Vec::new();
        let mut node = |id: String, label: String, sub: String, kind: &str, col: f32, row: usize, status: &str| {
            nodes.push(NodeDef {
                id,
                label,
                sub,
                kind: kind.to_string(),
                status: status.to_string(),
                x: Some(col * c.col_gap),
                y: Some(row as f32 * c.row_gap),
                ports_in: vec![],
                ports_out: vec![],
            });
        };
        node("engine".into(), self.t("live_engine"), self.t("live_engine_sub"), "engine", 0.0, 0, "running");
        for (row, id) in self.agents.ids.iter().enumerate() {
            let Some(id) = id else { continue };
            let Some(a) = agents.iter().find(|a| format!("a:{}", a.id) == *id) else { continue };
            let kind = match (a.kind.as_str(), a.state == "running") {
                (_, false) => "idle",
                ("main", _) => "primary",
                ("workspace", _) => "workspace",
                ("codex", _) => "codex",
                _ => "subagent",
            };
            node(id.clone(), a.label.clone(), a.step.chars().take(34).collect(), kind, 0.0, row + 1, &a.state);
        }
        let visible_ev: HashSet<&str> = self.events.ids.iter().flatten().map(String::as_str).collect();
        let visible_ck: HashSet<&str> = self.checks.ids.iter().flatten().map(String::as_str).collect();
        let visible_ru: HashSet<&str> = self.rules.ids.iter().flatten().map(String::as_str).collect();
        for (row, id) in self.events.ids.iter().enumerate() {
            let Some(id) = id else { continue };
            let name = id.trim_start_matches("ev:");
            let bound = self.map.edges.iter().filter(|(e, _)| e == name).count();
            let sub = format!("{:.1}{per_s}{}", rate_of("e|", name, 1), if bound > 0 { format!(" · {bound} {}", self.t("live_n_checks")) } else { String::new() });
            node(id.clone(), name.to_string(), sub, "event", 1.0, row, "ok");
        }
        for (row, id) in self.checks.ids.iter().enumerate() {
            let Some(id) = id else { continue };
            let name = id.trim_start_matches("ck:");
            let rule = self.rule_of.get(id).filter(|r| !r.is_empty()).map(|r| format!(" · {r}")).unwrap_or_default();
            node(id.clone(), name.to_string(), format!("{:.1}{per_s}{rule}", rate_of("e|", name, 2)), "check", 2.0, row, "ok");
        }
        for (row, id) in self.rules.ids.iter().enumerate() {
            let Some(id) = id else { continue };
            let name = id.trim_start_matches("ru:");
            node(id.clone(), name.to_string(), format!("{:.1}{per_s}", rate_of("r|", name, 2)), "rule", 3.0, row, "ok");
        }
        for (row, key) in ["allow", "advise", "inject", "block"].iter().enumerate() {
            let id = node_dn(key);
            let sub = format!("{:.1}{per_s}", rate_of("k|", key, 2) + rate_of("q|", key, 2));
            node(id, self.t(&format!("live_fx_{key}")), sub, key, 5.0, row * 2 + 1, "ok");
        }
        {
            let (sub, status) = match self.jev.back() {
                None => (self.t("live_mind_idle"), "idle"),
                Some(j) => (
                    self.t("live_mind_sub").replace("{id}", &j.id).replace("{conf}", &j.conf.map_or_else(|| self.t("live_unavailable"), |c| format!("{c:.2}"))).replace("{mode}", &self.t(&format!("live_mode_{}", j.mode))),
                    if now_ms.saturating_sub(j.ts_ms) > c.rate_window_s * 1000 { "idle" } else { match j.mode.as_str() { "on" => "running", "shadow" => "waiting", _ => "idle" } },
                ),
            };
            node("mind".into(), self.t("live_mind"), sub, "jev", 4.0, 4, status);
        }
        let mut edges = Vec::new();
        let mut seen = HashSet::new();
        let mut edge = |id: String, from: String, to: String, rate: f32| {
            if seen.insert(id.clone()) {
                edges.push(ah_web_graph::EdgeDef { id, from, from_port: String::new(), to, to_port: String::new(), label: String::new(), rate });
            }
        };
        for (e, k) in &self.map.edges {
            if visible_ev.contains(node_ev(e).as_str()) && visible_ck.contains(node_ck(k).as_str()) {
                let id = edge_ec(e, k);
                edge(id.clone(), node_ev(e), node_ck(k), er.get(&id).copied().unwrap_or(0.0));
            }
        }
        for id in &self.seen_edges {
            let parts: Vec<&str> = id.split('|').collect();
            let (Some(kind), Some(a), Some(b)) = (parts.first(), parts.get(1), parts.get(2)) else { continue };
            let (from, to) = match *kind {
                "e" => (node_ev(a), node_ck(b)),
                "r" => (node_ck(a), node_ru(b)),
                "q" => (node_ru(a), node_dn(b)),
                "j" => (node_ck(a), "mind".to_string()),
                _ => (node_ck(a), node_dn(b)),
            };
            let known = match *kind {
                "e" => visible_ev.contains(from.as_str()) && visible_ck.contains(to.as_str()),
                "r" => visible_ck.contains(from.as_str()) && visible_ru.contains(to.as_str()),
                "q" => visible_ru.contains(from.as_str()),
                "j" => visible_ck.contains(from.as_str()),
                _ => visible_ck.contains(from.as_str()),
            };
            if known {
                edge(id.clone(), from, to, er.get(id).copied().unwrap_or(0.0));
            }
        }
        edges.sort_by(|a, b| a.id.cmp(&b.id));
        GraphData { nodes, edges }
    }
}

impl Hub {
    /// Start the update timer if it is not running. It stops itself when nothing moves any more.
    fn ensure_ticking(self: &Rc<Self>) {
        if self.timer.get().is_some() || self.sink.get().is_none() {
            return;
        }
        let tick_ms = self.inner.borrow().cfg.tick_ms.max(100) as i32;
        let me = Rc::downgrade(self);
        let cb = Closure::<dyn FnMut()>::new(move || {
            if let Some(h) = me.upgrade() {
                if !h.tick() {
                    h.stop();
                }
            }
        });
        let Some(w) = web_sys::window() else { return };
        if let Ok(id) = w.set_interval_with_callback_and_timeout_and_arguments_0(cb.as_ref().unchecked_ref(), tick_ms) {
            self.timer.set(Some(id));
            *self.cb.borrow_mut() = Some(cb);
        }
        self.tick();
    }

    fn stop(&self) {
        if let (Some(id), Some(w)) = (self.timer.take(), web_sys::window()) {
            w.clear_interval_with_handle(id);
        }
        self.cb.borrow_mut().take();
    }

    /// One update of the graph data, counters and timeline; `true` while something is still moving.
    fn tick(&self) -> bool {
        let Some(sink) = self.sink.get() else { return false };
        if web_sys::window().and_then(|w| w.document()).is_some_and(|d| d.hidden()) {
            return false; // hidden: no timer at all; `watch_visibility` starts it again when the tab is shown
        }
        let now = now_ms();
        let agents = sink.snap.with_untracked(|s| s.agents.clone());
        let (data, counters, timeline, more, rev) = {
            let mut i = self.inner.borrow_mut();
            i.sync_agents(&agents);
            let data = i.graph(now, &agents);
            let counters = i.counters(now);
            let keep = i.cfg.block_window_s.max(i.cfg.rate_window_s);
            let from = (now / 1000).saturating_sub(keep);
            while i.buckets.front().is_some_and(|b| b.sec < from) {
                i.buckets.pop_front();
            }
            let moving = data.edges.iter().any(|e| e.rate > 0.0) || i.dirty;
            i.dirty = false;
            let timeline = (i.timeline_rev != self.timeline_seen.get()).then(|| i.timeline.iter().cloned().collect::<Vec<_>>());
            (data, counters, timeline, moving, i.timeline_rev)
        };
        if sink.graph.with_untracked(|g| *g != data) {
            sink.graph.set(data);
        }
        if sink.counters.with_untracked(|c| *c != counters) {
            sink.counters.set(counters);
        }
        if let Some(t) = timeline {
            self.timeline_seen.set(rev);
            sink.timeline.set(t);
            sink.panel_rev.update(|r| *r += 1);
        }
        more
    }
}

/// Start the update timer again when the tab becomes visible (it stops itself while hidden). Added once per page.
fn watch_visibility() {
    thread_local! {
        static DONE: Cell<bool> = const { Cell::new(false) };
    }
    if DONE.with(|d| d.replace(true)) {
        return;
    }
    let cb = Closure::<dyn FnMut()>::new(|| {
        if let Some(h) = hub() {
            h.inner.borrow_mut().dirty = true;
            h.ensure_ticking();
        }
    });
    if let Some(d) = web_sys::window().and_then(|w| w.document()) {
        let _ = d.add_event_listener_with_callback("visibilitychange", cb.as_ref().unchecked_ref());
    }
    cb.forget();
}

async fn fetch_map() -> Option<LiveMap> {
    let w = web_sys::window()?;
    let resp: web_sys::Response = JsFuture::from(w.fetch_with_str(LIVE_MAP_PATH)).await.ok()?.dyn_into().ok()?;
    let text = JsFuture::from(resp.text().ok()?).await.ok()?.as_string()?;
    serde_json::from_str(&text).ok()
}

fn fx_class(d: &Decision, cfg: &LiveCfg) -> String {
    format!("tl-{}", if d.fx.is_empty() { cfg.travel_fx.as_str() } else { d.fx.as_str() })
}

/// The screen. `active` is true while the Live item is chosen; nothing exists (no graph, no timer) while it is not.
#[component]
pub fn LiveScreen(mode: RwSignal<String>, active: Signal<bool>) -> impl IntoView {
    view! { <Show when=move || active.get()><LiveBody mode=mode /></Show> }
}

#[component]
fn LiveBody(mode: RwSignal<String>) -> impl IntoView {
    let ctx = expect_context::<Ctx>();
    let boot = expect_context::<Arc<Boot>>();
    let Some(h) = hub() else { return view! { <p class="empty">{tx("live_waiting")}</p> }.into_any() };
    let cfg: Option<Arc<GraphConfig>> = serde_json::from_str(&boot.graph).ok().map(Arc::new);
    let Some(cfg) = cfg else { return view! { <p class="empty">{tx("live_no_config")}</p> }.into_any() };
    let sink = Sink {
        graph: RwSignal::new(GraphData::default()),
        timeline: RwSignal::new(Vec::new()),
        counters: RwSignal::new(Counters::default()),
        panel_rev: RwSignal::new(0),
        snap: ctx.snap,
    };
    let bus = FxBus::new(cfg.fx.queue_max);
    {
        let mut i = h.inner.borrow_mut();
        i.bus = Some(bus.clone());
        i.mounted = true;
        i.reduced = !matches!(tier_of(&mode.get_untracked()), "full");
        // the first picture shows what the page already knows
        let hist: Vec<Decision> = ctx.snap.with_untracked(|s| s.decisions.clone());
        for d in hist {
            i.record(&d, false);
        }
        i.dirty = true;
    }
    h.sink.set(Some(sink));
    h.timeline_seen.set(u64::MAX);
    h.ensure_ticking();
    leptos::task::spawn_local(async move {
        if let Some(m) = fetch_map().await {
            if let Some(h) = hub() {
                h.inner.borrow_mut().map = m;
                h.inner.borrow_mut().dirty = true;
                h.ensure_ticking();
            }
        }
    });
    on_cleanup(|| {
        if let Some(h) = hub() {
            h.stop();
            h.sink.set(None);
            let mut i = h.inner.borrow_mut();
            i.mounted = false;
            i.bus = None;
        }
    });
    watch_visibility();

    let selected = RwSignal::new(None::<String>);
    let lc = boot.live.clone();
    let actions = {
        let boot = boot.clone();
        Callback::new(move |id: String| -> Vec<ActionDef> {
            if !id.starts_with("a:") {
                return Vec::new();
            }
            boot.actions
                .iter()
                .map(|a| ActionDef { id: a.name.clone(), label: tx(&a.label), destructive: a.confirm, enabled: true, note: if a.confirm { tx("act_confirm_stop") } else { String::new() } })
                .collect()
        })
    };
    let on_action = {
        let boot = boot.clone();
        Callback::new(move |c: ActionCall| {
            let Some(agent) = c.node.strip_prefix("a:").map(str::to_string) else {
                c.done.run(false);
                return;
            };
            let Some(def) = boot.actions.iter().find(|a| a.name == c.action) else {
                c.done.run(false);
                return;
            };
            if def.local {
                open_detail(ctx, agent);
                c.done.run(true);
                return;
            }
            let (node, action, done) = (c.node.clone(), c.action.clone(), c.done);
            leptos::task::spawn_local(async move {
                let res = post_action(&ActionReq { id: agent, action: action.clone(), confirmed: true }).await;
                let (ok, outcome) = match &res {
                    Ok(r) => (r.ok, r.outcome.clone()),
                    Err(_) => (false, "failed".to_string()),
                };
                if let Some(h) = hub() {
                    let mut i = h.inner.borrow_mut();
                    i.local.push((node.clone(), now_ms()));
                    if i.mounted && !i.reduced {
                        i.play_action(&node, &action, if ok { "ok" } else { &outcome });
                    }
                }
                done.run(ok);
            });
        })
    };
    let panel = Callback::new(move |id: String| view! { <Panel id=id sink=sink /> }.into_any());
    let cfg2 = cfg.clone();
    let graph = move || {
        let tier = if tier_of(&mode.get()) == "full" { Tier::Full } else { Tier::Lite };
        if let Some(h) = hub() {
            h.inner.borrow_mut().reduced = tier == Tier::Lite;
        }
        view! {
            <Graph data=sink.graph.into() cfg=cfg2.clone() tier=tier mode=LayoutMode::Layered actions=actions on_action=on_action selected=selected panel=panel fx=bus.clone() />
        }
    };
    let counters = sink.counters;
    let timeline = sink.timeline;
    let lc2 = lc.clone();
    view! {
        <div class="live">
            <div class="main-head">
                <h1>{tx("title_live")}</h1>
                <span class="counts">{tx("live_hint")}</span>
                <div class="grow"></div>
            </div>
            <div class="live-stats">
                <div class="stat"><div class="stat-k">{tx("live_rate")}</div><div class="stat-v">{move || format!("{:.1}", counters.with(|c| c.rate_x10) as f32 / 10.0)}</div></div>
                <div class="stat"><div class="stat-k">{tx("pill_cpu")}</div><div class="stat-v">{move || ctx.snap.with(|s| s.pulse.as_ref().and_then(|p| p.cpu_permille).map_or_else(|| "\u{2014}".to_string(), |v| format!("{:.1}%", v as f64 / 10.0)))}</div></div>
                <div class="stat"><div class="stat-k">{tx("pill_mem")}</div><div class="stat-v">{move || ctx.snap.with(|s| s.pulse.as_ref().map_or_else(|| "\u{2014}".to_string(), |p| format!("{} MB", p.rss_kb / 1024)))}</div></div>
                <div class="stat"><div class="stat-k">"Jev"</div><div class="stat-v">{move || counters.with(|c| c.jev_calls)}</div></div>
                <div class="stat"><div class="stat-k">{tx("live_blocks")}</div><div class="stat-v live-block">{move || counters.with(|c| c.blocks)}</div></div>
                <div class="stat live-top"><div class="stat-k">{tx("live_top")}</div>
                    <ol>{move || counters.with(|c| c.top.iter().map(|(n, v)| view! { <li><span>{n.clone()}</span><b>{*v}</b></li> }).collect_view())}</ol>
                </div>
            </div>
            <div class="live-cols" aria-hidden="true">
                <span>{tx("live_col_agents")}</span><span>{tx("live_col_events")}</span><span>{tx("live_col_checks")}</span><span>{tx("live_col_rules")}</span><span></span><span>{tx("live_col_decisions")}</span>
            </div>
            <div class="live-graph">{graph}</div>
            <section class="live-timeline" aria-label=tx("live_timeline")>
                <div class="sect">{tx("live_timeline")}</div>
                <Show when=move || timeline.with(|t| t.is_empty())><p class="soft-note">{tx("live_waiting")}</p></Show>
                <ol aria-live="off">
                    {move || {
                        let lc = lc2.clone();
                        timeline.with(|t| t.iter().rev().map(|d| {
                            let cls = format!("tl {}", fx_class(d, &lc));
                            view! { <li class=cls><i></i><span class="tl-check">{d.check.clone()}</span><span class="tl-ev">{d.event.clone()}</span><span class="tl-age">{since(d.ts_ms)}</span></li> }
                        }).collect_view())
                    }}
                </ol>
            </section>
            <p class="soft-note">{tx("live_attrib_note")}</p>
        </div>
    }
    .into_any()
}

/// The side panel of a node: its recent decisions (or, for an agent or the engine, its recent actions).
#[component]
fn Panel(id: String, sink: Sink) -> impl IntoView {
    let id2 = id.clone();
    view! {
        <div class="live-panel">
            {move || {
                sink.panel_rev.get();
                let h = hub();
                let (decisions, acts) = h.clone().map(|h| {
                    let i = h.inner.borrow();
                    (i.recent.get(&id2).cloned().unwrap_or_default(), i.acts.get(&id2).cloned().unwrap_or_default())
                }).unwrap_or_default();
                if id2 == "mind" {
                    let rows = h.as_ref().map(|h| h.inner.borrow().jev.iter().rev().cloned().collect::<Vec<_>>()).unwrap_or_default();
                    let na = tx("live_unavailable");
                    return view! {
                        <div class="sect">{tx("live_mind")}</div>
                        <p class="soft-note">{tx("live_jev_title")}</p>
                        {rows.is_empty().then(|| view! { <p class="soft-note">{tx("live_jev_none")}</p> })}
                        <ul class="live-rows jev">
                            {rows.into_iter().map(|j| view! {
                                <li class="jev-row">
                                    <b>{j.id.clone()}</b> <span class="tl-ev">{format!("{} · {}", tx(&format!("live_mode_{}", j.mode)), if j.verdict.is_empty() { na.clone() } else { j.verdict.clone() })}</span>
                                    <span class="tl-rule">{format!("{} {} · {} {} ms · {} {} · {} {} · {} {}", tx("live_conf"), j.conf.map_or_else(|| na.clone(), |c| format!("{c:.2}")), tx("live_latency"), j.latency_ms, tx("live_cost"), j.cost_usd.map_or_else(|| na.clone(), |c| format!("${c:.4}")), tx("live_question"), na, tx("live_evidence"), na)}</span>
                                    {(!j.reason.is_empty()).then(|| view! { <span class="tl-rule">{j.reason.clone()}</span> })}
                                    <span class="tl-age">{since(j.ts_ms)}</span>
                                </li>
                            }).collect_view()}
                        </ul>
                    }.into_any();
                }
                let title = id2.split_once(':').map(|(_, n)| n.to_string()).unwrap_or_else(|| id2.clone());
                view! {
                    <div class="sect">{title}</div>
                    {id2.strip_prefix("a:").map(|a| view! { <Tasks agent=a.to_string() /> })}
                    <p class="soft-note">{tx("live_panel_title")}</p>
                    {(decisions.is_empty() && acts.is_empty()).then(|| view! { <p class="soft-note">{tx("live_panel_empty")}</p> })}
                    <ul class="live-rows">
                        {decisions.iter().rev().map(|d| view! {
                            <li class=format!("tl tl-{}", d.fx)><i></i><span class="tl-check">{d.check.clone()}</span><span class="tl-ev">{format!("{} · {}", d.event, d.decision)}</span>
                                <span class="tl-age">{since(d.ts_ms)}</span>{(!d.rule.is_empty()).then(|| view! { <span class="tl-rule">{d.rule.clone()}</span> })}</li>
                        }).collect_view()}
                        {acts.iter().rev().map(|a| view! {
                            <li class="tl tl-action"><i></i><span class="tl-check">{a.action.clone()}</span><span class="tl-ev">{format!("{} · {}", a.outcome, a.reason)}</span><span class="tl-age">{since(a.ts_ms)}</span></li>
                        }).collect_view()}
                    </ul>
                }.into_any()
            }}
        </div>
    }
}

/// The task list of one agent (`agents agent=<id>`), fetched when its panel opens. Without a list the page says so.
#[component]
fn Tasks(agent: String) -> impl IntoView {
    let state = RwSignal::new(None::<ah_web_proto::Detail>);
    leptos::task::spawn_local(async move { state.set(Some(get_detail(&agent).await.unwrap_or_default())) });
    view! {
        <div class="sect">{tx("task_title")}</div>
        {move || match state.get() {
            None => view! { <p class="soft-note">{tx("task_loading")}</p> }.into_any(),
            Some(d) if d.tasks.is_empty() => view! { <p class="soft-note">{tx("task_none")}</p> }.into_any(),
            Some(d) => view! {
                <ul class="live-rows tasks">
                    {d.tasks.into_iter().map(|t| view! {
                        <li class="task"><span class=format!("chip chip-{}", t.status)>{tx(&format!("task_{}", t.status))}</span>
                            <span class="tl-check">{t.subject}</span><span class="tl-rule">{t.priority}</span>
                            <span class="tl-age">{(t.changed_ms > 0).then(|| since(t.changed_ms))}</span></li>
                    }).collect_view()}
                </ul>
            }.into_any(),
        }}
    }
}
