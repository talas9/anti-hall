//! Geometry shared by every renderer: camera, card sizes, port/edge anchors, wire polylines and flow-particle positions.

use crate::layout::Pos;
use crate::model::{GraphConfig, GraphData, LayoutMode, NodeDef};
use std::collections::HashMap;

/// screen = world * k + (x, y)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cam {
    pub x: f32,
    pub y: f32,
    pub k: f32,
}

pub fn node_size(n: &NodeDef, cfg: &GraphConfig) -> (f32, f32) {
    let g = &cfg.geometry;
    let ports = n.ports_in.len().max(n.ports_out.len()) as f32;
    (g.node_w, g.node_h.max(ports * g.port_pitch + g.port_pitch * 0.5))
}

/// Vertical offset of port `i` of `count` inside a card of height `h`.
pub fn port_y(i: usize, count: usize, h: f32) -> f32 {
    h * (i as f32 + 0.5) / count.max(1) as f32
}

/// Where a wire touches a card. `toward` is the far end, used to pick the border point in force mode.
fn border_point(pos: (f32, f32), size: (f32, f32), port: Option<(usize, usize, bool)>, toward: (f32, f32), mode: LayoutMode) -> (f32, f32) {
    let (w, h) = size;
    if let Some((i, count, is_out)) = port {
        return (pos.0 + if is_out { w } else { 0.0 }, pos.1 + port_y(i, count, h));
    }
    let c = (pos.0 + w / 2.0, pos.1 + h / 2.0);
    match mode {
        LayoutMode::Layered => (c.0 + if toward.0 >= c.0 { w / 2.0 } else { -w / 2.0 }, c.1),
        LayoutMode::Force => {
            let (dx, dy) = (toward.0 - c.0, toward.1 - c.1);
            if dx == 0.0 && dy == 0.0 {
                return c;
            }
            let t = ((w / 2.0) / dx.abs().max(1e-3)).min((h / 2.0) / dy.abs().max(1e-3));
            (c.0 + dx * t, c.1 + dy * t)
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WireGeom {
    pub edge: usize,
    pub ctrl: [[f32; 2]; 4],
    pub pts: Vec<[f32; 2]>,
}

fn bez(p: &[[f32; 2]; 4], t: f32) -> [f32; 2] {
    let u = 1.0 - t;
    let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    [a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0], a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1]]
}

pub fn wires(data: &GraphData, pos: &Pos, cfg: &GraphConfig, mode: LayoutMode) -> Vec<WireGeom> {
    let by_id: HashMap<&str, &NodeDef> = data.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let samples = cfg.budget.wire_samples.max(2);
    let mut out = Vec::with_capacity(data.edges.len());
    for (ei, e) in data.edges.iter().enumerate() {
        let (Some(a), Some(b)) = (by_id.get(e.from.as_str()), by_id.get(e.to.as_str())) else { continue };
        let (Some(pa), Some(pb)) = (pos.get(&e.from), pos.get(&e.to)) else { continue };
        let (sa, sb) = (node_size(a, cfg), node_size(b, cfg));
        let out_port = a.ports_out.iter().position(|p| p.id == e.from_port).map(|i| (i, a.ports_out.len(), true));
        let in_port = b.ports_in.iter().position(|p| p.id == e.to_port).map(|i| (i, b.ports_in.len(), false));
        let (ca, cb) = ((pa.0 + sa.0 / 2.0, pa.1 + sa.1 / 2.0), (pb.0 + sb.0 / 2.0, pb.1 + sb.1 / 2.0));
        let p0 = border_point(*pa, sa, out_port, cb, mode);
        let p3 = border_point(*pb, sb, in_port, ca, mode);
        let ctrl = match mode {
            LayoutMode::Layered => {
                let k = ((p3.0 - p0.0).abs() * 0.5).max(cfg.geometry.node_w * 0.35);
                [[p0.0, p0.1], [p0.0 + k, p0.1], [p3.0 - k, p3.1], [p3.0, p3.1]]
            }
            LayoutMode::Force => {
                let (dx, dy) = (p3.0 - p0.0, p3.1 - p0.1);
                // gentle bow so two opposite edges between the same pair do not overlap
                let (nx, ny) = (-dy * 0.08, dx * 0.08);
                [[p0.0, p0.1], [p0.0 + dx / 3.0 + nx, p0.1 + dy / 3.0 + ny], [p0.0 + dx * 2.0 / 3.0 + nx, p0.1 + dy * 2.0 / 3.0 + ny], [p3.0, p3.1]]
            }
        };
        let pts = (0..=samples).map(|i| bez(&ctrl, i as f32 / samples as f32)).collect();
        out.push(WireGeom { edge: ei, ctrl, pts });
    }
    out
}

/// Point at fraction `t` (0..1) along a polyline.
pub fn along(pts: &[[f32; 2]], t: f32) -> [f32; 2] {
    let n = pts.len() - 1;
    let f = t.clamp(0.0, 0.9999) * n as f32;
    let i = f as usize;
    let u = f - i as f32;
    [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u]
}

pub struct Particle {
    pub pos: [f32; 2],
    pub hot: bool,
    /// Own colour (an effect particle); `None` takes the palette's particle colour.
    pub col: Option<[f32; 4]>,
    /// Size multiple of the budget's particle size.
    pub r: f32,
}

/// Flow particles at time `t_s` seconds. Density follows the edge rate; the total is capped by the budget.
pub fn particles(data: &GraphData, wires: &[WireGeom], hot: &dyn Fn(usize) -> bool, t_s: f32, cfg: &GraphConfig) -> Vec<Particle> {
    let b = &cfg.budget;
    let per: Vec<usize> = wires
        .iter()
        .map(|w| {
            let r = data.edges[w.edge].rate;
            if r <= 0.0 { 0 } else { ((r * b.particles_per_rate).ceil() as usize).max(1) }
        })
        .collect();
    let total: usize = per.iter().sum();
    let scale = if total > b.particles_max { b.particles_max as f32 / total as f32 } else { 1.0 };
    let mut out = Vec::with_capacity(total.min(b.particles_max));
    for (wi, (w, n)) in wires.iter().zip(&per).enumerate() {
        let n = ((*n as f32 * scale).floor() as usize).max(usize::from(*n > 0 && scale > 0.0));
        let h = hot(w.edge);
        for i in 0..n {
            let ph = i as f32 / n as f32 + wi as f32 * 0.137;
            let t = (t_s * b.particle_speed * (if h { 1.6 } else { 1.0 }) + ph).fract();
            out.push(Particle { pos: along(&w.pts, t), hot: h, col: None, r: 1.0 });
        }
        if out.len() >= b.particles_max {
            break;
        }
    }
    out
}
