//! Auto-layout. Layered DAG = `rust-sugiyama` (left to right); force-directed = `fdg-sim` (Fruchterman-Reingold).
//! Both are established crates; this file only adapts the model to them and normalises the result to top-left node corners.

use crate::model::{GraphConfig, GraphData, LayoutMode};
use fdg_sim::{force, glam::Vec3, ForceGraph, ForceGraphHelper, Simulation, SimulationParameters};
use std::collections::HashMap;

pub type Pos = HashMap<String, (f32, f32)>;

/// Positions for every node. Pinned `x`/`y` on a node win over the computed ones.
pub fn compute(data: &GraphData, mode: LayoutMode, cfg: &GraphConfig) -> Pos {
    let mut pos = match mode {
        LayoutMode::Layered => layered(data, cfg),
        LayoutMode::Force => forced(data, cfg),
    };
    for n in &data.nodes {
        if let (Some(x), Some(y)) = (n.x, n.y) {
            pos.insert(n.id.clone(), (x, y));
        }
    }
    pos
}

fn index(data: &GraphData) -> HashMap<&str, u32> {
    data.nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i as u32)).collect()
}

fn layered(data: &GraphData, cfg: &GraphConfig) -> Pos {
    let (g, l) = (&cfg.geometry, &cfg.layout);
    let idx = index(data);
    // Sugiyama lays layers out top to bottom; we want left to right, so feed it the transposed node sizes and swap the axes after.
    let verts: Vec<(u32, (f64, f64))> =
        data.nodes.iter().enumerate().map(|(i, _)| (i as u32, (g.node_h as f64, g.node_w as f64))).collect();
    let edges: Vec<(u32, u32)> = data
        .edges
        .iter()
        .filter_map(|e| Some((*idx.get(e.from.as_str())?, *idx.get(e.to.as_str())?)))
        .filter(|(a, b)| a != b)
        .collect();
    let conf = rust_sugiyama::configure::Config {
        vertex_spacing: l.node_gap,
        minimum_length: 1,
        ..Default::default()
    };
    let mut out = Pos::new();
    let mut y_off = 0.0f32;
    let mut comps = rust_sugiyama::from_vertices_and_edges(&verts, &edges, &conf);
    comps.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    for (nodes, _w, _h) in comps {
        let (mut min_y, mut max_y) = (f32::MAX, f32::MIN);
        let mut min_x = f32::MAX;
        for (_, (a, b)) in &nodes {
            // a = within-layer axis, b = layer axis
            min_y = min_y.min(*a as f32);
            max_y = max_y.max(*a as f32);
            min_x = min_x.min(*b as f32);
        }
        for (i, (a, b)) in &nodes {
            let x = (*b as f32 - min_x) * (1.0 + (l.layer_gap as f32) / g.node_w).max(1.0);
            out.insert(data.nodes[*i].id.clone(), (x, y_off + (*a as f32 - min_y)));
        }
        y_off += (max_y - min_y) + g.node_h + l.component_gap;
    }
    out
}

fn forced(data: &GraphData, cfg: &GraphConfig) -> Pos {
    let l = &cfg.layout;
    let idx = index(data);
    let mut fg: ForceGraph<(), ()> = ForceGraph::default();
    // Deterministic spiral start so a reload does not reshuffle the picture.
    let ids: Vec<_> = data
        .nodes
        .iter()
        .enumerate()
        .map(|(i, nd)| {
            let (a, r) = (i as f32 * 2.399_963, (i as f32 + 0.5).sqrt() * l.force_scale * 0.5);
            fg.add_force_node_with_coords(&nd.id, (), Vec3::new(r * a.cos(), r * a.sin(), 0.0))
        })
        .collect();
    for e in &data.edges {
        if let (Some(a), Some(b)) = (idx.get(e.from.as_str()), idx.get(e.to.as_str())) {
            if a != b {
                fg.add_edge(ids[*a as usize], ids[*b as usize], ());
            }
        }
    }
    let params = SimulationParameters::from_force(force::fruchterman_reingold(l.force_scale, l.force_cooloff));
    let mut sim = Simulation::from_graph(fg, params);
    // `from_graph` re-randomises; put the deterministic start back.
    for (i, nid) in ids.iter().enumerate() {
        let (a, r) = (i as f32 * 2.399_963, (i as f32 + 0.5).sqrt() * l.force_scale * 0.5);
        let node = &mut sim.get_graph_mut()[*nid];
        node.location = Vec3::new(r * a.cos(), r * a.sin(), 0.0);
        node.old_location = node.location;
        node.velocity = Vec3::ZERO;
    }
    for _ in 0..l.force_iterations {
        sim.update(l.force_dt);
    }
    let (mut min_x, mut min_y) = (f32::MAX, f32::MAX);
    for nid in &ids {
        let p = sim.get_graph()[*nid].location;
        min_x = min_x.min(p.x);
        min_y = min_y.min(p.y);
    }
    data.nodes
        .iter()
        .zip(&ids)
        .map(|(nd, nid)| {
            let p = sim.get_graph()[*nid].location;
            (nd.id.clone(), ((p.x - min_x) * l.force_spread, (p.y - min_y) * l.force_spread))
        })
        .collect()
}
