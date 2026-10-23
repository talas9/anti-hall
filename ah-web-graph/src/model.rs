//! Data model: the graph the caller hands in, the actions it offers, and the config the host reads from plugin TOML.
//! Nothing here has a built-in value: every number, colour and text arrives through `GraphConfig` (see `web_graph.toml`).

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct PortDef {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct NodeDef {
    pub id: String,
    pub label: String,
    /// Second line on the card (model, heartbeat, hook event ...).
    pub sub: String,
    /// Key into `theme.kinds`.
    pub kind: String,
    /// Key into `theme.status`; empty = no status dot colouring.
    pub status: String,
    /// Pinned position; absent = laid out automatically.
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub ports_in: Vec<PortDef>,
    pub ports_out: Vec<PortDef>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct EdgeDef {
    pub id: String,
    pub from: String,
    pub from_port: String,
    pub to: String,
    pub to_port: String,
    pub label: String,
    /// Flow rate in messages/s; drives particle density. 0 = no particles.
    pub rate: f32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Default)]
pub struct GraphData {
    pub nodes: Vec<NodeDef>,
    pub edges: Vec<EdgeDef>,
}

/// One entry of a node's context menu. The caller decides which actions are valid for the node.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ActionDef {
    pub id: String,
    pub label: String,
    pub destructive: bool,
    pub enabled: bool,
    /// Why it is disabled (tooltip), or the confirm sentence for a destructive one; empty = use the config text.
    pub note: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Full,
    Lite,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LayoutMode {
    /// Layered DAG, left to right (rules / hooks editor).
    Layered,
    /// Force-directed (agents, system topology).
    Force,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fb {
    Running,
    Done,
    Failed,
}

#[derive(Clone, Debug, Deserialize)]
pub struct KindStyle {
    /// `oklch(L C H)`; converted to sRGB for the canvas/GPU layers, used verbatim by CSS.
    pub color: String,
    /// `circle` | `square` | `diamond`
    pub shape: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Theme {
    pub bg: String,
    pub grid: String,
    pub wire: String,
    pub wire_hot: String,
    pub particle: String,
    pub kinds: HashMap<String, KindStyle>,
    pub status: HashMap<String, String>,
    pub fallback_kind: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Budget {
    pub fps_interact: u32,
    pub fps_ambient: u32,
    /// How long after the last input the 60 fps mode is held.
    pub interact_hold_ms: u32,
    pub particles_max: usize,
    pub particles_per_rate: f32,
    pub particle_speed: f32,
    pub particle_size: f32,
    pub wire_width: f32,
    pub wire_samples: usize,
    pub highlight_throttle_ms: u32,
    pub feedback_clear_ms: u32,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Geometry {
    pub node_w: f32,
    pub node_h: f32,
    pub port_r: f32,
    pub port_pitch: f32,
    pub zoom_min: f32,
    pub zoom_max: f32,
    pub zoom_step: f32,
    pub fit_pad: f32,
    pub minimap_w: f32,
    pub minimap_h: f32,
}

#[derive(Clone, Debug, Deserialize)]
pub struct LayoutCfg {
    pub layer_gap: f64,
    pub node_gap: f64,
    pub force_scale: f32,
    pub force_cooloff: f32,
    pub force_iterations: usize,
    pub force_dt: f32,
    /// Canvas area per node as a multiple of one card's area.
    pub force_density: f32,
    pub force_collide_passes: usize,
    pub force_collide_pad: f32,
    pub component_gap: f32,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Texts {
    pub menu_label: String,
    pub menu_button: String,
    pub running: String,
    pub done: String,
    pub failed: String,
    pub confirm_title: String,
    pub confirm_body: String,
    pub confirm_yes: String,
    pub confirm_no: String,
    pub no_actions: String,
    pub fit: String,
    pub zoom_in: String,
    pub zoom_out: String,
    pub minimap: String,
    pub graph_label: String,
    pub edge_rate_unit: String,
    pub tier_lite_note: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GraphConfig {
    pub theme: Theme,
    pub budget: Budget,
    pub geometry: Geometry,
    pub layout: LayoutCfg,
    pub texts: Texts,
}

impl GraphConfig {
    pub fn kind(&self, k: &str) -> Option<&KindStyle> {
        self.theme.kinds.get(k).or_else(|| self.theme.kinds.get(&self.theme.fallback_kind))
    }
}
